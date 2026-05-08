const express = require("express");
const rateLimit = require("express-rate-limit");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { requireMinimumRole, requirePlatformOwner, normalizeRole } = auth;
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

/* ============================================================
 * Support Phase 1 — internal ticketing system.
 *
 * Company surface (req.user.company_id scoped, manager+ only):
 *   GET    /support/tickets
 *   POST   /support/tickets
 *   GET    /support/tickets/:id
 *   POST   /support/tickets/:id/messages
 *   PATCH  /support/tickets/:id/status              (open <-> closed only)
 *
 * Platform surface (platform_owner only, all companies):
 *   GET    /platform/support/tickets
 *   PATCH  /platform/support/tickets/:id/assign
 *   PATCH  /platform/support/tickets/:id/status     (any allowed status)
 *
 * Platform owners may also access GET /support/tickets/:id and
 * POST /support/tickets/:id/messages without a company_id scope check, so
 * they can answer in-thread on the same canonical ticket the company sees.
 *
 * Notes:
 *  - This module does NOT use requireCompanyBillingForMutations because a
 *    past_due/suspended company must still be able to file billing tickets;
 *    blocking that would create an unrecoverable lockout.
 *  - No email notifications, no live chat, no external integrations
 *    (per Phase 1 scope).
 * ============================================================ */

const ALLOWED_STATUSES = new Set(["open", "pending", "resolved", "closed"]);
const COMPANY_SETTABLE_STATUSES = new Set(["open", "closed"]);
const ALLOWED_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const ALLOWED_CATEGORIES = new Set([
  "general", "billing", "bug", "feature_request", "account", "marketplace"
]);
const ALLOWED_SENDER_ROLES = new Set([
  "worker", "manager", "admin", "owner", "platform_owner"
]);

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

/* Per-route mutation limiter (in addition to global apiLimiter). Keeps a single
 * actor from spamming new tickets / replies. Matches the cadence used by other
 * mutation surfaces in this codebase (uploadLimiter etc.). */
const supportMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many support requests, please slow down" }
});

function parsePagination(query) {
  const parsedLimit = Number(query && query.limit);
  const parsedOffset = Number(query && query.offset);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;
  return { limit, offset };
}

/* Trim, collapse runs of whitespace, strip control chars, enforce max length. */
function sanitizeTextField(value, maxLen) {
  const raw = String(value == null ? "" : value);
  // eslint-disable-next-line no-control-regex
  const noCtrl = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  const trimmed = noCtrl.trim();
  if (!trimmed) return "";
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function parseTicketId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isPlatformOwnerUser(user) {
  return normalizeRole(user && user.role) === "platform_owner";
}

async function loadTicketRow(ticketId, { companyId = null } = {}) {
  const params = [ticketId];
  let where = "id = $1";
  if (companyId != null) {
    params.push(companyId);
    where += " AND company_id = $2";
  }
  const result = await pool.query(
    `
    SELECT id, company_id, created_by_user_id, assigned_to_user_id,
           subject, category, priority, status,
           created_at, updated_at
    FROM support_tickets
    WHERE ${where}
    LIMIT 1
    `,
    params
  );
  return result.rows[0] || null;
}

async function loadTicketMessages(ticketId) {
  const result = await pool.query(
    `
    SELECT m.id, m.ticket_id, m.sender_user_id, m.sender_role, m.message, m.created_at,
           u.username AS sender_username
    FROM support_ticket_messages m
    LEFT JOIN users u ON u.id = m.sender_user_id
    WHERE m.ticket_id = $1
    ORDER BY m.created_at ASC, m.id ASC
    `,
    [ticketId]
  );
  return result.rows;
}

async function appendMessage(client, { ticketId, senderUserId, senderRole, message }) {
  const inserted = await client.query(
    `
    INSERT INTO support_ticket_messages
      (ticket_id, sender_user_id, sender_role, message)
    VALUES ($1, $2, $3, $4)
    RETURNING id, ticket_id, sender_user_id, sender_role, message, created_at
    `,
    [ticketId, senderUserId, senderRole, message]
  );
  await client.query(
    `UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [ticketId]
  );
  return inserted.rows[0];
}

/* ============================================================
 * COMPANY ROUTES
 * ============================================================ */

router.get(
  "/support/tickets",
  auth,
  requireMinimumRole("manager"),
  async (req, res) => {
    try {
      const company_id = req.user.company_id;
      if (!company_id) return res.status(403).json({ error: "Forbidden" });

      const { limit, offset } = parsePagination(req.query);
      const status = req.query && req.query.status
        ? sanitizeTextField(req.query.status, 32).toLowerCase()
        : "";

      const params = [company_id];
      let where = "t.company_id = $1";
      if (status && ALLOWED_STATUSES.has(status)) {
        params.push(status);
        where += ` AND t.status = $${params.length}`;
      }
      params.push(limit, offset);

      const result = await pool.query(
        `
        SELECT
          t.id, t.company_id, t.created_by_user_id, t.assigned_to_user_id,
          t.subject, t.category, t.priority, t.status,
          t.created_at, t.updated_at,
          creator.username AS created_by_username,
          assignee.username AS assigned_to_username,
          (
            SELECT COUNT(*)::int
            FROM support_ticket_messages m
            WHERE m.ticket_id = t.id
          ) AS message_count
        FROM support_tickets t
        LEFT JOIN users creator  ON creator.id  = t.created_by_user_id
        LEFT JOIN users assignee ON assignee.id = t.assigned_to_user_id
        WHERE ${where}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );

      return res.json(result.rows);
    } catch (err) {
      console.log("LIST SUPPORT TICKETS ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    }
  }
);

router.post(
  "/support/tickets",
  auth,
  requireMinimumRole("manager"),
  supportMutationLimiter,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const company_id = req.user.company_id;
      if (!company_id) return res.status(403).json({ error: "Forbidden" });

      const subject = sanitizeTextField(req.body && req.body.subject, SUBJECT_MAX);
      const initialMessage = sanitizeTextField(req.body && req.body.message, MESSAGE_MAX);
      const rawCategory = sanitizeTextField(req.body && req.body.category, 32).toLowerCase();
      const rawPriority = sanitizeTextField(req.body && req.body.priority, 16).toLowerCase();
      const category = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : "general";
      const priority = ALLOWED_PRIORITIES.has(rawPriority) ? rawPriority : "normal";

      if (!subject) {
        return res.status(400).json({ error: "Subject is required" });
      }
      if (!initialMessage) {
        return res.status(400).json({ error: "Message is required" });
      }

      const senderRole = normalizeRole(req.user && req.user.role) || "manager";
      if (!ALLOWED_SENDER_ROLES.has(senderRole)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await client.query("BEGIN");

      const ticketInsert = await client.query(
        `
        INSERT INTO support_tickets
          (company_id, created_by_user_id, subject, category, priority, status)
        VALUES ($1, $2, $3, $4, $5, 'open')
        RETURNING id, company_id, created_by_user_id, assigned_to_user_id,
                  subject, category, priority, status, created_at, updated_at
        `,
        [company_id, req.user.id, subject, category, priority]
      );
      const ticket = ticketInsert.rows[0];

      await appendMessage(client, {
        ticketId: ticket.id,
        senderUserId: req.user.id,
        senderRole,
        message: initialMessage
      });

      await client.query("COMMIT");
      return res.status(201).json(ticket);
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
      console.log("CREATE SUPPORT TICKET ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    } finally {
      client.release();
    }
  }
);

router.get(
  "/support/tickets/:id",
  auth,
  async (req, res) => {
    try {
      const ticketId = parseTicketId(req.params.id);
      if (!ticketId) return res.status(400).json({ error: "Invalid ticket id" });

      const platformView = isPlatformOwnerUser(req.user);
      const company_id = platformView ? null : req.user.company_id;

      if (!platformView && !company_id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const ticket = await loadTicketRow(ticketId, { companyId: company_id });
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });

      const messages = await loadTicketMessages(ticketId);
      return res.json({ ticket, messages });
    } catch (err) {
      console.log("GET SUPPORT TICKET ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    }
  }
);

router.post(
  "/support/tickets/:id/messages",
  auth,
  supportMutationLimiter,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const ticketId = parseTicketId(req.params.id);
      if (!ticketId) return res.status(400).json({ error: "Invalid ticket id" });

      const message = sanitizeTextField(req.body && req.body.message, MESSAGE_MAX);
      if (!message) return res.status(400).json({ error: "Message is required" });

      const platformView = isPlatformOwnerUser(req.user);
      const company_id = platformView ? null : req.user.company_id;
      if (!platformView && !company_id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const senderRole = normalizeRole(req.user && req.user.role);
      if (!senderRole || !ALLOWED_SENDER_ROLES.has(senderRole)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Company users (manager+) may post on their own company tickets.
      if (!platformView) {
        if (!auth.hasMinimumRole(req.user, "manager")) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      await client.query("BEGIN");

      const ticket = await (async () => {
        const params = [ticketId];
        let where = "id = $1";
        if (company_id != null) {
          params.push(company_id);
          where += " AND company_id = $2";
        }
        const r = await client.query(
          `SELECT id, company_id, status FROM support_tickets WHERE ${where} FOR UPDATE`,
          params
        );
        return r.rows[0] || null;
      })();

      if (!ticket) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Ticket not found" });
      }

      if (ticket.status === "closed") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Ticket is closed; reopen it before replying" });
      }

      const inserted = await appendMessage(client, {
        ticketId,
        senderUserId: req.user.id,
        senderRole,
        message
      });

      // When a platform_owner replies and the ticket is still 'open', mark it
      // 'pending' (awaiting customer). Company replies on a 'pending' ticket
      // flip it back to 'open' (awaiting platform). This keeps the status
      // useful without adding new transitions to the constraint set.
      if (platformView && ticket.status === "open") {
        await client.query(
          `UPDATE support_tickets SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [ticketId]
        );
      } else if (!platformView && ticket.status === "pending") {
        await client.query(
          `UPDATE support_tickets SET status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [ticketId]
        );
      }

      await client.query("COMMIT");
      return res.status(201).json(inserted);
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
      console.log("REPLY SUPPORT TICKET ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    } finally {
      client.release();
    }
  }
);

router.patch(
  "/support/tickets/:id/status",
  auth,
  requireMinimumRole("manager"),
  supportMutationLimiter,
  async (req, res) => {
    try {
      const ticketId = parseTicketId(req.params.id);
      if (!ticketId) return res.status(400).json({ error: "Invalid ticket id" });

      const requested = sanitizeTextField(req.body && req.body.status, 16).toLowerCase();
      if (!COMPANY_SETTABLE_STATUSES.has(requested)) {
        return res.status(400).json({
          error: "Companies may only set status to 'open' or 'closed'"
        });
      }

      const company_id = req.user.company_id;
      if (!company_id) return res.status(403).json({ error: "Forbidden" });

      const updated = await pool.query(
        `
        UPDATE support_tickets
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND company_id = $3
        RETURNING id, company_id, created_by_user_id, assigned_to_user_id,
                  subject, category, priority, status, created_at, updated_at
        `,
        [requested, ticketId, company_id]
      );

      if (!updated.rows.length) {
        return res.status(404).json({ error: "Ticket not found" });
      }
      return res.json(updated.rows[0]);
    } catch (err) {
      console.log("UPDATE SUPPORT TICKET STATUS ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    }
  }
);

/* ============================================================
 * PLATFORM ROUTES (platform_owner only)
 * ============================================================ */

router.get(
  "/platform/support/tickets",
  auth,
  requirePlatformOwner,
  async (req, res) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const status = req.query && req.query.status
        ? sanitizeTextField(req.query.status, 32).toLowerCase()
        : "";
      const companyFilter = req.query && req.query.company_id
        ? Number(req.query.company_id)
        : null;

      const params = [];
      const conds = [];
      if (status && ALLOWED_STATUSES.has(status)) {
        params.push(status);
        conds.push(`t.status = $${params.length}`);
      }
      if (Number.isInteger(companyFilter) && companyFilter > 0) {
        params.push(companyFilter);
        conds.push(`t.company_id = $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

      params.push(limit, offset);

      const result = await pool.query(
        `
        SELECT
          t.id, t.company_id, t.created_by_user_id, t.assigned_to_user_id,
          t.subject, t.category, t.priority, t.status,
          t.created_at, t.updated_at,
          c.name AS company_name,
          creator.username AS created_by_username,
          assignee.username AS assigned_to_username,
          (
            SELECT COUNT(*)::int
            FROM support_ticket_messages m
            WHERE m.ticket_id = t.id
          ) AS message_count
        FROM support_tickets t
        LEFT JOIN companies c    ON c.id        = t.company_id
        LEFT JOIN users creator  ON creator.id  = t.created_by_user_id
        LEFT JOIN users assignee ON assignee.id = t.assigned_to_user_id
        ${where}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );

      return res.json(result.rows);
    } catch (err) {
      console.log("PLATFORM LIST SUPPORT TICKETS ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    }
  }
);

router.patch(
  "/platform/support/tickets/:id/assign",
  auth,
  requirePlatformOwner,
  supportMutationLimiter,
  async (req, res) => {
    try {
      const ticketId = parseTicketId(req.params.id);
      if (!ticketId) return res.status(400).json({ error: "Invalid ticket id" });

      const rawAssignee = req.body && req.body.assigned_to_user_id;
      let assigneeId = null;
      if (rawAssignee !== null && rawAssignee !== undefined && rawAssignee !== "") {
        const parsed = Number(rawAssignee);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return res.status(400).json({ error: "Invalid assigned_to_user_id" });
        }
        // Only platform_owner users may be assigned to a support ticket.
        const userCheck = await pool.query(
          `SELECT id, role FROM users WHERE id = $1 LIMIT 1`,
          [parsed]
        );
        const found = userCheck.rows[0];
        if (!found || normalizeRole(found.role) !== "platform_owner") {
          return res.status(400).json({
            error: "Assignee must be an existing platform_owner user"
          });
        }
        assigneeId = parsed;
      }

      const updated = await pool.query(
        `
        UPDATE support_tickets
        SET assigned_to_user_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, company_id, created_by_user_id, assigned_to_user_id,
                  subject, category, priority, status, created_at, updated_at
        `,
        [assigneeId, ticketId]
      );

      if (!updated.rows.length) {
        return res.status(404).json({ error: "Ticket not found" });
      }
      return res.json(updated.rows[0]);
    } catch (err) {
      console.log("PLATFORM ASSIGN SUPPORT TICKET ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    }
  }
);

router.patch(
  "/platform/support/tickets/:id/status",
  auth,
  requirePlatformOwner,
  supportMutationLimiter,
  async (req, res) => {
    try {
      const ticketId = parseTicketId(req.params.id);
      if (!ticketId) return res.status(400).json({ error: "Invalid ticket id" });

      const requested = sanitizeTextField(req.body && req.body.status, 16).toLowerCase();
      if (!ALLOWED_STATUSES.has(requested)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const updated = await pool.query(
        `
        UPDATE support_tickets
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, company_id, created_by_user_id, assigned_to_user_id,
                  subject, category, priority, status, created_at, updated_at
        `,
        [requested, ticketId]
      );

      if (!updated.rows.length) {
        return res.status(404).json({ error: "Ticket not found" });
      }
      return res.json(updated.rows[0]);
    } catch (err) {
      console.log("PLATFORM UPDATE SUPPORT TICKET STATUS ERROR:", err);
      sendSafeServerError(res, err, "routes/support");
    }
  }
);

module.exports = router;

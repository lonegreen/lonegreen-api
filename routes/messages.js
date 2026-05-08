const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { SECRET } = require("../config/env");
const { classifyTokenBoundary, normalizeRole } = require("../middleware/auth");
const { validateMessageContent } = require("../middleware/abuseGuards");
const { sendSafeServerError } = require("../services/safeServerError");
const { sendOperationalEmailSafe } = require("../services/emailService");
const {
  resolveCustomerAccountId,
  loadPortalScopes,
  tokenClientBelongsToScopes
} = require("../services/customerPortalScope");

const router = express.Router();

function queueSafeEmail(payload, options) {
  Promise.resolve()
    .then(() => sendOperationalEmailSafe(payload, options))
    .catch(() => {});
}

function parseBearerToken(header) {
  if (!header || typeof header !== "string") {
    return null;
  }
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return null;
  }
  return parts[1];
}

async function resolveCustomerActor(decoded) {
  const clientId = Number(decoded && decoded.client_id);
  const tokenCompanyId = decoded && decoded.company_id ? Number(decoded.company_id) : null;
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return null;
  }
  if (tokenCompanyId !== null && (!Number.isInteger(tokenCompanyId) || tokenCompanyId <= 0)) {
    return null;
  }

  const accountId = await resolveCustomerAccountId(decoded);
  let scopes = accountId ? await loadPortalScopes(accountId) : [];

  if (!scopes.length) {
    const clientResult = tokenCompanyId
      ? await pool.query(
        "SELECT id, company_id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1",
        [clientId, tokenCompanyId]
      )
      : await pool.query(
        "SELECT id, company_id FROM clients WHERE id = $1 LIMIT 1",
        [clientId]
      );
    if (!clientResult.rows.length) {
      return null;
    }
    const client = clientResult.rows[0];
    const clientCompanyId = Number(client.company_id);
    if (tokenCompanyId && tokenCompanyId !== clientCompanyId) {
      return null;
    }
    scopes = [{
      company_id: clientCompanyId,
      client_id: Number(client.id)
    }];
  } else if (!tokenClientBelongsToScopes(scopes, clientId)) {
    return null;
  }

  const primary = scopes.find(s => Number(s.client_id) === clientId) || scopes[0];

  return {
    actor_type: "customer",
    client_id: Number(primary.client_id),
    token_client_id: clientId,
    company_id: Number(primary.company_id),
    account_id: accountId,
    scopes,
    user_id: undefined
  };
}

function resolveCompanyActor(decoded) {
  const userId = Number(decoded && decoded.id);
  const role = normalizeRole(decoded && decoded.role);
  const companyId = Number(decoded && decoded.company_id);
  const allowedCompanyRoles = new Set(["owner", "admin", "manager", "worker", "platform_owner"]);

  if (!Number.isInteger(userId) || userId <= 0 || !role) {
    return null;
  }
  if (!allowedCompanyRoles.has(role)) {
    return null;
  }
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return null;
  }

  return {
    actor_type: "company",
    user_id: userId,
    company_id: companyId,
    role,
    worker_id: Number(decoded && decoded.worker_id) || null
  };
}

function isWorkerActor(participant) {
  return participant && participant.actor_type === "company" && participant.role === "worker";
}

async function workerHasClientAccess(companyId, workerId, clientId) {
  if (!Number.isInteger(companyId) || companyId <= 0) return false;
  if (!Number.isInteger(workerId) || workerId <= 0) return false;
  if (!Number.isInteger(clientId) || clientId <= 0) return false;
  const result = await pool.query(
    `
    SELECT 1
    FROM jobs
    WHERE company_id = $1
      AND worker_id = $2
      AND client_id = $3
    LIMIT 1
    `,
    [companyId, workerId, clientId]
  );
  return result.rows.length > 0;
}

async function participantAuth(req, res, next) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: "Authorization required" });
  }

  try {
    const decoded = jwt.verify(token, SECRET);
    const boundary = classifyTokenBoundary(decoded);
    if (boundary.type === "mixed") {
      return res.status(403).json({ error: "Mixed auth boundary token" });
    }
    const isCustomerToken = boundary.type === "customer";

    if (isCustomerToken) {
      const customerActor = await resolveCustomerActor(decoded);
      if (!customerActor) {
        return res.status(403).json({ error: "Forbidden" });
      }
      req.participant = customerActor;
      return next();
    }

    const companyActor = resolveCompanyActor(decoded);
    if (!companyActor) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.participant = companyActor;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function getConversationIfParticipant(conversationId, participant) {
  if (participant.actor_type === "customer") {
    const scopes = participant.scopes && participant.scopes.length
      ? participant.scopes
      : [{ company_id: participant.company_id, client_id: participant.client_id }];
    const parts = [];
    const params = [conversationId];
    let p = 2;
    for (const s of scopes) {
      parts.push(`(company_id = $${p} AND client_id = $${p + 1})`);
      params.push(s.company_id, s.client_id);
      p += 2;
    }
    const result = await pool.query(
      `
      SELECT id, company_id, client_id, created_at
      FROM conversations
      WHERE id = $1
        AND (${parts.join(" OR ")})
      LIMIT 1
      `,
      params
    );
    return result.rows[0] || null;
  }

  const result = await pool.query(
    `
    SELECT id, company_id, client_id, created_at
    FROM conversations
    WHERE id = $1
      AND company_id = $2
    LIMIT 1
    `,
    [conversationId, participant.company_id]
  );
  const row = result.rows[0] || null;
  if (!row) {
    return null;
  }
  if (isWorkerActor(participant)) {
    const allowed = await workerHasClientAccess(participant.company_id, participant.worker_id, Number(row.client_id));
    if (!allowed) {
      return null;
    }
  }
  return row;
}

function withModerationFlag(payload, res) {
  if (!res || !res.locals || res.locals.moderationFlagged !== true) {
    return payload;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...payload, moderation_flagged: true };
}

router.post("/conversations", participantAuth, async (req, res) => {
  try {
    if (req.participant.actor_type === "customer") {
      const scopes = req.participant.scopes && req.participant.scopes.length
        ? req.participant.scopes
        : [{ company_id: req.participant.company_id, client_id: req.participant.client_id }];
      if (!scopes.length) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const requestedCompanyId = req.body && req.body.company_id ? Number(req.body.company_id) : null;
      let pair;
      if (requestedCompanyId && Number.isInteger(requestedCompanyId) && requestedCompanyId > 0) {
        pair = scopes.find(s => Number(s.company_id) === requestedCompanyId);
        if (!pair) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else {
        const tokenClientId = Number(req.participant.token_client_id || req.participant.client_id);
        pair = scopes.find(s => Number(s.client_id) === tokenClientId) || scopes[0];
      }

      const conversation = await pool.query(
        `
        INSERT INTO conversations (company_id, client_id)
        VALUES ($1, $2)
        ON CONFLICT (company_id, client_id)
        DO UPDATE SET company_id = EXCLUDED.company_id
        RETURNING id, company_id, client_id, created_at
        `,
        [pair.company_id, pair.client_id]
      );
      return res.status(201).json(conversation.rows[0]);
    }

    const clientId = Number(req.body && req.body.client_id);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ error: "Invalid client_id" });
    }

    const clientCheck = await pool.query(
      "SELECT id, company_id FROM clients WHERE id = $1 LIMIT 1",
      [clientId]
    );
    if (!clientCheck.rows.length) {
      return res.status(404).json({ error: "Client not found" });
    }
    if (Number(clientCheck.rows[0].company_id) !== req.participant.company_id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (isWorkerActor(req.participant)) {
      const allowed = await workerHasClientAccess(req.participant.company_id, req.participant.worker_id, clientId);
      if (!allowed) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const conversation = await pool.query(
      `
      INSERT INTO conversations (company_id, client_id)
      VALUES ($1, $2)
      ON CONFLICT (company_id, client_id)
      DO UPDATE SET company_id = EXCLUDED.company_id
      RETURNING id, company_id, client_id, created_at
      `,
      [req.participant.company_id, clientId]
    );
    return res.status(201).json(conversation.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "CONVERSATIONS CREATE ERROR");
  }
});

router.get("/conversations", participantAuth, async (req, res) => {
  try {
    let result;
    if (req.participant.actor_type === "customer") {
      const scopes = req.participant.scopes && req.participant.scopes.length
        ? req.participant.scopes
        : [{ company_id: req.participant.company_id, client_id: req.participant.client_id }];
      if (!scopes.length) {
        return res.json([]);
      }
      const parts = [];
      const params = [];
      let p = 1;
      for (const s of scopes) {
        parts.push(`(company_id = $${p} AND client_id = $${p + 1})`);
        params.push(s.company_id, s.client_id);
        p += 2;
      }
      result = await pool.query(
        `
        SELECT id, company_id, client_id, created_at
        FROM conversations
        WHERE (${parts.join(" OR ")})
        ORDER BY created_at DESC, id DESC
        `,
        params
      );
    } else {
      if (isWorkerActor(req.participant)) {
        result = await pool.query(
          `
          SELECT c.id, c.company_id, c.client_id, c.created_at
          FROM conversations c
          WHERE c.company_id = $1
            AND EXISTS (
              SELECT 1
              FROM jobs j
              WHERE j.company_id = c.company_id
                AND j.client_id = c.client_id
                AND j.worker_id = $2
            )
          ORDER BY c.created_at DESC, c.id DESC
          `,
          [req.participant.company_id, req.participant.worker_id || 0]
        );
      } else {
        result = await pool.query(
        `
        SELECT id, company_id, client_id, created_at
        FROM conversations
        WHERE company_id = $1
        ORDER BY created_at DESC, id DESC
        `,
        [req.participant.company_id]
      );
      }
    }
    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "CONVERSATIONS LIST ERROR");
  }
});

router.get("/conversations/:id/messages", participantAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const conversation = await getConversationIfParticipant(conversationId, req.participant);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const result = await pool.query(
      `
      SELECT id, conversation_id, sender_type, sender_id, message_text, is_read, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [conversationId]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "CONVERSATION MESSAGES LIST ERROR");
  }
});

router.post("/conversations/:id/messages", participantAuth, validateMessageContent, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const messageText = String((req.body && req.body.message_text) || "").trim();
    if (!messageText) {
      return res.status(400).json({ error: "message_text is required" });
    }

    const conversation = await getConversationIfParticipant(conversationId, req.participant);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const senderType = req.participant.actor_type;
    const senderId = senderType === "customer"
      ? conversation.client_id
      : req.participant.user_id;

    const inserted = await pool.query(
      `
      INSERT INTO messages (conversation_id, sender_type, sender_id, message_text, is_read)
      VALUES ($1, $2, $3, $4, FALSE)
      RETURNING id, conversation_id, sender_type, sender_id, message_text, is_read, created_at
      `,
      [conversationId, senderType, senderId, messageText]
    );

    const insertedMessage = inserted.rows[0];
    const recipientRow = await pool.query(
      `
      SELECT
        c.id AS conversation_id,
        c.company_id,
        c.client_id,
        cl.email AS client_email,
        cl.name AS client_name,
        co.email AS company_email,
        co.name AS company_name
      FROM conversations c
      LEFT JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.id = $1
      LIMIT 1
      `,
      [conversationId]
    );
    const recipient = recipientRow.rows[0] || null;
    if (recipient) {
      const isCustomerSender = senderType === "customer";
      const to = isCustomerSender
        ? String(recipient.company_email || "").trim()
        : String(recipient.client_email || "").trim();
      if (to) {
        const senderLabel = isCustomerSender
          ? (recipient.client_name || "Customer")
          : (recipient.company_name || "Company");
        queueSafeEmail({
          to,
          subject: "New message in your conversation",
          text: `${senderLabel} sent a new message:\n\n${messageText}`,
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:560px">
              <h2>New message</h2>
              <p><strong>${String(senderLabel).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong> sent a new message:</p>
              <p style="white-space:pre-wrap">${String(messageText || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
            </div>
          `
        }, { kind: "new_message" });
      }
    }

    return res.status(201).json(withModerationFlag(insertedMessage, res));
  } catch (err) {
    return sendSafeServerError(res, err, "CONVERSATION MESSAGE CREATE ERROR");
  }
});

module.exports = router;

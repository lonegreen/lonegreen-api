const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { SECRET } = require("../config/env");
const { classifyTokenBoundary, normalizeRole } = require("../middleware/auth");
const { sendSafeServerError } = require("../services/safeServerError");
const { sendOperationalEmailSafe } = require("../services/emailService");

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

  return {
    actor_type: "customer",
    client_id: Number(client.id),
    company_id: clientCompanyId
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
    company_id: companyId
  };
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
    const result = await pool.query(
      `
      SELECT id, company_id, client_id, created_at
      FROM conversations
      WHERE id = $1
        AND company_id = $2
        AND client_id = $3
      LIMIT 1
      `,
      [conversationId, participant.company_id, participant.client_id]
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
  return result.rows[0] || null;
}

router.post("/conversations", participantAuth, async (req, res) => {
  try {
    if (req.participant.actor_type === "customer") {
      const requestedCompanyId = req.body && req.body.company_id ? Number(req.body.company_id) : null;
      if (requestedCompanyId && requestedCompanyId !== req.participant.company_id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const conversation = await pool.query(
        `
        INSERT INTO conversations (company_id, client_id)
        VALUES ($1, $2)
        ON CONFLICT (company_id, client_id)
        DO UPDATE SET company_id = EXCLUDED.company_id
        RETURNING id, company_id, client_id, created_at
        `,
        [req.participant.company_id, req.participant.client_id]
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
      result = await pool.query(
        `
        SELECT id, company_id, client_id, created_at
        FROM conversations
        WHERE company_id = $1
          AND client_id = $2
        ORDER BY created_at DESC, id DESC
        `,
        [req.participant.company_id, req.participant.client_id]
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

router.post("/conversations/:id/messages", participantAuth, async (req, res) => {
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
      ? req.participant.client_id
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

    return res.status(201).json(insertedMessage);
  } catch (err) {
    return sendSafeServerError(res, err, "CONVERSATION MESSAGE CREATE ERROR");
  }
});

module.exports = router;

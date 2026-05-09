const pool = require("../db/pool");

const ALLOWED_TYPES = new Set(["marketplace", "support", "dispute", "verification", "billing", "system"]);
let notificationsSchemaReadyPromise = null;

function cleanText(value, maxLen) {
  const text = String(value == null ? "" : value).trim();
  return maxLen ? text.slice(0, maxLen) : text;
}

function normalizeId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function cleanType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "system";
  return ALLOWED_TYPES.has(normalized) ? normalized : "system";
}

function shapeNotificationRow(row) {
  const readAt = row.read_at || null;
  const body = row.body || row.message || "";
  return {
    id: Number(row.id),
    company_id: row.company_id == null ? null : Number(row.company_id),
    user_id: row.user_id == null ? null : Number(row.user_id),
    customer_id: row.customer_id == null ? null : Number(row.customer_id),
    type: row.type,
    title: row.title,
    body,
    link_url: row.link_url || null,
    read_at: readAt,
    created_at: row.created_at,
    message: body,
    is_read: Boolean(readAt)
  };
}

async function ensureNotificationsSchema() {
  if (!notificationsSchemaReadyPromise) {
    notificationsSchemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NULL,
          user_id INTEGER NULL,
          customer_id INTEGER NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          link_url TEXT,
          read_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        ALTER TABLE notifications
          ADD COLUMN IF NOT EXISTS company_id INTEGER NULL,
          ADD COLUMN IF NOT EXISTS user_id INTEGER NULL,
          ADD COLUMN IF NOT EXISTS customer_id INTEGER NULL,
          ADD COLUMN IF NOT EXISTS type TEXT,
          ADD COLUMN IF NOT EXISTS title TEXT,
          ADD COLUMN IF NOT EXISTS body TEXT,
          ADD COLUMN IF NOT EXISTS link_url TEXT,
          ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
      `);
      await pool.query(`ALTER TABLE notifications ALTER COLUMN created_at SET DEFAULT NOW()`);
      await pool.query(`
        UPDATE notifications
        SET type = 'system'
        WHERE COALESCE(NULLIF(TRIM(type), ''), '') = ''
      `);
      await pool.query(`
        UPDATE notifications
        SET title = 'Notification'
        WHERE COALESCE(NULLIF(TRIM(title), ''), '') = ''
      `);
      await pool.query(`
        ALTER TABLE notifications
          ALTER COLUMN type SET NOT NULL,
          ALTER COLUMN title SET NOT NULL
      `);
      await pool.query(`
        ALTER TABLE notifications
          ADD COLUMN IF NOT EXISTS message TEXT
      `);
      await pool.query(`
        UPDATE notifications
        SET message = COALESCE(NULLIF(TRIM(message), ''), body, '')
        WHERE COALESCE(NULLIF(TRIM(message), ''), '') = ''
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON notifications(customer_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
        CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
        CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
      `);
    })().catch((err) => {
      notificationsSchemaReadyPromise = null;
      throw err;
    });
  }
  return notificationsSchemaReadyPromise;
}

async function createNotification({ companyId = null, userId = null, customerId = null, type, title, body, linkUrl, message }) {
  await ensureNotificationsSchema();
  const cleanNotificationType = cleanType(type);
  if (!cleanNotificationType) {
    throw new Error("Notification type is required");
  }
  const cleanTitle = cleanText(title, 200);
  if (!cleanTitle) {
    throw new Error("Notification title is required");
  }
  const cleanBody = cleanText(body != null ? body : message, 4000);
  const persistedBody = cleanBody !== "" ? cleanBody : "";
  const cleanLink = cleanText(linkUrl, 1024) || null;
  const normalizedCompanyId = normalizeId(companyId);
  const normalizedUserId = normalizeId(userId);
  const normalizedCustomerId = normalizeId(customerId);
  /* Company-wide rows use user_id NULL; listNotificationsForUser matches company_id + (user_id IS NULL OR user_id = $user). */
  if (!normalizedUserId && !normalizedCustomerId && !normalizedCompanyId) {
    throw new Error("Notification recipient is required");
  }
  const result = await pool.query(
    `
    INSERT INTO notifications (
      company_id, user_id, customer_id, type, title, body, message, link_url, read_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NULL)
    RETURNING id, company_id, user_id, customer_id, type, title, body, link_url, read_at, created_at
    `,
    [normalizedCompanyId, normalizedUserId, normalizedCustomerId, cleanNotificationType, cleanTitle, persistedBody, cleanLink]
  );
  return shapeNotificationRow(result.rows[0]);
}

async function listNotificationsForUser({ userId = null, companyId = null, customerId = null, limit = 25 }) {
  await ensureNotificationsSchema();
  const normalizedUserId = normalizeId(userId);
  const normalizedCompanyId = normalizeId(companyId);
  const normalizedCustomerId = normalizeId(customerId);
  const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100) : 25;
  if (normalizedCustomerId) {
    const result = await pool.query(
      `
      SELECT id, company_id, user_id, customer_id, type, title, body, link_url, read_at, created_at
      FROM notifications
      WHERE customer_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [normalizedCustomerId, safeLimit]
    );
    return result.rows.map(shapeNotificationRow);
  }
  if (!normalizedUserId || !normalizedCompanyId) {
    return [];
  }
  const result = await pool.query(
    `
    SELECT id, company_id, user_id, customer_id, type, title, body, link_url, read_at, created_at
    FROM notifications
    WHERE company_id = $1
      AND (user_id IS NULL OR user_id = $2)
      AND customer_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT $3
    `,
    [normalizedCompanyId, normalizedUserId, safeLimit]
  );
  return result.rows.map(shapeNotificationRow);
}

async function markNotificationRead({ notificationId, userId = null, companyId = null, customerId = null }) {
  await ensureNotificationsSchema();
  const normalizedNotificationId = normalizeId(notificationId);
  const normalizedUserId = normalizeId(userId);
  const normalizedCompanyId = normalizeId(companyId);
  const normalizedCustomerId = normalizeId(customerId);
  if (!normalizedNotificationId) {
    return null;
  }
  if (normalizedCustomerId) {
    const result = await pool.query(
      `
      UPDATE notifications
      SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE id = $1
        AND customer_id = $2
      RETURNING id, company_id, user_id, customer_id, type, title, body, link_url, read_at, created_at
      `,
      [normalizedNotificationId, normalizedCustomerId]
    );
    return result.rows[0] ? shapeNotificationRow(result.rows[0]) : null;
  }
  if (!normalizedUserId || !normalizedCompanyId) {
    return null;
  }
  const result = await pool.query(
    `
    UPDATE notifications
    SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = $1
      AND company_id = $2
      AND customer_id IS NULL
      AND (user_id IS NULL OR user_id = $3)
    RETURNING id, company_id, user_id, customer_id, type, title, body, link_url, read_at, created_at
    `,
    [normalizedNotificationId, normalizedCompanyId, normalizedUserId]
  );
  return result.rows[0] ? shapeNotificationRow(result.rows[0]) : null;
}

async function countUnreadNotifications({ userId = null, companyId = null, customerId = null }) {
  await ensureNotificationsSchema();
  const normalizedUserId = normalizeId(userId);
  const normalizedCompanyId = normalizeId(companyId);
  const normalizedCustomerId = normalizeId(customerId);
  if (normalizedCustomerId) {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS unread_count
      FROM notifications
      WHERE customer_id = $1
        AND read_at IS NULL
      `,
      [normalizedCustomerId]
    );
    return Number(result.rows[0] && result.rows[0].unread_count) || 0;
  }
  if (!normalizedUserId || !normalizedCompanyId) {
    return 0;
  }
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS unread_count
    FROM notifications
    WHERE company_id = $1
      AND customer_id IS NULL
      AND (user_id IS NULL OR user_id = $2)
      AND read_at IS NULL
    `,
    [normalizedCompanyId, normalizedUserId]
  );
  return Number(result.rows[0] && result.rows[0].unread_count) || 0;
}

async function ensureUniqueNotification({ companyId, userId = null, type, title, message, metadata = null }) {
  const normalizedCompanyId = normalizeId(companyId);
  const normalizedUserId = normalizeId(userId);
  const cleanNotificationType = cleanType(type);
  const cleanTitle = cleanText(title, 200);
  const cleanBody = cleanText(message, 4000);
  if (!normalizedCompanyId || !cleanNotificationType || !cleanTitle || !cleanBody) {
    return null;
  }
  await ensureNotificationsSchema();
  const existing = await pool.query(
    `
    SELECT id, company_id, user_id, customer_id, type, title, body, link_url, read_at, created_at
    FROM notifications
    WHERE company_id = $1
      AND type = $2
      AND title = $3
      AND COALESCE(body, '') = $4
      AND read_at IS NULL
      AND customer_id IS NULL
      AND (($5::int IS NULL AND user_id IS NULL) OR user_id = $5)
    ORDER BY id DESC
    LIMIT 1
    `,
    [normalizedCompanyId, cleanNotificationType, cleanTitle, cleanBody, normalizedUserId]
  );
  if (existing.rows.length) {
    return shapeNotificationRow(existing.rows[0]);
  }
  return createNotification({
    companyId: normalizedCompanyId,
    userId: normalizedUserId,
    type: cleanNotificationType,
    title: cleanTitle,
    body: cleanBody,
    linkUrl: metadata && typeof metadata.link_url === "string" ? metadata.link_url : null
  });
}

async function createNotificationIfMissing({ companyId, type, title, message, userId = null, metadata = null }) {
  const normalizedCompanyId = normalizeId(companyId);
  const normalizedUserId = normalizeId(userId);
  const cleanNotificationType = cleanType(type);
  const cleanTitle = cleanText(title, 200);
  const cleanBody = cleanText(message, 4000);
  if (!normalizedCompanyId || !cleanNotificationType || !cleanTitle || !cleanBody) {
    return null;
  }
  await ensureNotificationsSchema();
  const existing = await pool.query(
    `
    SELECT id
    FROM notifications
    WHERE company_id = $1
      AND type = $2
      AND title = $3
      AND COALESCE(body, '') = $4
      AND customer_id IS NULL
      AND (($5::int IS NULL AND user_id IS NULL) OR user_id = $5)
      AND DATE(created_at) = CURRENT_DATE
    LIMIT 1
    `,
    [normalizedCompanyId, cleanNotificationType, cleanTitle, cleanBody, normalizedUserId]
  );
  if (!existing.rows.length) {
    return createNotification({
      companyId: normalizedCompanyId,
      userId: normalizedUserId,
      type: cleanNotificationType,
      title: cleanTitle,
      body: cleanBody,
      linkUrl: metadata && typeof metadata.link_url === "string" ? metadata.link_url : null
    });
  }
  return null;
}

async function syncAlerts(companyId) {
  const today = await pool.query(`
    SELECT jobs.id, jobs.start_time, clients.name AS client_name
    FROM jobs
    LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
    WHERE jobs.company_id = $1
      AND jobs.date = CURRENT_DATE
      AND jobs.status IN ('scheduled', 'assigned')
      AND jobs.start_time <= NOW()::time
  `, [companyId]);

  for (const job of today.rows) {
    await createNotificationIfMissing({
      companyId,
      type: "alert_job_today_not_started",
      title: "Job today not started",
      message: `${job.client_name || "Client"} has a job scheduled for today that has not started yet.`
    });
  }

  const overdue = await pool.query(`
    SELECT jobs.id, clients.name AS client_name
    FROM jobs
    LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
    WHERE jobs.company_id = $1
      AND jobs.date < CURRENT_DATE
      AND jobs.status IN ('scheduled', 'assigned', 'in_progress')
  `, [companyId]);

  for (const job of overdue.rows) {
    await createNotificationIfMissing({
      companyId,
      type: "alert_overdue_job",
      title: "Overdue job",
      message: `${job.client_name || "Client"} has an overdue job that still needs attention.`
    });
  }

  const unpaid = await pool.query(`
    SELECT invoices.id, clients.name AS client_name
    FROM invoices
    LEFT JOIN clients ON clients.id = invoices.client_id AND clients.company_id = invoices.company_id
    WHERE invoices.company_id = $1
      AND invoices.status IN ('unpaid', 'overdue')
  `, [companyId]);

  for (const invoice of unpaid.rows) {
    await createNotificationIfMissing({
      companyId,
      type: "alert_unpaid_invoice",
      title: "Unpaid invoice",
      message: `${invoice.client_name || "Client"} has an unpaid invoice that needs follow-up.`
    });
  }
}

async function createFinancialNotification({ companyId, type, title, message, metadata = null }) {
  return ensureUniqueNotification({ companyId, type, title, message, metadata });
}

async function notifyMarketplaceRequestCreated({ companyId, customerId, requestId, service }) {
  return createNotification({
    companyId,
    customerId,
    type: "marketplace",
    title: "Marketplace request created",
    body: `${service || "Service request"} is now in the marketplace queue.`,
    linkUrl: requestId ? `/marketplace?request=${Number(requestId)}` : ""
  });
}

/** Customer-submitted workflow lead (estimates row); link targets leads UI, not marketplace_requests. */
async function notifyCustomerServiceLeadCreated({ companyId, customerId, leadId, service }) {
  const id = leadId != null ? Number(leadId) : null;
  const linkUrl = Number.isInteger(id) && id > 0
    ? `/estimates.html?view=leads&lead=${id}`
    : "/estimates.html?view=leads";
  return createNotification({
    companyId,
    customerId,
    type: "system",
    title: "New customer service request",
    body: `${service || "Service request"} — a customer submitted a new lead.`,
    linkUrl
  });
}

async function notifyOfferReceived({ customerId, requestId, companyName }) {
  return createNotification({
    customerId,
    type: "marketplace",
    title: "New offer received",
    body: `${companyName || "A company"} sent a new offer for your request.`,
    linkUrl: requestId ? `/customer-dashboard.html?request=${Number(requestId)}` : ""
  });
}

async function notifySupportTicketCreated({ companyId, customerId, ticketId, subject }) {
  return createNotification({
    companyId,
    customerId,
    type: "support",
    title: "Support ticket created",
    body: subject || "A new support ticket was opened.",
    linkUrl: ticketId ? `/support?ticket=${Number(ticketId)}` : ""
  });
}

async function notifyDisputeOpened({ companyId, customerId, disputeId, reason }) {
  return createNotification({
    companyId,
    customerId,
    type: "dispute",
    title: "Dispute opened",
    body: reason || "A new dispute was opened and requires review.",
    linkUrl: disputeId ? `/disputes?id=${Number(disputeId)}` : ""
  });
}

async function notifyVerificationApproved({ companyId }) {
  return createNotification({
    companyId,
    type: "verification",
    title: "Verification approved",
    body: "Your company verification has been approved.",
    linkUrl: "/control.html?page=settings"
  });
}

async function notifyBillingWarning({ companyId, warningMessage }) {
  return createNotification({
    companyId,
    type: "billing",
    title: "Billing warning",
    body: warningMessage || "A billing lifecycle warning needs review.",
    linkUrl: "/control.html?page=billing"
  });
}

module.exports = {
  ALLOWED_TYPES,
  ensureNotificationsSchema,
  createNotification,
  listNotificationsForUser,
  markNotificationRead,
  countUnreadNotifications,
  ensureUniqueNotification,
  createNotificationIfMissing,
  createFinancialNotification,
  syncAlerts,
  notifyMarketplaceRequestCreated,
  notifyCustomerServiceLeadCreated,
  notifyOfferReceived,
  notifySupportTicketCreated,
  notifyDisputeOpened,
  notifyVerificationApproved,
  notifyBillingWarning
};

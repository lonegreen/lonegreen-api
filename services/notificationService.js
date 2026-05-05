const pool = require("../db/pool");

let notificationsSchemaReadyPromise = null;

async function ensureNotificationsSchema() {
  if (!notificationsSchemaReadyPromise) {
    notificationsSchemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          user_id INTEGER,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
    })().catch(err => {
      notificationsSchemaReadyPromise = null;
      throw err;
    });
  }

  return notificationsSchemaReadyPromise;
}

async function createNotification({ companyId, userId = null, type, title, message, metadata = null }) {
  await ensureNotificationsSchema();

  const metaJson = JSON.stringify(metadata && typeof metadata === "object" ? metadata : {});

  const result = await pool.query(`
    INSERT INTO notifications (company_id, user_id, type, title, message, metadata)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    RETURNING id, company_id, user_id, type, title, message, is_read, metadata, created_at
  `, [companyId, userId, type, title, message, metaJson]);

  return result.rows[0];
}

async function ensureUniqueNotification({ companyId, userId = null, type, title, message, metadata = null }) {
  await ensureNotificationsSchema();

  const existing = await pool.query(`
    SELECT id
    FROM notifications
    WHERE company_id = $1
      AND type = $2
      AND title = $3
      AND message = $4
      AND is_read = FALSE
    LIMIT 1
  `, [companyId, type, title, message]);

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  return createNotification({ companyId, userId, type, title, message, metadata });
}

async function createNotificationIfMissing({ companyId, type, title, message, userId = null, metadata = null }) {
  await ensureNotificationsSchema();

  const existing = await pool.query(`
    SELECT id
    FROM notifications
    WHERE company_id = $1
      AND type = $2
      AND title = $3
      AND message = $4
      AND DATE(created_at) = CURRENT_DATE
    LIMIT 1
  `, [companyId, type, title, message]);

  if (existing.rows.length === 0) {
    const metaJson = JSON.stringify(metadata && typeof metadata === "object" ? metadata : {});
    await pool.query(`
      INSERT INTO notifications (company_id, user_id, type, title, message, is_read, metadata)
      VALUES ($1,$2,$3,$4,$5,FALSE,$6::jsonb)
    `, [companyId, userId, type, title, message, metaJson]);
  }
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

module.exports = {
  ensureNotificationsSchema,
  createNotification,
  ensureUniqueNotification,
  createNotificationIfMissing,
  createFinancialNotification,
  syncAlerts
};

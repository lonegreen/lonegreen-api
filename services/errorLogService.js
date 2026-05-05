const pool = require("../db/pool");
const logger = require("./logger");

let schemaReadyPromise = null;

async function ensureErrorLogsSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS error_logs (
          id BIGSERIAL PRIMARY KEY,
          route TEXT NOT NULL DEFAULT '',
          method TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL DEFAULT '',
          stack TEXT,
          company_id INTEGER,
          user_id INTEGER,
          severity TEXT NOT NULL DEFAULT 'error',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_error_logs_created
        ON error_logs (created_at DESC, id DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_error_logs_company
        ON error_logs (company_id, created_at DESC)
      `);
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

async function logErrorEntry({
  route = "",
  method = "",
  message = "",
  stack = null,
  companyId = null,
  userId = null,
  severity = "error",
  metadata = {}
}) {
  try {
    await ensureErrorLogsSchema();
    await pool.query(
      `
      INSERT INTO error_logs (route, method, message, stack, company_id, user_id, severity, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        String(route || "").slice(0, 2000),
        String(method || "").slice(0, 32),
        String(message || "").slice(0, 8000),
        stack != null ? String(stack).slice(0, 32000) : null,
        companyId != null ? Number(companyId) : null,
        userId != null ? Number(userId) : null,
        String(severity || "error").slice(0, 32),
        JSON.stringify(metadata && typeof metadata === "object" ? metadata : {})
      ]
    );
  } catch (err) {
    logger.error("ERROR_LOG_PERSIST_FAILED", err);
  }
}

async function listRecentErrorLogs({ limit = 100 } = {}) {
  await ensureErrorLogsSchema();
  const cap = Math.min(500, Math.max(1, Number(limit) || 100));
  const r = await pool.query(
    `
    SELECT id, route, method, message, stack, company_id, user_id, severity, metadata, created_at
    FROM error_logs
    ORDER BY created_at DESC, id DESC
    LIMIT $1
    `,
    [cap]
  );
  return r.rows;
}

module.exports = {
  ensureErrorLogsSchema,
  logErrorEntry,
  listRecentErrorLogs
};

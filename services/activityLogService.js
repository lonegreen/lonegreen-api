const pool = require("../db/pool");

let activitySchemaReadyPromise = null;

async function ensureActivityLogSchema() {
  if (!activitySchemaReadyPromise) {
    activitySchemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_log (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          user_id INTEGER,
          action TEXT NOT NULL,
          entity_type TEXT,
          entity_id INTEGER,
          details JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    })().catch(err => {
      activitySchemaReadyPromise = null;
      throw err;
    });
  }

  return activitySchemaReadyPromise;
}

async function logActivity({ companyId, userId, action, entityType, entityId = null, details = {} }) {
  await ensureActivityLogSchema();

  await pool.query(`
    INSERT INTO activity_log (company_id, user_id, action, entity_type, entity_id, details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
  `, [
    companyId,
    userId || null,
    action,
    entityType || null,
    entityId,
    JSON.stringify(details || {})
  ]);
}

function valuesEqual(left, right) {
  if (left instanceof Date) {
    left = left.toISOString();
  }
  if (right instanceof Date) {
    right = right.toISOString();
  }

  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function pickChangedFields(before = {}, after = {}, fields = []) {
  const changes = {
    before: {},
    after: {}
  };

  for (const field of fields) {
    const beforeValue = before ? before[field] : undefined;
    const afterValue = after ? after[field] : undefined;

    if (!valuesEqual(beforeValue, afterValue)) {
      changes.before[field] = beforeValue ?? null;
      changes.after[field] = afterValue ?? null;
    }
  }

  return changes;
}

async function logChange({
  companyId,
  userId,
  action,
  entityType,
  entityId = null,
  before = {},
  after = {},
  metadata = {}
}) {
  return logActivity({
    companyId,
    userId,
    action,
    entityType,
    entityId,
    details: {
      before: before || {},
      after: after || {},
      metadata: metadata || {}
    }
  });
}

module.exports = {
  ensureActivityLogSchema,
  logActivity,
  logChange,
  pickChangedFields
};

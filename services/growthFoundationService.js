/**
 * Phase 0 unified foundation events + read-model metrics (company/worker/customer + platform aggregates).
 * Company-scoped writes use activity_log with company_id set; platform-only events use NULL company_id.
 */
const pool = require("../db/pool");
const activityLogService = require("./activityLogService");

const FOUNDATION_EVENT_NAMES = Object.freeze([
  "lead_created",
  "estimate_created",
  "estimate_approved",
  "job_created",
  "job_completed",
  "invoice_created",
  "invoice_paid",
  "subscription_created",
  "subscription_billed",
  "marketplace_request_created",
  "marketplace_offer_created",
  "marketplace_offer_accepted",
  "review_created",
  "message_sent"
]);

function assertPositiveCompanyId(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

async function logPlatformEvent({
  userId = null,
  action,
  entityType = null,
  entityId = null,
  details = {}
}) {
  if (!action || typeof action !== "string") {
    throw new Error("logPlatformEvent: action is required");
  }
  return activityLogService.logActivity({
    companyId: null,
    userId,
    action,
    entityType,
    entityId,
    details
  });
}

async function safeCount(sql, params, label) {
  try {
    const result = await pool.query(sql, params);
    const row = result.rows[0] || {};
    const keys = Object.keys(row);
    const val = keys.length ? row[keys[0]] : 0;
    return Number(val || 0);
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "growth_foundation_metrics_table_missing",
        query: label,
        message: err.message
      }));
      return 0;
    }
    throw err;
  }
}

async function getCompanyMetrics(companyId) {
  const cid = assertPositiveCompanyId(companyId);
  if (!cid) {
    return null;
  }

  const [
    leads_total,
    estimates_total,
    estimates_approved,
    jobs_total,
    jobs_completed,
    invoices_total,
    invoices_paid_status,
    payments_recorded,
    subscriptions_active,
    reviews_total,
    marketplace_offers_total,
    marketplace_offers_accepted,
    messages_total
  ] = await Promise.all([
    safeCount(
      `SELECT COUNT(*)::int AS c FROM estimates
       WHERE company_id = $1 AND record_type = 'lead' AND COALESCE(archived, FALSE) = FALSE`,
      [cid],
      "gf_leads"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM estimates
       WHERE company_id = $1 AND record_type = 'estimate' AND COALESCE(archived, FALSE) = FALSE`,
      [cid],
      "gf_estimates"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM estimates
       WHERE company_id = $1 AND record_type = 'estimate' AND COALESCE(archived, FALSE) = FALSE
         AND LOWER(TRIM(status)) = 'approved'`,
      [cid],
      "gf_estimates_approved"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM jobs WHERE company_id = $1`,
      [cid],
      "gf_jobs"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM jobs WHERE company_id = $1 AND LOWER(TRIM(status)) = 'completed'`,
      [cid],
      "gf_jobs_completed"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM invoices WHERE company_id = $1`,
      [cid],
      "gf_invoices"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM invoices WHERE company_id = $1 AND LOWER(TRIM(status)) = 'paid'`,
      [cid],
      "gf_invoices_paid"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM payments WHERE company_id = $1`,
      [cid],
      "gf_payments"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM subscriptions WHERE company_id = $1 AND LOWER(TRIM(status)) = 'active'`,
      [cid],
      "gf_subscriptions_active"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM company_reviews WHERE company_id = $1`,
      [cid],
      "gf_reviews"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM marketplace_offers WHERE company_id = $1`,
      [cid],
      "gf_marketplace_offers"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM marketplace_offers WHERE company_id = $1 AND LOWER(TRIM(status)) = 'accepted'`,
      [cid],
      "gf_marketplace_offers_accepted"
    ),
    safeCount(
      `
      SELECT COUNT(m.id)::int AS c
      FROM messages m
      INNER JOIN conversations conv ON conv.id = m.conversation_id
      WHERE conv.company_id = $1
      `,
      [cid],
      "gf_messages"
    )
  ]);

  const foundation_events_last_90d = await safeFoundationEventCounts(cid, 90);

  return {
    leads_total,
    estimates_total,
    estimates_approved,
    jobs_total,
    jobs_completed,
    invoices_total,
    invoices_paid_status,
    payments_recorded,
    subscriptions_active,
    reviews_total,
    marketplace_offers_total,
    marketplace_offers_accepted,
    messages_total,
    foundation_events_last_90d
  };
}

async function safeFoundationEventCounts(companyId, days) {
  try {
    const result = await pool.query(
      `
      SELECT action, COUNT(*)::int AS c
      FROM activity_log
      WHERE company_id = $1
        AND created_at >= CURRENT_TIMESTAMP - ($2::int * INTERVAL '1 day')
        AND action = ANY($3::text[])
      GROUP BY action
      `,
      [companyId, Number(days) || 90, [...FOUNDATION_EVENT_NAMES]]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.action] = Number(row.c || 0);
    }
    return map;
  } catch (err) {
    if (err && err.code === "42P01") {
      return {};
    }
    throw err;
  }
}

async function getWorkerMetrics(companyId, workerId = null) {
  const cid = assertPositiveCompanyId(companyId);
  if (!cid) {
    return null;
  }

  const wid = workerId != null ? Number(workerId) : null;
  if (wid != null && (!Number.isInteger(wid) || wid <= 0)) {
    return { error: "invalid_worker_id" };
  }

  const params = wid != null ? [cid, wid] : [cid];
  const workerClause = wid != null ? "AND w.id = $2" : "";

  const result = await pool.query(
    `
    SELECT
      w.id,
      w.name,
      COALESCE(COUNT(j.id), 0)::int AS jobs_total,
      COALESCE(COUNT(j.id) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed'), 0)::int AS jobs_completed
    FROM workers w
    LEFT JOIN jobs j ON j.worker_id = w.id AND j.company_id = w.company_id
    WHERE w.company_id = $1
      ${workerClause}
    GROUP BY w.id, w.name
    ORDER BY w.name ASC, w.id ASC
    `,
    params
  );

  return {
    workers: result.rows.map((row) => ({
      worker_id: row.id,
      name: row.name,
      jobs_total: Number(row.jobs_total || 0),
      jobs_completed: Number(row.jobs_completed || 0)
    }))
  };
}

async function getCustomerMetrics(companyId) {
  const cid = assertPositiveCompanyId(companyId);
  if (!cid) {
    return null;
  }

  try {
    const row = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_clients,
        COUNT(*) FILTER (WHERE COALESCE(c.archived, FALSE) = FALSE)::int AS active_clients,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.company_id = c.company_id AND j.client_id = c.id
            AND LOWER(TRIM(j.status)) = 'completed'
        ))::int AS clients_with_completed_job
      FROM clients c
      WHERE c.company_id = $1
      `,
      [cid]
    );
    const r = row.rows[0] || {};
    return {
      total_clients: Number(r.total_clients || 0),
      active_clients: Number(r.active_clients || 0),
      clients_with_completed_job: Number(r.clients_with_completed_job || 0)
    };
  } catch (err) {
    if (err && err.code === "42P01") {
      return {
        total_clients: 0,
        active_clients: 0,
        clients_with_completed_job: 0
      };
    }
    throw err;
  }
}

async function getPlatformFoundationMetrics() {
  const companies = await safeCount(`SELECT COUNT(*)::int AS c FROM companies`, [], "gf_platform_companies");

  const [
    leads_total,
    estimates_total,
    jobs_total,
    invoices_total,
    payments_total,
    marketplace_requests_total,
    marketplace_offers_total,
    reviews_total,
    messages_total,
    subscriptions_active,
    platform_events_last_90d
  ] = await Promise.all([
    safeCount(
      `SELECT COUNT(*)::int AS c FROM estimates WHERE record_type = 'lead' AND COALESCE(archived, FALSE) = FALSE`,
      [],
      "gf_platform_leads"
    ),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM estimates WHERE record_type = 'estimate' AND COALESCE(archived, FALSE) = FALSE`,
      [],
      "gf_platform_estimates"
    ),
    safeCount(`SELECT COUNT(*)::int AS c FROM jobs`, [], "gf_platform_jobs"),
    safeCount(`SELECT COUNT(*)::int AS c FROM invoices`, [], "gf_platform_invoices"),
    safeCount(`SELECT COUNT(*)::int AS c FROM payments`, [], "gf_platform_payments"),
    safeCount(`SELECT COUNT(*)::int AS c FROM marketplace_requests`, [], "gf_platform_mr"),
    safeCount(`SELECT COUNT(*)::int AS c FROM marketplace_offers`, [], "gf_platform_mo"),
    safeCount(`SELECT COUNT(*)::int AS c FROM company_reviews`, [], "gf_platform_reviews"),
    safeCount(`SELECT COUNT(*)::int AS c FROM messages`, [], "gf_platform_messages"),
    safeCount(
      `SELECT COUNT(*)::int AS c FROM subscriptions WHERE LOWER(TRIM(status)) = 'active'`,
      [],
      "gf_platform_subs"
    ),
    safePlatformFoundationEventCounts(90)
  ]);

  return {
    generated_at: new Date().toISOString(),
    totals: {
      companies,
      leads_total,
      estimates_total,
      jobs_total,
      invoices_total,
      payments_total,
      subscriptions_active,
      marketplace_requests_total,
      marketplace_offers_total,
      reviews_total,
      messages_total
    },
    platform_activity_log_events_last_90d: platform_events_last_90d
  };
}

async function safePlatformFoundationEventCounts(days) {
  try {
    const result = await pool.query(
      `
      SELECT action, COUNT(*)::int AS c
      FROM activity_log
      WHERE company_id IS NULL
        AND created_at >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
        AND action = ANY($2::text[])
      GROUP BY action
      `,
      [Number(days) || 90, [...FOUNDATION_EVENT_NAMES]]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.action] = Number(row.c || 0);
    }
    return map;
  } catch (err) {
    if (err && err.code === "42P01") {
      return {};
    }
    throw err;
  }
}

module.exports = {
  FOUNDATION_EVENT_NAMES,
  logPlatformEvent,
  getCompanyMetrics,
  getWorkerMetrics,
  getCustomerMetrics,
  getPlatformFoundationMetrics
};

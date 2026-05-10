const pool = require("../db/pool");
const activityLogService = require("./activityLogService");

const LOOP_TYPES = new Set([
  "win-back",
  "reactivation",
  "abandoned-estimates",
  "unfinished-bookings",
  "review-requests",
  "referral-follow-ups",
  "subscription-upgrades"
]);

function assertCompanyId(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("Invalid company id");
    err.code = "INVALID_COMPANY_ID";
    throw err;
  }
  return id;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeLimit(limit) {
  const parsed = Number(limit);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

function nowIso() {
  return new Date().toISOString();
}

async function safeRows(sql, params, label) {
  try {
    const result = await pool.query(sql, params);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    if (err && (err.code === "42P01" || err.code === "42703")) {
      console.log(JSON.stringify({
        level: "warn",
        event: "growth_loop_signal_unavailable",
        signal: label,
        message: err.message
      }));
      return [];
    }
    throw err;
  }
}

function shapeClient(row, type, reason, score) {
  return {
    opportunity_id: Number(row.opportunity_id || row.client_id),
    type,
    client_id: row.client_id != null ? Number(row.client_id) : null,
    client_name: row.client_name || "",
    phone: row.phone || "",
    reason,
    priority_score: num(score),
    last_activity_at: row.last_activity_at || null,
    metrics: row.metrics && typeof row.metrics === "object" ? row.metrics : {}
  };
}

async function getWinBackOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    WITH completed AS (
      SELECT
        j.client_id,
        COUNT(*)::int AS completed_jobs,
        MAX(j.date) AS last_completed_date
      FROM jobs j
      WHERE j.company_id = $1
        AND j.client_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(j.status, ''))) = 'completed'
      GROUP BY j.client_id
    )
    SELECT
      c.id AS client_id,
      c.id AS opportunity_id,
      COALESCE(c.name, '') AS client_name,
      COALESCE(c.phone, '') AS phone,
      completed.completed_jobs,
      completed.last_completed_date AS last_activity_at,
      jsonb_build_object(
        'completed_jobs', completed.completed_jobs,
        'last_completed_date', completed.last_completed_date,
        'idle_days', EXTRACT(DAY FROM (CURRENT_DATE::timestamp - completed.last_completed_date::timestamp))
      ) AS metrics
    FROM completed
    JOIN clients c ON c.id = completed.client_id AND c.company_id = $1
    WHERE COALESCE(c.archived, FALSE) = FALSE
      AND completed.last_completed_date < CURRENT_DATE - INTERVAL '60 days'
      AND completed.last_completed_date >= CURRENT_DATE - INTERVAL '120 days'
      AND NOT EXISTS (
        SELECT 1 FROM jobs future
        WHERE future.company_id = $1
          AND future.client_id = c.id
          AND future.date >= CURRENT_DATE
          AND LOWER(TRIM(COALESCE(future.status, ''))) IN ('scheduled', 'assigned', 'in_progress')
      )
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.company_id = $1
          AND s.client_id = c.id
          AND LOWER(TRIM(COALESCE(s.status, ''))) = 'active'
      )
    ORDER BY completed.last_completed_date ASC, completed.completed_jobs DESC, c.id ASC
    LIMIT $2
  `, [id, limit], "win_back");

  return rows.map((row) => shapeClient(
    row,
    "win-back",
    "Completed work 60-120 days ago with no active future job or subscription",
    Math.min(100, 40 + num(row.completed_jobs) * 8)
  ));
}

async function getReactivationOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    WITH paid AS (
      SELECT
        i.client_id,
        COUNT(*)::int AS paid_invoices,
        MAX(COALESCE(i.paid_at::date, i.issued_date)) AS last_paid_date,
        COALESCE(SUM(i.amount), 0)::numeric AS paid_total
      FROM invoices i
      WHERE i.company_id = $1
        AND i.client_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(i.status, ''))) = 'paid'
      GROUP BY i.client_id
    ),
    recent AS (
      SELECT DISTINCT client_id
      FROM jobs
      WHERE company_id = $1
        AND client_id IS NOT NULL
        AND date >= CURRENT_DATE - INTERVAL '120 days'
    )
    SELECT
      c.id AS client_id,
      c.id AS opportunity_id,
      COALESCE(c.name, '') AS client_name,
      COALESCE(c.phone, '') AS phone,
      paid.paid_invoices,
      paid.paid_total,
      paid.last_paid_date AS last_activity_at,
      jsonb_build_object(
        'paid_invoices', paid.paid_invoices,
        'paid_total', paid.paid_total,
        'last_paid_date', paid.last_paid_date
      ) AS metrics
    FROM paid
    JOIN clients c ON c.id = paid.client_id AND c.company_id = $1
    LEFT JOIN recent ON recent.client_id = c.id
    WHERE COALESCE(c.archived, FALSE) = FALSE
      AND recent.client_id IS NULL
      AND paid.last_paid_date < CURRENT_DATE - INTERVAL '120 days'
    ORDER BY paid.paid_total DESC, paid.last_paid_date ASC, c.id ASC
    LIMIT $2
  `, [id, limit], "reactivation");

  return rows.map((row) => shapeClient(
    row,
    "reactivation",
    "Past paid customer with no recent job activity",
    Math.min(100, 35 + num(row.paid_invoices) * 6 + Math.min(25, num(row.paid_total) / 100))
  ));
}

async function getAbandonedEstimateOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    SELECT
      e.id AS opportunity_id,
      e.id AS estimate_id,
      e.client_id,
      COALESCE(c.name, e.customer_name, '') AS client_name,
      COALESCE(c.phone, e.phone, '') AS phone,
      COALESCE(e.service, '') AS service,
      e.status,
      e.quoted_price,
      e.visit_date,
      e.created_at AS last_activity_at,
      jsonb_build_object(
        'estimate_id', e.id,
        'status', e.status,
        'quoted_price', e.quoted_price,
        'visit_date', e.visit_date
      ) AS metrics
    FROM estimates e
    LEFT JOIN clients c ON c.id = e.client_id AND c.company_id = e.company_id
    WHERE e.company_id = $1
      AND COALESCE(e.archived, FALSE) = FALSE
      AND COALESCE(e.record_type, 'estimate') = 'estimate'
      AND LOWER(TRIM(COALESCE(e.status, ''))) IN ('sent', 'pending', 'quoted', 'contacted', 'new')
      AND COALESCE(e.created_at, e.visit_date::timestamp, CURRENT_TIMESTAMP) < CURRENT_TIMESTAMP - INTERVAL '7 days'
      AND e.converted_job_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.company_id = e.company_id
          AND j.estimate_id = e.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM estimates accepted
        WHERE accepted.company_id = e.company_id
          AND accepted.client_id IS NOT DISTINCT FROM e.client_id
          AND accepted.id <> e.id
          AND LOWER(TRIM(COALESCE(accepted.status, ''))) IN ('approved', 'converted')
      )
    ORDER BY COALESCE(e.created_at, e.visit_date::timestamp) ASC, e.id ASC
    LIMIT $2
  `, [id, limit], "abandoned_estimates");

  return rows.map((row) => ({
    opportunity_id: Number(row.opportunity_id),
    type: "abandoned-estimates",
    estimate_id: Number(row.estimate_id),
    client_id: row.client_id != null ? Number(row.client_id) : null,
    client_name: row.client_name || "",
    phone: row.phone || "",
    service: row.service || "",
    reason: "Estimate is older than 7 days and has not converted to accepted work",
    priority_score: Math.min(100, 45 + Math.min(35, num(row.quoted_price) / 50)),
    last_activity_at: row.last_activity_at || null,
    metrics: row.metrics || {}
  }));
}

async function getUnfinishedBookingOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    SELECT
      mr.id AS opportunity_id,
      mr.id AS marketplace_request_id,
      mr.client_id,
      COALESCE(c.name, '') AS client_name,
      COALESCE(c.phone, '') AS phone,
      COALESCE(mr.title, '') AS title,
      mr.status,
      mr.created_at AS last_activity_at,
      jsonb_build_object(
        'marketplace_request_id', mr.id,
        'status', mr.status,
        'category_id', mr.category_id,
        'created_at', mr.created_at
      ) AS metrics
    FROM marketplace_requests mr
    LEFT JOIN clients c ON c.id = mr.client_id
    WHERE mr.accepted_offer_id IS NULL
      AND LOWER(TRIM(COALESCE(mr.status, ''))) IN ('open', 'pending')
      AND mr.created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'
      AND EXISTS (
        SELECT 1
        FROM companies co
        JOIN company_services cs
          ON cs.company_id = co.id
         AND cs.active = TRUE
         AND cs.category_id = mr.category_id
        JOIN company_service_areas csa
          ON csa.company_id = co.id
         AND csa.active = TRUE
        WHERE co.id = $1
          AND co.is_public = TRUE
          AND co.platform_suspended_at IS NULL
          AND (
            (COALESCE(mr.zip_code, '') <> '' AND LEFT(REGEXP_REPLACE(COALESCE(csa.zip_code, ''), '[^0-9]', '', 'g'), 5) = LEFT(REGEXP_REPLACE(COALESCE(mr.zip_code, ''), '[^0-9]', '', 'g'), 5))
            OR (COALESCE(mr.city, '') <> '' AND LOWER(csa.city) = LOWER(mr.city))
            OR (COALESCE(mr.state, '') <> '' AND UPPER(csa.state) = UPPER(mr.state))
          )
      )
    ORDER BY mr.created_at ASC, mr.id ASC
    LIMIT $2
  `, [id, limit], "unfinished_bookings");

  return rows.map((row) => ({
    opportunity_id: Number(row.opportunity_id),
    type: "unfinished-bookings",
    marketplace_request_id: Number(row.marketplace_request_id),
    client_id: row.client_id != null ? Number(row.client_id) : null,
    client_name: row.client_name || "",
    phone: row.phone || "",
    title: row.title || "",
    reason: "Open marketplace request has no accepted offer after 24 hours",
    priority_score: 55,
    last_activity_at: row.last_activity_at || null,
    metrics: row.metrics || {}
  }));
}

async function getReviewRequestOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    SELECT
      j.id AS opportunity_id,
      j.id AS job_id,
      j.client_id,
      COALESCE(c.name, '') AS client_name,
      COALESCE(c.phone, '') AS phone,
      COALESCE(j.service, '') AS service,
      j.date AS last_activity_at,
      jsonb_build_object(
        'job_id', j.id,
        'service', j.service,
        'completed_date', j.date
      ) AS metrics
    FROM jobs j
    JOIN clients c ON c.id = j.client_id AND c.company_id = j.company_id
    WHERE j.company_id = $1
      AND j.client_id IS NOT NULL
      AND COALESCE(c.archived, FALSE) = FALSE
      AND LOWER(TRIM(COALESCE(j.status, ''))) = 'completed'
      AND j.date >= CURRENT_DATE - INTERVAL '14 days'
      AND j.date <= CURRENT_DATE - INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM company_reviews cr
        WHERE cr.company_id = j.company_id
          AND (cr.job_id = j.id OR cr.client_id = j.client_id)
      )
    ORDER BY j.date DESC, j.id DESC
    LIMIT $2
  `, [id, limit], "review_requests");

  return rows.map((row) => ({
    opportunity_id: Number(row.opportunity_id),
    type: "review-requests",
    job_id: Number(row.job_id),
    client_id: row.client_id != null ? Number(row.client_id) : null,
    client_name: row.client_name || "",
    phone: row.phone || "",
    service: row.service || "",
    reason: "Completed job is 3-14 days old and has no review",
    priority_score: 60,
    last_activity_at: row.last_activity_at || null,
    metrics: row.metrics || {}
  }));
}

async function getReferralFollowUpOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    SELECT
      r.id AS opportunity_id,
      r.id AS referral_id,
      rc.id AS referral_code_id,
      rc.code,
      r.referred_customer_account_id,
      r.journey_status,
      r.status,
      r.updated_at AS last_activity_at,
      jsonb_build_object(
        'referral_id', r.id,
        'referral_code_id', rc.id,
        'journey_status', r.journey_status,
        'status', r.status
      ) AS metrics
    FROM referrals r
    JOIN referral_codes rc ON rc.id = r.code_id
    WHERE (rc.owner_company_id = $1 OR rc.scope_company_id = $1)
      AND COALESCE(r.journey_status, 'pending') IN ('visited', 'lead_created', 'request_created')
      AND COALESCE(r.journey_status, '') <> 'converted'
      AND COALESCE(r.updated_at, r.created_at) < CURRENT_TIMESTAMP - INTERVAL '2 days'
      AND NOT EXISTS (
        SELECT 1 FROM referral_conversions conv
        WHERE conv.referral_id = r.id
      )
    ORDER BY COALESCE(r.updated_at, r.created_at) ASC, r.id ASC
    LIMIT $2
  `, [id, limit], "referral_followups");

  return rows.map((row) => ({
    opportunity_id: Number(row.opportunity_id),
    type: "referral-follow-ups",
    referral_id: Number(row.referral_id),
    referral_code_id: Number(row.referral_code_id),
    code: row.code || "",
    client_id: null,
    client_name: "",
    reason: "Referral entered the funnel but has not converted after 2 days",
    priority_score: 50,
    last_activity_at: row.last_activity_at || null,
    metrics: row.metrics || {}
  }));
}

async function getSubscriptionUpgradeOpportunities(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const limit = normalizeLimit(options.limit);
  const rows = await safeRows(`
    WITH recent_completed AS (
      SELECT
        j.client_id,
        COUNT(*)::int AS completed_90d,
        MAX(j.date) AS last_completed_date,
        COALESCE(SUM(j.price), 0)::numeric AS recent_job_value
      FROM jobs j
      WHERE j.company_id = $1
        AND j.client_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(j.status, ''))) = 'completed'
        AND j.date >= CURRENT_DATE - INTERVAL '90 days'
      GROUP BY j.client_id
    )
    SELECT
      c.id AS client_id,
      c.id AS opportunity_id,
      COALESCE(c.name, '') AS client_name,
      COALESCE(c.phone, '') AS phone,
      rc.completed_90d,
      rc.recent_job_value,
      rc.last_completed_date AS last_activity_at,
      jsonb_build_object(
        'completed_jobs_90d', rc.completed_90d,
        'recent_job_value', rc.recent_job_value,
        'last_completed_date', rc.last_completed_date
      ) AS metrics
    FROM recent_completed rc
    JOIN clients c ON c.id = rc.client_id AND c.company_id = $1
    WHERE COALESCE(c.archived, FALSE) = FALSE
      AND rc.completed_90d >= 2
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.company_id = $1
          AND s.client_id = c.id
          AND LOWER(TRIM(COALESCE(s.status, ''))) = 'active'
      )
    ORDER BY rc.completed_90d DESC, rc.recent_job_value DESC, c.id ASC
    LIMIT $2
  `, [id, limit], "subscription_upgrades");

  return rows.map((row) => shapeClient(
    row,
    "subscription-upgrades",
    "Client has 2+ completed jobs in 90 days and no active subscription",
    Math.min(100, 50 + num(row.completed_90d) * 10 + Math.min(20, num(row.recent_job_value) / 100))
  ));
}

async function buildGrowthLoopsOverview(companyId, options = {}) {
  const id = assertCompanyId(companyId);
  const [
    winBack,
    reactivation,
    abandonedEstimates,
    unfinishedBookings,
    reviewRequests,
    referralFollowUps,
    subscriptionUpgrades
  ] = await Promise.all([
    getWinBackOpportunities(id, options),
    getReactivationOpportunities(id, options),
    getAbandonedEstimateOpportunities(id, options),
    getUnfinishedBookingOpportunities(id, options),
    getReviewRequestOpportunities(id, options),
    getReferralFollowUpOpportunities(id, options),
    getSubscriptionUpgradeOpportunities(id, options)
  ]);

  const loops = {
    "win-back": winBack,
    reactivation,
    "abandoned-estimates": abandonedEstimates,
    "unfinished-bookings": unfinishedBookings,
    "review-requests": reviewRequests,
    "referral-follow-ups": referralFollowUps,
    "subscription-upgrades": subscriptionUpgrades
  };
  const counts = Object.fromEntries(Object.entries(loops).map(([key, rows]) => [key, rows.length]));
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);

  if (options.logActivity) {
    await activityLogService.logActivity({
      companyId: id,
      userId: options.userId || null,
      action: "growth_loops_built",
      entityType: "company",
      entityId: id,
      details: { counts, total_opportunities: total }
    });
    const detected = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({ type, count }));
    if (detected.length) {
      await activityLogService.logActivity({
        companyId: id,
        userId: options.userId || null,
        action: "growth_loop_opportunity_detected",
        entityType: "growth_loop",
        entityId: null,
        details: { loops: detected }
      });
    }
  }

  return {
    company_id: id,
    generated_at: nowIso(),
    total_opportunities: total,
    counts,
    loops
  };
}

async function logGrowthLoopAction({ companyId, userId, type, opportunityId, action, details = {} }) {
  const id = assertCompanyId(companyId);
  const cleanType = String(type || "").trim();
  const sourceId = Number(opportunityId);
  if (!LOOP_TYPES.has(cleanType)) {
    const err = new Error("Invalid growth loop type");
    err.code = "INVALID_LOOP_TYPE";
    throw err;
  }
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    const err = new Error("Invalid opportunity id");
    err.code = "INVALID_OPPORTUNITY_ID";
    throw err;
  }
  await activityLogService.logActivity({
    companyId: id,
    userId: userId || null,
    action,
    entityType: "growth_loop_opportunity",
    entityId: sourceId,
    details: {
      type: cleanType,
      opportunity_id: sourceId,
      ...details
    }
  });
  return {
    ok: true,
    company_id: id,
    type: cleanType,
    opportunity_id: sourceId,
    action
  };
}

module.exports = {
  buildGrowthLoopsOverview,
  getWinBackOpportunities,
  getReactivationOpportunities,
  getAbandonedEstimateOpportunities,
  getUnfinishedBookingOpportunities,
  getReviewRequestOpportunities,
  getReferralFollowUpOpportunities,
  getSubscriptionUpgradeOpportunities,
  logGrowthLoopAction
};

const pool = require("../db/pool");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function planDisplayName(plan) {
  const p = String(plan || "").trim().toLowerCase();
  if (p === "starter") return "Basic";
  if (p === "pro") return "Pro";
  if (p === "enterprise") return "Business";
  return p || "Unknown";
}

/**
 * Read-only aggregates for platform_owner dashboards.
 * Excludes companies under platform suspension from MRR / active-style counts where noted.
 */
async function getPlatformBillingAnalytics() {
  const mrrRow = await pool.query(`
    SELECT COALESCE(SUM(monthly_price::numeric), 0)::numeric AS mrr
    FROM companies
    WHERE billing_status IN ('active', 'trial', 'trialing')
      AND (platform_suspended_at IS NULL)
      AND billing_status <> 'suspended'
  `);

  let activeSubscriptions = 0;
  let trialingSubscriptions = 0;
  try {
    const subsRow = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE cs.status = 'active' AND c.platform_suspended_at IS NULL)::int AS active,
        COUNT(*) FILTER (WHERE cs.status = 'trialing' AND c.platform_suspended_at IS NULL)::int AS trialing
      FROM company_subscriptions cs
      INNER JOIN companies c ON c.id = cs.company_id
    `);
    activeSubscriptions = num(subsRow.rows[0] && subsRow.rows[0].active);
    trialingSubscriptions = num(subsRow.rows[0] && subsRow.rows[0].trialing);
  } catch (err) {
    if (err && err.code !== "42P01") {
      throw err;
    }
  }

  const companyBillingRow = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE billing_status = 'past_due' AND (platform_suspended_at IS NULL))::int AS past_due,
      COUNT(*) FILTER (WHERE billing_last_payment_failed_at >= date_trunc('month', CURRENT_TIMESTAMP)
        AND (platform_suspended_at IS NULL))::int AS failed_payments_this_month,
      COUNT(*) FILTER (WHERE billing_cancelled_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS churn_this_month,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS new_companies_this_month
    FROM companies
  `);

  const planRev = await pool.query(`
    SELECT
      COALESCE(NULLIF(TRIM(LOWER(plan)), ''), 'starter') AS plan_key,
      COALESCE(SUM(monthly_price::numeric), 0)::numeric AS mrr
    FROM companies
    WHERE billing_status IN ('active', 'trial', 'trialing')
      AND (platform_suspended_at IS NULL)
      AND billing_status <> 'suspended'
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  const revenue_by_plan = {};
  for (const row of planRev.rows) {
    const key = row.plan_key || "starter";
    revenue_by_plan[planDisplayName(key)] = num(row.mrr);
  }

  const cb = companyBillingRow.rows[0] || {};

  return {
    generated_at: new Date().toISOString(),
    mrr: num(mrrRow.rows[0] && mrrRow.rows[0].mrr),
    active_subscriptions: activeSubscriptions,
    trialing_subscriptions: trialingSubscriptions,
    past_due_accounts: num(cb.past_due),
    failed_payments_accounts_this_month: num(cb.failed_payments_this_month),
    churn_count_this_month: num(cb.churn_this_month),
    new_companies_this_month: num(cb.new_companies_this_month),
    revenue_by_plan,
    notes: {
      mrr_scope: "Sum of companies.monthly_price for active/trial/trialing, excluding platform-suspended and billing_suspended.",
      subscriptions_scope: "company_subscriptions joined to companies; open lifecycle rows.",
      churn_scope: "Companies with billing_cancelled_at in current month (or cancelled status with cancel timestamp in month)."
    }
  };
}

module.exports = {
  getPlatformBillingAnalytics,
  planDisplayName
};

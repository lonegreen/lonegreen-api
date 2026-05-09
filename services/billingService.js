const pool = require("../db/pool");
const logger = require("./logger");
const {
  BILLING_GRACE_PERIOD_DAYS,
  NODE_ENV,
  BILLING_LIFECYCLE_AUTOMATION
} = require("../config/env");

/** Structured readiness signals for ops / future launch gates (does not enable automation). */
function getBillingLifecycleAutomationReadinessWarnings() {
  const prod = String(NODE_ENV || "").toLowerCase() === "production";
  if (prod && !BILLING_LIFECYCLE_AUTOMATION) {
    return [{
      code: "billing_lifecycle_automation_disabled",
      severity: "high",
      message: "BILLING_LIFECYCLE_AUTOMATION is false in production; scheduled past-due suspensions and period-end expiry are skipped"
    }];
  }
  return [];
}

(function logBillingLifecycleAutomationStartupDiagnostics() {
  const prod = String(NODE_ENV || "").toLowerCase() === "production";
  logger.info("BILLING_LIFECYCLE_AUTOMATION_STATUS", {
    env: NODE_ENV,
    enabled: BILLING_LIFECYCLE_AUTOMATION,
    unset_defaults_to:
      prod ? "true_when_BILLING_LIFECYCLE_AUTOMATION_unset" : "false_when_unset_in_non_production"
  });
  if (!BILLING_LIFECYCLE_AUTOMATION) {
    logger.warn("BILLING_LIFECYCLE_AUTOMATION_DISABLED", {
      env: NODE_ENV,
      scheduler_impact: "evaluatePastDueSuspensions_not_run_on_billing_lifecycle_cron",
      readiness_warnings: getBillingLifecycleAutomationReadinessWarnings()
    });
  }
  if (prod && !BILLING_LIFECYCLE_AUTOMATION) {
    logger.error("LAUNCH_READINESS_BILLING_LIFECYCLE_AUTOMATION_OFF", {
      severity: "production_configuration_risk",
      message: "Automated billing lifecycle (past-due suspension, incomplete expiry, cancel-at-period-end) is disabled in production.",
      remediation: "Set BILLING_LIFECYCLE_AUTOMATION=true after validating Stripe webhooks and suspension policy."
    });
  }
})();

const PLAN_LIMITS = {
  starter: {
    monthly_price: 0,
    max_users: 2,
    max_clients: 50,
    max_jobs_per_month: 100
  },
  pro: {
    monthly_price: 49,
    max_users: 10,
    max_clients: 500,
    max_jobs_per_month: 1000
  },
  enterprise: {
    monthly_price: 149,
    max_users: null,
    max_clients: null,
    max_jobs_per_month: null
  }
};

const BILLING_STATUSES = new Set([
  "trial",
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "canceled",
  "expired",
  "suspended",
  "unpaid",
  "incomplete",
  "paused"
]);
const COMPANY_SUBSCRIPTION_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
  "unpaid",
  "incomplete",
  "paused"
]);
const BILLING_CYCLES = new Set(["monthly", "yearly"]);
const PLAN_ORDER = ["starter", "pro", "enterprise"];
const MAX_TENANT_TRIAL_DAYS = 30;

function num(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePlan(plan) {
  const value = String(plan || "").trim().toLowerCase();
  return PLAN_LIMITS[value] ? value : "starter";
}

function requireKnownPlan(plan, fallback = null) {
  if ((plan === undefined || plan === null || plan === "") && fallback) {
    return fallback;
  }

  const value = String(plan || "").trim().toLowerCase();
  if (PLAN_LIMITS[value]) return value;

  throw subscriptionError("INVALID_PLAN", "Invalid company subscription plan", 400);
}

function normalizeBillingStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "canceled") return "cancelled";
  return BILLING_STATUSES.has(value) ? value : "trial";
}

function normalizeCompanySubscriptionStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "trial") return "trialing";
  if (value === "suspended") return "past_due";
  if (value === "canceled") return "cancelled";
  if (value === "incomplete_expired") return "expired";
  return COMPANY_SUBSCRIPTION_STATUSES.has(value) ? value : "trialing";
}

function normalizeBillingCycle(cycle) {
  const value = String(cycle || "").trim().toLowerCase();
  return BILLING_CYCLES.has(value) ? value : "monthly";
}

function legacyBillingStatus(status) {
  const normalized = normalizeCompanySubscriptionStatus(status);
  if (normalized === "trialing") return "trial";
  if (normalized === "expired") return "cancelled";
  if (normalized === "unpaid") return "unpaid";
  if (normalized === "incomplete") return "incomplete";
  if (normalized === "paused") return "paused";
  return normalized;
}

function isoDateOrNull(value, fallback = null) {
  if (value === null || value === "") return null;
  if (value === undefined) return fallback;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function addDaysIso(days, base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function addBillingPeriodIso(cycle = "monthly", base = new Date()) {
  const d = new Date(base);
  if (normalizeBillingCycle(cycle) === "yearly") {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString();
}

function getPlanLimits(plan = "starter") {
  const normalized = normalizePlan(plan);
  return {
    plan: normalized,
    monthly_price: PLAN_LIMITS[normalized].monthly_price,
    price_monthly: PLAN_LIMITS[normalized].monthly_price,
    max_users: PLAN_LIMITS[normalized].max_users,
    max_clients: PLAN_LIMITS[normalized].max_clients,
    max_jobs_per_month: PLAN_LIMITS[normalized].max_jobs_per_month
  };
}

function planRank(plan) {
  const index = PLAN_ORDER.indexOf(normalizePlan(plan));
  return index >= 0 ? index : 0;
}

function hasUsageWithinLimits(usage, limits) {
  const failures = [];

  if (limits.max_users != null && num(usage.users_count) > limits.max_users) {
    failures.push({ limit: "max_users", current: num(usage.users_count), max: limits.max_users });
  }

  if (limits.max_clients != null && num(usage.clients_count) > limits.max_clients) {
    failures.push({ limit: "max_clients", current: num(usage.clients_count), max: limits.max_clients });
  }

  if (limits.max_jobs_per_month != null && num(usage.jobs_this_month) > limits.max_jobs_per_month) {
    failures.push({ limit: "max_jobs_per_month", current: num(usage.jobs_this_month), max: limits.max_jobs_per_month });
  }

  return failures;
}

function subscriptionError(code, message, statusCode = 400, details = null) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
}

function normalizeTenantTrialDays(rawValue, defaultDays = 14) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return defaultDays;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw subscriptionError("INVALID_TRIAL_DAYS", "trial_days must be a valid number", 400);
  }

  const trialDays = Math.floor(parsed);
  if (trialDays < 0) {
    throw subscriptionError("INVALID_TRIAL_DAYS", "trial_days cannot be negative", 400);
  }

  if (trialDays > MAX_TENANT_TRIAL_DAYS) {
    throw subscriptionError(
      "TRIAL_DAYS_EXCEEDS_MAX",
      `trial_days exceeds safe maximum of ${MAX_TENANT_TRIAL_DAYS}`,
      400,
      { max_trial_days: MAX_TENANT_TRIAL_DAYS }
    );
  }

  return trialDays;
}

function graceDaysRemaining(graceUntil) {
  const d = graceUntil ? new Date(graceUntil) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function buildBillingAutomationFlags(billing) {
  const status = normalizeBillingStatus(billing && billing.billing_status);
  const remaining = graceDaysRemaining(billing && billing.billing_grace_until);
  const actions = [];

  if (status === "past_due" || status === "unpaid") {
    actions.push("payment_failed");
    if (remaining != null && remaining <= 0) {
      actions.push("grace_period_expired");
    }
  }

  if (status === "suspended") {
    actions.push("subscription_suspended");
  }

  if (status === "cancelled") {
    actions.push("subscription_cancelled");
  }

  if (status === "incomplete") {
    actions.push("checkout_incomplete");
  }

  if (status === "paused") {
    actions.push("collection_paused");
  }

  return {
    is_past_due: status === "past_due" || status === "unpaid",
    is_suspended: status === "suspended",
    is_incomplete: status === "incomplete",
    is_paused: status === "paused",
    grace_days_remaining: remaining,
    billing_actions_required: actions
  };
}

function computeTrialMeta(billing) {
  const billing_status = billing && billing.billing_status != null
    ? normalizeBillingStatus(billing.billing_status)
    : "trial";
  const rawEnd = billing && billing.trial_ends_at;
  const ends = rawEnd ? new Date(rawEnd) : null;
  const validEnd = ends && !Number.isNaN(ends.getTime()) ? ends : null;
  const now = new Date();
  let days_remaining = null;

  if (validEnd) {
    days_remaining = Math.ceil((validEnd.getTime() - now.getTime()) / 86400000);
  }

  let subscription_state = billing_status;

  if (billing_status === "incomplete") {
    return {
      billing_status,
      trial_ends_at: validEnd ? validEnd.toISOString() : null,
      days_remaining,
      is_trial_expired: false,
      subscription_state: "incomplete"
    };
  }

  if (billing_status === "unpaid") {
    return {
      billing_status,
      trial_ends_at: validEnd ? validEnd.toISOString() : null,
      days_remaining,
      is_trial_expired: false,
      subscription_state: "unpaid"
    };
  }

  if (billing_status === "paused") {
    return {
      billing_status,
      trial_ends_at: validEnd ? validEnd.toISOString() : null,
      days_remaining,
      is_trial_expired: false,
      subscription_state: "paused"
    };
  }

  if (billing_status === "trial" || billing_status === "trialing") {
    if (!validEnd) {
      subscription_state = billing_status === "trialing" ? "trialing" : "trial";
    } else if (validEnd < now) {
      subscription_state = "trial_expired";
    } else {
      subscription_state = billing_status === "trialing" ? "trialing" : "trial_active";
    }
  }

  return {
    billing_status,
    trial_ends_at: validEnd ? validEnd.toISOString() : null,
    days_remaining,
    is_trial_expired: (billing_status === "trial" || billing_status === "trialing") && Boolean(validEnd && validEnd < now),
    subscription_state
  };
}

function enrichBillingClientSummary(summary) {
  if (!summary || !summary.billing) {
    return summary;
  }

  const trial = computeTrialMeta(summary.billing);

  return {
    ...summary,
    trial,
    subscription_state: trial.subscription_state
  };
}

async function getPlatformBillingOverview() {
  const totalRow = await pool.query(`
    SELECT COUNT(*)::int AS total FROM companies
  `);

  const planRows = await pool.query(`
    SELECT plan, COUNT(*)::int AS c
    FROM companies
    GROUP BY plan
  `);

  const statusRows = await pool.query(`
    SELECT billing_status, COUNT(*)::int AS c
    FROM companies
    GROUP BY billing_status
  `);

  const trialsSoon = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM companies
    WHERE billing_status = 'trial'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at <= CURRENT_TIMESTAMP + INTERVAL '7 days'
      AND trial_ends_at >= CURRENT_TIMESTAMP
  `);

  const by_plan = { starter: 0, pro: 0, enterprise: 0 };
  for (const row of planRows.rows) {
    const key = normalizePlan(row.plan);
    by_plan[key] = num(row.c);
  }

  const by_status = {
    trial: 0,
    active: 0,
    past_due: 0,
    cancelled: 0,
    suspended: 0
  };

  for (const row of statusRows.rows) {
    const key = normalizeBillingStatus(row.billing_status);
    if (Object.prototype.hasOwnProperty.call(by_status, key)) {
      by_status[key] = num(row.c);
    }
  }

  const companiesList = await pool.query(`SELECT id FROM companies`);
  let companies_with_warnings = 0;

  for (const row of companiesList.rows) {
    const w = await getBillingWarnings(row.id);
    const list = w && Array.isArray(w.warnings) ? w.warnings : [];

    if (list.length) {
      companies_with_warnings += 1;
    }
  }

  return {
    companies_total: num(totalRow.rows[0] && totalRow.rows[0].total),
    by_plan,
    by_status,
    trials_expiring_within_7_days: num(trialsSoon.rows[0] && trialsSoon.rows[0].c),
    companies_with_warnings,
    warning_mode: true
  };
}

async function updateCompanyPlatformSubscription(companyId, patch = {}) {
  const cur = await pool.query(`
    SELECT
      id,
      plan,
      billing_status,
      trial_ends_at,
      billing_started_at,
      billing_cancelled_at,
      billing_grace_until,
      billing_last_payment_failed_at,
      billing_last_payment_succeeded_at,
      billing_suspended_at,
      billing_failure_reason
    FROM companies
    WHERE id = $1
    LIMIT 1
  `, [companyId]);

  if (!cur.rows.length) {
    return null;
  }

  const row = cur.rows[0];
  const plan = patch.plan !== undefined ? normalizePlan(patch.plan) : normalizePlan(row.plan);
  const billing_status = patch.billing_status !== undefined
    ? normalizeBillingStatus(patch.billing_status)
    : normalizeBillingStatus(row.billing_status);

  let trial_ends_at = row.trial_ends_at;
  if (Object.prototype.hasOwnProperty.call(patch, "trial_ends_at")) {
    trial_ends_at = isoDateOrNull(patch.trial_ends_at, row.trial_ends_at);
  }

  const limits = PLAN_LIMITS[plan];
  let billing_grace_until = Object.prototype.hasOwnProperty.call(patch, "billing_grace_until")
    ? isoDateOrNull(patch.billing_grace_until, row.billing_grace_until)
    : row.billing_grace_until;
  let billing_failure_reason = Object.prototype.hasOwnProperty.call(patch, "billing_failure_reason")
    ? patch.billing_failure_reason || null
    : row.billing_failure_reason;
  const clear_suspended_at = patch.clear_suspended_at === true || billing_status === "active";

  if (billing_status === "active") {
    billing_grace_until = null;
    billing_failure_reason = null;
  }

  const result = await pool.query(`
    UPDATE companies
    SET plan = $1,
        billing_status = $2,
        monthly_price = $3,
        max_users = $4,
        max_clients = $5,
        max_jobs_per_month = $6,
        trial_ends_at = $7::timestamptz,
        billing_started_at = CASE
          WHEN $2::text = 'active' THEN COALESCE(billing_started_at, CURRENT_TIMESTAMP)
          ELSE billing_started_at
        END,
        billing_cancelled_at = CASE
          WHEN $2::text = 'cancelled' THEN COALESCE(billing_cancelled_at, CURRENT_TIMESTAMP)
          ELSE NULL
        END,
        billing_grace_until = $9::timestamptz,
        billing_failure_reason = $10,
        billing_suspended_at = CASE
          WHEN $11::boolean THEN NULL
          WHEN $2::text = 'suspended' THEN COALESCE(billing_suspended_at, CURRENT_TIMESTAMP)
          ELSE billing_suspended_at
        END
    WHERE id = $8
    RETURNING
      id AS company_id,
      plan,
      billing_status,
      trial_ends_at,
      billing_started_at,
      billing_cancelled_at,
      billing_grace_until,
      billing_last_payment_failed_at,
      billing_last_payment_succeeded_at,
      billing_suspended_at,
      billing_failure_reason,
      monthly_price,
      max_users,
      max_clients,
      max_jobs_per_month
  `, [
    plan,
    billing_status,
    limits.monthly_price,
    limits.max_users,
    limits.max_clients,
    limits.max_jobs_per_month,
    trial_ends_at,
    companyId,
    billing_grace_until,
    billing_failure_reason,
    clear_suspended_at
  ]);

  const updatedCompany = result.rows[0] || null;

  if (updatedCompany) {
    try {
      const subscriptionStatus = normalizeCompanySubscriptionStatus(billing_status);
      const existing = await getCompanySubscription(companyId);
      const currentPeriodStart = updatedCompany.billing_started_at || new Date().toISOString();
      const currentPeriodEnd = subscriptionStatus === "trialing"
        ? updatedCompany.trial_ends_at
        : addBillingPeriodIso("monthly");

      if (existing) {
        await pool.query(`
          UPDATE company_subscriptions
          SET plan = $1,
              status = $2,
              billing_status = $2,
              price_monthly = $3,
              trial_ends_at = $4::timestamptz,
              current_period_start = COALESCE(current_period_start, $5::timestamptz),
              current_period_end = COALESCE($6::timestamptz, current_period_end),
              cancel_at_period_end = CASE WHEN $2::text IN ('cancelled', 'expired') THEN TRUE ELSE FALSE END,
              cancelled_at = CASE WHEN $2::text IN ('cancelled', 'expired') THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP) ELSE NULL END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $7
        `, [
          plan,
          subscriptionStatus,
          limits.monthly_price,
          updatedCompany.trial_ends_at,
          currentPeriodStart,
          currentPeriodEnd,
          existing.id
        ]);
      } else {
        await pool.query(`
          INSERT INTO company_subscriptions (
            company_id,
            plan,
            status,
            billing_status,
            billing_cycle,
            price_monthly,
            trial_started_at,
            trial_ends_at,
            current_period_start,
            current_period_end,
            cancel_at_period_end,
            cancelled_at
          )
          VALUES ($1, $2, $3, $3, 'monthly', $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9, $10::timestamptz)
        `, [
          companyId,
          plan,
          subscriptionStatus,
          limits.monthly_price,
          subscriptionStatus === "trialing" ? currentPeriodStart : null,
          updatedCompany.trial_ends_at,
          currentPeriodStart,
          currentPeriodEnd,
          subscriptionStatus === "cancelled" || subscriptionStatus === "expired",
          subscriptionStatus === "cancelled" || subscriptionStatus === "expired" ? new Date().toISOString() : null
        ]);
      }
    } catch (err) {
      if (!isMissingCompanySubscriptionsTable(err)) {
        throw err;
      }
    }
  }

  return updatedCompany;
}

function defaultBilling(companyId = null) {
  const limits = PLAN_LIMITS.starter;
  return {
    company_id: companyId,
    plan: "starter",
    billing_status: "trial",
    trial_ends_at: null,
    billing_started_at: null,
    billing_cancelled_at: null,
    billing_grace_until: null,
    billing_last_payment_failed_at: null,
    billing_last_payment_succeeded_at: null,
    billing_suspended_at: null,
    billing_failure_reason: null,
    billing_period_end: null,
    monthly_price: limits.monthly_price,
    max_users: limits.max_users,
    max_clients: limits.max_clients,
    max_jobs_per_month: limits.max_jobs_per_month
  };
}

function isMissingBillingColumn(err) {
  return err && err.code === "42703";
}

function isMissingCompanySubscriptionsTable(err) {
  return err && err.code === "42P01";
}

async function getCompanyBilling(companyId) {
  if (!companyId) {
    return defaultBilling(null);
  }

  try {
    const subscription = await getCompanySubscription(companyId);
    if (subscription) {
      const company = await pool.query(`
        SELECT
          id AS company_id,
          billing_status,
          trial_ends_at,
          billing_started_at,
          billing_cancelled_at,
          billing_grace_until,
          billing_last_payment_failed_at,
          billing_last_payment_succeeded_at,
          billing_suspended_at,
          billing_failure_reason,
          billing_period_end,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_price_id,
          stripe_plan_key,
          stripe_subscription_status,
          stripe_current_period_end
        FROM companies
        WHERE id = $1
        LIMIT 1
      `, [companyId]);
      const companyRow = company.rows[0] || {};
      const companyStatus = normalizeBillingStatus(companyRow.billing_status);
      const subStatus = subscription.legacy_billing_status;
      const companyStatusOverridesSubscription = [
        "past_due",
        "unpaid",
        "incomplete",
        "paused",
        "suspended",
        "cancelled"
      ].includes(companyStatus);
      const effectiveStatus = companyStatusOverridesSubscription ? companyStatus : subStatus;

      return {
        company_id: subscription.company_id,
        subscription_id: subscription.id,
        plan: subscription.plan,
        status: subscription.status,
        billing_status: effectiveStatus,
        subscription_billing_status: subscription.billing_status,
        billing_cycle: subscription.billing_cycle,
        price_monthly: subscription.price_monthly,
        trial_started_at: subscription.trial_started_at,
        trial_ends_at: subscription.trial_ends_at || companyRow.trial_ends_at || null,
        billing_started_at: subscription.current_period_start || companyRow.billing_started_at || null,
        billing_cancelled_at: subscription.cancelled_at || companyRow.billing_cancelled_at || null,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end || companyRow.stripe_current_period_end || companyRow.billing_period_end || null,
        cancel_at_period_end: subscription.cancel_at_period_end,
        cancelled_at: subscription.cancelled_at || companyRow.billing_cancelled_at || null,
        stripe_customer_id: subscription.stripe_customer_id || companyRow.stripe_customer_id || null,
        stripe_subscription_id: subscription.stripe_subscription_id || companyRow.stripe_subscription_id || null,
        stripe_price_id: subscription.stripe_price_id || companyRow.stripe_price_id || null,
        stripe_plan_key: subscription.stripe_plan_key || companyRow.stripe_plan_key || null,
        stripe_subscription_status: subscription.stripe_subscription_status || companyRow.stripe_subscription_status || null,
        billing_grace_until: companyRow.billing_grace_until || null,
        billing_last_payment_failed_at: companyRow.billing_last_payment_failed_at || null,
        billing_last_payment_succeeded_at: companyRow.billing_last_payment_succeeded_at || null,
        billing_suspended_at: companyRow.billing_suspended_at || null,
        billing_failure_reason: companyRow.billing_failure_reason || null,
        billing_period_end: subscription.current_period_end || companyRow.billing_period_end || companyRow.stripe_current_period_end || null,
        monthly_price: subscription.monthly_price,
        max_users: subscription.max_users,
        max_clients: subscription.max_clients,
        max_jobs_per_month: subscription.max_jobs_per_month
      };
    }

    const result = await pool.query(`
      SELECT
        id AS company_id,
        plan,
        billing_status,
        trial_ends_at,
        billing_started_at,
        billing_cancelled_at,
        billing_grace_until,
        billing_last_payment_failed_at,
        billing_last_payment_succeeded_at,
        billing_suspended_at,
        billing_failure_reason,
        billing_period_end,
        monthly_price,
        max_users,
        max_clients,
        max_jobs_per_month
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [companyId]);

    if (!result.rows.length) {
      return null;
    }

    const row = result.rows[0];
    const plan = normalizePlan(row.plan);
    const limits = PLAN_LIMITS[plan];

    return {
      company_id: row.company_id,
      plan,
      billing_status: normalizeBillingStatus(row.billing_status),
      trial_ends_at: row.trial_ends_at || null,
      billing_started_at: row.billing_started_at || null,
      billing_cancelled_at: row.billing_cancelled_at || null,
      billing_grace_until: row.billing_grace_until || null,
      billing_last_payment_failed_at: row.billing_last_payment_failed_at || null,
      billing_last_payment_succeeded_at: row.billing_last_payment_succeeded_at || null,
      billing_suspended_at: row.billing_suspended_at || null,
      billing_failure_reason: row.billing_failure_reason || null,
      billing_period_end: row.billing_period_end || null,
      monthly_price: num(row.monthly_price != null ? row.monthly_price : limits.monthly_price),
      max_users: row.max_users != null ? num(row.max_users) : limits.max_users,
      max_clients: row.max_clients != null ? num(row.max_clients) : limits.max_clients,
      max_jobs_per_month: row.max_jobs_per_month != null ? num(row.max_jobs_per_month) : limits.max_jobs_per_month
    };
  } catch (err) {
    if (isMissingBillingColumn(err)) {
      return defaultBilling(companyId);
    }

    throw err;
  }
}

async function updateCompanyPlan(companyId, plan, status) {
  return updateCompanyPlatformSubscription(companyId, {
    plan,
    billing_status: status
  });
}

function normalizeCompanySubscriptionRow(row) {
  if (!row) return null;
  const plan = normalizePlan(row.plan);
  const limits = getPlanLimits(plan);
  const status = normalizeCompanySubscriptionStatus(row.status);
  const billing_status = normalizeCompanySubscriptionStatus(row.billing_status || row.status);

  return {
    id: row.id,
    company_id: row.company_id,
    plan,
    status,
    billing_status,
    legacy_billing_status: legacyBillingStatus(billing_status),
    billing_cycle: normalizeBillingCycle(row.billing_cycle),
    price_monthly: num(row.price_monthly != null ? row.price_monthly : limits.price_monthly),
    monthly_price: num(row.price_monthly != null ? row.price_monthly : limits.price_monthly),
    max_users: limits.max_users,
    max_clients: limits.max_clients,
    max_jobs_per_month: limits.max_jobs_per_month,
    trial_started_at: row.trial_started_at || null,
    trial_ends_at: row.trial_ends_at || null,
    current_period_start: row.current_period_start || null,
    current_period_end: row.current_period_end || null,
    cancel_at_period_end: row.cancel_at_period_end === true,
    cancelled_at: row.cancelled_at || null,
    stripe_customer_id: row.stripe_customer_id || null,
    stripe_subscription_id: row.stripe_subscription_id || null,
    stripe_price_id: row.stripe_price_id || null,
    stripe_plan_key: row.stripe_plan_key || null,
    stripe_subscription_status: row.stripe_subscription_status || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function syncLegacyCompanyBilling(client, subscription) {
  if (!subscription || !subscription.company_id) return null;

  const plan = normalizePlan(subscription.plan);
  const limits = getPlanLimits(plan);
  const status = normalizeCompanySubscriptionStatus(subscription.status);
  const accessStatus = subscription.billing_status
    ? normalizeCompanySubscriptionStatus(subscription.billing_status)
    : status;
  const companyBillingStatus = legacyBillingStatus(accessStatus);

  const result = await client.query(`
    UPDATE companies
    SET plan = $1,
        billing_status = $2,
        monthly_price = $3,
        max_users = $4,
        max_clients = $5,
        max_jobs_per_month = $6,
        trial_ends_at = $7::timestamptz,
        billing_started_at = CASE
          WHEN $2::text = 'active' THEN COALESCE(billing_started_at, $8::timestamptz, CURRENT_TIMESTAMP)
          ELSE billing_started_at
        END,
        billing_cancelled_at = CASE
          WHEN $9::boolean THEN COALESCE(billing_cancelled_at, CURRENT_TIMESTAMP)
          ELSE NULL
        END,
        stripe_customer_id = COALESCE($11, stripe_customer_id),
        stripe_subscription_id = COALESCE($12, stripe_subscription_id),
        stripe_subscription_status = COALESCE($13, stripe_subscription_status),
        stripe_current_period_end = COALESCE($14::timestamptz, stripe_current_period_end),
        billing_period_end = COALESCE($14::timestamptz, billing_period_end),
        stripe_price_id = COALESCE($15, stripe_price_id),
        stripe_plan_key = COALESCE($16, stripe_plan_key)
    WHERE id = $10
    RETURNING id AS company_id,
              plan,
              billing_status,
              trial_ends_at,
              billing_started_at,
              billing_cancelled_at,
              monthly_price,
              max_users,
              max_clients,
              max_jobs_per_month
  `, [
    plan,
    companyBillingStatus,
    limits.monthly_price,
    limits.max_users,
    limits.max_clients,
    limits.max_jobs_per_month,
    subscription.trial_ends_at || null,
    subscription.current_period_start || null,
    status === "cancelled" || status === "expired",
    subscription.company_id,
    subscription.stripe_customer_id || null,
    subscription.stripe_subscription_id || null,
    subscription.stripe_subscription_status || null,
    subscription.current_period_end || null,
    subscription.stripe_price_id || null,
    subscription.stripe_plan_key || null
  ]);

  return result.rows[0] || null;
}

async function fetchOpenCompanySubscription(client, companyId, lock = false) {
  const result = await client.query(`
    SELECT *
    FROM company_subscriptions
    WHERE company_id = $1
      AND (
        status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused')
        OR billing_status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused')
      )
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [companyId]);

  return normalizeCompanySubscriptionRow(result.rows[0] || null);
}

async function fetchLatestCompanySubscription(client, companyId, lock = false) {
  const result = await client.query(`
    SELECT *
    FROM company_subscriptions
    WHERE company_id = $1
    ORDER BY
      CASE
        WHEN status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused')
          OR billing_status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused') THEN 0
        ELSE 1
      END,
      created_at DESC,
      id DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [companyId]);

  return normalizeCompanySubscriptionRow(result.rows[0] || null);
}

async function assertCompanyExists(client, companyId) {
  const result = await client.query(`
    SELECT id
    FROM companies
    WHERE id = $1
    LIMIT 1
  `, [companyId]);

  if (!result.rows.length) {
    throw subscriptionError("COMPANY_NOT_FOUND", "Company not found", 404);
  }
}

async function createCompanySubscription(companyId, options = {}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assertCompanyExists(client, companyId);

    const existing = await fetchOpenCompanySubscription(client, companyId, true);
    if (existing) {
      throw subscriptionError("DUPLICATE_ACTIVE_SUBSCRIPTION", "Company already has an open platform subscription", 409);
    }

    const plan = requireKnownPlan(options.plan, "starter");
    const limits = getPlanLimits(plan);
    const billingCycle = normalizeBillingCycle(options.billing_cycle);
    const now = new Date();
    const trialDays = normalizeTenantTrialDays(options.trial_days, 14);
    const hasTrial = trialDays > 0;
    const trialEndsAt = hasTrial
      ? addDaysIso(trialDays, now)
      : isoDateOrNull(options.trial_ends_at, null);
    const status = hasTrial ? "trialing" : "active";
    const currentPeriodStart = now.toISOString();
    const currentPeriodEnd = hasTrial && trialEndsAt
      ? trialEndsAt
      : addBillingPeriodIso(billingCycle, now);

    const result = await client.query(`
      INSERT INTO company_subscriptions (
        company_id,
        plan,
        status,
        billing_status,
        billing_cycle,
        price_monthly,
        trial_started_at,
        trial_ends_at,
        current_period_start,
        current_period_end,
        cancel_at_period_end
      )
      VALUES ($1, $2, $3, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::timestamptz, FALSE)
      RETURNING *
    `, [
      companyId,
      plan,
      status,
      billingCycle,
      limits.price_monthly,
      hasTrial ? currentPeriodStart : null,
      trialEndsAt,
      currentPeriodStart,
      currentPeriodEnd
    ]);

    const subscription = normalizeCompanySubscriptionRow(result.rows[0]);
    await syncLegacyCompanyBilling(client, subscription);
    await client.query("COMMIT");
    return subscription;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getCompanySubscription(companyId) {
  if (!companyId) return null;

  try {
    const subscription = await fetchLatestCompanySubscription(pool, companyId, false);
    return subscription;
  } catch (err) {
    if (isMissingCompanySubscriptionsTable(err)) {
      return null;
    }

    throw err;
  }
}

async function changeCompanyPlan(companyId, targetPlan, direction) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assertCompanyExists(client, companyId);

    const subscription = await fetchOpenCompanySubscription(client, companyId, true);
    if (!subscription) {
      throw subscriptionError("NO_ACTIVE_SUBSCRIPTION", "Company does not have an open platform subscription", 404);
    }

    if (subscription.cancel_at_period_end) {
      throw subscriptionError("INVALID_TRANSITION", "Cancelled subscriptions must be reactivated before plan changes", 409);
    }

    if ((subscription.status === "past_due" || subscription.status === "unpaid") && direction === "downgrade") {
      throw subscriptionError("INVALID_TRANSITION", "Past due subscriptions cannot be downgraded until billing is resolved", 409);
    }

    if (["incomplete", "unpaid", "paused"].includes(subscription.status)) {
      throw subscriptionError(
        "INVALID_TRANSITION",
        "Resolve billing in Stripe (checkout or portal) before changing plans here.",
        409
      );
    }

    if (subscription.status === "trialing" && direction === "downgrade") {
      throw subscriptionError("INVALID_TRANSITION", "Trialing subscriptions cannot be downgraded", 409);
    }

    const plan = requireKnownPlan(targetPlan);
    const currentRank = planRank(subscription.plan);
    const targetRank = planRank(plan);

    if (direction === "upgrade" && targetRank <= currentRank) {
      throw subscriptionError("INVALID_PLAN_TRANSITION", "Target plan must be higher than the current plan", 400);
    }

    if (direction === "downgrade" && targetRank >= currentRank) {
      throw subscriptionError("INVALID_PLAN_TRANSITION", "Target plan must be lower than the current plan", 400);
    }

    const limits = getPlanLimits(plan);

    if (direction === "downgrade") {
      const usage = await getUsageForCompany(companyId);
      const failures = hasUsageWithinLimits(usage, limits);
      if (failures.length) {
        throw subscriptionError("DOWNGRADE_BELOW_USAGE", "Current usage exceeds the target plan limits", 409, failures);
      }
    }

    const result = await client.query(`
      UPDATE company_subscriptions
      SET plan = $1,
          price_monthly = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [plan, limits.price_monthly, subscription.id]);

    const updated = normalizeCompanySubscriptionRow(result.rows[0]);
    await syncLegacyCompanyBilling(client, updated);
    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function upgradeCompanyPlan(companyId, plan) {
  return changeCompanyPlan(companyId, plan, "upgrade");
}

async function downgradeCompanyPlan(companyId, plan) {
  return changeCompanyPlan(companyId, plan, "downgrade");
}

async function cancelCompanySubscription(companyId, options = {}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assertCompanyExists(client, companyId);

    const subscription = await fetchOpenCompanySubscription(client, companyId, true);
    if (!subscription) {
      throw subscriptionError("NO_ACTIVE_SUBSCRIPTION", "Company does not have an open platform subscription", 404);
    }

    if (subscription.cancel_at_period_end) {
      throw subscriptionError("INVALID_TRANSITION", "Subscription is already scheduled for cancellation", 409);
    }

    const cancelAtPeriodEnd = options.cancel_at_period_end !== false;
    const status = cancelAtPeriodEnd ? "cancelled" : "expired";
    const accessStatus = cancelAtPeriodEnd ? "active" : "expired";

    const result = await client.query(`
      UPDATE company_subscriptions
      SET status = $1,
          billing_status = $2,
          cancel_at_period_end = $3,
          cancelled_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [status, accessStatus, cancelAtPeriodEnd, subscription.id]);

    const updated = normalizeCompanySubscriptionRow(result.rows[0]);
    await syncLegacyCompanyBilling(client, updated);
    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function reactivateCompanySubscription(companyId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assertCompanyExists(client, companyId);

    const latest = await fetchLatestCompanySubscription(client, companyId, true);
    if (!latest) {
      throw subscriptionError("NO_SUBSCRIPTION", "Company does not have a platform subscription", 404);
    }

    if (latest.status === "expired") {
      throw subscriptionError("INVALID_TRANSITION", "Expired subscriptions cannot be reactivated; create a new subscription", 409);
    }

    if (latest.status !== "cancelled" && !latest.cancel_at_period_end) {
      throw subscriptionError("INVALID_TRANSITION", "Only cancelled subscriptions can be reactivated", 409);
    }

    const result = await client.query(`
      UPDATE company_subscriptions
      SET status = CASE
            WHEN trial_ends_at IS NOT NULL AND trial_ends_at > CURRENT_TIMESTAMP THEN 'trialing'
            ELSE 'active'
          END,
          billing_status = CASE
            WHEN trial_ends_at IS NOT NULL AND trial_ends_at > CURRENT_TIMESTAMP THEN 'trialing'
            ELSE 'active'
          END,
          cancel_at_period_end = FALSE,
          cancelled_at = NULL,
          current_period_start = COALESCE(current_period_start, CURRENT_TIMESTAMP),
          current_period_end = CASE
            WHEN current_period_end IS NULL OR current_period_end < CURRENT_TIMESTAMP
              THEN CURRENT_TIMESTAMP + CASE WHEN billing_cycle = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END
            ELSE current_period_end
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [latest.id]);

    const updated = normalizeCompanySubscriptionRow(result.rows[0]);
    await syncLegacyCompanyBilling(client, updated);
    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function renewCompanySubscription(companyId, options = {}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assertCompanyExists(client, companyId);

    const subscription = await fetchLatestCompanySubscription(client, companyId, true);
    if (!subscription) {
      throw subscriptionError("NO_SUBSCRIPTION", "Company does not have a platform subscription", 404);
    }

    if (subscription.status === "expired") {
      throw subscriptionError("INVALID_TRANSITION", "Expired subscriptions cannot be renewed", 409);
    }

    const nextStart = new Date().toISOString();
    const nextEnd = options.current_period_end
      ? isoDateOrNull(options.current_period_end, addBillingPeriodIso(subscription.billing_cycle))
      : addBillingPeriodIso(subscription.billing_cycle);
    const status = subscription.cancel_at_period_end ? "expired" : "active";

    const result = await client.query(`
      UPDATE company_subscriptions
      SET status = $1,
          billing_status = $1,
          current_period_start = $2::timestamptz,
          current_period_end = $3::timestamptz,
          cancel_at_period_end = CASE WHEN $1::text = 'expired' THEN FALSE ELSE cancel_at_period_end END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [status, nextStart, nextEnd, subscription.id]);

    const updated = normalizeCompanySubscriptionRow(result.rows[0]);
    await syncLegacyCompanyBilling(client, updated);
    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getUsageForCompany(companyId) {
  const billing = await getCompanyBilling(companyId);

  if (!companyId) {
    return {
      users_count: 0,
      clients_count: 0,
      jobs_this_month: 0,
      users: 0,
      clients: 0,
      max_users: null,
      max_clients: null,
      max_jobs_per_month: null,
      plan: "starter",
      billing_status: "trial",
      trial_ends_at: null,
    };
  }

  if (!billing) {
    return {
      users_count: 0,
      clients_count: 0,
      jobs_this_month: 0,
      users: 0,
      clients: 0,
      max_users: null,
      max_clients: null,
      max_jobs_per_month: null,
      plan: "starter",
      billing_status: "trial",
      trial_ends_at: null,
    };
  }

  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE company_id = $1)::int AS users,
      (SELECT COUNT(*) FROM clients WHERE company_id = $1 AND COALESCE(archived, FALSE) = FALSE)::int AS clients,
      (SELECT COUNT(*) FROM jobs WHERE company_id = $1 AND date >= date_trunc('month', CURRENT_DATE)::date)::int AS jobs_this_month
  `, [companyId]);

  const row = result.rows[0] || {};
  const usersCount = num(row.users);
  const clientsCount = num(row.clients);
  const jobsThisMonth = num(row.jobs_this_month);

  return {
    users_count: usersCount,
    clients_count: clientsCount,
    jobs_this_month: jobsThisMonth,
    users: usersCount,
    clients: clientsCount,
    max_users: billing.max_users,
    max_clients: billing.max_clients,
    max_jobs_per_month: billing.max_jobs_per_month,
    plan: billing.plan,
    status: billing.status || billing.billing_status,
    billing_status: billing.billing_status,
    trial_ends_at: billing.trial_ends_at
  };
}

async function getBillingWarnings(companyId) {
  const usage = await getUsageForCompany(companyId);
  const billing = await getCompanyBilling(companyId);
  const now = new Date();
  const trialEndsAt = usage.trial_ends_at ? new Date(usage.trial_ends_at) : null;
  const graceUntil = billing && billing.billing_grace_until ? new Date(billing.billing_grace_until) : null;
  const validGraceUntil = graceUntil && !Number.isNaN(graceUntil.getTime()) ? graceUntil : null;
  const subscriptionStatus = billing && billing.status ? normalizeCompanySubscriptionStatus(billing.status) : null;
  const isTrialExpired = (usage.billing_status === "trial" || usage.billing_status === "trialing" || subscriptionStatus === "trialing")
    && trialEndsAt
    && !Number.isNaN(trialEndsAt.getTime())
    && trialEndsAt < now;
  const isPastDue = usage.billing_status === "past_due" || usage.billing_status === "unpaid";
  const isIncomplete = usage.billing_status === "incomplete";
  const isPaused = usage.billing_status === "paused";
  const isCancelled = usage.billing_status === "cancelled" || subscriptionStatus === "cancelled" || subscriptionStatus === "expired";
  const isSuspended = usage.billing_status === "suspended";
  const overUserLimit = usage.max_users != null && usage.users_count > usage.max_users;
  const overClientLimit = usage.max_clients != null && usage.clients_count > usage.max_clients;
  const overJobLimit = usage.max_jobs_per_month != null && usage.jobs_this_month > usage.max_jobs_per_month;
  const warnings = [];

  if (isTrialExpired) {
    warnings.push({
      type: "trial_expired",
      severity: "warning",
      message: "Trial has expired.",
      current: usage.trial_ends_at,
      limit: null
    });
  }

  if (isPastDue) {
    warnings.push({
      type: usage.billing_status === "unpaid" ? "unpaid" : "past_due",
      severity: "danger",
      message: validGraceUntil
        ? `Payment failed. Grace period ends ${validGraceUntil.toISOString().split("T")[0]}.`
        : "Payment failed. Grace period is not set.",
      current: usage.billing_status,
      limit: validGraceUntil ? validGraceUntil.toISOString() : "active"
    });
  }

  if (isIncomplete) {
    warnings.push({
      type: "incomplete",
      severity: "danger",
      message: "Subscription checkout or first payment is incomplete.",
      current: usage.billing_status,
      limit: "active"
    });
  }

  if (isPaused) {
    warnings.push({
      type: "paused",
      severity: "warning",
      message: "Stripe payment collection is paused for this subscription.",
      current: usage.billing_status,
      limit: "active"
    });
  }

  if (isCancelled) {
    warnings.push({
      type: "cancelled",
      severity: billing && billing.cancel_at_period_end ? "warning" : "danger",
      message: billing && billing.cancel_at_period_end
        ? "Subscription is scheduled to cancel at the end of the current period."
        : "Billing status is cancelled.",
      current: subscriptionStatus || usage.billing_status,
      limit: "active"
    });
  }

  if (isSuspended) {
    warnings.push({
      type: "suspended",
      severity: "danger",
      message: "Company platform billing is suspended.",
      current: usage.billing_status,
      limit: "active"
    });
  }

  if (overUserLimit) {
    warnings.push({
      type: "over_users",
      severity: "warning",
      message: `Company is over the ${usage.plan} plan user limit.`,
      current: usage.users_count,
      limit: usage.max_users
    });
  }

  if (overClientLimit) {
    warnings.push({
      type: "over_clients",
      severity: "warning",
      message: `Company is over the ${usage.plan} plan client limit.`,
      current: usage.clients_count,
      limit: usage.max_clients
    });
  }

  if (overJobLimit) {
    warnings.push({
      type: "over_jobs",
      severity: "warning",
      message: `Company is over the ${usage.plan} plan monthly job limit.`,
      current: usage.jobs_this_month,
      limit: usage.max_jobs_per_month
    });
  }

  return {
    is_trial_expired: Boolean(isTrialExpired),
    is_past_due: isPastDue,
    is_unpaid: usage.billing_status === "unpaid",
    is_incomplete: isIncomplete,
    is_paused: isPaused,
    is_cancelled: isCancelled,
    is_suspended: isSuspended,
    grace_days_remaining: graceDaysRemaining(billing && billing.billing_grace_until),
    over_user_limit: overUserLimit,
    over_client_limit: overClientLimit,
    over_job_limit: overJobLimit,
    warnings
  };
}

async function getBillingSummary(companyId) {
  const billing = await getCompanyBilling(companyId);
  const usage = await getUsageForCompany(companyId);

  if (!billing) {
    return null;
  }

  const automationFlags = buildBillingAutomationFlags(billing);

  return {
    billing,
    usage,
    limits: {
      max_users: billing.max_users,
      max_clients: billing.max_clients,
      max_jobs_per_month: billing.max_jobs_per_month
    },
    over_limits: {
      max_users: billing.max_users != null ? usage.users_count > billing.max_users : false,
      max_clients: billing.max_clients != null ? usage.clients_count > billing.max_clients : false,
      max_jobs_per_month: billing.max_jobs_per_month != null ? usage.jobs_this_month > billing.max_jobs_per_month : false
    },
    warnings: await getBillingWarnings(companyId),
    ...automationFlags,
    warning_mode: true
  };
}

async function isOverLimit(companyId, limitName) {
  const summary = await getBillingSummary(companyId);
  return Boolean(summary && summary.over_limits && summary.over_limits[limitName]);
}

async function syncCompanyBillingFromStripe(companyId, patch = {}) {
  try {
    const cur = await pool.query(`
      SELECT *
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [companyId]);

    if (!cur.rows.length) {
      return null;
    }

    const row = cur.rows[0];
    const plan = patch.plan !== undefined ? normalizePlan(patch.plan) : normalizePlan(row.plan);
    const subscription_status = patch.billing_status !== undefined
      ? normalizeCompanySubscriptionStatus(patch.billing_status)
      : normalizeCompanySubscriptionStatus(row.billing_status);
    const billing_status = legacyBillingStatus(subscription_status);

    let trial_ends_at = row.trial_ends_at;
    if (Object.prototype.hasOwnProperty.call(patch, "trial_ends_at")) {
      trial_ends_at = isoDateOrNull(patch.trial_ends_at, row.trial_ends_at);
    }

    const limits = PLAN_LIMITS[plan];

    const stripe_customer_id = Object.prototype.hasOwnProperty.call(patch, "stripe_customer_id")
      ? patch.stripe_customer_id
      : row.stripe_customer_id;
    const stripe_subscription_id = Object.prototype.hasOwnProperty.call(patch, "stripe_subscription_id")
      ? patch.stripe_subscription_id
      : row.stripe_subscription_id;
    const stripe_subscription_status = Object.prototype.hasOwnProperty.call(patch, "stripe_subscription_status")
      ? patch.stripe_subscription_status
      : row.stripe_subscription_status;
    const stripe_current_period_end = Object.prototype.hasOwnProperty.call(patch, "stripe_current_period_end")
      ? patch.stripe_current_period_end
      : row.stripe_current_period_end;
    const stripe_price_id = Object.prototype.hasOwnProperty.call(patch, "stripe_price_id")
      ? patch.stripe_price_id
      : row.stripe_price_id;
    const stripe_plan_key = Object.prototype.hasOwnProperty.call(patch, "stripe_plan_key")
      ? patch.stripe_plan_key
      : row.stripe_plan_key;
    let billing_grace_until = Object.prototype.hasOwnProperty.call(patch, "billing_grace_until")
      ? isoDateOrNull(patch.billing_grace_until, row.billing_grace_until)
      : row.billing_grace_until;
    const billing_last_payment_failed_at = Object.prototype.hasOwnProperty.call(patch, "billing_last_payment_failed_at")
      ? isoDateOrNull(patch.billing_last_payment_failed_at, row.billing_last_payment_failed_at)
      : row.billing_last_payment_failed_at;
    const billing_last_payment_succeeded_at = Object.prototype.hasOwnProperty.call(patch, "billing_last_payment_succeeded_at")
      ? isoDateOrNull(patch.billing_last_payment_succeeded_at, row.billing_last_payment_succeeded_at)
      : row.billing_last_payment_succeeded_at;
    const billing_suspended_at = Object.prototype.hasOwnProperty.call(patch, "billing_suspended_at")
      ? isoDateOrNull(patch.billing_suspended_at, row.billing_suspended_at)
      : row.billing_suspended_at;
    const billing_failure_reason = Object.prototype.hasOwnProperty.call(patch, "billing_failure_reason")
      ? patch.billing_failure_reason || null
      : row.billing_failure_reason;
    const billing_cycle = patch.billing_cycle !== undefined
      ? normalizeBillingCycle(patch.billing_cycle)
      : null;

    if ((billing_status === "past_due" || billing_status === "unpaid") && !billing_grace_until) {
      billing_grace_until = addDaysIso(BILLING_GRACE_PERIOD_DAYS);
    }

    if (billing_status === "active") {
      billing_grace_until = null;
    }

    let stripe_period_end_iso = null;
    if (stripe_current_period_end !== null && stripe_current_period_end !== undefined) {
      const d = stripe_current_period_end instanceof Date
        ? stripe_current_period_end
        : new Date(stripe_current_period_end);
      stripe_period_end_iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    const result = await pool.query(`
      UPDATE companies
      SET plan = $1,
          billing_status = $2,
          monthly_price = $3,
          max_users = $4,
          max_clients = $5,
          max_jobs_per_month = $6,
          trial_ends_at = $7::timestamptz,
          billing_started_at = CASE
            WHEN $2::text = 'active' THEN COALESCE(billing_started_at, CURRENT_TIMESTAMP)
            ELSE billing_started_at
          END,
          billing_cancelled_at = CASE
            WHEN $2::text IN ('cancelled', 'expired') THEN COALESCE(billing_cancelled_at, CURRENT_TIMESTAMP)
            ELSE NULL
          END,
          stripe_subscription_id = $9,
          stripe_subscription_status = $10,
          stripe_current_period_end = $11::timestamptz,
          billing_period_end = $11::timestamptz,
          stripe_price_id = $12,
          stripe_plan_key = $13,
          billing_grace_until = $14::timestamptz,
          billing_last_payment_failed_at = $15::timestamptz,
          billing_last_payment_succeeded_at = $16::timestamptz,
          billing_suspended_at = $17::timestamptz,
          billing_failure_reason = $18,
          stripe_customer_id = COALESCE($19, stripe_customer_id)
      WHERE id = $8
      RETURNING id AS company_id,
                plan,
                billing_status,
                billing_grace_until,
                billing_last_payment_failed_at,
                billing_last_payment_succeeded_at,
                billing_suspended_at,
                billing_cancelled_at,
                billing_failure_reason,
                stripe_customer_id,
                stripe_subscription_id,
                stripe_subscription_status,
                stripe_current_period_end,
                stripe_price_id,
                stripe_plan_key
    `, [
      plan,
      billing_status,
      limits.monthly_price,
      limits.max_users,
      limits.max_clients,
      limits.max_jobs_per_month,
      trial_ends_at,
      companyId,
      stripe_subscription_id,
      stripe_subscription_status,
      stripe_period_end_iso,
      stripe_price_id,
      stripe_plan_key,
      billing_grace_until,
      billing_last_payment_failed_at,
      billing_last_payment_succeeded_at,
      billing_suspended_at,
      billing_failure_reason,
      stripe_customer_id || null
    ]);

    const updatedCompany = result.rows[0] || null;

    if (updatedCompany) {
      try {
        const currentPeriodStart = patch.stripe_current_period_start
          ? isoDateOrNull(patch.stripe_current_period_start, null)
          : null;
        const currentPeriodEnd = stripe_period_end_iso || trial_ends_at || null;
        const cancelledAt = subscription_status === "cancelled" || subscription_status === "expired"
          ? new Date().toISOString()
          : null;

        if (stripe_subscription_id) {
          const subParams = [
            companyId,
            plan,
            subscription_status,
            limits.monthly_price,
            subscription_status === "trialing" ? new Date().toISOString() : null,
            trial_ends_at,
            currentPeriodStart,
            currentPeriodEnd,
            patch.cancel_at_period_end === true,
            cancelledAt,
            stripe_customer_id || null,
            stripe_subscription_id || null,
            stripe_price_id || null,
            stripe_plan_key || null,
            stripe_subscription_status || null,
            billing_cycle
          ];

          const updatedSub = await pool.query(`
            UPDATE company_subscriptions
            SET plan = $2,
                status = $3,
                billing_status = $3,
                price_monthly = $4,
                trial_started_at = COALESCE(trial_started_at, $5::timestamptz),
                trial_ends_at = $6::timestamptz,
                current_period_start = COALESCE($7::timestamptz, current_period_start),
                current_period_end = COALESCE($8::timestamptz, current_period_end),
                cancel_at_period_end = $9,
                cancelled_at = $10::timestamptz,
                stripe_customer_id = COALESCE($11, stripe_customer_id),
                stripe_subscription_id = $12,
                stripe_price_id = COALESCE($13, stripe_price_id),
                stripe_plan_key = COALESCE($14, stripe_plan_key),
                stripe_subscription_status = COALESCE($15, stripe_subscription_status),
                billing_cycle = COALESCE($16, billing_cycle),
                updated_at = CURRENT_TIMESTAMP
            WHERE company_id = $1
              AND (
                stripe_subscription_id = $12
                OR stripe_subscription_id IS NULL
                OR stripe_subscription_id = ''
              )
            RETURNING id
          `, subParams);

          if (!updatedSub.rows.length) {
            await pool.query(`
            INSERT INTO company_subscriptions (
              company_id,
              plan,
              status,
              billing_status,
              billing_cycle,
              price_monthly,
              trial_started_at,
              trial_ends_at,
              current_period_start,
              current_period_end,
              cancel_at_period_end,
              cancelled_at,
              stripe_customer_id,
              stripe_subscription_id,
              stripe_price_id,
              stripe_plan_key,
              stripe_subscription_status
            )
            VALUES ($1, $2, $3, $3, COALESCE($16, 'monthly'), $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9, $10::timestamptz, $11, $12, $13, $14, $15)
            ON CONFLICT (stripe_subscription_id)
            WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> ''
            DO UPDATE SET
              plan = EXCLUDED.plan,
              status = EXCLUDED.status,
              billing_status = EXCLUDED.billing_status,
              billing_cycle = COALESCE(EXCLUDED.billing_cycle, company_subscriptions.billing_cycle),
              price_monthly = EXCLUDED.price_monthly,
              trial_ends_at = EXCLUDED.trial_ends_at,
              current_period_start = COALESCE(EXCLUDED.current_period_start, company_subscriptions.current_period_start),
              current_period_end = COALESCE(EXCLUDED.current_period_end, company_subscriptions.current_period_end),
              cancel_at_period_end = EXCLUDED.cancel_at_period_end,
              cancelled_at = EXCLUDED.cancelled_at,
              stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, company_subscriptions.stripe_customer_id),
              stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, company_subscriptions.stripe_price_id),
              stripe_plan_key = COALESCE(EXCLUDED.stripe_plan_key, company_subscriptions.stripe_plan_key),
              stripe_subscription_status = COALESCE(EXCLUDED.stripe_subscription_status, company_subscriptions.stripe_subscription_status),
              updated_at = CURRENT_TIMESTAMP
            `, subParams);
          }
        }
      } catch (err) {
        if (!isMissingCompanySubscriptionsTable(err) && err.code !== "42703") {
          throw err;
        }
      }
    }

    return updatedCompany;
  } catch (err) {
    if (isMissingBillingColumn(err)) {
      console.log("STRIPE SYNC SKIP: billing columns missing — run migrations:", err.message);
      return null;
    }

    throw err;
  }
}

async function markCompanyPaymentSucceeded(companyId, patch = {}) {
  return syncCompanyBillingFromStripe(companyId, {
    ...patch,
    billing_status: "active",
    billing_grace_until: null,
    billing_last_payment_succeeded_at: new Date().toISOString(),
    billing_suspended_at: null,
    billing_failure_reason: null
  });
}

async function markCompanyPaymentFailed(companyId, reason = "payment_failed") {
  const existing = await pool.query(
    `
    SELECT billing_grace_until
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  ).catch((err) => {
    if (err && err.code === "42703") return { rows: [] };
    throw err;
  });
  const currentGrace = existing.rows[0] && existing.rows[0].billing_grace_until;

  return syncCompanyBillingFromStripe(companyId, {
    billing_status: "past_due",
    billing_grace_until: currentGrace || addDaysIso(BILLING_GRACE_PERIOD_DAYS),
    billing_last_payment_failed_at: new Date().toISOString(),
    billing_failure_reason: reason || "payment_failed"
  });
}

async function markCompanySubscriptionCancelled(companyId, patch = {}) {
  return syncCompanyBillingFromStripe(companyId, {
    ...patch,
    billing_status: "cancelled",
    billing_grace_until: null,
    billing_cancelled_at: new Date().toISOString(),
    billing_failure_reason: null
  });
}

async function evaluatePastDueSuspensions() {
  logger.info("BILLING_LIFECYCLE_EVALUATION_BEGIN", {
    at: new Date().toISOString(),
    automation_flag: BILLING_LIFECYCLE_AUTOMATION,
    env: NODE_ENV
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(`
      UPDATE companies
      SET billing_status = 'suspended',
          billing_suspended_at = COALESCE(billing_suspended_at, CURRENT_TIMESTAMP)
      WHERE billing_status IN ('past_due', 'unpaid')
        AND billing_grace_until IS NOT NULL
        AND billing_grace_until < CURRENT_TIMESTAMP
      RETURNING id AS company_id,
                plan,
                billing_status,
                billing_grace_until,
                billing_suspended_at,
                billing_failure_reason
    `);

    const incomplete = await client.query(`
      UPDATE companies
      SET billing_status = 'expired',
          billing_failure_reason = COALESCE(billing_failure_reason, 'checkout_incomplete_expired')
      WHERE billing_status = 'incomplete'
        AND COALESCE(billing_started_at, trial_ends_at, created_at) < CURRENT_TIMESTAMP - INTERVAL '24 hours'
      RETURNING id AS company_id
    `);

    const periodEnded = await client.query(`
      UPDATE company_subscriptions
      SET status = 'expired',
          billing_status = 'expired',
          cancel_at_period_end = FALSE,
          cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE cancel_at_period_end = TRUE
        AND current_period_end IS NOT NULL
        AND current_period_end < CURRENT_TIMESTAMP
      RETURNING company_id
    `).catch((err) => {
      if (isMissingCompanySubscriptionsTable(err) || err.code === "42703") return { rows: [] };
      throw err;
    });

    if (result.rows.length) {
      await client.query(`
        UPDATE company_subscriptions
        SET billing_status = 'past_due',
            status = CASE
              WHEN status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused') THEN 'past_due'
              ELSE status
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE company_id = ANY($1::int[])
      `, [result.rows.map((row) => row.company_id)]).catch((err) => {
        if (!isMissingCompanySubscriptionsTable(err) && err.code !== "42703") throw err;
      });
    }

    const expiredCompanyIds = [
      ...incomplete.rows.map((row) => row.company_id),
      ...periodEnded.rows.map((row) => row.company_id)
    ];

    if (expiredCompanyIds.length) {
      await client.query(`
        UPDATE companies
        SET billing_status = 'expired',
            billing_cancelled_at = COALESCE(billing_cancelled_at, CURRENT_TIMESTAMP)
        WHERE id = ANY($1::int[])
      `, [[...new Set(expiredCompanyIds)]]);
    }

    await client.query("COMMIT");

    return {
      evaluated_at: new Date().toISOString(),
      suspended_count: result.rows.length,
      incomplete_expired_count: incomplete.rows.length,
      period_end_expired_count: periodEnded.rows.length,
      companies: result.rows
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * When non-null, staff mutations for this company must be blocked.
 * Used by requireCompanyBillingForMutations middleware (POST/PUT/PATCH/DELETE).
 */
function billingBlockPayload({
  error,
  code,
  billing_status,
  action_required,
  portal_available = true,
  extra = {}
}) {
  return {
    error,
    code,
    billing_status,
    action_required,
    portal_available,
    warning_mode: false,
    ...extra
  };
}

function mutationLimitForRequest(options = {}) {
  const method = String(options.method || "").toUpperCase();
  const path = String(options.path || "").toLowerCase().split("?")[0];

  if (method !== "POST") return null;
  if (path === "/users") return "max_users";
  if (path === "/clients" || path.endsWith("/convert-to-client")) return "max_clients";
  if (
    path === "/jobs"
    || path === "/workflow/jobs"
    || path === "/subscriptions"
    || path === "/ops/subscriptions"
    || path.endsWith("/convert-to-job")
    || path.endsWith("/convert-to-subscription")
  ) {
    return "max_jobs_per_month";
  }

  return null;
}

async function getStaffMutationBillingBlock(companyId, options = {}) {
  if (!companyId) {
    return {
      httpStatus: 400,
      payload: billingBlockPayload({
        error: "Company billing is not available for this account",
        code: "BILLING_COMPANY_REQUIRED",
        billing_status: null,
        action_required: "missing_company"
      })
    };
  }

  const billing = await getCompanyBilling(companyId);

  if (!billing) {
    return {
      httpStatus: 404,
      payload: billingBlockPayload({
        error: "Company not found",
        code: "COMPANY_NOT_FOUND",
        billing_status: null,
        action_required: "company_not_found"
      })
    };
  }

  const status = normalizeBillingStatus(billing.billing_status);
  const platformState = await pool.query(
    `
    SELECT platform_suspended_at
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  ).catch((err) => {
    if (err && err.code === "42703") return { rows: [] };
    throw err;
  });

  if (platformState.rows[0] && platformState.rows[0].platform_suspended_at) {
    return {
      httpStatus: 403,
      payload: billingBlockPayload({
        error: "Company is suspended by the platform.",
        code: "PLATFORM_SUSPENDED",
        billing_status: status,
        action_required: "contact_support",
        portal_available: false
      })
    };
  }

  if (status === "suspended") {
    return {
      httpStatus: 403,
      payload: billingBlockPayload({
        error: "Subscription suspended. Update billing to continue.",
        code: "BILLING_SUSPENDED",
        billing_status: status,
        action_required: "resolve_suspension"
      })
    };
  }

  if (status === "cancelled" || status === "expired") {
    return {
      httpStatus: 403,
      payload: billingBlockPayload({
        error: status === "expired"
          ? "Subscription expired. Subscribe to continue."
          : "Subscription cancelled. Reactivate billing to continue.",
        code: status === "expired" ? "BILLING_EXPIRED" : "BILLING_CANCELLED",
        billing_status: status,
        action_required: status === "expired" ? "subscribe" : "reactivate_subscription"
      })
    };
  }

  if (status === "past_due" || status === "unpaid") {
    const grace = billing.billing_grace_until ? new Date(billing.billing_grace_until) : null;
    const graceValid = grace && !Number.isNaN(grace.getTime());
    const graceExpired = !graceValid || grace.getTime() < Date.now();

    if (graceExpired) {
      return {
        httpStatus: 402,
        payload: billingBlockPayload({
          error: "Payment failed and grace period ended. Update payment method.",
          code: status === "unpaid" ? "BILLING_UNPAID" : "BILLING_GRACE_EXPIRED",
          billing_status: status,
          action_required: "update_payment"
        })
      };
    }
  }

  if (status === "incomplete") {
    return {
      httpStatus: 402,
      payload: billingBlockPayload({
        error: "Subscription payment is incomplete. Finish checkout or update your payment method.",
        code: "BILLING_INCOMPLETE",
        billing_status: status,
        action_required: "complete_checkout"
      })
    };
  }

  if (status === "paused") {
    return {
      httpStatus: 403,
      payload: billingBlockPayload({
        error: "Payment collection is paused on this subscription. Resume billing in the customer portal to continue.",
        code: "BILLING_PAUSED",
        billing_status: status,
        action_required: "resume_billing"
      })
    };
  }

  const trialMeta = computeTrialMeta(billing);

  if (trialMeta.is_trial_expired) {
    return {
      httpStatus: 402,
      payload: billingBlockPayload({
        error: "Trial has expired. Subscribe to continue.",
        code: "TRIAL_EXPIRED",
        billing_status: status,
        action_required: "subscribe"
      })
    };
  }

  const summary = await getBillingSummary(companyId);
  const limitName = mutationLimitForRequest(options);
  if (summary && limitName) {
    const limitValue = summary.limits && summary.limits[limitName];
    const usageMap = {
      max_users: "users_count",
      max_clients: "clients_count",
      max_jobs_per_month: "jobs_this_month"
    };
    const usageName = usageMap[limitName];
    const currentUsage = summary.usage ? num(summary.usage[usageName]) : 0;

    if (limitValue != null && currentUsage >= Number(limitValue)) {
      return {
        httpStatus: 403,
        payload: billingBlockPayload({
          error: "Plan limits exceeded. Reduce usage or upgrade before making more changes.",
          code: "PLAN_LIMIT_EXCEEDED",
          billing_status: status,
          action_required: "within_plan_limits",
          extra: {
          blocked_limit: limitName,
          limits: summary.limits,
          usage: {
            users_count: summary.usage.users_count,
            clients_count: summary.usage.clients_count,
            jobs_this_month: summary.usage.jobs_this_month
          }
          }
        })
      };
    }
  }

  return null;
}

module.exports = {
  PLAN_LIMITS,
  COMPANY_SUBSCRIPTION_STATUSES,
  BILLING_GRACE_PERIOD_DAYS,
  getPlanLimits,
  normalizePlan,
  normalizeBillingStatus,
  normalizeBillingCycle,
  normalizeCompanySubscriptionStatus,
  planRank,
  buildBillingAutomationFlags,
  createCompanySubscription,
  getCompanySubscription,
  upgradeCompanyPlan,
  downgradeCompanyPlan,
  cancelCompanySubscription,
  reactivateCompanySubscription,
  renewCompanySubscription,
  getCompanyBilling,
  updateCompanyPlan,
  updateCompanyPlatformSubscription,
  syncCompanyBillingFromStripe,
  markCompanyPaymentSucceeded,
  markCompanyPaymentFailed,
  markCompanySubscriptionCancelled,
  evaluatePastDueSuspensions,
  getBillingLifecycleAutomationReadinessWarnings,
  computeTrialMeta,
  enrichBillingClientSummary,
  getPlatformBillingOverview,
  getUsageForCompany,
  getBillingWarnings,
  isOverLimit,
  getBillingSummary,
  getStaffMutationBillingBlock,
  hasUsageWithinLimits,
  MAX_TENANT_TRIAL_DAYS,
  normalizeTenantTrialDays
};

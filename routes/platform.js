const express = require("express");
const crypto = require("crypto");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { requirePlatformOwner } = auth;
const { NODE_ENV, ALLOW_MAINTENANCE_ROUTES, ALLOWED_ORIGINS } = require("../config/env");
const { getQueueStatus } = require("../services/jobQueue");
const { getSchedulerStatus } = require("../services/schedulerService");
const { normalizeBillingStatus } = require("../services/billingService");
const { suspendCompanyByPlatform, unsuspendCompanyByPlatform } = require("../services/platformControlService");
const { createNotification, ensureNotificationsSchema } = require("../services/notificationService");
const activityLogService = require("../services/activityLogService");
const { listRecentErrorLogs } = require("../services/errorLogService");
const { sendSafeServerError } = require("../services/safeServerError");
const { getUploadReadiness, getStorageActivationStatus } = require("../services/uploadService");
const { getHealthReadiness } = require("../services/productionReadiness");
const { getMonitoringSnapshot, getMonitoringActivationReadiness } = require("../services/monitoringService");
const { getBackupReadiness, validateBackupScheduleReadiness, validateBackupRetentionReadiness, validateRestoreDrillReadiness } = require("../services/backupService");
const { refreshCompanyReputation } = require("../services/reputationService");
const { notifyVerificationApproved, notifyBillingWarning } = require("../services/notificationService");
const growthFoundationService = require("../services/growthFoundationService");
const trustReputationService = require("../services/trustReputationService");
const referralEngineService = require("../services/referralEngineService");
const marketplaceRankingService = require("../services/marketplaceRankingService");

const router = express.Router();
const platformOnly = [auth, requirePlatformOwner];

function parsePagination(query) {
  const parsedLimit = Number(query && query.limit);
  const parsedOffset = Number(query && query.offset);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;
  return { limit, offset };
}

function num(value) {
  return Number(value || 0);
}

async function one(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || {};
}

function warningSummary(warnings) {
  const list = warnings && Array.isArray(warnings.warnings) ? warnings.warnings : [];
  return {
    warnings_count: list.length,
    has_billing_warning: list.length > 0,
    warning_types: list.map((warning) => warning.type).filter(Boolean)
  };
}

function cleanCustomerStatus(value, fallback = "active") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "active" || normalized === "suspended" || normalized === "deactivated") {
    return normalized;
  }
  return fallback;
}

function cleanVerificationStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["unverified", "pending", "verified", "rejected", "suspended"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanLicenseOrInsuranceStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["unknown", "pending", "verified", "rejected", "expired"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanIdentityStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["unknown", "pending", "verified", "rejected"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanModerationStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["open", "reviewing", "action_taken", "dismissed", "closed"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanModerationPriority(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high", "urgent"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanModerationTargetType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["company", "review", "message", "marketplace_request"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanDisputeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["open", "reviewing", "waiting_customer", "waiting_company", "resolved", "closed"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanDisputePriority(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high", "urgent"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanInviteType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["founding_partner", "company_user", "referral"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanInviteStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["pending", "accepted", "expired", "canceled"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseCustomerPagination(query) {
  const parsedLimit = Number(query && query.limit);
  const parsedOffset = Number(query && query.offset);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;
  return { limit, offset };
}

function buildUsageFromCompanyRow(row) {
  const status = normalizeBillingStatus(row && row.billing_status);
  return {
    users_count: num(row && row.users_count),
    clients_count: num(row && row.usage_clients_count),
    jobs_this_month: num(row && row.jobs_this_month),
    users: num(row && row.users_count),
    clients: num(row && row.usage_clients_count),
    max_users: row && row.max_users != null ? num(row.max_users) : null,
    max_clients: row && row.max_clients != null ? num(row.max_clients) : null,
    max_jobs_per_month: row && row.max_jobs_per_month != null ? num(row.max_jobs_per_month) : null,
    plan: row && row.plan ? String(row.plan) : "starter",
    status,
    billing_status: status,
    trial_ends_at: row && row.trial_ends_at ? row.trial_ends_at : null
  };
}

function buildWarningsFromUsageRow(usage, row) {
  const now = new Date();
  const status = normalizeBillingStatus(usage && usage.billing_status);
  const trialEndsAt = usage && usage.trial_ends_at ? new Date(usage.trial_ends_at) : null;
  const graceUntil = row && row.billing_grace_until ? new Date(row.billing_grace_until) : null;
  const validTrialEndsAt = trialEndsAt && !Number.isNaN(trialEndsAt.getTime()) ? trialEndsAt : null;
  const validGraceUntil = graceUntil && !Number.isNaN(graceUntil.getTime()) ? graceUntil : null;
  const isTrialExpired = (status === "trial" || status === "trialing")
    && validTrialEndsAt
    && validTrialEndsAt < now;
  const isPastDue = status === "past_due" || status === "unpaid";
  const isIncomplete = status === "incomplete";
  const isPaused = status === "paused";
  const isCancelled = status === "cancelled" || status === "expired";
  const isSuspended = status === "suspended";
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
      type: status === "unpaid" ? "unpaid" : "past_due",
      severity: "danger",
      message: validGraceUntil
        ? `Payment failed. Grace period ends ${validGraceUntil.toISOString().split("T")[0]}.`
        : "Payment failed. Grace period is not set.",
      current: status,
      limit: validGraceUntil ? validGraceUntil.toISOString() : "active"
    });
  }
  if (isIncomplete) {
    warnings.push({
      type: "incomplete",
      severity: "danger",
      message: "Subscription checkout or first payment is incomplete.",
      current: status,
      limit: "active"
    });
  }
  if (isPaused) {
    warnings.push({
      type: "paused",
      severity: "warning",
      message: "Stripe payment collection is paused for this subscription.",
      current: status,
      limit: "active"
    });
  }
  if (isCancelled) {
    warnings.push({
      type: "cancelled",
      severity: "danger",
      message: "Billing status is cancelled.",
      current: status,
      limit: "active"
    });
  }
  if (isSuspended) {
    warnings.push({
      type: "suspended",
      severity: "danger",
      message: "Company platform billing is suspended.",
      current: status,
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
    is_unpaid: status === "unpaid",
    is_incomplete: isIncomplete,
    is_paused: isPaused,
    is_cancelled: isCancelled,
    is_suspended: isSuspended,
    grace_days_remaining: validGraceUntil
      ? Math.ceil((validGraceUntil.getTime() - Date.now()) / 86400000)
      : null,
    over_user_limit: overUserLimit,
    over_client_limit: overClientLimit,
    over_job_limit: overJobLimit,
    warnings
  };
}

router.get("/platform/overview", platformOnly, async (req, res) => {
  try {
    console.log("PLATFORM OVERVIEW VIEWED:", req.user && req.user.username);

    const [
      companies,
      users,
      clients,
      jobs,
      invoices,
      payments,
      subscriptions,
      recentCompanies
    ] = await Promise.all([
      one("SELECT COUNT(*)::int AS count FROM companies"),
      one("SELECT COUNT(*)::int AS count FROM users"),
      one("SELECT COUNT(*)::int AS count FROM clients"),
      one("SELECT COUNT(*)::int AS count FROM jobs"),
      one("SELECT COUNT(*)::int AS count FROM invoices"),
      one("SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments"),
      one("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status = 'active'"),
      pool.query(`
        SELECT id, name, phone, email, created_at
        FROM companies
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 8
      `)
    ]);

    res.json({
      total_companies: num(companies.count),
      total_users: num(users.count),
      total_clients: num(clients.count),
      total_jobs: num(jobs.count),
      total_invoices: num(invoices.count),
      total_payments_collected: num(payments.total),
      active_subscriptions: num(subscriptions.count),
      recent_companies: recentCompanies.rows
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM OVERVIEW ERROR");
  }
});

router.get("/platform/companies", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(`
      SELECT
        companies.id,
        companies.name,
        companies.phone,
        companies.email,
        companies.created_at,
        companies.plan,
        companies.billing_status,
        companies.billing_grace_until,
        companies.billing_last_payment_failed_at,
        companies.billing_last_payment_succeeded_at,
        companies.billing_suspended_at,
        companies.billing_cancelled_at,
        companies.billing_failure_reason,
        companies.platform_suspended_at,
        companies.platform_suspension_reason,
        companies.monthly_price,
        companies.max_users,
        companies.max_clients,
        companies.max_jobs_per_month,
        companies.trial_ends_at,
        COALESCE(users_counts.count, 0)::int AS users_count,
        COALESCE(clients_counts.count, 0)::int AS clients_count,
        COALESCE(active_clients_counts.count, 0)::int AS usage_clients_count,
        COALESCE(jobs_counts.count, 0)::int AS jobs_count,
        COALESCE(jobs_this_month_counts.count, 0)::int AS jobs_this_month,
        COALESCE(invoices_counts.count, 0)::int AS invoices_count,
        COALESCE(payments_counts.total, 0)::numeric AS payments_total,
        COALESCE(subscription_counts.count, 0)::int AS active_subscriptions_count
      FROM companies
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM users
        GROUP BY company_id
      ) users_counts ON users_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM clients
        GROUP BY company_id
      ) clients_counts ON clients_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM clients
        WHERE COALESCE(archived, FALSE) = FALSE
        GROUP BY company_id
      ) active_clients_counts ON active_clients_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM jobs
        GROUP BY company_id
      ) jobs_counts ON jobs_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM jobs
        WHERE date >= date_trunc('month', CURRENT_DATE)::date
        GROUP BY company_id
      ) jobs_this_month_counts ON jobs_this_month_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM invoices
        GROUP BY company_id
      ) invoices_counts ON invoices_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, SUM(amount)::numeric AS total
        FROM payments
        GROUP BY company_id
      ) payments_counts ON payments_counts.company_id = companies.id
      LEFT JOIN (
        SELECT company_id, COUNT(*)::int AS count
        FROM subscriptions
        WHERE status = 'active'
        GROUP BY company_id
      ) subscription_counts ON subscription_counts.company_id = companies.id
      ORDER BY companies.created_at DESC NULLS LAST, companies.id DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const rows = [];

    for (const row of result.rows) {
      const usage = buildUsageFromCompanyRow(row);
      const warnings = buildWarningsFromUsageRow(usage, row);
      const {
        usage_clients_count,
        jobs_this_month,
        trial_ends_at,
        max_users,
        max_clients,
        max_jobs_per_month,
        ...publicRow
      } = row;

      rows.push({
        ...publicRow,
        users_count: num(row.users_count),
        clients_count: num(row.clients_count),
        jobs_count: num(row.jobs_count),
        invoices_count: num(row.invoices_count),
        payments_total: num(row.payments_total),
        active_subscriptions_count: num(row.active_subscriptions_count),
        monthly_price: num(row.monthly_price),
        usage,
        warnings,
        warning_mode: true,
        ...warningSummary(warnings)
      });
    }

    res.json(rows);
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM COMPANIES ERROR");
  }
});

router.get("/platform/companies/:id", platformOnly, async (req, res) => {
  try {
    const companyId = req.params.id;

    const company = await one(`
      SELECT
        id,
        name,
        phone,
        email,
        address,
        service_area,
        business_hours,
        created_at,
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
        platform_suspended_at,
        platform_suspension_reason,
        monthly_price,
        max_users,
        max_clients,
        max_jobs_per_month
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [companyId]);

    if (!company.id) {
      return res.status(404).json({ error: "Company not found" });
    }

    const [users, metrics, recentJobs, recentInvoices, recentActivity, usage, billingWarnings] = await Promise.all([
      pool.query(`
        SELECT id, username, role, active, worker_id
        FROM users
        WHERE company_id = $1
        ORDER BY id ASC
      `, [companyId]),
      one(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE company_id = $1)::int AS users_count,
          (SELECT COUNT(*) FROM clients WHERE company_id = $1)::int AS clients_count,
          (SELECT COUNT(*) FROM jobs WHERE company_id = $1)::int AS jobs_count,
          (SELECT COUNT(*) FROM jobs WHERE company_id = $1 AND status = 'completed')::int AS completed_jobs,
          (SELECT COUNT(*) FROM invoices WHERE company_id = $1)::int AS invoices_count,
          (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE company_id = $1)::numeric AS invoices_total,
          (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE company_id = $1)::numeric AS payments_total,
          (SELECT COUNT(*) FROM subscriptions WHERE company_id = $1 AND status = 'active')::int AS active_subscriptions_count
      `, [companyId]),
      pool.query(`
        SELECT jobs.id, jobs.service, jobs.date, jobs.status, clients.name AS client_name, workers.name AS worker_name
        FROM jobs
        LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
        LEFT JOIN workers ON workers.id = jobs.worker_id AND workers.company_id = jobs.company_id
        WHERE jobs.company_id = $1
        ORDER BY jobs.date DESC NULLS LAST, jobs.id DESC
        LIMIT 10
      `, [companyId]),
      pool.query(`
        SELECT invoices.id, invoices.invoice_number, invoices.status, invoices.amount, invoices.due_date, clients.name AS client_name
        FROM invoices
        LEFT JOIN clients ON clients.id = invoices.client_id AND clients.company_id = invoices.company_id
        WHERE invoices.company_id = $1
        ORDER BY invoices.id DESC
        LIMIT 10
      `, [companyId]),
      pool.query(`
        SELECT id, user_id, action, entity_type, entity_id, details, created_at
        FROM activity_log
        WHERE company_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 20
      `, [companyId]),
      getUsageForCompany(companyId),
      getBillingWarnings(companyId)
    ]);

    res.json({
      company,
      users: users.rows,
      metrics: {
        users_count: num(metrics.users_count),
        clients_count: num(metrics.clients_count),
        jobs_count: num(metrics.jobs_count),
        completed_jobs: num(metrics.completed_jobs),
        invoices_count: num(metrics.invoices_count),
        invoices_total: num(metrics.invoices_total),
        payments_total: num(metrics.payments_total),
        active_subscriptions_count: num(metrics.active_subscriptions_count)
      },
      usage,
      warnings: billingWarnings,
      warning_mode: true,
      ...warningSummary(billingWarnings),
      recent_jobs: recentJobs.rows,
      recent_invoices: recentInvoices.rows.map(row => ({ ...row, amount: num(row.amount) })),
      recent_activity: recentActivity.rows
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM COMPANY DETAIL ERROR");
  }
});

router.get("/platform/analytics", platformOnly, async (req, res) => {
  try {
    const [companyStats, userStats, jobStats, revenueStats, monthlyCompanies, monthlyJobs] = await Promise.all([
      one(`
        SELECT
          COUNT(*)::int AS total_companies,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))::int AS companies_this_month
        FROM companies
      `),
      one(`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE COALESCE(active, TRUE) = TRUE)::int AS active_users,
          COUNT(*) FILTER (WHERE role = 'platform_owner')::int AS platform_users
        FROM users
      `),
      one(`
        SELECT
          COUNT(*)::int AS total_jobs,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
          COUNT(*) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)::date)::int AS jobs_this_month
        FROM jobs
      `),
      one(`
        SELECT
          COALESCE((SELECT SUM(amount) FROM payments), 0)::numeric AS total_collected,
          COALESCE((SELECT SUM(amount) FROM payments WHERE date >= date_trunc('month', CURRENT_DATE)::date), 0)::numeric AS collected_this_month,
          COALESCE((SELECT AVG(amount) FROM invoices), 0)::numeric AS average_invoice_value
      `),
      pool.query(`
        SELECT to_char(months.month, 'YYYY-MM') AS month,
               COUNT(companies.id)::int AS companies
        FROM generate_series(
          date_trunc('month', CURRENT_DATE)::date - INTERVAL '11 months',
          date_trunc('month', CURRENT_DATE)::date,
          INTERVAL '1 month'
        ) AS months(month)
        LEFT JOIN companies ON companies.created_at >= months.month
          AND companies.created_at < months.month + INTERVAL '1 month'
        GROUP BY months.month
        ORDER BY months.month ASC
      `),
      pool.query(`
        SELECT to_char(months.month, 'YYYY-MM') AS month,
               COUNT(jobs.id)::int AS jobs
        FROM generate_series(
          date_trunc('month', CURRENT_DATE)::date - INTERVAL '11 months',
          date_trunc('month', CURRENT_DATE)::date,
          INTERVAL '1 month'
        ) AS months(month)
        LEFT JOIN jobs ON jobs.date >= months.month
          AND jobs.date < months.month + INTERVAL '1 month'
        GROUP BY months.month
        ORDER BY months.month ASC
      `)
    ]);

    const totalJobs = num(jobStats.total_jobs);
    const completedJobs = num(jobStats.completed_jobs);

    res.json({
      companies: {
        total: num(companyStats.total_companies),
        this_month: num(companyStats.companies_this_month)
      },
      users: {
        total: num(userStats.total_users),
        active: num(userStats.active_users),
        platform_users: num(userStats.platform_users)
      },
      jobs: {
        total: totalJobs,
        completed: completedJobs,
        this_month: num(jobStats.jobs_this_month),
        completion_rate: totalJobs ? Math.round((completedJobs / totalJobs) * 1000) / 10 : 0
      },
      revenue: {
        total_collected: num(revenueStats.total_collected),
        collected_this_month: num(revenueStats.collected_this_month),
        average_invoice_value: num(revenueStats.average_invoice_value)
      },
      trends: {
        monthly_companies: monthlyCompanies.rows.map(row => ({ month: row.month, companies: num(row.companies) })),
        monthly_jobs: monthlyJobs.rows.map(row => ({ month: row.month, jobs: num(row.jobs) }))
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM ANALYTICS ERROR");
  }
});

router.get("/platform/metrics/foundation", platformOnly, async (req, res) => {
  try {
    const payload = await growthFoundationService.getPlatformFoundationMetrics();
    res.json(payload);
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM METRICS FOUNDATION ERROR");
  }
});

router.post("/platform/trust/recompute-scores", platformOnly, async (req, res) => {
  try {
    const raw = req.body && req.body.company_id;
    const singleId = raw !== undefined && raw !== null && raw !== "" ? Number(raw) : null;
    if (singleId != null && Number.isInteger(singleId) && singleId > 0) {
      const snapshot = await trustReputationService.persistCompanyTrustScores(singleId);
      return res.json({
        mode: "single",
        company_id: singleId,
        snapshot
      });
    }

    const limit = Number(req.body && req.body.limit);
    const processed = await trustReputationService.recomputeAllCompanyTrustScores(
      Number.isInteger(limit) && limit > 0 ? limit : undefined
    );
    res.json({
      mode: "all",
      ...processed
    });
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ error: "Company not found" });
    }
    sendSafeServerError(res, err, "PLATFORM TRUST RECOMPUTE ERROR");
  }
});

router.post("/platform/marketplace/recompute-rankings", platformOnly, async (req, res) => {
  try {
    const raw = req.body && req.body.company_id;
    const singleId = raw !== undefined && raw !== null && raw !== "" ? Number(raw) : null;
    const userId = req.user && req.user.id ? Number(req.user.id) : null;

    if (singleId != null && Number.isInteger(singleId) && singleId > 0) {
      const snapshot = await marketplaceRankingService.refreshCompanyRanking(singleId, {
        logActivity: true,
        userId
      });
      return res.json({
        mode: "single",
        company_id: singleId,
        ...snapshot
      });
    }

    const limit = Number(req.body && req.body.limit);
    const processed = await marketplaceRankingService.refreshAllRankings(
      Number.isInteger(limit) && limit > 0 ? limit : undefined,
      { userId }
    );
    res.json({
      mode: "all",
      ...processed
    });
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ error: "Company not found" });
    }
    sendSafeServerError(res, err, "PLATFORM MARKETPLACE RANKING RECOMPUTE ERROR");
  }
});

router.get("/platform/health", platformOnly, async (req, res) => {
  try {
    const database = await one("SELECT NOW() AS checked_at");

    res.json({
      app: {
        status: "ok",
        name: "FairLinx",
        env: NODE_ENV,
        checked_at: new Date().toISOString()
      },
      database: {
        status: database.checked_at ? "ok" : "unknown",
        checked_at: database.checked_at || null
      },
      queue: getQueueStatus(),
      scheduler: getSchedulerStatus(),
      uploads: getUploadReadiness()
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM HEALTH ERROR");
  }
});

router.get("/platform/launch-readiness", platformOnly, async (req, res) => {
  try {
    const readiness = await getHealthReadiness();
    return res.json({
      ok: readiness && readiness.ok === true,
      app: readiness && readiness.app ? readiness.app : { app: "FairLinx" },
      billing: readiness && readiness.billing ? readiness.billing : { status: "needs_review" },
      uploads: readiness && readiness.uploads ? readiness.uploads : { status: "needs_review" },
      workflows: readiness && readiness.workflows ? readiness.workflows : { status: "needs_review" },
      environment: readiness && readiness.environment ? readiness.environment : { status: "needs_review" },
      operational: readiness && readiness.operational ? readiness.operational : {}
    });
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM LAUNCH READINESS ERROR");
  }
});

router.get("/platform/monitoring", platformOnly, async (req, res) => {
  try {
    const snapshot = await getMonitoringSnapshot();
    return res.json(snapshot);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM MONITORING ERROR");
  }
});

router.get("/platform/backups/status", platformOnly, async (req, res) => {
  try {
    return res.json(getBackupReadiness());
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM BACKUP STATUS ERROR");
  }
});

router.get("/platform/storage/readiness", platformOnly, async (req, res) => {
  try {
    return res.json(getStorageActivationStatus());
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM STORAGE READINESS ERROR");
  }
});

router.get("/platform/monitoring/readiness", platformOnly, async (req, res) => {
  try {
    return res.json(getMonitoringActivationReadiness());
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM MONITORING READINESS ERROR");
  }
});

router.get("/platform/backups/readiness", platformOnly, async (req, res) => {
  try {
    const schedule = validateBackupScheduleReadiness();
    const retention = validateBackupRetentionReadiness();
    const restore = validateRestoreDrillReadiness();
    return res.json({
      status: [schedule, retention, restore].every((item) => item && item.status === "ok") ? "ready" : "needs_review",
      schedule,
      retention,
      restore
    });
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM BACKUPS READINESS ERROR");
  }
});

router.get("/platform/founding-partner/invites", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const status = cleanInviteStatus(req.query && req.query.status);
    const type = cleanInviteType(req.query && req.query.invite_type);
    const q = String((req.query && req.query.q) || "").trim();
    const params = [];
    const conds = [];
    if (status) {
      params.push(status);
      conds.push(`LOWER(status) = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conds.push(`LOWER(invite_type) = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`LOWER(invited_email) LIKE $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);
    const result = await pool.query(
      `
      SELECT
        id,
        company_id,
        invited_email,
        invited_by_user_id,
        invite_type,
        status,
        token_hash,
        created_at,
        accepted_at
      FROM company_invites
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return res.json(result.rows.map((row) => ({
      ...row,
      token_hash_present: Boolean(row.token_hash),
      token_hash: null
    })));
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM FOUNDING PARTNER INVITES LIST ERROR");
  }
});

router.post("/platform/founding-partner/invites", platformOnly, async (req, res) => {
  try {
    const invitedEmail = cleanEmail(req.body && req.body.invited_email);
    const inviteType = cleanInviteType(req.body && req.body.invite_type) || "founding_partner";
    if (!invitedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitedEmail)) {
      return res.status(400).json({ error: "Valid invited_email is required" });
    }
    if (inviteType !== "founding_partner") {
      return res.status(400).json({ error: "Only founding_partner invites are supported in this phase" });
    }
    const existing = await pool.query(
      `
      SELECT id
      FROM company_invites
      WHERE LOWER(invited_email) = LOWER($1)
        AND invite_type = 'founding_partner'
        AND status = 'pending'
      LIMIT 1
      `,
      [invitedEmail]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: "Pending invite already exists for this email" });
    }
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const inserted = await pool.query(
      `
      INSERT INTO company_invites (
        company_id, invited_email, invited_by_user_id, invite_type, status, token_hash
      )
      VALUES (NULL, $1, $2, 'founding_partner', 'pending', $3)
      RETURNING id, company_id, invited_email, invited_by_user_id, invite_type, status, created_at, accepted_at
      `,
      [invitedEmail, Number(req.user.id), tokenHash]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM FOUNDING PARTNER INVITE CREATE ERROR");
  }
});

router.patch("/platform/founding-partner/invites/:id/cancel", platformOnly, async (req, res) => {
  try {
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId) || inviteId <= 0) {
      return res.status(400).json({ error: "Invalid invite id" });
    }
    const result = await pool.query(
      `
      UPDATE company_invites
      SET status = 'canceled'
      WHERE id = $1
        AND invite_type = 'founding_partner'
        AND status = 'pending'
      RETURNING id, company_id, invited_email, invited_by_user_id, invite_type, status, created_at, accepted_at
      `,
      [inviteId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Pending invite not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM FOUNDING PARTNER INVITE CANCEL ERROR");
  }
});

router.patch("/platform/founding-partner/invites/:id/accept", platformOnly, async (req, res) => {
  try {
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId) || inviteId <= 0) {
      return res.status(400).json({ error: "Invalid invite id" });
    }
    const acceptedCompanyId = Number(req.body && req.body.accepted_company_id);
    const acceptanceNotes = String(req.body && req.body.acceptance_notes || "").trim().slice(0, 2000);
    const result = await pool.query(
      `
      UPDATE company_invites
      SET
        status = 'accepted',
        accepted_at = CURRENT_TIMESTAMP,
        accepted_by_platform_user_id = $2,
        accepted_company_id = CASE WHEN $3::int > 0 THEN $3 ELSE accepted_company_id END,
        acceptance_notes = CASE WHEN $4 = '' THEN acceptance_notes ELSE $4 END
      WHERE id = $1
        AND invite_type = 'founding_partner'
        AND status = 'pending'
      RETURNING id, company_id, invited_email, invited_by_user_id, invite_type, status, created_at, accepted_at
      `,
      [inviteId, Number(req.user.id), Number.isInteger(acceptedCompanyId) ? acceptedCompanyId : 0, acceptanceNotes]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Pending invite not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM FOUNDING PARTNER INVITE ACCEPT ERROR");
  }
});

router.get("/platform/billing-lifecycle/audit", platformOnly, async (req, res) => {
  try {
    const summary = await pool.query(
      `
      SELECT
        COALESCE(billing_status, 'unknown') AS billing_status,
        COUNT(*)::int AS count
      FROM companies
      GROUP BY COALESCE(billing_status, 'unknown')
      ORDER BY count DESC, billing_status ASC
      `
    );
    const grace = await one(
      `
      SELECT
        COUNT(*) FILTER (WHERE billing_grace_until IS NOT NULL AND billing_grace_until >= CURRENT_TIMESTAMP)::int AS in_grace,
        COUNT(*) FILTER (WHERE billing_grace_until IS NOT NULL AND billing_grace_until < CURRENT_TIMESTAMP)::int AS grace_expired
      FROM companies
      `
    );
    const missingStripe = await one(
      `
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(stripe_customer_id), ''), '') = '')::int AS missing_stripe_customer_id,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(stripe_subscription_id), ''), '') = '')::int AS missing_stripe_subscription_id
      FROM companies
      `
    );
    const statusCounts = summary.rows.reduce((acc, row) => {
      acc[String(row.billing_status || "unknown")] = Number(row.count || 0);
      return acc;
    }, {});
    const warnings = [];
    if (Number(missingStripe.missing_stripe_customer_id || 0) > 0) {
      warnings.push("Some companies are missing Stripe customer IDs.");
    }
    if (Number(missingStripe.missing_stripe_subscription_id || 0) > 0) {
      warnings.push("Some companies are missing Stripe subscription IDs.");
    }
    if (Number(grace.grace_expired || 0) > 0) {
      warnings.push("Some companies have expired grace periods.");
    }
    const payload = {
      status_counts: statusCounts,
      grace_period: {
        in_grace: Number(grace.in_grace || 0),
        grace_expired: Number(grace.grace_expired || 0)
      },
      risk_statuses: {
        past_due: Number(statusCounts.past_due || 0),
        unpaid: Number(statusCounts.unpaid || 0),
        canceled: Number(statusCounts.canceled || statusCounts.cancelled || 0)
      },
      missing_stripe_fields: {
        stripe_customer_id: Number(missingStripe.missing_stripe_customer_id || 0),
        stripe_subscription_id: Number(missingStripe.missing_stripe_subscription_id || 0)
      },
      warnings
    };
    if (warnings.length) {
      try {
        await notifyBillingWarning({
          companyId: Number(req.user.company_id),
          warningMessage: warnings[0]
        });
      } catch (_) {
        // read-only endpoint remains non-fatal
      }
    }
    return res.json(payload);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM BILLING LIFECYCLE AUDIT ERROR");
  }
});

router.get("/platform/activity", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(`
      SELECT
        activity_log.id,
        activity_log.company_id,
        companies.name AS company_name,
        activity_log.user_id,
        users.username,
        activity_log.action,
        activity_log.entity_type,
        activity_log.entity_id,
        activity_log.details,
        activity_log.created_at
      FROM activity_log
      LEFT JOIN companies ON companies.id = activity_log.company_id
      LEFT JOIN users ON users.id = activity_log.user_id
      ORDER BY activity_log.created_at DESC, activity_log.id DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM ACTIVITY ERROR");
  }
});

router.get("/platform/users", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(`
      SELECT id, username, role, active, company_id
      FROM users
      WHERE role = 'platform_owner'
      ORDER BY id ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM USERS ERROR");
  }
});

router.get("/platform/settings", platformOnly, async (req, res) => {
  try {
    res.json({
      mode: "read_only",
      editable: false,
      environment: NODE_ENV,
      maintenance_routes_enabled: Boolean(ALLOW_MAINTENANCE_ROUTES),
      allowed_origins_count: Array.isArray(ALLOWED_ORIGINS) ? ALLOWED_ORIGINS.length : 0,
      notes: [
        "Platform settings are read-only in Phase 1.",
        "Billing, payments, Stripe, and business workflow settings are intentionally excluded."
      ]
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM SETTINGS ERROR");
  }
});

router.get("/platform/error-logs", platformOnly, async (req, res) => {
  try {
    const limit = req.query && req.query.limit ? Number(req.query.limit) : 100;
    const rows = await listRecentErrorLogs({ limit });
    res.json({ items: rows, warning_mode: true });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM ERROR LOGS");
  }
});

router.post("/platform/companies/:id/suspend", platformOnly, async (req, res) => {
  try {
    const companyId = req.params.id;
    await suspendCompanyByPlatform({
      companyId,
      actorUserId: req.user.id,
      reason: req.body && req.body.reason
    });
    try {
      await ensureNotificationsSchema();
      await createNotification({
        companyId: Number(companyId),
        userId: null,
        type: "company_suspended",
        title: "Company suspended by platform",
        message: (req.body && req.body.reason && String(req.body.reason).trim())
          ? String(req.body.reason).trim()
          : "This workspace was suspended by the platform. You can still view data; contact support to resolve.",
        metadata: { platform: true }
      });
    } catch (notifErr) {
      /* non-fatal */
    }
    try {
      await activityLogService.ensureActivityLogSchema();
      await activityLogService.logActivity({
        companyId: Number(companyId),
        userId: req.user.id,
        action: "platform_company_suspended",
        entityType: "company",
        entityId: Number(companyId),
        details: {
          reason: (req.body && req.body.reason) || null
        }
      });
    } catch (actErr) {
      /* non-fatal */
    }
    const company = await one(`
      SELECT id, name, platform_suspended_at, platform_suspension_reason
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [companyId]);
    res.json({ success: true, company });
  } catch (err) {
    if (err && err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    sendSafeServerError(res, err, "PLATFORM COMPANY SUSPEND ERROR");
  }
});

router.post("/platform/companies/:id/unsuspend", platformOnly, async (req, res) => {
  try {
    const companyId = req.params.id;
    await unsuspendCompanyByPlatform({
      companyId,
      actorUserId: req.user.id
    });
    try {
      await activityLogService.ensureActivityLogSchema();
      await activityLogService.logActivity({
        companyId: Number(companyId),
        userId: req.user.id,
        action: "platform_company_unsuspended",
        entityType: "company",
        entityId: Number(companyId),
        details: {}
      });
    } catch (actErr) {
      /* non-fatal */
    }
    const company = await one(`
      SELECT id, name, platform_suspended_at, platform_suspension_reason
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [companyId]);
    res.json({ success: true, company });
  } catch (err) {
    if (err && err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    sendSafeServerError(res, err, "PLATFORM COMPANY UNSUSPEND ERROR");
  }
});

router.get("/platform/customers", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parseCustomerPagination(req.query);
    const q = String((req.query && req.query.q) || "").trim();
    const requestedStatus = String((req.query && req.query.status) || "").trim().toLowerCase();
    const statusFilter = requestedStatus && requestedStatus !== "all"
      ? cleanCustomerStatus(requestedStatus, "")
      : "";

    const params = [];
    const conds = [];

    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      conds.push(
        `(ca.email ILIKE $${idx} OR ca.first_name ILIKE $${idx} OR ca.last_name ILIKE $${idx} OR ca.phone ILIKE $${idx} OR CAST(ca.id AS TEXT) ILIKE $${idx})`
      );
    }

    if (statusFilter) {
      params.push(statusFilter);
      conds.push(`LOWER(ca.status) = $${params.length}`);
    }

    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);

    const result = await pool.query(
      `
      SELECT
        ca.id,
        ca.client_id,
        ca.email,
        ca.first_name,
        ca.last_name,
        ca.phone,
        ca.is_verified,
        ca.created_at,
        ca.updated_at,
        ca.status,
        ca.suspended_at,
        ca.suspended_reason,
        ca.deactivated_at,
        c.company_id,
        c.name AS client_name
      FROM customer_accounts ca
      LEFT JOIN clients c ON c.id = ca.client_id
      ${whereSql}
      ORDER BY ca.created_at DESC, ca.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    res.json(result.rows.map((row) => ({
      ...row,
      status: cleanCustomerStatus(row.status, "active")
    })));
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM CUSTOMERS LIST ERROR");
  }
});

router.get("/platform/customers/:id", platformOnly, async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id" });
    }

    const customer = await one(
      `
      SELECT
        ca.id,
        ca.client_id,
        ca.email,
        ca.first_name,
        ca.last_name,
        ca.phone,
        ca.address,
        ca.is_verified,
        ca.created_at,
        ca.updated_at,
        ca.status,
        ca.suspended_at,
        ca.suspended_reason,
        ca.deactivated_at,
        c.company_id,
        c.name AS client_name,
        c.email AS client_email,
        c.phone AS client_phone
      FROM customer_accounts ca
      LEFT JOIN clients c ON c.id = ca.client_id
      WHERE ca.id = $1
      LIMIT 1
      `,
      [customerId]
    );

    if (!customer.id) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const [marketplaceRequests, reviews, reports] = await Promise.all([
      one(
        `
        SELECT COUNT(*)::int AS count
        FROM marketplace_requests
        WHERE ($1::int IS NOT NULL AND customer_account_id = $1)
           OR ($2::int IS NOT NULL AND client_id = $2)
        `,
        [customer.id || null, customer.client_id || null]
      ),
      one(
        `
        SELECT COUNT(*)::int AS count
        FROM company_reviews
        WHERE client_id = $1
        `,
        [customer.client_id || 0]
      ),
      one(
        `
        SELECT COUNT(*)::int AS count
        FROM company_reports
        WHERE customer_id = $1
        `,
        [customerId]
      )
    ]);

    return res.json({
      customer: {
        ...customer,
        status: cleanCustomerStatus(customer.status, "active")
      },
      summary: {
        marketplace_requests_count: num(marketplaceRequests.count),
        reviews_count: num(reviews.count),
        reports_count: num(reports.count)
      }
    });
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM CUSTOMER DETAIL ERROR");
  }
});

router.patch("/platform/customers/:id/suspend", platformOnly, async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id" });
    }
    const reason = String((req.body && req.body.reason) || "").trim();
    const result = await pool.query(
      `
      UPDATE customer_accounts
      SET
        status = 'suspended',
        suspended_at = CURRENT_TIMESTAMP,
        suspended_reason = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, client_id, email, first_name, last_name, phone, status, suspended_at, suspended_reason, deactivated_at, created_at, updated_at
      `,
      [customerId, reason || null]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Customer not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM CUSTOMER SUSPEND ERROR");
  }
});

router.patch("/platform/customers/:id/unsuspend", platformOnly, async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id" });
    }
    const result = await pool.query(
      `
      UPDATE customer_accounts
      SET
        status = CASE WHEN deactivated_at IS NULL THEN 'active' ELSE 'deactivated' END,
        suspended_at = NULL,
        suspended_reason = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, client_id, email, first_name, last_name, phone, status, suspended_at, suspended_reason, deactivated_at, created_at, updated_at
      `,
      [customerId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Customer not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM CUSTOMER UNSUSPEND ERROR");
  }
});

router.patch("/platform/customers/:id/deactivate", platformOnly, async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id" });
    }
    const result = await pool.query(
      `
      UPDATE customer_accounts
      SET
        status = 'deactivated',
        deactivated_at = COALESCE(deactivated_at, CURRENT_TIMESTAMP),
        suspended_at = COALESCE(suspended_at, CURRENT_TIMESTAMP),
        suspended_reason = COALESCE(NULLIF(TRIM(suspended_reason), ''), 'Account deactivated by platform'),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, client_id, email, first_name, last_name, phone, status, suspended_at, suspended_reason, deactivated_at, created_at, updated_at
      `,
      [customerId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Customer not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM CUSTOMER DEACTIVATE ERROR");
  }
});

router.get("/platform/moderation/reports", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const q = String((req.query && req.query.q) || "").trim();
    const status = cleanModerationStatus(req.query && req.query.status);
    const priority = cleanModerationPriority(req.query && req.query.priority);
    const targetType = cleanModerationTargetType(req.query && req.query.target_type);

    const params = [];
    const conds = [];
    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      conds.push(`(
        CAST(r.id AS TEXT) ILIKE $${idx}
        OR CAST(r.target_id AS TEXT) ILIKE $${idx}
        OR COALESCE(c.name, '') ILIKE $${idx}
        OR r.reason ILIKE $${idx}
        OR COALESCE(r.details, '') ILIKE $${idx}
      )`);
    }
    if (status) {
      params.push(status);
      conds.push(`LOWER(r.status) = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      conds.push(`LOWER(r.priority) = $${params.length}`);
    }
    if (targetType) {
      params.push(targetType);
      conds.push(`LOWER(r.target_type) = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);

    const result = await pool.query(
      `
      SELECT
        r.id,
        r.reporter_user_id,
        r.reporter_customer_id,
        r.company_id,
        r.target_type,
        r.target_id,
        r.reason,
        r.details,
        r.status,
        r.priority,
        r.resolution_notes,
        r.resolved_by,
        r.resolved_at,
        r.created_at,
        r.updated_at,
        c.name AS company_name,
        resolver.username AS resolved_by_username
      FROM abuse_reports r
      LEFT JOIN companies c ON c.id = r.company_id
      LEFT JOIN users resolver ON resolver.id = r.resolved_by
      ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM MODERATION REPORTS LIST ERROR");
  }
});

router.patch("/platform/moderation/reports/:id", platformOnly, async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return res.status(400).json({ error: "Invalid report id" });
    }

    const incomingStatus = req.body && Object.prototype.hasOwnProperty.call(req.body, "status")
      ? cleanModerationStatus(req.body.status)
      : null;
    const incomingPriority = req.body && Object.prototype.hasOwnProperty.call(req.body, "priority")
      ? cleanModerationPriority(req.body.priority)
      : null;
    const incomingResolutionNotes = req.body && Object.prototype.hasOwnProperty.call(req.body, "resolution_notes")
      ? String(req.body.resolution_notes || "").trim().slice(0, 4000)
      : null;

    if (incomingStatus === "" || incomingPriority === "") {
      return res.status(400).json({ error: "Invalid moderation field value" });
    }

    const updates = [];
    const params = [];
    if (incomingStatus !== null) {
      params.push(incomingStatus);
      updates.push(`status = $${params.length}`);
      if (["action_taken", "dismissed", "closed"].includes(incomingStatus)) {
        updates.push("resolved_at = CURRENT_TIMESTAMP");
        params.push(req.user.id);
        updates.push(`resolved_by = $${params.length}`);
      } else {
        updates.push("resolved_at = NULL");
        updates.push("resolved_by = NULL");
      }
    }
    if (incomingPriority !== null) {
      params.push(incomingPriority);
      updates.push(`priority = $${params.length}`);
    }
    if (incomingResolutionNotes !== null) {
      params.push(incomingResolutionNotes || null);
      updates.push(`resolution_notes = $${params.length}`);
    }
    if (!updates.length) {
      return res.status(400).json({ error: "No moderation fields provided" });
    }

    params.push(reportId);
    const result = await pool.query(
      `
      UPDATE abuse_reports
      SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${params.length}
      RETURNING
        id,
        reporter_user_id,
        reporter_customer_id,
        company_id,
        target_type,
        target_id,
        reason,
        details,
        status,
        priority,
        resolution_notes,
        resolved_by,
        resolved_at,
        created_at,
        updated_at
      `,
      params
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Report not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM MODERATION REPORT UPDATE ERROR");
  }
});

router.get("/platform/disputes", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const q = String((req.query && req.query.q) || "").trim();
    const status = cleanDisputeStatus(req.query && req.query.status);
    const priority = cleanDisputePriority(req.query && req.query.priority);
    const companyId = Number(req.query && req.query.company_id);
    const customerId = Number(req.query && req.query.customer_id);
    const params = [];
    const conds = [];

    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      conds.push(`(
        CAST(d.id AS TEXT) ILIKE $${idx}
        OR COALESCE(d.reason, '') ILIKE $${idx}
        OR COALESCE(d.details, '') ILIKE $${idx}
        OR COALESCE(c.name, '') ILIKE $${idx}
      )`);
    }
    if (status) {
      params.push(status);
      conds.push(`LOWER(d.status) = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      conds.push(`LOWER(d.priority) = $${params.length}`);
    }
    if (Number.isInteger(companyId) && companyId > 0) {
      params.push(companyId);
      conds.push(`d.company_id = $${params.length}`);
    }
    if (Number.isInteger(customerId) && customerId > 0) {
      params.push(customerId);
      conds.push(`d.customer_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);

    const result = await pool.query(
      `
      SELECT
        d.id,
        d.marketplace_request_id,
        d.support_ticket_id,
        d.company_id,
        d.customer_id,
        d.opened_by_type,
        d.opened_by_user_id,
        d.opened_by_customer_id,
        d.reason,
        d.details,
        d.status,
        d.priority,
        d.resolution,
        d.resolution_notes,
        d.resolved_by,
        d.resolved_at,
        d.created_at,
        d.updated_at,
        c.name AS company_name,
        resolver.username AS resolved_by_username
      FROM disputes d
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN users resolver ON resolver.id = d.resolved_by
      ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM DISPUTES LIST ERROR");
  }
});

router.patch("/platform/disputes/:id", platformOnly, async (req, res) => {
  try {
    const disputeId = Number(req.params.id);
    if (!Number.isInteger(disputeId) || disputeId <= 0) {
      return res.status(400).json({ error: "Invalid dispute id" });
    }
    const incomingStatus = req.body && Object.prototype.hasOwnProperty.call(req.body, "status")
      ? cleanDisputeStatus(req.body.status)
      : null;
    const incomingPriority = req.body && Object.prototype.hasOwnProperty.call(req.body, "priority")
      ? cleanDisputePriority(req.body.priority)
      : null;
    const incomingResolution = req.body && Object.prototype.hasOwnProperty.call(req.body, "resolution")
      ? String(req.body.resolution || "").trim().slice(0, 2000)
      : null;
    const incomingResolutionNotes = req.body && Object.prototype.hasOwnProperty.call(req.body, "resolution_notes")
      ? String(req.body.resolution_notes || "").trim().slice(0, 4000)
      : null;

    if (incomingStatus === "" || incomingPriority === "") {
      return res.status(400).json({ error: "Invalid dispute field value" });
    }

    const updates = [];
    const params = [];
    if (incomingStatus !== null) {
      params.push(incomingStatus);
      updates.push(`status = $${params.length}`);
      if (["resolved", "closed"].includes(incomingStatus)) {
        updates.push("resolved_at = CURRENT_TIMESTAMP");
        params.push(req.user.id);
        updates.push(`resolved_by = $${params.length}`);
      } else {
        updates.push("resolved_at = NULL");
        updates.push("resolved_by = NULL");
      }
    }
    if (incomingPriority !== null) {
      params.push(incomingPriority);
      updates.push(`priority = $${params.length}`);
    }
    if (incomingResolution !== null) {
      params.push(incomingResolution || null);
      updates.push(`resolution = $${params.length}`);
    }
    if (incomingResolutionNotes !== null) {
      params.push(incomingResolutionNotes || null);
      updates.push(`resolution_notes = $${params.length}`);
    }
    if (!updates.length) {
      return res.status(400).json({ error: "No dispute fields provided" });
    }

    params.push(disputeId);
    const result = await pool.query(
      `
      UPDATE disputes
      SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${params.length}
      RETURNING
        id,
        marketplace_request_id,
        support_ticket_id,
        company_id,
        customer_id,
        opened_by_type,
        opened_by_user_id,
        opened_by_customer_id,
        reason,
        details,
        status,
        priority,
        resolution,
        resolution_notes,
        resolved_by,
        resolved_at,
        created_at,
        updated_at
      `,
      params
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM DISPUTE UPDATE ERROR");
  }
});

router.get("/platform/verification/companies", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const q = String((req.query && req.query.q) || "").trim();
    const verificationStatus = cleanVerificationStatus(req.query && req.query.verification_status);
    const licenseStatus = cleanLicenseOrInsuranceStatus(req.query && req.query.license_status);
    const insuranceStatus = cleanLicenseOrInsuranceStatus(req.query && req.query.insurance_status);

    const params = [];
    const conds = [];
    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      conds.push(`(c.name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx} OR CAST(c.id AS TEXT) ILIKE $${idx})`);
    }
    if (verificationStatus) {
      params.push(verificationStatus);
      conds.push(`LOWER(c.verification_status) = $${params.length}`);
    }
    if (licenseStatus) {
      params.push(licenseStatus);
      conds.push(`LOWER(c.license_status) = $${params.length}`);
    }
    if (insuranceStatus) {
      params.push(insuranceStatus);
      conds.push(`LOWER(c.insurance_status) = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit, offset);

    const result = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.verification_status,
        c.verified_at,
        c.verified_by,
        c.verification_notes,
        c.license_status,
        c.insurance_status,
        c.identity_status,
        c.created_at,
        verifier.username AS verified_by_username
      FROM companies c
      LEFT JOIN users verifier ON verifier.id = c.verified_by
      ${where}
      ORDER BY c.created_at DESC NULLS LAST, c.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM VERIFICATION COMPANIES LIST ERROR");
  }
});

router.patch("/platform/verification/companies/:id", platformOnly, async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const incomingVerification = req.body && Object.prototype.hasOwnProperty.call(req.body, "verification_status")
      ? cleanVerificationStatus(req.body.verification_status)
      : null;
    const incomingLicense = req.body && Object.prototype.hasOwnProperty.call(req.body, "license_status")
      ? cleanLicenseOrInsuranceStatus(req.body.license_status)
      : null;
    const incomingInsurance = req.body && Object.prototype.hasOwnProperty.call(req.body, "insurance_status")
      ? cleanLicenseOrInsuranceStatus(req.body.insurance_status)
      : null;
    const incomingIdentity = req.body && Object.prototype.hasOwnProperty.call(req.body, "identity_status")
      ? cleanIdentityStatus(req.body.identity_status)
      : null;
    const incomingNotes = req.body && Object.prototype.hasOwnProperty.call(req.body, "verification_notes")
      ? String(req.body.verification_notes || "").trim().slice(0, 4000)
      : null;

    if (incomingVerification === "" || incomingLicense === "" || incomingInsurance === "" || incomingIdentity === "") {
      return res.status(400).json({ error: "Invalid verification field value" });
    }

    const updates = [];
    const params = [];
    if (incomingVerification !== null) {
      params.push(incomingVerification);
      updates.push(`verification_status = $${params.length}`);
      if (incomingVerification === "verified") {
        updates.push("verified_at = CURRENT_TIMESTAMP");
        params.push(req.user.id);
        updates.push(`verified_by = $${params.length}`);
        updates.push("is_verified = TRUE");
      } else {
        updates.push("verified_at = NULL");
        updates.push("verified_by = NULL");
        updates.push("is_verified = FALSE");
      }
    }
    if (incomingLicense !== null) {
      params.push(incomingLicense);
      updates.push(`license_status = $${params.length}`);
    }
    if (incomingInsurance !== null) {
      params.push(incomingInsurance);
      updates.push(`insurance_status = $${params.length}`);
    }
    if (incomingIdentity !== null) {
      params.push(incomingIdentity);
      updates.push(`identity_status = $${params.length}`);
    }
    if (incomingNotes !== null) {
      params.push(incomingNotes || null);
      updates.push(`verification_notes = $${params.length}`);
    }

    if (!updates.length) {
      return res.status(400).json({ error: "No verification fields provided" });
    }

    params.push(companyId);
    const result = await pool.query(
      `
      UPDATE companies
      SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${params.length}
      RETURNING
        id,
        name,
        email,
        phone,
        verification_status,
        verified_at,
        verified_by,
        verification_notes,
        license_status,
        insurance_status,
        identity_status
      `,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }
    if (incomingVerification === "verified") {
      try {
        await notifyVerificationApproved({ companyId });
      } catch (_) {}
      try {
        await refreshCompanyReputation(companyId);
      } catch (_) {}
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM VERIFICATION COMPANY UPDATE ERROR");
  }
});

router.get("/platform/referrals", platformOnly, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const summary = await referralEngineService.getPlatformReferralSummary();
    const referrals = await referralEngineService.listPlatformReferrals({ limit, offset });
    res.json({
      summary,
      referrals,
      limit,
      offset
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM REFERRALS ERROR");
  }
});

router.put("/platform/referrals/:id/status", platformOnly, async (req, res) => {
  try {
    const referralId = Number(req.params.id);
    if (!Number.isInteger(referralId) || referralId <= 0) {
      return res.status(400).json({ error: "Invalid referral id" });
    }

    const status = req.body && req.body.status;
    const qualificationEvent = req.body && req.body.qualification_event;
    const reward = req.body && req.body.reward;

    const row = await referralEngineService.updateReferralStatusByPlatform({
      referralId,
      status,
      qualificationEvent,
      rewardPayload: reward,
      actorUserId: req.user && req.user.id
    });

    res.json(row);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "";
    if (msg.includes("not found") || msg.includes("Invalid")) {
      return res.status(400).json({ error: msg });
    }
    sendSafeServerError(res, err, "PLATFORM REFERRAL STATUS ERROR");
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { requirePlatformOwner } = auth;
const { NODE_ENV, ALLOW_MAINTENANCE_ROUTES, ALLOWED_ORIGINS } = require("../config/env");
const { getQueueStatus } = require("../services/jobQueue");
const { getSchedulerStatus } = require("../services/schedulerService");
const { getUsageForCompany, getBillingWarnings } = require("../services/billingService");
const { suspendCompanyByPlatform, unsuspendCompanyByPlatform } = require("../services/platformControlService");
const { createNotification, ensureNotificationsSchema } = require("../services/notificationService");
const activityLogService = require("../services/activityLogService");
const { listRecentErrorLogs } = require("../services/errorLogService");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();
const platformOnly = [auth, requirePlatformOwner];

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
        COALESCE(users_counts.count, 0)::int AS users_count,
        COALESCE(clients_counts.count, 0)::int AS clients_count,
        COALESCE(jobs_counts.count, 0)::int AS jobs_count,
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
        FROM jobs
        GROUP BY company_id
      ) jobs_counts ON jobs_counts.company_id = companies.id
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
    `);

    const rows = [];

    for (const row of result.rows) {
      const usage = await getUsageForCompany(row.id);
      const warnings = await getBillingWarnings(row.id);

      rows.push({
        ...row,
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

router.get("/platform/health", platformOnly, async (req, res) => {
  try {
    const database = await one("SELECT NOW() AS checked_at");

    res.json({
      app: {
        status: "ok",
        name: "LoneGreen SaaS",
        env: NODE_ENV,
        checked_at: new Date().toISOString()
      },
      database: {
        status: database.checked_at ? "ok" : "unknown",
        checked_at: database.checked_at || null
      },
      queue: getQueueStatus(),
      scheduler: getSchedulerStatus(),
      uploads: {
        status: "configured",
        storage: "local"
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM HEALTH ERROR");
  }
});

router.get("/platform/activity", platformOnly, async (req, res) => {
  try {
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
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM ACTIVITY ERROR");
  }
});

router.get("/platform/users", platformOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, role, active, company_id
      FROM users
      WHERE role = 'platform_owner'
      ORDER BY id ASC
    `);

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

module.exports = router;

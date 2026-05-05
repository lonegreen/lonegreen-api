const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { requireMinimumRole, normalizeRole } = auth;
const {
  warnDeprecatedRoute,
  parseIntSafe,
  normalizeDateOnly,
  parseDateOnly,
  formatDateOnly,
  addFrequency,
  buildSubscriptionVisitDates,
  buildUpcomingSubscriptionDates,
  normalizeJobStatus,
  normalizeJobPaymentStatus,
  normalizePaymentStatus,
  getSuggestedWorker,
  safeJsonParse,
  normalizePaymentMethod,
  normalizeInvoiceStatus,
  nextInvoiceNumber,
  normalizeLineItems,
  recalculateInvoiceFinancials,
  hydrateInvoice,
  syncFinancialAlerts,
  ensureActivityLogSchema,
  logActivity,
  ensureNotificationsSchema,
  createNotification,
  ensureUniqueNotification,
  createNotificationIfMissing,
  syncAlerts,
  ensureEstimateSchema,
  ensureJobPhotoSchema,
  ensureSubscriptionBillingSchema,
  ensureClientLifecycleSchema,
  ensureWorkflowSchema,
  ensureOperationsSchema,
  normalizeLeadStatus,
  normalizeEstimateStatus,
  nextMonthDateString,
  getClientById,
  createClientFromContact,
  getLead,
  getEstimate,
  formatTimelineItem
} = require("../services/routeHelpers");

const router = express.Router();

/* ================= CALENDAR / DASHBOARD / MONEY ================= */

async function fetchCalendarJobs(req, res) {
  try {
    const company_id = req.user.company_id;

    const result = await pool.query(`
      SELECT
        jobs.*,
        clients.name AS client_name,
        workers.name AS worker_name
      FROM jobs
      LEFT JOIN clients ON jobs.client_id = clients.id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON jobs.worker_id = workers.id AND workers.company_id = jobs.company_id
      WHERE jobs.company_id = $1
      ORDER BY jobs.date ASC, jobs.start_time ASC
    `, [company_id]);

    res.json(result.rows);
  } catch (err) {
    console.log("CALENDAR ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}

router.get("/calendar", auth, requireMinimumRole("manager"), fetchCalendarJobs);

router.get("/dashboard", auth, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/dashboard", "legacy summary route");
    const company_id = req.user.company_id;

    const today = await pool.query(`
      SELECT COUNT(*) FROM jobs
      WHERE date = CURRENT_DATE AND company_id = $1
    `, [company_id]);

    const week = await pool.query(`
      SELECT COUNT(*) FROM jobs
      WHERE date >= CURRENT_DATE - INTERVAL '7 days'
        AND company_id = $1
    `, [company_id]);

    const completed = await pool.query(`
      SELECT COUNT(*) FROM jobs
      WHERE status = 'completed' AND company_id = $1
    `, [company_id]);

    const openJobs = await pool.query(`
      SELECT COUNT(*) FROM jobs
      WHERE status IN ('scheduled', 'confirmed', 'assigned', 'en_route', 'arrived', 'in_progress', 'rescheduled')
        AND company_id = $1
    `, [company_id]);

    res.json({
      today: parseIntSafe(today.rows[0].count),
      week: parseIntSafe(week.rows[0].count),
      done: parseIntSafe(completed.rows[0].count),
      pending: parseIntSafe(openJobs.rows[0].count)
    });
  } catch (err) {
    console.log("DASHBOARD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/money", auth, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/money", "legacy revenue route");
    await ensureSubscriptionBillingSchema();
    await syncFinancialAlerts(req.user.company_id);
    const company_id = req.user.company_id;

    const [
      paymentsToday,
      paymentsWeek,
      paymentsTotal,
      revenueMonth,
      unpaidAmount,
      overdueAmount,
      paidInvoicesMonth,
      subscriptions,
      monthlyReports
    ] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(amount),0)::numeric AS total
        FROM payments
        WHERE company_id = $1
          AND date = CURRENT_DATE
      `, [company_id]),
      pool.query(`
        SELECT COALESCE(SUM(amount),0)::numeric AS total
        FROM payments
        WHERE company_id = $1
          AND date >= date_trunc('week', CURRENT_DATE)::date
      `, [company_id]),
      pool.query(`
        SELECT COALESCE(SUM(amount),0)::numeric AS total
        FROM payments
        WHERE company_id = $1
      `, [company_id]),
      pool.query(`
        SELECT COALESCE(SUM(amount),0)::numeric AS total
        FROM payments
        WHERE company_id = $1
          AND date >= date_trunc('month', CURRENT_DATE)::date
          AND date < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
      `, [company_id]),
      pool.query(`
        SELECT COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payment_totals.paid_amount, 0), 0)),0)::numeric AS total
        FROM invoices
        LEFT JOIN (
          SELECT invoice_id, company_id, COALESCE(SUM(amount),0)::numeric AS paid_amount
          FROM payments
          GROUP BY invoice_id, company_id
        ) payment_totals
          ON payment_totals.invoice_id = invoices.id
         AND payment_totals.company_id = invoices.company_id
        WHERE invoices.company_id = $1
          AND invoices.status IN ('unpaid', 'overdue')
      `, [company_id]),
      pool.query(`
        SELECT COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payment_totals.paid_amount, 0), 0)),0)::numeric AS total
        FROM invoices
        LEFT JOIN (
          SELECT invoice_id, company_id, COALESCE(SUM(amount),0)::numeric AS paid_amount
          FROM payments
          GROUP BY invoice_id, company_id
        ) payment_totals
          ON payment_totals.invoice_id = invoices.id
         AND payment_totals.company_id = invoices.company_id
        WHERE invoices.company_id = $1
          AND invoices.status = 'overdue'
      `, [company_id]),
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM invoices
        WHERE company_id = $1
          AND status = 'paid'
          AND paid_at >= date_trunc('month', CURRENT_DATE)
          AND paid_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      `, [company_id]),
      pool.query(`
        SELECT COALESCE(SUM(price),0)::numeric AS mrr
        FROM subscriptions
        WHERE company_id = $1
          AND status = 'active'
      `, [company_id]),
      pool.query(`
        SELECT
          to_char(date_trunc('month', payments.date), 'YYYY-MM') AS month,
          COALESCE(SUM(payments.amount),0)::numeric AS total_revenue,
          COALESCE(SUM(CASE WHEN COALESCE(invoices.source_type, 'job') = 'subscription' THEN payments.amount ELSE 0 END),0)::numeric AS subscription_revenue,
          COALESCE(SUM(CASE WHEN COALESCE(invoices.source_type, 'job') <> 'subscription' THEN payments.amount ELSE 0 END),0)::numeric AS job_revenue,
          COUNT(DISTINCT CASE WHEN invoices.status = 'paid' THEN invoices.id END)::int AS paid_invoices
        FROM payments
        LEFT JOIN invoices ON invoices.id = payments.invoice_id AND invoices.company_id = payments.company_id
        WHERE payments.company_id = $1
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 12
      `, [company_id])
    ]);

    res.json({
      today: parseFloat(paymentsToday.rows[0].total || 0),
      week: parseFloat(paymentsWeek.rows[0].total || 0),
      total: parseFloat(paymentsTotal.rows[0].total || 0),
      total_revenue_month: parseFloat(revenueMonth.rows[0].total || 0),
      monthly_subscription_revenue: parseFloat(subscriptions.rows[0].mrr || 0),
      mrr: parseFloat(subscriptions.rows[0].mrr || 0),
      unpaid_revenue_month: parseFloat(unpaidAmount.rows[0].total || 0),
      unpaid_amount: parseFloat(unpaidAmount.rows[0].total || 0),
      overdue_amount: parseFloat(overdueAmount.rows[0].total || 0),
      paid_invoices_count: parseIntSafe(paidInvoicesMonth.rows[0].total),
      monthly_reports: monthlyReports.rows.map(row => ({
        month: row.month,
        total_revenue: parseFloat(row.total_revenue || 0),
        subscription_revenue: parseFloat(row.subscription_revenue || 0),
        job_revenue: parseFloat(row.job_revenue || 0),
        paid_invoices: parseIntSafe(row.paid_invoices)
      }))
    });
  } catch (err) {
    console.log("MONEY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


router.get("/ops/calendar", auth, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    await syncAlerts(req.user.company_id);
    const workerFilter = req.query.worker_id ? Number(req.query.worker_id) : null;

    const result = await pool.query(`
      SELECT
        jobs.*,
        clients.name AS client_name,
        clients.address AS client_address,
        clients.zip AS client_zip,
        workers.name AS worker_name
      FROM jobs
      LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON workers.id = jobs.worker_id AND workers.company_id = jobs.company_id
      WHERE jobs.company_id = $1
        AND ($2::int IS NULL OR jobs.worker_id = $2)
      ORDER BY jobs.date ASC, jobs.start_time ASC, jobs.id ASC
    `, [req.user.company_id, workerFilter]);

    const grouped = result.rows.reduce((acc, job) => {
      const key = normalizeDateOnly(job.date);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push({ ...job, status: normalizeJobStatus(job.status) });
      return acc;
    }, {});

    res.json({ jobs: result.rows.map(job => ({ ...job, status: normalizeJobStatus(job.status) })), grouped_by_date: grouped });
  } catch (err) {
    console.log("OPS CALENDAR ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/operations/calendar", auth, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/operations/calendar", "/ops/calendar");
    await ensureOperationsSchema();
    await syncAlerts(req.user.company_id);
    const workerFilter = req.query.worker_id ? Number(req.query.worker_id) : null;

    const result = await pool.query(`
      SELECT
        jobs.*,
        clients.name AS client_name,
        clients.address AS client_address,
        clients.zip AS client_zip,
        workers.name AS worker_name
      FROM jobs
      LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON workers.id = jobs.worker_id AND workers.company_id = jobs.company_id
      WHERE jobs.company_id = $1
        AND ($2::int IS NULL OR jobs.worker_id = $2)
      ORDER BY jobs.date ASC, jobs.start_time ASC, jobs.id ASC
    `, [req.user.company_id, workerFilter]);

    const grouped = result.rows.reduce((acc, job) => {
      const key = normalizeDateOnly(job.date);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push({ ...job, status: normalizeJobStatus(job.status) });
      return acc;
    }, {});

    res.json({ jobs: result.rows.map(job => ({ ...job, status: normalizeJobStatus(job.status) })), grouped_by_date: grouped });
  } catch (err) {
    console.log("OPS CALENDAR ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;

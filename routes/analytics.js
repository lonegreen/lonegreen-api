const express = require("express");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { logActivity } = require("../services/routeHelpers");
const { requireMinimumRole } = auth;

const router = express.Router();
const ownerAdmin = [auth, requireMinimumRole("admin")];

function num(value) {
  return Number(value || 0);
}

async function one(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || {};
}

router.get("/analytics/overview", ownerAdmin, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const [clients, activeSubscriptions, openInvoices, overdueInvoices, jobsToday, jobsWeek] = await Promise.all([
      one("SELECT COUNT(*)::int AS count FROM clients WHERE company_id=$1 AND COALESCE(archived, FALSE)=FALSE", [companyId]),
      one("SELECT COUNT(*)::int AS count FROM subscriptions WHERE company_id=$1 AND status='active'", [companyId]),
      one("SELECT COUNT(*)::int AS count FROM invoices WHERE company_id=$1 AND status IN ('draft','unpaid','overdue')", [companyId]),
      one("SELECT COUNT(*)::int AS count FROM invoices WHERE company_id=$1 AND (status='overdue' OR (status IN ('draft','unpaid') AND due_date < CURRENT_DATE))", [companyId]),
      one("SELECT COUNT(*)::int AS count FROM jobs WHERE company_id=$1 AND date=CURRENT_DATE", [companyId]),
      one("SELECT COUNT(*)::int AS count FROM jobs WHERE company_id=$1 AND date >= date_trunc('week', CURRENT_DATE)::date AND date < (date_trunc('week', CURRENT_DATE)::date + INTERVAL '7 days')", [companyId])
    ]);

    res.json({
      total_clients: num(clients.count),
      active_subscriptions: num(activeSubscriptions.count),
      open_invoices: num(openInvoices.count),
      overdue_invoices: num(overdueInvoices.count),
      jobs_today: num(jobsToday.count),
      jobs_this_week: num(jobsWeek.count)
    });
  } catch (err) {
    console.log("ANALYTICS OVERVIEW ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/revenue", ownerAdmin, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const [totalRevenue, unpaid, monthly, invoiceTotals, paymentTotals] = await Promise.all([
      one("SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM payments WHERE company_id=$1", [companyId]),
      one(`
        SELECT COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payments.total_paid, 0), 0)),0)::numeric AS amount
        FROM invoices
        LEFT JOIN (
          SELECT invoice_id, company_id, SUM(amount)::numeric AS total_paid
          FROM payments
          WHERE company_id=$1
          GROUP BY invoice_id, company_id
        ) payments ON payments.invoice_id=invoices.id AND payments.company_id=invoices.company_id
        WHERE invoices.company_id=$1
          AND invoices.status IN ('draft','unpaid','overdue')
      `, [companyId]),
      pool.query(`
        SELECT month, revenue
        FROM (
          SELECT
            to_char(date_trunc('month', payments.date), 'YYYY-MM') AS month,
            date_trunc('month', payments.date) AS month_start,
            COALESCE(SUM(payments.amount),0)::numeric AS revenue
          FROM payments
          WHERE payments.company_id=$1
          GROUP BY date_trunc('month', payments.date)
          ORDER BY month_start DESC
          LIMIT 12
        ) recent_months
        ORDER BY month_start ASC
      `, [companyId]),
      pool.query(`
        SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS amount
        FROM invoices
        WHERE company_id=$1
        GROUP BY status
        ORDER BY status ASC
      `, [companyId]),
      pool.query(`
        SELECT method, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS amount
        FROM payments
        WHERE company_id=$1
        GROUP BY method
        ORDER BY method ASC
      `, [companyId])
    ]);

    res.json({
      total_revenue: num(totalRevenue.amount),
      unpaid_amount: num(unpaid.amount),
      monthly_revenue: monthly.rows.map(row => ({ month: row.month, revenue: num(row.revenue) })),
      invoice_totals: invoiceTotals.rows.map(row => ({ status: row.status || "draft", count: num(row.count), amount: num(row.amount) })),
      payment_totals: paymentTotals.rows.map(row => ({ method: row.method || "unknown", count: num(row.count), amount: num(row.amount) }))
    });
  } catch (err) {
    console.log("ANALYTICS REVENUE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/workers", ownerAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        workers.id,
        workers.name,
        workers.phone,
        COALESCE(COUNT(jobs.id),0)::int AS jobs_assigned,
        COALESCE(COUNT(jobs.id) FILTER (WHERE jobs.status='completed'),0)::int AS jobs_completed
      FROM workers
      LEFT JOIN jobs ON jobs.worker_id=workers.id AND jobs.company_id=workers.company_id
      WHERE workers.company_id=$1
      GROUP BY workers.id, workers.name, workers.phone
      ORDER BY workers.name ASC, workers.id ASC
    `, [req.user.company_id]);

    res.json(result.rows.map(row => {
      const assigned = num(row.jobs_assigned);
      const completed = num(row.jobs_completed);
      return {
        id: row.id,
        name: row.name,
        phone: row.phone,
        jobs_assigned: assigned,
        jobs_completed: completed,
        completion_rate: assigned ? Math.round((completed / assigned) * 1000) / 10 : 0
      };
    }));
  } catch (err) {
    console.log("ANALYTICS WORKERS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/clients", ownerAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        clients.id,
        clients.name,
        clients.phone,
        clients.address,
        COALESCE(COUNT(DISTINCT jobs.id),0)::int AS total_jobs,
        COALESCE(COUNT(DISTINCT subscriptions.id) FILTER (WHERE subscriptions.status='active'),0)::int AS active_subscriptions,
        MAX(jobs.date) AS last_service_date,
        COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payment_totals.total_paid, 0), 0)) FILTER (WHERE invoices.status IN ('draft','unpaid','overdue')),0)::numeric AS unpaid_balance
      FROM clients
      LEFT JOIN jobs ON jobs.client_id=clients.id AND jobs.company_id=clients.company_id
      LEFT JOIN subscriptions ON subscriptions.client_id=clients.id AND subscriptions.company_id=clients.company_id
      LEFT JOIN invoices ON invoices.client_id=clients.id AND invoices.company_id=clients.company_id
      LEFT JOIN (
        SELECT invoice_id, company_id, SUM(amount)::numeric AS total_paid
        FROM payments
        WHERE company_id=$1
        GROUP BY invoice_id, company_id
      ) payment_totals ON payment_totals.invoice_id=invoices.id AND payment_totals.company_id=invoices.company_id
      WHERE clients.company_id=$1 AND COALESCE(clients.archived, FALSE)=FALSE
      GROUP BY clients.id, clients.name, clients.phone, clients.address
      ORDER BY unpaid_balance DESC, total_jobs DESC, clients.name ASC
    `, [req.user.company_id]);

    res.json(result.rows.map(row => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      address: row.address,
      total_jobs: num(row.total_jobs),
      active_subscriptions: num(row.active_subscriptions),
      unpaid_balance: num(row.unpaid_balance),
      last_service_date: row.last_service_date
    })));
  } catch (err) {
    console.log("ANALYTICS CLIENTS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/analytics/pro", ownerAdmin, async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const [
      revenue,
      jobs,
      clients,
      subscriptions,
      workers,
      topWorkers,
      monthlyRevenue,
      monthlyJobs,
      monthlyNewClients,
      alerts
    ] = await Promise.all([
      one(`
        WITH payment_totals AS (
          SELECT invoice_id, company_id, COALESCE(SUM(amount), 0)::numeric AS paid_amount
          FROM payments
          WHERE company_id = $1
          GROUP BY invoice_id, company_id
        )
        SELECT
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1), 0)::numeric AS total_collected,
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1 AND date >= date_trunc('month', CURRENT_DATE)::date), 0)::numeric AS this_month_collected,
          COALESCE((
            SELECT SUM(amount)
            FROM payments
            WHERE company_id = $1
              AND date >= (date_trunc('month', CURRENT_DATE)::date - INTERVAL '1 month')
              AND date < date_trunc('month', CURRENT_DATE)::date
          ), 0)::numeric AS last_month_collected,
          COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payment_totals.paid_amount, 0), 0)) FILTER (WHERE invoices.status IN ('draft','unpaid','overdue')), 0)::numeric AS unpaid_total,
          COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payment_totals.paid_amount, 0), 0)) FILTER (WHERE invoices.status = 'overdue' OR (invoices.status IN ('draft','unpaid') AND invoices.due_date < CURRENT_DATE)), 0)::numeric AS overdue_total,
          COALESCE(AVG(invoices.amount), 0)::numeric AS average_invoice_value
        FROM invoices
        LEFT JOIN payment_totals ON payment_totals.invoice_id = invoices.id AND payment_totals.company_id = invoices.company_id
        WHERE invoices.company_id = $1
      `, [companyId]),
      one(`
        SELECT
          COUNT(*)::int AS total_jobs,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
          COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled_jobs,
          COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_jobs,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_jobs,
          COUNT(*) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)::date)::int AS jobs_this_month,
          COUNT(*) FILTER (
            WHERE date >= (date_trunc('month', CURRENT_DATE)::date - INTERVAL '1 month')
              AND date < date_trunc('month', CURRENT_DATE)::date
          )::int AS jobs_last_month
        FROM jobs
        WHERE company_id = $1
      `, [companyId]),
      one(`
        SELECT
          COUNT(DISTINCT clients.id)::int AS total_clients,
          COUNT(DISTINCT clients.id) FILTER (WHERE COALESCE(clients.archived, FALSE) = FALSE)::int AS active_clients,
          COUNT(DISTINCT clients.id) FILTER (WHERE COALESCE(clients.archived, FALSE) = TRUE)::int AS archived_clients,
          COUNT(DISTINCT clients.id) FILTER (WHERE clients.created_at >= date_trunc('month', CURRENT_DATE))::int AS new_clients_this_month,
          COUNT(DISTINCT clients.id) FILTER (WHERE subscriptions.status = 'active')::int AS clients_with_active_subscriptions
        FROM clients
        LEFT JOIN subscriptions ON subscriptions.client_id = clients.id AND subscriptions.company_id = clients.company_id
        WHERE clients.company_id = $1
      `, [companyId]),
      one(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_subscriptions,
          COUNT(*) FILTER (WHERE status = 'paused')::int AS paused_subscriptions,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_subscriptions,
          COALESCE(SUM(
            CASE
              WHEN status <> 'active' THEN 0
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('weekly', 'week') THEN price * 4.33
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('biweekly', 'bi-weekly', 'every_two_weeks') THEN price * 2.165
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('quarterly', 'quarter') THEN price / 3
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('yearly', 'annual', 'annually') THEN price / 12
              ELSE price
            END
          ), 0)::numeric AS estimated_mrr
        FROM subscriptions
        WHERE company_id = $1
      `, [companyId]),
      one(`
        SELECT
          COUNT(*)::int AS total_workers,
          COUNT(*) FILTER (WHERE COALESCE(active, TRUE) = TRUE)::int AS active_workers
        FROM workers
        WHERE company_id = $1
      `, [companyId]),
      pool.query(`
        SELECT
          workers.id AS worker_id,
          workers.name AS worker_name,
          COUNT(jobs.id) FILTER (WHERE jobs.status = 'completed')::int AS completed_jobs
        FROM workers
        LEFT JOIN jobs ON jobs.worker_id = workers.id AND jobs.company_id = workers.company_id
        WHERE workers.company_id = $1
        GROUP BY workers.id, workers.name
        ORDER BY completed_jobs DESC, workers.name ASC
        LIMIT 5
      `, [companyId]),
      pool.query(`
        SELECT to_char(months.month, 'YYYY-MM') AS month,
               COALESCE(SUM(payments.amount), 0)::numeric AS revenue
        FROM generate_series(
          date_trunc('month', CURRENT_DATE)::date - INTERVAL '11 months',
          date_trunc('month', CURRENT_DATE)::date,
          INTERVAL '1 month'
        ) AS months(month)
        LEFT JOIN payments ON payments.company_id = $1
          AND payments.date >= months.month
          AND payments.date < months.month + INTERVAL '1 month'
        GROUP BY months.month
        ORDER BY months.month ASC
      `, [companyId]),
      pool.query(`
        SELECT to_char(months.month, 'YYYY-MM') AS month,
               COUNT(jobs.id)::int AS jobs
        FROM generate_series(
          date_trunc('month', CURRENT_DATE)::date - INTERVAL '11 months',
          date_trunc('month', CURRENT_DATE)::date,
          INTERVAL '1 month'
        ) AS months(month)
        LEFT JOIN jobs ON jobs.company_id = $1
          AND jobs.date >= months.month
          AND jobs.date < months.month + INTERVAL '1 month'
        GROUP BY months.month
        ORDER BY months.month ASC
      `, [companyId]),
      pool.query(`
        SELECT to_char(months.month, 'YYYY-MM') AS month,
               COUNT(clients.id)::int AS clients
        FROM generate_series(
          date_trunc('month', CURRENT_DATE)::date - INTERVAL '11 months',
          date_trunc('month', CURRENT_DATE)::date,
          INTERVAL '1 month'
        ) AS months(month)
        LEFT JOIN clients ON clients.company_id = $1
          AND clients.created_at >= months.month
          AND clients.created_at < months.month + INTERVAL '1 month'
        GROUP BY months.month
        ORDER BY months.month ASC
      `, [companyId]),
      one(`
        SELECT
          (SELECT COUNT(*) FROM jobs WHERE company_id = $1 AND worker_id IS NULL AND status IN ('scheduled','assigned'))::int AS unassigned_jobs,
          (SELECT COUNT(*) FROM jobs WHERE company_id = $1 AND date < CURRENT_DATE AND status IN ('scheduled','assigned','in_progress'))::int AS overdue_jobs,
          (SELECT COUNT(*) FROM invoices WHERE company_id = $1 AND status IN ('draft','unpaid','overdue'))::int AS unpaid_invoices,
          (SELECT COUNT(*) FROM invoices WHERE company_id = $1 AND (status = 'overdue' OR (status IN ('draft','unpaid') AND due_date < CURRENT_DATE)))::int AS overdue_invoices
      `, [companyId])
    ]);

    const totalJobs = num(jobs.total_jobs);
    const completedJobs = num(jobs.completed_jobs);
    const estimatedMrr = num(subscriptions.estimated_mrr);

    await logActivity({
      companyId,
      userId: req.user.id,
      action: "analytics_pro_viewed",
      entityType: "analytics",
      entityId: null,
      details: { section: "pro" }
    });

    res.json({
      revenue: {
        total_collected: num(revenue.total_collected),
        this_month_collected: num(revenue.this_month_collected),
        last_month_collected: num(revenue.last_month_collected),
        unpaid_total: num(revenue.unpaid_total),
        overdue_total: num(revenue.overdue_total),
        average_invoice_value: num(revenue.average_invoice_value)
      },
      jobs: {
        total_jobs: totalJobs,
        completed_jobs: completedJobs,
        scheduled_jobs: num(jobs.scheduled_jobs),
        in_progress_jobs: num(jobs.in_progress_jobs),
        cancelled_jobs: num(jobs.cancelled_jobs),
        completion_rate: totalJobs ? Math.round((completedJobs / totalJobs) * 1000) / 10 : 0,
        jobs_this_month: num(jobs.jobs_this_month),
        jobs_last_month: num(jobs.jobs_last_month)
      },
      clients: {
        total_clients: num(clients.total_clients),
        active_clients: num(clients.active_clients),
        archived_clients: num(clients.archived_clients),
        new_clients_this_month: num(clients.new_clients_this_month),
        clients_with_active_subscriptions: num(clients.clients_with_active_subscriptions)
      },
      subscriptions: {
        active_subscriptions: num(subscriptions.active_subscriptions),
        paused_subscriptions: num(subscriptions.paused_subscriptions),
        cancelled_subscriptions: num(subscriptions.cancelled_subscriptions),
        estimated_mrr: estimatedMrr,
        estimated_arr: estimatedMrr * 12
      },
      workers: {
        total_workers: num(workers.total_workers),
        active_workers: num(workers.active_workers),
        top_workers_by_completed_jobs: topWorkers.rows.map(row => ({
          worker_id: row.worker_id,
          worker_name: row.worker_name || "Worker",
          completed_jobs: num(row.completed_jobs)
        }))
      },
      trends: {
        monthly_revenue: monthlyRevenue.rows.map(row => ({ month: row.month, revenue: num(row.revenue) })),
        monthly_jobs: monthlyJobs.rows.map(row => ({ month: row.month, jobs: num(row.jobs) })),
        monthly_new_clients: monthlyNewClients.rows.map(row => ({ month: row.month, clients: num(row.clients) }))
      },
      alerts: {
        unassigned_jobs: num(alerts.unassigned_jobs),
        overdue_jobs: num(alerts.overdue_jobs),
        unpaid_invoices: num(alerts.unpaid_invoices),
        overdue_invoices: num(alerts.overdue_invoices)
      }
    });
  } catch (err) {
    console.log("ANALYTICS PRO ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { logActivity } = require("../services/routeHelpers");
const { sendSafeServerError } = require("../services/safeServerError");
const { requireMinimumRole } = auth;

const router = express.Router();
const ownerAdmin = [auth, requireMinimumRole("admin")];
const growthFoundationAccess = [auth, requireMinimumRole("manager")];

const growthFoundationService = require("../services/growthFoundationService");
const trustReputationService = require("../services/trustReputationService");
const growthOsService = require("../services/growthOsService");
const customerRetentionService = require("../services/customerRetentionService");

function num(value) {
  return Number(value || 0);
}

/** Normalize pg-style { rows } results; avoids crashes if a query handle is missing. */
function ensureQueryResult(result, queryLabel) {
  if (result && typeof result === "object" && Array.isArray(result.rows)) {
    return result;
  }
  const reason =
    result === undefined ? "undefined_result" :
      result === null ? "null_result" :
        typeof result !== "object" ? "non_object_result" :
          !Array.isArray(result.rows) ? "missing_or_invalid_rows" :
            "unknown";
  console.log(JSON.stringify({
    level: "warn",
    event: "analytics_query_fallback",
    query: queryLabel,
    reason
  }));
  return { rows: [] };
}

async function one(sql, params) {
  const result = await pool.query(sql, params);
  const safe = ensureQueryResult(result, "analytics_one");
  return safe.rows[0] || {};
}

/** Lifetime net collected: payments minus refunds (read-model). Falls back if refunds table missing. */
async function netCollectedLifetime(companyId) {
  try {
    return await one(`
      SELECT (
        COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1), 0)
        - COALESCE((SELECT SUM(amount) FROM refunds WHERE company_id = $1), 0)
      )::numeric AS amount
    `, [companyId]);
  } catch (err) {
    if (err && err.code === "42P01") {
      return one("SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM payments WHERE company_id=$1", [companyId]);
    }
    throw err;
  }
}

/** Remaining balance on non-paid statuses: invoice amount minus net paid (payments minus refunds per invoice). */
async function unpaidAmountOpenStatuses(companyId) {
  try {
    return await one(`
      WITH net AS (
        SELECT
          i.id,
          i.amount::numeric AS amount,
          i.status,
          COALESCE((
            SELECT SUM(p.amount)::numeric FROM payments p
            WHERE p.invoice_id = i.id AND p.company_id = i.company_id
          ), 0)
          - COALESCE((
            SELECT SUM(r.amount)::numeric FROM refunds r
            WHERE r.invoice_id = i.id AND r.company_id = i.company_id
          ), 0) AS net_paid
        FROM invoices i
        WHERE i.company_id = $1
      )
      SELECT COALESCE(SUM(GREATEST(amount - net_paid, 0)), 0)::numeric AS amount
      FROM net
      WHERE status IN ('draft','unpaid','overdue')
    `, [companyId]);
  } catch (err) {
    if (err && err.code === "42P01") {
      return one(`
        SELECT COALESCE(SUM(GREATEST(invoices.amount - COALESCE(payments.total_paid, 0), 0)), 0)::numeric AS amount
        FROM invoices
        LEFT JOIN (
          SELECT invoice_id, company_id, SUM(amount)::numeric AS total_paid
          FROM payments
          WHERE company_id=$1
          GROUP BY invoice_id, company_id
        ) payments ON payments.invoice_id=invoices.id AND payments.company_id=invoices.company_id
        WHERE invoices.company_id=$1
          AND invoices.status IN ('draft','unpaid','overdue')
      `, [companyId]);
    }
    throw err;
  }
}

/** Rolling 12 calendar months of net revenue (payments in month minus refunds issued in month). */
async function monthlyNetRevenueSeries(companyId) {
  try {
    const result = await pool.query(`
      SELECT
        to_char(gs.month_bucket, 'YYYY-MM') AS month,
        (COALESCE(pay.pay_amt, 0)::numeric - COALESCE(ref.ref_amt, 0)::numeric) AS revenue
      FROM generate_series(
        date_trunc('month', CURRENT_TIMESTAMP::timestamp with time zone) - interval '11 months',
        date_trunc('month', CURRENT_TIMESTAMP::timestamp with time zone),
        interval '1 month'
      ) AS gs(month_bucket)
      LEFT JOIN (
        SELECT date_trunc('month', date::timestamp with time zone) AS mb, SUM(amount)::numeric AS pay_amt
        FROM payments
        WHERE company_id = $1
        GROUP BY 1
      ) pay ON pay.mb = gs.month_bucket
      LEFT JOIN (
        SELECT date_trunc('month', created_at) AS mb, SUM(amount)::numeric AS ref_amt
        FROM refunds
        WHERE company_id = $1
        GROUP BY 1
      ) ref ON ref.mb = gs.month_bucket
      ORDER BY gs.month_bucket ASC
    `, [companyId]);
    return ensureQueryResult(result, "monthlyNetRevenueSeries");
  } catch (err) {
    if (err && err.code === "42P01") {
      const fallback = await pool.query(`
        SELECT
          to_char(gs.month_bucket, 'YYYY-MM') AS month,
          COALESCE(pay.pay_amt, 0)::numeric AS revenue
        FROM generate_series(
          date_trunc('month', CURRENT_TIMESTAMP::timestamp with time zone) - interval '11 months',
          date_trunc('month', CURRENT_TIMESTAMP::timestamp with time zone),
          interval '1 month'
        ) AS gs(month_bucket)
        LEFT JOIN (
          SELECT date_trunc('month', date::timestamp with time zone) AS mb, SUM(amount)::numeric AS pay_amt
          FROM payments
          WHERE company_id = $1
          GROUP BY 1
        ) pay ON pay.mb = gs.month_bucket
        ORDER BY gs.month_bucket ASC
      `, [companyId]);
      return ensureQueryResult(fallback, "monthlyNetRevenueSeries_fallback");
    }
    throw err;
  }
}

/** Pro dashboard revenue row: net collected, net monthly slices, unpaid/overdue from net per invoice. */
async function proRevenueMetrics(companyId) {
  try {
    return await one(`
      WITH net_per_invoice AS (
        SELECT
          i.id,
          i.amount::numeric AS amount,
          i.status,
          i.due_date,
          COALESCE((
            SELECT SUM(p.amount)::numeric FROM payments p
            WHERE p.invoice_id = i.id AND p.company_id = i.company_id
          ), 0)
          - COALESCE((
            SELECT SUM(r.amount)::numeric FROM refunds r
            WHERE r.invoice_id = i.id AND r.company_id = i.company_id
          ), 0) AS net_paid
        FROM invoices i
        WHERE i.company_id = $1
      )
      SELECT
        (
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1), 0)
          - COALESCE((SELECT SUM(amount) FROM refunds WHERE company_id = $1), 0)
        )::numeric AS total_collected,
        (
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1 AND date >= date_trunc('month', CURRENT_DATE)::date), 0)
          - COALESCE((SELECT SUM(amount) FROM refunds WHERE company_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)::timestamptz), 0)
        )::numeric AS this_month_collected,
        (
          COALESCE((
            SELECT SUM(amount) FROM payments
            WHERE company_id = $1
              AND date >= (date_trunc('month', CURRENT_DATE)::date - INTERVAL '1 month')
              AND date < date_trunc('month', CURRENT_DATE)::date
          ), 0)
          - COALESCE((
            SELECT SUM(amount) FROM refunds
            WHERE company_id = $1
              AND created_at >= (date_trunc('month', CURRENT_DATE)::timestamptz - INTERVAL '1 month')
              AND created_at < date_trunc('month', CURRENT_DATE)::timestamptz
          ), 0)
        )::numeric AS last_month_collected,
        (SELECT COALESCE(SUM(GREATEST(amount - net_paid, 0)), 0) FROM net_per_invoice WHERE status IN ('draft','unpaid','overdue'))::numeric AS unpaid_total,
        (SELECT COALESCE(SUM(GREATEST(amount - net_paid, 0)), 0) FROM net_per_invoice WHERE status = 'overdue' OR (status IN ('draft','unpaid') AND due_date < CURRENT_DATE))::numeric AS overdue_total,
        (SELECT COALESCE(AVG(amount), 0) FROM invoices WHERE company_id = $1)::numeric AS average_invoice_value
    `, [companyId]);
  } catch (err) {
    if (err && err.code === "42P01") {
      return one(`
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
      `, [companyId]);
    }
    throw err;
  }
}

async function proMonthlyNetTrends(companyId) {
  try {
    const result = await pool.query(`
      SELECT
        to_char(gs.mb, 'YYYY-MM') AS month,
        (COALESCE(pay.pay_amt, 0)::numeric - COALESCE(ref.ref_amt, 0)::numeric) AS revenue
      FROM generate_series(
        date_trunc('month', CURRENT_DATE)::date - INTERVAL '11 months',
        date_trunc('month', CURRENT_DATE)::date,
        INTERVAL '1 month'
      ) AS gs(mb)
      LEFT JOIN (
        SELECT date_trunc('month', date)::date AS m, SUM(amount)::numeric AS pay_amt
        FROM payments
        WHERE company_id = $1
        GROUP BY 1
      ) pay ON pay.m = gs.mb
      LEFT JOIN (
        SELECT date_trunc('month', created_at)::date AS m, SUM(amount)::numeric AS ref_amt
        FROM refunds
        WHERE company_id = $1
        GROUP BY 1
      ) ref ON ref.m = gs.mb
      ORDER BY gs.mb ASC
    `, [companyId]);
    return ensureQueryResult(result, "proMonthlyNetTrends");
  } catch (err) {
    if (err && err.code === "42P01") {
      const fallback = await pool.query(`
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
      `, [companyId]);
      return ensureQueryResult(fallback, "proMonthlyNetTrends_fallback");
    }
    throw err;
  }
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
    sendSafeServerError(res, err, "ANALYTICS OVERVIEW ERROR");
  }
});

router.get("/analytics/revenue", ownerAdmin, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    let totalRevenue;
    let unpaid;
    let monthly;
    let invoiceTotals;
    let paymentTotals;
    let billingMetrics;
    let invoiceAlerts;
    let recentPayments;
    let recentRefunds;
    [
      totalRevenue,
      unpaid,
      monthly,
      invoiceTotals,
      paymentTotals,
      billingMetrics,
      invoiceAlerts,
      recentPayments,
      recentRefunds
    ] = await Promise.all([
      netCollectedLifetime(companyId),
      unpaidAmountOpenStatuses(companyId),
      monthlyNetRevenueSeries(companyId),
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
      `, [companyId]),
      one(`
        WITH net AS (
          SELECT
            i.id,
            i.amount::numeric AS total,
            i.status,
            i.issued_date,
            i.due_date,
            COALESCE((
              SELECT SUM(p.amount)::numeric
              FROM payments p
              WHERE p.invoice_id = i.id AND p.company_id = i.company_id
            ), 0) - COALESCE((
              SELECT SUM(r.amount)::numeric
              FROM refunds r
              WHERE r.invoice_id = i.id AND r.company_id = i.company_id
            ), 0) AS net_paid
          FROM invoices i
          WHERE i.company_id = $1
        )
        SELECT
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1 AND date >= date_trunc('month', CURRENT_DATE)::date), 0)::numeric
            - COALESCE((SELECT SUM(amount) FROM refunds WHERE company_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)::timestamptz), 0)::numeric
            AS paid_this_month,
          COALESCE((SELECT SUM(amount) FROM refunds WHERE company_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)::timestamptz), 0)::numeric
            AS refunds_this_month,
          (SELECT COUNT(*) FROM invoices WHERE company_id = $1 AND status IN ('draft','unpaid','overdue'))::int
            AS active_invoices,
          COALESCE((SELECT SUM(GREATEST(total - net_paid, 0)) FROM net WHERE status IN ('draft','unpaid','overdue')), 0)::numeric
            AS open_unpaid_balance,
          COALESCE((SELECT SUM(GREATEST(total - net_paid, 0)) FROM net WHERE status = 'overdue' OR (status IN ('draft','unpaid') AND due_date < CURRENT_DATE)), 0)::numeric
            AS open_overdue_balance,
          (SELECT COUNT(*) FROM invoices WHERE company_id = $1 AND issued_date >= date_trunc('month', CURRENT_DATE)::date)::int
            AS invoices_sent_this_month,
          (SELECT COUNT(*) FROM net WHERE net_paid >= total - 0.01 AND total >= 0 AND issued_date >= date_trunc('month', CURRENT_DATE)::date)::int
            AS invoices_paid_this_month,
          COALESCE((SELECT AVG(amount) FROM invoices WHERE company_id = $1), 0)::numeric AS average_invoice_value
      `, [companyId]),
      pool.query(`
        WITH net AS (
          SELECT
            i.id,
            i.invoice_number,
            i.status,
            i.client_id,
            i.due_date,
            i.amount::numeric AS total,
            c.name AS client_name,
            COALESCE((
              SELECT SUM(p.amount)::numeric
              FROM payments p
              WHERE p.invoice_id = i.id AND p.company_id = i.company_id
            ), 0) - COALESCE((
              SELECT SUM(r.amount)::numeric
              FROM refunds r
              WHERE r.invoice_id = i.id AND r.company_id = i.company_id
            ), 0) AS net_paid
          FROM invoices i
          LEFT JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
          WHERE i.company_id = $1
        )
        SELECT
          id,
          invoice_number,
          status,
          client_id,
          client_name,
          due_date,
          GREATEST(total - net_paid, 0)::numeric AS remaining_balance,
          CASE
            WHEN status = 'cancelled' THEN 'cancelled'
            WHEN GREATEST(total - net_paid, 0) <= 0.009 AND total >= 0 THEN 'paid'
            WHEN net_paid > 0.009 AND GREATEST(total - net_paid, 0) > 0.009 THEN 'partially_paid'
            ELSE status
          END AS display_status
        FROM net
        WHERE status <> 'cancelled'
        ORDER BY due_date ASC NULLS LAST, id DESC
      `, [companyId]),
      pool.query(`
        SELECT p.id, p.invoice_id, p.date, p.method, p.amount::numeric AS amount, i.invoice_number, c.name AS client_name
        FROM payments p
        LEFT JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
        LEFT JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
        WHERE p.company_id = $1
        ORDER BY p.id DESC
        LIMIT 10
      `, [companyId]),
      pool.query(`
        SELECT r.id, r.invoice_id, r.payment_id, r.created_at, r.amount::numeric AS amount, r.reason, i.invoice_number, c.name AS client_name
        FROM refunds r
        LEFT JOIN invoices i ON i.id = r.invoice_id AND i.company_id = r.company_id
        LEFT JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
        WHERE r.company_id = $1
        ORDER BY r.id DESC
        LIMIT 10
      `, [companyId])
    ]);

    monthly = ensureQueryResult(monthly, "monthlyNetRevenueSeries");
    invoiceTotals = ensureQueryResult(invoiceTotals, "invoice_totals");
    paymentTotals = ensureQueryResult(paymentTotals, "payment_totals");
    invoiceAlerts = ensureQueryResult(invoiceAlerts, "invoice_alerts");
    recentPayments = ensureQueryResult(recentPayments, "recent_payments");
    recentRefunds = ensureQueryResult(recentRefunds, "recent_refunds");

    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const sevenDays = new Date(today);
    sevenDays.setDate(sevenDays.getDate() + 7);
    const sevenDaysKey = sevenDays.toISOString().slice(0, 10);

    const alertsBase = invoiceAlerts.rows.map(row => ({
      id: Number(row.id),
      invoice_id: Number(row.id),
      invoice_number: row.invoice_number || `#${row.id}`,
      status: row.status || "draft",
      display_status: row.display_status || row.status || "draft",
      client_id: row.client_id ? Number(row.client_id) : null,
      client_name: row.client_name || "Client",
      due_date: row.due_date,
      remaining_balance: num(row.remaining_balance)
    }));

    const overdueInvoices = alertsBase.filter(item => {
      const due = item.due_date ? String(item.due_date).split("T")[0] : "";
      return Boolean(due) && due < todayKey && item.remaining_balance > 0.009 && item.display_status !== "paid";
    });

    const dueSoonInvoices = alertsBase.filter(item => {
      const due = item.due_date ? String(item.due_date).split("T")[0] : "";
      return Boolean(due) && due >= todayKey && due <= sevenDaysKey && item.remaining_balance > 0.009 && item.display_status !== "paid";
    });

    const partialInvoices = alertsBase.filter(item => item.display_status === "partially_paid" && item.remaining_balance > 0.009);
    const unpaidInvoices = alertsBase.filter(item => ["draft", "unpaid", "overdue"].includes(String(item.status || "").toLowerCase()) && item.remaining_balance > 0.009);

    const aging = {
      current: 0,
      overdue_1_30: 0,
      overdue_31_60: 0,
      overdue_61_plus: 0
    };
    alertsBase.forEach(item => {
      const due = item.due_date ? new Date(String(item.due_date).split("T")[0] + "T00:00:00Z") : null;
      const remaining = num(item.remaining_balance);
      if (!due || remaining <= 0.009) {
        aging.current += remaining;
        return;
      }
      const days = Math.floor((Date.parse(todayKey + "T00:00:00Z") - due.getTime()) / 86400000);
      if (days <= 0) aging.current += remaining;
      else if (days <= 30) aging.overdue_1_30 += remaining;
      else if (days <= 60) aging.overdue_31_60 += remaining;
      else aging.overdue_61_plus += remaining;
    });

    const sentThisMonth = num(billingMetrics.invoices_sent_this_month);
    const paidThisMonthCount = num(billingMetrics.invoices_paid_this_month);
    const collectionRate = sentThisMonth > 0 ? (paidThisMonthCount / sentThisMonth) * 100 : 0;

    let statusChanges = [];
    try {
      let statusRows = await pool.query(`
        SELECT created_at, details
        FROM activity_log
        WHERE company_id = $1
          AND action IN ('invoice_status_changed', 'invoice_marked_paid')
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      `, [companyId]);
      statusRows = ensureQueryResult(statusRows, "analytics_revenue_activity_log");
      statusChanges = statusRows.rows.map(row => {
        let details = {};
        try { details = JSON.parse(row.details || "{}"); } catch (_err) { details = {}; }
        return {
          type: "invoice_status",
          at: row.created_at,
          invoice_id: details.invoice_id ? Number(details.invoice_id) : null,
          invoice_number: details.invoice_number || null,
          client_name: details.client_name || null,
          before_status: details.before_status || null,
          after_status: details.after_status || null
        };
      });
    } catch (err) {
      if (!(err && err.code === "42P01")) {
        throw err;
      }
    }

    res.json({
      total_revenue: num(totalRevenue.amount),
      unpaid_amount: num(unpaid.amount),
      monthly_revenue: monthly.rows.map(row => ({ month: row.month, revenue: num(row.revenue) })),
      invoice_totals: invoiceTotals.rows.map(row => ({ status: row.status || "draft", count: num(row.count), amount: num(row.amount) })),
      payment_totals: paymentTotals.rows.map(row => ({ method: row.method || "unknown", count: num(row.count), amount: num(row.amount) })),
      billing_kpis: {
        revenue_this_month: num(monthly.rows.length ? monthly.rows[monthly.rows.length - 1].revenue : 0),
        total_collected: num(totalRevenue.amount),
        unpaid_balance: num(billingMetrics.open_unpaid_balance),
        overdue_balance: num(billingMetrics.open_overdue_balance),
        active_invoices: num(billingMetrics.active_invoices),
        paid_this_month: num(billingMetrics.paid_this_month),
        refunds_this_month: num(billingMetrics.refunds_this_month)
      },
      invoice_alerts: {
        overdue: overdueInvoices,
        due_soon: dueSoonInvoices,
        partially_paid: partialInvoices,
        unpaid: unpaidInvoices
      },
      aging_buckets: {
        current: num(aging.current),
        overdue_1_30: num(aging.overdue_1_30),
        overdue_31_60: num(aging.overdue_31_60),
        overdue_61_plus: num(aging.overdue_61_plus)
      },
      collections_snapshot: {
        invoices_sent_this_month: sentThisMonth,
        invoices_paid_this_month: paidThisMonthCount,
        collection_rate_this_month: Number(collectionRate.toFixed(2)),
        average_invoice_value: num(billingMetrics.average_invoice_value)
      },
      recent_billing_activity: {
        payments: recentPayments.rows.map(row => ({
          id: Number(row.id),
          invoice_id: Number(row.invoice_id),
          invoice_number: row.invoice_number || null,
          client_name: row.client_name || null,
          date: row.date,
          method: row.method || "unknown",
          amount: num(row.amount)
        })),
        refunds: recentRefunds.rows.map(row => ({
          id: Number(row.id),
          invoice_id: Number(row.invoice_id),
          payment_id: Number(row.payment_id),
          invoice_number: row.invoice_number || null,
          client_name: row.client_name || null,
          created_at: row.created_at,
          reason: row.reason || "",
          amount: num(row.amount)
        })),
        invoice_status_changes: statusChanges
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS REVENUE ERROR");
  }
});

router.get("/analytics/workers", ownerAdmin, async (req, res) => {
  try {
    let result = await pool.query(`
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

    result = ensureQueryResult(result, "analytics_workers");
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
    sendSafeServerError(res, err, "ANALYTICS WORKERS ERROR");
  }
});

router.get("/analytics/clients", ownerAdmin, async (req, res) => {
  try {
    let result;
    try {
      result = await pool.query(`
        SELECT
          clients.id,
          clients.name,
          clients.phone,
          clients.address,
          COALESCE(COUNT(DISTINCT jobs.id),0)::int AS total_jobs,
          COALESCE(COUNT(DISTINCT subscriptions.id) FILTER (WHERE subscriptions.status='active'),0)::int AS active_subscriptions,
          MAX(jobs.date) AS last_service_date,
          COALESCE(SUM(GREATEST(
            invoices.amount::numeric
              - (COALESCE(gross_pay.total_paid, 0)::numeric - COALESCE(refund_totals.refunded, 0)::numeric),
            0
          )) FILTER (WHERE invoices.status IN ('draft','unpaid','overdue')),0)::numeric AS unpaid_balance
        FROM clients
        LEFT JOIN jobs ON jobs.client_id=clients.id AND jobs.company_id=clients.company_id
        LEFT JOIN subscriptions ON subscriptions.client_id=clients.id AND subscriptions.company_id=clients.company_id
        LEFT JOIN invoices ON invoices.client_id=clients.id AND invoices.company_id=clients.company_id
        LEFT JOIN (
          SELECT invoice_id, company_id, SUM(amount)::numeric AS total_paid
          FROM payments
          WHERE company_id=$1
          GROUP BY invoice_id, company_id
        ) gross_pay ON gross_pay.invoice_id=invoices.id AND gross_pay.company_id=invoices.company_id
        LEFT JOIN (
          SELECT invoice_id, company_id, SUM(amount)::numeric AS refunded
          FROM refunds
          WHERE company_id=$1
          GROUP BY invoice_id, company_id
        ) refund_totals ON refund_totals.invoice_id=invoices.id AND refund_totals.company_id=invoices.company_id
        WHERE clients.company_id=$1 AND COALESCE(clients.archived, FALSE)=FALSE
        GROUP BY clients.id, clients.name, clients.phone, clients.address
        ORDER BY unpaid_balance DESC, total_jobs DESC, clients.name ASC
      `, [req.user.company_id]);
    } catch (err) {
      if (err && err.code === "42P01") {
        result = await pool.query(`
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
      } else {
        throw err;
      }
    }

    result = ensureQueryResult(result, "analytics_clients");
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
    sendSafeServerError(res, err, "ANALYTICS CLIENTS ERROR");
  }
});

router.get("/analytics/pro", ownerAdmin, async (req, res) => {
  try {
    const companyId = req.user.company_id;

    let revenue;
    let jobs;
    let clients;
    let subscriptions;
    let workers;
    let topWorkers;
    let monthlyRevenue;
    let monthlyJobs;
    let monthlyNewClients;
    let alerts;
    [
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
      proRevenueMetrics(companyId),
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
      proMonthlyNetTrends(companyId),
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

    topWorkers = ensureQueryResult(topWorkers, "analytics_pro_top_workers");
    monthlyRevenue = ensureQueryResult(monthlyRevenue, "analytics_pro_monthly_revenue");
    monthlyJobs = ensureQueryResult(monthlyJobs, "analytics_pro_monthly_jobs");
    monthlyNewClients = ensureQueryResult(monthlyNewClients, "analytics_pro_monthly_new_clients");

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
    sendSafeServerError(res, err, "ANALYTICS PRO ERROR");
  }
});

router.get("/analytics/growth-foundation", growthFoundationAccess, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const [company_metrics, worker_metrics, customer_metrics] = await Promise.all([
      growthFoundationService.getCompanyMetrics(companyId),
      growthFoundationService.getWorkerMetrics(companyId),
      growthFoundationService.getCustomerMetrics(companyId)
    ]);

    res.json({
      company_id: companyId,
      generated_at: new Date().toISOString(),
      company_metrics,
      worker_metrics,
      customer_metrics
    });
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH FOUNDATION ERROR");
  }
});

function growthOsCompanyScope(req, res, next) {
  if (!req.user || !req.user.company_id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

const growthOsHandlers = [auth, requireMinimumRole("manager"), growthOsCompanyScope];

router.get("/analytics/growth-os", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getGrowthOverview(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS OVERVIEW ERROR");
  }
});

router.get("/analytics/growth-os/funnel", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getFunnelAnalytics(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS FUNNEL ERROR");
  }
});

router.get("/analytics/growth-os/revenue", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getRevenueIntelligence(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS REVENUE ERROR");
  }
});

router.get("/analytics/growth-os/lost-revenue", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getLostRevenueAnalytics(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS LOST REVENUE ERROR");
  }
});

router.get("/analytics/growth-os/retention", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getRetentionAnalytics(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS RETENTION ERROR");
  }
});

router.get("/analytics/growth-os/client-value", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getClientValueAnalytics(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS CLIENT VALUE ERROR");
  }
});

router.get("/analytics/growth-os/marketplace", growthOsHandlers, async (req, res) => {
  try {
    const data = await growthOsService.getMarketplaceGrowthAnalytics(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS GROWTH OS MARKETPLACE ERROR");
  }
});

router.get("/analytics/customer-retention", growthOsHandlers, async (req, res) => {
  try {
    const data = await customerRetentionService.getRetentionOverview(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS CUSTOMER RETENTION OVERVIEW ERROR");
  }
});

router.get("/analytics/customer-retention/rebook-candidates", growthOsHandlers, async (req, res) => {
  try {
    const data = await customerRetentionService.getRebookCandidates(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS REBOOK CANDIDATES ERROR");
  }
});

router.get("/analytics/customer-retention/reactivation-candidates", growthOsHandlers, async (req, res) => {
  try {
    const data = await customerRetentionService.getReactivationCandidates(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS REACTIVATION CANDIDATES ERROR");
  }
});

router.get("/analytics/customer-retention/subscription-renewals", growthOsHandlers, async (req, res) => {
  try {
    const data = await customerRetentionService.getSubscriptionRenewalCandidates(req.user.company_id);
    res.json(data);
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS SUBSCRIPTION RENEWALS ERROR");
  }
});

router.get("/analytics/customer-retention/saved-addresses", growthOsHandlers, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const [summary, addresses] = await Promise.all([
      customerRetentionService.getSavedAddressSummary(companyId),
      customerRetentionService.listSavedAddressesForCompany(companyId)
    ]);
    res.json({
      summary,
      addresses
    });
  } catch (err) {
    sendSafeServerError(res, err, "ANALYTICS SAVED ADDRESSES ERROR");
  }
});

router.get("/analytics/trust-reputation", growthFoundationAccess, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const profile = await trustReputationService.buildCompanyTrustProfile(companyId, { detail: true });
    const gf = await growthFoundationService.getCompanyMetrics(companyId).catch(() => null);

    res.json({
      company_id: companyId,
      generated_at: profile.generated_at,
      trust_score: profile.trust_score,
      reputation_score: profile.reputation_score,
      verified: profile.verified,
      badges: profile.badges,
      rating_summary: profile.rating_summary,
      components: profile.components,
      detail: profile.detail,
      growth_foundation_metrics: gf
    });
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ error: "Company not found" });
    }
    sendSafeServerError(res, err, "ANALYTICS TRUST REPUTATION ERROR");
  }
});

module.exports = router;

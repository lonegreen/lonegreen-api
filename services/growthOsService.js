/**
 * Phase 2 Growth OS — read-only, company-scoped analytics (funnel, revenue, retention, marketplace).
 * All SQL is parameterized; optional tables fail soft (42P01).
 */
const pool = require("../db/pool");
const growthFoundationService = require("./growthFoundationService");
const trustReputationService = require("./trustReputationService");

function assertCompanyId(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function safeDiv(num, den) {
  const a = n(num);
  const b = n(den);
  if (b === 0) return 0;
  return a / b;
}

async function queryRows(sql, params, label) {
  try {
    const result = await pool.query(sql, params);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "growth_os_table_missing",
        query: label,
        message: err.message
      }));
      return [];
    }
    throw err;
  }
}

async function queryOne(sql, params, label) {
  const rows = await queryRows(sql, params, label);
  return rows[0] || {};
}

async function getFunnelAnalytics(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const row = await queryOne(
    `
    WITH lead_rows AS (
      SELECT id, created_at, status, company_id
      FROM estimates
      WHERE company_id = $1
        AND record_type = 'lead'
        AND COALESCE(archived, FALSE) = FALSE
    ),
    est_rows AS (
      SELECT id, created_at, status, company_id, source_lead_id, quoted_price, record_type
      FROM estimates
      WHERE company_id = $1
        AND record_type = 'estimate'
        AND COALESCE(archived, FALSE) = FALSE
    ),
    job_rows AS (
      SELECT id, date, company_id, estimate_id, status, price
      FROM jobs
      WHERE company_id = $1
    ),
    inv_rows AS (
      SELECT id, issued_date, company_id, job_id, estimate_id, status, amount
      FROM invoices
      WHERE company_id = $1
    )
    SELECT
      (SELECT COUNT(*)::int FROM lead_rows) AS leads_total,
      (SELECT COUNT(*)::int FROM lead_rows WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS leads_30d,
      (SELECT COUNT(*)::int FROM lead_rows WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '90 days') AS leads_90d,
      (SELECT COUNT(*)::int FROM est_rows) AS estimates_total,
      (SELECT COUNT(*)::int FROM est_rows WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS estimates_30d,
      (SELECT COUNT(*)::int FROM est_rows WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '90 days') AS estimates_90d,
      (SELECT COUNT(*)::int FROM est_rows WHERE source_lead_id IS NOT NULL) AS estimates_from_lead,
      (SELECT COUNT(*)::int FROM job_rows) AS jobs_total,
      (SELECT COUNT(*)::int FROM job_rows WHERE date >= CURRENT_DATE - INTERVAL '30 days') AS jobs_30d,
      (SELECT COUNT(*)::int FROM job_rows WHERE date >= CURRENT_DATE - INTERVAL '90 days') AS jobs_90d,
      (SELECT COUNT(*)::int FROM job_rows WHERE estimate_id IS NOT NULL) AS jobs_with_estimate,
      (SELECT COUNT(*)::int FROM inv_rows) AS invoices_total,
      (SELECT COUNT(*)::int FROM inv_rows WHERE issued_date >= CURRENT_DATE - INTERVAL '30 days') AS invoices_30d,
      (SELECT COUNT(*)::int FROM inv_rows WHERE issued_date >= CURRENT_DATE - INTERVAL '90 days') AS invoices_90d,
      (SELECT COUNT(*)::int FROM inv_rows WHERE job_id IS NOT NULL) AS invoices_with_job,
      (SELECT COUNT(*)::int FROM inv_rows WHERE LOWER(TRIM(status)) = 'paid') AS invoices_paid_total,
      (SELECT COUNT(*)::int FROM inv_rows
         WHERE LOWER(TRIM(status)) = 'paid'
           AND issued_date >= CURRENT_DATE - INTERVAL '30 days') AS invoices_paid_30d,
      (SELECT COUNT(*)::int FROM inv_rows
         WHERE LOWER(TRIM(status)) = 'paid'
           AND issued_date >= CURRENT_DATE - INTERVAL '90 days') AS invoices_paid_90d
    `,
    [cid],
    "gos_funnel_core"
  );

  const leadTotal = n(row.leads_total);
  const estTotal = n(row.estimates_total);
  const jobsTotal = n(row.jobs_total);
  const invTotal = n(row.invoices_total);
  const paidTotal = n(row.invoices_paid_total);

  const timing = await queryOne(
    `
    SELECT
      (
        SELECT AVG(EXTRACT(EPOCH FROM (e.created_at - l.created_at)) / 86400.0)::numeric
        FROM estimates e
        INNER JOIN estimates l
          ON l.id = e.source_lead_id
         AND l.company_id = e.company_id
         AND l.record_type = 'lead'
        WHERE e.company_id = $1
          AND e.record_type = 'estimate'
          AND COALESCE(e.archived, FALSE) = FALSE
      ) AS avg_days_lead_to_estimate,
      (
        SELECT AVG(EXTRACT(EPOCH FROM (j.date::timestamp - es.created_at::timestamp)) / 86400.0)::numeric
        FROM jobs j
        INNER JOIN estimates es
          ON es.id = j.estimate_id
         AND es.company_id = j.company_id
        WHERE j.company_id = $1
      ) AS avg_days_estimate_to_job,
      (
        SELECT AVG(EXTRACT(EPOCH FROM (i.issued_date::timestamp - jb.date::timestamp)) / 86400.0)::numeric
        FROM invoices i
        INNER JOIN jobs jb
          ON jb.id = i.job_id
         AND jb.company_id = i.company_id
        WHERE i.company_id = $1
          AND i.job_id IS NOT NULL
      ) AS avg_days_job_to_invoice
    `,
    [cid],
    "gos_funnel_timing"
  );

  const payLag = await queryOne(
    `
    SELECT
      AVG(
        EXTRACT(EPOCH FROM (
          (SELECT MIN(p.date)::timestamp FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id)
          - i.issued_date::timestamp
        )) / 86400.0
      )::numeric AS avg_days_invoice_to_first_payment
    FROM invoices i
    WHERE i.company_id = $1
      AND EXISTS (
        SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id
      )
    `,
    [cid],
    "gos_funnel_pay_lag"
  );

  return {
    counts: {
      leads: leadTotal,
      leads_last_30d: n(row.leads_30d),
      leads_last_90d: n(row.leads_90d),
      estimates: estTotal,
      estimates_last_30d: n(row.estimates_30d),
      estimates_last_90d: n(row.estimates_90d),
      estimates_sourced_from_lead: n(row.estimates_from_lead),
      jobs: jobsTotal,
      jobs_last_30d: n(row.jobs_30d),
      jobs_last_90d: n(row.jobs_90d),
      jobs_linked_to_estimate: n(row.jobs_with_estimate),
      invoices: invTotal,
      invoices_last_30d: n(row.invoices_30d),
      invoices_last_90d: n(row.invoices_90d),
      invoices_linked_to_job: n(row.invoices_with_job),
      invoices_paid: paidTotal,
      invoices_paid_last_30d: n(row.invoices_paid_30d),
      invoices_paid_last_90d: n(row.invoices_paid_90d)
    },
    conversion_rates: {
      lead_to_estimate: roundPct(safeDiv(n(row.estimates_from_lead), leadTotal)),
      estimate_to_job: roundPct(safeDiv(n(row.jobs_with_estimate), estTotal)),
      job_to_invoice: roundPct(safeDiv(n(row.invoices_with_job), jobsTotal)),
      invoice_to_paid: roundPct(safeDiv(paidTotal, invTotal)),
      end_to_end_lead_to_paid: roundPct(
        safeDiv(paidTotal, Math.max(leadTotal, 1))
      )
    },
    drop_off_rates: {
      lead_to_estimate: roundPct(1 - safeDiv(n(row.estimates_from_lead), Math.max(leadTotal, 1))),
      estimate_to_job: roundPct(1 - safeDiv(n(row.jobs_with_estimate), Math.max(estTotal, 1))),
      job_to_invoice: roundPct(1 - safeDiv(n(row.invoices_with_job), Math.max(jobsTotal, 1))),
      invoice_to_paid: roundPct(1 - safeDiv(paidTotal, Math.max(invTotal, 1)))
    },
    timing_days: {
      avg_lead_to_estimate: round2(timing.avg_days_lead_to_estimate),
      avg_estimate_to_job: round2(timing.avg_days_estimate_to_job),
      avg_job_to_invoice: round2(timing.avg_days_job_to_invoice),
      avg_invoice_to_first_payment: round2(payLag.avg_days_invoice_to_first_payment)
    }
  };
}

function roundPct(x) {
  return Number((100 * n(x)).toFixed(2));
}

function round2(x) {
  if (x == null || !Number.isFinite(Number(x))) return 0;
  return Number(Number(x).toFixed(2));
}

async function getRevenueIntelligence(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  let core;
  try {
    const result = await pool.query(
      `
      WITH pay AS (
        SELECT COALESCE(SUM(amount), 0)::numeric AS total_paid
        FROM payments
        WHERE company_id = $1
      ),
      ref AS (
        SELECT COALESCE(SUM(amount), 0)::numeric AS total_refunded
        FROM refunds
        WHERE company_id = $1
      ),
      inv AS (
        SELECT
          COALESCE(SUM(amount), 0)::numeric AS total_invoiced,
          COALESCE(AVG(amount), 0)::numeric AS avg_invoice
        FROM invoices
        WHERE company_id = $1
      ),
      net_inv AS (
        SELECT
          COALESCE(SUM(GREATEST(
            i.amount::numeric
            - COALESCE((SELECT SUM(p.amount)::numeric FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id), 0)
            + COALESCE((SELECT SUM(r.amount)::numeric FROM refunds r WHERE r.invoice_id = i.id AND r.company_id = i.company_id), 0),
            0
          )), 0)::numeric AS outstanding
        FROM invoices i
        WHERE i.company_id = $1
          AND LOWER(TRIM(i.status)) IN ('draft', 'unpaid', 'overdue')
      ),
      mrr AS (
        SELECT
          COALESCE(SUM(
            CASE
              WHEN LOWER(COALESCE(status, '')) <> 'active' THEN 0
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('weekly', 'week') THEN price * 4.33
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('biweekly', 'bi-weekly', 'every_two_weeks') THEN price * 2.165
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('quarterly', 'quarter') THEN price / 3
              WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('yearly', 'annual', 'annually') THEN price / 12
              ELSE price
            END
          ), 0)::numeric AS estimated_mrr
        FROM subscriptions
        WHERE company_id = $1
      ),
      repeat_pay AS (
        SELECT COALESCE(SUM(p.amount), 0)::numeric AS repeat_revenue
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
        WHERE p.company_id = $1
          AND i.client_id IN (
            SELECT client_id
            FROM payments p2
            INNER JOIN invoices i2 ON i2.id = p2.invoice_id AND i2.company_id = p2.company_id
            WHERE p2.company_id = $1 AND i2.client_id IS NOT NULL
            GROUP BY i2.client_id
            HAVING COUNT(DISTINCT i2.id) >= 2 OR COUNT(*) >= 2
          )
      )
      SELECT
        inv.total_invoiced,
        inv.avg_invoice,
        pay.total_paid,
        ref.total_refunded,
        (pay.total_paid - ref.total_refunded)::numeric AS net_collected,
        net_inv.outstanding,
        mrr.estimated_mrr,
        repeat_pay.repeat_revenue
      FROM pay, ref, inv, net_inv, mrr, repeat_pay
      `,
      [cid]
    );
    core = result.rows[0] || {};
  } catch (err) {
    if (err && err.code === "42P01") {
      const fb = await pool.query(
        `
        SELECT
          COALESCE(SUM(amount), 0)::numeric AS total_invoiced,
          COALESCE(AVG(amount), 0)::numeric AS avg_invoice,
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1), 0)::numeric AS total_paid,
          0::numeric AS total_refunded,
          COALESCE((SELECT SUM(amount) FROM payments WHERE company_id = $1), 0)::numeric AS net_collected,
          COALESCE((
            SELECT SUM(GREATEST(i.amount - COALESCE(pt.paid, 0), 0))
            FROM invoices i
            LEFT JOIN (
              SELECT invoice_id, SUM(amount)::numeric AS paid
              FROM payments WHERE company_id = $1
              GROUP BY invoice_id
            ) pt ON pt.invoice_id = i.id
            WHERE i.company_id = $1 AND LOWER(TRIM(i.status)) IN ('draft','unpaid','overdue')
          ), 0)::numeric AS outstanding,
          COALESCE((
            SELECT SUM(
              CASE
                WHEN LOWER(COALESCE(status, '')) <> 'active' THEN 0
                WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('weekly', 'week') THEN price * 4.33
                WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('biweekly', 'bi-weekly', 'every_two_weeks') THEN price * 2.165
                WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('quarterly', 'quarter') THEN price / 3
                WHEN LOWER(COALESCE(frequency, 'monthly')) IN ('yearly', 'annual', 'annually') THEN price / 12
                ELSE price
              END
            )
            FROM subscriptions WHERE company_id = $1
          ), 0)::numeric AS estimated_mrr,
          COALESCE((
            SELECT SUM(p.amount)
            FROM payments p
            INNER JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
            WHERE p.company_id = $1
              AND i.client_id IN (
                SELECT i2.client_id
                FROM invoices i2
                WHERE i2.company_id = $1 AND i2.client_id IS NOT NULL
                GROUP BY i2.client_id
                HAVING COUNT(*) >= 2
              )
          ), 0)::numeric AS repeat_revenue
        FROM invoices
        WHERE company_id = $1
        LIMIT 1
        `,
        [cid]
      );
      core = fb.rows[0] || {};
    } else {
      throw err;
    }
  }

  const monthly = await queryRows(
    `
    SELECT
      to_char(gs.mb, 'YYYY-MM') AS month,
      (
        COALESCE(pay.pay_amt, 0)::numeric - COALESCE(ref.ref_amt, 0)::numeric
      ) AS net_revenue
    FROM generate_series(
      date_trunc('month', CURRENT_TIMESTAMP)::timestamp - INTERVAL '11 months',
      date_trunc('month', CURRENT_TIMESTAMP)::timestamp,
      INTERVAL '1 month'
    ) AS gs(mb)
    LEFT JOIN (
      SELECT date_trunc('month', date::timestamp with time zone) AS mb, SUM(amount)::numeric AS pay_amt
      FROM payments
      WHERE company_id = $1
      GROUP BY 1
    ) pay ON pay.mb = gs.mb
    LEFT JOIN (
      SELECT date_trunc('month', created_at) AS mb, SUM(amount)::numeric AS ref_amt
      FROM refunds
      WHERE company_id = $1
      GROUP BY 1
    ) ref ON ref.mb = gs.mb
    ORDER BY gs.mb ASC
    `,
    [cid],
    "gos_revenue_monthly"
  ).catch(() =>
    queryRows(
      `
      SELECT
        to_char(gs.mb, 'YYYY-MM') AS month,
        COALESCE(pay.pay_amt, 0)::numeric AS net_revenue
      FROM generate_series(
        date_trunc('month', CURRENT_TIMESTAMP)::timestamp - INTERVAL '11 months',
        date_trunc('month', CURRENT_TIMESTAMP)::timestamp,
        INTERVAL '1 month'
      ) AS gs(mb)
      LEFT JOIN (
        SELECT date_trunc('month', date::timestamp with time zone) AS mb, SUM(amount)::numeric AS pay_amt
        FROM payments
        WHERE company_id = $1
        GROUP BY 1
      ) pay ON pay.mb = gs.mb
      ORDER BY gs.mb ASC
      `,
      [cid],
      "gos_revenue_monthly_fb"
    )
  );

  return {
    totals: {
      total_invoiced: round2(core.total_invoiced),
      total_paid: round2(core.total_paid),
      total_refunded: round2(core.total_refunded),
      net_collected: round2(core.net_collected),
      outstanding_balance: round2(core.outstanding),
      average_invoice_value: round2(core.avg_invoice),
      estimated_mrr: round2(core.estimated_mrr),
      estimated_arr: round2(n(core.estimated_mrr) * 12),
      repeat_revenue_approx: round2(core.repeat_revenue)
    },
    monthly_net_revenue_trend: monthly.map((r) => ({
      month: r.month,
      net_revenue: round2(r.net_revenue)
    }))
  };
}

async function getLostRevenueAnalytics(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const estLost = await queryOne(
    `
    SELECT
      COALESCE(SUM(quoted_price), 0)::numeric AS rejected_amount,
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'rejected')::int AS rejected_count
    FROM estimates
    WHERE company_id = $1
      AND record_type = 'estimate'
      AND COALESCE(archived, FALSE) = FALSE
    `,
    [cid],
    "gos_lost_est"
  );

  const stale = await queryOne(
    `
    SELECT
      COALESCE(SUM(quoted_price), 0)::numeric AS stale_amount,
      COUNT(*)::int AS stale_count
    FROM estimates
    WHERE company_id = $1
      AND record_type = 'estimate'
      AND COALESCE(archived, FALSE) = FALSE
      AND LOWER(TRIM(status)) NOT IN ('converted', 'approved', 'rejected')
      AND created_at < CURRENT_TIMESTAMP - INTERVAL '60 days'
    `,
    [cid],
    "gos_stale_est"
  );

  const jobsLost = await queryOne(
    `
    SELECT
      COALESCE(SUM(price), 0)::numeric AS cancelled_job_value,
      COUNT(*)::int AS cancelled_jobs
    FROM jobs
    WHERE company_id = $1
      AND LOWER(TRIM(status)) = 'cancelled'
    `,
    [cid],
    "gos_cancel_jobs"
  );

  const invLost = await queryOne(
    `
    WITH net AS (
      SELECT
        i.id,
        i.amount::numeric AS amount,
        i.status,
        COALESCE((SELECT SUM(p.amount)::numeric FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id), 0)
        - COALESCE((SELECT SUM(r.amount)::numeric FROM refunds r WHERE r.invoice_id = i.id AND r.company_id = i.company_id), 0) AS net_paid
      FROM invoices i
      WHERE i.company_id = $1
    )
    SELECT
      COALESCE(SUM(GREATEST(amount - net_paid, 0)) FILTER (
        WHERE LOWER(TRIM(status)) IN ('unpaid', 'overdue')
          OR (LOWER(TRIM(status)) IN ('draft', 'unpaid') AND due_date IS NOT NULL AND due_date < CURRENT_DATE)
      ), 0)::numeric AS unpaid_balance_at_risk,
      COUNT(*) FILTER (
        WHERE LOWER(TRIM(status)) IN ('unpaid', 'overdue')
      )::int AS unpaid_invoice_count
    FROM net
    `,
    [cid],
    "gos_inv_lost"
  ).catch(async () =>
    queryOne(
      `
      SELECT
        COALESCE(SUM(GREATEST(i.amount - COALESCE(pt.paid, 0), 0)) FILTER (
          WHERE LOWER(TRIM(i.status)) IN ('unpaid', 'overdue', 'draft')
        ), 0)::numeric AS unpaid_balance_at_risk,
        COUNT(*) FILTER (WHERE LOWER(TRIM(i.status)) IN ('unpaid', 'overdue'))::int AS unpaid_invoice_count
      FROM invoices i
      LEFT JOIN (
        SELECT invoice_id, SUM(amount)::numeric AS paid FROM payments WHERE company_id = $1 GROUP BY invoice_id
      ) pt ON pt.invoice_id = i.id
      WHERE i.company_id = $1
      `,
      [cid],
      "gos_inv_lost_fb"
    )
  );

  const offersLost = await queryOne(
    `
    SELECT
      COALESCE(SUM(price), 0)::numeric AS rejected_offer_value,
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'rejected')::int AS rejected_offers
    FROM marketplace_offers
    WHERE company_id = $1
    `,
    [cid],
    "gos_offers_lost"
  );

  const totalEstimatedLost = round2(
    n(estLost.rejected_amount) +
      n(stale.stale_amount) +
      n(jobsLost.cancelled_job_value) +
      n(invLost.unpaid_balance_at_risk) +
      n(offersLost.rejected_offer_value)
  );

  return {
    estimates: {
      rejected_count: n(estLost.rejected_count),
      rejected_value_approx: round2(estLost.rejected_amount),
      stale_open_count: n(stale.stale_count),
      stale_value_approx: round2(stale.stale_amount),
      stale_definition_days: 60
    },
    jobs: {
      cancelled_count: n(jobsLost.cancelled_jobs),
      cancelled_value_approx: round2(jobsLost.cancelled_job_value)
    },
    invoices: {
      unpaid_or_overdue_count: n(invLost.unpaid_invoice_count),
      unpaid_balance_at_risk: round2(invLost.unpaid_balance_at_risk)
    },
    marketplace_offers: {
      rejected_count: n(offersLost.rejected_offers),
      rejected_value_approx: round2(offersLost.rejected_offer_value)
    },
    total_estimated_lost_value_approx: totalEstimatedLost
  };
}

async function getRetentionAnalytics(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const sub = await queryOne(
    `
    SELECT
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'active')::int AS active,
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'cancelled')::int AS cancelled,
      COUNT(*)::int AS total
    FROM subscriptions
    WHERE company_id = $1
    `,
    [cid],
    "gos_ret_sub"
  );

  const repeat = await queryOne(
    `
    SELECT
      COUNT(*)::int AS repeat_clients
    FROM (
      SELECT client_id
      FROM jobs
      WHERE company_id = $1 AND client_id IS NOT NULL
      GROUP BY client_id
      HAVING COUNT(*) >= 2
    ) x
    `,
    [cid],
    "gos_repeat"
  );

  const activeClients = await queryOne(
    `
    SELECT COUNT(*)::int AS c
    FROM clients
    WHERE company_id = $1 AND COALESCE(archived, FALSE) = FALSE
    `,
    [cid],
    "gos_active_clients"
  );

  const repeatJobs = await queryOne(
    `
    SELECT
      COALESCE(AVG(cnt), 0)::numeric AS avg_completed_jobs_per_repeat_client
    FROM (
      SELECT client_id, COUNT(*)::numeric AS cnt
      FROM jobs
      WHERE company_id = $1
        AND client_id IS NOT NULL
        AND LOWER(TRIM(status)) = 'completed'
        AND client_id IN (
          SELECT client_id
          FROM jobs
          WHERE company_id = $1 AND client_id IS NOT NULL
          GROUP BY client_id
          HAVING COUNT(*) >= 2
        )
      GROUP BY client_id
    ) z
    `,
    [cid],
    "gos_repeat_jobs"
  );

  const clv = await queryOne(
    `
    SELECT
      COALESCE(SUM(p.amount), 0)::numeric AS lifetime_payments,
      COUNT(DISTINCT i.client_id)::int AS clients_with_payments
    FROM payments p
    INNER JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
    WHERE p.company_id = $1 AND i.client_id IS NOT NULL
    `,
    [cid],
    "gos_clv"
  );

  const active = n(sub.active);
  const cancelled = n(sub.cancelled);
  const churnRate = roundPct(safeDiv(cancelled, Math.max(active + cancelled, 1)));

  return {
    subscriptions: {
      active,
      cancelled,
      churn_rate_lifetime_approx: churnRate,
      note:
        "Subscription rows do not expose reliable cancellation timestamps in all deployments; churn uses lifetime cancelled vs active+cancelled split."
    },
    clients: {
      active_clients: n(activeClients.c),
      repeat_clients: n(repeat.repeat_clients),
      repeat_client_rate: roundPct(safeDiv(n(repeat.repeat_clients), Math.max(n(activeClients.c), 1))),
      avg_completed_jobs_per_repeat_client: round2(repeatJobs.avg_completed_jobs_per_repeat_client)
    },
    lifetime_value: {
      approx_avg_revenue_per_paying_client: round2(
        safeDiv(clv.lifetime_payments, Math.max(clv.clients_with_payments, 1))
      ),
      paying_clients: n(clv.clients_with_payments)
    }
  };
}

async function getClientValueAnalytics(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const rows = await queryRows(
    `
    WITH pay AS (
      SELECT
        i.client_id,
        COALESCE(SUM(p.amount), 0)::numeric AS paid_total,
        COUNT(DISTINCT p.id)::int AS payment_count
      FROM payments p
      INNER JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
      WHERE p.company_id = $1 AND i.client_id IS NOT NULL
      GROUP BY i.client_id
    ),
    inv AS (
      SELECT
        client_id,
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(amount), 0)::numeric AS invoiced_total
      FROM invoices
      WHERE company_id = $1 AND client_id IS NOT NULL
      GROUP BY client_id
    ),
    jc AS (
      SELECT client_id, COUNT(*)::int AS job_count
      FROM jobs
      WHERE company_id = $1 AND client_id IS NOT NULL
      GROUP BY client_id
    ),
    sub AS (
      SELECT
        client_id,
        BOOL_OR(LOWER(TRIM(status)) = 'active') AS has_active_subscription
      FROM subscriptions
      WHERE company_id = $1
      GROUP BY client_id
    )
    SELECT
      c.id AS client_id,
      c.name AS client_name,
      COALESCE(inv.invoiced_total, 0)::numeric AS total_invoiced,
      COALESCE(pay.paid_total, 0)::numeric AS total_paid,
      COALESCE(inv.invoice_count, 0)::int AS invoice_count,
      COALESCE(jc.job_count, 0)::int AS job_count,
      COALESCE(pay.payment_count, 0)::int AS payment_count,
      COALESCE(sub.has_active_subscription, FALSE) AS has_active_subscription
    FROM clients c
    LEFT JOIN pay ON pay.client_id = c.id
    LEFT JOIN inv ON inv.client_id = c.id
    LEFT JOIN jc ON jc.client_id = c.id
    LEFT JOIN sub ON sub.client_id = c.id
    WHERE c.company_id = $1
      AND COALESCE(c.archived, FALSE) = FALSE
      AND (
        COALESCE(pay.paid_total, 0) > 0
        OR COALESCE(inv.invoiced_total, 0) > 0
        OR COALESCE(jc.job_count, 0) > 0
      )
    ORDER BY COALESCE(pay.paid_total, 0)::numeric DESC, c.id ASC
    LIMIT 25
    `,
    [cid],
    "gos_client_value"
  );

  return {
    limit: 25,
    clients: rows.map((r) => ({
      client_id: r.client_id,
      client_name: r.client_name || "",
      total_invoiced: round2(r.total_invoiced),
      total_paid: round2(r.total_paid),
      invoice_count: n(r.invoice_count),
      job_count: n(r.job_count),
      payment_count: n(r.payment_count),
      has_active_subscription: r.has_active_subscription === true
    }))
  };
}

async function getMarketplaceGrowthAnalytics(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const offerStats = await queryOne(
    `
    SELECT
      COUNT(*)::int AS offers_total,
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'accepted')::int AS offers_accepted,
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'rejected')::int AS offers_rejected,
      COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'pending')::int AS offers_pending,
      COALESCE(AVG(price), 0)::numeric AS avg_offer_amount,
      COALESCE(SUM(price) FILTER (WHERE LOWER(TRIM(status)) = 'accepted'), 0)::numeric AS accepted_value
    FROM marketplace_offers
    WHERE company_id = $1
    `,
    [cid],
    "gos_mp_offers"
  );

  const conv = await queryOne(
    `
    SELECT
      COUNT(*)::int AS conversions
    FROM marketplace_requests
    WHERE converted_by_company_id = $1
      AND converted_at IS NOT NULL
    `,
    [cid],
    "gos_mp_conv"
  );

  const resp = await queryOne(
    `
    SELECT
      AVG(EXTRACT(EPOCH FROM (mo.created_at - mr.created_at)))::numeric AS avg_response_seconds,
      COUNT(*)::int AS offers_with_request
    FROM marketplace_offers mo
    INNER JOIN marketplace_requests mr ON mr.id = mo.request_id
    WHERE mo.company_id = $1
    `,
    [cid],
    "gos_mp_resp"
  );

  const matchedRequests = await queryOne(
    `
    SELECT COUNT(DISTINCT mo.request_id)::int AS cnt
    FROM marketplace_offers mo
    WHERE mo.company_id = $1
    `,
    [cid],
    "gos_mp_distinct_req"
  );

  const acc = n(offerStats.offers_accepted);
  const rej = n(offerStats.offers_rejected);
  const terminal = acc + rej;

  return {
    offers: {
      total: n(offerStats.offers_total),
      accepted: acc,
      rejected: rej,
      pending: n(offerStats.offers_pending),
      win_rate_percent: roundPct(safeDiv(acc, Math.max(terminal, 1))),
      average_offer_amount: round2(offerStats.avg_offer_amount),
      accepted_pipeline_value: round2(offerStats.accepted_value)
    },
    requests: {
      distinct_requests_with_offer: n(matchedRequests.cnt),
      conversions_traced_to_company: n(conv.conversions)
    },
    response: {
      avg_seconds_offer_after_request: round2(resp.avg_response_seconds),
      offers_timed: n(resp.offers_with_request)
    },
    revenue_influenced_approx: round2(offerStats.accepted_value)
  };
}

async function getGrowthOverview(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const [
    funnel,
    revenue,
    lost,
    retention,
    clientValue,
    marketplace,
    foundation,
    trust
  ] = await Promise.all([
    getFunnelAnalytics(cid),
    getRevenueIntelligence(cid),
    getLostRevenueAnalytics(cid),
    getRetentionAnalytics(cid),
    getClientValueAnalytics(cid),
    getMarketplaceGrowthAnalytics(cid),
    growthFoundationService.getCompanyMetrics(cid).catch(() => null),
    trustReputationService.buildCompanyTrustProfile(cid, { detail: false }).catch(() => null)
  ]);

  const topClients = (clientValue && clientValue.clients ? clientValue.clients : []).slice(0, 8);

  return {
    company_id: cid,
    generated_at: new Date().toISOString(),
    foundation_metrics: foundation,
    trust_snapshot: trust
      ? {
          trust_score: trust.trust_score,
          reputation_score: trust.reputation_score,
          badges: trust.badges || []
        }
      : null,
    kpis: {
      leads_open: funnel && funnel.counts ? funnel.counts.leads : 0,
      estimates_pipeline: funnel && funnel.counts ? funnel.counts.estimates : 0,
      jobs_total: funnel && funnel.counts ? funnel.counts.jobs : 0,
      net_collected: revenue && revenue.totals ? revenue.totals.net_collected : 0,
      outstanding_balance: revenue && revenue.totals ? revenue.totals.outstanding_balance : 0,
      estimated_mrr: revenue && revenue.totals ? revenue.totals.estimated_mrr : 0,
      estimated_lost_value: lost ? lost.total_estimated_lost_value_approx : 0,
      repeat_client_rate_pct: retention && retention.clients ? retention.clients.repeat_client_rate : 0,
      marketplace_win_rate_pct: marketplace && marketplace.offers ? marketplace.offers.win_rate_percent : 0
    },
    top_clients_preview: topClients,
    sections: {
      funnel,
      revenue,
      lost_revenue: lost,
      retention,
      client_value: clientValue,
      marketplace
    }
  };
}

module.exports = {
  getGrowthOverview,
  getFunnelAnalytics,
  getRevenueIntelligence,
  getLostRevenueAnalytics,
  getRetentionAnalytics,
  getClientValueAnalytics,
  getMarketplaceGrowthAnalytics
};

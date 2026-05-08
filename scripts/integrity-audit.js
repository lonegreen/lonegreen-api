#!/usr/bin/env node
/**
 * Read-only database integrity / orphan risk audit.
 * Reports issues only — does not modify or delete data.
 * Usage: node scripts/integrity-audit.js [--strict]
 *   --strict  exit with code 1 if any check finds rows (for CI gates)
 */
"use strict";

const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env")
});

const pool = require("../db/pool");

const strict = process.argv.includes("--strict");

const checks = [
  {
    id: "jobs_orphan_client",
    title: "Jobs referencing a missing client row",
    sql: `
      SELECT j.id, j.company_id, j.client_id, j.status, j.type
      FROM jobs j
      WHERE j.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = j.client_id)
      ORDER BY j.id
      LIMIT 100
    `
  },
  {
    id: "jobs_client_company_mismatch",
    title: "Jobs where job.company_id differs from linked client.company_id",
    sql: `
      SELECT j.id AS job_id, j.company_id AS job_company_id, j.client_id,
             c.company_id AS client_company_id
      FROM jobs j
      INNER JOIN clients c ON c.id = j.client_id
      WHERE j.company_id IS NOT NULL
        AND c.company_id IS NOT NULL
        AND j.company_id <> c.company_id
      ORDER BY j.id
      LIMIT 100
    `
  },
  {
    id: "jobs_worker_company_mismatch",
    title: "Jobs where job.company_id differs from assigned worker.company_id",
    sql: `
      SELECT j.id AS job_id, j.company_id AS job_company_id, j.worker_id,
             w.company_id AS worker_company_id
      FROM jobs j
      INNER JOIN workers w ON w.id = j.worker_id
      WHERE j.worker_id IS NOT NULL
        AND j.company_id IS NOT NULL
        AND w.company_id IS NOT NULL
        AND j.company_id <> w.company_id
      ORDER BY j.id
      LIMIT 100
    `
  },
  {
    id: "jobs_missing_company",
    title: "Jobs with NULL company_id",
    sql: `
      SELECT j.id, j.client_id, j.status
      FROM jobs j
      WHERE j.company_id IS NULL
      ORDER BY j.id
      LIMIT 100
    `
  },
  {
    id: "clients_missing_company",
    title: "Company clients with NULL company_id",
    sql: `
      SELECT id, name
      FROM clients c
      WHERE c.company_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM customer_accounts ca
          WHERE ca.client_id = c.id
        )
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "workers_invalid_company",
    title: "Workers referencing a missing company",
    sql: `
      SELECT w.id, w.name, w.company_id
      FROM workers w
      WHERE w.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = w.company_id)
      ORDER BY w.id
      LIMIT 100
    `
  },
  {
    id: "users_invalid_company",
    title: "Users (non–platform_owner) referencing a missing company",
    sql: `
      SELECT u.id, u.username, u.role, u.company_id
      FROM users u
      WHERE u.company_id IS NOT NULL
        AND COALESCE(u.role, '') <> 'platform_owner'
        AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = u.company_id)
      ORDER BY u.id
      LIMIT 100
    `
  },
  {
    id: "users_worker_company_mismatch",
    title: "Users where user.company_id differs from linked worker.company_id",
    sql: `
      SELECT u.id AS user_id, u.username, u.role, u.company_id AS user_company_id,
             u.worker_id, w.company_id AS worker_company_id
      FROM users u
      INNER JOIN workers w ON w.id = u.worker_id
      WHERE u.worker_id IS NOT NULL
        AND u.company_id IS NOT NULL
        AND w.company_id IS NOT NULL
        AND u.company_id <> w.company_id
      ORDER BY u.id
      LIMIT 100
    `
  },
  {
    id: "worker_zip_groups_worker_company_mismatch",
    title: "Worker ZIP group links where link.company_id differs from worker.company_id",
    sql: `
      SELECT wzg.company_id AS link_company_id, wzg.worker_id, w.company_id AS worker_company_id,
             wzg.group_id
      FROM worker_zip_groups wzg
      INNER JOIN workers w ON w.id = wzg.worker_id
      WHERE wzg.company_id IS NOT NULL
        AND w.company_id IS NOT NULL
        AND wzg.company_id <> w.company_id
      ORDER BY wzg.worker_id, wzg.group_id
      LIMIT 100
    `
  },
  {
    id: "worker_zip_groups_group_company_mismatch",
    title: "Worker ZIP group links where link.company_id differs from zip_group.company_id",
    sql: `
      SELECT wzg.company_id AS link_company_id, wzg.group_id, zg.company_id AS group_company_id,
             wzg.worker_id
      FROM worker_zip_groups wzg
      INNER JOIN zip_groups zg ON zg.id = wzg.group_id
      WHERE wzg.company_id IS NOT NULL
        AND zg.company_id IS NOT NULL
        AND wzg.company_id <> zg.company_id
      ORDER BY wzg.group_id, wzg.worker_id
      LIMIT 100
    `
  },
  {
    id: "zip_codes_group_company_mismatch",
    title: "ZIP codes where zip_code.company_id differs from zip_group.company_id",
    sql: `
      SELECT zc.id AS zip_code_id, zc.company_id AS zip_code_company_id,
             zc.group_id, zg.company_id AS group_company_id
      FROM zip_codes zc
      INNER JOIN zip_groups zg ON zg.id = zc.group_id
      WHERE zc.company_id IS NOT NULL
        AND zg.company_id IS NOT NULL
        AND zc.company_id <> zg.company_id
      ORDER BY zc.id
      LIMIT 100
    `
  },
  {
    id: "invoices_orphan_client",
    title: "Invoices referencing a missing client",
    sql: `
      SELECT i.id, i.company_id, i.client_id, i.status
      FROM invoices i
      WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = i.client_id)
      ORDER BY i.id
      LIMIT 100
    `
  },
  {
    id: "invoices_orphan_job",
    title: "Invoices with job_id set but job row missing",
    sql: `
      SELECT i.id, i.company_id, i.job_id
      FROM invoices i
      WHERE i.job_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = i.job_id)
      ORDER BY i.id
      LIMIT 100
    `
  },
  {
    id: "invoices_job_company_mismatch",
    title: "Invoices where invoice.company_id differs from linked job.company_id",
    sql: `
      SELECT i.id AS invoice_id, i.company_id AS invoice_company_id, i.job_id,
             j.company_id AS job_company_id
      FROM invoices i
      INNER JOIN jobs j ON j.id = i.job_id
      WHERE i.job_id IS NOT NULL
        AND i.company_id IS NOT NULL
        AND j.company_id IS NOT NULL
        AND i.company_id <> j.company_id
      ORDER BY i.id
      LIMIT 100
    `
  },
  {
    id: "invoices_client_company_mismatch",
    title: "Invoices where invoice.company_id differs from linked client.company_id",
    sql: `
      SELECT i.id AS invoice_id, i.company_id AS invoice_company_id, i.client_id,
             c.company_id AS client_company_id
      FROM invoices i
      INNER JOIN clients c ON c.id = i.client_id
      WHERE i.company_id IS NOT NULL
        AND c.company_id IS NOT NULL
        AND i.company_id <> c.company_id
      ORDER BY i.id
      LIMIT 100
    `
  },
  {
    id: "payments_orphan_invoice",
    title: "Payments referencing a missing invoice",
    sql: `
      SELECT p.id, p.company_id, p.invoice_id, p.amount
      FROM payments p
      WHERE NOT EXISTS (SELECT 1 FROM invoices inv WHERE inv.id = p.invoice_id)
      ORDER BY p.id
      LIMIT 100
    `
  },
  {
    id: "payments_invoice_company_mismatch",
    title: "Payments where payment.company_id differs from invoice.company_id",
    sql: `
      SELECT p.id AS payment_id, p.company_id AS payment_company_id, p.invoice_id,
             inv.company_id AS invoice_company_id
      FROM payments p
      INNER JOIN invoices inv ON inv.id = p.invoice_id
      WHERE p.company_id IS NOT NULL
        AND inv.company_id IS NOT NULL
        AND p.company_id <> inv.company_id
      ORDER BY p.id
      LIMIT 100
    `
  },
  {
    id: "subscription_visits_missing_subscription",
    title: "Subscription visit jobs with missing or invalid source_subscription_id",
    sql: `
      SELECT j.id, j.company_id, j.client_id, j.source_subscription_id, j.date
      FROM jobs j
      WHERE j.type = 'subscription_visit'
        AND (
          j.source_subscription_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM subscriptions s WHERE s.id = j.source_subscription_id
          )
        )
      ORDER BY j.id
      LIMIT 100
    `
  },
  {
    id: "subscription_visits_subscription_company_mismatch",
    title: "Subscription visits where job.company_id differs from subscription.company_id",
    sql: `
      SELECT j.id AS job_id, j.company_id AS job_company_id, j.source_subscription_id,
             s.company_id AS subscription_company_id
      FROM jobs j
      INNER JOIN subscriptions s ON s.id = j.source_subscription_id
      WHERE j.type = 'subscription_visit'
        AND j.source_subscription_id IS NOT NULL
        AND j.company_id IS NOT NULL
        AND s.company_id IS NOT NULL
        AND j.company_id <> s.company_id
      ORDER BY j.id
      LIMIT 100
    `
  },
  {
    id: "duplicate_subscription_visits",
    title: "Duplicate subscription visits for the same company/subscription/date/type",
    sql: `
      SELECT company_id, source_subscription_id, date, type, COUNT(*)::int AS duplicate_count,
             ARRAY_AGG(id ORDER BY id) AS job_ids
      FROM jobs
      WHERE source_subscription_id IS NOT NULL
        AND type = 'subscription_visit'
      GROUP BY company_id, source_subscription_id, date, type
      HAVING COUNT(*) > 1
      ORDER BY company_id, source_subscription_id, date
      LIMIT 100
    `
  },
  {
    id: "subscriptions_worker_company_mismatch",
    title: "Subscriptions where subscription.company_id differs from assigned worker.company_id",
    sql: `
      SELECT s.id AS subscription_id, s.company_id AS subscription_company_id,
             s.worker_id, w.company_id AS worker_company_id
      FROM subscriptions s
      INNER JOIN workers w ON w.id = s.worker_id
      WHERE s.worker_id IS NOT NULL
        AND s.company_id IS NOT NULL
        AND w.company_id IS NOT NULL
        AND s.company_id <> w.company_id
      ORDER BY s.id
      LIMIT 100
    `
  },
  {
    id: "subscription_billings_orphan_subscription",
    title: "subscription_billings rows referencing a missing subscription",
    sql: `
      SELECT sb.id, sb.company_id, sb.subscription_id, sb.billing_month
      FROM subscription_billings sb
      WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = sb.subscription_id)
      ORDER BY sb.id
      LIMIT 100
    `
  },
  {
    id: "invoices_negative_totals",
    title: "Invoices with negative amount or subtotal",
    sql: `
      SELECT id, company_id, invoice_number, status, amount, subtotal
      FROM invoices
      WHERE COALESCE(amount, 0) < 0
         OR COALESCE(subtotal, 0) < 0
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "invoice_line_item_total_mismatch",
    title: "Invoices where line item total differs from invoice amount",
    sql: `
      WITH invoice_lines AS (
        SELECT
          i.id,
          i.company_id,
          i.invoice_number,
          i.amount,
          COALESCE(SUM(
            CASE
              WHEN item.value ? 'amount'
               AND (item.value->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (item.value->>'amount')::numeric
              ELSE 0
            END
          ), 0)::numeric AS line_total,
          COUNT(item.value)::int AS line_count
        FROM invoices i
        LEFT JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(i.line_items) = 'array' THEN i.line_items ELSE '[]'::jsonb END
        ) AS item(value) ON TRUE
        GROUP BY i.id, i.company_id, i.invoice_number, i.amount
      )
      SELECT id, company_id, invoice_number, amount, line_total
      FROM invoice_lines
      WHERE line_count > 0
        AND ABS(COALESCE(amount, 0) - line_total) > 0.01
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "payments_nonpositive_amount",
    title: "Payments with non-positive amount",
    sql: `
      SELECT id, company_id, invoice_id, amount
      FROM payments
      WHERE COALESCE(amount, 0) <= 0
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "refunds_nonpositive_amount",
    title: "Refunds with non-positive amount",
    sql: `
      SELECT id, company_id, invoice_id, payment_id, amount
      FROM refunds
      WHERE COALESCE(amount, 0) <= 0
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "refunds_exceed_payment_amount",
    title: "Refund totals exceeding original payment amount",
    sql: `
      SELECT
        p.id AS payment_id,
        p.company_id,
        p.invoice_id,
        p.amount AS payment_amount,
        COALESCE(SUM(r.amount), 0)::numeric AS refunded_amount
      FROM payments p
      INNER JOIN refunds r
        ON r.payment_id = p.id
       AND r.company_id = p.company_id
      GROUP BY p.id, p.company_id, p.invoice_id, p.amount
      HAVING COALESCE(SUM(r.amount), 0) > p.amount + 0.01
      ORDER BY p.id
      LIMIT 100
    `
  },
  {
    id: "invoice_net_paid_exceeds_total",
    title: "Invoices where net payments exceed invoice total",
    sql: `
      WITH balances AS (
        SELECT
          i.id,
          i.company_id,
          i.invoice_number,
          i.status,
          COALESCE(i.amount, 0)::numeric AS invoice_total,
          COALESCE((SELECT SUM(p.amount)::numeric FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id), 0)
            - COALESCE((SELECT SUM(r.amount)::numeric FROM refunds r WHERE r.invoice_id = i.id AND r.company_id = i.company_id), 0) AS net_paid
        FROM invoices i
      )
      SELECT id, company_id, invoice_number, status, invoice_total, net_paid
      FROM balances
      WHERE status <> 'cancelled'
        AND net_paid > invoice_total + 0.01
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "invoice_paid_status_balance_mismatch",
    title: "Paid invoices with remaining balance",
    sql: `
      WITH balances AS (
        SELECT
          i.id,
          i.company_id,
          i.invoice_number,
          i.status,
          COALESCE(i.amount, 0)::numeric AS invoice_total,
          COALESCE((SELECT SUM(p.amount)::numeric FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id), 0)
            - COALESCE((SELECT SUM(r.amount)::numeric FROM refunds r WHERE r.invoice_id = i.id AND r.company_id = i.company_id), 0) AS net_paid
        FROM invoices i
      )
      SELECT id, company_id, invoice_number, status, invoice_total, net_paid,
             invoice_total - net_paid AS remaining_balance
      FROM balances
      WHERE status = 'paid'
        AND invoice_total - net_paid > 0.01
      ORDER BY id
      LIMIT 100
    `
  },
  {
    id: "invoice_open_status_balance_mismatch",
    title: "Open invoices with zero remaining balance",
    sql: `
      WITH balances AS (
        SELECT
          i.id,
          i.company_id,
          i.invoice_number,
          i.status,
          COALESCE(i.amount, 0)::numeric AS invoice_total,
          COALESCE((SELECT SUM(p.amount)::numeric FROM payments p WHERE p.invoice_id = i.id AND p.company_id = i.company_id), 0)
            - COALESCE((SELECT SUM(r.amount)::numeric FROM refunds r WHERE r.invoice_id = i.id AND r.company_id = i.company_id), 0) AS net_paid
        FROM invoices i
      )
      SELECT id, company_id, invoice_number, status, invoice_total, net_paid,
             invoice_total - net_paid AS remaining_balance
      FROM balances
      WHERE status IN ('unpaid', 'overdue')
        AND invoice_total >= 0
        AND invoice_total - net_paid <= 0.01
      ORDER BY id
      LIMIT 100
    `
  }
];

async function run() {
  console.log("FairLinx DB integrity audit (read-only)");
  console.log("Started:", new Date().toISOString());
  console.log("");

  let totalIssues = 0;
  const sections = [];

  for (const check of checks) {
    try {
      const result = await pool.query(check.sql);
      const count = result.rowCount;
      totalIssues += count;
      sections.push({
        id: check.id,
        title: check.title,
        count,
        sample: result.rows
      });

      const status = count === 0 ? "OK" : "REVIEW";
      console.log(`[${status}] ${check.title} (${count} row${count === 1 ? "" : "s"})`);
      if (count > 0 && result.rows.length > 0) {
        console.log("  Sample (up to 5):");
        for (const row of result.rows.slice(0, 5)) {
          console.log("   ", JSON.stringify(row));
        }
      }
      console.log("");
    } catch (err) {
      console.log(`[ERROR] ${check.title}`);
      console.log("  ", err.message || String(err));
      console.log("");
      sections.push({
        id: check.id,
        title: check.title,
        count: null,
        error: err.message || String(err)
      });
    }
  }

  console.log("---");
  console.log("Total flagged rows (sum of counts):", totalIssues);
  console.log("Finished:", new Date().toISOString());

  await pool.end();

  if (strict && totalIssues > 0) {
    process.exit(1);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("Integrity audit failed:", err.message || err);
  process.exit(1);
});

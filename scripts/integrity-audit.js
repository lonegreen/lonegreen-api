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
    title: "Clients with NULL company_id",
    sql: `
      SELECT id, name
      FROM clients
      WHERE company_id IS NULL
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
    id: "subscription_billings_orphan_subscription",
    title: "subscription_billings rows referencing a missing subscription",
    sql: `
      SELECT sb.id, sb.company_id, sb.subscription_id, sb.billing_month
      FROM subscription_billings sb
      WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = sb.subscription_id)
      ORDER BY sb.id
      LIMIT 100
    `
  }
];

async function run() {
  console.log("LoneGreen DB integrity audit (read-only)");
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

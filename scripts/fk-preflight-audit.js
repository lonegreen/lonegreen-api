#!/usr/bin/env node
"use strict";

/**
 * Read-only FK preflight audit for core relational links.
 * - SELECT only
 * - No UPDATE/DELETE/ALTER
 *
 * Usage:
 *   node scripts/fk-preflight-audit.js
 *   node scripts/fk-preflight-audit.js --strict
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db/pool");

const strict = process.argv.includes("--strict");

const checks = [
  {
    id: "users_company_missing",
    title: "users.company_id -> companies.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM users u
      WHERE u.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = u.company_id)
    `
  },
  {
    id: "clients_company_missing",
    title: "clients.company_id -> companies.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM clients c
      WHERE c.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)
    `
  },
  {
    id: "jobs_company_missing",
    title: "jobs.company_id -> companies.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM jobs j
      WHERE j.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = j.company_id)
    `
  },
  {
    id: "jobs_client_missing",
    title: "jobs.client_id -> clients.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM jobs j
      WHERE j.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = j.client_id)
    `
  },
  {
    id: "jobs_worker_missing",
    title: "jobs.worker_id -> workers.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM jobs j
      WHERE j.worker_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = j.worker_id)
    `
  },
  {
    id: "estimates_company_missing",
    title: "estimates.company_id -> companies.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM estimates e
      WHERE e.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = e.company_id)
    `
  },
  {
    id: "estimates_client_missing",
    title: "estimates.client_id -> clients.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM estimates e
      WHERE e.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = e.client_id)
    `
  },
  {
    id: "invoices_company_missing",
    title: "invoices.company_id -> companies.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM invoices i
      WHERE i.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = i.company_id)
    `
  },
  {
    id: "invoices_client_missing",
    title: "invoices.client_id -> clients.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM invoices i
      WHERE i.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = i.client_id)
    `
  },
  {
    id: "invoices_job_missing",
    title: "invoices.job_id -> jobs.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM invoices i
      WHERE i.job_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = i.job_id)
    `
  },
  {
    id: "payments_invoice_missing",
    title: "payments.invoice_id -> invoices.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM payments p
      WHERE p.invoice_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = p.invoice_id)
    `
  },
  {
    id: "subscriptions_company_missing",
    title: "subscriptions.company_id -> companies.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM subscriptions s
      WHERE s.company_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = s.company_id)
    `
  },
  {
    id: "subscriptions_client_missing",
    title: "subscriptions.client_id -> clients.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM subscriptions s
      WHERE s.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = s.client_id)
    `
  },
  {
    id: "subscriptions_worker_missing",
    title: "subscriptions.worker_id -> workers.id missing",
    sql: `
      SELECT COUNT(*)::int AS cnt
      FROM subscriptions s
      WHERE s.worker_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = s.worker_id)
    `
  }
];

async function run() {
  console.log("FairLinx FK preflight audit (read-only)");
  console.log("Started:", new Date().toISOString());
  console.log("");

  let flagged = 0;
  for (const check of checks) {
    const result = await pool.query(check.sql);
    const count = Number(result.rows[0] && result.rows[0].cnt ? result.rows[0].cnt : 0);
    flagged += count;
    const status = count > 0 ? "REVIEW" : "OK";
    console.log(`[${status}] ${check.title}: ${count}`);
  }

  console.log("");
  console.log("Total orphan/missing-reference rows:", flagged);
  console.log("Finished:", new Date().toISOString());

  await pool.end();
  if (strict && flagged > 0) {
    process.exit(1);
  }
}

run().catch(async (err) => {
  console.error("FK preflight audit failed:", err && (err.stack || err.message || err));
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});


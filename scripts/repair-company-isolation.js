#!/usr/bin/env node
/**
 * Phase 14 company isolation repair.
 *
 * Safe and idempotent:
 * - repairs rows only when a single tenant can be inferred from related data
 * - quarantines unresolved legacy rows into an inaccessible quarantine company
 * - logs every repair/quarantine in database tables
 */
"use strict";

const fs = require("fs/promises");
const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env")
});

const pool = require("../db/pool");

const migrationPath = path.join(__dirname, "..", "db", "migrations", "023_company_isolation_repair.sql");

async function counts() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM jobs WHERE company_id IS NULL) AS jobs_missing_company,
      (SELECT COUNT(*)::int FROM clients WHERE company_id IS NULL) AS clients_missing_company,
      (
        SELECT COUNT(*)::int
        FROM workers w
        WHERE w.company_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = w.company_id)
      ) AS workers_invalid_company,
      (
        SELECT COUNT(*)::int
        FROM company_isolation_repair_log
      ) AS repair_log_rows,
      (
        SELECT COUNT(*)::int
        FROM company_isolation_quarantine
      ) AS quarantine_rows
  `);

  return result.rows[0];
}

async function run() {
  console.log("Phase 14 company isolation repair");
  console.log("Started:", new Date().toISOString());

  const sql = await fs.readFile(migrationPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const summary = await counts();
  console.log("Summary:", JSON.stringify(summary, null, 2));
  console.log("Finished:", new Date().toISOString());
  await pool.end();
}

run().catch(async (err) => {
  console.error("Company isolation repair failed:", err.message || err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

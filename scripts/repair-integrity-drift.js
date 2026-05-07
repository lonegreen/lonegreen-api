#!/usr/bin/env node
/**
 * Conservative production data drift repair.
 *
 * Default mode is dry-run. Use --apply to run safe repairs in one transaction.
 * Destructive deletes are backed up to integrity_repair_backups first.
 */
"use strict";

const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env")
});

const pool = require("../db/pool");

const apply = process.argv.includes("--apply");
const repairRunId = `integrity-repair-${new Date().toISOString().replace(/[:.]/g, "-")}`;

function logSection(title) {
  console.log("");
  console.log(`== ${title} ==`);
}

function cleanIds(rows) {
  return rows.map(row => Number(row.id)).filter(id => Number.isInteger(id) && id > 0);
}

function distinctNonNull(values) {
  return Array.from(new Set(values.filter(value => value !== null && value !== undefined).map(Number)))
    .filter(value => Number.isInteger(value) && value > 0);
}

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS integrity_repair_backups (
      id BIGSERIAL PRIMARY KEY,
      repair_run_id TEXT NOT NULL,
      category TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id INTEGER,
      row_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function backupRowsById(client, category, tableName, ids) {
  if (!ids.length) return;

  await client.query(`
    INSERT INTO integrity_repair_backups (repair_run_id, category, table_name, row_id, row_data)
    SELECT $1, $2, $3, id, to_jsonb(${tableName})
    FROM ${tableName}
    WHERE id = ANY($4::int[])
  `, [repairRunId, category, tableName, ids]);
}

async function backupWorkerZipRows(client, category, rows) {
  if (!rows.length) return;

  for (const row of rows) {
    await client.query(`
      INSERT INTO integrity_repair_backups (repair_run_id, category, table_name, row_id, row_data)
      VALUES ($1, $2, 'worker_zip_groups', NULL, $3::jsonb)
    `, [repairRunId, category, JSON.stringify(row)]);
  }
}

async function findDuplicateSubscriptionVisits(client) {
  const groups = await client.query(`
    SELECT company_id, source_subscription_id, date, type, COUNT(*)::int AS count
    FROM jobs
    WHERE source_subscription_id IS NOT NULL
      AND type = 'subscription_visit'
    GROUP BY company_id, source_subscription_id, date, type
    HAVING COUNT(*) > 1
    ORDER BY company_id, source_subscription_id, date
  `);

  const safeDeletes = [];
  const manual = [];

  for (const group of groups.rows) {
    const jobs = await client.query(`
      SELECT
        jobs.*,
        (SELECT COUNT(*)::int FROM invoices WHERE invoices.job_id = jobs.id) AS invoice_count,
        (
          SELECT COUNT(*)::int
          FROM payments
          JOIN invoices ON invoices.id = payments.invoice_id
            AND invoices.company_id = payments.company_id
          WHERE invoices.job_id = jobs.id
        ) AS payment_count,
        (SELECT COUNT(*)::int FROM job_photos WHERE job_photos.job_id = jobs.id) AS photo_count
      FROM jobs
      WHERE company_id IS NOT DISTINCT FROM $1
        AND source_subscription_id = $2
        AND date = $3::date
        AND type = $4
      ORDER BY
        (
          (SELECT COUNT(*) FROM invoices WHERE invoices.job_id = jobs.id) +
          (
            SELECT COUNT(*)
            FROM payments
            JOIN invoices ON invoices.id = payments.invoice_id
              AND invoices.company_id = payments.company_id
            WHERE invoices.job_id = jobs.id
          ) +
          (SELECT COUNT(*) FROM job_photos WHERE job_photos.job_id = jobs.id)
        ) DESC,
        id ASC
    `, [group.company_id, group.source_subscription_id, group.date, group.type]);

    if (jobs.rows.length === 0) {
      manual.push({
        group,
        canonical_id: null,
        duplicate_ids: [],
        reason: "Duplicate group was found but child rows could not be reloaded"
      });
      continue;
    }

    const canonical = jobs.rows[0];
    const duplicates = jobs.rows.slice(1);
    const linkedDuplicates = duplicates.filter(row =>
      Number(row.invoice_count || 0) > 0 ||
      Number(row.payment_count || 0) > 0 ||
      Number(row.photo_count || 0) > 0
    );

    if (linkedDuplicates.length > 0) {
      manual.push({
        group,
        canonical_id: canonical.id,
        duplicate_ids: duplicates.map(row => row.id),
        reason: "One or more duplicate rows has invoice/payment/photo links"
      });
      continue;
    }

    safeDeletes.push({
      group,
      canonical_id: canonical.id,
      delete_ids: duplicates.map(row => row.id)
    });
  }

  return { groups: groups.rows, safeDeletes, manual };
}

async function repairDuplicateSubscriptionVisits(client, summary) {
  const analysis = await findDuplicateSubscriptionVisits(client);
  summary.duplicateSubscriptionVisits = analysis;

  logSection("Duplicate subscription visits");
  console.log(`Duplicate groups found: ${analysis.groups.length}`);
  console.log(`Safe duplicate jobs to delete: ${analysis.safeDeletes.reduce((sum, item) => sum + item.delete_ids.length, 0)}`);
  console.log(`Groups needing manual review: ${analysis.manual.length}`);

  if (!apply) return;

  const ids = analysis.safeDeletes.flatMap(item => item.delete_ids);
  await backupRowsById(client, "duplicate_subscription_visits", "jobs", ids);

  if (ids.length) {
    await client.query("DELETE FROM jobs WHERE id = ANY($1::int[])", [ids]);
  }
}

async function findJobsWithNullCompany(client) {
  const result = await client.query(`
    SELECT
      jobs.id,
      jobs.client_id,
      jobs.worker_id,
      jobs.source_subscription_id,
      jobs.estimate_id,
      clients.company_id AS client_company_id,
      workers.company_id AS worker_company_id,
      subscriptions.company_id AS subscription_company_id,
      estimates.company_id AS estimate_company_id,
      (
        SELECT ARRAY_AGG(DISTINCT invoices.company_id)
        FROM invoices
        WHERE invoices.job_id = jobs.id
          AND invoices.company_id IS NOT NULL
      ) AS invoice_company_ids
    FROM jobs
    LEFT JOIN clients ON clients.id = jobs.client_id
    LEFT JOIN workers ON workers.id = jobs.worker_id
    LEFT JOIN subscriptions ON subscriptions.id = jobs.source_subscription_id
    LEFT JOIN estimates ON estimates.id = jobs.estimate_id
    WHERE jobs.company_id IS NULL
    ORDER BY jobs.id
  `);

  const repairable = [];
  const manual = [];

  for (const row of result.rows) {
    const inferred = distinctNonNull([
      row.client_company_id,
      row.worker_company_id,
      row.subscription_company_id,
      row.estimate_company_id,
      ...((row.invoice_company_ids || []).map(Number))
    ]);

    if (inferred.length === 1) {
      repairable.push({ id: row.id, company_id: inferred[0] });
    } else {
      manual.push({
        id: row.id,
        inferred_company_ids: inferred,
        reason: inferred.length === 0 ? "No trusted company source found" : "Conflicting company sources"
      });
    }
  }

  return { rows: result.rows, repairable, manual };
}

async function repairJobsWithNullCompany(client, summary) {
  const analysis = await findJobsWithNullCompany(client);
  summary.jobsWithNullCompany = analysis;

  logSection("Jobs with NULL company_id");
  console.log(`Rows found: ${analysis.rows.length}`);
  console.log(`Repairable: ${analysis.repairable.length}`);
  console.log(`Manual review: ${analysis.manual.length}`);

  if (!apply) return;

  await backupRowsById(client, "jobs_null_company_id", "jobs", analysis.repairable.map(row => row.id));
  for (const row of analysis.repairable) {
    await client.query(
      "UPDATE jobs SET company_id = $1 WHERE id = $2 AND company_id IS NULL",
      [row.company_id, row.id]
    );
  }
}

async function repairJobWorkerMismatches(client, summary) {
  const result = await client.query(`
    SELECT jobs.id, jobs.company_id AS job_company_id, jobs.worker_id, workers.company_id AS worker_company_id
    FROM jobs
    INNER JOIN workers ON workers.id = jobs.worker_id
    WHERE jobs.worker_id IS NOT NULL
      AND jobs.company_id IS NOT NULL
      AND workers.company_id IS NOT NULL
      AND jobs.company_id <> workers.company_id
    ORDER BY jobs.id
  `);

  summary.jobWorkerMismatches = { rows: result.rows };

  logSection("Job/worker company mismatches");
  console.log(`Rows found: ${result.rows.length}`);
  console.log(`Repair action: set jobs.worker_id = NULL`);

  if (!apply) return;

  const ids = cleanIds(result.rows);
  await backupRowsById(client, "job_worker_company_mismatch", "jobs", ids);
  if (ids.length) {
    await client.query("UPDATE jobs SET worker_id = NULL WHERE id = ANY($1::int[])", [ids]);
  }
}

async function repairSubscriptionWorkerMismatches(client, summary) {
  const result = await client.query(`
    SELECT subscriptions.id, subscriptions.company_id AS subscription_company_id,
           subscriptions.worker_id, workers.company_id AS worker_company_id
    FROM subscriptions
    INNER JOIN workers ON workers.id = subscriptions.worker_id
    WHERE subscriptions.worker_id IS NOT NULL
      AND subscriptions.company_id IS NOT NULL
      AND workers.company_id IS NOT NULL
      AND subscriptions.company_id <> workers.company_id
    ORDER BY subscriptions.id
  `);

  summary.subscriptionWorkerMismatches = { rows: result.rows };

  logSection("Subscription/worker company mismatches");
  console.log(`Rows found: ${result.rows.length}`);
  console.log(`Repair action: set subscriptions.worker_id = NULL`);

  if (!apply) return;

  const ids = cleanIds(result.rows);
  await backupRowsById(client, "subscription_worker_company_mismatch", "subscriptions", ids);
  if (ids.length) {
    await client.query("UPDATE subscriptions SET worker_id = NULL WHERE id = ANY($1::int[])", [ids]);
  }
}

async function repairWorkerZipGroupMismatches(client, summary) {
  const result = await client.query(`
    SELECT wzg.company_id, wzg.worker_id, wzg.group_id,
           workers.company_id AS worker_company_id,
           zip_groups.company_id AS group_company_id
    FROM worker_zip_groups wzg
    LEFT JOIN workers ON workers.id = wzg.worker_id
    LEFT JOIN zip_groups ON zip_groups.id = wzg.group_id
    WHERE (
        workers.id IS NOT NULL
        AND workers.company_id IS NOT NULL
        AND wzg.company_id IS NOT NULL
        AND wzg.company_id <> workers.company_id
      )
      OR (
        zip_groups.id IS NOT NULL
        AND zip_groups.company_id IS NOT NULL
        AND wzg.company_id IS NOT NULL
        AND wzg.company_id <> zip_groups.company_id
      )
    ORDER BY wzg.company_id, wzg.worker_id, wzg.group_id
  `);

  const safeDeletes = result.rows.filter(row => row.worker_company_id && row.group_company_id);
  const manual = result.rows.filter(row => !row.worker_company_id || !row.group_company_id);
  summary.workerZipGroupMismatches = { rows: result.rows, safeDeletes, manual };

  logSection("Worker ZIP group mismatches");
  console.log(`Rows found: ${result.rows.length}`);
  console.log(`Safe join rows to delete: ${safeDeletes.length}`);
  console.log(`Manual review: ${manual.length}`);

  if (!apply) return;

  await backupWorkerZipRows(client, "worker_zip_group_company_mismatch", safeDeletes);
  for (const row of safeDeletes) {
    await client.query(`
      DELETE FROM worker_zip_groups
      WHERE company_id = $1 AND worker_id = $2 AND group_id = $3
    `, [row.company_id, row.worker_id, row.group_id]);
  }
}

async function repairZipCodeGroupMismatches(client, summary) {
  const result = await client.query(`
    SELECT zip_codes.id, zip_codes.company_id AS zip_code_company_id,
           zip_codes.group_id, zip_groups.company_id AS group_company_id
    FROM zip_codes
    INNER JOIN zip_groups ON zip_groups.id = zip_codes.group_id
    WHERE zip_codes.company_id IS NOT NULL
      AND zip_groups.company_id IS NOT NULL
      AND zip_codes.company_id <> zip_groups.company_id
    ORDER BY zip_codes.id
  `);

  summary.zipCodeGroupMismatches = { rows: result.rows };

  logSection("ZIP code group/company mismatches");
  console.log(`Rows found: ${result.rows.length}`);
  console.log("Repair action: set zip_codes.company_id = linked zip_groups.company_id");

  if (!apply) return;

  await backupRowsById(client, "zip_code_group_company_mismatch", "zip_codes", cleanIds(result.rows));
  for (const row of result.rows) {
    await client.query(
      "UPDATE zip_codes SET company_id = $1 WHERE id = $2",
      [row.group_company_id, row.id]
    );
  }
}

async function checkMigrationReadiness(client) {
  const result = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT 1
      FROM jobs
      WHERE source_subscription_id IS NOT NULL
        AND type = 'subscription_visit'
      GROUP BY company_id, source_subscription_id, date, type
      HAVING COUNT(*) > 1
    ) duplicates
  `);

  return Number(result.rows[0].count || 0) === 0;
}

async function run() {
  const client = await pool.connect();
  const summary = {};

  console.log(`FairLinx integrity repair ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`repair_run_id: ${repairRunId}`);

  try {
    if (apply) {
      await client.query("BEGIN");
      await ensureBackupTable(client);
    }

    await repairDuplicateSubscriptionVisits(client, summary);
    await repairJobsWithNullCompany(client, summary);
    await repairJobWorkerMismatches(client, summary);
    await repairSubscriptionWorkerMismatches(client, summary);
    await repairWorkerZipGroupMismatches(client, summary);
    await repairZipCodeGroupMismatches(client, summary);

    const migrationReady = await checkMigrationReadiness(client);

    if (apply) {
      await client.query("COMMIT");
    }

    logSection("Summary");
    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`Backups table used: ${apply ? "integrity_repair_backups" : "not created in dry-run"}`);
    console.log(`Migration 026 duplicate preflight ready: ${migrationReady ? "yes" : "no"}`);
    console.log("Manual review counts:", JSON.stringify({
      duplicate_subscription_visit_groups: summary.duplicateSubscriptionVisits.manual.length,
      jobs_null_company_id: summary.jobsWithNullCompany.manual.length,
      worker_zip_groups: summary.workerZipGroupMismatches.manual.length
    }));
  } catch (err) {
    if (apply) {
      await client.query("ROLLBACK");
    }
    console.error("Integrity repair failed:", err && (err.stack || err.message || err));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(async (err) => {
  console.error("Integrity repair failed:", err && (err.stack || err.message || err));
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});

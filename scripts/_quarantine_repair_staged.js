#!/usr/bin/env node
/**
 * Staged repair: remap orphan company_id values to quarantine company #31.
 * Usage: node scripts/_quarantine_repair_staged.js [--apply]
 */
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const pool = require("../db/pool");

const QUARANTINE_COMPANY_ID = 31;
/** Approved orphan company_id values to remap to quarantine (must match DB discovery exactly). */
const APPROVED_STALE_IDS = [
  1, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27
];
const EXPECTED_STALE_COUNT = APPROVED_STALE_IDS.length;

const apply = process.argv.includes("--apply");
const repairRunId = `quarantine-repair-${new Date().toISOString().replace(/[:.]/g, "-") }`;

const REPORT = {
  started_at: new Date().toISOString(),
  repair_run_id: repairRunId,
  apply,
  stages: [],
  stopped_reason: null
};

async function listCompanyIdTables(client) {
  const r = await client.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'company_id'
    ORDER BY table_name
  `);
  return r.rows.map((row) => row.table_name);
}

async function discoverStaleIds(client) {
  const tables = await listCompanyIdTables(client);
  const ids = new Set();
  for (const tn of tables) {
    let r;
    try {
      r = await client.query(`
        SELECT DISTINCT t.company_id AS cid
        FROM ${tn} t
        WHERE t.company_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.company_id)
      `);
    } catch (err) {
      if (err && err.code === "42P01") continue;
      throw err;
    }
    for (const row of r.rows) {
      if (row.cid != null) ids.add(Number(row.cid));
    }
  }
  return { tables, stale_ids: Array.from(ids).sort((a, b) => a - b) };
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

async function snapshotRows(client, tableName, staleIds) {
  if (!staleIds.length) return 0;
  let rows;
  try {
    const res = await client.query(
      `SELECT * FROM ${tableName} WHERE company_id = ANY($1::int[])`,
      [staleIds]
    );
    rows = res.rows;
  } catch (err) {
    if (err && err.code === "42P01") return 0;
    throw err;
  }
  for (const row of rows) {
    const pk = Object.prototype.hasOwnProperty.call(row, "id") ? row.id : null;
    await client.query(
      `
      INSERT INTO integrity_repair_backups (repair_run_id, category, table_name, row_id, row_data)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [repairRunId, "pre_quarantine_remap", tableName, pk, JSON.stringify(row)]
    );
  }
  return rows.length;
}

async function remapTable(client, tableName, staleIds) {
  if (!staleIds.length) return 0;
  const ph = staleIds.map((_, i) => `$${i + 2}`).join(", ");
  const sql = `
    UPDATE ${tableName}
    SET company_id = $1
    WHERE company_id IN (${ph})
  `;
  const params = [QUARANTINE_COMPANY_ID, ...staleIds];
  let res;
  try {
    res = await client.query(sql, params);
  } catch (err) {
    if (err && err.code === "42P01") return 0;
    throw err;
  }
  return res.rowCount || 0;
}

/**
 * invoice_counters.company_id is PRIMARY KEY — cannot UPDATE multiple rows to the same id.
 * Merge MAX(last_value) into quarantine row, delete stale rows, upsert target.
 */
async function remapInvoiceCountersToQuarantine(client, staleIds, quarantineId) {
  const maxR = await client.query(
    `
    SELECT COALESCE(MAX(last_value), 0)::int AS m
    FROM invoice_counters
    WHERE company_id = ANY($1::int[])
       OR company_id = $2
    `,
    [staleIds, quarantineId]
  );
  const mergedMax = Number(maxR.rows[0].m || 0);
  const del = await client.query(
    `DELETE FROM invoice_counters WHERE company_id = ANY($1::int[])`,
    [staleIds]
  );
  await client.query(
    `
    INSERT INTO invoice_counters (company_id, last_value, updated_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (company_id) DO UPDATE SET
      last_value = GREATEST(invoice_counters.last_value, EXCLUDED.last_value),
      updated_at = CURRENT_TIMESTAMP
    `,
    [quarantineId, mergedMax]
  );
  return Number(del.rowCount || 0);
}

function sortedCopy(nums) {
  return [...nums].sort((a, b) => a - b);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Rows that would be updated per table (read-only). */
async function countRemapImpact(client, tableNames, staleIds) {
  const byTable = {};
  const byStaleId = {};
  for (const id of staleIds) byStaleId[id] = {};
  let total = 0;

  for (const tn of tableNames) {
    try {
      const res = await client.query(
        `
        SELECT company_id::int AS cid, COUNT(*)::bigint AS n
        FROM ${tn}
        WHERE company_id = ANY($1::int[])
        GROUP BY company_id
        ORDER BY company_id
        `,
        [staleIds]
      );
      let tableSum = 0;
      for (const row of res.rows) {
        const n = Number(row.n);
        const cid = Number(row.cid);
        tableSum += n;
        byStaleId[cid][tn] = n;
      }
      if (tableSum > 0) byTable[tn] = tableSum;
      total += tableSum;
    } catch (err) {
      if (err && err.code === "42P01") continue;
      throw err;
    }
  }
  return { byTable, byStaleId, totalRowsWouldChange: total };
}

async function verifyQuarantineExists(client) {
  const r = await client.query("SELECT id, name FROM companies WHERE id = $1", [
    QUARANTINE_COMPANY_ID
  ]);
  if (!r.rows.length) {
    throw new Error(`VERIFICATION FAILED: companies row id=${QUARANTINE_COMPANY_ID} missing`);
  }
  return r.rows[0];
}

/** V1: No company_id anywhere references a missing companies row. */
async function verifyV1_noOrphanCompanyRefs(client) {
  const { stale_ids } = await discoverStaleIds(client);
  if (stale_ids.length > 0) {
    throw new Error(
      `V1 FAILED: orphan company_id values remain: ${JSON.stringify(stale_ids)}`
    );
  }
  return { pass: true, stale_distinct_count: 0 };
}

/** V2: Core tenant tables — company_id must resolve to companies (fk-preflight set). */
async function verifyV2_fkCoreCompanyOrphans(client) {
  return fkPreflightZero(client);
}

/** V3: Remapped rows must not still carry any approved stale id (all moved to quarantine). */
async function verifyV3_noAllowlistCompanyIdsRemain(client, staleIds) {
  const tables = await listCompanyIdTables(client);
  const detail = {};
  let total = 0;
  for (const tn of tables) {
    try {
      const r = await client.query(
        `SELECT COUNT(*)::bigint AS n FROM ${tn} WHERE company_id = ANY($1::int[])`,
        [staleIds]
      );
      const n = Number(r.rows[0].n || 0);
      if (n > 0) detail[tn] = n;
      total += n;
    } catch (err) {
      if (err && err.code === "42P01") continue;
      throw err;
    }
  }
  if (total > 0) {
    throw new Error(
      `V3 FAILED: ${total} rows still have company_id in approved stale allowlist: ${JSON.stringify(detail)}`
    );
  }
  return { pass: true, rows_with_old_stale_ids: 0 };
}

/** V4: Jobs tenant matches linked client tenant. */
async function verifyV4_jobsClientCompanyAligned(client) {
  const r = await client.query(`
    SELECT COUNT(*)::int AS cnt
    FROM jobs j
    INNER JOIN clients c ON c.id = j.client_id
    WHERE j.company_id IS NOT NULL
      AND c.company_id IS NOT NULL
      AND j.company_id <> c.company_id
  `);
  const cnt = Number(r.rows[0].cnt || 0);
  if (cnt > 0) {
    throw new Error(`V4 FAILED: jobs/client company_id mismatch count=${cnt}`);
  }
  return { pass: true, mismatch_count: 0 };
}

/** V5: Payment company matches invoice company. */
async function verifyV5_paymentsInvoiceCompanyAligned(client) {
  const r = await client.query(`
    SELECT COUNT(*)::int AS cnt
    FROM payments p
    INNER JOIN invoices i ON i.id = p.invoice_id
    WHERE p.company_id IS NOT NULL
      AND i.company_id IS NOT NULL
      AND p.company_id <> i.company_id
  `);
  const cnt = Number(r.rows[0].cnt || 0);
  if (cnt > 0) {
    throw new Error(`V5 FAILED: payments/invoice company_id mismatch count=${cnt}`);
  }
  return { pass: true, mismatch_count: 0 };
}

/** V6: No duplicate subscription_visit job groups (same company + subscription + date). */
async function verifyV6_noDuplicateSubscriptionVisitGroups(client) {
  const r = await client.query(`
    SELECT COUNT(*)::int AS cnt
    FROM (
      SELECT 1
      FROM jobs
      WHERE source_subscription_id IS NOT NULL
        AND type = 'subscription_visit'
      GROUP BY company_id, source_subscription_id, date, type
      HAVING COUNT(*) > 1
    ) dup
  `);
  const cnt = Number(r.rows[0].cnt || 0);
  if (cnt > 0) {
    throw new Error(`V6 FAILED: duplicate subscription_visit groups count=${cnt}`);
  }
  return { pass: true, duplicate_groups: 0 };
}

/** After remapping many tenants into one company_id, duplicate subscription_visit rows may appear. */
async function findDuplicateSubscriptionVisitsForDedupe(client) {
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
    const jobs = await client.query(
      `
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
      `,
      [group.company_id, group.source_subscription_id, group.date, group.type]
    );

    if (jobs.rows.length === 0) {
      manual.push({ group, reason: "reload_failed" });
      continue;
    }

    const canonical = jobs.rows[0];
    const duplicates = jobs.rows.slice(1);
    const linkedDuplicates = duplicates.filter(
      (row) =>
        Number(row.invoice_count || 0) > 0 ||
        Number(row.payment_count || 0) > 0 ||
        Number(row.photo_count || 0) > 0
    );

    if (linkedDuplicates.length > 0) {
      manual.push({
        group,
        canonical_id: canonical.id,
        reason: "duplicate_has_invoice_payment_or_photo"
      });
      continue;
    }

    safeDeletes.push({
      delete_ids: duplicates.map((row) => row.id)
    });
  }

  return { groups: groups.rows, safeDeletes, manual };
}

async function dedupeSubscriptionVisitJobsSafe(client) {
  const analysis = await findDuplicateSubscriptionVisitsForDedupe(client);
  if (analysis.manual.length > 0) {
    throw new Error(
      `dedupe subscription_visit FAILED: ${analysis.manual.length} group(s) need manual repair: ${JSON.stringify(analysis.manual)}`
    );
  }
  const ids = analysis.safeDeletes.flatMap((item) => item.delete_ids);
  if (ids.length) {
    await client.query(
      `
      INSERT INTO integrity_repair_backups (repair_run_id, category, table_name, row_id, row_data)
      SELECT $1, 'dedupe_subscription_visit', 'jobs', jobs.id, to_jsonb(jobs.*)
      FROM jobs
      WHERE jobs.id = ANY($2::int[])
      `,
      [repairRunId, ids]
    );
    await client.query(`DELETE FROM jobs WHERE id = ANY($1::int[])`, [ids]);
  }
  return {
    duplicate_groups_before: analysis.groups.length,
    jobs_deleted: ids.length
  };
}

async function runPostRemapVerificationsV1ThroughV6(client, staleIds) {
  const v1 = await verifyV1_noOrphanCompanyRefs(client);
  const v2 = await verifyV2_fkCoreCompanyOrphans(client);
  const v3 = await verifyV3_noAllowlistCompanyIdsRemain(client, staleIds);
  const v4 = await verifyV4_jobsClientCompanyAligned(client);
  const v5 = await verifyV5_paymentsInvoiceCompanyAligned(client);
  const v6 = await verifyV6_noDuplicateSubscriptionVisitGroups(client);
  return { v1, v2, v3, v4, v5, v6, all_pass: true };
}

async function fkPreflightZero(client) {
  const checks = [
    `SELECT COUNT(*)::int AS cnt FROM users u WHERE u.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = u.company_id)`,
    `SELECT COUNT(*)::int AS cnt FROM clients c WHERE c.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)`,
    `SELECT COUNT(*)::int AS cnt FROM jobs j WHERE j.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = j.company_id)`,
    `SELECT COUNT(*)::int AS cnt FROM estimates e WHERE e.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = e.company_id)`,
    `SELECT COUNT(*)::int AS cnt FROM invoices i WHERE i.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = i.company_id)`,
    `SELECT COUNT(*)::int AS cnt FROM payments p WHERE p.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.company_id)`,
    `SELECT COUNT(*)::int AS cnt FROM subscriptions s WHERE s.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = s.company_id)`
  ];
  const out = {};
  let sum = 0;
  for (let i = 0; i < checks.length; i++) {
    const x = await client.query(checks[i]);
    const cnt = Number(x.rows[0].cnt || 0);
    out[`check_${i}`] = cnt;
    sum += cnt;
  }
  if (sum > 0) {
    throw new Error(`VERIFICATION FAILED: fk preflight orphan sum=${sum} ${JSON.stringify(out)}`);
  }
  return out;
}

async function runMigration060(client) {
  const migrationPath = path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "060_critical_ownership_fk_hardening.sql"
  );
  const sql = await fs.promises.readFile(migrationPath, "utf8");
  await client.query(sql);
}

async function main() {
  const client = await pool.connect();

  try {
    console.log(`Quarantine repair ${apply ? "APPLY" : "DRY-RUN"} — target company ${QUARANTINE_COMPANY_ID}`);

    const qc = await verifyQuarantineExists(client);
    REPORT.quarantine_company = qc;

    const discovered = await discoverStaleIds(client);
    REPORT.discovered = discovered;
    REPORT.approved_allowlist = APPROVED_STALE_IDS;

    const sortedApproved = sortedCopy(APPROVED_STALE_IDS);
    const sortedDiscovered = sortedCopy(discovered.stale_ids);

    console.log(
      `Discovered ${discovered.stale_ids.length} stale company IDs:`,
      JSON.stringify(discovered.stale_ids)
    );
    console.log(`Tables scanned with company_id: ${discovered.tables.length}`);

    if (discovered.stale_ids.length !== EXPECTED_STALE_COUNT) {
      throw new Error(
        `VERIFICATION FAILED: expected exactly ${EXPECTED_STALE_COUNT} stale IDs, found ${discovered.stale_ids.length}`
      );
    }

    if (!arraysEqual(sortedDiscovered, sortedApproved)) {
      throw new Error(
        "VERIFICATION FAILED: discovered stale IDs do not match APPROVED_STALE_IDS.\n" +
        `  discovered: ${JSON.stringify(sortedDiscovered)}\n` +
        `  approved:   ${JSON.stringify(sortedApproved)}`
      );
    }

    const impact = await countRemapImpact(client, discovered.tables, APPROVED_STALE_IDS);
    REPORT.dry_run = {
      mode: "no_mutations",
      quarantine_target_id: QUARANTINE_COMPANY_ID,
      stale_id_count_verified: EXPECTED_STALE_COUNT,
      allowlist_matches_discovery: true,
      rows_impact: impact
    };

    if (!apply) {
      REPORT.stopped_reason = "dry_run_ok_no_apply_flag";
      REPORT.summary = {
        would_update_total_rows: impact.totalRowsWouldChange,
        tables_with_updates: Object.keys(impact.byTable).length
      };
      console.log("Dry-run OK — no rows modified.");
      console.log(`Would update ${impact.totalRowsWouldChange} rows across ${Object.keys(impact.byTable).length} tables.`);
      console.log("Re-run with --apply to execute snapshot + remap + post-checks + 060.");
    } else {
    await client.query("BEGIN");
    await ensureBackupTable(client);

    let snapTotal = 0;
    let updTotal = 0;
    for (const tn of discovered.tables) {
      if (tn === "invoice_counters") {
        const s = await snapshotRows(client, tn, discovered.stale_ids);
        snapTotal += s;
        const u = await remapInvoiceCountersToQuarantine(
          client,
          APPROVED_STALE_IDS,
          QUARANTINE_COMPANY_ID
        );
        updTotal += u;
        if (s || u) {
          REPORT.stages.push({
            table: tn,
            snapshot_rows: s,
            updated_rows: u,
            note: "merged PK company_id into quarantine (invoice_counters)"
          });
        }
        continue;
      }
      const s = await snapshotRows(client, tn, discovered.stale_ids);
      snapTotal += s;
      const u = await remapTable(client, tn, discovered.stale_ids);
      updTotal += u;
      if (s || u) REPORT.stages.push({ table: tn, snapshot_rows: s, updated_rows: u });
    }

    REPORT.snapshot_total_rows = snapTotal;
    REPORT.updated_total_rows = updTotal;

    const dedupe = await dedupeSubscriptionVisitJobsSafe(client);
    REPORT.subscription_visit_dedupe = dedupe;

    const v1v6 = await runPostRemapVerificationsV1ThroughV6(
      client,
      APPROVED_STALE_IDS
    );
    REPORT.verifications_v1_v6 = v1v6;

    await runMigration060(client);
    REPORT.migration_060 = "executed";

    await client.query("COMMIT");
    REPORT.completed_at = new Date().toISOString();
    console.log("COMMIT ok", { snapTotal, updTotal });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    REPORT.stopped_reason = err.message || String(err);
    console.error("STOPPED:", REPORT.stopped_reason);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  const reportPath = path.join(__dirname, "..", `repair-report-${repairRunId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(REPORT, null, 2), "utf8");
  console.log("Report:", reportPath);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});

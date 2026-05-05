#!/usr/bin/env node
/**
 * Restore validation only — does NOT modify the database.
 * Verifies dump file exists, non-empty, and pg_restore can read the TOC (integrity).
 *
 * Usage:
 *   node scripts/validate-backup.js backups/lonegreen-backup-2026-05-03-12-00-00.dump
 *   node scripts/validate-backup.js path/to/file.dump --json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true
});

function usage() {
  console.error("Usage: node scripts/validate-backup.js <path-to.dump> [--json]");
  process.exit(1);
}

function runPgRestoreList(dumpPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("pg_restore", ["-l", dumpPath], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(stderr.trim() || `pg_restore -l exited ${code}`);
        err.code = "PG_RESTORE_LIST_FAILED";
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const jsonOut = process.argv.includes("--json");

  if (!args.length) {
    usage();
  }

  const rel = args[0];
  const resolved = path.resolve(process.cwd(), rel);

  const result = {
    ok: false,
    path: resolved,
    exists: false,
    size_bytes: 0,
    toc_lines: 0,
    dry_run: true,
    message: ""
  };

  try {
    if (!fs.existsSync(resolved)) {
      result.message = "Backup file not found";
      throw new Error(result.message);
    }
    result.exists = true;

    const st = fs.statSync(resolved);
    result.size_bytes = st.size;
    if (!st.isFile() || st.size < 64) {
      result.message = "Backup file is empty or too small to be a valid custom dump";
      throw new Error(result.message);
    }

    const listing = await runPgRestoreList(resolved);
    const lines = listing.split("\n").filter((l) => l.trim().length);
    result.toc_lines = lines.length;
    if (result.toc_lines < 1) {
      result.message = "pg_restore listing produced no lines";
      throw new Error(result.message);
    }

    result.ok = true;
    result.message = "Backup integrity check passed (list-only; no database changes)";
  } catch (err) {
    result.ok = false;
    if (!result.message) {
      result.message = err && err.message ? err.message : String(err);
    }
  }

  const logLine = JSON.stringify({
    ts: new Date().toISOString(),
    event: "backup_validate",
    ...result
  });
  try {
    const logDir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "restore-validation.log"), logLine + "\n", "utf8");
  } catch {
    /* optional log */
  }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log("OK:", result.message);
    console.log("Path:", result.path);
    console.log("Size (bytes):", result.size_bytes);
    console.log("TOC lines:", result.toc_lines);
  } else {
    console.error("FAILED:", result.message);
    console.error("Path:", result.path);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("VALIDATE BACKUP ERROR:", err);
  process.exit(1);
});

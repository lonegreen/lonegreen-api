#!/usr/bin/env node
/**
 * PostgreSQL native backup (pg_dump custom format).
 * Timestamped file, rotation, JSON lines in backups/backup.log
 *
 * Env:
 *   DATABASE_URL (required)
 *   BACKUP_DIR — optional override directory
 *   BACKUP_KEEP_COUNT — max dumps to keep after rotation (default 30)
 *   BACKUP_MAX_AGE_DAYS — delete dumps older than this (default 45), always keeps ≥1 newest
 */
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
  quiet: true
});

const { runBackup } = require("../services/backupService");
const logger = require("../services/logger");

async function main() {
  try {
    const summary = await runBackup({ trigger: "cli" });
    console.log(`Backup created: ${summary.path}`);
    console.log(`Size: ${summary.size_bytes} bytes`);
    if (summary.rotation && summary.rotation.removed.length) {
      console.log(`Rotation removed: ${summary.rotation.removed.join(", ")}`);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error("pg_dump is not installed or is not available on PATH.");
    } else if (err && err.code === "EPERM") {
      console.error("Unable to start pg_dump. Permission was denied or the executable is blocked.");
    } else {
      console.error(err.message || String(err));
      logger.error("BACKUP_CLI_FAILED", err);
    }
    process.exit(1);
  }
}

main();

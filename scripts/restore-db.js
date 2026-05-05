const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true
});

function usage() {
  console.log("Usage: node scripts/restore-db.js backups/file.dump --yes");
}

function runRestore() {
  const databaseUrl = process.env.DATABASE_URL;
  const args = process.argv.slice(2);
  const backupFile = args.find(arg => arg !== "--yes");
  const confirmed = args.includes("--yes");

  if (!databaseUrl) {
    console.error("DATABASE_URL is required to run a database restore.");
    process.exit(1);
  }

  if (!backupFile) {
    console.error("Backup file path is required.");
    usage();
    process.exit(1);
  }

  if (!confirmed) {
    console.error("Restore is destructive. Re-run with --yes to confirm.");
    usage();
    process.exit(1);
  }

  const resolvedBackupPath = path.resolve(process.cwd(), backupFile);

  if (!fs.existsSync(resolvedBackupPath)) {
    console.error(`Backup file not found: ${resolvedBackupPath}`);
    process.exit(1);
  }

  let child;

  try {
    child = spawn("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      `--dbname=${databaseUrl}`,
      resolvedBackupPath
    ], {
      stdio: ["ignore", "inherit", "pipe"],
      shell: false
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("pg_restore is not installed or is not available on PATH.");
    } else if (err.code === "EPERM") {
      console.error("Unable to start pg_restore. Permission was denied or the executable is blocked.");
    } else {
      console.error("Unable to start pg_restore:", err.message);
    }
    process.exit(1);
  }

  let stderr = "";

  child.stderr.on("data", chunk => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  child.on("error", err => {
    if (err.code === "ENOENT") {
      console.error("pg_restore is not installed or is not available on PATH.");
    } else if (err.code === "EPERM") {
      console.error("Unable to start pg_restore. Permission was denied or the executable is blocked.");
    } else {
      console.error("Unable to start pg_restore:", err.message);
    }
    process.exit(1);
  });

  child.on("close", code => {
    if (code !== 0) {
      console.error(`pg_restore failed with exit code ${code}.`);
      if (!stderr.trim()) {
        console.error("No pg_restore error output was provided.");
      }
      process.exit(code || 1);
    }

    console.log(`Restore completed from: ${resolvedBackupPath}`);
  });
}

runRestore();

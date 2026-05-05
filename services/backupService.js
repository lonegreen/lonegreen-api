const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const logger = require("./logger");

const DEFAULT_BACKUP_DIR = path.join(__dirname, "..", "backups");
const DUMP_NAME_RE = /^lonegreen-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.dump$/;

function getBackupDir() {
  const raw = String(process.env.BACKUP_DIR || "").trim();
  return raw ? path.resolve(process.cwd(), raw) : DEFAULT_BACKUP_DIR;
}

function timestampForFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("-");
}

function appendBackupLog(entry) {
  try {
    const dir = getBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "backup.log");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry
    }) + "\n";
    fs.appendFileSync(logPath, line, { encoding: "utf8" });
    trimLogIfHuge(logPath);
  } catch (err) {
    logger.warn("BACKUP_LOG_WRITE_FAILED", { error: err && err.message });
  }
}

function trimLogIfHuge(logPath, maxBytes = 5 * 1024 * 1024) {
  try {
    const st = fs.statSync(logPath);
    if (st.size <= maxBytes) {
      return;
    }
    const tail = fs.readFileSync(logPath, { encoding: "utf8" }).slice(-Math.floor(maxBytes / 2));
    fs.writeFileSync(logPath, tail, { encoding: "utf8" });
  } catch {
    /* ignore */
  }
}

function listDumpFiles(backupDir) {
  if (!fs.existsSync(backupDir)) {
    return [];
  }
  return fs.readdirSync(backupDir)
    .filter((name) => DUMP_NAME_RE.test(name))
    .map((name) => {
      const full = path.join(backupDir, name);
      const st = fs.statSync(full);
      return { name, path: full, mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Deletes older dumps by age and by excess count. Keeps at least one newest file if any exist.
 */
function rotateBackups(backupDir, options = {}) {
  const keepCount = Math.max(1, Number(options.keepCount || process.env.BACKUP_KEEP_COUNT || 30));
  const maxAgeDays = Math.max(1, Number(options.maxAgeDays || process.env.BACKUP_MAX_AGE_DAYS || 45));
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const files = listDumpFiles(backupDir);
  if (!files.length) {
    return { removed: [], kept: 0 };
  }

  const removed = [];
  let remaining = files.slice();

  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const f = remaining[i];
    if (remaining.length <= 1) {
      break;
    }
    if (now - f.mtimeMs > maxAgeMs) {
      try {
        fs.unlinkSync(f.path);
        removed.push(f.name);
        remaining.splice(i, 1);
      } catch (err) {
        logger.warn("BACKUP_ROTATION_DELETE_FAILED", { file: f.name, error: err && err.message });
      }
    }
  }

  while (remaining.length > keepCount) {
    const oldest = remaining[remaining.length - 1];
    try {
      fs.unlinkSync(oldest.path);
      removed.push(oldest.name);
      remaining.pop();
    } catch (err) {
      logger.warn("BACKUP_ROTATION_COUNT_DELETE_FAILED", { file: oldest.name, error: err && err.message });
      break;
    }
  }

  return { removed, kept: remaining.length };
}

function runPgDump(backupPath, databaseUrl) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("pg_dump", [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        databaseUrl,
        "-f",
        backupPath
      ], {
        stdio: ["ignore", "inherit", "pipe"],
        shell: false
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`pg_dump failed with exit code ${code}: ${stderr.slice(0, 2000)}`);
        err.code = "PG_DUMP_FAILED";
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Creates a timestamped custom-format dump under BACKUP_DIR (or default backups/), rotates old files, logs outcome.
 */
async function runBackup(options = {}) {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    const err = new Error("DATABASE_URL is required to run a database backup.");
    err.code = "MISSING_DATABASE_URL";
    throw err;
  }

  const backupDir = options.backupDir || getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  const filename = `lonegreen-backup-${timestampForFilename()}.dump`;
  const backupPath = path.join(backupDir, filename);
  const started = Date.now();

  appendBackupLog({
    event: "backup_start",
    path: backupPath,
    trigger: options.trigger || "cli"
  });

  try {
    await runPgDump(backupPath, databaseUrl);
  } catch (err) {
    appendBackupLog({
      event: "backup_failed",
      path: backupPath,
      trigger: options.trigger || "cli",
      error: err && err.message ? err.message : String(err)
    });
    try {
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
    } catch {
      /* ignore */
    }
    throw err;
  }

  let size = 0;
  try {
    size = fs.statSync(backupPath).size;
  } catch {
    /* ignore */
  }

  const rotation = rotateBackups(backupDir, options);

  appendBackupLog({
    event: "backup_success",
    path: backupPath,
    size_bytes: size,
    duration_ms: Date.now() - started,
    trigger: options.trigger || "cli",
    rotation_removed: rotation.removed,
    rotation_kept: rotation.kept
  });

  logger.info("DATABASE_BACKUP_OK", {
    path: backupPath,
    size_bytes: size,
    rotation_removed: rotation.removed.length
  });

  return {
    path: backupPath,
    filename,
    size_bytes: size,
    duration_ms: Date.now() - started,
    rotation
  };
}

function listRecentBackups(limit = 20) {
  const backupDir = getBackupDir();
  return listDumpFiles(backupDir).slice(0, Math.max(1, Number(limit) || 20));
}

module.exports = {
  getBackupDir,
  runBackup,
  listRecentBackups,
  rotateBackups,
  appendBackupLog,
  DUMP_NAME_RE
};

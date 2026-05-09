const pool = require("../db/pool");
const logger = require("./logger");

const DEFAULT_MAX_QUEUE_SIZE = Number(process.env.JOB_QUEUE_MAX_SIZE || 500);
const MAX_ATTEMPTS = Number(process.env.JOB_QUEUE_MAX_ATTEMPTS || 3);
const BASE_BACKOFF_MS = Number(process.env.JOB_QUEUE_BASE_BACKOFF_MS || 1000);
const UNKNOWN_HANDLER_RETRY_MS = Number(process.env.JOB_QUEUE_UNKNOWN_HANDLER_RETRY_MS || 15000);
const MIN_DB_BACKOFF_MS = Number(process.env.JOB_QUEUE_DB_MIN_BACKOFF_MS || 5000);
const MAX_DB_BACKOFF_MS = Number(process.env.JOB_QUEUE_DB_MAX_BACKOFF_MS || 60000);
const DB_CIRCUIT_FAILURE_THRESHOLD = Number(process.env.JOB_QUEUE_DB_CIRCUIT_FAILURES || 5);
const DB_CIRCUIT_COOLDOWN_MS = Number(process.env.JOB_QUEUE_DB_CIRCUIT_COOLDOWN_MS || 60000);
const DB_ERROR_LOG_THROTTLE_MS = Number(process.env.JOB_QUEUE_DB_LOG_THROTTLE_MS || 10000);
const WORKER_ID = `${process.pid}`;
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

const handlers = new Map();
let running = false;
let processing = false;
let timer = null;
let currentJob = null;
let processedCount = 0;
let failedCount = 0;
let pendingCount = 0;
let schemaReady = false;
let consecutiveDbFailures = 0;
let dbCircuitOpenUntil = 0;
let lastDbStormLogAt = 0;
let lastPendingCountErrorLogAt = 0;
let dbCircuitWarned = false;

function safeMaxQueueSize() {
  return Number.isFinite(DEFAULT_MAX_QUEUE_SIZE) && DEFAULT_MAX_QUEUE_SIZE > 0 ? DEFAULT_MAX_QUEUE_SIZE : 500;
}

function classifyDbConnectivity(err) {
  if (!err) {
    return { kind: "unknown", retry_style: "connectivity" };
  }
  const code = err.code;
  const msg = String(err.message || err).toLowerCase();
  if (code === "ENOTFOUND") {
    return { kind: "dns_enotfound", retry_style: "connectivity" };
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNREFUSED") {
    return { kind: "conn_reset", retry_style: "connectivity" };
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return { kind: "timeout", retry_style: "connectivity" };
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("connection terminated")) {
    return { kind: "timeout", retry_style: "connectivity" };
  }
  if (code === "28P01" || msg.includes("password authentication failed")) {
    return { kind: "auth_password", retry_style: "auth" };
  }
  if (msg.includes("no pg_hba.conf entry")) {
    return { kind: "auth_pg_hba", retry_style: "auth" };
  }
  if (code === "57P01") {
    return { kind: "admin_shutdown", retry_style: "connectivity" };
  }
  return { kind: "other", retry_style: "connectivity" };
}

function computeDbBackoffMs(failureCount) {
  const n = Math.max(1, Number(failureCount) || 1);
  const cappedPow = Math.min(n - 1, 4);
  const exp = MIN_DB_BACKOFF_MS * Math.pow(2, Math.max(0, cappedPow));
  const jitter = Math.floor(Math.random() * MIN_DB_BACKOFF_MS * 0.15);
  return Math.min(MAX_DB_BACKOFF_MS, Math.floor(exp + jitter));
}

function resetQueueDbHealth() {
  consecutiveDbFailures = 0;
  dbCircuitOpenUntil = 0;
  dbCircuitWarned = false;
}

function registerDbFailure(err) {
  const classified = classifyDbConnectivity(err);
  consecutiveDbFailures += 1;
  const backoffMs = computeDbBackoffMs(consecutiveDbFailures);
  if (consecutiveDbFailures >= DB_CIRCUIT_FAILURE_THRESHOLD) {
    dbCircuitOpenUntil = Date.now() + DB_CIRCUIT_COOLDOWN_MS;
    if (!dbCircuitWarned) {
      dbCircuitWarned = true;
      logger.warn("JOB_QUEUE_DB_CIRCUIT_OPEN", {
        failures: consecutiveDbFailures,
        cooldown_ms: DB_CIRCUIT_COOLDOWN_MS,
        resume_after_ms: Math.max(0, dbCircuitOpenUntil - Date.now()),
        classified
      });
    }
  }
  const now = Date.now();
  if (now - lastDbStormLogAt >= DB_ERROR_LOG_THROTTLE_MS) {
    lastDbStormLogAt = now;
    logger.warn("JOB_QUEUE_DB_UNAVAILABLE", {
      failures: consecutiveDbFailures,
      next_backoff_ms: backoffMs,
      circuit_open_until: dbCircuitOpenUntil || null,
      code: err && err.code ? err.code : undefined,
      classified
    });
  }
  return backoffMs;
}

function shouldDeferForDbCircuit() {
  return Date.now() < dbCircuitOpenUntil;
}

function deferDelayForCircuit() {
  const remaining = dbCircuitOpenUntil - Date.now();
  return Math.min(MAX_DB_BACKOFF_MS, Math.max(MIN_DB_BACKOFF_MS, remaining + 50));
}

async function ensureQueueSchema() {
  if (schemaReady) {
    return;
  }
  if (IS_PRODUCTION) {
    const tableCheck = await pool.query(
      "SELECT to_regclass('public.background_jobs') AS regclass"
    );
    const hasQueueTable = Boolean(tableCheck.rows[0] && tableCheck.rows[0].regclass);
    if (!hasQueueTable) {
      throw new Error(
        "Production startup blocked: required table 'background_jobs' is missing. Run migrations before starting the app."
      );
    }
    schemaReady = true;
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      locked_at TIMESTAMP,
      locked_by TEXT,
      last_error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      dead_letter_at TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status_run_at
    ON background_jobs (status, run_at, id)
  `);
  schemaReady = true;
}

async function refreshPendingCount() {
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS pending
      FROM background_jobs
      WHERE status IN ('pending', 'retry')
    `);
    pendingCount = Number(result.rows[0] && result.rows[0].pending ? result.rows[0].pending : 0);
  } catch (err) {
    const now = Date.now();
    if (now - lastPendingCountErrorLogAt >= DB_ERROR_LOG_THROTTLE_MS) {
      lastPendingCountErrorLogAt = now;
      logger.warn("JOB_QUEUE_PENDING_COUNT_ERROR", {
        classified: classifyDbConnectivity(err),
        code: err && err.code ? err.code : undefined,
        error: err
      });
    }
  }
}

function scheduleNext(delayMs = 0) {
  if (!running || timer) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    processNext().catch((err) => {
      processing = false;
      currentJob = null;
      const delay = registerDbFailure(err);
      scheduleNext(delay);
    });
  }, Math.max(0, delayMs));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

async function claimNextJob() {
  const reclaimed = await pool.query(`
    UPDATE background_jobs
    SET
      status = 'retry',
      locked_at = NULL,
      locked_by = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
      AND locked_at IS NOT NULL
      AND locked_at < (CURRENT_TIMESTAMP - INTERVAL '15 minutes')
    RETURNING id
  `);
  for (const row of reclaimed.rows) {
    logger.warn("JOB_QUEUE_RECLAIMED_STUCK_JOB", { id: row.id });
  }

  const result = await pool.query(`
    WITH candidate AS (
      SELECT id
      FROM background_jobs
      WHERE status IN ('pending', 'retry')
        AND run_at <= CURRENT_TIMESTAMP
      ORDER BY run_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE background_jobs AS j
    SET
      status = 'running',
      locked_at = CURRENT_TIMESTAMP,
      locked_by = $1,
      updated_at = CURRENT_TIMESTAMP
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.*
  `, [WORKER_ID]);
  return result.rows[0] || null;
}

async function requeueJobForUnknownHandler(job) {
  await pool.query(`
    UPDATE background_jobs
    SET
      status = 'retry',
      run_at = CURRENT_TIMESTAMP + ($2::int * INTERVAL '1 millisecond'),
      locked_at = NULL,
      locked_by = NULL,
      updated_at = CURRENT_TIMESTAMP,
      last_error = 'No registered handler for job type'
    WHERE id = $1
  `, [job.id, UNKNOWN_HANDLER_RETRY_MS]);
}

async function completeJob(jobId) {
  await pool.query(`
    UPDATE background_jobs
    SET
      status = 'completed',
      locked_at = NULL,
      locked_by = NULL,
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
  `, [jobId]);
}

async function failOrRetryJob(job, err) {
  const attempts = Number(job.attempts || 0) + 1;
  const maxAttempts = Number(job.max_attempts || MAX_ATTEMPTS);
  if (attempts < maxAttempts) {
    const backoff = BASE_BACKOFF_MS * Math.pow(2, attempts - 1);
    await pool.query(`
      UPDATE background_jobs
      SET
        attempts = $2,
        status = 'retry',
        run_at = CURRENT_TIMESTAMP + ($3::int * INTERVAL '1 millisecond'),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = CURRENT_TIMESTAMP,
        last_error = LEFT($4, 2000)
      WHERE id = $1
    `, [job.id, attempts, backoff, err && err.message ? err.message : String(err)]);
    logger.warn("JOB_QUEUE_RETRY", {
      type: job.type,
      id: job.id,
      attempt: attempts,
      max_attempts: maxAttempts,
      error: err
    });
    return;
  }

  await pool.query(`
    UPDATE background_jobs
    SET
      attempts = $2,
      status = 'failed',
      dead_letter_at = CURRENT_TIMESTAMP,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = CURRENT_TIMESTAMP,
      last_error = LEFT($3, 2000)
    WHERE id = $1
  `, [job.id, attempts, err && err.message ? err.message : String(err)]);
  failedCount += 1;
  logger.error("JOB_QUEUE_FAILED", { type: job.type, id: job.id, error: err });
}

async function processNext() {
  if (!running || processing) {
    return;
  }

  if (shouldDeferForDbCircuit()) {
    scheduleNext(deferDelayForCircuit());
    return;
  }

  processing = true;
  let nextDelay = 0;

  try {
    try {
      await ensureQueueSchema();
    } catch (err) {
      nextDelay = registerDbFailure(err);
      return;
    }

    let job;
    try {
      job = await claimNextJob();
    } catch (err) {
      nextDelay = registerDbFailure(err);
      return;
    }

    resetQueueDbHealth();

    if (!job) {
      await refreshPendingCount();
      nextDelay = 250;
      return;
    }

    currentJob = { id: job.id, type: job.type, attempts: Number(job.attempts || 0) };
    logger.info("JOB_QUEUE_JOB_CLAIMED", {
      job_id: job.id,
      job_type: job.type,
      locked_by: WORKER_ID,
      multi_node_guard: "FOR UPDATE SKIP LOCKED"
    });
    const handler = handlers.get(job.type);
    if (typeof handler !== "function") {
      try {
        await requeueJobForUnknownHandler(job);
      } catch (err) {
        nextDelay = registerDbFailure(err);
        return;
      }
      currentJob = null;
      await refreshPendingCount();
      nextDelay = 1000;
      return;
    }

    try {
      await handler(job.payload || {});
      processedCount += 1;
      try {
        await completeJob(job.id);
      } catch (err) {
        nextDelay = registerDbFailure(err);
        return;
      }
    } catch (err) {
      try {
        await failOrRetryJob(job, err);
      } catch (dbErr) {
        nextDelay = registerDbFailure(dbErr);
        return;
      }
    }
    nextDelay = 0;
  } finally {
    processing = false;
    currentJob = null;
    try {
      await refreshPendingCount();
    } catch (_) {
      /* refreshPendingCount logs throttled warnings internally */
    }
    if (running) {
      scheduleNext(nextDelay);
    }
  }
}

async function enqueueJob(type, payload, handler) {
  if (!type || typeof type !== "string") {
    throw new Error("Queue job type is required");
  }
  if (typeof handler !== "function") {
    throw new Error("Queue job handler is required");
  }
  handlers.set(type, handler);
  await ensureQueueSchema();

  const pendingResult = await pool.query(`
    SELECT COUNT(*)::int AS pending
    FROM background_jobs
    WHERE status IN ('pending', 'retry', 'running')
  `);
  const currentPending = Number(pendingResult.rows[0] && pendingResult.rows[0].pending ? pendingResult.rows[0].pending : 0);
  if (currentPending >= safeMaxQueueSize()) {
    throw new Error("Queue is full");
  }

  const inserted = await pool.query(`
    INSERT INTO background_jobs (type, payload, status, attempts, max_attempts, run_at)
    VALUES ($1, $2::jsonb, 'pending', 0, $3, CURRENT_TIMESTAMP)
    RETURNING id, type, created_at
  `, [type, JSON.stringify(payload || {}), MAX_ATTEMPTS]);
  await refreshPendingCount();
  scheduleNext(0);
  return {
    id: Number(inserted.rows[0].id),
    type: inserted.rows[0].type,
    enqueuedAt: inserted.rows[0].created_at
  };
}

async function startQueue() {
  if (running) {
    return getQueueStatus();
  }
  await ensureQueueSchema();
  running = true;
  await refreshPendingCount();
  scheduleNext(0);
  return getQueueStatus();
}

async function waitForQueueIdle(timeoutMs = Number(process.env.JOB_QUEUE_DRAIN_TIMEOUT_MS || 20000)) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runningRow = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM background_jobs
      WHERE status = 'running'
    `);
    const queuedRow = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM background_jobs
      WHERE status IN ('pending', 'retry')
    `);
    const runningCount = Number(runningRow.rows[0] && runningRow.rows[0].cnt ? runningRow.rows[0].cnt : 0);
    const queuedCount = Number(queuedRow.rows[0] && queuedRow.rows[0].cnt ? queuedRow.rows[0].cnt : 0);
    if (runningCount === 0 && queuedCount === 0 && !processing) {
      await refreshPendingCount();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function stopQueue(options = {}) {
  const drain = Boolean(options && options.drain);
  const timeoutMs = Number(options && options.timeoutMs ? options.timeoutMs : (process.env.JOB_QUEUE_DRAIN_TIMEOUT_MS || 20000));
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  let drained = true;
  if (drain) {
    drained = await waitForQueueIdle(timeoutMs);
  }
  await refreshPendingCount();
  return {
    ...getQueueStatus(),
    drained
  };
}

function getQueueStatus() {
  return {
    durability: "database_backed",
    pending: pendingCount,
    running: processing,
    started: running,
    current: currentJob,
    processed: processedCount,
    failed: failedCount,
    db_resilience: {
      consecutive_db_failures: consecutiveDbFailures,
      circuit_open_until: dbCircuitOpenUntil || null,
      backoff_ms_min: MIN_DB_BACKOFF_MS,
      backoff_ms_max: MAX_DB_BACKOFF_MS
    }
  };
}

module.exports = {
  enqueueJob,
  startQueue,
  stopQueue,
  waitForQueueIdle,
  getQueueStatus
};

const pool = require("../db/pool");
const logger = require("./logger");

const DEFAULT_MAX_QUEUE_SIZE = Number(process.env.JOB_QUEUE_MAX_SIZE || 500);
const MAX_ATTEMPTS = Number(process.env.JOB_QUEUE_MAX_ATTEMPTS || 3);
const BASE_BACKOFF_MS = Number(process.env.JOB_QUEUE_BASE_BACKOFF_MS || 1000);
const UNKNOWN_HANDLER_RETRY_MS = Number(process.env.JOB_QUEUE_UNKNOWN_HANDLER_RETRY_MS || 15000);
const WORKER_ID = `${process.pid}`;

const handlers = new Map();
let running = false;
let processing = false;
let timer = null;
let currentJob = null;
let processedCount = 0;
let failedCount = 0;
let pendingCount = 0;
let schemaReady = false;

function safeMaxQueueSize() {
  return Number.isFinite(DEFAULT_MAX_QUEUE_SIZE) && DEFAULT_MAX_QUEUE_SIZE > 0 ? DEFAULT_MAX_QUEUE_SIZE : 500;
}

async function ensureQueueSchema() {
  if (schemaReady) {
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
    logger.error("JOB_QUEUE_PENDING_COUNT_ERROR", err);
  }
}

function scheduleNext(delayMs = 0) {
  if (!running || timer) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    processNext().catch((err) => {
      logger.error("JOB_QUEUE_LOOP_ERROR", err);
      processing = false;
      currentJob = null;
      scheduleNext(BASE_BACKOFF_MS);
    });
  }, Math.max(0, delayMs));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

async function claimNextJob() {
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
  processing = true;
  try {
    const job = await claimNextJob();
    if (!job) {
      await refreshPendingCount();
      scheduleNext(250);
      return;
    }

    currentJob = { id: job.id, type: job.type, attempts: Number(job.attempts || 0) };
    const handler = handlers.get(job.type);
    if (typeof handler !== "function") {
      await requeueJobForUnknownHandler(job);
      currentJob = null;
      await refreshPendingCount();
      scheduleNext(1000);
      return;
    }

    try {
      await handler(job.payload || {});
      processedCount += 1;
      await completeJob(job.id);
    } catch (err) {
      await failOrRetryJob(job, err);
    }
  } finally {
    processing = false;
    currentJob = null;
    await refreshPendingCount();
    scheduleNext(0);
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
    failed: failedCount
  };
}

module.exports = {
  enqueueJob,
  startQueue,
  stopQueue,
  waitForQueueIdle,
  getQueueStatus
};

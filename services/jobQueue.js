const DEFAULT_MAX_QUEUE_SIZE = Number(process.env.JOB_QUEUE_MAX_SIZE || 500);
const logger = require("./logger");
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

const queue = [];

let running = false;
let processing = false;
let timer = null;
let currentJob = null;
let processedCount = 0;
let failedCount = 0;
let nextJobId = 1;

function safeMaxQueueSize() {
  return Number.isFinite(DEFAULT_MAX_QUEUE_SIZE) && DEFAULT_MAX_QUEUE_SIZE > 0
    ? DEFAULT_MAX_QUEUE_SIZE
    : 500;
}

function scheduleNext(delayMs = 0) {
  if (!running || timer) {
    return;
  }

  timer = setTimeout(() => {
    timer = null;
    processNext().catch((err) => {
      logger.error("JOB QUEUE LOOP ERROR", err);
      processing = false;
      currentJob = null;
      scheduleNext(BASE_BACKOFF_MS);
    });
  }, Math.max(0, delayMs));

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function nextRunnableJobIndex() {
  const now = Date.now();
  return queue.findIndex(job => job.runAt <= now);
}

function nextDelayMs() {
  if (!queue.length) {
    return 250;
  }

  const nextRunAt = Math.min(...queue.map(job => job.runAt));
  return Math.max(0, nextRunAt - Date.now());
}

async function processNext() {
  if (!running || processing) {
    return;
  }

  const index = nextRunnableJobIndex();
  if (index === -1) {
    scheduleNext(nextDelayMs());
    return;
  }

  const job = queue.splice(index, 1)[0];
  processing = true;
  currentJob = {
    id: job.id,
    type: job.type,
    attempts: job.attempts
  };

  try {
    await job.handler(job.payload);
    processedCount += 1;
  } catch (err) {
    job.attempts += 1;

    if (job.attempts < MAX_ATTEMPTS) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, job.attempts - 1);
      job.runAt = Date.now() + backoff;
      queue.push(job);
      logger.warn("JOB QUEUE RETRY", {
        type: job.type,
        id: job.id,
        attempt: job.attempts,
        max_attempts: MAX_ATTEMPTS,
        error: err
      });
    } else {
      failedCount += 1;
      logger.error("JOB QUEUE FAILED", {
        type: job.type,
        id: job.id,
        error: err
      });
    }
  } finally {
    processing = false;
    currentJob = null;
    scheduleNext(nextDelayMs());
  }
}

function enqueueJob(type, payload, handler) {
  if (!type || typeof type !== "string") {
    throw new Error("Queue job type is required");
  }

  if (typeof handler !== "function") {
    throw new Error("Queue job handler is required");
  }

  if (queue.length >= safeMaxQueueSize()) {
    throw new Error("Queue is full");
  }

  const job = {
    id: nextJobId++,
    type,
    payload: payload || {},
    handler,
    attempts: 0,
    runAt: Date.now(),
    enqueuedAt: new Date().toISOString()
  };

  queue.push(job);
  scheduleNext(0);

  return {
    id: job.id,
    type: job.type,
    enqueuedAt: job.enqueuedAt
  };
}

function startQueue() {
  if (running) {
    return getQueueStatus();
  }

  running = true;
  scheduleNext(0);
  return getQueueStatus();
}

function stopQueue() {
  running = false;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  return getQueueStatus();
}

function getQueueStatus() {
  return {
    pending: queue.length,
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
  getQueueStatus
};

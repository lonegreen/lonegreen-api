const cron = require("node-cron");
const pool = require("../db/pool");
const { getQueueStatus } = require("./jobQueue");
const { syncAlerts } = require("./notificationService");
const { processSubscriptions } = require("./subscriptionEngine");
const { evaluatePastDueSuspensions } = require("./billingService");
const { syncExpiredTrustStatuses } = require("./trustExpiryService");
const { BILLING_LIFECYCLE_AUTOMATION } = require("../config/env");
const logger = require("./logger");

let backgroundTasks = {};

try {
  backgroundTasks = require("./backgroundTasks");
} catch (err) {
  logger.warn("SCHEDULER BACKGROUND TASKS UNAVAILABLE", err);
}

const scheduledTasks = new Map();
let started = false;

function nowIso() {
  return new Date().toISOString();
}

function createStatus(name, schedule) {
  return {
    name,
    schedule,
    last_run: null,
    last_success: null,
    last_error: null,
    run_count: 0,
    running: false
  };
}

async function runTask(status, handler) {
  if (status.running) {
    logger.warn("SCHEDULER_TASK_SKIPPED_OVERLAP", {
      task: status.name
    });
    return;
  }
  status.running = true;
  status.last_run = nowIso();
  status.run_count += 1;
  const startedAt = Date.now();
  const lockName = `scheduler:${status.name}`;
  let advisoryLockAcquired = false;
  logger.info("SCHEDULER_TASK_STARTED", {
    task: status.name,
    run_count: status.run_count
  });

  // PostgreSQL session-level advisory locks are per-connection. Acquiring
  // and releasing on different pooled connections produces a no-op release
  // and silently lets another instance acquire the lock. We dedicate one
  // checked-out client to the entire acquire/run/release lifecycle so the
  // lock truly serializes the task across processes.
  let lockClient = null;
  try {
    lockClient = await pool.connect();
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [lockName]
    );
    advisoryLockAcquired = Boolean(lockResult.rows[0] && lockResult.rows[0].acquired);
    if (!advisoryLockAcquired) {
      logger.info("SCHEDULER_TASK_SKIPPED_DISTRIBUTED_LOCK", {
        task: status.name,
        lock_key: lockName,
        process_pid: process.pid,
        detail: "another_instance_or_scheduler_tick_holds_pg_advisory_lock"
      });
      status.last_error = null;
      return;
    }
    logger.info("SCHEDULER_ADVISORY_LOCK_ACQUIRED", {
      task: status.name,
      lock_key: lockName,
      process_pid: process.pid
    });
    await handler();
    status.last_success = nowIso();
    status.last_error = null;
    logger.info("SCHEDULER_TASK_COMPLETED", {
      task: status.name,
      duration_ms: Date.now() - startedAt
    });
  } catch (err) {
    status.last_error = err && (err.message || String(err));
    logger.error("SCHEDULER TASK ERROR", {
      task: status.name,
      duration_ms: Date.now() - startedAt,
      error: err
    });
  }
  finally {
    if (lockClient) {
      if (advisoryLockAcquired) {
        try {
          await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
        } catch (unlockErr) {
          logger.error("SCHEDULER_TASK_UNLOCK_ERROR", {
            task: status.name,
            error: unlockErr
          });
        }
      }
      try {
        lockClient.release();
      } catch (releaseErr) {
        logger.warn("SCHEDULER_TASK_LOCK_CLIENT_RELEASE_NOTE", {
          task: status.name,
          error: releaseErr && releaseErr.message ? releaseErr.message : String(releaseErr)
        });
      }
    }
    status.running = false;
  }
}

function registerTask(name, schedule, handler) {
  const status = createStatus(name, schedule);
  const task = cron.schedule(schedule, () => {
    runTask(status, handler).catch(err => {
      status.last_error = err && (err.message || String(err));
      logger.error("SCHEDULER LOOP ERROR", {
        task: name,
        error: err
      });
    });
  }, {
    scheduled: false
  });

  scheduledTasks.set(name, {
    task,
    status
  });
}

async function runSubscriptionProcessing() {
  logger.info("Scheduler subscription_processing: running DB-locked processor inline");
  await processSubscriptions();
}

async function runBillingLifecycleAutomation() {
  /* Production requires BILLING_LIFECYCLE_AUTOMATION=true (enforced at startup via config/env.js). */
  if (!BILLING_LIFECYCLE_AUTOMATION) {
    logger.info("Scheduler billing_lifecycle: disabled by BILLING_LIFECYCLE_AUTOMATION");
    return;
  }

  if (typeof backgroundTasks.enqueueBillingLifecycleTask === "function") {
    logger.info("Scheduler billing_lifecycle: dispatched to job queue");
    await backgroundTasks.enqueueBillingLifecycleTask();
    return;
  }

  logger.info("Scheduler billing_lifecycle: running evaluatePastDueSuspensions inline");
  await evaluatePastDueSuspensions();
}

async function runScheduledDatabaseBackup() {
  const { runBackup } = require("./backupService");
  await runBackup({ trigger: "scheduler" });
}

async function runDailyAlertsSync() {
  const companies = await pool.query("SELECT id FROM companies ORDER BY id ASC");

  for (const company of companies.rows) {
    try {
      await syncAlerts(company.id);
    } catch (err) {
      logger.error("SCHEDULER ALERT SYNC ERROR", {
        company_id: company.id,
        error: err
      });
    }
  }
}

async function runDailyTrustExpirySync() {
  const summary = await syncExpiredTrustStatuses();
  logger.info("SCHEDULER_TRUST_EXPIRY_SYNC_RESULT", {
    updated_count: Number(summary && summary.updated_count) || 0
  });
}

function runQueueHeartbeat() {
  if (String(process.env.LOG_QUEUE_HEARTBEAT || "").toLowerCase() === "true") {
    logger.info("QUEUE STATUS HEARTBEAT", getQueueStatus());
  }
}

function startScheduler() {
  if (started) {
    return getSchedulerStatus();
  }

  registerTask("subscription_processing", "0 2 * * *", runSubscriptionProcessing);
  registerTask("billing_lifecycle", "*/30 * * * *", runBillingLifecycleAutomation);
  registerTask("daily_alerts_sync", "0 7 * * *", runDailyAlertsSync);
  registerTask("daily_trust_expiry_sync", "15 6 * * *", runDailyTrustExpirySync);
  registerTask("queue_status_heartbeat", "0 * * * *", runQueueHeartbeat);

  const backupCron = String(process.env.DATABASE_BACKUP_CRON || "").trim();
  if (backupCron) {
    try {
      registerTask("database_backup", backupCron, runScheduledDatabaseBackup);
      logger.info("DATABASE_BACKUP_SCHEDULED", { cron: backupCron });
    } catch (err) {
      logger.error("DATABASE_BACKUP_CRON_INVALID", {
        cron: backupCron,
        error: err && err.message ? err.message : String(err)
      });
    }
  }

  for (const item of scheduledTasks.values()) {
    item.task.start();
  }

  started = true;
  logger.info("Scheduler started");
  return getSchedulerStatus();
}

function stopScheduler() {
  for (const item of scheduledTasks.values()) {
    item.task.stop();
  }

  started = false;
  return getSchedulerStatus();
}

function getSchedulerStatus() {
  return {
    started,
    tasks: Array.from(scheduledTasks.values()).map(item => ({ ...item.status }))
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  getSchedulerStatus
};

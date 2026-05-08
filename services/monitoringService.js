const pool = require("../db/pool");
const { getQueueStatus } = require("./jobQueue");
const { getSchedulerStatus } = require("./schedulerService");
const { getUploadReadiness } = require("./uploadService");
const { getBillingReadiness, getWorkflowReadiness } = require("./productionReadiness");

async function getDbStatus() {
  try {
    const result = await pool.query("SELECT NOW() AS checked_at");
    return { status: "ok", checked_at: result.rows[0] && result.rows[0].checked_at ? result.rows[0].checked_at : null };
  } catch (err) {
    return { status: "error", error: err.message || "DB connectivity failed" };
  }
}

function summarizeWorkflowChecks(workflows) {
  const checks = workflows && workflows.checks ? workflows.checks : {};
  return {
    support_readiness: checks.support_system || { status: "needs_review" },
    moderation_readiness: checks.moderation_system || { status: "needs_review" },
    dispute_readiness: checks.disputes_system || { status: "needs_review" },
    notification_readiness: checks.notifications_system || { status: "needs_review" }
  };
}

function getMonitoringActivationReadiness() {
  const alertChannel = String(process.env.MONITORING_ALERT_CHANNEL || "").trim();
  const alertEmail = String(process.env.MONITORING_ALERT_EMAIL || "").trim();
  const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS || 0);
  const uptimeUrl = String(process.env.UPTIME_MONITOR_URL || "").trim();

  const checks = {
    alert_channel_ready: {
      status: alertChannel || alertEmail ? "ok" : "needs_review",
      channel: alertChannel || null,
      email: alertEmail || null
    },
    log_retention_ready: {
      status: Number.isInteger(logRetentionDays) && logRetentionDays >= 14 ? "ok" : "needs_review",
      retention_days: Number.isFinite(logRetentionDays) ? logRetentionDays : 0
    },
    uptime_monitor_ready: {
      status: uptimeUrl ? "ok" : "needs_review",
      url_configured: Boolean(uptimeUrl)
    }
  };
  const blockerCount = Object.values(checks).filter((c) => c.status !== "ok").length;
  return {
    status: blockerCount === 0 ? "ready" : "needs_review",
    checks,
    blocker_count: blockerCount
  };
}

async function getMonitoringSnapshot() {
  const [db, billing, workflows] = await Promise.all([
    getDbStatus(),
    getBillingReadiness().catch((err) => ({ status: "error", error: err.message || "Billing readiness unavailable" })),
    getWorkflowReadiness().catch((err) => ({ status: "needs_review", warning: err.message || "Workflow readiness unavailable" }))
  ]);

  return {
    db,
    queue: getQueueStatus(),
    scheduler: getSchedulerStatus(),
    billing,
    uploads: getUploadReadiness(),
    ...summarizeWorkflowChecks(workflows)
  };
}

module.exports = {
  getMonitoringSnapshot,
  getMonitoringActivationReadiness
};

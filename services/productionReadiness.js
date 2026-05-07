const pool = require("../db/pool");
const { getMigrationStatus } = require("../db/setup");
const {
  getProductionEnvReadiness,
  STRIPE_WEBHOOK_SECRET,
  BILLING_LIFECYCLE_AUTOMATION,
  SUBSCRIPTION_INTERVAL_ENGINE
} = require("../config/env");
const { isStripeCheckoutConfigured, isStripePortalConfigured } = require("./stripeService");
const { getEmailReadiness } = require("./emailService");
const { getQueueStatus } = require("./jobQueue");
const { getSchedulerStatus } = require("./schedulerService");
const { getUploadReadiness } = require("./uploadService");
const logger = require("./logger");

function getProcessReadiness() {
  return {
    status: "ok",
    uptime_seconds: Math.round(process.uptime()),
    pid: process.pid
  };
}

async function getDatabaseReadiness() {
  try {
    const result = await pool.query("SELECT NOW() AS checked_at");
    return {
      status: "ok",
      checked_at: result.rows[0].checked_at,
      pool: typeof pool.getPoolReadinessInfo === "function"
        ? pool.getPoolReadinessInfo()
        : null
    };
  } catch (err) {
    logger.error("HEALTH_DATABASE_READINESS_FAILED", err);
    return {
      status: "error",
      error: err.message || "Database check failed"
    };
  }
}

async function getBillingReadiness() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE billing_status = 'past_due')::int AS past_due,
        COUNT(*) FILTER (WHERE billing_status = 'suspended')::int AS suspended,
        COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL)::int AS stripe_customers
      FROM companies
    `);

    return {
      status: "ok",
      past_due_companies: result.rows[0].past_due,
      suspended_companies: result.rows[0].suspended,
      companies_with_stripe_customer: result.rows[0].stripe_customers,
      warning_mode: true
    };
  } catch (err) {
    logger.error("HEALTH_BILLING_READINESS_FAILED", err);
    return {
      status: "error",
      error: err.message || "Billing readiness check failed",
      warning_mode: true
    };
  }
}

function getStripeReadiness() {
  return {
    status: isStripeCheckoutConfigured() && STRIPE_WEBHOOK_SECRET ? "configured" : "not_configured",
    checkout_configured: isStripeCheckoutConfigured(),
    webhook_secret_configured: Boolean(STRIPE_WEBHOOK_SECRET),
    portal_configured: isStripePortalConfigured()
  };
}

async function getHealthReadiness() {
  const [database, migrations, billing] = await Promise.all([
    getDatabaseReadiness(),
    getMigrationStatus().catch(err => {
      logger.error("HEALTH_MIGRATION_READINESS_FAILED", err);
      return {
        status: "error",
        error: err.message || "Migration status unavailable"
      };
    }),
    getBillingReadiness()
  ]);

  const processStatus = getProcessReadiness();
  const stripe = getStripeReadiness();
  const environment = getProductionEnvReadiness();
  const email = getEmailReadiness();
  const uploads = getUploadReadiness();
  const queue = getQueueStatus();
  const scheduler = getSchedulerStatus();
  const environmentReady = environment.production
    ? environment.status === "ready"
    : environment.status !== "critical_missing";
  const ok = database.status === "ok"
    && migrations.status === "current"
    && environmentReady;

  return {
    ok,
    app: "FairLinx",
    process: processStatus,
    database,
    migrations,
    billing,
    stripe,
    email,
    uploads,
    queue,
    scheduler,
    environment,
    operational: {
      subscription_interval_poll_enabled: SUBSCRIPTION_INTERVAL_ENGINE,
      billing_lifecycle_automation_enabled: BILLING_LIFECYCLE_AUTOMATION,
      subscription_processing_cron_utc: "02:00 daily",
      upload_ephemeral_warning: uploads.ephemeral_storage_warning === true,
      observability: {
        stripe_webhook_failures: "STRIPE_WEBHOOK_HANDLER_FAILURE / STRIPE_WEBHOOK_ROUTE_FAILURE",
        billing_enforcement: "BILLING_MUTATION_BLOCKED",
        scheduler_errors: "SCHEDULER TASK ERROR / SCHEDULER LOOP ERROR"
      }
    }
  };
}

module.exports = {
  getHealthReadiness,
  getDatabaseReadiness,
  getBillingReadiness,
  getStripeReadiness
};

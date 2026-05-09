const dns = require("dns").promises;
const pool = require("../db/pool");
const fs = require("fs");
const path = require("path");
const { getMigrationStatus } = require("../db/setup");
const {
  NODE_ENV,
  getProductionEnvReadiness,
  STRIPE_WEBHOOK_SECRET,
  BILLING_LIFECYCLE_AUTOMATION,
  SUBSCRIPTION_INTERVAL_ENGINE
} = require("../config/env");
const {
  isStripeCheckoutConfigured,
  isStripePortalConfigured,
  getStripeCheckoutReadiness,
  getStripe,
  priceIdForCheckoutPlan
} = require("./stripeService");
const { getEmailReadiness } = require("./emailService");
const { getQueueStatus } = require("./jobQueue");
const { getSchedulerStatus } = require("./schedulerService");
const { getUploadReadiness, getStorageActivationStatus } = require("./uploadService");
const {
  validateBackupScheduleReadiness,
  validateBackupRetentionReadiness,
  validateRestoreDrillReadiness
} = require("./backupService");
const logger = require("./logger");
const rootDir = path.join(__dirname, "..");

function getProcessReadiness() {
  return {
    status: "ok",
    uptime_seconds: Math.round(process.uptime()),
    pid: process.pid
  };
}

async function getDatabaseReadiness() {
  const poolInfo = typeof pool.getPoolReadinessInfo === "function"
    ? pool.getPoolReadinessInfo()
    : null;
  const dbHost = poolInfo && poolInfo.host ? poolInfo.host : null;

  let dns_check = { status: "skipped", host: dbHost };
  if (dbHost && dbHost !== "unknown") {
    try {
      await dns.lookup(dbHost);
      dns_check = { status: "ok", host: dbHost };
    } catch (dnsErr) {
      dns_check = {
        status: "warning",
        host: dbHost,
        code: dnsErr && dnsErr.code ? dnsErr.code : undefined,
        message: dnsErr && dnsErr.message ? dnsErr.message : String(dnsErr),
        warning:
          "DNS lookup failed for the configured database host. Check DATABASE_URL, resolver/DNS, and provider status (e.g. Neon ENOTFOUND / timeouts)."
      };
    }
  }

  try {
    const result = await pool.query("SELECT NOW() AS checked_at");
    return {
      status: "ok",
      checked_at: result.rows[0].checked_at,
      pool: poolInfo,
      dns: dns_check
    };
  } catch (err) {
    logger.error("HEALTH_DATABASE_READINESS_FAILED", err);
    return {
      status: "error",
      error: err.message || "Database check failed",
      pool: poolInfo,
      dns: dns_check
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

async function getStripeProviderReadiness(checkout) {
  if (!checkout || checkout.status !== "configured") {
    return {
      status: "skipped",
      reason: "checkout_not_configured"
    };
  }

  const stripe = getStripe();
  if (!stripe) {
    return {
      status: "error",
      error: "Stripe client is not configured"
    };
  }

  try {
    await Promise.all(["starter", "pro", "growth"].map(async (plan) => {
      const priceId = priceIdForCheckoutPlan(plan, "monthly");
      const price = await stripe.prices.retrieve(priceId);
      if (!price || price.deleted || price.active === false || !price.recurring) {
        throw Object.assign(new Error(`Stripe Price for ${plan} is inactive or not recurring`), {
          code: "STRIPE_PRICE_NOT_USABLE"
        });
      }
    }));
    return {
      status: "ok"
    };
  } catch (err) {
    return {
      status: "error",
      code: err && (err.code || err.type) ? (err.code || err.type) : "STRIPE_PROVIDER_READINESS_ERROR",
      error: err && err.message ? err.message : "Stripe provider readiness check failed"
    };
  }
}

async function getStripeReadiness() {
  const checkout = getStripeCheckoutReadiness();
  const provider = await getStripeProviderReadiness(checkout);
  const providerOk = provider.status === "ok" || provider.status === "skipped";
  return {
    status: isStripeCheckoutConfigured() && STRIPE_WEBHOOK_SECRET && providerOk ? "configured" : "not_configured",
    checkout_configured: isStripeCheckoutConfigured(),
    checkout_status: checkout.status,
    missing_checkout_config: checkout.missing,
    invalid_checkout_config: checkout.invalid,
    checkout_price_aliases: checkout.price_aliases,
    provider,
    webhook_secret_configured: Boolean(STRIPE_WEBHOOK_SECRET),
    portal_configured: isStripePortalConfigured()
  };
}

function docsPresenceReadiness() {
  const requiredDocs = [
    "docs/launch-readiness-checklist.md",
    "docs/incident-response-playbook.md",
    "docs/backup-restore-playbook.md",
    "docs/founding-partner-onboarding.md",
    "docs/notification-center-plan.md",
    "docs/billing-lifecycle-hardening-plan.md",
    "docs/production-storage-plan.md",
    "docs/monitoring-alerts-plan.md",
    "docs/backup-automation-plan.md",
    "docs/reputation-scoring-plan.md",
    "docs/open-launch-audit.md",
    "docs/production-cutover-checklist.md",
    "docs/launch-marketing-assets.md",
    "docs/storage-activation-checklist.md",
    "docs/monitoring-activation-checklist.md",
    "docs/backup-scheduling-checklist.md"
  ];
  const missing = requiredDocs.filter((rel) => !fs.existsSync(path.join(rootDir, rel)));
  return {
    status: missing.length ? "needs_review" : "ok",
    required_docs: requiredDocs,
    missing_docs: missing
  };
}

async function getWorkflowReadiness() {
  try {
    const [supportTable, verificationColumns, moderationTable, disputesTable, notificationsTable, reputationColumns, inviteTable] = await Promise.all([
      pool.query("SELECT to_regclass('public.support_tickets') AS table_name"),
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM information_schema.columns
        WHERE table_name = 'companies'
          AND column_name IN ('verification_status', 'license_status', 'insurance_status', 'identity_status')
        `
      ),
      pool.query("SELECT to_regclass('public.abuse_reports') AS table_name"),
      pool.query("SELECT to_regclass('public.disputes') AS table_name"),
      pool.query("SELECT to_regclass('public.notifications') AS table_name"),
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM information_schema.columns
        WHERE table_name = 'companies'
          AND column_name IN ('reputation_score', 'reputation_updated_at')
        `
      ),
      pool.query("SELECT to_regclass('public.company_invites') AS table_name")
    ]);

    const supportReady = Boolean(supportTable.rows[0] && supportTable.rows[0].table_name);
    const verificationReady = Number(verificationColumns.rows[0] && verificationColumns.rows[0].count) >= 4;
    const moderationReady = Boolean(moderationTable.rows[0] && moderationTable.rows[0].table_name);
    const disputesReady = Boolean(disputesTable.rows[0] && disputesTable.rows[0].table_name);
    const notificationsReady = Boolean(notificationsTable.rows[0] && notificationsTable.rows[0].table_name);
    const reputationReady = Number(reputationColumns.rows[0] && reputationColumns.rows[0].count) >= 2;
    const invitesReady = Boolean(inviteTable.rows[0] && inviteTable.rows[0].table_name);
    const uploads = getUploadReadiness();
    const docs = docsPresenceReadiness();
    const platformRoutesPath = path.join(rootDir, "routes/platform.js");
    const notificationServicePath = path.join(rootDir, "services/notificationService.js");
    const platformSource = fs.existsSync(platformRoutesPath) ? fs.readFileSync(platformRoutesPath, "utf8") : "";
    const notificationServiceSource = fs.existsSync(notificationServicePath) ? fs.readFileSync(notificationServicePath, "utf8") : "";
    const hasInviteRoutes = platformSource.includes("/platform/founding-partner/invites");
    const hasBillingAuditRoute = platformSource.includes("/platform/billing-lifecycle/audit");
    const hasNotificationServiceScopes = notificationServiceSource.includes("listNotificationsForUser")
      && notificationServiceSource.includes("markNotificationRead")
      && notificationServiceSource.includes("countUnreadNotifications");
    const monitoringServicePath = path.join(rootDir, "services/monitoringService.js");
    const backupServicePath = path.join(rootDir, "services/backupService.js");
    const reputationServicePath = path.join(rootDir, "services/reputationService.js");
    const customerRoutesPath = path.join(rootDir, "routes/customer.js");
    const customerRoutesSource = fs.existsSync(customerRoutesPath) ? fs.readFileSync(customerRoutesPath, "utf8") : "";
    const hasMonitoringRoute = platformSource.includes("/platform/monitoring");
    const hasBackupRoute = platformSource.includes("/platform/backups/status");
    const hasInviteValidationRoute = customerRoutesSource.includes("/invites/:token/validate");
    const hasNotificationTriggers = notificationServiceSource.includes("notifyMarketplaceRequestCreated")
      && notificationServiceSource.includes("notifySupportTicketCreated")
      && notificationServiceSource.includes("notifyDisputeOpened")
      && notificationServiceSource.includes("notifyVerificationApproved")
      && notificationServiceSource.includes("notifyBillingWarning");
    const checks = {
      support_system: { status: supportReady ? "ok" : "needs_review" },
      verification_system: { status: verificationReady ? "ok" : "needs_review" },
      moderation_system: { status: moderationReady ? "ok" : "needs_review" },
      disputes_system: { status: disputesReady ? "ok" : "needs_review" },
      notifications_system: { status: notificationsReady && hasNotificationServiceScopes ? "ok" : "needs_review" },
      reputation_system: { status: reputationReady ? "ok" : "needs_review" },
      founding_partner_invites: { status: invitesReady && hasInviteRoutes ? "ok" : "needs_review" },
      billing_lifecycle_audit: { status: hasBillingAuditRoute ? "ok" : "needs_review" },
      monitoring_system: { status: fs.existsSync(monitoringServicePath) && hasMonitoringRoute ? "ok" : "needs_review" },
      backup_system: { status: fs.existsSync(backupServicePath) && hasBackupRoute ? "ok" : "needs_review" },
      invite_validation: { status: hasInviteValidationRoute ? "ok" : "needs_review" },
      reputation_engine: { status: fs.existsSync(reputationServicePath) ? "ok" : "needs_review" },
      notification_triggers: { status: hasNotificationTriggers ? "ok" : "needs_review" },
      upload_storage: {
        status: uploads && uploads.status && uploads.status !== "error" ? "ok" : "needs_review",
        mode: uploads && uploads.storage ? uploads.storage : "unknown"
      },
      backup_docs: {
        status: docs.missing_docs.includes("docs/backup-restore-playbook.md") ? "needs_review" : "ok"
      },
      incident_playbook: {
        status: docs.missing_docs.includes("docs/incident-response-playbook.md") ? "needs_review" : "ok"
      },
      launch_checklist: {
        status: docs.missing_docs.includes("docs/launch-readiness-checklist.md") ? "needs_review" : "ok"
      },
      notification_plan_doc: {
        status: docs.missing_docs.includes("docs/notification-center-plan.md") ? "needs_review" : "ok"
      },
      billing_hardening_doc: {
        status: docs.missing_docs.includes("docs/billing-lifecycle-hardening-plan.md") ? "needs_review" : "ok"
      },
      production_storage_doc: {
        status: docs.missing_docs.includes("docs/production-storage-plan.md") ? "needs_review" : "ok"
      },
      monitoring_plan_doc: {
        status: docs.missing_docs.includes("docs/monitoring-alerts-plan.md") ? "needs_review" : "ok"
      },
      backup_plan_doc: {
        status: docs.missing_docs.includes("docs/backup-automation-plan.md") ? "needs_review" : "ok"
      },
      reputation_plan_doc: {
        status: docs.missing_docs.includes("docs/reputation-scoring-plan.md") ? "needs_review" : "ok"
      }
    };
    const allOk = Object.values(checks).every((item) => item && item.status === "ok");
    return {
      status: allOk ? "ok" : "needs_review",
      checks,
      docs
    };
  } catch (err) {
    logger.error("HEALTH_WORKFLOW_READINESS_FAILED", err);
    return {
      status: "needs_review",
      warning: err.message || "Workflow readiness unavailable",
      checks: {
        support_system: { status: "needs_review" },
        verification_system: { status: "needs_review" },
        moderation_system: { status: "needs_review" },
        disputes_system: { status: "needs_review" },
        notifications_system: { status: "needs_review" },
        reputation_system: { status: "needs_review" },
        founding_partner_invites: { status: "needs_review" },
        billing_lifecycle_audit: { status: "needs_review" },
        monitoring_system: { status: "needs_review" },
        backup_system: { status: "needs_review" },
        invite_validation: { status: "needs_review" },
        reputation_engine: { status: "needs_review" },
        notification_triggers: { status: "needs_review" },
        upload_storage: { status: "needs_review", mode: "unknown" },
        backup_docs: { status: "needs_review" },
        incident_playbook: { status: "needs_review" },
        launch_checklist: { status: "needs_review" },
        notification_plan_doc: { status: "needs_review" },
        billing_hardening_doc: { status: "needs_review" },
        production_storage_doc: { status: "needs_review" },
        monitoring_plan_doc: { status: "needs_review" },
        backup_plan_doc: { status: "needs_review" },
        reputation_plan_doc: { status: "needs_review" }
      },
      docs: docsPresenceReadiness()
    };
  }
}

async function getHealthReadiness() {
  const [database, migrations, billing, workflows] = await Promise.all([
    getDatabaseReadiness(),
    getMigrationStatus().catch(err => {
      logger.error("HEALTH_MIGRATION_READINESS_FAILED", err);
      return {
        status: "error",
        error: err.message || "Migration status unavailable"
      };
    }),
    getBillingReadiness(),
    getWorkflowReadiness()
  ]);

  const processStatus = getProcessReadiness();
  const stripe = await getStripeReadiness();
  const environment = getProductionEnvReadiness();
  const email = getEmailReadiness();
  const uploads = getUploadReadiness();
  const queue = getQueueStatus();
  const scheduler = getSchedulerStatus();
  const storageActivation = getStorageActivationStatus();
  const { getMonitoringActivationReadiness } = require("./monitoringService");
  const monitoringActivation = getMonitoringActivationReadiness();
  const backupSchedule = validateBackupScheduleReadiness();
  const backupRetention = validateBackupRetentionReadiness();
  const backupRestore = validateRestoreDrillReadiness();
  const launchDocs = docsPresenceReadiness();
  const launchBlockers = [];
  if (String(NODE_ENV).toLowerCase() === "production" && !BILLING_LIFECYCLE_AUTOMATION) {
    launchBlockers.push("billing_lifecycle_automation");
  }
  if (storageActivation.status !== "ready") launchBlockers.push("storage_activation");
  if (monitoringActivation.status !== "ready") launchBlockers.push("monitoring_activation");
  if (backupSchedule.status !== "ok" || backupRetention.status !== "ok" || backupRestore.status !== "ok") {
    launchBlockers.push("backup_scheduling");
  }
  if (launchDocs.status !== "ok") launchBlockers.push("launch_docs");
  const environmentReady = environment.production
    ? environment.status === "ready"
    : environment.status !== "critical_missing";
  const uploadsReady = uploads.status !== "error";
  const launchReady = !environment.production || launchBlockers.length === 0;
  const ok = database.status === "ok"
    && migrations.status === "current"
    && environmentReady
    && uploadsReady
    && launchReady;

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
    storage_activation: storageActivation,
    monitoring_activation: monitoringActivation,
    backup_scheduling: {
      status: (backupSchedule.status === "ok" && backupRetention.status === "ok" && backupRestore.status === "ok") ? "ready" : "needs_review",
      schedule: backupSchedule,
      retention: backupRetention,
      restore: backupRestore
    },
    launch_docs: launchDocs,
    launch_blockers: {
      status: launchBlockers.length ? "not_ready" : "ready",
      count: launchBlockers.length,
      items: launchBlockers
    },
    workflows,
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
      },
      launch_readiness: workflows
    }
  };
}

/**
 * Strip infrastructure and operational detail from readiness for unauthenticated HTTP probes.
 * Preserves fields relied on by scripts/smoke-test.js (`ok`, `database.status`, `migrations.status`).
 */
function sanitizeHealthReadinessForPublic(fullReadiness) {
  const database = fullReadiness.database || {};
  const migrations = fullReadiness.migrations || {};
  const workflows = fullReadiness.workflows || {};
  const stripe = fullReadiness.stripe || {};
  return {
    ok: Boolean(fullReadiness.ok),
    app: fullReadiness.app || "FairLinx",
    database: {
      status: database.status || "unknown"
    },
    migrations: {
      status: migrations.status || "unknown"
    },
    workflows: {
      status: workflows.status || "unknown"
    },
    stripe: {
      status: stripe.status || "unknown",
      checkout_configured: Boolean(stripe.checkout_configured),
      checkout_status: stripe.checkout_status || "unknown",
      webhook_secret_configured: Boolean(stripe.webhook_secret_configured),
      portal_configured: Boolean(stripe.portal_configured),
      missing_checkout_config: Array.isArray(stripe.missing_checkout_config) ? stripe.missing_checkout_config : [],
      invalid_checkout_config: Array.isArray(stripe.invalid_checkout_config) ? stripe.invalid_checkout_config : [],
      provider: stripe.provider && typeof stripe.provider === "object"
        ? {
          status: stripe.provider.status || "unknown",
          code: stripe.provider.code || undefined,
          error: stripe.provider.error || undefined
        }
        : { status: "unknown" }
    },
    time: new Date().toISOString()
  };
}

module.exports = {
  getHealthReadiness,
  sanitizeHealthReadinessForPublic,
  getDatabaseReadiness,
  getBillingReadiness,
  getStripeReadiness,
  getWorkflowReadiness
};

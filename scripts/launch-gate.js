#!/usr/bin/env node
/**
 * Safe launch-gate checks for local and CI runs.
 *
 * Default mode is filesystem/static only and does not connect to a database.
 * DB checks require ALLOW_DB_TESTS=true and TEST_DATABASE_URL.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

const syntaxFiles = [
  "server.js",
  "config/env.js",
  "db/pool.js",
  "db/setup.js",
  "routes/auth.js",
  "routes/jobs.js",
  "routes/subscriptions.js",
  "routes/invoices.js",
  "routes/payments.js",
  "routes/billing.js",
  "routes/customer.js",
  "routes/notifications.js",
  "routes/platform.js",
  "routes/support.js",
  "routes/marketplace.js",
  "routes/messages.js",
  "routes/uploads.js",
  "routes/trust.js",
  "routes/workers.js",
  "routes/companies.js",
  "services/uploadService.js",
  "services/subscriptionEngine.js",
  "services/billingService.js",
  "services/stripeWebhookService.js",
  "services/financialIntegrityService.js",
  "services/trustExpiryService.js",
  "services/productionReadiness.js",
  "services/notificationService.js",
  "services/monitoringService.js",
  "services/backupService.js",
  "services/reputationService.js",
  "services/growthFoundationService.js",
  "services/trustReputationService.js",
  "services/growthOsService.js",
  "services/backgroundTasks.js",
  "services/schedulerService.js",
  "services/jobQueue.js",
  "middleware/auth.js",
  "middleware/requireCompanyBillingForMutations.js",
  "routes/analytics.js",
  "scripts/integrity-audit.js",
  "scripts/repair-integrity-drift.js",
  "scripts/smoke-test.js"
];

const sourceExpectations = [
  {
    name: "final launch docs exist",
    file: "docs/open-launch-audit.md",
    patterns: [
      "Go/No-Go Matrix",
      "Launch Blockers",
      "Launch Risks"
    ]
  },
  {
    name: "production cutover checklist exists",
    file: "docs/production-cutover-checklist.md",
    patterns: [
      "Environment Verification",
      "Rollback Checklist",
      "Smoke Tests"
    ]
  },
  {
    name: "launch marketing assets doc exists",
    file: "docs/launch-marketing-assets.md",
    patterns: [
      "No-Commission Positioning",
      "TikTok Ad Angle",
      "Referral Angle"
    ]
  },
  {
    name: "storage activation checklist exists",
    file: "docs/storage-activation-checklist.md",
    patterns: [
      "getStorageActivationStatus",
      "validateStorageDriverEnv"
    ]
  },
  {
    name: "monitoring activation checklist exists",
    file: "docs/monitoring-activation-checklist.md",
    patterns: [
      "alert channel readiness",
      "uptime monitor readiness"
    ]
  },
  {
    name: "backup scheduling checklist exists",
    file: "docs/backup-scheduling-checklist.md",
    patterns: [
      "backups/readiness",
      "restore drill readiness"
    ]
  },
  {
    name: "readiness endpoints exist",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/storage/readiness\", platformOnly",
      "router.get(\"/platform/monitoring/readiness\", platformOnly",
      "router.get(\"/platform/backups/readiness\", platformOnly"
    ]
  },
  {
    name: "platform final launch center exists",
    file: "public/platform.html",
    patterns: [
      "Final Launch Center",
      "finalLaunchCenterGrid",
      "launchBlockersList",
      "renderFinalLaunchCenter"
    ]
  },
  {
    name: "phase 12 migration exists",
    file: "db/migrations/059_production_hardening_bundle.sql",
    patterns: [
      "ALTER TABLE company_invites",
      "CREATE TABLE IF NOT EXISTS reputation_score_audits"
    ]
  },
  {
    name: "upload adapter safety and readiness scaffolding exists",
    file: "services/uploadService.js",
    patterns: [
      "buildStorageAdapters",
      "getUploadAdapter",
      "getDeleteAdapter",
      "s3MissingEnvKeys",
      "r2MissingEnvKeys"
    ]
  },
  {
    name: "monitoring route is platform guarded",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/monitoring\", platformOnly",
      "getMonitoringSnapshot"
    ]
  },
  {
    name: "backup route is platform guarded",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/backups/status\", platformOnly",
      "getBackupReadiness"
    ]
  },
  {
    name: "invite validation and acceptance routes exist",
    file: "routes/customer.js",
    patterns: [
      "router.get(\"/invites/:token/validate\"",
      "createHash(\"sha256\")"
    ]
  },
  {
    name: "platform invite accept route exists",
    file: "routes/platform.js",
    patterns: [
      "router.patch(\"/platform/founding-partner/invites/:id/accept\", platformOnly"
    ]
  },
  {
    name: "reputation engine foundation exists",
    file: "services/reputationService.js",
    patterns: [
      "computeCompanyReputation",
      "refreshCompanyReputation",
      "reputation_score_audits"
    ]
  },
  {
    name: "phase 12 docs exist",
    file: "docs/production-storage-plan.md",
    patterns: [
      "Drivers",
      "readiness"
    ]
  },
  {
    name: "subscription worker ownership validation exists",
    file: "routes/subscriptions.js",
    patterns: [
      "async function resolveCompanyWorkerId",
      "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
      "Worker not found in this company"
    ]
  },
  {
    name: "subscription update preserves omitted fields",
    file: "routes/subscriptions.js",
    patterns: [
      "function hasBodyField",
      "const updates = []",
      "if (updates.length === 0)",
      "if (hasBodyField(req, \"worker_id\"))"
    ],
    absent: [
      "service || \"\",\n      frequency || \"\",\n      start_date || null,\n      next_date || null,\n      price || 0,\n      worker_id || null,\n      status || \"active\""
    ]
  },
  {
    name: "worker users are restricted to assigned jobs",
    file: "routes/workers.js",
    patterns: [
      "async function requireWorkerJobMutationAccess",
      "SELECT id FROM jobs WHERE id=$1 AND company_id=$2 AND worker_id=$3 LIMIT 1",
      "req.body.worker_id = workerId"
    ]
  },
  {
    name: "worker job admin updates validate worker company",
    file: "routes/workers.js",
    patterns: [
      "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
      "Worker not found in this company"
    ]
  },
  {
    name: "subscription engine has DB advisory lock",
    file: "services/subscriptionEngine.js",
    patterns: [
      "pg_try_advisory_lock",
      "pg_advisory_unlock",
      "lock_unavailable"
    ]
  },
  {
    name: "duplicate subscription visits are DB-guarded",
    file: "db/migrations/026_subscription_visit_uniqueness.sql",
    patterns: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_subscription_visit",
      "ON jobs (company_id, source_subscription_id, date, type)",
      "type = 'subscription_visit'"
    ]
  },
  {
    name: "integrity audit checks launch-critical drift",
    file: "scripts/integrity-audit.js",
    patterns: [
      "jobs_worker_company_mismatch",
      "subscriptions_worker_company_mismatch",
      "duplicate_subscription_visits",
      "worker_zip_groups_worker_company_mismatch",
      "customer_accounts_missing_client",
      "job_photos_orphan_job_reference",
      "duplicate_background_jobs_same_payload"
    ]
  },
  {
    name: "staff auth validates JWT against live users row",
    file: "middleware/auth.js",
    patterns: [
      "validateStaffTokenAgainstDatabase",
      "SELECT id, role, company_id, worker_id",
      "COALESCE(active, TRUE)"
    ]
  },
  {
    name: "customer portal resolves canonical company from DB",
    file: "routes/customer.js",
    patterns: [
      "resolveCanonicalCustomerPrincipal",
      "ensureCustomerCompanyIsolation",
      "await resolveCanonicalCustomerPrincipal"
    ]
  },
  {
    name: "messages customer actor uses DB-resolved company_id",
    file: "routes/messages.js",
    patterns: [
      "canonicalCompanyId",
      "clientLookup",
      "tokenCompanyRaw !== canonicalCompanyId"
    ]
  },
  {
    name: "analytics queries use defensive ensureQueryResult",
    file: "routes/analytics.js",
    patterns: [
      "function ensureQueryResult",
      "analytics_query_fallback",
      "analytics_one"
    ]
  },
  {
    name: "upload service exposes orphan audit helpers",
    file: "services/uploadService.js",
    patterns: [
      "findOrphanUploads",
      "validateUploadOwnership",
      "getUploadCleanupCandidates"
    ]
  },
  {
    name: "job queue logs claimed work and skip-locked guard",
    file: "services/jobQueue.js",
    patterns: [
      "JOB_QUEUE_JOB_CLAIMED",
      "FOR UPDATE SKIP LOCKED"
    ]
  },
  {
    name: "scheduler logs advisory lock acquisition and contention",
    file: "services/schedulerService.js",
    patterns: [
      "SCHEDULER_ADVISORY_LOCK_ACQUIRED",
      "SCHEDULER_TASK_SKIPPED_DISTRIBUTED_LOCK",
      "pg_try_advisory_lock(hashtext($1))"
    ]
  },
  {
    name: "repair script is dry-run by default and apply-gated",
    file: "scripts/repair-integrity-drift.js",
    patterns: [
      "const apply = process.argv.includes(\"--apply\")",
      "BEGIN",
      "integrity_repair_backups",
      "ROLLBACK"
    ]
  },
  {
    name: "Stripe webhook raw body is mounted before JSON parser",
    file: "server.js",
    patterns: [
      "handleStripeWebhookRequest",
      "express.raw({ type: \"application/json\" })",
      "app.use(express.json({"
    ],
    ordered: [
      ["express.raw({ type: \"application/json\" })", "app.use(express.json({"]
    ]
  },
  {
    name: "Stripe webhook processing is signature-verified and idempotent",
    file: "services/stripeWebhookService.js",
    patterns: [
      "stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)",
      "const claimed = await tryClaimEvent(event.id, event.type)",
      "await markEventProcessed(event, audit || {})",
      "await markEventFailed(event, err, err.safeDetails || {})",
      "STRIPE_WEBHOOK_DUPLICATE_SKIPPED"
    ]
  },
  {
    name: "Stripe past-due sync preserves or seeds grace",
    file: "services/billingService.js",
    patterns: [
      "if ((billing_status === \"past_due\" || billing_status === \"unpaid\") && !billing_grace_until)",
      "billing_grace_until = addDaysIso(BILLING_GRACE_PERIOD_DAYS)",
      "if (billing_status === \"active\")",
      "billing_grace_until = null"
    ]
  },
  {
    name: "billing mutation gate blocks grace-expired and suspended companies",
    file: "services/billingService.js",
    patterns: [
      "async function getStaffMutationBillingBlock",
      "BILLING_GRACE_EXPIRED",
      "BILLING_SUSPENDED",
      "PLAN_LIMIT_EXCEEDED",
      "mutationLimitForRequest"
    ]
  },
  {
    name: "production Stripe key safety guard exists",
    file: "config/env.js",
    patterns: [
      "function isStripeTestSecretKey",
      "STRIPE_SECRET_KEY must not be a Stripe test key in production",
      "STRIPE_SECRET_KEY appears to be a placeholder value"
    ]
  },
  {
    name: "health endpoints distinguish live and ready",
    file: "server.js",
    patterns: [
      "app.get(\"/health/live\"",
      "app.get(\"/health/ready\"",
      "HEALTH_READINESS_NOT_READY",
      "getHealthReadiness()"
    ]
  },
  {
    name: "maintenance routes are production-gated",
    file: "config/env.js",
    patterns: [
      "ALLOW_MAINTENANCE_ROUTES must be false in production",
      "ALLOW_SEED_ADMIN must be false in production"
    ]
  },
  {
    name: "Neon pool readiness is configurable and exposed safely",
    file: "db/pool.js",
    patterns: [
      "PG_POOL_MAX",
      "getPoolReadinessInfo",
      "POSTGRES_POOL_ERROR",
      "neon_detected"
    ]
  },
  {
    name: "production readiness reports process database migrations queue scheduler",
    file: "services/productionReadiness.js",
    patterns: [
      "function getProcessReadiness",
      "getDatabaseReadiness",
      "getMigrationStatus",
      "getQueueStatus",
      "getSchedulerStatus"
    ]
  },
  {
    name: "platform health uses upload service readiness",
    file: "routes/platform.js",
    patterns: [
      "getUploadReadiness",
      "uploads: getUploadReadiness()"
    ],
    absent: [
      "uploads: {\n        status: \"configured\",\n        storage: \"local\"\n      }"
    ]
  },
  {
    name: "smoke test covers health ready and safe credential-gated probes",
    file: "scripts/smoke-test.js",
    patterns: [
      "/health/ready",
      "SMOKE_USERNAME",
      "SMOKE_PASSWORD",
      "billing probe"
    ]
  },
  {
    name: "Phase 5 production runbook exists",
    file: "docs/PHASE5_PRODUCTION_RUNBOOK.md",
    patterns: [
      "Deploy Checklist",
      "Neon Backup And Restore",
      "Migration Checklist",
      "Smoke Test Checklist",
      "Before Marketplace"
    ]
  },
  {
    name: "financial service blocks negative totals and transactional overpayments",
    file: "services/financialIntegrityService.js",
    patterns: [
      "INVOICE_NEGATIVE_TOTAL",
      "INVOICE_NEGATIVE_LINE_ITEM",
      "async function createPaymentRecord",
      "FOR UPDATE",
      "OVERPAYMENT"
    ]
  },
  {
    name: "payments route uses transactional financial payment helper",
    file: "routes/payments.js",
    patterns: [
      "createPaymentRecord",
      "source: \"workflow_payment\"",
      "Cannot add payment to cancelled invoice"
    ]
  },
  {
    name: "subscription mark-paid paths use net payments and ledger helpers",
    file: "routes/subscriptions.js",
    patterns: [
      "getNetPaidForInvoice",
      "appendPaymentLedgerEntry",
      "createPaymentRecord",
      "SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)",
      "Subscription price cannot be negative"
    ]
  },
  {
    name: "integrity audit checks financial balance drift",
    file: "scripts/integrity-audit.js",
    patterns: [
      "invoices_negative_totals",
      "invoice_line_item_total_mismatch",
      "payments_nonpositive_amount",
      "refunds_exceed_payment_amount",
      "invoice_net_paid_exceeds_total",
      "invoice_paid_status_balance_mismatch",
      "invoice_open_status_balance_mismatch"
    ]
  },
  {
    name: "marketplace company UI endpoints exist and are company-scoped",
    file: "routes/marketplace.js",
    patterns: [
      "router.get(\"/marketplace/opportunities\", companyAuth, requireMinimumRole(\"manager\")",
      "router.get(\"/marketplace/offers/me\", companyAuth, requireMinimumRole(\"manager\")",
      "WHERE mo.company_id = $1",
      "WHERE c.id = $1"
    ]
  },
  {
    name: "customer marketplace request creation always starts open",
    file: "routes/marketplace.js",
    patterns: [
      "router.post(\"/marketplace/requests\", customerAuth",
      "const status = \"open\";",
      "INSERT INTO marketplace_requests",
      "status"
    ],
    absent: [
      "normalizeStatus(req.body?.status"
    ]
  },
  {
    name: "company marketplace setup mutations are billing-gated",
    file: "routes/companies.js",
    patterns: [
      "requireCompanyBillingForMutations",
      "router.put(\"/companies/public-profile\", auth, requireCompanyBillingForMutations, requireMinimumRole(\"admin\")",
      "router.put(\"/companies/services\", auth, requireCompanyBillingForMutations, requireMinimumRole(\"admin\")",
      "router.put(\"/companies/service-areas\", auth, requireCompanyBillingForMutations, requireMinimumRole(\"admin\")",
      "router.put(\"/companies/availability\", auth, requireCompanyBillingForMutations, requireMinimumRole(\"admin\")"
    ]
  },
  {
    name: "support attachments only accept owned upload URLs",
    file: "routes/support.js",
    patterns: [
      "function isAllowedSupportAttachmentUrl",
      "raw.startsWith(\"/uploads/\")",
      "process.env.R2_PUBLIC_BASE_URL",
      "isAllowedSupportAttachmentUrl(item.file_url)"
    ]
  },
  {
    name: "trust proof documents only accept owned upload URLs",
    file: "routes/trust.js",
    patterns: [
      "function isAllowedTrustDocumentUrl",
      "raw.startsWith(\"/uploads/\")",
      "process.env.R2_PUBLIC_BASE_URL",
      "!isAllowedTrustDocumentUrl(documentUrl)",
      "Document URL must use FairLinx upload storage"
    ]
  },
  {
    name: "customer marketplace and social routes use active account auth",
    file: "middleware/auth.js",
    patterns: [
      "async function verifyActiveCustomerBearerToken",
      "async function requireActiveCustomer",
      "FROM customer_accounts",
      "status !== \"active\"",
      "module.exports.requireActiveCustomer = requireActiveCustomer"
    ]
  },
  {
    name: "customer marketplace route uses shared active auth",
    file: "routes/marketplace.js",
    patterns: [
      "requireActiveCustomer",
      "const customerAuth = requireActiveCustomer"
    ],
    absent: [
      "verifyCustomerBearerToken"
    ]
  },
  {
    name: "customer social routes use shared active auth",
    file: "routes/reviews.js",
    patterns: [
      "requireActiveCustomer",
      "const customerAuth = requireActiveCustomer"
    ],
    absent: [
      "verifyCustomerBearerToken"
    ]
  },
  {
    name: "customer favorites route uses shared active auth",
    file: "routes/favorites.js",
    patterns: [
      "requireActiveCustomer",
      "const customerAuth = requireActiveCustomer"
    ],
    absent: [
      "verifyCustomerBearerToken"
    ]
  },
  {
    name: "customer follows route uses shared active auth",
    file: "routes/follows.js",
    patterns: [
      "requireActiveCustomer",
      "const customerAuth = requireActiveCustomer"
    ],
    absent: [
      "verifyCustomerBearerToken"
    ]
  },
  {
    name: "messages customer branch refreshes account status",
    file: "routes/messages.js",
    patterns: [
      "verifyActiveCustomerBearerToken",
      "const active = await verifyActiveCustomerBearerToken(req.headers.authorization)",
      "req.customerAccount = active.account"
    ]
  },
  {
    name: "verification engine migration includes required fields and indexes",
    file: "db/migrations/055_company_verification_engine.sql",
    patterns: [
      "ADD COLUMN IF NOT EXISTS verification_status",
      "ADD COLUMN IF NOT EXISTS verified_at",
      "ADD COLUMN IF NOT EXISTS verified_by",
      "ADD COLUMN IF NOT EXISTS verification_notes",
      "ADD COLUMN IF NOT EXISTS license_status",
      "ADD COLUMN IF NOT EXISTS insurance_status",
      "ADD COLUMN IF NOT EXISTS identity_status",
      "CREATE INDEX IF NOT EXISTS idx_companies_verification_status",
      "CREATE INDEX IF NOT EXISTS idx_companies_license_status",
      "CREATE INDEX IF NOT EXISTS idx_companies_insurance_status",
      "CREATE INDEX IF NOT EXISTS idx_companies_identity_status"
    ]
  },
  {
    name: "platform verification routes are platform-owner guarded",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/verification/companies\", platformOnly",
      "router.patch(\"/platform/verification/companies/:id\", platformOnly"
    ]
  },
  {
    name: "discover verified badge uses verification_status",
    file: "public/discover.html",
    patterns: [
      "trust.verification_status === \"verified\"",
      "Verified</span>"
    ]
  },
  {
    name: "company profile trust badges use verification engine statuses",
    file: "public/company-profile.html",
    patterns: [
      "trust.verification_status === \"verified\"",
      "trust.license_status",
      "trust.insurance_status",
      "trust.identity_status"
    ]
  },
  {
    name: "abuse reporting migration exists with moderation indexes",
    file: "db/migrations/056_abuse_reporting_moderation.sql",
    patterns: [
      "CREATE TABLE IF NOT EXISTS abuse_reports",
      "target_type IN ('company', 'review', 'message', 'marketplace_request')",
      "status IN ('open', 'reviewing', 'action_taken', 'dismissed', 'closed')",
      "priority IN ('low', 'medium', 'high', 'urgent')",
      "CREATE INDEX IF NOT EXISTS idx_abuse_reports_target",
      "CREATE INDEX IF NOT EXISTS idx_abuse_reports_company_id",
      "CREATE INDEX IF NOT EXISTS idx_abuse_reports_status",
      "CREATE INDEX IF NOT EXISTS idx_abuse_reports_priority",
      "CREATE INDEX IF NOT EXISTS idx_abuse_reports_created_at"
    ]
  },
  {
    name: "platform moderation routes are platform-owner guarded",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/moderation/reports\", platformOnly",
      "router.patch(\"/platform/moderation/reports/:id\", platformOnly"
    ]
  },
  {
    name: "public report endpoints exist",
    file: "routes/companies.js",
    patterns: [
      "router.post(\"/companies/:id/report\""
    ]
  },
  {
    name: "reviews report endpoint exists",
    file: "routes/reviews.js",
    patterns: [
      "router.post(\"/reviews/:id/report\""
    ]
  },
  {
    name: "messages report endpoint exists",
    file: "routes/messages.js",
    patterns: [
      "router.post(\"/messages/:id/report\""
    ]
  },
  {
    name: "marketplace request report endpoint exists",
    file: "routes/marketplace.js",
    patterns: [
      "router.post(\"/marketplace/requests/:id/report\""
    ]
  },
  {
    name: "dispute system migration exists with required checks and indexes",
    file: "db/migrations/057_dispute_system.sql",
    patterns: [
      "CREATE TABLE IF NOT EXISTS disputes",
      "opened_by_type IN ('customer', 'company', 'platform')",
      "status IN ('open', 'reviewing', 'waiting_customer', 'waiting_company', 'resolved', 'closed')",
      "priority IN ('low', 'medium', 'high', 'urgent')",
      "CREATE INDEX IF NOT EXISTS idx_disputes_marketplace_request_id",
      "CREATE INDEX IF NOT EXISTS idx_disputes_support_ticket_id",
      "CREATE INDEX IF NOT EXISTS idx_disputes_company_id",
      "CREATE INDEX IF NOT EXISTS idx_disputes_customer_id",
      "CREATE INDEX IF NOT EXISTS idx_disputes_status",
      "CREATE INDEX IF NOT EXISTS idx_disputes_priority",
      "CREATE INDEX IF NOT EXISTS idx_disputes_created_at"
    ]
  },
  {
    name: "platform dispute routes are platform-owner guarded",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/disputes\", platformOnly",
      "router.patch(\"/platform/disputes/:id\", platformOnly"
    ]
  },
  {
    name: "marketplace dispute route exists",
    file: "routes/marketplace.js",
    patterns: [
      "router.post(\"/marketplace/requests/:id/dispute\""
    ]
  },
  {
    name: "support dispute route exists",
    file: "routes/support.js",
    patterns: [
      "router.post(",
      "\"/support/tickets/:id/dispute\""
    ]
  },
  {
    name: "phase 11 notifications migration exists",
    file: "db/migrations/058_notifications_reputation_invites.sql",
    patterns: [
      "CREATE TABLE IF NOT EXISTS notifications",
      "type IN ('marketplace', 'support', 'dispute', 'verification', 'billing', 'system')",
      "ADD COLUMN IF NOT EXISTS reputation_score",
      "CREATE TABLE IF NOT EXISTS company_invites",
      "token_hash TEXT"
    ]
  },
  {
    name: "notification service exposes scoped helpers",
    file: "services/notificationService.js",
    patterns: [
      "listNotificationsForUser",
      "markNotificationRead",
      "countUnreadNotifications",
      "customer_id = $1",
      "company_id = $1",
      "(user_id IS NULL OR user_id = $2)"
    ]
  },
  {
    name: "customer notifications routes are active-customer scoped",
    file: "routes/notifications.js",
    patterns: [
      "router.get(\"/customer/notifications\", auth.requireActiveCustomer",
      "router.patch(\"/customer/notifications/:id/read\", auth.requireActiveCustomer",
      "customerId = Number(req.customer && req.customer.client_id)"
    ]
  },
  {
    name: "platform founding partner invite routes exist",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/founding-partner/invites\", platformOnly",
      "router.post(\"/platform/founding-partner/invites\", platformOnly",
      "router.patch(\"/platform/founding-partner/invites/:id/cancel\", platformOnly"
    ]
  },
  {
    name: "platform billing lifecycle audit route exists",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/billing-lifecycle/audit\", platformOnly",
      "status_counts",
      "missing_stripe_fields",
      "warnings"
    ]
  },
  {
    name: "companies public responses include reputation score",
    file: "routes/companies.js",
    patterns: [
      "reputation_score",
      "shapePublicCompany"
    ]
  },
  {
    name: "discover and company profile reputation UI use neutral fallback",
    file: "public/discover.html",
    patterns: [
      "getReputationScore",
      "Neutral"
    ]
  },
  {
    name: "company profile reputation UI uses neutral fallback",
    file: "public/company-profile.html",
    patterns: [
      "reputationScore",
      "Neutral"
    ]
  },
  {
    name: "launch readiness docs exist",
    file: "docs/launch-readiness-checklist.md",
    patterns: [
      "Go/No-Go",
      "Tenant Isolation",
      "Verification Workflow",
      "Moderation Workflow",
      "Dispute Workflow"
    ]
  },
  {
    name: "incident response playbook exists",
    file: "docs/incident-response-playbook.md",
    patterns: [
      "Severity Levels",
      "Auth Incident Response",
      "Rollback Steps",
      "Communication Templates"
    ]
  },
  {
    name: "backup restore playbook exists",
    file: "docs/backup-restore-playbook.md",
    patterns: [
      "pg_dump",
      "Restore Checklist",
      "RPO",
      "RTO"
    ]
  },
  {
    name: "founding partner onboarding guide exists",
    file: "docs/founding-partner-onboarding.md",
    patterns: [
      "Partner Eligibility",
      "Verification Checklist",
      "Support Expectations"
    ]
  },
  {
    name: "notification center plan exists",
    file: "docs/notification-center-plan.md",
    patterns: [
      "Notification Types",
      "Read/Unread Model",
      "Support/Dispute Notifications"
    ]
  },
  {
    name: "billing lifecycle hardening plan exists",
    file: "docs/billing-lifecycle-hardening-plan.md",
    patterns: [
      "grace",
      "Mutation Blocking Rules",
      "Webhook Recovery Checklist"
    ]
  },
  {
    name: "production readiness includes workflow checks",
    file: "services/productionReadiness.js",
    patterns: [
      "getWorkflowReadiness",
      "support_system",
      "verification_system",
      "moderation_system",
      "disputes_system",
      "launch_checklist"
    ]
  },
  {
    name: "platform launch readiness endpoint exists",
    file: "routes/platform.js",
    patterns: [
      "router.get(\"/platform/launch-readiness\", platformOnly",
      "getHealthReadiness"
    ]
  },
  {
    name: "platform UI has launch readiness panel",
    file: "public/platform.html",
    patterns: [
      "Launch Readiness",
      "launchReadinessGrid",
      "renderLaunchReadiness"
    ]
  }
];

const allowedDuplicateMigrationPrefixes = new Map([
  ["050", ["050_company_trust_layer.sql", "050_job_estimate_uniqueness.sql"]],
  ["051", ["051_company_reports.sql", "051_customer_accounts_email_ci_uniqueness.sql"]]
]);

let failures = 0;
let skips = 0;

function rel(file) {
  return path.join(root, file);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function skip(message) {
  skips += 1;
  console.log(`SKIP ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    shell: /^win/.test(process.platform),
    ...options
  });

  return result;
}

function checkSyntax() {
  for (const file of syntaxFiles) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`missing syntax target ${file}`);
      continue;
    }

    try {
      new vm.Script(fs.readFileSync(filePath, "utf8"), { filename: filePath });
      pass(`syntax parse ${file}`);
    } catch (err) {
      fail(`syntax parse ${file}\n${err && err.message}`);
    }
  }
}

function checkSourceExpectations() {
  for (const check of sourceExpectations) {
    const filePath = rel(check.file);
    if (!fs.existsSync(filePath)) {
      fail(`${check.name}: missing ${check.file}`);
      continue;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const missing = (check.patterns || []).filter(pattern => !source.includes(pattern));
    const presentButForbidden = (check.absent || []).filter(pattern => source.includes(pattern));
    const unordered = (check.ordered || []).filter(([before, after]) => {
      const beforeIndex = source.indexOf(before);
      const afterIndex = source.indexOf(after);
      return beforeIndex === -1 || afterIndex === -1 || beforeIndex >= afterIndex;
    });

    if (missing.length || presentButForbidden.length || unordered.length) {
      fail(`${check.name}: missing=${JSON.stringify(missing)} forbidden=${JSON.stringify(presentButForbidden)} unordered=${JSON.stringify(unordered)}`);
    } else {
      pass(check.name);
    }
  }
}

function checkVerificationPublicExposure() {
  const filePath = rel("routes/companies.js");
  if (!fs.existsSync(filePath)) {
    fail("verification public exposure check: missing routes/companies.js");
    return;
  }
  const source = fs.readFileSync(filePath, "utf8");
  const fnStart = source.indexOf("async function shapePublicCompany");
  if (fnStart === -1) {
    fail("verification public exposure check: shapePublicCompany missing");
    return;
  }
  const fnEnd = source.indexOf("function cleanCustomServiceName", fnStart);
  const slice = source.slice(fnStart, fnEnd === -1 ? source.length : fnEnd);
  if (!slice.includes("verification_status") || !slice.includes("verified_at") || !slice.includes("identity_status")) {
    fail("verification public exposure check: required public verification fields missing in shapePublicCompany");
    return;
  }
  if (slice.includes("verification_notes") || slice.includes("verified_by")) {
    fail("verification public exposure check: internal verification fields exposed in shapePublicCompany");
    return;
  }
  pass("verification public exposure check");
}

function checkAbuseReportPublicExposure() {
  const files = [
    "routes/companies.js",
    "routes/reviews.js",
    "routes/messages.js",
    "routes/marketplace.js"
  ];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`abuse report public exposure check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("RETURNING id, target_type, target_id, reason, details, status, priority, created_at, resolution_notes")) {
      fail(`abuse report public exposure check: ${file} exposes resolution_notes`);
      return;
    }
  }
  pass("abuse report public exposure check");
}

function checkNoModerationDestructiveDelete() {
  const files = [
    "routes/platform.js",
    "routes/companies.js",
    "routes/reviews.js",
    "routes/messages.js",
    "routes/marketplace.js"
  ];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`moderation destructive delete check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8").toLowerCase();
    if (source.includes("delete from abuse_reports")) {
      fail(`moderation destructive delete check: delete from abuse_reports found in ${file}`);
      return;
    }
  }
  pass("moderation destructive delete check");
}

function checkFrontendReportHandlersNoInlineOnclick() {
  const files = [
    "public/company-profile.html",
    "public/discover.html",
    "public/trust.html",
    "public/platform.html"
  ];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`frontend report onclick check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8").toLowerCase();
    if (source.includes("onclick=")) {
      fail(`frontend report onclick check: inline onclick found in ${file}`);
      return;
    }
  }
  pass("frontend report onclick check");
}

function checkDisputeNoPaymentOrStripeLogic() {
  const checks = [
    { file: "routes/marketplace.js", anchor: "/marketplace/requests/:id/dispute" },
    { file: "routes/support.js", anchor: "/support/tickets/:id/dispute" },
    { file: "routes/platform.js", anchor: "/platform/disputes" }
  ];
  const forbidden = ["stripe", "refund", "payment_status", "payout", "chargeback"];
  for (const check of checks) {
    const filePath = rel(check.file);
    if (!fs.existsSync(filePath)) {
      fail(`dispute payment/stripe check: missing ${check.file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8");
    const anchorIndex = source.indexOf(check.anchor);
    if (anchorIndex === -1) {
      fail(`dispute payment/stripe check: missing anchor "${check.anchor}" in ${check.file}`);
      return;
    }
    const start = Math.max(0, anchorIndex - 1200);
    const end = Math.min(source.length, anchorIndex + 5000);
    const slice = source.slice(start, end).toLowerCase();
    const hit = forbidden.find(token => slice.includes(token));
    if (hit) {
      fail(`dispute payment/stripe check: forbidden token "${hit}" near ${check.anchor} in ${check.file}`);
      return;
    }
  }
  pass("dispute payment/stripe check");
}

function checkDisputePublicExposure() {
  const files = ["routes/marketplace.js", "routes/support.js"];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`dispute public exposure check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("RETURNING") && source.includes("resolution_notes")) {
      fail(`dispute public exposure check: resolution_notes exposed in ${file}`);
      return;
    }
  }
  pass("dispute public exposure check");
}

function checkLaunchReadinessNoPaymentLogicChange() {
  const checks = [
    { file: "routes/platform.js", anchor: "/platform/launch-readiness" },
    { file: "services/productionReadiness.js", anchor: "getWorkflowReadiness" },
    { file: "public/platform.html", anchor: "launchReadinessGrid" }
  ];
  const forbidden = ["refund", "payment reversal", "stripe.checkout.sessions.create", "stripe.webhooks.constructevent"];
  for (const check of checks) {
    const filePath = rel(check.file);
    if (!fs.existsSync(filePath)) {
      fail(`launch readiness payment logic check: missing ${check.file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8");
    const anchorIndex = source.indexOf(check.anchor);
    if (anchorIndex === -1) {
      fail(`launch readiness payment logic check: missing anchor "${check.anchor}" in ${check.file}`);
      return;
    }
    const start = Math.max(0, anchorIndex - 1500);
    const end = Math.min(source.length, anchorIndex + 4000);
    const slice = source.slice(start, end).toLowerCase();
    const hit = forbidden.find((token) => slice.includes(token));
    if (hit) {
      fail(`launch readiness payment logic check: forbidden token "${hit}" near ${check.anchor} in ${check.file}`);
      return;
    }
  }
  pass("launch readiness payment logic check");
}

function checkNoDestructiveSchemaPatternsInLaunchPhase() {
  const files = [
    "routes/platform.js",
    "routes/notifications.js",
    "routes/customer.js",
    "routes/companies.js",
    "services/notificationService.js",
    "services/productionReadiness.js",
    "db/migrations/058_notifications_reputation_invites.sql",
    "db/migrations/059_production_hardening_bundle.sql",
    "services/uploadService.js",
    "services/monitoringService.js",
    "services/backupService.js",
    "services/reputationService.js",
    "public/control.html",
    "public/customer-dashboard.html",
    "public/discover.html",
    "public/company-profile.html",
    "public/platform.html",
    "public/index.html",
    "public/for-customers.html",
    "public/for-companies.html",
    "scripts/launch-gate.js"
  ];
  const forbiddenPatterns = [/drop\s+table/i, /drop\s+column/i, /truncate\s+table/i];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`launch phase destructive schema check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8");
    if (forbiddenPatterns.some((pattern) => pattern.test(source))) {
      fail(`launch phase destructive schema check: destructive schema pattern found in ${file}`);
      return;
    }
  }
  pass("launch phase destructive schema check");
}

function checkPlatformNoInlineOnclick() {
  const file = "public/platform.html";
  const filePath = rel(file);
  if (!fs.existsSync(filePath)) {
    fail("platform inline onclick check: missing public/platform.html");
    return;
  }
  const source = fs.readFileSync(filePath, "utf8").toLowerCase();
  if (source.includes("onclick=")) {
    fail("platform inline onclick check: inline onclick found");
    return;
  }
  pass("platform inline onclick check");
}

function checkEditedLandingNoInlineOnclick() {
  const files = [
    "public/index.html",
    "public/for-customers.html",
    "public/for-companies.html"
  ];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`landing onclick check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8").toLowerCase();
    if (source.includes("onclick=")) {
      fail(`landing onclick check: inline onclick found in ${file}`);
      return;
    }
  }
  pass("landing onclick check");
}

function checkNotificationServiceOwnershipScoping() {
  const file = "services/notificationService.js";
  const filePath = rel(file);
  if (!fs.existsSync(filePath)) {
    fail("notification service scoping check: missing services/notificationService.js");
    return;
  }
  const source = fs.readFileSync(filePath, "utf8");
  const requiredTokens = [
    "customer_id = $1",
    "company_id = $1",
    "(user_id IS NULL OR user_id = $2)",
    "AND customer_id IS NULL"
  ];
  const missing = requiredTokens.filter((token) => !source.includes(token));
  if (missing.length) {
    fail(`notification service scoping check: missing=${JSON.stringify(missing)}`);
    return;
  }
  pass("notification service scoping check");
}

function checkNoFakeHighReputationScores() {
  const files = ["public/discover.html", "public/company-profile.html"];
  const suspicious = [/4\.9/g, /5\.0/g, /reputation[^\\n]{0,60}100/g, /reputation[^\\n]{0,60}99/g];
  for (const file of files) {
    const filePath = rel(file);
    if (!fs.existsSync(filePath)) {
      fail(`reputation fake-score check: missing ${file}`);
      return;
    }
    const source = fs.readFileSync(filePath, "utf8");
    const hasNeutralFallback = source.includes("Neutral");
    if (!hasNeutralFallback) {
      fail(`reputation fake-score check: neutral fallback missing in ${file}`);
      return;
    }
    if (suspicious.some((pattern) => pattern.test(source))) {
      fail(`reputation fake-score check: suspicious hardcoded high score in ${file}`);
      return;
    }
  }
  pass("reputation fake-score check");
}

function checkInviteTokensNotPlainText() {
  const file = "routes/platform.js";
  const filePath = rel(file);
  if (!fs.existsSync(filePath)) {
    fail("invite token safety check: missing routes/platform.js");
    return;
  }
  const source = fs.readFileSync(filePath, "utf8");
  const required = [
    "crypto.randomBytes",
    "createHash(\"sha256\")",
    "token_hash"
  ];
  const missing = required.filter((token) => !source.includes(token));
  if (missing.length) {
    fail(`invite token safety check: missing=${JSON.stringify(missing)}`);
    return;
  }
  if (source.includes("token_plain") || source.includes("plain_token")) {
    fail("invite token safety check: plain token storage pattern found");
    return;
  }
  pass("invite token safety check");
}

function checkBillingAuditReadOnlyNoStripe() {
  const file = "routes/platform.js";
  const filePath = rel(file);
  if (!fs.existsSync(filePath)) {
    fail("billing lifecycle audit safety check: missing routes/platform.js");
    return;
  }
  const source = fs.readFileSync(filePath, "utf8");
  const anchor = "router.get(\"/platform/billing-lifecycle/audit\", platformOnly";
  const idx = source.indexOf(anchor);
  if (idx === -1) {
    fail("billing lifecycle audit safety check: endpoint missing");
    return;
  }
  const slice = source.slice(idx, Math.min(source.length, idx + 4000)).toLowerCase();
  const forbidden = [
    "stripe.webhooks",
    "stripe.checkout",
    "stripe.customers",
    "stripe.subscriptions",
    "require(\"../services/stripe",
    "update companies",
    "insert into companies",
    "delete from companies",
    "suspendcompany",
    "unsuspendcompany"
  ];
  const hit = forbidden.find((token) => slice.includes(token));
  if (hit) {
    fail(`billing lifecycle audit safety check: forbidden token "${hit}"`);
    return;
  }
  pass("billing lifecycle audit safety check");
}

function checkMigrationPrefixCollisions() {
  const migrationsDir = rel("db/migrations");
  if (!fs.existsSync(migrationsDir)) {
    fail("migration prefix collision check: missing db/migrations");
    return;
  }

  const groups = new Map();
  for (const file of fs.readdirSync(migrationsDir)) {
    const match = /^(\d+)_.*\.sql$/.exec(file);
    if (!match) {
      continue;
    }
    const prefix = match[1];
    const files = groups.get(prefix) || [];
    files.push(file);
    groups.set(prefix, files);
  }

  const unexpected = [];
  const known = [];
  for (const [prefix, files] of groups.entries()) {
    if (files.length <= 1) {
      continue;
    }
    const sorted = files.slice().sort();
    const allowed = allowedDuplicateMigrationPrefixes.get(prefix);
    if (
      allowed
      && sorted.length === allowed.length
      && sorted.every((file, index) => file === allowed[index])
    ) {
      known.push(`${prefix}: ${sorted.join(", ")}`);
    } else {
      unexpected.push(`${prefix}: ${sorted.join(", ")}`);
    }
  }

  if (unexpected.length) {
    fail(`unexpected duplicate migration prefixes: ${unexpected.join("; ")}`);
    return;
  }

  if (known.length) {
    console.warn(`WARN known duplicate migration prefixes retained: ${known.join("; ")}`);
  }
  pass("migration duplicate prefix check");
}

function checkPublicEntrypoint() {
  const indexPath = rel("public/index.html");
  const serverPath = rel("server.js");
  if (!fs.existsSync(indexPath)) {
    fail("public entrypoint exists: missing public/index.html");
    return;
  }
  const serverSource = fs.readFileSync(serverPath, "utf8");
  const rootRoutePattern = /app\.get\(\s*["']\/["'][\s\S]*?path\.join\(\s*__dirname\s*,\s*["']public["']\s*,\s*["']index\.html["']\s*\)/;
  if (!rootRoutePattern.test(serverSource)) {
    fail("root route serves public/index.html");
    return;
  }
  pass("public entrypoint serves index.html");
}

function checkPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));
  const scripts = pkg.scripts || {};

  if (scripts.test === "npm run check") {
    pass("npm test delegates to launch gate");
  } else {
    fail("npm test must delegate to npm run check");
  }

  if (scripts.check === "node scripts/launch-gate.js") {
    pass("npm run check is wired");
  } else {
    fail("npm run check must run scripts/launch-gate.js");
  }
}

function checkDbGate() {
  const allowDbTests = String(process.env.ALLOW_DB_TESTS || "").toLowerCase() === "true";
  const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

  if (!allowDbTests) {
    skip("DB-dependent integrity audit (set ALLOW_DB_TESTS=true and TEST_DATABASE_URL)");
    return;
  }

  if (!testDatabaseUrl) {
    fail("ALLOW_DB_TESTS=true requires TEST_DATABASE_URL");
    return;
  }

  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    RUN_STARTUP_MIGRATIONS: "false"
  };
  const result = run(/^win/.test(process.platform) ? "npm.cmd" : "npm", ["run", "integrity:audit", "--", "--strict"], { env });

  if (result.status === 0) {
    pass("DB integrity audit strict on TEST_DATABASE_URL");
  } else {
    fail(`DB integrity audit strict failed\n${result.stdout}\n${result.stderr}`);
  }
}

function checkAdditionalIntegrityScripts() {
  const stableChecks = [
    { name: "navigation integrity", script: "check:navigation" },
    { name: "marketplace UI contract", script: "check:marketplace-contract" }
  ];

  for (const check of stableChecks) {
    const result = run(/^win/.test(process.platform) ? "npm.cmd" : "npm", ["run", check.script]);
    if (result.status === 0) {
      pass(check.name);
    } else {
      fail(`${check.name} failed\n${result.stdout}\n${result.stderr}`);
    }
  }
}

console.log("FairLinx launch gate");
checkSyntax();
checkSourceExpectations();
checkVerificationPublicExposure();
checkAbuseReportPublicExposure();
checkNoModerationDestructiveDelete();
checkFrontendReportHandlersNoInlineOnclick();
checkDisputeNoPaymentOrStripeLogic();
checkDisputePublicExposure();
checkLaunchReadinessNoPaymentLogicChange();
checkNoDestructiveSchemaPatternsInLaunchPhase();
checkPlatformNoInlineOnclick();
checkEditedLandingNoInlineOnclick();
checkNotificationServiceOwnershipScoping();
checkNoFakeHighReputationScores();
checkInviteTokensNotPlainText();
checkBillingAuditReadOnlyNoStripe();
checkMigrationPrefixCollisions();
checkPublicEntrypoint();
checkPackageScripts();
checkDbGate();
checkAdditionalIntegrityScripts();

if (failures > 0) {
  console.error(`Launch gate failed: ${failures} failure(s), ${skips} skipped.`);
  process.exit(1);
}

console.log(`Launch gate passed: ${skips} skipped.`);

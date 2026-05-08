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
  "routes/workers.js",
  "services/subscriptionEngine.js",
  "services/billingService.js",
  "services/stripeWebhookService.js",
  "services/financialIntegrityService.js",
  "services/productionReadiness.js",
  "services/backgroundTasks.js",
  "services/schedulerService.js",
  "services/jobQueue.js",
  "middleware/auth.js",
  "middleware/requireCompanyBillingForMutations.js",
  "scripts/integrity-audit.js",
  "scripts/repair-integrity-drift.js",
  "scripts/smoke-test.js"
];

const sourceExpectations = [
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
      "worker_zip_groups_worker_company_mismatch"
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
  }
];

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
checkPackageScripts();
checkDbGate();
checkAdditionalIntegrityScripts();

if (failures > 0) {
  console.error(`Launch gate failed: ${failures} failure(s), ${skips} skipped.`);
  process.exit(1);
}

console.log(`Launch gate passed: ${skips} skipped.`);

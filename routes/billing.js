const express = require("express");
const rateLimit = require("express-rate-limit");
const { NODE_ENV } = require("../config/env");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const {
  PLAN_LIMITS,
  getPlanLimits,
  getBillingSummary,
  getUsageForCompany,
  getBillingWarnings,
  updateCompanyPlatformSubscription,
  enrichBillingClientSummary,
  getPlatformBillingOverview,
  getCompanyBilling,
  getCompanySubscription,
  cancelCompanySubscription,
  reactivateCompanySubscription,
  normalizePlan,
  normalizeBillingStatus,
  computeTrialMeta,
  evaluatePastDueSuspensions,
  planRank,
  hasUsageWithinLimits,
  MAX_TENANT_TRIAL_DAYS,
  normalizeTenantTrialDays
} = require("../services/billingService");

const {
  createCheckoutSessionForCompany,
  getCheckoutSessionSummaryForCompany,
  changeStripeSubscriptionPlan,
  cancelStripeSubscriptionForCompany,
  reactivateStripeSubscriptionForCompany,
  createPortalSessionForCompany,
  isStripeCheckoutConfigured,
  isStripePortalConfigured,
  normalizeCheckoutPlan,
  yearlyPricesConfigured,
  internalPlanForCheckoutPlan,
  checkoutPlanFromInternalPlan
} = require("../services/stripeService");

const { syncSubscriptionToCompany, replayRetryableStripeEvents } = require("../services/stripeWebhookService");

const { getPlatformBillingAnalytics } = require("../services/platformBillingAnalyticsService");
const { logPlatformCompanyAudit } = require("../services/platformControlService");

const logger = require("../services/logger");
const activityLogService = require("../services/activityLogService");
const { sendSafeServerError } = require("../services/safeServerError");

const { requirePlatformOwner, requireRole } = auth;
const router = express.Router();
const platformOnly = [auth, requirePlatformOwner];
const billingOwnerAdminOnly = [auth, requireRole("owner", "admin")];

const checkoutSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checkout attempts, please try again later" }
});

function num(value) {
  return Number(value || 0);
}

const TENANT_PROTECTED_BILLING_FIELDS = new Set([
  "billing_status",
  "trial_ends_at",
  "billing_started_at",
  "billing_cancelled_at",
  "billing_grace_until",
  "billing_last_payment_failed_at",
  "billing_last_payment_succeeded_at",
  "billing_suspended_at",
  "billing_failure_reason",
  "platform_suspended_at",
  "platform_suspension_reason"
]);

function warningSummary(warnings) {
  const list = warnings && Array.isArray(warnings.warnings) ? warnings.warnings : [];
  return {
    warnings_count: list.length,
    has_billing_warning: list.length > 0,
    warning_types: list.map((warning) => warning.type).filter(Boolean)
  };
}

function resolveCheckoutPlanInput(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return checkoutPlanFromInternalPlan("starter");
  const direct = normalizeCheckoutPlan(normalized);
  if (direct) return direct;
  if (["starter", "pro", "enterprise"].includes(normalized)) {
    return checkoutPlanFromInternalPlan(normalized);
  }
  return null;
}

function billingProviderRequiredResponse(res) {
  return res.status(503).json({
    error: "Stripe billing is required for tenant plan and subscription changes.",
    code: "BILLING_PROVIDER_REQUIRED",
    warning_mode: true
  });
}

function tenantPlanFieldAttempt(body) {
  const payload = body || {};
  if (payload.plan_id !== undefined) return "plan_id";
  if (payload.plan_slug !== undefined) return "plan_slug";
  return null;
}

function validateTenantTrialDaysAtRoute(rawTrialDays) {
  try {
    return normalizeTenantTrialDays(rawTrialDays, 14);
  } catch (err) {
    if (err && err.code) {
      err.statusCode = err.statusCode || 400;
      throw err;
    }
    throw err;
  }
}

async function logTenantBillingMutation({
  req,
  action,
  details = {}
}) {
  try {
    await activityLogService.ensureActivityLogSchema();
    await activityLogService.logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action,
      entityType: "billing",
      entityId: req.user.company_id,
      details
    });
  } catch (err) {
    logger.warn("TENANT_BILLING_AUDIT_LOG_FAILED", {
      action,
      company_id: req.user && req.user.company_id,
      user_id: req.user && req.user.id,
      error: err && err.message
    });
  }
}

async function getActiveSubscriptionPlans() {
  const result = await pool.query(
    `
    SELECT
      id,
      name,
      slug,
      monthly_price,
      max_users,
      max_clients,
      max_jobs,
      max_invoices,
      max_workers,
      active,
      created_at
    FROM subscription_plans
    WHERE active = TRUE
    ORDER BY id ASC
    `
  );
  return result.rows;
}

async function getCompanyCurrentPlanRecord(companyId) {
  const result = await pool.query(
    `
    SELECT
      c.id AS company_id,
      c.plan,
      c.plan_id,
      c.billing_status,
      p.id AS selected_plan_id,
      p.name AS selected_plan_name,
      p.slug AS selected_plan_slug,
      p.monthly_price AS selected_plan_monthly_price,
      p.max_users AS selected_plan_max_users,
      p.max_clients AS selected_plan_max_clients,
      p.max_jobs AS selected_plan_max_jobs,
      p.max_invoices AS selected_plan_max_invoices,
      p.max_workers AS selected_plan_max_workers,
      p.active AS selected_plan_active,
      p.created_at AS selected_plan_created_at
    FROM companies c
    LEFT JOIN subscription_plans p ON p.id = c.plan_id
    WHERE c.id = $1
    LIMIT 1
    `,
    [companyId]
  );
  return result.rows[0] || null;
}

function normalizeRequestedBillingStatus(raw, fallbackStatus) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) {
    return normalizeBillingStatus(fallbackStatus || "active");
  }
  return normalizeBillingStatus(normalized);
}

function billingRouteError(res, err, label) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message || "Billing request failed",
      code: err.code || "BILLING_REQUEST_FAILED",
      details: err.details || null,
      warning_mode: true
    });
  }

  sendSafeServerError(res, err, label);
}

async function currentBillingPayload(companyId) {
  const summary = await getBillingSummary(companyId);
  if (!summary) return null;

  const enriched = enrichBillingClientSummary(summary);
  const subscription = await getCompanySubscription(companyId);
  const billing = enriched.billing || {};
  const stripeCustomerId = (subscription && subscription.stripe_customer_id) || billing.stripe_customer_id || null;
  const stripeSubscriptionId = (subscription && subscription.stripe_subscription_id) || billing.stripe_subscription_id || null;

  return {
    ...enriched,
    subscription,
    warnings: enriched.warnings || await getBillingWarnings(companyId),
    warning_mode: true,
    checkout_available: isStripeCheckoutConfigured(),
    yearly_billing_available: yearlyPricesConfigured(),
    portal_available: Boolean(stripeCustomerId && isStripePortalConfigured()),
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    current_period_start: subscription && subscription.current_period_start,
    current_period_end: subscription && subscription.current_period_end,
    cancel_at_period_end: subscription && subscription.cancel_at_period_end,
    payment_history: [],
    payment_history_available: false,
    recovery_required: ["past_due", "unpaid", "incomplete"].includes(normalizeBillingStatus(billing.billing_status)),
    recovery_url_available: Boolean(stripeCustomerId && isStripePortalConfigured()),
    billing_blocked: ["suspended", "cancelled", "expired", "unpaid"].includes(normalizeBillingStatus(billing.billing_status)),
    block_reason: (() => {
      const st = normalizeBillingStatus(billing.billing_status);
      if (st === "suspended") return "subscription_suspended";
      if (st === "cancelled") return "subscription_cancelled";
      if (st === "expired") return "subscription_expired";
      if (st === "unpaid") return "payment_required";
      return null;
    })(),
    payment_recovery: (() => {
      const b = enriched.billing || {};
      const st = normalizeBillingStatus(b.billing_status);
      const portalOk = Boolean(stripeCustomerId && isStripePortalConfigured());
      const needsRecovery = portalOk && ["past_due", "unpaid", "incomplete"].includes(st);
      return {
        retry_via_customer_portal: needsRecovery,
        flow: needsRecovery ? "customer_portal" : null,
        billing_failure_reason: b.billing_failure_reason || null
      };
    })()
  };
}

router.get("/billing/me", auth, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const payload = await currentBillingPayload(req.user.company_id);
    if (!payload) return res.status(404).json({ error: "Company not found" });

    res.json(payload);
  } catch (err) {
    sendSafeServerError(res, err, "BILLING ME ERROR");
  }
});

router.post("/billing/subscribe", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const planField = tenantPlanFieldAttempt(req.body);
    if (planField) {
      return res.status(403).json({
        error: "Direct plan_id/plan_slug changes are not allowed for tenant billing routes.",
        code: "TENANT_PLAN_OVERRIDE_BLOCKED",
        field: planField,
        warning_mode: true
      });
    }

    const trialDays = validateTenantTrialDaysAtRoute(req.body && req.body.trial_days);
    const selectedCheckoutPlan = resolveCheckoutPlanInput(req.body && req.body.plan);

    if (!isStripeCheckoutConfigured()) {
      return billingProviderRequiredResponse(res);
    }

    const session = await createCheckoutSessionForCompany({
      companyId: req.user.company_id,
      checkoutPlan: selectedCheckoutPlan,
      billing_cycle: req.body && req.body.billing_cycle,
      req
    });

    await logTenantBillingMutation({
      req,
      action: "tenant_billing_checkout_started",
      details: {
        checkout_plan: selectedCheckoutPlan,
        billing_cycle: req.body && req.body.billing_cycle ? String(req.body.billing_cycle) : "monthly",
        requested_trial_days: trialDays,
        max_trial_days: MAX_TENANT_TRIAL_DAYS
      }
    });

    return res.json({
      url: session.url,
      session_id: session.id,
      stripe_checkout: true,
      warning_mode: true
    });
  } catch (err) {
    billingRouteError(res, err, "BILLING SUBSCRIBE ERROR");
  }
});

router.post("/billing/upgrade", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    if (!isStripeCheckoutConfigured()) {
      return billingProviderRequiredResponse(res);
    }

    req.body = {
      ...(req.body || {}),
      plan: req.body && req.body.plan
    };
    return handleBillingPlanChange(req, res);
  } catch (err) {
    billingRouteError(res, err, "BILLING UPGRADE ERROR");
  }
});

router.post("/billing/downgrade", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    if (!isStripeCheckoutConfigured()) {
      return billingProviderRequiredResponse(res);
    }

    return handleBillingPlanChange(req, res);
  } catch (err) {
    billingRouteError(res, err, "BILLING DOWNGRADE ERROR");
  }
});

router.post("/billing/cancel", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const current = await getCompanySubscription(req.user.company_id);
    const stripeSubId = current && current.stripe_subscription_id
      ? String(current.stripe_subscription_id).trim()
      : "";

    if (isStripeCheckoutConfigured()) {
      if (!stripeSubId) {
        return res.status(409).json({
          error: "Stripe billing is configured, but this company has no linked Stripe subscription. Use Checkout or the Billing Portal.",
          code: "STRIPE_SUBSCRIPTION_REQUIRED",
          warning_mode: true
        });
      }

      if (current && current.cancel_at_period_end && !(req.body && req.body.cancel_at_period_end === false)) {
        return res.status(409).json({
          error: "Subscription is already scheduled for cancellation.",
          code: "CANCEL_ALREADY_SCHEDULED",
          cancel_at_period_end: true,
          current_period_end: current.current_period_end || null,
          warning_mode: true
        });
      }

      const refreshed = await cancelStripeSubscriptionForCompany({
        companyId: req.user.company_id,
        cancel_at_period_end: !(req.body && req.body.cancel_at_period_end === false)
      });
      await syncSubscriptionToCompany(refreshed, {});
      const subscription = await getCompanySubscription(req.user.company_id);
      const summary = await currentBillingPayload(req.user.company_id);

      return res.json({
        subscription,
        summary,
        warning_mode: true,
        stripe_updated: true
      });
    }

    const subscription = await cancelCompanySubscription(req.user.company_id, {
      cancel_at_period_end: !(req.body && req.body.cancel_at_period_end === false)
    });
    const summary = await currentBillingPayload(req.user.company_id);

    res.json({
      subscription,
      summary,
      warning_mode: true
    });
  } catch (err) {
    billingRouteError(res, err, "BILLING CANCEL ERROR");
  }
});

router.post("/billing/reactivate", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const current = await getCompanySubscription(req.user.company_id);
    const stripeSubId = current && current.stripe_subscription_id
      ? String(current.stripe_subscription_id).trim()
      : "";

    if (isStripeCheckoutConfigured()) {
      if (!stripeSubId) {
        return res.status(409).json({
          error: "Stripe billing is configured, but this company has no linked Stripe subscription. Start a new checkout session.",
          code: "STRIPE_SUBSCRIPTION_REQUIRED",
          warning_mode: true
        });
      }

      const refreshed = await reactivateStripeSubscriptionForCompany(req.user.company_id);
      await syncSubscriptionToCompany(refreshed, {});
      const subscription = await getCompanySubscription(req.user.company_id);
      const summary = await currentBillingPayload(req.user.company_id);

      return res.json({
        subscription,
        summary,
        warning_mode: true,
        stripe_updated: true
      });
    }

    const subscription = await reactivateCompanySubscription(req.user.company_id);
    const summary = await currentBillingPayload(req.user.company_id);

    res.json({
      subscription,
      summary,
      warning_mode: true
    });
  } catch (err) {
    billingRouteError(res, err, "BILLING REACTIVATE ERROR");
  }
});

router.get("/billing/plans", billingOwnerAdminOnly, async (req, res) => {
  try {
    const plans = await getActiveSubscriptionPlans();
    res.json({
      plans,
      warning_mode: true
    });
  } catch (err) {
    sendSafeServerError(res, err, "BILLING PLANS LIST ERROR");
  }
});

router.get("/billing/current-plan", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const row = await getCompanyCurrentPlanRecord(req.user.company_id);
    if (!row) {
      return res.status(404).json({ error: "Company not found" });
    }

    const selectedPlan = row.selected_plan_id
      ? {
        id: row.selected_plan_id,
        name: row.selected_plan_name,
        slug: row.selected_plan_slug,
        monthly_price: row.selected_plan_monthly_price,
        max_users: row.selected_plan_max_users,
        max_clients: row.selected_plan_max_clients,
        max_jobs: row.selected_plan_max_jobs,
        max_invoices: row.selected_plan_max_invoices,
        max_workers: row.selected_plan_max_workers,
        active: row.selected_plan_active,
        created_at: row.selected_plan_created_at
      }
      : null;

    res.json({
      company_id: row.company_id,
      billing_status: normalizeBillingStatus(row.billing_status),
      selected_plan: selectedPlan,
      legacy_plan: normalizePlan(row.plan),
      warning_mode: true
    });
  } catch (err) {
    sendSafeServerError(res, err, "BILLING CURRENT PLAN ERROR");
  }
});

async function handleStripeCheckoutSession(req, res) {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const session = await createCheckoutSessionForCompany({
      companyId: req.user.company_id,
      checkoutPlan: req.body && req.body.plan,
      billing_cycle: req.body && req.body.billing_cycle,
      req
    });

    res.json({
      url: session.url,
      session_id: session.id,
      warning_mode: true
    });
  } catch (err) {
    console.log("CREATE CHECKOUT SESSION ERROR:", err && err.message);

    if (err && err.code === "STRIPE_NOT_CONFIGURED") {
      return res.status(503).json({
        error: err.message || "Stripe is not configured",
        warning_mode: true
      });
    }

    if (err && err.code === "STRIPE_PRICE_MISSING") {
      return res.status(500).json({
        error: err.message || "Stripe price is not configured",
        warning_mode: true
      });
    }

    if (err && err.code === "STRIPE_YEARLY_PRICE_MISSING") {
      return res.status(500).json({
        error: err.message || "Stripe yearly price is not configured",
        warning_mode: true
      });
    }

    if (err && err.code === "CHECKOUT_ORIGIN") {
      return res.status(503).json({
        error: err.message || "Checkout redirect URL could not be determined",
        warning_mode: true
      });
    }

    if (err && (err.code === "INVALID_PLAN" || err.code === "COMPANY_NOT_FOUND")) {
      return res.status(400).json({
        error: err.message || "Invalid checkout request",
        warning_mode: true
      });
    }

    if (err && typeof err.type === "string" && err.type.indexOf("Stripe") === 0) {
      return res.status(502).json({
        error: "Payment provider error. Try again later.",
        warning_mode: true
      });
    }

    logger.error("CREATE CHECKOUT SESSION UNHANDLED ERROR", err);
    res.status(500).json({
      error: NODE_ENV === "production"
        ? "Internal server error"
        : (err && err.message) || "Checkout failed",
      warning_mode: true
    });
  }
}

router.post("/billing/create-checkout-session", billingOwnerAdminOnly, checkoutSessionLimiter, handleStripeCheckoutSession);
router.post("/billing/checkout", billingOwnerAdminOnly, checkoutSessionLimiter, handleStripeCheckoutSession);

router.get("/billing/checkout/session/:sessionId", billingOwnerAdminOnly, async (req, res) => {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const session = await getCheckoutSessionSummaryForCompany({
      companyId: req.user.company_id,
      sessionId: req.params.sessionId
    });
    const summary = await currentBillingPayload(req.user.company_id);

    res.json({
      session,
      billing: summary ? summary.billing : null,
      warning_mode: true
    });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message || "Checkout session is not available",
        code: err.code || "CHECKOUT_SESSION_UNAVAILABLE",
        warning_mode: true
      });
    }

    if (err && typeof err.type === "string" && err.type.indexOf("Stripe") === 0) {
      return res.status(502).json({
        error: "Payment provider error. Try again later.",
        warning_mode: true
      });
    }

    sendSafeServerError(res, err, "BILLING CHECKOUT SESSION ERROR");
  }
});

async function handleStripePortalSession(req, res, options = {}) {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const session = await createPortalSessionForCompany({
      companyId: req.user.company_id,
      req,
      return_query: options.return_query
    });

    res.json({
      url: session.url,
      warning_mode: true
    });
  } catch (err) {
    if (err && err.code === "STRIPE_CUSTOMER_MISSING") {
      return res.status(400).json({
        error: err.message || "Stripe customer is not available for this company.",
        warning_mode: true
      });
    }

    if (err && err.code === "STRIPE_NOT_CONFIGURED") {
      return res.status(503).json({
        error: err.message || "Stripe is not configured",
        warning_mode: true
      });
    }

    if (err && err.code === "CHECKOUT_ORIGIN") {
      return res.status(503).json({
        error: err.message || "Portal redirect URL could not be determined",
        warning_mode: true
      });
    }

    if (err && typeof err.type === "string" && err.type.indexOf("Stripe") === 0) {
      return res.status(502).json({
        error: "Payment provider error. Try again later.",
        warning_mode: true
      });
    }

    sendSafeServerError(res, err, "CREATE PORTAL SESSION ERROR");
  }
}

router.post("/billing/create-portal-session", billingOwnerAdminOnly, (req, res) => handleStripePortalSession(req, res));
router.post("/billing/portal", billingOwnerAdminOnly, (req, res) => handleStripePortalSession(req, res));
router.post("/billing/recovery", billingOwnerAdminOnly, (req, res) => handleStripePortalSession(req, res, {
  return_query: "billing=recovery"
}));

async function handleBillingPlanChange(req, res) {
  try {
    if (!req.user.company_id) {
      return res.status(400).json({ error: "Company billing is not available for this account" });
    }

    const protectedFieldAttempt = Object.keys(req.body || {}).find((key) => TENANT_PROTECTED_BILLING_FIELDS.has(key));
    if (protectedFieldAttempt) {
      return res.status(403).json({
        error: "Billing status and protected billing fields are managed by Stripe or platform controls only.",
        code: "PROTECTED_BILLING_FIELD",
        field: protectedFieldAttempt,
        warning_mode: true
      });
    }

    const planField = tenantPlanFieldAttempt(req.body);
    if (planField) {
      return res.status(403).json({
        error: "Direct plan_id/plan_slug changes are not allowed for tenant billing routes.",
        code: "TENANT_PLAN_OVERRIDE_BLOCKED",
        field: planField,
        warning_mode: true
      });
    }

    const targetCheckout = resolveCheckoutPlanInput(req.body && req.body.plan);
    if (!targetCheckout) {
      return res.status(400).json({
        error: "Invalid plan. Use starter, pro, enterprise, basic, or business.",
        warning_mode: true
      });
    }

    const targetInternal = internalPlanForCheckoutPlan(targetCheckout);
    const subscription = await getCompanySubscription(req.user.company_id);
    const currentInternal = subscription ? normalizePlan(subscription.plan) : normalizePlan("starter");
    const rankCur = planRank(currentInternal);
    const rankTgt = planRank(targetInternal);

    if (rankTgt === rankCur) {
      return res.status(400).json({
        error: "Company is already on the requested plan tier.",
        warning_mode: true
      });
    }

    const direction = rankTgt > rankCur ? "upgrade" : "downgrade";
    const stripeSubId = subscription && subscription.stripe_subscription_id
      ? String(subscription.stripe_subscription_id).trim()
      : "";

    if (!isStripeCheckoutConfigured()) {
      return billingProviderRequiredResponse(res);
    }

    if (!stripeSubId) {
      return res.status(409).json({
        error: "Use Stripe Checkout to start billing before changing plans.",
        code: "STRIPE_SUBSCRIPTION_REQUIRED",
        warning_mode: true
      });
    }

    if (direction === "downgrade") {
      const usage = await getUsageForCompany(req.user.company_id);
      const limits = getPlanLimits(targetInternal);
      const failures = hasUsageWithinLimits(usage, limits);
      if (failures.length) {
        return res.status(409).json({
          error: "Current usage exceeds the target plan limits.",
          code: "DOWNGRADE_BELOW_USAGE",
          details: failures,
          warning_mode: true
        });
      }
    }

    const proration = req.body && req.body.proration_behavior;
    const refreshed = await changeStripeSubscriptionPlan({
      companyId: req.user.company_id,
      checkoutPlan: targetCheckout,
      billing_cycle: req.body && req.body.billing_cycle,
      proration_behavior: typeof proration === "string" && proration.trim()
        ? proration.trim()
        : "create_prorations"
    });

    await syncSubscriptionToCompany(refreshed, {});
    const nextSub = await getCompanySubscription(req.user.company_id);
    const summary = await currentBillingPayload(req.user.company_id);
    await logTenantBillingMutation({
      req,
      action: "tenant_billing_plan_changed",
      details: {
        direction,
        from_plan: currentInternal,
        to_plan: targetInternal,
        stripe_subscription_id: stripeSubId,
        proration_behavior: typeof proration === "string" && proration.trim()
          ? proration.trim()
          : "create_prorations"
      }
    });

    res.json({
      subscription: nextSub,
      summary,
      warning_mode: true,
      stripe_updated: true
    });
  } catch (err) {
    billingRouteError(res, err, "BILLING CHANGE PLAN ERROR");
  }
}

router.post("/billing/change-plan", billingOwnerAdminOnly, checkoutSessionLimiter, handleBillingPlanChange);

router.get("/platform/billing/analytics", platformOnly, async (req, res) => {
  try {
    const analytics = await getPlatformBillingAnalytics();
    res.json({
      ...analytics,
      warning_mode: true
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM BILLING ANALYTICS ERROR");
  }
});

router.get("/platform/billing/overview", platformOnly, async (req, res) => {
  try {
    const overview = await getPlatformBillingOverview();
    res.json({
      ...overview,
      warning_mode: true
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM BILLING OVERVIEW ERROR");
  }
});

router.get("/platform/billing/companies", platformOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        phone,
        email,
        created_at,
        plan,
        billing_status,
        trial_ends_at,
        billing_started_at,
        billing_cancelled_at,
        billing_grace_until,
        billing_last_payment_failed_at,
        billing_last_payment_succeeded_at,
        billing_suspended_at,
        billing_failure_reason,
        platform_suspended_at,
        platform_suspension_reason,
        monthly_price,
        max_users,
        max_clients,
        max_jobs_per_month
      FROM companies
      ORDER BY created_at DESC NULLS LAST, id DESC
    `);

    const rows = [];
    for (const company of result.rows) {
      const plan = normalizePlan(company.plan);
      const planDefaults = PLAN_LIMITS[plan];
      const usage = await getUsageForCompany(company.id);
      const warnings = await getBillingWarnings(company.id);
      const billing = await getCompanyBilling(company.id);
      const trial = billing ? computeTrialMeta(billing) : null;

      rows.push({
        id: company.id,
        name: company.name,
        phone: company.phone,
        email: company.email,
        created_at: company.created_at,
        plan,
        billing_status: normalizeBillingStatus(company.billing_status),
        trial_ends_at: company.trial_ends_at,
        billing_started_at: company.billing_started_at,
        billing_cancelled_at: company.billing_cancelled_at,
        billing_grace_until: company.billing_grace_until,
        billing_last_payment_failed_at: company.billing_last_payment_failed_at,
        billing_last_payment_succeeded_at: company.billing_last_payment_succeeded_at,
        billing_suspended_at: company.billing_suspended_at,
        billing_failure_reason: company.billing_failure_reason,
        platform_suspended_at: company.platform_suspended_at || null,
        platform_suspension_reason: company.platform_suspension_reason || null,
        monthly_price: num(company.monthly_price != null ? company.monthly_price : planDefaults.monthly_price),
        max_users: company.max_users != null ? num(company.max_users) : planDefaults.max_users,
        max_clients: company.max_clients != null ? num(company.max_clients) : planDefaults.max_clients,
        max_jobs_per_month: company.max_jobs_per_month != null ? num(company.max_jobs_per_month) : planDefaults.max_jobs_per_month,
        usage,
        trial,
        subscription_state: trial && trial.subscription_state,
        warnings,
        warning_mode: true,
        ...warningSummary(warnings)
      });
    }

    res.json(rows);
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM BILLING COMPANIES ERROR");
  }
});

router.get("/platform/billing/companies/:id", platformOnly, async (req, res) => {
  try {
    const companyId = req.params.id;
    const summary = await getBillingSummary(companyId);

    if (!summary) {
      return res.status(404).json({ error: "Company not found" });
    }

    const billing = await getCompanyBilling(companyId);
    const trial = billing ? computeTrialMeta(billing) : null;
    const warningsPayload = summary.warnings || await getBillingWarnings(companyId);

    res.json({
      company_id: Number(companyId),
      ...summary,
      trial,
      subscription_state: trial && trial.subscription_state,
      warnings: warningsPayload,
      warning_mode: true,
      ...warningSummary(warningsPayload)
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM BILLING COMPANY DETAIL ERROR");
  }
});

router.put("/platform/billing/companies/:id", platformOnly, async (req, res) => {
  try {
    const companyId = req.params.id;
    const patch = {};
    const auditExtras = {};

    if (req.body.plan !== undefined) {
      patch.plan = req.body.plan;
    }

    if (req.body.billing_status !== undefined) {
      patch.billing_status = req.body.billing_status;
    }

    if (req.body.trial_ends_at !== undefined) {
      patch.trial_ends_at = req.body.trial_ends_at;
    }

    if (req.body.billing_grace_until !== undefined) {
      patch.billing_grace_until = req.body.billing_grace_until;
    }

    if (req.body.billing_failure_reason !== undefined) {
      patch.billing_failure_reason = req.body.billing_failure_reason;
    }

    if (req.body.clear_suspended_at !== undefined) {
      patch.clear_suspended_at = req.body.clear_suspended_at === true;
    }

    if (req.body.extend_trial_days !== undefined) {
      const days = Math.max(0, Math.min(3650, Number(req.body.extend_trial_days) || 0));
      if (days > 0) {
        const cur = await pool.query(
          `SELECT trial_ends_at FROM companies WHERE id = $1 LIMIT 1`,
          [companyId]
        );
        if (!cur.rows.length) {
          return res.status(404).json({ error: "Company not found" });
        }
        const raw = cur.rows[0].trial_ends_at;
        const base = raw ? new Date(raw) : new Date();
        const d = Number.isNaN(base.getTime()) ? new Date() : base;
        d.setUTCDate(d.getUTCDate() + days);
        patch.trial_ends_at = d.toISOString();
        auditExtras.extend_trial_days = days;
      }
    }

    if (req.body.clear_billing_flags === true) {
      patch.billing_grace_until = null;
      patch.billing_failure_reason = null;
      patch.clear_suspended_at = true;
      auditExtras.clear_billing_flags = true;
    }

    let didPlatformUnlock = false;
    if (req.body.platform_unlock === true) {
      await pool.query(
        `
        UPDATE companies
        SET platform_suspended_at = NULL,
            platform_suspension_reason = NULL
        WHERE id = $1
        `,
        [companyId]
      ).catch((err) => {
        if (err && err.code !== "42703") {
          throw err;
        }
      });
      didPlatformUnlock = true;
      auditExtras.platform_unlock = true;
    }

    const hasSensitiveOverride = Boolean(
      patch.plan !== undefined
      || patch.trial_ends_at !== undefined
      || req.body.extend_trial_days !== undefined
      || didPlatformUnlock
    );
    const auditReason = String(req.body && req.body.audit_reason || "").trim();
    if (hasSensitiveOverride && !auditReason) {
      return res.status(400).json({
        error: "audit_reason is required for plan, trial, or platform unlock overrides"
      });
    }
    if (auditReason) {
      auditExtras.audit_reason = auditReason;
    }

    const hasPatchKeys = Object.keys(patch).length > 0;
    if (!hasPatchKeys && !didPlatformUnlock) {
      return res.status(400).json({
        error: "Provide plan, billing_status, trial_ends_at, extend_trial_days, clear_billing_flags, billing_grace_until, billing_failure_reason, clear_suspended_at, and/or platform_unlock"
      });
    }

    let updated = null;
    if (hasPatchKeys) {
      updated = await updateCompanyPlatformSubscription(companyId, patch);
      if (!updated) {
        return res.status(404).json({ error: "Company not found" });
      }
    }

    if (!updated) {
      const ref = await pool.query(`
        SELECT
          id AS company_id,
          plan,
          billing_status,
          trial_ends_at,
          billing_started_at,
          billing_cancelled_at,
          billing_grace_until,
          billing_last_payment_failed_at,
          billing_last_payment_succeeded_at,
          billing_suspended_at,
          billing_failure_reason,
          platform_suspended_at,
          platform_suspension_reason,
          monthly_price,
          max_users,
          max_clients,
          max_jobs_per_month
        FROM companies
        WHERE id = $1
        LIMIT 1
      `, [companyId]);
      if (!ref.rows.length) {
        return res.status(404).json({ error: "Company not found" });
      }
      updated = ref.rows[0];
    } else {
      try {
        const px = await pool.query(
          `
          SELECT platform_suspended_at, platform_suspension_reason
          FROM companies
          WHERE id = $1
          LIMIT 1
          `,
          [companyId]
        );
        if (px.rows[0]) {
          updated = {
            ...updated,
            platform_suspended_at: px.rows[0].platform_suspended_at,
            platform_suspension_reason: px.rows[0].platform_suspension_reason
          };
        }
      } catch (pxErr) {
        if (!pxErr || pxErr.code !== "42703") {
          throw pxErr;
        }
      }
    }

    try {
      await logPlatformCompanyAudit(null, {
        company_id: Number(companyId),
        actor_user_id: req.user.id,
        action: "platform_billing_company_override",
        payload: {
          patch,
          ...auditExtras
        }
      });
    } catch (auditErr) {
      if (!auditErr || auditErr.code !== "42P01") {
        throw auditErr;
      }
    }

    try {
      await activityLogService.ensureActivityLogSchema();
      await activityLogService.logActivity({
        companyId: Number(companyId),
        userId: req.user.id,
        action: "platform_billing_override",
        entityType: "company",
        entityId: Number(companyId),
        details: {
          patch,
          ...auditExtras
        }
      });
    } catch (actErr) {
      logger.warn("PLATFORM_BILLING_ACTIVITY_LOG_FAILED", { error: actErr && actErr.message });
    }

    const summary = await getBillingSummary(companyId);
    const enriched = summary ? enrichBillingClientSummary(summary) : null;

    res.json({
      company: updated,
      summary: enriched,
      warnings: enriched && enriched.warnings ? enriched.warnings : await getBillingWarnings(companyId),
      warning_mode: true
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM BILLING UPDATE ERROR");
  }
});

router.post("/platform/billing/evaluate-suspensions", platformOnly, async (req, res) => {
  try {
    const result = await evaluatePastDueSuspensions();
    res.json({
      ...result,
      warning_mode: true
    });
  } catch (err) {
    sendSafeServerError(res, err, "PLATFORM BILLING SUSPENSION EVALUATION ERROR");
  }
});

router.post("/platform/billing/stripe/replay-retryable-events", platformOnly, async (req, res) => {
  try {
    const requestedLimit = req.body && req.body.limit;
    const summary = await replayRetryableStripeEvents({ limit: requestedLimit });
    return res.json({
      replayed: true,
      summary
    });
  } catch (err) {
    return sendSafeServerError(res, err, "PLATFORM BILLING STRIPE REPLAY ERROR");
  }
});

module.exports = router;

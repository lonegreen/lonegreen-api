const Stripe = require("stripe");
const pool = require("../db/pool");
const {
  NODE_ENV,
  ALLOWED_ORIGINS,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_BASIC,
  STRIPE_PRICE_PRO,
  STRIPE_PRICE_BUSINESS,
  STRIPE_PRICE_BASIC_YEARLY,
  STRIPE_PRICE_PRO_YEARLY,
  STRIPE_PRICE_BUSINESS_YEARLY,
  PUBLIC_APP_URL
} = require("../config/env");

const CHECKOUT_PLANS = new Set(["basic", "pro", "business"]);
const BILLING_CYCLES = new Set(["monthly", "yearly"]);
const INTERNAL_PLAN_BY_CHECKOUT_PLAN = {
  basic: "starter",
  pro: "pro",
  business: "enterprise"
};

let stripeClient = null;

function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    return null;
  }

  if (!stripeClient) {
    stripeClient = new Stripe(STRIPE_SECRET_KEY);
  }

  return stripeClient;
}

function normalizeCheckoutBillingCycle(cycle) {
  const value = String(cycle || "").trim().toLowerCase();
  return BILLING_CYCLES.has(value) ? value : "monthly";
}

function isStripeCheckoutConfigured() {
  return Boolean(
    STRIPE_SECRET_KEY
    && STRIPE_PRICE_BASIC
    && STRIPE_PRICE_PRO
    && STRIPE_PRICE_BUSINESS
  );
}

function isStripePortalConfigured() {
  return Boolean(STRIPE_SECRET_KEY);
}

function normalizeCheckoutPlan(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return CHECKOUT_PLANS.has(value) ? value : null;
}

function priceIdForCheckoutPlan(plan, billingCycle = "monthly") {
  const cycle = normalizeCheckoutBillingCycle(billingCycle);
  const monthly = {
    basic: STRIPE_PRICE_BASIC,
    pro: STRIPE_PRICE_PRO,
    business: STRIPE_PRICE_BUSINESS
  };
  const yearly = {
    basic: STRIPE_PRICE_BASIC_YEARLY,
    pro: STRIPE_PRICE_PRO_YEARLY,
    business: STRIPE_PRICE_BUSINESS_YEARLY
  };

  const map = cycle === "yearly" ? yearly : monthly;
  return String(map[plan] || "").trim();
}

function checkoutPlanAndCycleFromPriceId(priceId) {
  const id = String(priceId || "").trim();
  if (!id) return { checkoutPlan: null, billing_cycle: null };

  const pairs = [
    ["basic", "monthly", STRIPE_PRICE_BASIC],
    ["pro", "monthly", STRIPE_PRICE_PRO],
    ["business", "monthly", STRIPE_PRICE_BUSINESS],
    ["basic", "yearly", STRIPE_PRICE_BASIC_YEARLY],
    ["pro", "yearly", STRIPE_PRICE_PRO_YEARLY],
    ["business", "yearly", STRIPE_PRICE_BUSINESS_YEARLY]
  ];

  for (const [checkoutPlan, billingCycle, configuredPriceId] of pairs) {
    if (configuredPriceId && id === String(configuredPriceId).trim()) {
      return { checkoutPlan, billing_cycle: billingCycle };
    }
  }

  return { checkoutPlan: null, billing_cycle: null };
}

function idempotencyKey(parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(":")
    .slice(0, 255);
}

function yearlyPricesConfigured() {
  return Boolean(
    STRIPE_PRICE_BASIC_YEARLY
    && STRIPE_PRICE_PRO_YEARLY
    && STRIPE_PRICE_BUSINESS_YEARLY
  );
}

function internalPlanForCheckoutPlan(plan) {
  return INTERNAL_PLAN_BY_CHECKOUT_PLAN[plan] || null;
}

function checkoutPlanFromInternalPlan(internalPlan) {
  const value = String(internalPlan || "").trim().toLowerCase();
  if (value === "starter") return "basic";
  if (value === "pro") return "pro";
  if (value === "enterprise") return "business";
  return null;
}

/**
 * Checkout plan slugs (basic / pro / business) align with marketing tiers.
 * Internal company.plan remains starter / pro / enterprise until lifecycle sync (later group).
 */
function resolveCheckoutOrigin(req) {
  const origin = req.get("origin");

  if (origin && (NODE_ENV !== "production" || ALLOWED_ORIGINS.includes(origin))) {
    return origin.replace(/\/$/, "");
  }

  if (PUBLIC_APP_URL) {
    return PUBLIC_APP_URL.replace(/\/$/, "");
  }

  const host = req.get("host");

  if (NODE_ENV !== "production" && host) {
    const proto = req.protocol === "https" ? "https" : "http";
    return `${proto}://${host}`;
  }

  throw Object.assign(new Error("Unable to resolve safe checkout redirect URL. Set PUBLIC_APP_URL or use an allowed Origin."), {
    code: "CHECKOUT_ORIGIN"
  });
}

async function createStripeCustomerForCompany(companyId) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [Number(companyId)]);

    const existing = await client.query(
      `
      SELECT id, name, email, stripe_customer_id
      FROM companies
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [companyId]
    );

    const row = existing.rows[0];

    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    if (row.stripe_customer_id) {
      await client.query("COMMIT");
      return row.stripe_customer_id;
    }

    const customer = await stripe.customers.create({
      email: row.email || undefined,
      name: row.name || undefined,
      metadata: {
        company_id: String(companyId),
        source: "platform_billing",
        app: "lonegreen"
      }
    }, {
      idempotencyKey: idempotencyKey(["lg", "customer", companyId])
    });

    await client.query(
      `
      UPDATE companies
      SET stripe_customer_id = $1
      WHERE id = $2
      `,
      [customer.id, companyId]
    );

    await client.query(
      `
      UPDATE company_subscriptions
      SET stripe_customer_id = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $2
      `,
      [customer.id, companyId]
    ).catch((err) => {
      if (err && err.code !== "42P01" && err.code !== "42703") throw err;
    });

    await client.query("COMMIT");
    return customer.id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getOrCreateStripeCustomer(companyId) {
  return createStripeCustomerForCompany(companyId);
}

async function getOrCreateStripeCustomerId(companyId) {
  return getOrCreateStripeCustomer(companyId);
}

async function createCheckoutSessionForCompany({
  companyId,
  checkoutPlan,
  billing_cycle,
  req
}) {
  if (!isStripeCheckoutConfigured()) {
    const err = new Error("Stripe Checkout is not fully configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_BASIC, STRIPE_PRICE_PRO, STRIPE_PRICE_BUSINESS.");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const plan = normalizeCheckoutPlan(checkoutPlan);

  if (!plan) {
    const err = new Error("Invalid plan. Use basic, pro, or business.");
    err.code = "INVALID_PLAN";
    throw err;
  }

  const billingCycle = normalizeCheckoutBillingCycle(billing_cycle);
  const priceId = priceIdForCheckoutPlan(plan, billingCycle);

  if (!priceId) {
    const err = new Error(
      billingCycle === "yearly"
        ? "Stripe yearly Price ID is not configured for this plan. Set STRIPE_PRICE_BASIC_YEARLY, STRIPE_PRICE_PRO_YEARLY, STRIPE_PRICE_BUSINESS_YEARLY."
        : "Stripe Price ID is not configured for this plan."
    );
    err.code = billingCycle === "yearly" ? "STRIPE_YEARLY_PRICE_MISSING" : "STRIPE_PRICE_MISSING";
    throw err;
  }

  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const customerId = await getOrCreateStripeCustomerId(companyId);

  if (!customerId) {
    const err = new Error("Company not found.");
    err.code = "COMPANY_NOT_FOUND";
    throw err;
  }

  const baseUrl = resolveCheckoutOrigin(req);
  const successUrl = `${baseUrl}/dashboard.html?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/dashboard.html?billing=cancel`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [
      {
        price: priceId,
        quantity: 1
      }
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(companyId),
    metadata: {
      company_id: String(companyId),
      plan,
      checkout_plan: plan,
      billing_cycle: billingCycle,
      user_id: String((req.user && req.user.id) || ""),
      source: "platform_billing"
    },
    subscription_data: {
      metadata: {
        company_id: String(companyId),
        plan,
        checkout_plan: plan,
        billing_cycle: billingCycle,
        user_id: String((req.user && req.user.id) || ""),
        source: "platform_billing"
      }
    }
  }, {
    idempotencyKey: idempotencyKey([
      "lg",
      "checkout",
      companyId,
      plan,
      billingCycle,
      priceId,
      (req.user && req.user.id) || "system"
    ])
  });

  return session;
}

async function getCheckoutSessionSummaryForCompany({ companyId, sessionId }) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const cleanSessionId = String(sessionId || "").trim();
  if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(cleanSessionId)) {
    const err = new Error("Invalid checkout session id.");
    err.code = "INVALID_SESSION_ID";
    err.statusCode = 400;
    throw err;
  }

  const session = await stripe.checkout.sessions.retrieve(cleanSessionId, {
    expand: ["subscription"]
  });

  const customerId = typeof session.customer === "string"
    ? session.customer
    : session.customer && session.customer.id;
  const subscription = session.subscription && typeof session.subscription === "object"
    ? session.subscription
    : null;
  const subscriptionId = typeof session.subscription === "string"
    ? session.subscription
    : subscription && subscription.id;
  const metadataCompanyId = parseInt(String((session.metadata && session.metadata.company_id) || ""), 10);
  const clientRefCompanyId = parseInt(String(session.client_reference_id || ""), 10);

  const local = await pool.query(
    `
    SELECT id, stripe_customer_id
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  );

  const company = local.rows[0];
  if (!company) {
    const err = new Error("Company not found.");
    err.code = "COMPANY_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const belongsByMetadata = metadataCompanyId === Number(companyId) || clientRefCompanyId === Number(companyId);
  const belongsByCustomer = Boolean(customerId && company.stripe_customer_id && company.stripe_customer_id === customerId);

  if (!belongsByMetadata && !belongsByCustomer) {
    const err = new Error("Checkout session is not available for this company.");
    err.code = "SESSION_COMPANY_MISMATCH";
    err.statusCode = 404;
    throw err;
  }

  let priceId = null;
  if (subscription && subscription.items && subscription.items.data && subscription.items.data[0]) {
    priceId = subscription.items.data[0].price && subscription.items.data[0].price.id;
  }

  const priceMeta = checkoutPlanAndCycleFromPriceId(priceId);
  const checkoutPlan = normalizeCheckoutPlan(session.metadata && (session.metadata.checkout_plan || session.metadata.plan))
    || priceMeta.checkoutPlan;
  const internalPlan = internalPlanForCheckoutPlan(checkoutPlan);

  return {
    id: session.id,
    status: session.status,
    payment_status: session.payment_status,
    mode: session.mode,
    customer_id: customerId || null,
    subscription_id: subscriptionId || null,
    subscription_status: subscription ? subscription.status || null : null,
    plan: internalPlan || null,
    checkout_plan: checkoutPlan || null,
    billing_cycle: normalizeCheckoutBillingCycle((session.metadata && session.metadata.billing_cycle) || priceMeta.billing_cycle),
    current_period_start: subscription && subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000).toISOString()
      : null,
    current_period_end: subscription && subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: subscription ? subscription.cancel_at_period_end === true : false
  };
}

async function changeStripeSubscriptionPlan({
  companyId,
  checkoutPlan,
  billing_cycle,
  proration_behavior = "create_prorations"
}) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const plan = normalizeCheckoutPlan(checkoutPlan);

  if (!plan) {
    const err = new Error("Invalid plan. Use basic, pro, or business.");
    err.code = "INVALID_PLAN";
    throw err;
  }

  const billingCycle = normalizeCheckoutBillingCycle(billing_cycle);
  const priceId = priceIdForCheckoutPlan(plan, billingCycle);

  if (!priceId) {
    const err = new Error(
      billingCycle === "yearly"
        ? "Stripe yearly Price ID is not configured for this plan."
        : "Stripe Price ID is not configured for this plan."
    );
    err.code = billingCycle === "yearly" ? "STRIPE_YEARLY_PRICE_MISSING" : "STRIPE_PRICE_MISSING";
    throw err;
  }

  const existing = await pool.query(
    `
    SELECT COALESCE(
      NULLIF(stripe_subscription_id, ''),
      (
        SELECT NULLIF(cs.stripe_subscription_id, '')
        FROM company_subscriptions cs
        WHERE cs.company_id = companies.id
          AND cs.stripe_subscription_id IS NOT NULL
          AND cs.stripe_subscription_id <> ''
        ORDER BY cs.updated_at DESC NULLS LAST, cs.id DESC
        LIMIT 1
      )
    ) AS stripe_subscription_id
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  );

  const subId = existing.rows[0] && existing.rows[0].stripe_subscription_id
    ? String(existing.rows[0].stripe_subscription_id).trim()
    : "";

  if (!subId) {
    const err = new Error("No Stripe subscription is linked to this company. Start checkout first.");
    err.code = "STRIPE_SUBSCRIPTION_MISSING";
    err.statusCode = 400;
    throw err;
  }

  const subscription = await stripe.subscriptions.retrieve(subId);
  const item = subscription.items && subscription.items.data && subscription.items.data[0];

  if (!item || !item.id) {
    const err = new Error("Stripe subscription has no billable items.");
    err.code = "STRIPE_SUBSCRIPTION_ITEM_MISSING";
    err.statusCode = 502;
    throw err;
  }

  await stripe.subscriptions.update(subId, {
    items: [
      {
        id: item.id,
        price: priceId
      }
    ],
    proration_behavior,
    metadata: {
      ...(subscription.metadata || {}),
      company_id: String(companyId),
      checkout_plan: plan,
      billing_cycle: billingCycle,
      source: "platform_billing"
    }
  }, {
    idempotencyKey: idempotencyKey(["lg", "plan_change", companyId, subId, priceId, proration_behavior])
  });

  const refreshed = await stripe.subscriptions.retrieve(subId);
  return refreshed;
}

async function cancelStripeSubscriptionForCompany({
  companyId,
  cancel_at_period_end = true
}) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const existing = await pool.query(
    `
    SELECT COALESCE(
      NULLIF(stripe_subscription_id, ''),
      (
        SELECT NULLIF(cs.stripe_subscription_id, '')
        FROM company_subscriptions cs
        WHERE cs.company_id = companies.id
          AND cs.stripe_subscription_id IS NOT NULL
          AND cs.stripe_subscription_id <> ''
        ORDER BY cs.updated_at DESC NULLS LAST, cs.id DESC
        LIMIT 1
      )
    ) AS stripe_subscription_id
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  );

  const subId = existing.rows[0] && existing.rows[0].stripe_subscription_id
    ? String(existing.rows[0].stripe_subscription_id).trim()
    : "";

  if (!subId) {
    const err = new Error("No Stripe subscription is linked to this company.");
    err.code = "STRIPE_SUBSCRIPTION_MISSING";
    err.statusCode = 400;
    throw err;
  }

  if (cancel_at_period_end === false) {
    return stripe.subscriptions.cancel(subId, {}, {
      idempotencyKey: idempotencyKey(["lg", "cancel_now", companyId, subId])
    });
  }

  return stripe.subscriptions.update(subId, {
    cancel_at_period_end: true
  }, {
    idempotencyKey: idempotencyKey(["lg", "cancel_period_end", companyId, subId])
  });
}

async function reactivateStripeSubscriptionForCompany(companyId) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const existing = await pool.query(
    `
    SELECT COALESCE(
      NULLIF(stripe_subscription_id, ''),
      (
        SELECT NULLIF(cs.stripe_subscription_id, '')
        FROM company_subscriptions cs
        WHERE cs.company_id = companies.id
          AND cs.stripe_subscription_id IS NOT NULL
          AND cs.stripe_subscription_id <> ''
        ORDER BY cs.updated_at DESC NULLS LAST, cs.id DESC
        LIMIT 1
      )
    ) AS stripe_subscription_id
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  );

  const subId = existing.rows[0] && existing.rows[0].stripe_subscription_id
    ? String(existing.rows[0].stripe_subscription_id).trim()
    : "";

  if (!subId) {
    const err = new Error("No Stripe subscription is linked to this company.");
    err.code = "STRIPE_SUBSCRIPTION_MISSING";
    err.statusCode = 400;
    throw err;
  }

  const subscription = await stripe.subscriptions.retrieve(subId);
  const status = String(subscription.status || "").toLowerCase();

  if (status === "canceled" || status === "cancelled") {
    const err = new Error("Canceled Stripe subscriptions cannot be reactivated. Start a new checkout session.");
    err.code = "STRIPE_SUBSCRIPTION_CANCELED";
    err.statusCode = 409;
    throw err;
  }

  return stripe.subscriptions.update(subId, {
    cancel_at_period_end: false
  }, {
    idempotencyKey: idempotencyKey(["lg", "reactivate", companyId, subId])
  });
}

async function createPortalSessionForCompany({
  companyId,
  req,
  return_query
}) {
  const stripe = getStripe();

  if (!stripe) {
    const err = new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const existing = await pool.query(
    `
    SELECT COALESCE(
      NULLIF(stripe_customer_id, ''),
      (
        SELECT NULLIF(cs.stripe_customer_id, '')
        FROM company_subscriptions cs
        WHERE cs.company_id = companies.id
          AND cs.stripe_customer_id IS NOT NULL
          AND cs.stripe_customer_id <> ''
        ORDER BY cs.updated_at DESC NULLS LAST, cs.id DESC
        LIMIT 1
      )
    ) AS stripe_customer_id
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  );

  const customerId = existing.rows[0] && existing.rows[0].stripe_customer_id;

  if (!customerId) {
    const err = new Error("Stripe customer is not available for this company.");
    err.code = "STRIPE_CUSTOMER_MISSING";
    throw err;
  }

  const baseUrl = resolveCheckoutOrigin(req);
  const query = String(return_query || "billing=portal").trim() || "billing=portal";

  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/dashboard.html?${query}`
  });
}

module.exports = {
  getStripe,
  isStripeCheckoutConfigured,
  isStripePortalConfigured,
  yearlyPricesConfigured,
  normalizeCheckoutPlan,
  normalizeCheckoutBillingCycle,
  internalPlanForCheckoutPlan,
  checkoutPlanFromInternalPlan,
  priceIdForCheckoutPlan,
  checkoutPlanAndCycleFromPriceId,
  createCheckoutSessionForCompany,
  getCheckoutSessionSummaryForCompany,
  changeStripeSubscriptionPlan,
  cancelStripeSubscriptionForCompany,
  reactivateStripeSubscriptionForCompany,
  createPortalSessionForCompany,
  createStripeCustomerForCompany,
  getOrCreateStripeCustomer,
  getOrCreateStripeCustomerId
};

const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env")
});

function required(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} is required in .env`);
  }

  return value;
}

function booleanEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  return value === "true";
}

function listEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

const NODE_ENV = String(process.env.NODE_ENV || "development")
  .trim()
  .toLowerCase();

const DATABASE_URL = required("DATABASE_URL");

const SECRET = required("JWT_SECRET");

if (SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters");
}

const ALLOW_MAINTENANCE_ROUTES = booleanEnv(
  "ALLOW_MAINTENANCE_ROUTES",
  false
);

const ALLOW_SEED_ADMIN = booleanEnv(
  "ALLOW_SEED_ADMIN",
  false
);

const ALLOWED_ORIGINS = listEnv("ALLOWED_ORIGINS");
const PUBLIC_APP_URL = optionalEnv("PUBLIC_APP_URL");

function assertValidAbsoluteUrl(value, name) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`${name} must use http/https`);
    }
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function assertValidOriginList(origins) {
  for (const origin of origins) {
    assertValidAbsoluteUrl(origin, "ALLOWED_ORIGINS entry");
  }
}

const PORT = integerEnv("PORT", 4000);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

if (NODE_ENV === "production") {
  assertValidOriginList(ALLOWED_ORIGINS);
  assertValidAbsoluteUrl(PUBLIC_APP_URL, "PUBLIC_APP_URL");

  if (ALLOWED_ORIGINS.length === 0) {
    throw new Error("ALLOWED_ORIGINS is required in production");
  }

  if (!PUBLIC_APP_URL) {
    throw new Error("PUBLIC_APP_URL is required in production");
  }

  if (ALLOW_MAINTENANCE_ROUTES) {
    throw new Error(
      "ALLOW_MAINTENANCE_ROUTES must be false in production"
    );
  }

  if (ALLOW_SEED_ADMIN) {
    throw new Error(
      "ALLOW_SEED_ADMIN must be false in production"
    );
  }
}

function integerEnv(name, fallback) {
  const parsed = parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const STRIPE_SECRET_KEY = optionalEnv("STRIPE_SECRET_KEY");
const RAW_STRIPE_PRICE_STARTER = optionalEnv("STRIPE_PRICE_STARTER");
const RAW_STRIPE_PRICE_BASIC = optionalEnv("STRIPE_PRICE_BASIC");
const STRIPE_PRICE_PRO = optionalEnv("STRIPE_PRICE_PRO");
const RAW_STRIPE_PRICE_GROWTH = optionalEnv("STRIPE_PRICE_GROWTH");
const RAW_STRIPE_PRICE_BUSINESS = optionalEnv("STRIPE_PRICE_BUSINESS");
const RAW_STRIPE_PRICE_STARTER_YEARLY = optionalEnv("STRIPE_PRICE_STARTER_YEARLY");
const RAW_STRIPE_PRICE_BASIC_YEARLY = optionalEnv("STRIPE_PRICE_BASIC_YEARLY");
const STRIPE_PRICE_PRO_YEARLY = optionalEnv("STRIPE_PRICE_PRO_YEARLY");
const RAW_STRIPE_PRICE_GROWTH_YEARLY = optionalEnv("STRIPE_PRICE_GROWTH_YEARLY");
const RAW_STRIPE_PRICE_BUSINESS_YEARLY = optionalEnv("STRIPE_PRICE_BUSINESS_YEARLY");
const STRIPE_PRICE_STARTER = RAW_STRIPE_PRICE_STARTER || RAW_STRIPE_PRICE_BASIC;
const STRIPE_PRICE_BASIC = RAW_STRIPE_PRICE_BASIC || RAW_STRIPE_PRICE_STARTER;
const STRIPE_PRICE_GROWTH = RAW_STRIPE_PRICE_GROWTH || RAW_STRIPE_PRICE_BUSINESS;
const STRIPE_PRICE_BUSINESS = RAW_STRIPE_PRICE_BUSINESS || RAW_STRIPE_PRICE_GROWTH;
const STRIPE_PRICE_STARTER_YEARLY = RAW_STRIPE_PRICE_STARTER_YEARLY || RAW_STRIPE_PRICE_BASIC_YEARLY;
const STRIPE_PRICE_BASIC_YEARLY = RAW_STRIPE_PRICE_BASIC_YEARLY || RAW_STRIPE_PRICE_STARTER_YEARLY;
const STRIPE_PRICE_GROWTH_YEARLY = RAW_STRIPE_PRICE_GROWTH_YEARLY || RAW_STRIPE_PRICE_BUSINESS_YEARLY;
const STRIPE_PRICE_BUSINESS_YEARLY = RAW_STRIPE_PRICE_BUSINESS_YEARLY || RAW_STRIPE_PRICE_GROWTH_YEARLY;
const STRIPE_WEBHOOK_SECRET = optionalEnv("STRIPE_WEBHOOK_SECRET");
const BILLING_GRACE_PERIOD_DAYS = Math.max(0, integerEnv("BILLING_GRACE_PERIOD_DAYS", 7));
const BILLING_LIFECYCLE_AUTOMATION = booleanEnv(
  "BILLING_LIFECYCLE_AUTOMATION",
  NODE_ENV === "production"
);

if (NODE_ENV === "production" && !BILLING_LIFECYCLE_AUTOMATION) {
  throw new Error(
    "BILLING_LIFECYCLE_AUTOMATION must be true in production (billing lifecycle scheduler automation)."
  );
}

function isStripeTestSecretKey(value) {
  return /^(sk|rk)_test_/.test(String(value || "").trim());
}

function isStripeLiveSecretKey(value) {
  return /^(sk|rk)_live_/.test(String(value || "").trim());
}

function isStripeSecretKeyShape(value) {
  return /^(sk|rk)_(test|live)_/.test(String(value || "").trim());
}

function isStripePriceIdShape(value) {
  return /^price_[A-Za-z0-9_]+$/.test(String(value || "").trim());
}

function isPlaceholderSecret(value) {
  return /(placeholder|changeme|change_me|your_)/i.test(String(value || "").trim());
}

if (NODE_ENV === "production") {
  if (isStripeTestSecretKey(STRIPE_SECRET_KEY)) {
    throw new Error("STRIPE_SECRET_KEY must not be a Stripe test key in production");
  }

  if (STRIPE_SECRET_KEY && isPlaceholderSecret(STRIPE_SECRET_KEY)) {
    throw new Error("STRIPE_SECRET_KEY appears to be a placeholder value");
  }
}

// Stripe price-id integrity check.
// - Always reject duplicate price IDs across plan tiers / billing cycles.
//   Duplicates cause silent plan misclassification in both checkout
//   (services/stripeService.js#priceIdForCheckoutPlan) and webhook handling
//   (services/stripeWebhookService.js#internalPlanFromStripePriceId).
// - In production, additionally require monthly basic / pro / business to be present
//   when STRIPE_SECRET_KEY is configured.
function validateStripePriceIdsConfig() {
  const monthly = [
    ["STRIPE_PRICE_STARTER", STRIPE_PRICE_STARTER],
    ["STRIPE_PRICE_PRO", STRIPE_PRICE_PRO],
    ["STRIPE_PRICE_GROWTH", STRIPE_PRICE_GROWTH]
  ];
  const yearly = [
    ["STRIPE_PRICE_STARTER_YEARLY", STRIPE_PRICE_STARTER_YEARLY],
    ["STRIPE_PRICE_PRO_YEARLY", STRIPE_PRICE_PRO_YEARLY],
    ["STRIPE_PRICE_GROWTH_YEARLY", STRIPE_PRICE_GROWTH_YEARLY]
  ];
  const all = monthly.concat(yearly);

  if (NODE_ENV === "production" && STRIPE_SECRET_KEY) {
    const missingMonthly = monthly.filter(([, value]) => !value);
    if (missingMonthly.length > 0) {
      const names = missingMonthly.map(([name]) => name).join(", ");
      throw new Error(
        "Stripe price IDs missing in production: " + names + ". " +
        "Each plan tier (starter, pro, growth) must map to a distinct Stripe price."
      );
    }
  }

  const seen = new Map();
  for (const [name, value] of all) {
    if (!value) continue;
    const key = String(value).trim();
    if (!seen.has(key)) {
      seen.set(key, [name]);
    } else {
      seen.get(key).push(name);
    }
  }

  const collisions = [];
  for (const [, names] of seen.entries()) {
    if (names.length > 1) {
      collisions.push(names);
    }
  }

  if (collisions.length > 0) {
    const summary = collisions
      .map((names) => names.join(" === "))
      .join("; ");
    throw new Error(
      "Stripe price IDs must be unique per plan tier and billing cycle. " +
      "Duplicate detected: " + summary + ". " +
      "Create distinct Stripe Price objects in the Stripe Dashboard and update .env."
    );
  }
}

validateStripePriceIdsConfig();

function getStripeCheckoutEnvReadiness() {
  const required = [
    ["STRIPE_SECRET_KEY", STRIPE_SECRET_KEY],
    ["STRIPE_PRICE_STARTER (or STRIPE_PRICE_BASIC)", STRIPE_PRICE_STARTER],
    ["STRIPE_PRICE_PRO", STRIPE_PRICE_PRO],
    ["STRIPE_PRICE_GROWTH (or STRIPE_PRICE_BUSINESS)", STRIPE_PRICE_GROWTH]
  ];
  const missing = required
    .filter(([, value]) => !String(value || "").trim())
    .map(([name]) => name);
  const invalid = [];

  if (STRIPE_SECRET_KEY && !isStripeSecretKeyShape(STRIPE_SECRET_KEY)) {
    invalid.push("STRIPE_SECRET_KEY must start with sk_test_, rk_test_, sk_live_, or rk_live_");
  }

  for (const [name, value] of required.slice(1)) {
    if (value && !isStripePriceIdShape(value)) {
      invalid.push(`${name} must be a Stripe Price ID starting with price_`);
    }
  }

  return {
    status: missing.length || invalid.length ? "not_configured" : "configured",
    missing,
    invalid,
    price_aliases: {
      starter: RAW_STRIPE_PRICE_STARTER ? "STRIPE_PRICE_STARTER" : (RAW_STRIPE_PRICE_BASIC ? "STRIPE_PRICE_BASIC" : null),
      pro: STRIPE_PRICE_PRO ? "STRIPE_PRICE_PRO" : null,
      growth: RAW_STRIPE_PRICE_GROWTH ? "STRIPE_PRICE_GROWTH" : (RAW_STRIPE_PRICE_BUSINESS ? "STRIPE_PRICE_BUSINESS" : null)
    }
  };
}

/**
 * Legacy setInterval subscription poll. Off in production unless explicitly true.
 * Non-production defaults to true for faster local feedback (set SUBSCRIPTION_INTERVAL_ENGINE=false to disable).
 */
const SUBSCRIPTION_INTERVAL_ENGINE = booleanEnv(
  "SUBSCRIPTION_INTERVAL_ENGINE",
  NODE_ENV !== "production"
);

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function getProductionEnvReadiness() {
  const critical = ["JWT_SECRET", "DATABASE_URL"];
  const requiredForLaunch = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PRO",
    "EMAIL_USER",
    "EMAIL_PASS",
    "ALLOWED_ORIGINS",
    "PUBLIC_APP_URL",
    "BILLING_LIFECYCLE_AUTOMATION"
  ];
  const recommended = [];

  const missingCritical = critical.filter(name => !hasEnv(name));
  const missingRequired = requiredForLaunch.filter(name => !hasEnv(name));
  if (!STRIPE_PRICE_STARTER) {
    missingRequired.push("STRIPE_PRICE_STARTER (or STRIPE_PRICE_BASIC)");
  }
  if (!STRIPE_PRICE_GROWTH) {
    missingRequired.push("STRIPE_PRICE_GROWTH (or STRIPE_PRICE_BUSINESS)");
  }
  const missingRecommended = recommended.filter(name => !hasEnv(name));
  const warnings = [];

  if (NODE_ENV !== "production") {
    warnings.push("NODE_ENV is not production");
  }

  if (NODE_ENV === "production" && SUBSCRIPTION_INTERVAL_ENGINE) {
    warnings.push("SUBSCRIPTION_INTERVAL_ENGINE is enabled in production");
  }

  if (NODE_ENV === "production" && !BILLING_LIFECYCLE_AUTOMATION) {
    warnings.push("BILLING_LIFECYCLE_AUTOMATION is disabled in production");
  }

  if (NODE_ENV === "production" && isStripeTestSecretKey(STRIPE_SECRET_KEY)) {
    warnings.push("STRIPE_SECRET_KEY is a Stripe test key in production");
  }

  if (NODE_ENV !== "production" && isStripeLiveSecretKey(STRIPE_SECRET_KEY)) {
    warnings.push("STRIPE_SECRET_KEY is a Stripe live key outside production");
  }

  if (STRIPE_SECRET_KEY && isPlaceholderSecret(STRIPE_SECRET_KEY)) {
    warnings.push("STRIPE_SECRET_KEY appears to be a placeholder value");
  }

  const pricePairs = [
    ["STRIPE_PRICE_STARTER", STRIPE_PRICE_STARTER],
    ["STRIPE_PRICE_PRO", STRIPE_PRICE_PRO],
    ["STRIPE_PRICE_GROWTH", STRIPE_PRICE_GROWTH],
    ["STRIPE_PRICE_STARTER_YEARLY", STRIPE_PRICE_STARTER_YEARLY],
    ["STRIPE_PRICE_PRO_YEARLY", STRIPE_PRICE_PRO_YEARLY],
    ["STRIPE_PRICE_GROWTH_YEARLY", STRIPE_PRICE_GROWTH_YEARLY]
  ];
  const seenPrices = new Map();
  for (const [name, value] of pricePairs) {
    if (!value) continue;
    const key = String(value).trim();
    if (!seenPrices.has(key)) {
      seenPrices.set(key, [name]);
    } else {
      seenPrices.get(key).push(name);
      warnings.push("Stripe price IDs duplicated: " + seenPrices.get(key).join(" === "));
    }
  }

  return {
    status: missingCritical.length
      ? "critical_missing"
      : missingRequired.length
        ? "launch_blockers"
        : missingRecommended.length || warnings.length
          ? "warnings"
          : "ready",
    missing_critical: missingCritical,
    missing_launch_required: missingRequired,
    missing_recommended: missingRecommended,
    warnings,
    production: NODE_ENV === "production"
  };
}

module.exports = {
  NODE_ENV,
  DATABASE_URL,
  SECRET,
  ALLOW_MAINTENANCE_ROUTES,
  ALLOW_SEED_ADMIN,
  ALLOWED_ORIGINS,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_STARTER,
  STRIPE_PRICE_BASIC,
  STRIPE_PRICE_PRO,
  STRIPE_PRICE_GROWTH,
  STRIPE_PRICE_BUSINESS,
  STRIPE_PRICE_STARTER_YEARLY,
  STRIPE_PRICE_BASIC_YEARLY,
  STRIPE_PRICE_PRO_YEARLY,
  STRIPE_PRICE_GROWTH_YEARLY,
  STRIPE_PRICE_BUSINESS_YEARLY,
  PUBLIC_APP_URL,
  STRIPE_WEBHOOK_SECRET,
  BILLING_GRACE_PERIOD_DAYS,
  BILLING_LIFECYCLE_AUTOMATION,
  SUBSCRIPTION_INTERVAL_ENGINE,
  getProductionEnvReadiness,
  getStripeCheckoutEnvReadiness
  ,
  PORT
};

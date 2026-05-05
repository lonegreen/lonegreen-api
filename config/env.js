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

if (NODE_ENV === "production") {
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
const STRIPE_PRICE_BASIC = optionalEnv("STRIPE_PRICE_BASIC");
const STRIPE_PRICE_PRO = optionalEnv("STRIPE_PRICE_PRO");
const STRIPE_PRICE_BUSINESS = optionalEnv("STRIPE_PRICE_BUSINESS");
const STRIPE_PRICE_BASIC_YEARLY = optionalEnv("STRIPE_PRICE_BASIC_YEARLY");
const STRIPE_PRICE_PRO_YEARLY = optionalEnv("STRIPE_PRICE_PRO_YEARLY");
const STRIPE_PRICE_BUSINESS_YEARLY = optionalEnv("STRIPE_PRICE_BUSINESS_YEARLY");
const STRIPE_WEBHOOK_SECRET = optionalEnv("STRIPE_WEBHOOK_SECRET");
const BILLING_GRACE_PERIOD_DAYS = Math.max(0, integerEnv("BILLING_GRACE_PERIOD_DAYS", 7));
const BILLING_LIFECYCLE_AUTOMATION = booleanEnv(
  "BILLING_LIFECYCLE_AUTOMATION",
  NODE_ENV === "production"
);

function isStripeTestSecretKey(value) {
  return /^(sk|rk)_test_/.test(String(value || "").trim());
}

function isStripeLiveSecretKey(value) {
  return /^(sk|rk)_live_/.test(String(value || "").trim());
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
    "STRIPE_PRICE_BASIC",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_BUSINESS",
    "EMAIL_USER",
    "EMAIL_PASS",
    "ALLOWED_ORIGINS",
    "PUBLIC_APP_URL",
    "BILLING_LIFECYCLE_AUTOMATION"
  ];
  const recommended = [];

  const missingCritical = critical.filter(name => !hasEnv(name));
  const missingRequired = requiredForLaunch.filter(name => !hasEnv(name));
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
  STRIPE_PRICE_BASIC,
  STRIPE_PRICE_PRO,
  STRIPE_PRICE_BUSINESS,
  STRIPE_PRICE_BASIC_YEARLY,
  STRIPE_PRICE_PRO_YEARLY,
  STRIPE_PRICE_BUSINESS_YEARLY,
  PUBLIC_APP_URL,
  STRIPE_WEBHOOK_SECRET,
  BILLING_GRACE_PERIOD_DAYS,
  BILLING_LIFECYCLE_AUTOMATION,
  SUBSCRIPTION_INTERVAL_ENGINE,
  getProductionEnvReadiness
};

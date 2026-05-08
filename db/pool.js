const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env")
});

const { Pool } = require("pg");
const { DATABASE_URL, NODE_ENV } = require("../config/env");
const logger = require("../services/logger");

const rawDatabaseUrl = String(DATABASE_URL || "").trim();
if (!rawDatabaseUrl) {
  throw new Error("DATABASE_URL is missing or empty");
}

let ssl = false;
let databaseHost = "unknown";
let isNeonHost = false;
let sslMode = "";

function integerEnv(name, fallback, min, max) {
  const parsed = parseInt(String(process.env[name] || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function assertResolvableDatabaseHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) {
    throw new Error("DATABASE_URL must include a non-empty hostname");
  }
  if (host.length > 253) {
    throw new Error("DATABASE_URL hostname is invalid (too long)");
  }
  if (/[\s@]/.test(host)) {
    throw new Error("DATABASE_URL hostname appears malformed");
  }
}

const poolMax = integerEnv("PG_POOL_MAX", 20, 1, 50);
const poolIdleTimeoutMillis = integerEnv("PG_POOL_IDLE_TIMEOUT_MS", 30000, 1000, 300000);
const poolConnectionTimeoutMillis = integerEnv("PG_POOL_CONNECTION_TIMEOUT_MS", 10000, 1000, 60000);

try {
  let parsed;
  try {
    parsed = new URL(rawDatabaseUrl);
  } catch (cause) {
    const detail = cause && cause.message ? cause.message : String(cause);
    throw new Error(`DATABASE_URL is not a valid URL (${detail})`);
  }

  databaseHost = String(parsed.hostname || "").trim().toLowerCase();
  assertResolvableDatabaseHostname(databaseHost);

  sslMode = (
    parsed.searchParams.get("sslmode") || ""
  ).toLowerCase();

  const isLocalHost =
    databaseHost === "localhost" ||
    databaseHost === "127.0.0.1" ||
    databaseHost === "::1";

  const isRenderHost =
    databaseHost.includes("render.com");

  isNeonHost =
    databaseHost.includes("neon.tech");

  if (!isLocalHost && (isRenderHost || isNeonHost || sslMode === "require")) {
    ssl = {
      rejectUnauthorized: sslMode === "verify-full"
    };
  }

} catch (err) {
  if (err && err.message && String(err.message).startsWith("DATABASE_URL")) {
    throw err;
  }
  throw new Error(`DATABASE_URL could not be parsed safely: ${err.message || err}`);
}

const pool = new Pool({
  connectionString: rawDatabaseUrl,
  ...(ssl ? { ssl } : {}),
  max: poolMax,
  idleTimeoutMillis: poolIdleTimeoutMillis,
  connectionTimeoutMillis: poolConnectionTimeoutMillis
});

pool.on("error", (err) => {
  logger.error("POSTGRES_POOL_ERROR", {
    host: databaseHost,
    dns_safe_log: true,
    code: err && err.code ? err.code : undefined,
    error: err
  });
});

async function testDatabaseConnection() {
  const client = await pool.connect();

  try {
    await client.query("SELECT NOW()");
    logger.info("DATABASE_CONNECTION_TEST_PASSED", getPoolReadinessInfo());
  } finally {
    client.release();
  }
}

logger.info("Database configuration loaded", {
  host: databaseHost,
  dns_safe_log: true,
  ssl: Boolean(ssl),
  ssl_reject_unauthorized: Boolean(ssl && ssl.rejectUnauthorized),
  pool_max: poolMax,
  env: NODE_ENV
});

function getPoolReadinessInfo() {
  return {
    host: databaseHost,
    neon_detected: isNeonHost,
    ssl_enabled: Boolean(ssl),
    ssl_reject_unauthorized: Boolean(ssl && ssl.rejectUnauthorized),
    sslmode: sslMode || null,
    pool_max: poolMax,
    idle_timeout_ms: poolIdleTimeoutMillis,
    connection_timeout_ms: poolConnectionTimeoutMillis
  };
}

module.exports = pool;
module.exports.testDatabaseConnection = testDatabaseConnection;
module.exports.getPoolReadinessInfo = getPoolReadinessInfo;

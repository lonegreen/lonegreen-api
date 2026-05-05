const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env")
});

const { Pool } = require("pg");
const { DATABASE_URL, NODE_ENV } = require("../config/env");
const logger = require("../services/logger");

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
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

const poolMax = integerEnv("PG_POOL_MAX", 20, 1, 50);
const poolIdleTimeoutMillis = integerEnv("PG_POOL_IDLE_TIMEOUT_MS", 30000, 1000, 300000);
const poolConnectionTimeoutMillis = integerEnv("PG_POOL_CONNECTION_TIMEOUT_MS", 10000, 1000, 60000);

try {
  const parsed = new URL(DATABASE_URL);

  databaseHost = (parsed.hostname || "").toLowerCase();

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

} catch {
  throw new Error("Invalid DATABASE_URL format");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ...(ssl ? { ssl } : {}),
  max: poolMax,
  idleTimeoutMillis: poolIdleTimeoutMillis,
  connectionTimeoutMillis: poolConnectionTimeoutMillis
});

pool.on("error", (err) => {
  logger.error("POSTGRES_POOL_ERROR", {
    host: databaseHost,
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

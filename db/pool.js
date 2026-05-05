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

try {
  const parsed = new URL(DATABASE_URL);

  databaseHost = (parsed.hostname || "").toLowerCase();

  const sslMode = (
    parsed.searchParams.get("sslmode") || ""
  ).toLowerCase();

  const isLocalHost =
    databaseHost === "localhost" ||
    databaseHost === "127.0.0.1" ||
    databaseHost === "::1";

  const isRenderHost =
    databaseHost.includes("render.com");

  const isNeonHost =
    databaseHost.includes("neon.tech");

  if (!isLocalHost && (isRenderHost || isNeonHost || sslMode === "require")) {
    ssl = {
      rejectUnauthorized: false
    };
  }

} catch {
  throw new Error("Invalid DATABASE_URL format");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ...(ssl ? { ssl } : {}),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", err);
});

async function testDatabaseConnection() {
  const client = await pool.connect();

  try {
    await client.query("SELECT NOW()");
    console.log("Database connection test passed");
  } finally {
    client.release();
  }
}

logger.info("Database configuration loaded", {
  host: databaseHost,
  ssl: Boolean(ssl),
  env: NODE_ENV
});

module.exports = pool;
module.exports.testDatabaseConnection = testDatabaseConnection;

const fs = require("fs/promises");
const path = require("path");
const bcrypt = require("bcrypt");
const pool = require("./pool");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function envEnabled(name) {
  return String(process.env[name] || "").toLowerCase() === "true";
}

function cleanText(value) {
  return String(value || "").trim();
}

async function ensureMigrationTrackingTable(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function listMigrationFiles() {
  const files = await fs.readdir(MIGRATIONS_DIR);

  return files
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(db = pool) {
  const result = await db.query(`SELECT filename FROM schema_migrations`);
  return new Set(result.rows.map(row => row.filename));
}

async function runMigrationFile(filename) {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql = await fs.readFile(fullPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(sql);

    await client.query(
      `
      INSERT INTO schema_migrations (filename)
      VALUES ($1)
      ON CONFLICT (filename) DO NOTHING
      `,
      [filename]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations() {
  await ensureMigrationTrackingTable();

  const files = await listMigrationFiles();
  const applied = await getAppliedMigrations();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    console.log("Running migration:", file);
    await runMigrationFile(file);
  }
}

async function getMigrationStatus() {
  await ensureMigrationTrackingTable();
  const files = await listMigrationFiles();
  const applied = await getAppliedMigrations();
  const pending = files.filter(file => !applied.has(file));

  return {
    status: pending.length ? "pending" : "current",
    total: files.length,
    applied: applied.size,
    pending_count: pending.length,
    pending
  };
}

async function assertProductionSchemaReady() {
  const tableResult = await pool.query(
    "SELECT to_regclass('public.schema_migrations') AS regclass"
  );
  const hasTrackingTable = Boolean(tableResult.rows[0] && tableResult.rows[0].regclass);
  if (!hasTrackingTable) {
    throw new Error(
      "Production startup blocked: required table 'schema_migrations' is missing. Run migrations before starting the app."
    );
  }

  const files = await listMigrationFiles();
  const applied = await getAppliedMigrations();
  const pending = files.filter((file) => !applied.has(file));
  if (pending.length > 0) {
    throw new Error(
      `Production startup blocked: ${pending.length} pending migration(s). Run migrations before starting the app.`
    );
  }
}

async function createBaseTables() {
  await runMigrations();
}

async function createDefaultCompanyAndAdmin() {
  const allowSeedAdmin = envEnabled("ALLOW_SEED_ADMIN");

  if (!allowSeedAdmin) {
    console.log("Default admin seed skipped. Set ALLOW_SEED_ADMIN=true to enable.");
    return null;
  }

  const seedUsername = cleanText(process.env.SEED_ADMIN_USERNAME);
  const seedPassword = String(process.env.SEED_ADMIN_PASSWORD || "");
  const seedCompanyName = cleanText(process.env.SEED_COMPANY_NAME) || "My Company";

  if (!seedUsername || !seedPassword) {
    throw new Error(
      "SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD are required when ALLOW_SEED_ADMIN=true"
    );
  }

  if (seedPassword.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 8 characters");
  }

  if (isProduction() && seedPassword === "123") {
    throw new Error("Unsafe production seed password is not allowed");
  }

  const companyCheck = await pool.query(`
    SELECT *
    FROM companies
    ORDER BY id ASC
    LIMIT 1
  `);

  let companyId;

  if (companyCheck.rows.length === 0) {
    const newCompany = await pool.query(
      `
      INSERT INTO companies (name, phone, email, address, service_area, business_hours)
      VALUES ($1, '', '', '', '', '')
      RETURNING id
      `,
      [seedCompanyName]
    );

    companyId = newCompany.rows[0].id;
  } else {
    companyId = companyCheck.rows[0].id;
  }

  const existingUser = await pool.query(
    `
    SELECT id
    FROM users
    WHERE username = $1
    LIMIT 1
    `,
    [seedUsername]
  );

  if (existingUser.rows.length > 0) {
    console.log("Seed admin already exists:", seedUsername);
    return existingUser.rows[0];
  }

  const hashed = await bcrypt.hash(seedPassword, 10);

  const created = await pool.query(
    `
    INSERT INTO users (username, password, role, company_id)
    VALUES ($1, $2, 'admin', $3)
    RETURNING id, username, role, company_id
    `,
    [seedUsername, hashed, companyId]
  );

  console.log("Seed admin created:", seedUsername);

  return created.rows[0];
}

async function setupDatabase(options = {}) {
  const runMigrationsOnThisCall = options.runMigrations !== false;

  if (runMigrationsOnThisCall) {
    console.log("Database setup: running migrations...");
    await runMigrations();
  } else {
    console.warn("Database setup: migrations explicitly skipped for this run.");
  }

  await createDefaultCompanyAndAdmin();
}

module.exports = {
  ensureMigrationTrackingTable,
  listMigrationFiles,
  getAppliedMigrations,
  getMigrationStatus,
  assertProductionSchemaReady,
  runMigrationFile,
  createBaseTables,
  runMigrations,
  createDefaultCompanyAndAdmin,
  setupDatabase
};

if (require.main === module) {
  console.warn("Starting manual database setup command.");
  console.warn("This command runs migrations and optional seeding based on environment.");
  setupDatabase()
    .then(async () => {
      console.log("Database setup complete");
      await pool.end();
    })
    .catch(async (err) => {
      console.error("DATABASE SETUP ERROR:", err && (err.stack || err.message || err));
      await pool.end();
      process.exit(1);
    });
}

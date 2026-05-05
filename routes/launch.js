
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { requireMinimumRole, normalizeRole } = auth;
const { listMigrationFiles, getAppliedMigrations } = require("../db/setup");
const { logActivity } = require("../services/routeHelpers");

const router = express.Router();
const ROLES = new Set(["owner", "admin", "manager", "worker"]);
let launchSchemaChecked = false;

function cleanText(value) {
  return String(value || "").trim();
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: normalizeRole(row.role),
    company_id: row.company_id,
    active: row.active !== false,
    worker_id: row.worker_id || null,
    worker_name: row.worker_name || null
  };
}

async function ensureLaunchSchema() {
  if (launchSchemaChecked) {
    return;
  }

  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name IN ('active', 'worker_id')
  `);
  const found = new Set(result.rows.map((row) => row.column_name));
  const missing = ["active", "worker_id"].filter((name) => !found.has(name));

  if (missing.length > 0) {
    console.warn(
      "LAUNCH SCHEMA WARNING: Missing users columns:",
      missing.join(", "),
      "- run controlled migrations before using user management routes."
    );
  }

  launchSchemaChecked = true;
}

async function companyStatus(companyId) {
  const companyResult = await pool.query(
    "SELECT id, name, phone, email, address, service_area, business_hours, created_at FROM companies WHERE id=$1 LIMIT 1",
    [companyId]
  );

  const company = companyResult.rows[0] || {};
  const required = ["name", "phone", "email", "address", "service_area", "business_hours"];
  const missing_fields = required.filter(field => !cleanText(company[field]));

  return {
    company,
    complete: missing_fields.length === 0,
    missing_fields
  };
}

router.get("/onboarding/status", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const status = await companyStatus(req.user.company_id);
    res.json({
      complete: status.complete,
      missing_fields: status.missing_fields,
      company: status.company
    });
  } catch (err) {
    console.log("ONBOARDING STATUS ERROR:", err.message);
    res.status(500).json({ error: "Unable to load onboarding status" });
  }
});

router.get("/users", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureLaunchSchema();
    const result = await pool.query(
      `SELECT users.id, users.username, users.role, users.company_id, users.active, users.worker_id, workers.name AS worker_name
       FROM users
       LEFT JOIN workers ON workers.id = users.worker_id AND workers.company_id = users.company_id
       WHERE users.company_id=$1
       ORDER BY users.active DESC, users.id ASC`,
      [req.user.company_id]
    );
    res.json(result.rows.map(publicUser));
  } catch (err) {
    console.log("LIST USERS ERROR:", err.message);
    res.status(500).json({ error: "Unable to load users" });
  }
});

router.get("/users/options", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureLaunchSchema();
    const workers = await pool.query(
      "SELECT id, name, phone, active FROM workers WHERE company_id=$1 ORDER BY active DESC, name ASC, id ASC",
      [req.user.company_id]
    );
    res.json({
      roles: ["owner", "admin", "manager", "worker"],
      workers: workers.rows
    });
  } catch (err) {
    console.log("USER OPTIONS ERROR:", err.message);
    res.status(500).json({ error: "Unable to load user options" });
  }
});

router.post("/users", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureLaunchSchema();
    const username = cleanText(req.body.username);
    const password = String(req.body.password || "");
    const role = normalizeRole(req.body.role);
    const workerId = req.body.worker_id ? Number(req.body.worker_id) : null;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    if (!ROLES.has(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    if (role === "owner" && normalizeRole(req.user.role) !== "owner") {
      return res.status(403).json({ error: "Only owners can create owner users" });
    }

    if (workerId) {
      const worker = await pool.query("SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1", [workerId, req.user.company_id]);
      if (worker.rows.length === 0) {
        return res.status(400).json({ error: "Worker not found" });
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    const created = await pool.query(
      `INSERT INTO users (username, password, role, company_id, active, worker_id)
       VALUES ($1,$2,$3,$4,TRUE,$5)
       RETURNING id, username, role, company_id, active, worker_id`,
      [username, hashed, role, req.user.company_id, role === "worker" ? workerId : null]
    );

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "team_user_created",
      entityType: "user",
      entityId: created.rows[0].id,
      details: { username, role }
    });

    res.json(publicUser(created.rows[0]));
  } catch (err) {
    if (err && err.code === "23505") {
      return res.status(400).json({ error: "Username already exists" });
    }
    console.log("CREATE USER ERROR:", err.message);
    res.status(500).json({ error: "Unable to create user" });
  }
});

router.put("/users/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureLaunchSchema();
    const userId = Number(req.params.id);
    const role = req.body.role ? normalizeRole(req.body.role) : null;
    const active = typeof req.body.active === "boolean" ? req.body.active : null;
    const workerId = req.body.worker_id ? Number(req.body.worker_id) : null;

    const current = await pool.query("SELECT id, role FROM users WHERE id=$1 AND company_id=$2 LIMIT 1", [userId, req.user.company_id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const currentRole = normalizeRole(current.rows[0].role);
    const actorRole = normalizeRole(req.user.role);

    if ((currentRole === "owner" || role === "owner") && actorRole !== "owner") {
      return res.status(403).json({ error: "Only owners can manage owner users" });
    }

    if (userId === Number(req.user.id) && active === false) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }

    if (role && !ROLES.has(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    if (workerId) {
      const worker = await pool.query("SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1", [workerId, req.user.company_id]);
      if (worker.rows.length === 0) {
        return res.status(400).json({ error: "Worker not found" });
      }
    }

    const updated = await pool.query(
      `UPDATE users
       SET role = COALESCE($1::text, role),
           active = COALESCE($2::boolean, active),
           worker_id = CASE WHEN COALESCE($1::text, role) = 'worker' THEN $3::int ELSE NULL END
       WHERE id=$4 AND company_id=$5
       RETURNING id, username, role, company_id, active, worker_id`,
      [role, active, workerId, userId, req.user.company_id]
    );

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "team_user_updated",
      entityType: "user",
      entityId: userId,
      details: { role, active, worker_id: workerId }
    });

    res.json(publicUser(updated.rows[0]));
  } catch (err) {
    console.log("UPDATE USER ERROR:", err.message);
    res.status(500).json({ error: "Unable to update user" });
  }
});

router.delete("/users/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureLaunchSchema();
    const userId = Number(req.params.id);
    const actorRole = normalizeRole(req.user.role);

    if (!["owner", "admin"].includes(actorRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (userId === Number(req.user.id)) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }

    const existing = await pool.query(
      "SELECT id, username, role FROM users WHERE id=$1 AND company_id=$2 LIMIT 1",
      [userId, req.user.company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const targetRole = normalizeRole(existing.rows[0].role);

    if (targetRole === "owner" && actorRole !== "owner") {
      return res.status(403).json({ error: "Only owners can delete owner users" });
    }

    if (["owner", "admin"].includes(targetRole)) {
      const remaining = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM users
        WHERE company_id=$1
          AND id <> $2
          AND active IS TRUE
          AND role IN ('owner', 'admin')
      `, [req.user.company_id, userId]);

      if (Number(remaining.rows[0]?.count || 0) === 0) {
        return res.status(400).json({ error: "Cannot delete the last owner/admin user in the company" });
      }
    }

    await pool.query(
      "DELETE FROM users WHERE id=$1 AND company_id=$2",
      [userId, req.user.company_id]
    );

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "team_user_deleted",
      entityType: "user",
      entityId: userId,
      details: {
        username: existing.rows[0].username,
        role: targetRole
      }
    });

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log("DELETE USER ERROR:", err.message);
    res.status(500).json({ error: "Unable to delete user" });
  }
});

router.get("/system/health", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const dbCheck = await pool.query("SELECT NOW() AS checked_at");
    const files = await listMigrationFiles();
    const applied = await getAppliedMigrations();
    const status = await companyStatus(req.user.company_id);

    res.json({
      app: {
        status: "ok",
        checked_at: dbCheck.rows[0].checked_at
      },
      database: {
        status: "ok"
      },
      migrations: {
        status: files.every(file => applied.has(file)) ? "ok" : "pending",
        applied: Array.from(applied).sort(),
        pending: files.filter(file => !applied.has(file))
      },
      company: {
        status: status.complete ? "complete" : "incomplete",
        missing_fields: status.missing_fields
      }
    });
  } catch (err) {
    console.log("SYSTEM HEALTH ERROR:", err.message);
    res.status(500).json({
      app: { status: "error" },
      database: { status: "error" },
      error: "Unable to load system health"
    });
  }
});

module.exports = router;

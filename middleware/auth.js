const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { SECRET } = require("../config/env");

const ROLE_RANK = {
  customer: 0,
  worker: 1,
  manager: 2,
  admin: 3,
  owner: 4,
  platform_owner: 5
};
const STAFF_ROLES = new Set(["worker", "manager", "admin", "owner", "platform_owner"]);

function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, normalized) ? normalized : null;
}

function isValidRole(role) {
  return normalizeRole(role) !== null;
}

function getBearerToken(header) {
  if (!header || typeof header !== "string") {
    return null;
  }

  const parts = header.trim().split(/\s+/);

  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return null;
  }

  return parts[1];
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function classifyTokenBoundary(decoded) {
  const role = normalizeRole(decoded && decoded.role);
  const portal = String((decoded && decoded.portal) || "").trim().toLowerCase();
  const hasCustomerPortal = portal === "customer";
  const hasCustomerRole = role === "customer";
  const hasCustomerMarker = hasCustomerPortal || hasCustomerRole;
  const hasStaffRole = STAFF_ROLES.has(role) && role !== "customer";
  const hasClientId = toPositiveInteger(decoded && decoded.client_id) !== null;
  const hasWorkerId = toPositiveInteger(decoded && decoded.worker_id) !== null;
  const hasCompanyId = toPositiveInteger(decoded && decoded.company_id) !== null;

  if ((hasCustomerMarker && hasStaffRole) || (hasCustomerMarker && hasWorkerId)) {
    return { role, type: "mixed" };
  }

  if (hasCustomerMarker || hasClientId) {
    if (hasStaffRole) {
      return { role, type: "mixed" };
    }
    return { role, type: "customer" };
  }

  if (hasStaffRole || (role && role === "platform_owner")) {
    return { role, type: "staff" };
  }

  if (hasCompanyId && role && role !== "customer") {
    return { role, type: "staff" };
  }

  return { role, type: "unknown" };
}

function parseCustomerPrincipal(decoded) {
  const boundary = classifyTokenBoundary(decoded);
  if (boundary.type === "mixed") {
    const error = new Error("Mixed auth boundary token");
    error.status = 403;
    throw error;
  }
  if (boundary.type !== "customer") {
    const error = new Error("Forbidden");
    error.status = 403;
    throw error;
  }

  const clientId = toPositiveInteger(decoded && decoded.client_id);
  if (!clientId) {
    const error = new Error("Forbidden");
    error.status = 403;
    throw error;
  }

  const customerAccountId =
    toPositiveInteger(decoded && decoded.customer_account_id)
    || toPositiveInteger(decoded && decoded.id);

  const customerStatus = String((decoded && decoded.customer_status) || "").trim().toLowerCase();
  const customerDeactivatedAt = decoded && decoded.customer_deactivated_at
    ? String(decoded.customer_deactivated_at).trim()
    : "";
  if (customerDeactivatedAt || customerStatus === "deactivated") {
    const error = new Error("Customer account is deactivated");
    error.status = 403;
    throw error;
  }
  if (customerStatus === "suspended") {
    const error = new Error("Customer account is suspended");
    error.status = 403;
    throw error;
  }

  return {
    ...decoded,
    client_id: clientId,
    customer_account_id: customerAccountId || undefined,
    role: "customer",
    portal: String((decoded && decoded.portal) || "").trim().toLowerCase() === "customer"
      ? "customer"
      : "customer_account"
  };
}

function verifyCustomerBearerToken(header) {
  const token = getBearerToken(header);
  if (!token) {
    const error = new Error("Customer login required");
    error.status = 401;
    throw error;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    const error = new Error("Invalid customer token");
    error.status = 401;
    throw error;
  }

  return parseCustomerPrincipal(decoded);
}

async function validateStaffTokenAgainstDatabase(decoded, tokenRole) {
  const userId = toPositiveInteger(decoded && decoded.id);
  if (!userId) {
    const err = new Error("Invalid token payload");
    err.status = 401;
    throw err;
  }

  if (tokenRole === "platform_owner") {
    let result;
    try {
      result = await pool.query(
        `
        SELECT id, role,
               COALESCE(active, TRUE) AS active
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );
    } catch (err) {
      if (!err || err.code !== "42703") {
        throw err;
      }
      result = await pool.query(
        `
        SELECT id, role
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );
    }
    const row = result.rows[0];
    if (!row || normalizeRole(row.role) !== "platform_owner") {
      const err = new Error("Forbidden");
      err.status = 403;
      throw err;
    }
    if (row.active === false) {
      const err = new Error("Forbidden");
      err.status = 403;
      throw err;
    }
    return;
  }

  let result;
  try {
    result = await pool.query(
      `
      SELECT id, role, company_id, worker_id,
             COALESCE(active, TRUE) AS active
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );
  } catch (err) {
    if (!err || err.code !== "42703") {
      throw err;
    }
    result = await pool.query(
      `
      SELECT id, role, company_id, worker_id
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );
  }

  const row = result.rows[0];
  if (!row) {
    const err = new Error("Invalid token");
    err.status = 401;
    throw err;
  }

  const dbRole = normalizeRole(row.role);
  if (!dbRole || dbRole !== tokenRole) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const activeVal = row.active;
  if (activeVal === false) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const tokenCompanyId = toPositiveInteger(decoded && decoded.company_id);
  const dbCompanyId = toPositiveInteger(row.company_id);
  if (tokenCompanyId && !dbCompanyId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (tokenCompanyId && dbCompanyId && tokenCompanyId !== dbCompanyId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const tokenWorkerId = toPositiveInteger(decoded && (decoded.worker_id || decoded.workerId));
  const dbWorkerId = toPositiveInteger(row.worker_id);
  if (tokenWorkerId && !dbWorkerId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (tokenWorkerId && dbWorkerId && tokenWorkerId !== dbWorkerId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

async function loadActiveCustomerAccount(customer) {
  const customerAccountId = toPositiveInteger(customer && customer.customer_account_id)
    || toPositiveInteger(customer && customer.id);
  const clientId = toPositiveInteger(customer && customer.client_id);

  let result;
  if (customerAccountId) {
    result = await pool.query(
      `
      SELECT id, client_id, email, first_name, last_name, phone, is_verified, status, deactivated_at
      FROM customer_accounts
      WHERE id = $1
      LIMIT 1
      `,
      [customerAccountId]
    );
  } else if (clientId) {
    result = await pool.query(
      `
      SELECT id, client_id, email, first_name, last_name, phone, is_verified, status, deactivated_at
      FROM customer_accounts
      WHERE client_id = $1
      LIMIT 1
      `,
      [clientId]
    );
  } else {
    result = { rows: [] };
  }

  const account = result.rows[0];
  if (!account) {
    const error = new Error("Customer account not found");
    error.status = 403;
    throw error;
  }

  const status = String(account.status || "active").trim().toLowerCase();
  if (account.deactivated_at || status === "deactivated") {
    const error = new Error("Customer account is deactivated");
    error.status = 403;
    throw error;
  }
  if (status !== "active") {
    const error = new Error(status === "suspended"
      ? "Customer account is suspended"
      : "Customer account is not active");
    error.status = 403;
    throw error;
  }

  return {
    id: account.id,
    client_id: account.client_id,
    email: account.email,
    first_name: account.first_name,
    last_name: account.last_name,
    phone: account.phone,
    is_verified: account.is_verified,
    status,
    deactivated_at: account.deactivated_at
  };
}

async function verifyActiveCustomerBearerToken(header) {
  const customer = verifyCustomerBearerToken(header);
  const account = await loadActiveCustomerAccount(customer);

  const clientRow = await pool.query(
    `
    SELECT id, company_id
    FROM clients
    WHERE id = $1
    LIMIT 1
    `,
    [account.client_id]
  );
  if (!clientRow.rows.length) {
    const err = new Error("Customer not found");
    err.status = 403;
    throw err;
  }

  const dbCompanyId = clientRow.rows[0].company_id != null
    ? Number(clientRow.rows[0].company_id)
    : null;
  const tokenCompanyId = toPositiveInteger(customer && customer.company_id);
  if (tokenCompanyId && dbCompanyId != null && tokenCompanyId !== dbCompanyId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  return {
    customer: {
      ...customer,
      customer_account_id: account.id,
      customer_status: account.status,
      customer_deactivated_at: account.deactivated_at || null,
      company_id: dbCompanyId != null && !Number.isNaN(dbCompanyId) ? dbCompanyId : customer.company_id
    },
    account
  };
}

async function requireActiveCustomer(req, res, next) {
  try {
    const active = await verifyActiveCustomerBearerToken(req.headers.authorization);
    req.customer = active.customer;
    req.customerAccount = active.account;
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({
      error: err.message || "Invalid customer token"
    });
  }
}

function auth(req, res, next) {
  const token = getBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: "Invalid authorization header" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const boundary = classifyTokenBoundary(decoded);
  if (boundary.type === "mixed") {
    return res.status(403).json({ error: "Mixed auth boundary token" });
  }
  if (boundary.type === "customer") {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!decoded || !decoded.id || !decoded.role) {
    return res.status(401).json({ error: "Invalid token payload" });
  }

  const role = boundary.role || normalizeRole(decoded.role);

  if (!role || !STAFF_ROLES.has(role) || role === "customer") {
    return res.status(403).json({ error: "Invalid role" });
  }

  if (role !== "platform_owner" && !toPositiveInteger(decoded.company_id)) {
    return res.status(403).json({ error: "Invalid token payload" });
  }

  (async () => {
    try {
      await validateStaffTokenAgainstDatabase(decoded, role);
      req.user = {
        ...decoded,
        role
      };
      next();
    } catch (err) {
      const status = Number(err && err.status);
      if (status === 403) {
        return res.status(403).json({ error: err.message || "Forbidden" });
      }
      return res.status(401).json({ error: err.message || "Invalid token" });
    }
  })();
}

function requireRole(...allowedRoles) {
  const normalizedAllowed = allowedRoles
    .map(normalizeRole)
    .filter(Boolean);

  return (req, res, next) => {
    const currentRole = normalizeRole(req.user && req.user.role);

    if (currentRole && normalizedAllowed.includes(currentRole)) {
      return next();
    }

    return res.status(403).json({ error: "Forbidden" });
  };
}

function roleRank(role) {
  const normalized = normalizeRole(role);
  return normalized ? ROLE_RANK[normalized] : 0;
}

function hasMinimumRole(user, minRole) {
  const currentRole = normalizeRole(user && user.role);
  const normalizedMinRole = normalizeRole(minRole);

  if (!currentRole || !normalizedMinRole) {
    return false;
  }

  if (currentRole === "platform_owner") {
    return normalizedMinRole === "platform_owner";
  }

  return roleRank(currentRole) >= roleRank(normalizedMinRole);
}

function requireMinimumRole(minRole) {
  const normalizedMinRole = normalizeRole(minRole);

  return (req, res, next) => {
    if (!normalizedMinRole) {
      return res.status(500).json({ error: "Invalid minimum role configuration" });
    }

    if (hasMinimumRole(req.user, normalizedMinRole)) {
      return next();
    }

    return res.status(403).json({ error: "Forbidden" });
  };
}

function requireOwnerAdmin(req, res, next) {
  return requireMinimumRole("admin")(req, res, next);
}

function requirePlatformOwner(req, res, next) {
  const currentRole = normalizeRole(req.user && req.user.role);

  if (currentRole === "platform_owner") {
    return next();
  }

  return res.status(403).json({ error: "Forbidden" });
}

function isOwnerAdmin(user) {
  return hasMinimumRole(user, "admin");
}

function isManagerOrAbove(user) {
  return hasMinimumRole(user, "manager");
}

function isWorker(user) {
  return normalizeRole(user && user.role) === "worker";
}

function workerIdForUser(user) {
  return user && (user.worker_id || user.workerId || null);
}

module.exports = auth;
module.exports.requireRole = requireRole;
module.exports.requireMinimumRole = requireMinimumRole;
module.exports.requireOwnerAdmin = requireOwnerAdmin;
module.exports.requirePlatformOwner = requirePlatformOwner;
module.exports.hasMinimumRole = hasMinimumRole;
module.exports.isOwnerAdmin = isOwnerAdmin;
module.exports.isManagerOrAbove = isManagerOrAbove;
module.exports.isWorker = isWorker;
module.exports.workerIdForUser = workerIdForUser;
module.exports.normalizeRole = normalizeRole;
module.exports.ROLE_RANK = ROLE_RANK;
module.exports.getBearerToken = getBearerToken;
module.exports.classifyTokenBoundary = classifyTokenBoundary;
module.exports.verifyCustomerBearerToken = verifyCustomerBearerToken;
module.exports.verifyActiveCustomerBearerToken = verifyActiveCustomerBearerToken;
module.exports.requireActiveCustomer = requireActiveCustomer;
module.exports.validateStaffTokenAgainstDatabase = validateStaffTokenAgainstDatabase;

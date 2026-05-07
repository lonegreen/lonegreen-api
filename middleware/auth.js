const jwt = require("jsonwebtoken");
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

  return {
    ...decoded,
    client_id: clientId,
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

function auth(req, res, next) {
  const token = getBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: "Invalid authorization header" });
  }

  try {
    const decoded = jwt.verify(token, SECRET);
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

    req.user = {
      ...decoded,
      role
    };

    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
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

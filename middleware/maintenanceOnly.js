const jwt = require("jsonwebtoken");
const { ALLOW_MAINTENANCE_ROUTES, SECRET } = require("../config/env");
const { getBearerToken, normalizeRole } = require("./auth");
const logger = require("../services/logger");

function hideRoute(res) {
  return res.status(404).json({ error: "Route not found" });
}

function maintenanceOnly(req, res, next) {
  if (!ALLOW_MAINTENANCE_ROUTES) {
    logger.warn("MAINTENANCE_ROUTE_DISABLED_ACCESS_ATTEMPT", {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip || req.socket?.remoteAddress || "unknown"
    });
    return hideRoute(res);
  }

  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    logger.warn("MAINTENANCE_ROUTE_UNAUTHENTICATED_ACCESS_ATTEMPT", {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip || req.socket?.remoteAddress || "unknown"
    });
    return hideRoute(res);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    logger.warn("MAINTENANCE_ROUTE_INVALID_TOKEN_ATTEMPT", {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip || req.socket?.remoteAddress || "unknown"
    });
    return hideRoute(res);
  }

  const role = normalizeRole(decoded && decoded.role);
  if (role !== "platform_owner") {
    logger.warn("MAINTENANCE_ROUTE_FORBIDDEN_ROLE_ATTEMPT", {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip || req.socket?.remoteAddress || "unknown",
      user_id: decoded && decoded.id ? decoded.id : null,
      role: role || null
    });
    return hideRoute(res);
  }

  req.user = {
    ...decoded,
    role
  };

  logger.info("MAINTENANCE_ROUTE_ACCESS_GRANTED", {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    user_id: decoded.id || null
  });

  return next();
}

module.exports = maintenanceOnly;

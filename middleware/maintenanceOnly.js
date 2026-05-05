const { ALLOW_MAINTENANCE_ROUTES } = require("../config/env");

function maintenanceOnly(req, res, next) {
  if (!ALLOW_MAINTENANCE_ROUTES) {
    return res.status(403).json({
      error: "Maintenance routes are disabled. Set ALLOW_MAINTENANCE_ROUTES=true to use them.",
    });
  }

  next();
}

module.exports = maintenanceOnly;

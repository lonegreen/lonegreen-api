const { NODE_ENV } = require("../config/env");
const logger = require("./logger");

function sendSafeServerError(res, err, logLabel) {
  logger.error(logLabel, err);
  res.status(500).json({
    error: NODE_ENV === "production"
      ? "Internal server error"
      : (err && err.message) || "Internal server error"
  });
}

module.exports = {
  sendSafeServerError
};

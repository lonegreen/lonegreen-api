function sendSuccess(res, data, meta) {
  const payload = { success: true, data };
  if (meta && typeof meta === "object") {
    Object.assign(payload, meta);
  }
  return res.json(payload);
}

function sendError(res, status, message, details) {
  const payload = {
    success: false,
    error: message || "Internal server error"
  };
  if (details !== undefined) {
    payload.details = details;
  }
  return res.status(status || 500).json(payload);
}

function sendNotFound(res, message = "Not found") {
  return sendError(res, 404, message);
}

function sendForbidden(res, message = "Forbidden") {
  return sendError(res, 403, message);
}

function sendBadRequest(res, message = "Bad request") {
  return sendError(res, 400, message);
}

module.exports = {
  sendSuccess,
  sendError,
  sendNotFound,
  sendForbidden,
  sendBadRequest
};

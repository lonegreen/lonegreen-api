const { normalizeRole } = require("./auth");
const { getStaffMutationBillingBlock } = require("../services/billingService");
const { getStaffMutationPlatformBlock } = require("../services/platformControlService");
const { sendSafeServerError } = require("../services/safeServerError");
const logger = require("../services/logger");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * After `auth`, blocks company-scoped mutating requests when platform billing
 * does not allow changes (suspended, cancelled, grace-expired past_due, expired trial).
 * Skips platform_owner (cross-tenant ops use dedicated routes).
 */
async function requireCompanyBillingForMutations(req, res, next) {
  if (!MUTATING.has(req.method)) {
    return next();
  }

  if (!req.user) {
    return next();
  }

  const role = normalizeRole(req.user.role);

  if (role === "platform_owner") {
    return next();
  }

  try {
    const platformBlock = await getStaffMutationPlatformBlock(req.user.company_id);

    if (platformBlock) {
      logger.warn("PLATFORM_MUTATION_BLOCKED", {
        company_id: req.user.company_id,
        role,
        http_status: platformBlock.httpStatus,
        path: req.originalUrl,
        method: req.method
      });
      return res.status(platformBlock.httpStatus).json(platformBlock.payload);
    }

    const block = await getStaffMutationBillingBlock(req.user.company_id, {
      method: req.method,
      path: req.originalUrl || req.url || ""
    });

    if (block) {
      logger.warn("BILLING_MUTATION_BLOCKED", {
        company_id: req.user.company_id,
        role,
        http_status: block.httpStatus,
        action_required: block.payload && block.payload.action_required,
        billing_status: block.payload && block.payload.billing_status,
        path: req.originalUrl,
        method: req.method
      });
      return res.status(block.httpStatus).json(block.payload);
    }

    return next();
  } catch (err) {
    sendSafeServerError(res, err, "BILLING MUTATION GATE ERROR");
  }
}

module.exports = requireCompanyBillingForMutations;

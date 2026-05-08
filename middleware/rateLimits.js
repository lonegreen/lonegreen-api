const rateLimit = require("express-rate-limit");

function marketplaceRateLimit(windowMs, max, keyBuilder) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      return keyBuilder(req, ip);
    }
  });
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

const marketplaceCustomerRequestCreateLimiter = marketplaceRateLimit(
  FIFTEEN_MINUTES_MS,
  10,
  (req, ip) => `mp:customer:request-create:${req.customer && req.customer.client_id ? req.customer.client_id : "anon"}:${ip}`
);

const marketplaceOfferAcceptLimiter = marketplaceRateLimit(
  FIFTEEN_MINUTES_MS,
  20,
  (req, ip) => `mp:customer:offer-accept:${req.customer && req.customer.client_id ? req.customer.client_id : "anon"}:${ip}`
);

const marketplaceCompanyOfferCreateLimiter = marketplaceRateLimit(
  FIFTEEN_MINUTES_MS,
  60,
  (req, ip) => `mp:company:offer-create:${req.user && req.user.company_id ? req.user.company_id : "anon"}:${ip}`
);

const marketplaceCompanyConvertLimiter = marketplaceRateLimit(
  FIFTEEN_MINUTES_MS,
  30,
  (req, ip) => `mp:company:convert:${req.user && req.user.company_id ? req.user.company_id : "anon"}:${ip}`
);

module.exports = {
  marketplaceCustomerRequestCreateLimiter,
  marketplaceOfferAcceptLimiter,
  marketplaceCompanyOfferCreateLimiter,
  marketplaceCompanyConvertLimiter
};

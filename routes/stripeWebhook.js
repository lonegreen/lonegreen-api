const { processStripeWebhookHttpRequest } = require("../services/stripeWebhookService");
const logger = require("../services/logger");

async function handleStripeWebhookRequest(req, res) {
  try {
    const result = await processStripeWebhookHttpRequest(req);

    if (result.skipped) {
      return res.status(200).json({
        received: true,
        duplicate: true
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    const code = err.code;

    if (code === "WEBHOOK_SECRET_MISSING") {
      logger.warn("STRIPE_WEBHOOK_ROUTE_FAILURE", { webhook_error_code: code });
      return res.status(503).send("Webhook not configured");
    }

    if (code === "STRIPE_NOT_CONFIGURED") {
      logger.warn("STRIPE_WEBHOOK_ROUTE_FAILURE", { webhook_error_code: code });
      return res.status(503).send("Stripe API not configured");
    }

    if (code === "SIGNATURE_INVALID" || code === "SIGNATURE_MISSING") {
      logger.warn("STRIPE_WEBHOOK_ROUTE_FAILURE", { webhook_error_code: code });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (code === "BODY_INVALID") {
      logger.warn("STRIPE_WEBHOOK_ROUTE_FAILURE", { webhook_error_code: code });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (code === "COMPANY_NOT_RESOLVED" || code === "SUBSCRIPTION_SYNC_FAILED") {
      logger.error("STRIPE_WEBHOOK_ROUTE_FAILURE", {
        webhook_error_code: code,
        message: err.message,
        details: err.safeDetails || {}
      });
      return res.status(500).send("Webhook sync error");
    }

    logger.error("STRIPE_WEBHOOK_ROUTE_FAILURE", {
      webhook_error_code: code || "UNKNOWN",
      message: err.message
    });
    return res.status(500).send("Webhook handler error");
  }
}

module.exports = {
  handleStripeWebhookRequest
};

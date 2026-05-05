const { enqueueJob } = require("./jobQueue");
const notificationService = require("./notificationService");
const emailService = require("./emailService");
const subscriptionEngine = require("./subscriptionEngine");
const billingService = require("./billingService");
const logger = require("./logger");

function enqueueNotificationTask(payload) {
  return enqueueJob("notification", payload, async (jobPayload) => {
    if (jobPayload && jobPayload.unique) {
      await notificationService.ensureUniqueNotification(jobPayload);
      return;
    }

    await notificationService.createNotification(jobPayload);
  });
}

function enqueueEmailTask(payload) {
  return enqueueJob("email", payload, async (jobPayload) => {
    try {
      await emailService.sendEmailWithRetry(jobPayload, {
        retries: 3,
        baseDelayMs: 800
      });
    } catch (err) {
      logger.error("EMAIL TASK_ERROR", err);
      throw err;
    }
  });
}

function enqueueSubscriptionProcessingTask() {
  return enqueueJob("subscription_processing", {}, async () => {
    await subscriptionEngine.processSubscriptions();
  });
}

function enqueueBillingLifecycleTask() {
  return enqueueJob("billing_lifecycle", {}, async () => {
    await billingService.evaluatePastDueSuspensions();
  });
}

module.exports = {
  enqueueNotificationTask,
  enqueueEmailTask,
  enqueueSubscriptionProcessingTask,
  enqueueBillingLifecycleTask
};

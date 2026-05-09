const { enqueueJob, registerJobHandler } = require("./jobQueue");
const notificationService = require("./notificationService");
const emailService = require("./emailService");
const subscriptionEngine = require("./subscriptionEngine");
const billingService = require("./billingService");
const logger = require("./logger");

async function notificationJobHandler(jobPayload) {
  if (jobPayload && jobPayload.unique) {
    await notificationService.ensureUniqueNotification(jobPayload);
    return;
  }

  await notificationService.createNotification(jobPayload);
}

async function emailJobHandler(jobPayload) {
  if (!emailService.isEmailConfigured()) {
    const err = new Error("Email SMTP is not configured. Set EMAIL_USER and EMAIL_PASS.");
    err.code = "EMAIL_NOT_CONFIGURED";
    throw err;
  }

  try {
    await emailService.sendEmailWithRetry(jobPayload, {
      retries: 3,
      baseDelayMs: 800
    });
  } catch (err) {
    logger.error("EMAIL TASK_ERROR", err);
    throw err;
  }
}

async function subscriptionProcessingJobHandler() {
  await subscriptionEngine.processSubscriptions();
}

async function billingLifecycleJobHandler() {
  await billingService.evaluatePastDueSuspensions();
}

registerJobHandler("notification", notificationJobHandler);
registerJobHandler("email", emailJobHandler);
registerJobHandler("subscription_processing", subscriptionProcessingJobHandler);
registerJobHandler("billing_lifecycle", billingLifecycleJobHandler);

function enqueueNotificationTask(payload) {
  return enqueueJob("notification", payload, notificationJobHandler);
}

function enqueueEmailTask(payload) {
  return enqueueJob("email", payload, emailJobHandler);
}

function enqueueSubscriptionProcessingTask() {
  return enqueueJob("subscription_processing", {}, subscriptionProcessingJobHandler);
}

function enqueueBillingLifecycleTask() {
  return enqueueJob("billing_lifecycle", {}, billingLifecycleJobHandler);
}

module.exports = {
  enqueueNotificationTask,
  enqueueEmailTask,
  enqueueSubscriptionProcessingTask,
  enqueueBillingLifecycleTask
};

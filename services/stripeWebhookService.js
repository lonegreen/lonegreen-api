const pool = require("../db/pool");
const logger = require("./logger");
const {
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_BASIC,
  STRIPE_PRICE_PRO,
  STRIPE_PRICE_BUSINESS,
  STRIPE_PRICE_BASIC_YEARLY,
  STRIPE_PRICE_PRO_YEARLY,
  STRIPE_PRICE_BUSINESS_YEARLY,
  BILLING_GRACE_PERIOD_DAYS
} = require("../config/env");
const { getStripe } = require("./stripeService");
const {
  syncCompanyBillingFromStripe,
  markCompanyPaymentFailed,
  normalizeBillingCycle
} = require("./billingService");
const notificationService = require("./notificationService");

let backgroundTasks = {};
try {
  backgroundTasks = require("./backgroundTasks");
} catch (err) {
  backgroundTasks = {};
}

const STRIPE_REPLAY_DEFAULT_LIMIT = 25;
const STRIPE_REPLAY_MAX_LIMIT = 100;
const STRIPE_REPLAY_MAX_ATTEMPTS = Number(process.env.STRIPE_REPLAY_MAX_ATTEMPTS || 5);
const STRIPE_EVENT_LEASE_MS = Math.max(1000, Number(process.env.STRIPE_EVENT_LEASE_MS || 120000));

function stripeCustomerId(obj) {
  if (!obj) return null;
  if (typeof obj === "string") return obj;
  return obj.id || null;
}

function internalPlanFromStripePriceId(priceId) {
  const id = String(priceId || "").trim();
  if (!id) return null;
  if (STRIPE_PRICE_BASIC && id === STRIPE_PRICE_BASIC.trim()) return "starter";
  if (STRIPE_PRICE_PRO && id === STRIPE_PRICE_PRO.trim()) return "pro";
  if (STRIPE_PRICE_BUSINESS && id === STRIPE_PRICE_BUSINESS.trim()) return "enterprise";
  if (STRIPE_PRICE_BASIC_YEARLY && id === STRIPE_PRICE_BASIC_YEARLY.trim()) return "starter";
  if (STRIPE_PRICE_PRO_YEARLY && id === STRIPE_PRICE_PRO_YEARLY.trim()) return "pro";
  if (STRIPE_PRICE_BUSINESS_YEARLY && id === STRIPE_PRICE_BUSINESS_YEARLY.trim()) return "enterprise";
  logger.warn("stripeWebhook.unknownPriceId", {
    priceId: id,
    helper: "internalPlanFromStripePriceId"
  });
  return null;
}

function internalPlanFromCheckoutPlanKey(key) {
  const v = String(key || "").trim().toLowerCase();
  if (v === "basic") return "starter";
  if (v === "pro") return "pro";
  if (v === "business") return "enterprise";
  return null;
}

function checkoutPlanKeyFromStripePriceId(priceId) {
  const id = String(priceId || "").trim();
  if (!id) return null;
  if (STRIPE_PRICE_BASIC && id === STRIPE_PRICE_BASIC.trim()) return "basic";
  if (STRIPE_PRICE_PRO && id === STRIPE_PRICE_PRO.trim()) return "pro";
  if (STRIPE_PRICE_BUSINESS && id === STRIPE_PRICE_BUSINESS.trim()) return "business";
  if (STRIPE_PRICE_BASIC_YEARLY && id === STRIPE_PRICE_BASIC_YEARLY.trim()) return "basic";
  if (STRIPE_PRICE_PRO_YEARLY && id === STRIPE_PRICE_PRO_YEARLY.trim()) return "pro";
  if (STRIPE_PRICE_BUSINESS_YEARLY && id === STRIPE_PRICE_BUSINESS_YEARLY.trim()) return "business";
  logger.warn("stripeWebhook.unknownPriceId", {
    priceId: id,
    helper: "checkoutPlanKeyFromStripePriceId"
  });
  return null;
}

function safeWebhookError(message, code, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.safeDetails = details;
  return err;
}

function invoiceFailureReason(invoice) {
  if (invoice && invoice.last_payment_error && invoice.last_payment_error.message) {
    return invoice.last_payment_error.message;
  }

  if (invoice && invoice.status) {
    return `invoice_${invoice.status}`;
  }

  return "payment_failed";
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function mapStripeSubscriptionToBillingPatch(subscription) {
  const pauseCollection = subscription.pause_collection;
  if (pauseCollection && pauseCollection.behavior) {
    return {
      billing_status: "paused",
      trial_ends_at: null,
      billing_grace_until: null
    };
  }

  const status = String(subscription.status || "").toLowerCase();
  const trialEndUnix = subscription.trial_end;

  if (status === "trialing") {
    const trialIso = trialEndUnix
      ? new Date(trialEndUnix * 1000).toISOString()
      : null;
    return {
      billing_status: "trial",
      trial_ends_at: trialIso,
      billing_grace_until: null
    };
  }

  if (status === "active") {
    return {
      billing_status: "active",
      trial_ends_at: null,
      billing_grace_until: null
    };
  }

  if (status === "past_due") {
    return {
      billing_status: "past_due",
      trial_ends_at: null
    };
  }

  if (status === "canceled" || status === "cancelled") {
    return {
      billing_status: "cancelled",
      trial_ends_at: null,
      billing_grace_until: null
    };
  }

  if (status === "unpaid") {
    return {
      billing_status: "unpaid",
      trial_ends_at: null,
      billing_grace_until: addDaysIso(BILLING_GRACE_PERIOD_DAYS)
    };
  }

  if (status === "paused") {
    return {
      billing_status: "paused",
      trial_ends_at: null,
      billing_grace_until: null
    };
  }

  if (status === "incomplete") {
    return {
      billing_status: "incomplete",
      trial_ends_at: null,
      billing_grace_until: null
    };
  }

  if (status === "incomplete_expired") {
    return {
      billing_status: "expired",
      trial_ends_at: null,
      billing_grace_until: null
    };
  }

  return {
    billing_status: "past_due",
    trial_ends_at: null
  };
}

function subscriptionStripePatch(subscription, overrides = {}) {
  const priceId = subscription.items && subscription.items.data && subscription.items.data[0]
    ? subscription.items.data[0].price && subscription.items.data[0].price.id
    : null;

  const metaPlan = subscription.metadata && subscription.metadata.checkout_plan;
  const pricePlan = internalPlanFromStripePriceId(priceId);
  const metaMapped = internalPlanFromCheckoutPlanKey(metaPlan);
  const planKey = metaPlan || checkoutPlanKeyFromStripePriceId(priceId);
  const plan = overrides.plan || pricePlan || metaMapped || "starter";

  const billingPatch = mapStripeSubscriptionToBillingPatch(subscription);
  const cpe = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
  const cps = subscription.current_period_start
    ? new Date(subscription.current_period_start * 1000).toISOString()
    : null;

  const billing_cycle = subscription.metadata && subscription.metadata.billing_cycle
    ? normalizeBillingCycle(subscription.metadata.billing_cycle)
    : undefined;

  return {
    plan,
    billing_status: overrides.billing_status !== undefined
      ? overrides.billing_status
      : billingPatch.billing_status,
    trial_ends_at: Object.prototype.hasOwnProperty.call(overrides, "trial_ends_at")
      ? overrides.trial_ends_at
      : billingPatch.trial_ends_at,
    billing_grace_until: Object.prototype.hasOwnProperty.call(overrides, "billing_grace_until")
      ? overrides.billing_grace_until
      : billingPatch.billing_grace_until,
    billing_cycle,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: stripeCustomerId(subscription.customer),
    stripe_subscription_status: subscription.status,
    stripe_current_period_start: cps,
    stripe_current_period_end: cpe,
    stripe_price_id: priceId || null,
    stripe_plan_key: planKey || null,
    cancel_at_period_end: subscription.cancel_at_period_end === true
  };
}

async function resolveCompanyId(metadataCompanyId, clientReferenceId, stripeCustomerId) {
  const customerId = stripeCustomerId ? String(stripeCustomerId).trim() : null;
  const candidates = [metadataCompanyId, clientReferenceId]
    .map((value) => parseInt(String(value || ""), 10))
    .filter((value) => Number.isFinite(value));

  if (customerId) {
    const authResult = await pool.query(
      `
      SELECT id
      FROM companies
      WHERE stripe_customer_id = $1
      LIMIT 1
      `,
      [customerId]
    );

    if (authResult.rows[0]) {
      const authoritativeId = authResult.rows[0].id;
      const metaPid = parseInt(String(metadataCompanyId || ""), 10);
      const refPid = parseInt(String(clientReferenceId || ""), 10);
      if (Number.isFinite(metaPid) && metaPid !== authoritativeId) {
        logger.warn("Stripe webhook: metadata company_id conflicts with stripe_customer_id mapping", {
          authoritative_company_id: authoritativeId,
          metadata_company_id: metaPid,
          stripe_customer_id: customerId
        });
        return {
          companyId: null,
          method: null
        };
      }
      if (Number.isFinite(refPid) && refPid !== authoritativeId) {
        logger.warn("Stripe webhook: client_reference_id conflicts with stripe_customer_id mapping", {
          authoritative_company_id: authoritativeId,
          client_reference_id: refPid,
          stripe_customer_id: customerId
        });
        return {
          companyId: null,
          method: null
        };
      }
      return {
        companyId: authoritativeId,
        method: "stripe_customer_id"
      };
    }
  }

  for (const pid of [...new Set(candidates)]) {
    const r = await pool.query(
      `
      SELECT id, stripe_customer_id
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [pid]
    );

    if (!r.rows.length) {
      continue;
    }

    const row = r.rows[0];

    if (customerId) {
      if (row.stripe_customer_id && row.stripe_customer_id !== customerId) {
        continue;
      }
      return {
        companyId: pid,
        method: pid === parseInt(String(metadataCompanyId || ""), 10)
          ? "metadata.company_id"
          : "client_reference_id"
      };
    }

    return {
      companyId: pid,
      method: pid === parseInt(String(metadataCompanyId || ""), 10)
        ? "metadata.company_id"
        : "client_reference_id"
    };
  }

  return {
    companyId: null,
    method: null
  };
}

async function tryClaimEvent(eventId, eventType) {
  const leaseStartedAt = new Date().toISOString();
  const leaseMarker = `[lease_started_at:${leaseStartedAt}]`;

  const parseLeaseStartedAt = (errorCode, errorMessage) => {
    if (String(errorCode || "") !== "IN_PROGRESS") return null;
    const match = String(errorMessage || "").match(/\[lease_started_at:([^\]]+)\]/);
    if (!match) return null;
    const d = new Date(match[1]);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const isLeaseExpired = (startedAt) => {
    if (!startedAt) return false;
    return Date.now() - startedAt.getTime() >= STRIPE_EVENT_LEASE_MS;
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `
      SELECT stripe_event_id, processed_at, retryable, error_code, error_message, created_at
      FROM stripe_events
      WHERE stripe_event_id = $1
      FOR UPDATE
      `,
      [eventId]
    );

    if (!existing.rows.length) {
      try {
        await client.query(
          `
          INSERT INTO stripe_events (stripe_event_id, event_type, processed_at, error_code, error_message, retryable)
          VALUES ($1, $2, NULL, 'IN_PROGRESS', $3, FALSE)
          `,
          [eventId, eventType, leaseMarker]
        );
      } catch (err) {
        if (err && err.code === "23505") {
          await client.query("ROLLBACK");
          logger.info("STRIPE_WEBHOOK_CLAIM_RACE_DUPLICATE", {
            stripe_event_id: eventId,
            event_type: eventType,
            detail: "unique_violation_on_insert_treated_as_already_claimed"
          });
          return false;
        }
        if (!err || err.code !== "42703") throw err;
        try {
          await client.query(
            `
            INSERT INTO stripe_events (stripe_event_id, event_type, processed_at)
            VALUES ($1, $2, NULL)
            `,
            [eventId, eventType]
          );
        } catch (err2) {
          if (err2 && err2.code === "23505") {
            await client.query("ROLLBACK");
            logger.info("STRIPE_WEBHOOK_CLAIM_RACE_DUPLICATE", {
              stripe_event_id: eventId,
              event_type: eventType,
              detail: "legacy_insert_unique_violation_treated_as_already_claimed"
            });
            return false;
          }
          throw err2;
        }
      }
      await client.query("COMMIT");
      return true;
    }

    const row = existing.rows[0];
    if (row.processed_at) {
      await client.query("COMMIT");
      return false;
    }

    const inProgressLeaseStartedAt = parseLeaseStartedAt(row.error_code, row.error_message);
    const inProgress = String(row.error_code || "") === "IN_PROGRESS" && row.retryable !== true;
    const inProgressExpired = inProgress && isLeaseExpired(inProgressLeaseStartedAt);

    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const legacyStaleClaim = (
      row.retryable !== true
      && !inProgress
      && createdAt
      && !Number.isNaN(createdAt.getTime())
      && isLeaseExpired(createdAt)
    );

    const canClaim = row.retryable === true || inProgressExpired || legacyStaleClaim;
    if (!canClaim) {
      await client.query("COMMIT");
      return false;
    }

    try {
      await client.query(
        `
        UPDATE stripe_events
        SET event_type = $2,
            processed_at = NULL,
            error_code = 'IN_PROGRESS',
            error_message = $3,
            retryable = FALSE
        WHERE stripe_event_id = $1
        `,
        [eventId, eventType, leaseMarker]
      );
    } catch (err) {
      if (!err || err.code !== "42703") throw err;
      await client.query(
        `
        UPDATE stripe_events
        SET event_type = $2,
            processed_at = NULL
        WHERE stripe_event_id = $1
        `,
        [eventId, eventType]
      );
    }

    await client.query("COMMIT");
    return true;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function markEventProcessed(event, audit = {}) {
  await pool.query(
    `
    UPDATE stripe_events
    SET event_type = $2,
        object_id = COALESCE($3, object_id),
        company_id = COALESCE($4::int, company_id),
        processed_at = CURRENT_TIMESTAMP,
        error_code = NULL,
        error_message = NULL,
        retryable = FALSE
    WHERE stripe_event_id = $1
    `,
    [
      event.id,
      event.type,
      audit.object_id || null,
      audit.company_id || null
    ]
  ).catch((err) => {
    if (err && err.code === "42703") {
      return pool.query(
        `
        UPDATE stripe_events
        SET processed_at = CURRENT_TIMESTAMP
        WHERE stripe_event_id = $1
        `,
        [event.id]
      ).catch(() => {});
    }
    if (err) {
      logger.warn("STRIPE_WEBHOOK_AUDIT_UPDATE_FAILED", { error: err.message });
    }
  });

  await pool.query(
    `
    INSERT INTO stripe_processed_events (stripe_event_id, event_type)
    VALUES ($1, $2)
    ON CONFLICT (stripe_event_id) DO NOTHING
    `,
    [event.id, event.type]
  ).catch(() => {});
}

async function markEventFailed(event, err, audit = {}) {
  await pool.query(
    `
    UPDATE stripe_events
    SET event_type = $2,
        object_id = COALESCE($3, object_id),
        company_id = COALESCE($4::int, company_id),
        error_code = $5,
        error_message = $6,
        retryable = $7,
        processed_at = NULL
    WHERE stripe_event_id = $1
    `,
    [
      event.id,
      event.type,
      audit.object_id || null,
      audit.company_id || null,
      err.code || "WEBHOOK_HANDLER_ERROR",
      String(err.message || "Webhook handler error").slice(0, 500),
      err.code !== "SIGNATURE_INVALID" && err.code !== "BODY_INVALID"
    ]
  ).catch((auditErr) => {
    if (auditErr && auditErr.code === "42703") {
      return Promise.all([
        pool.query("DELETE FROM stripe_events WHERE stripe_event_id = $1", [event.id]).catch(() => {}),
        pool.query("DELETE FROM stripe_processed_events WHERE stripe_event_id = $1", [event.id]).catch(() => {})
      ]);
    }
    if (auditErr) {
      logger.warn("STRIPE_WEBHOOK_AUDIT_FAILURE_UPDATE_FAILED", { error: auditErr.message });
    }
  });
}

async function createSafeBillingNotification(companyId, payload) {
  if (!companyId) return;

  try {
    await notificationService.createNotification({
      companyId,
      userId: null,
      ...payload
    });
  } catch (err) {
    logger.warn("BILLING_WEBHOOK_NOTIFICATION_FAILED", {
      company_id: companyId,
      error: err && err.message
    });
  }
}

function enqueueSafeBillingEmail(payload) {
  if (!payload || typeof backgroundTasks.enqueueEmailTask !== "function") return;

  try {
    const enqueueResult = backgroundTasks.enqueueEmailTask(payload);
    if (enqueueResult && typeof enqueueResult.catch === "function") {
      enqueueResult.catch((err) => {
        logger.warn("BILLING_WEBHOOK_EMAIL_ENQUEUE_FAILED", { error: err && err.message });
      });
    }
  } catch (err) {
    logger.warn("BILLING_WEBHOOK_EMAIL_ENQUEUE_FAILED", { error: err && err.message });
  }
}

async function mirrorProcessedEvent(eventId, eventType) {
  try {
    await pool.query(
      `
      INSERT INTO stripe_processed_events (stripe_event_id, event_type)
      VALUES ($1, $2)
      ON CONFLICT (stripe_event_id) DO NOTHING
      `,
      [eventId, eventType]
    ).catch(() => {});
  } catch (err) {
    /* non-fatal compatibility mirror */
  }
}

async function syncSubscriptionToCompany(subscription, overrides = {}) {
  const customerId = stripeCustomerId(subscription.customer);
  const metaCompany = subscription.metadata && subscription.metadata.company_id;
  const resolution = await resolveCompanyId(metaCompany, null, customerId);
  const companyId = resolution.companyId;

  console.log("Stripe webhook: company resolution result", {
    object: "subscription",
    object_id: subscription.id,
    company_id: companyId,
    method: resolution.method
  });

  if (!companyId) {
    throw safeWebhookError("Stripe webhook could not resolve company for subscription", "COMPANY_NOT_RESOLVED", {
      subscription_id: subscription.id,
      customer_id: customerId
    });
  }

  const patch = subscriptionStripePatch(subscription, overrides);
  const synced = await syncCompanyBillingFromStripe(companyId, patch);

  if (!synced) {
    throw safeWebhookError("Stripe webhook subscription sync did not update a company", "SUBSCRIPTION_SYNC_FAILED", {
      company_id: companyId,
      subscription_id: subscription.id
    });
  }

  console.log("Stripe webhook: synced subscription", {
    company_id: companyId,
    subscription_id: subscription.id,
    status: subscription.status,
    plan: patch.plan,
    billing_status: patch.billing_status,
    price_id: patch.stripe_price_id,
    plan_key: patch.stripe_plan_key
  });

  return synced;
}

async function onCheckoutSessionCompleted(session, stripe) {
  if (session.mode !== "subscription") {
    return;
  }

  const subRef = session.subscription;
  if (!subRef) {
    console.warn("Stripe webhook: checkout.session.completed without subscription");
    return;
  }

  const subId = typeof subRef === "string" ? subRef : subRef.id;
  const subscription = await stripe.subscriptions.retrieve(subId);

  const customerId = stripeCustomerId(session.customer);
  const metaCompany = session.metadata && session.metadata.company_id;
  const resolution = await resolveCompanyId(metaCompany, session.client_reference_id, customerId);
  const companyId = resolution.companyId;

  console.log("Stripe webhook: company resolution result", {
    object: "checkout.session",
    object_id: session.id,
    company_id: companyId,
    method: resolution.method
  });

  if (!companyId) {
    throw safeWebhookError("Stripe webhook could not resolve company for checkout session", "COMPANY_NOT_RESOLVED", {
      session_id: session.id,
      customer_id: customerId
    });
  }

  if (
    customerId
    && subscription.metadata
    && (!subscription.metadata.company_id || !subscription.metadata.checkout_plan)
  ) {
    try {
      await stripe.subscriptions.update(subscription.id, {
        metadata: {
          ...subscription.metadata,
          company_id: String(companyId),
          checkout_plan: session.metadata && session.metadata.checkout_plan
            ? String(session.metadata.checkout_plan)
            : subscription.metadata.checkout_plan,
          billing_cycle: session.metadata && session.metadata.billing_cycle
            ? String(session.metadata.billing_cycle)
            : subscription.metadata.billing_cycle
        }
      });
    } catch (metaErr) {
      console.warn("Stripe webhook: could not attach company_id metadata", metaErr.message);
    }
  }

  const refreshed = await stripe.subscriptions.retrieve(subscription.id);
  const synced = await syncSubscriptionToCompany(refreshed, {});
  return {
    company_id: synced && synced.company_id,
    object_id: session.id
  };
}

async function onSubscriptionDeleted(subscription) {
  const customerId = stripeCustomerId(subscription.customer);
  const metaCompany = subscription.metadata && subscription.metadata.company_id;
  const resolution = await resolveCompanyId(metaCompany, null, customerId);
  const companyId = resolution.companyId;

  console.log("Stripe webhook: company resolution result", {
    object: "subscription.deleted",
    object_id: subscription.id,
    company_id: companyId,
    method: resolution.method
  });

  if (!companyId) {
    throw safeWebhookError("Stripe webhook could not resolve company for deleted subscription", "COMPANY_NOT_RESOLVED", {
      subscription_id: subscription.id,
      customer_id: customerId
    });
  }

  const synced = await syncCompanyBillingFromStripe(companyId, {
    billing_status: "cancelled",
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    stripe_subscription_status: "canceled",
    stripe_current_period_end: null,
    trial_ends_at: null,
    cancel_at_period_end: false,
    billing_grace_until: null,
    billing_failure_reason: null
  });

  if (!synced) {
    throw safeWebhookError("Stripe webhook deleted subscription sync did not update a company", "SUBSCRIPTION_SYNC_FAILED", {
      company_id: companyId,
      subscription_id: subscription.id
    });
  }

  console.log("Stripe webhook: subscription deleted → billing cancelled", {
    company_id: companyId,
    subscription_id: subscription.id
  });

  await createSafeBillingNotification(companyId, {
    type: "billing_subscription_cancelled",
    title: "Subscription cancelled",
    message: "Billing subscription was cancelled. Mutations are blocked until billing is reactivated.",
    metadata: { stripe_subscription_id: subscription.id }
  });

  return {
    company_id: companyId,
    object_id: subscription.id
  };
}

async function onInvoicePaymentFailed(invoice, stripe) {
  const customerId = stripeCustomerId(invoice.customer);
  let companyId = null;

  if (invoice.subscription) {
    const subId = typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subId);
    const metaCompany = subscription.metadata && subscription.metadata.company_id;
    const resolution = await resolveCompanyId(metaCompany, null, customerId);
    companyId = resolution.companyId;
  }

  if (!companyId) {
    const resolution = await resolveCompanyId(null, null, customerId);
    companyId = resolution.companyId;
  }

  console.log("Stripe webhook: company resolution result", {
    object: "invoice.payment_failed",
    object_id: invoice.id,
    company_id: companyId,
    method: companyId ? "subscription_or_customer" : null
  });

  if (!companyId) {
    throw safeWebhookError("Stripe webhook could not resolve company for invoice payment failure", "COMPANY_NOT_RESOLVED", {
      invoice_id: invoice.id,
      customer_id: customerId
    });
  }

  const synced = await markCompanyPaymentFailed(companyId, invoiceFailureReason(invoice));

  if (!synced) {
    throw safeWebhookError("Stripe webhook invoice failure sync did not update a company", "SUBSCRIPTION_SYNC_FAILED", {
      company_id: companyId,
      invoice_id: invoice.id
    });
  }

  console.log("Stripe webhook: invoice payment failed → past_due", {
    company_id: companyId,
    invoice_id: invoice.id
  });

  await createSafeBillingNotification(companyId, {
    type: "billing_payment_failed",
    title: "Payment failed",
    message: "A subscription payment failed. Update payment details before the grace period ends.",
    metadata: { stripe_invoice_id: invoice.id }
  });
  enqueueSafeBillingEmail(null);

  return {
    company_id: companyId,
    object_id: invoice.id
  };
}

async function onInvoicePaymentSucceeded(invoice, stripe) {
  if (!invoice.subscription) {
    return;
  }

  const subId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription.id;
  const subscription = await stripe.subscriptions.retrieve(subId);
  const synced = await syncSubscriptionToCompany(subscription, {
    billing_status: "active",
    billing_grace_until: null,
    billing_last_payment_succeeded_at: new Date().toISOString(),
    billing_suspended_at: null,
    billing_failure_reason: null
  });

  const companyId = synced && synced.company_id;
  await createSafeBillingNotification(companyId, {
    type: "billing_payment_succeeded",
    title: "Payment recovered",
    message: "Subscription payment succeeded and billing access is active.",
    metadata: { stripe_invoice_id: invoice.id }
  });

  return {
    company_id: companyId,
    object_id: invoice.id
  };
}

async function dispatchStripeEvent(event) {
  const stripe = getStripe();

  if (!stripe) {
    throw Object.assign(new Error("Stripe API not configured"), { code: "STRIPE_NOT_CONFIGURED" });
  }

  const type = event.type;
  const obj = event.data && event.data.object;

  console.log("Stripe webhook: event received", {
    id: event.id,
    type
  });

  if (!obj) {
    console.warn("Stripe webhook: event without data.object", type);
    return;
  }

  if (type === "checkout.session.completed") {
    return onCheckoutSessionCompleted(obj, stripe);
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    if (String(obj.status || "").toLowerCase() === "canceled") {
      return onSubscriptionDeleted(obj);
    }

    const synced = await syncSubscriptionToCompany(obj, {});
    return {
      company_id: synced && synced.company_id,
      object_id: obj.id
    };
  }

  if (type === "customer.subscription.deleted") {
    return onSubscriptionDeleted(obj);
  }

  if (type === "invoice.payment_failed") {
    return onInvoicePaymentFailed(obj, stripe);
  }

  if (type === "invoice.payment_succeeded") {
    return onInvoicePaymentSucceeded(obj, stripe);
  }

  if (type === "invoice.finalization_failed") {
    logger.warn("STRIPE_WEBHOOK_INVOICE_FINALIZATION_FAILED", {
      invoice_id: obj.id,
      customer_id: stripeCustomerId(obj.customer)
    });
    return { object_id: obj.id };
  }

  if (type === "customer.subscription.trial_will_end") {
    const synced = await syncSubscriptionToCompany(obj, {});
    await createSafeBillingNotification(synced && synced.company_id, {
      type: "billing_trial_will_end",
      title: "Trial ending soon",
      message: "Your billing trial is ending soon. Add payment details to keep access active.",
      metadata: { stripe_subscription_id: obj.id }
    });
    return {
      company_id: synced && synced.company_id,
      object_id: obj.id
    };
  }

  logger.info("STRIPE_WEBHOOK_EVENT_IGNORED", {
    event_id: event.id,
    event_type: type
  });
  return { object_id: obj.id || null };
}

async function processStripeWebhookHttpRequest(req) {
  const stripe = getStripe();

  if (!STRIPE_WEBHOOK_SECRET) {
    logger.warn("STRIPE_WEBHOOK_CONFIG", { detail: "STRIPE_WEBHOOK_SECRET not set" });
    throw Object.assign(new Error("Webhook endpoint not configured"), { code: "WEBHOOK_SECRET_MISSING" });
  }

  if (!stripe) {
    throw Object.assign(new Error("Stripe API not configured"), { code: "STRIPE_NOT_CONFIGURED" });
  }

  const sig = req.headers["stripe-signature"];

  if (!sig) {
    throw Object.assign(new Error("Missing Stripe-Signature header"), { code: "SIGNATURE_MISSING" });
  }

  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    throw Object.assign(new Error("Invalid webhook body (expected raw buffer)"), { code: "BODY_INVALID" });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn("STRIPE_WEBHOOK_SIGNATURE_INVALID", { message: err.message });
    throw Object.assign(new Error("Signature verification failed"), { code: "SIGNATURE_INVALID" });
  }

  const claimed = await tryClaimEvent(event.id, event.type);

  if (!claimed) {
    logger.info("STRIPE_WEBHOOK_DUPLICATE_SKIPPED", {
      event_id: event.id,
      event_type: event.type
    });
    return { skipped: true };
  }

  try {
    const audit = await dispatchStripeEvent(event);
    await markEventProcessed(event, audit || {});
  } catch (err) {
    logger.error("STRIPE_WEBHOOK_HANDLER_FAILURE", {
      event_id: event.id,
      event_type: event.type,
      code: err.code || "WEBHOOK_HANDLER_ERROR",
      message: err.message,
      details: err.safeDetails || {}
    });
    await markEventFailed(event, err, err.safeDetails || {});
    throw err;
  }

  return { skipped: false };
}

function parseReplayAttemptCount(message) {
  const text = String(message || "");
  const match = text.match(/\[replay_attempt:(\d+)\]/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function buildReplayFailureError(err, attempt) {
  const message = err && err.message ? String(err.message) : "Webhook handler error";
  const replayErr = new Error(`[replay_attempt:${attempt}] ${message}`);
  replayErr.code = err && err.code ? err.code : "WEBHOOK_HANDLER_ERROR";
  replayErr.safeDetails = err && err.safeDetails ? err.safeDetails : {};
  return replayErr;
}

function normalizeReplayLimit(rawLimit) {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) return STRIPE_REPLAY_DEFAULT_LIMIT;
  return Math.min(STRIPE_REPLAY_MAX_LIMIT, Math.floor(parsed));
}

async function listReplayCandidates(limit) {
  const result = await pool.query(
    `
    SELECT se.stripe_event_id, se.event_type, se.error_message
    FROM stripe_events se
    LEFT JOIN stripe_processed_events spe
      ON spe.stripe_event_id = se.stripe_event_id
    WHERE se.retryable = TRUE
      AND se.processed_at IS NULL
      AND spe.stripe_event_id IS NULL
    ORDER BY se.created_at ASC, se.stripe_event_id ASC
    LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

async function claimReplayCandidate(eventId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `
      SELECT stripe_event_id, event_type, error_message, retryable, processed_at
      FROM stripe_events
      WHERE stripe_event_id = $1
      FOR UPDATE
      `,
      [eventId]
    );
    if (!locked.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = locked.rows[0];
    if (!row.retryable || row.processed_at) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `
      UPDATE stripe_events
      SET
        retryable = FALSE,
        error_code = 'REPLAY_IN_PROGRESS',
        error_message = 'Internal replay in progress'
      WHERE stripe_event_id = $1
      `,
      [eventId]
    );
    await client.query("COMMIT");
    return row;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function replayRetryableStripeEvents(options = {}) {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe API not configured"), { code: "STRIPE_NOT_CONFIGURED" });
  }
  const limit = normalizeReplayLimit(options.limit);
  const maxAttempts = Number.isFinite(Number(options.maxAttempts))
    ? Math.max(1, Math.floor(Number(options.maxAttempts)))
    : Math.max(1, STRIPE_REPLAY_MAX_ATTEMPTS);

  logger.info("STRIPE_WEBHOOK_REPLAY_STARTED", { limit, max_attempts: maxAttempts });

  const candidates = await listReplayCandidates(limit);
  const summary = {
    scanned: candidates.length,
    replayed_success: 0,
    replayed_failed: 0,
    skipped_processed: 0,
    skipped_max_attempts: 0
  };

  for (const candidate of candidates) {
    const eventId = candidate.stripe_event_id;
    const knownAttempts = parseReplayAttemptCount(candidate.error_message);
    if (knownAttempts >= maxAttempts) {
      summary.skipped_max_attempts += 1;
      logger.warn("STRIPE_WEBHOOK_REPLAY_SKIPPED_MAX_ATTEMPTS", {
        event_id: eventId,
        attempts: knownAttempts,
        max_attempts: maxAttempts
      });
      continue;
    }

    const claimed = await claimReplayCandidate(eventId);
    if (!claimed) {
      summary.skipped_processed += 1;
      continue;
    }

    try {
      const alreadyProcessed = await pool.query(
        `
        SELECT 1
        FROM stripe_processed_events
        WHERE stripe_event_id = $1
        LIMIT 1
        `,
        [eventId]
      );
      if (alreadyProcessed.rows.length) {
        await markEventProcessed({ id: eventId, type: claimed.event_type }, {});
        summary.skipped_processed += 1;
        logger.info("STRIPE_WEBHOOK_REPLAY_SKIPPED_ALREADY_PROCESSED", {
          event_id: eventId,
          event_type: claimed.event_type
        });
        continue;
      }

      const event = await stripe.events.retrieve(eventId);
      const audit = await dispatchStripeEvent(event);
      await markEventProcessed(event, audit || {});
      summary.replayed_success += 1;
      logger.info("STRIPE_WEBHOOK_REPLAY_EVENT_SUCCESS", {
        event_id: eventId,
        event_type: event.type
      });
    } catch (err) {
      summary.replayed_failed += 1;
      const replayError = buildReplayFailureError(err, knownAttempts + 1);
      await markEventFailed({ id: eventId, type: claimed.event_type }, replayError, replayError.safeDetails || {});
      logger.error("STRIPE_WEBHOOK_REPLAY_EVENT_FAILED", {
        event_id: eventId,
        event_type: claimed.event_type,
        code: replayError.code || "WEBHOOK_HANDLER_ERROR",
        message: replayError.message
      });
    }
  }

  logger.info("STRIPE_WEBHOOK_REPLAY_FINISHED", summary);
  return summary;
}

module.exports = {
  processStripeWebhookHttpRequest,
  resolveCompanyId,
  internalPlanFromStripePriceId,
  syncSubscriptionToCompany,
  replayRetryableStripeEvents
};

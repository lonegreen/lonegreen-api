const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { requireMinimumRole, normalizeRole } = auth;
const {
  warnDeprecatedRoute,
  parseIntSafe,
  normalizeDateOnly,
  parseDateOnly,
  formatDateOnly,
  addFrequency,
  buildSubscriptionVisitDates,
  buildUpcomingSubscriptionDates,
  normalizeJobStatus,
  normalizeJobPaymentStatus,
  normalizePaymentStatus,
  getSuggestedWorker,
  safeJsonParse,
  normalizePaymentMethod,
  normalizeInvoiceStatus,
  nextInvoiceNumber,
  normalizeLineItems,
  recalculateInvoiceFinancials,
  hydrateInvoice,
  syncFinancialAlerts,
  ensureActivityLogSchema,
  logActivity,
  logChange,
  ensureNotificationsSchema,
  createNotification,
  ensureUniqueNotification,
  createNotificationIfMissing,
  syncAlerts,
  ensureEstimateSchema,
  ensureJobPhotoSchema,
  ensureSubscriptionBillingSchema,
  ensureClientLifecycleSchema,
  ensureWorkflowSchema,
  ensureOperationsSchema,
  normalizeLeadStatus,
  normalizeEstimateStatus,
  nextMonthDateString,
  getClientById,
  createClientFromContact,
  getLead,
  getEstimate,
  formatTimelineItem
} = require("../services/routeHelpers");
const { sendSafeServerError } = require("../services/safeServerError");
const { enqueueEmailTask } = require("../services/backgroundTasks");
const { buildSubscriptionReminderPayload } = require("../services/emailService");
const logger = require("../services/logger");
const { notifyBillingWarning } = require("../services/notificationService");
// Subscription mark-paid paths run inside a single transaction (BEGIN/COMMIT on a
// pool.connect() client) and therefore inline the canonical equivalent of
// createPaymentRecord: lock invoice FOR UPDATE -> assertPaymentWithinRemaining ->
// INSERT INTO payments -> appendPaymentLedgerEntry, all atomically. The
// createPaymentRecord helper is re-exported here for callers that record a
// subscription payment WITHOUT an existing transaction (it opens its own).
const {
  appendPaymentLedgerEntry,
  assertPaymentWithinRemaining,
  getNetPaidForInvoice,
  createPaymentRecord
} = require("../services/financialIntegrityService");

const router = express.Router();
const DEPRECATED_ENDPOINT_ERROR = { error: "Deprecated endpoint. Use canonical API route." };

const BILLING_STATES = new Set(["trialing", "active", "past_due", "unpaid", "canceled", "suspended"]);

function evaluateBillingLifecycleState(rawStatus) {
  const normalized = String(rawStatus || "").trim().toLowerCase();
  const state = BILLING_STATES.has(normalized) ? normalized : "active";
  const warnings = [];
  if (state === "past_due" || state === "unpaid") warnings.push("billing_attention_required");
  if (state === "canceled" || state === "suspended") warnings.push("billing_reactivation_required");
  return { state, warnings, blocking: false };
}

async function billingLifecycleAuditOnlyMiddleware(req, res, next) {
  try {
    const companyId = Number(req.user && req.user.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) return next();
    const result = await pool.query(
      "SELECT billing_status FROM companies WHERE id=$1 LIMIT 1",
      [companyId]
    );
    const evalResult = evaluateBillingLifecycleState(result.rows[0] && result.rows[0].billing_status);
    req.billingLifecycle = evalResult;
    if (evalResult.warnings.length) {
      res.setHeader("x-fairlinx-billing-warning", evalResult.warnings.join(","));
      try {
        await notifyBillingWarning({
          companyId,
          warningMessage: `Billing lifecycle warning: ${evalResult.state}`
        });
      } catch (_) {}
    }
    return next();
  } catch (err) {
    return next();
  }
}

function parsePagination(query) {
  const parsedLimit = Number(query && query.limit);
  const parsedOffset = Number(query && query.offset);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;
  return { limit, offset };
}

function lockDeprecatedLegacyMutations(req, res, next) {
  const method = req.method;
  const path = req.path;
  const isLockedLegacyMutation = (
    (method === "POST" && path === "/subscriptions") ||
    (method === "POST" && /^\/subscriptions\/[^/]+\/send-reminder-email$/.test(path)) ||
    (method === "PUT" && /^\/subscriptions\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/subscriptions\/[^/]+\/status$/.test(path)) ||
    (method === "PUT" && /^\/subscriptions\/[^/]+\/mark-paid$/.test(path)) ||
    (method === "DELETE" && /^\/subscriptions\/[^/]+$/.test(path))
  );
  if (isLockedLegacyMutation) {
    return res.status(410).json(DEPRECATED_ENDPOINT_ERROR);
  }
  return next();
}
router.use(lockDeprecatedLegacyMutations);

function hasBodyField(req, field) {
  return Object.prototype.hasOwnProperty.call(req.body || {}, field);
}

async function resolveCompanyWorkerId(companyId, workerId, queryRunner = pool) {
  if (workerId === undefined || workerId === null || String(workerId).trim() === "") {
    return { ok: true, workerId: null };
  }

  const parsedWorkerId = Number(workerId);
  if (!Number.isInteger(parsedWorkerId) || parsedWorkerId <= 0) {
    return { ok: false };
  }

  const worker = await queryRunner.query(
    "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
    [parsedWorkerId, companyId]
  );

  if (worker.rows.length === 0) {
    return { ok: false };
  }

  return { ok: true, workerId: parsedWorkerId };
}

/* ================= SUBSCRIPTIONS ================= */

router.post("/subscriptions", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/subscriptions", "/ops/subscriptions");
    await ensureSubscriptionBillingSchema();
    const { client_id, service, frequency, next_date, price, worker_id } = req.body;
    const company_id = req.user.company_id;

    if (!client_id || !service || !frequency || !next_date) {
      return res.status(400).json({ error: "Missing data" });
    }

    const client = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [client_id, company_id]
    );

    if (client.rows.length === 0) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    const workerLookup = await resolveCompanyWorkerId(company_id, worker_id);
    if (!workerLookup.ok) {
      return res.status(400).json({ error: "Worker not found in this company" });
    }

    const subResult = await pool.query(`
      INSERT INTO subscriptions 
      (client_id, service, frequency, next_date, price, worker_id, status, company_id, start_date, next_billing_date)
      VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)
      RETURNING *
    `, [
      client_id,
      service,
      frequency,
      next_date,
      price || 0,
      workerLookup.workerId,
      company_id,
      next_date,
      next_date
    ]);

    const createdSub = subResult.rows[0];

    const visitDates = buildSubscriptionVisitDates(next_date, frequency, 8);

    for (const visitDate of visitDates) {
      const exists = await pool.query(`
        SELECT id FROM jobs
        WHERE source_subscription_id = $1
          AND date = $2
          AND type='subscription_visit'
          AND company_id=$3
      `, [createdSub.id, visitDate, company_id]);

      if (exists.rows.length === 0) {
        await pool.query(`
          INSERT INTO jobs
          (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
          SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
          WHERE NOT EXISTS (
            SELECT 1
            FROM jobs
            WHERE source_subscription_id = $6
              AND date = $3
              AND type = 'subscription_visit'
              AND company_id = $5
          )
        `, [
          client_id,
          service,
          visitDate,
          workerLookup.workerId,
          company_id,
          createdSub.id
        ]);
      }
    }

    res.json(createdSub);
  } catch (err) {
    console.log("ADD SUB ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.get("/subscriptions", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/subscriptions", "/ops/subscriptions");
    await ensureSubscriptionBillingSchema();
    const company_id = req.user.company_id;
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(`
      SELECT 
        subscriptions.id,
        subscriptions.client_id,
        subscriptions.service,
        subscriptions.frequency,
        subscriptions.next_date,
        subscriptions.last_run,
        subscriptions.price,
        subscriptions.worker_id,
        subscriptions.status,
        subscriptions.start_date,
        subscriptions.next_billing_date,
        subscriptions.last_billed_month,
        subscriptions.last_billed_at,
        subscriptions.pause_reason,
        subscriptions.cancel_reason,
        subscriptions.company_id,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address,
        workers.name AS worker_name
      FROM subscriptions
      LEFT JOIN clients ON subscriptions.client_id = clients.id AND clients.company_id = subscriptions.company_id
      LEFT JOIN workers ON subscriptions.worker_id = workers.id AND workers.company_id = subscriptions.company_id
      WHERE subscriptions.company_id = $1
      ORDER BY subscriptions.id DESC
      LIMIT $2 OFFSET $3
    `, [company_id, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.log("GET SUBSCRIPTIONS ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.get("/subscriptions/:id", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureSubscriptionBillingSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;

    const result = await pool.query(`
      SELECT
        subscriptions.*,
        clients.name AS client_name,
        clients.email AS client_email,
        clients.phone AS client_phone,
        clients.address AS client_address,
        workers.name AS worker_name,
        companies.email AS company_email,
        companies.name AS company_name
      FROM subscriptions
      LEFT JOIN clients ON subscriptions.client_id = clients.id AND clients.company_id = subscriptions.company_id
      LEFT JOIN workers ON subscriptions.worker_id = workers.id AND workers.company_id = subscriptions.company_id
      LEFT JOIN companies ON companies.id = subscriptions.company_id
      WHERE subscriptions.id = $1 AND subscriptions.company_id = $2
    `, [id, company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log("GET SUBSCRIPTION ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

async function sendSubscriptionReminderEmailMutation(req, res) {
  try {
    await ensureSubscriptionBillingSchema();
    const company_id = req.user.company_id;
    const id = req.params.id;

    const result = await pool.query(`
      SELECT
        subscriptions.*,
        clients.name AS client_name,
        clients.email AS client_email,
        companies.email AS company_email,
        companies.name AS company_name
      FROM subscriptions
      LEFT JOIN clients ON subscriptions.client_id = clients.id AND clients.company_id = subscriptions.company_id
      LEFT JOIN companies ON companies.id = subscriptions.company_id
      WHERE subscriptions.id = $1 AND subscriptions.company_id = $2
      LIMIT 1
    `, [id, company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const sub = result.rows[0];
    const payload = buildSubscriptionReminderPayload({
      clientEmail: sub.client_email,
      companyEmail: sub.company_email,
      clientName: sub.client_name,
      service: sub.service,
      nextDate: sub.next_date,
      companyName: sub.company_name,
      overrideTo: req.body && req.body.to
    });

    if (!payload) {
      return res.status(400).json({
        error: "No recipient email — add a client email or company email, or pass `to` in the request body."
      });
    }

    try {
      await enqueueEmailTask(payload);
    } catch (qErr) {
      logger.warn("SUBSCRIPTION_REMINDER_ENQUEUE_FAILED", { error: qErr && qErr.message });
      return res.status(503).json({ error: "Mail queue unavailable. Try again shortly." });
    }

    try {
      await createNotification({
        companyId: company_id,
        userId: null,
        type: "subscription_warning",
        title: "Subscription reminder sent",
        message: `Reminder queued for ${sub.client_name || "client"} — ${sub.service || "subscription"}.`,
        metadata: { subscription_id: Number(sub.id) }
      });
    } catch (notifErr) {
      logger.warn("SUBSCRIPTION_WARNING_NOTIFICATION_FAILED", { error: notifErr && notifErr.message });
    }

    res.json({ queued: true, to: payload.to });
  } catch (err) {
    console.log("SUBSCRIPTION REMINDER EMAIL ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
}

router.post("/subscriptions/:id/send-reminder-email", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), sendSubscriptionReminderEmailMutation);
router.post("/ops/subscriptions/:id/send-reminder-email", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), sendSubscriptionReminderEmailMutation);

router.put("/subscriptions/:id", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  const client = await pool.connect();

  try {
    await ensureSubscriptionBillingSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;
    const {
      client_id,
      service,
      frequency,
      start_date,
      next_date,
      price,
      worker_id,
      status,
      rebuild_future_jobs
    } = req.body;

    const allowedStatuses = [
      "draft",
      "active",
      "paused",
      "cancelled",
      "completed",
      "expired"
    ];

    const allowedFrequencies = ["weekly", "biweekly", "monthly"];

    if (!client_id || !service || !frequency || !start_date || !next_date || status === undefined) {
      return res.status(400).json({ error: "Missing data" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid subscription status" });
    }

    if (!allowedFrequencies.includes(frequency)) {
      return res.status(400).json({ error: "Invalid frequency" });
    }

    const clientLookup = await client.query(
      "SELECT id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1",
      [client_id, company_id]
    );

    if (clientLookup.rows.length === 0) {
      return res.status(400).json({ error: "Client not found in this company" });
    }

    const workerLookup = await resolveCompanyWorkerId(company_id, worker_id, client);
    if (!workerLookup.ok) {
      return res.status(400).json({ error: "Worker not found in this company" });
    }

    await client.query("BEGIN");

    const existing = await client.query(`
      SELECT *
      FROM subscriptions
      WHERE id = $1 AND company_id = $2
    `, [id, company_id]);

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Subscription not found" });
    }

    const updated = await client.query(`
      UPDATE subscriptions
      SET
        client_id = $1,
        service = $2,
        frequency = $3,
        start_date = $4,
        next_date = $5,
        price = $6,
        worker_id = $7,
        status = $8,
        next_billing_date = COALESCE(next_billing_date, $5)
      WHERE id = $9 AND company_id = $10
      RETURNING *
    `, [
      client_id,
      service,
      frequency,
      start_date,
      next_date,
      price || 0,
      workerLookup.workerId,
      status,
      id,
      company_id
    ]);

    if (rebuild_future_jobs) {
      await client.query(`
        UPDATE jobs
        SET status = 'cancelled',
            status_reason = COALESCE(NULLIF(status_reason, ''), 'Subscription schedule rebuilt; previous visit cancelled.')
        WHERE source_subscription_id = $1
          AND company_id = $2
          AND type = 'subscription_visit'
          AND status = 'scheduled'
          AND date >= CURRENT_DATE
      `, [id, company_id]);

      const scheduleBaseDate = next_date || start_date;
      const visitDates = buildSubscriptionVisitDates(scheduleBaseDate, frequency, 8);

      for (const visitDate of visitDates) {
        await client.query(`
          INSERT INTO jobs
          (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
          SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
          WHERE NOT EXISTS (
            SELECT 1
            FROM jobs
            WHERE source_subscription_id = $6
              AND date = $3
              AND type = 'subscription_visit'
              AND company_id = $5
          )
        `, [
          client_id,
          service,
          visitDate,
          workerLookup.workerId,
          company_id,
          id
        ]);
      }
    }

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("UPDATE SUBSCRIPTION ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  } finally {
    client.release();
  }
});

router.put("/subscriptions/:id/status", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/subscriptions/:id/status", "/ops/subscriptions/:id/status");
    await ensureSubscriptionBillingSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;
    const { status, pause_reason, cancel_reason } = req.body;

    const allowedStatuses = [
      "draft",
      "active",
      "paused",
      "cancelled",
      "completed",
      "expired"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid subscription status" });
    }

    const sub = await pool.query(`
      SELECT *
      FROM subscriptions
      WHERE id = $1 AND company_id = $2
    `, [id, company_id]);

    if (sub.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const current = sub.rows[0];

    const result = await pool.query(`
      UPDATE subscriptions
      SET
        status = $1,
        pause_reason = COALESCE($2, pause_reason),
        cancel_reason = COALESCE($3, cancel_reason)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [
      status,
      pause_reason || null,
      cancel_reason || null,
      id,
      company_id
    ]);

    if (["paused", "cancelled", "completed", "expired"].includes(status)) {
      await pool.query(`
        UPDATE jobs
        SET status = 'cancelled',
            status_reason = COALESCE(NULLIF(status_reason, ''), 'Subscription status changed; visit cancelled.')
        WHERE source_subscription_id = $1
          AND company_id = $2
          AND type = 'subscription_visit'
          AND status = 'scheduled'
          AND date >= CURRENT_DATE
      `, [id, company_id]);
    }

    if (status === "active" && current.next_date) {
      const visitDates = buildSubscriptionVisitDates(current.next_date, current.frequency || "weekly", 8);

      for (const visitDate of visitDates) {
        const exists = await pool.query(`
          SELECT id FROM jobs
          WHERE source_subscription_id = $1
            AND company_id = $2
            AND type = 'subscription_visit'
            AND date = $3
        `, [id, company_id, visitDate]);

        if (exists.rows.length === 0) {
          await pool.query(`
            INSERT INTO jobs
            (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
            SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
            WHERE NOT EXISTS (
              SELECT 1
              FROM jobs
              WHERE source_subscription_id = $6
                AND date = $3
                AND type = 'subscription_visit'
                AND company_id = $5
            )
          `, [
            current.client_id,
            current.service,
            visitDate,
            current.worker_id || null,
            company_id,
            id
          ]);
        }
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log("UPDATE SUBSCRIPTION STATUS ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.put("/subscriptions/:id/mark-paid", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/subscriptions/:id/mark-paid", "/ops/subscriptions/:id/mark-paid");
    await ensureSubscriptionBillingSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;
    const billedMonth = new Date().toISOString().slice(0, 7);
    const method = normalizePaymentMethod(req.body && req.body.method);
    const notes = (req.body && req.body.notes) || "";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const subResult = await client.query(`
        SELECT subscriptions.*, clients.name AS client_name
        FROM subscriptions
        LEFT JOIN clients ON clients.id = subscriptions.client_id AND clients.company_id = subscriptions.company_id
        WHERE subscriptions.id = $1 AND subscriptions.company_id = $2
        FOR UPDATE
        LIMIT 1
      `, [id, company_id]);

      if (subResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Subscription not found" });
      }

      const subscription = subResult.rows[0];
      const existingBilling = await client.query(`
        SELECT *
        FROM subscription_billings
        WHERE subscription_id = $1
          AND company_id = $2
          AND billing_month = $3
        ORDER BY id DESC
        LIMIT 1
      `, [id, company_id, billedMonth]);

      let invoiceId = existingBilling.rows[0] ? existingBilling.rows[0].invoice_id : null;
      let invoiceAmount = Number(subscription.price || 0);
      let invoiceNumber = null;

      if (!Number.isFinite(invoiceAmount) || invoiceAmount < 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Subscription price cannot be negative" });
      }

      if (!invoiceId) {
        invoiceNumber = await nextInvoiceNumber(company_id, client);
        const invoiceInsert = await client.query(`
          INSERT INTO invoices
          (company_id, client_id, source_subscription_id, source_type, invoice_number, status, issued_date, due_date, subtotal, amount, notes, line_items)
          VALUES ($1,$2,$3,'subscription',$4,'unpaid',CURRENT_DATE,CURRENT_DATE,$5,$6,$7,$8::jsonb)
          RETURNING *
        `, [
          company_id,
          subscription.client_id,
          id,
          invoiceNumber,
          invoiceAmount,
          invoiceAmount,
          `Subscription billing for ${subscription.service || "service"} (${billedMonth})`,
          JSON.stringify([{
            description: `${subscription.service || "Subscription service"} - ${billedMonth}`,
            quantity: 1,
            price: invoiceAmount,
            amount: invoiceAmount
          }])
        ]);
        invoiceId = invoiceInsert.rows[0].id;
      }

      await client.query(
        `
        SELECT id
        FROM invoices
        WHERE id = $1 AND company_id = $2
        LIMIT 1
        FOR UPDATE
        `,
        [invoiceId, company_id]
      );
      const alreadyPaid = await getNetPaidForInvoice(client, company_id, invoiceId);
      const remaining = Number(Math.max(invoiceAmount - alreadyPaid, 0).toFixed(2));

      if (remaining > 0) {
        await assertPaymentWithinRemaining({
          companyId: company_id,
          invoiceId,
          proposedPaymentAmount: remaining,
          invoiceTotalAmount: invoiceAmount,
          client
        });
        const paymentInsert = await client.query(`
          INSERT INTO payments (invoice_id, amount, method, date, notes, company_id)
          VALUES ($1,$2,$3,CURRENT_DATE,$4,$5)
          RETURNING *
        `, [
          invoiceId,
          remaining,
          method,
          notes || `Subscription payment for ${billedMonth}`,
          company_id
        ]);

        await appendPaymentLedgerEntry(client, {
          company_id,
          event_type: "payment_received",
          invoice_id: Number(invoiceId),
          payment_id: paymentInsert.rows[0].id,
          amount: remaining,
          metadata: {
            method,
            source: "subscription_mark_paid",
            billing_month: billedMonth
          },
          created_by: req.user.id
        });
      }

      await client.query(`
        INSERT INTO subscription_billings
        (subscription_id, invoice_id, billing_month, billing_date, amount, status, notes, company_id)
        VALUES ($1,$2,$3,CURRENT_DATE,$4,'paid',$5,$6)
        ON CONFLICT (company_id, subscription_id, billing_month)
        DO UPDATE SET
          invoice_id = COALESCE(subscription_billings.invoice_id, EXCLUDED.invoice_id),
          amount = EXCLUDED.amount,
          status = 'paid',
          notes = CASE
            WHEN COALESCE(NULLIF(EXCLUDED.notes, ''), '') = '' THEN subscription_billings.notes
            ELSE EXCLUDED.notes
          END,
          billing_date = EXCLUDED.billing_date
      `, [id, invoiceId, billedMonth, invoiceAmount, notes || "", company_id]);

      await client.query(`
        UPDATE invoices
        SET status = 'paid',
            paid_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND company_id = $2
      `, [invoiceId, company_id]);

      const nextBillingDate = (() => {
        const current = new Date(`${subscription.next_billing_date || subscription.next_date || new Date().toISOString().split("T")[0]}T00:00:00Z`);

        if (subscription.frequency === "weekly") {
          current.setUTCDate(current.getUTCDate() + 7);
        } else if (subscription.frequency === "biweekly") {
          current.setUTCDate(current.getUTCDate() + 14);
        } else {
          current.setUTCMonth(current.getUTCMonth() + 1);
        }

        return current.toISOString().split("T")[0];
      })();
      const updatedSub = await client.query(`
        UPDATE subscriptions
        SET
          last_billed_month = $1,
          last_billed_at = CURRENT_DATE,
          last_billed_date = CURRENT_DATE,
          next_billing_date = $2
        WHERE id = $3 AND company_id = $4
        RETURNING *
      `, [billedMonth, nextBillingDate, id, company_id]);

      await client.query("COMMIT");
      await logActivity({
        companyId: company_id,
        userId: req.user.id,
        action: "subscription_billing_paid",
        entityType: "subscription",
        entityId: Number(id),
        details: {
          billing_month: billedMonth,
          invoice_id: invoiceId,
          amount: invoiceAmount,
          method
        }
      });

      await logActivity({
        companyId: company_id,
        userId: req.user.id,
        action: "payment_recorded",
        entityType: "invoice",
        entityId: Number(invoiceId),
        details: {
          invoice_id: invoiceId,
          subscription_id: Number(id),
          amount: invoiceAmount,
          method
        }
      });

      res.json({
        subscription: updatedSub.rows[0],
        invoice_id: invoiceId,
        billing_month: billedMonth,
        amount: invoiceAmount,
        method
      });
    } catch (transactionErr) {
      await client.query("ROLLBACK");
      throw transactionErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.log("MARK SUBSCRIPTION PAID ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.delete("/subscriptions/:id", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid subscription id" });
    }

    const company_id = req.user.company_id;

    const result = await pool.query(
      "UPDATE subscriptions SET status='cancelled' WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, company_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE SUB ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.delete("/ops/subscriptions/:id/permanent", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("owner"), async (req, res) => {
  try {
    await ensureSubscriptionBillingSchema();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid subscription id" });
    }

    const company_id = req.user.company_id;

    const existing = await pool.query(
      "SELECT id, service, client_id FROM subscriptions WHERE id=$1 AND company_id=$2 LIMIT 1",
      [id, company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const linked = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM jobs WHERE source_subscription_id=$1 AND company_id=$2 LIMIT 1) AS has_jobs,
        EXISTS (SELECT 1 FROM invoices WHERE source_subscription_id=$1 AND company_id=$2 LIMIT 1) AS has_invoices,
        EXISTS (SELECT 1 FROM subscription_billings WHERE subscription_id=$1 AND company_id=$2 LIMIT 1) AS has_billings
    `, [id, company_id]);

    const row = linked.rows[0] || {};
    if (row.has_jobs || row.has_invoices || row.has_billings) {
      const cancelled = await pool.query(
        "UPDATE subscriptions SET status='cancelled' WHERE id=$1 AND company_id=$2",
        [id, company_id]
      );
      if (!cancelled.rowCount) {
        return res.status(404).json({ error: "Not found" });
      }

      await logActivity({
        companyId: company_id,
        userId: req.user.id,
        action: "subscription_cancelled",
        entityType: "subscription",
        entityId: Number(id),
        details: {
          client_id: existing.rows[0].client_id,
          service: existing.rows[0].service,
          reason: "linked_records"
        }
      });

      return res.json({
        success: true,
        message: "Cancelled.",
        notice: "Subscription has linked records. Cancel instead."
      });
    }

    const deleted = await pool.query(
      "DELETE FROM subscriptions WHERE id=$1 AND company_id=$2",
      [id, company_id]
    );

    if (!deleted.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "subscription_permanent_deleted",
      entityType: "subscription",
      entityId: Number(id),
      details: {
        client_id: existing.rows[0].client_id,
        service: existing.rows[0].service,
        permanent: true
      }
    });

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log("PERMANENT DELETE SUBSCRIPTION ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});


router.get("/ops/subscriptions", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(`
      SELECT
        subscriptions.*,
        clients.name AS client_name,
        clients.zip AS client_zip,
        workers.name AS worker_name,
        (
          SELECT COUNT(*)
          FROM jobs
          WHERE jobs.source_subscription_id = subscriptions.id
            AND jobs.company_id = subscriptions.company_id
            AND jobs.date >= CURRENT_DATE
        ) AS upcoming_visit_count,
        (
          SELECT MIN(jobs.date)
          FROM jobs
          WHERE jobs.source_subscription_id = subscriptions.id
            AND jobs.company_id = subscriptions.company_id
            AND jobs.date >= CURRENT_DATE
        ) AS next_upcoming_visit,
        (
          SELECT COUNT(*)
          FROM subscription_billings
          WHERE subscription_billings.subscription_id = subscriptions.id
            AND subscription_billings.company_id = subscriptions.company_id
        ) AS billing_history_count,
        (
          SELECT MAX(subscription_billings.billing_date)
          FROM subscription_billings
          WHERE subscription_billings.subscription_id = subscriptions.id
            AND subscription_billings.company_id = subscriptions.company_id
        ) AS last_billing_date,
        (
          SELECT invoices.invoice_number
          FROM subscription_billings
          LEFT JOIN invoices ON invoices.id = subscription_billings.invoice_id AND invoices.company_id = subscription_billings.company_id
          WHERE subscription_billings.subscription_id = subscriptions.id
            AND subscription_billings.company_id = subscriptions.company_id
          ORDER BY subscription_billings.billing_date DESC, subscription_billings.id DESC
          LIMIT 1
        ) AS latest_invoice_number
      FROM subscriptions
      LEFT JOIN clients ON clients.id = subscriptions.client_id AND clients.company_id = subscriptions.company_id
      LEFT JOIN workers ON workers.id = subscriptions.worker_id AND workers.company_id = subscriptions.company_id
      WHERE subscriptions.company_id = $1
      ORDER BY subscriptions.next_date ASC NULLS LAST, subscriptions.id DESC
      LIMIT $2 OFFSET $3
    `, [req.user.company_id, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.log("OPS SUBSCRIPTIONS ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.post("/ops/subscriptions", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const {
      client_id,
      service,
      frequency,
      next_date,
      price,
      worker_id
    } = req.body;

    if (!client_id || !service || !frequency || !next_date) {
      return res.status(400).json({ error: "Missing data" });
    }

    const client = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [client_id, req.user.company_id]
    );

    if (client.rows.length === 0) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    const workerLookup = await resolveCompanyWorkerId(req.user.company_id, worker_id);
    if (!workerLookup.ok) {
      return res.status(400).json({ error: "Worker not found in this company" });
    }

    const result = await pool.query(`
      INSERT INTO subscriptions
      (client_id, service, frequency, next_date, price, worker_id, status, company_id, start_date, next_billing_date)
      VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)
      RETURNING *
    `, [
      client_id,
      service,
      frequency,
      next_date,
      price || 0,
      workerLookup.workerId,
      req.user.company_id,
      next_date,
      next_date
    ]);

    const createdSubscription = result.rows[0];

    const visitDates = buildUpcomingSubscriptionDates(next_date, frequency);

    for (const visitDate of visitDates) {
      const existingJob = await pool.query(`
        SELECT id
        FROM jobs
        WHERE source_subscription_id = $1
          AND date = $2
          AND type = 'subscription_visit'
          AND company_id = $3
        LIMIT 1
      `, [createdSubscription.id, visitDate, req.user.company_id]);

      if (existingJob.rows.length === 0) {
        await pool.query(`
          INSERT INTO jobs
          (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
          SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
          WHERE NOT EXISTS (
            SELECT 1
            FROM jobs
            WHERE source_subscription_id = $6
              AND date = $3
              AND type = 'subscription_visit'
              AND company_id = $5
          )
        `, [
          client_id,
          service,
          visitDate,
          workerLookup.workerId,
          req.user.company_id,
          createdSubscription.id
        ]);
      }
    }

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "subscription_created",
      entityType: "subscription",
      entityId: createdSubscription.id,
      details: {
        client_id,
        service,
        frequency,
        price: Number(createdSubscription.price || 0)
      }
    });

    res.json(createdSubscription);
  } catch (err) {
    console.log("OPS CREATE SUBSCRIPTION ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.put("/ops/subscriptions/:id", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const {
      client_id,
      service,
      frequency,
      start_date,
      next_date,
      price,
      worker_id,
      status,
      pause_reason,
      cancel_reason
    } = req.body;

    if (client_id !== undefined && client_id !== null) {
      const clientLookup = await pool.query(
        "SELECT id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1",
        [client_id, req.user.company_id]
      );

      if (clientLookup.rows.length === 0) {
        return res.status(400).json({ error: "Client not found in this company" });
      }
    }

    const allowedFrequencies = ["weekly", "biweekly", "monthly"];
    const allowedStatuses = ["active", "paused", "cancelled"];

    if (frequency !== undefined && frequency !== null && !allowedFrequencies.includes(frequency)) {
      return res.status(400).json({ error: "Invalid frequency" });
    }

    if (status !== undefined && status !== null && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const existing = await pool.query(
      "SELECT * FROM subscriptions WHERE id=$1 AND company_id=$2 LIMIT 1",
      [req.params.id, req.user.company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const updates = [];
    const values = [];
    const addUpdate = (column, value) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };

    if (client_id !== undefined) addUpdate("client_id", client_id);
    if (service !== undefined) addUpdate("service", service || "");
    if (frequency !== undefined) addUpdate("frequency", frequency);
    if (start_date !== undefined) addUpdate("start_date", start_date || null);
    if (next_date !== undefined) addUpdate("next_date", next_date || null);
    if (price !== undefined) addUpdate("price", price || 0);
    if (hasBodyField(req, "worker_id")) {
      const workerLookup = await resolveCompanyWorkerId(req.user.company_id, worker_id);
      if (!workerLookup.ok) {
        return res.status(400).json({ error: "Worker not found in this company" });
      }
      addUpdate("worker_id", workerLookup.workerId);
    }
    if (status !== undefined) addUpdate("status", status);
    if (pause_reason !== undefined) addUpdate("pause_reason", pause_reason || "");
    if (cancel_reason !== undefined) addUpdate("cancel_reason", cancel_reason || "");

    if (updates.length === 0) {
      return res.json(existing.rows[0]);
    }

    values.push(req.params.id, req.user.company_id);
    const result = await pool.query(`
      UPDATE subscriptions
      SET ${updates.join(", ")}
      WHERE id = $${values.length - 1}
        AND company_id = $${values.length}
      RETURNING *
    `, values);

    res.json(result.rows[0]);
  } catch (err) {
    console.log("OPS UPDATE SUBSCRIPTION ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.put("/ops/subscriptions/:id/status", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const { status, pause_reason, cancel_reason } = req.body;
    const allowedStatuses = ["active", "paused", "cancelled"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const before = await pool.query(`
      SELECT id, status, pause_reason, cancel_reason
      FROM subscriptions
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [req.params.id, req.user.company_id]);

    if (before.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const result = await pool.query(`
      UPDATE subscriptions
      SET
        status = $1,
        pause_reason = CASE WHEN $1 = 'paused' THEN $2 ELSE pause_reason END,
        cancel_reason = CASE WHEN $1 = 'cancelled' THEN $3 ELSE cancel_reason END
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [
      status,
      pause_reason || "",
      cancel_reason || "",
      req.params.id,
      req.user.company_id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const current = result.rows[0];
    if (status === "active" && current.next_date) {
      const visitDates = buildUpcomingSubscriptionDates(current.next_date, current.frequency || "weekly");

      for (const visitDate of visitDates) {
        const exists = await pool.query(`
          SELECT id FROM jobs
          WHERE source_subscription_id = $1
            AND company_id = $2
            AND type = 'subscription_visit'
            AND date = $3
        `, [current.id, req.user.company_id, visitDate]);

        if (exists.rows.length === 0) {
          await pool.query(`
            INSERT INTO jobs
            (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
            SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
            WHERE NOT EXISTS (
              SELECT 1
              FROM jobs
              WHERE source_subscription_id = $6
                AND date = $3
                AND type = 'subscription_visit'
                AND company_id = $5
            )
          `, [
            current.client_id,
            current.service,
            visitDate,
            current.worker_id || null,
            req.user.company_id,
            current.id
          ]);
        }
      }

    }
    await logChange({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: `subscription_${status}`,
      entityType: "subscription",
      entityId: Number(req.params.id),
      before: {
        status: before.rows[0].status,
        pause_reason: before.rows[0].pause_reason,
        cancel_reason: before.rows[0].cancel_reason
      },
      after: {
        status: result.rows[0].status,
        pause_reason: result.rows[0].pause_reason,
        cancel_reason: result.rows[0].cancel_reason
      },
      metadata: {
        requested_status: status
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("OPS SUBSCRIPTION STATUS ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});

router.put("/ops/subscriptions/:id/mark-paid", auth, billingLifecycleAuditOnlyMiddleware, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const companyId = req.user.company_id;
    const subscriptionId = Number(req.params.id);
    const { method = "cash", notes = "" } = req.body;
    const tx = await pool.connect();
    let invoiceId = null;
    let billingMonth = "";

    try {
      await tx.query("BEGIN");
      const subscriptionResult = await tx.query(`
        SELECT
          subscriptions.*,
          clients.name AS client_name
        FROM subscriptions
        LEFT JOIN clients ON clients.id = subscriptions.client_id AND clients.company_id = subscriptions.company_id
        WHERE subscriptions.id = $1 AND subscriptions.company_id = $2
        FOR UPDATE
        LIMIT 1
      `, [subscriptionId, companyId]);

      if (subscriptionResult.rows.length === 0) {
        await tx.query("ROLLBACK");
        return res.status(404).json({ error: "Subscription not found" });
      }

      const subscription = subscriptionResult.rows[0];
      const invoiceTotal = Number(subscription.price || 0);
      if (!Number.isFinite(invoiceTotal) || invoiceTotal < 0) {
        await tx.query("ROLLBACK");
        return res.status(400).json({ error: "Subscription price cannot be negative" });
      }

      const billingDate = normalizeDateOnly(subscription.next_billing_date || subscription.next_date || new Date().toISOString());
      billingMonth = billingDate.slice(0, 7);

      const existingBilling = await tx.query(`
        SELECT *
        FROM subscription_billings
        WHERE subscription_id = $1
          AND company_id = $2
          AND billing_month = $3
        ORDER BY id DESC
        LIMIT 1
      `, [subscriptionId, companyId, billingMonth]);

      invoiceId = existingBilling.rows[0] && existingBilling.rows[0].invoice_id ? existingBilling.rows[0].invoice_id : null;

      if (!invoiceId) {
        const invoiceNumber = await nextInvoiceNumber(companyId, tx);
        const invoiceInsert = await tx.query(`
          INSERT INTO invoices
          (company_id, client_id, source_subscription_id, source_type, invoice_number, status, issued_date, due_date, subtotal, amount, notes, line_items)
          VALUES ($1,$2,$3,'subscription',$4,'unpaid',$5,$5,$6,$6,$7,$8::jsonb)
          RETURNING *
        `, [
          companyId,
          subscription.client_id,
          subscriptionId,
          invoiceNumber,
          billingDate,
          invoiceTotal,
          notes || "",
          JSON.stringify([{
            description: subscription.service || "Subscription billing",
            quantity: 1,
            price: invoiceTotal,
            amount: invoiceTotal
          }])
        ]);
        invoiceId = invoiceInsert.rows[0].id;
      }

      const alreadyPaid = await getNetPaidForInvoice(tx, companyId, invoiceId);
      const paymentAmount = Number(Math.max(invoiceTotal - alreadyPaid, 0).toFixed(2));
      if (paymentAmount > 0) {
        await assertPaymentWithinRemaining({
          companyId,
          invoiceId,
          proposedPaymentAmount: paymentAmount,
          invoiceTotalAmount: invoiceTotal,
          client: tx
        });
        const paymentInsert = await tx.query(`
          INSERT INTO payments (invoice_id, amount, method, date, notes, company_id)
          VALUES ($1,$2,$3,$4,$5,$6)
          RETURNING *
        `, [
          invoiceId,
          paymentAmount,
          normalizePaymentMethod(method),
          billingDate,
          notes || "",
          companyId
        ]);
        await appendPaymentLedgerEntry(tx, {
          company_id: companyId,
          event_type: "payment_received",
          invoice_id: Number(invoiceId),
          payment_id: paymentInsert.rows[0].id,
          amount: paymentAmount,
          metadata: {
            source: "ops_subscription_mark_paid",
            billing_month: billingMonth,
            method: normalizePaymentMethod(method)
          },
          created_by: req.user.id
        });
      }

      await tx.query(`
        UPDATE invoices
        SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)
        WHERE id = $1 AND company_id = $2
      `, [invoiceId, companyId]);

      await tx.query(`
        INSERT INTO subscription_billings
        (subscription_id, invoice_id, billing_month, billing_date, amount, status, notes, company_id)
        VALUES ($1,$2,$3,$4,$5,'paid',$6,$7)
        ON CONFLICT (company_id, subscription_id, billing_month)
        DO UPDATE SET
          invoice_id = COALESCE(subscription_billings.invoice_id, EXCLUDED.invoice_id),
          amount = EXCLUDED.amount,
          status = 'paid',
          notes = CASE
            WHEN COALESCE(NULLIF(EXCLUDED.notes, ''), '') = '' THEN subscription_billings.notes
            ELSE EXCLUDED.notes
          END,
          billing_date = EXCLUDED.billing_date
      `, [
        subscriptionId,
        invoiceId,
        billingMonth,
        billingDate,
        invoiceTotal,
        notes || "",
        companyId
      ]);

      const nextBillingDate = (() => {
        const current = new Date(`${billingDate}T00:00:00Z`);
        if (subscription.frequency === "weekly") {
          current.setUTCDate(current.getUTCDate() + 7);
        } else if (subscription.frequency === "biweekly") {
          current.setUTCDate(current.getUTCDate() + 14);
        } else {
          current.setUTCMonth(current.getUTCMonth() + 1);
        }
        return current.toISOString().split("T")[0];
      })();

      await tx.query(`
        UPDATE subscriptions
        SET
          last_billed_month = $1,
          last_billed_at = $2,
          last_billed_date = $2,
          next_billing_date = $3
        WHERE id = $4 AND company_id = $5
      `, [billingMonth, billingDate, nextBillingDate, subscriptionId, companyId]);
      await tx.query("COMMIT");
    } catch (transactionErr) {
      await tx.query("ROLLBACK");
      throw transactionErr;
    } finally {
      tx.release();
    }

    await logActivity({
      companyId,
      userId: req.user.id,
      action: "subscription_billed",
      entityType: "subscription",
      entityId: subscriptionId,
      details: {
        subscription_id: subscriptionId,
        invoice_id: invoiceId,
        billing_month: billingMonth,
        amount: invoiceTotal,
        method
      }
    });

    res.json({
      success: true,
      invoice_id: invoiceId,
      subscription_id: subscriptionId
    });
  } catch (err) {
    console.log("OPS SUBSCRIPTION MARK PAID ERROR:", err);
    sendSafeServerError(res, err, "routes/subscriptions");
  }
});


module.exports = router;

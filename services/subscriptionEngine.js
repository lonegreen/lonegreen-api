const pool = require("../db/pool");
const logger = require("./logger");
const {
  nextInvoiceNumber,
  normalizeLineItems
} = require("./invoiceService");
const {
  appendPaymentLedgerEntrySafe
} = require("./financialIntegrityService");

const SUBSCRIPTION_ENGINE_LOCK_KEY_1 = 742011;
const SUBSCRIPTION_ENGINE_LOCK_KEY_2 = 202602;

async function suggestWorkerForSubscription(subscription, db = pool) {
  const workerSuggestion = await db.query(`
    SELECT workers.id
    FROM clients
    JOIN zip_codes ON zip_codes.zip = clients.zip AND zip_codes.company_id = clients.company_id
    JOIN worker_zip_groups ON worker_zip_groups.group_id = zip_codes.group_id AND worker_zip_groups.company_id = clients.company_id
    JOIN workers ON workers.id = worker_zip_groups.worker_id AND workers.company_id = clients.company_id
    WHERE clients.id = $1
      AND clients.company_id = $2
      AND COALESCE(workers.active, TRUE) = TRUE
    ORDER BY workers.name ASC
    LIMIT 1
  `, [subscription.client_id, subscription.company_id]);

  return workerSuggestion.rows[0] ? workerSuggestion.rows[0].id : null;
}

function advanceSubscriptionDate(date, frequency) {
  if (frequency === "weekly") {
    date.setDate(date.getDate() + 7);
    return;
  }

  if (frequency === "biweekly") {
    date.setDate(date.getDate() + 14);
    return;
  }

  date.setMonth(date.getMonth() + 1);
}

function dateOnly(value) {
  if (!value) return new Date().toISOString().split("T")[0];
  if (value instanceof Date) return value.toISOString().split("T")[0];
  return String(value).split("T")[0];
}

function billingMonthForDate(value) {
  return dateOnly(value).slice(0, 7);
}

function advanceBillingDate(dateText, frequency) {
  const billingDate = dateOnly(dateText);
  const currentMonth = billingMonthForDate(billingDate);
  const current = new Date(`${billingDate}T00:00:00Z`);

  do {
    advanceSubscriptionDate(current, frequency);
  } while (current.toISOString().slice(0, 7) === currentMonth);

  return current.toISOString().split("T")[0];
}

async function findExistingSubscriptionInvoice(db, companyId, subscriptionId, billingMonth) {
  const monthStart = `${billingMonth}-01`;
  const monthEndDate = new Date(`${monthStart}T00:00:00Z`);
  monthEndDate.setUTCMonth(monthEndDate.getUTCMonth() + 1);
  const monthEnd = monthEndDate.toISOString().split("T")[0];

  const result = await db.query(
    `
    SELECT id
    FROM invoices
    WHERE company_id = $1
      AND source_subscription_id = $2
      AND status <> 'cancelled'
      AND COALESCE(due_date, issued_date, created_at::date) >= $3::date
      AND COALESCE(due_date, issued_date, created_at::date) < $4::date
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [companyId, subscriptionId, monthStart, monthEnd]
  );

  return result.rows[0] ? Number(result.rows[0].id) : null;
}

async function createSubscriptionBillingInvoiceInTransaction(db, {
  companyId,
  subscriptionId,
  billingDate,
  notes = "",
  status = "generated",
  createdBy = null,
  source = "subscription_scheduler"
}) {
  const subResult = await db.query(
    `
    SELECT *
    FROM subscriptions
    WHERE id = $1
      AND company_id = $2
    LIMIT 1
    FOR UPDATE
    `,
    [subscriptionId, companyId]
  );

  if (!subResult.rows.length) {
    const err = new Error("Subscription not found");
    err.code = "SUBSCRIPTION_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const subscription = subResult.rows[0];
  const subscriptionStatus = String(subscription.status || "").trim().toLowerCase();
  if (subscriptionStatus !== "active") {
    return {
      skipped: true,
      reason: "subscription_not_active",
      subscription
    };
  }

  const resolvedBillingDate = dateOnly(
    billingDate
    || subscription.next_billing_date
    || subscription.next_date
    || new Date()
  );
  const billingMonth = billingMonthForDate(resolvedBillingDate);
  const amount = Number(subscription.price || 0);

  if (!Number.isFinite(amount) || amount < 0) {
    const err = new Error("Subscription price cannot be negative");
    err.code = "SUBSCRIPTION_PRICE_INVALID";
    err.statusCode = 400;
    throw err;
  }

  const existingBilling = await db.query(
    `
    SELECT *
    FROM subscription_billings
    WHERE company_id = $1
      AND subscription_id = $2
      AND billing_month = $3
    LIMIT 1
    FOR UPDATE
    `,
    [companyId, subscriptionId, billingMonth]
  );

  let billingRow = existingBilling.rows[0] || null;
  let invoiceId = billingRow && billingRow.invoice_id ? Number(billingRow.invoice_id) : null;
  let createdInvoice = false;
  let createdBilling = false;

  if (!invoiceId) {
    invoiceId = await findExistingSubscriptionInvoice(db, companyId, subscriptionId, billingMonth);
  }

  if (!billingRow) {
    const insertedBilling = await db.query(
      `
      INSERT INTO subscription_billings
        (subscription_id, invoice_id, billing_month, billing_date, amount, status, notes, company_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (company_id, subscription_id, billing_month)
      DO NOTHING
      RETURNING *
      `,
      [
        subscriptionId,
        invoiceId,
        billingMonth,
        resolvedBillingDate,
        amount,
        status,
        notes || "",
        companyId
      ]
    );

    if (!insertedBilling.rows.length) {
      const concurrentBilling = await db.query(
        `
        SELECT *
        FROM subscription_billings
        WHERE company_id = $1
          AND subscription_id = $2
          AND billing_month = $3
        LIMIT 1
        FOR UPDATE
        `,
        [companyId, subscriptionId, billingMonth]
      );
      billingRow = concurrentBilling.rows[0] || null;
      invoiceId = billingRow && billingRow.invoice_id ? Number(billingRow.invoice_id) : invoiceId;
    } else {
      billingRow = insertedBilling.rows[0];
      createdBilling = true;
    }
  }

  if (!invoiceId) {
    const invoiceNumber = await nextInvoiceNumber(companyId, db);
    const description = `${subscription.service || "Subscription billing"} - ${billingMonth}`;
    const normalizedInvoice = normalizeLineItems([], amount, description);

    const invoiceInsert = await db.query(
      `
      INSERT INTO invoices
        (company_id, client_id, source_subscription_id, source_type, invoice_number, status, issued_date, due_date, subtotal, amount, notes, line_items)
      VALUES
        ($1, $2, $3, 'subscription', $4, 'unpaid', $5, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
      `,
      [
        companyId,
        subscription.client_id,
        subscriptionId,
        invoiceNumber,
        resolvedBillingDate,
        normalizedInvoice.subtotal,
        normalizedInvoice.total,
        notes || `Subscription billing for ${subscription.service || "service"} (${billingMonth})`,
        JSON.stringify(normalizedInvoice.line_items)
      ]
    );

    invoiceId = Number(invoiceInsert.rows[0].id);
    createdInvoice = true;

    await appendPaymentLedgerEntrySafe(db, {
      company_id: companyId,
      event_type: "invoice_created",
      invoice_id: invoiceId,
      amount: normalizedInvoice.total,
      metadata: {
        source,
        subscription_id: Number(subscriptionId),
        billing_month: billingMonth
      },
      created_by: createdBy
    });
  }

  const billingStatus = status === "paid" ? "paid" : (billingRow && billingRow.status === "paid" ? "paid" : status);
  const updatedBilling = await db.query(
    `
    UPDATE subscription_billings
    SET
      invoice_id = COALESCE(invoice_id, $4),
      amount = $5,
      status = $6,
      notes = CASE
        WHEN COALESCE(NULLIF($7, ''), '') = '' THEN notes
        ELSE $7
      END,
      billing_date = $8
    WHERE company_id = $1
      AND subscription_id = $2
      AND billing_month = $3
    RETURNING *
    `,
    [
      companyId,
      subscriptionId,
      billingMonth,
      invoiceId,
      amount,
      billingStatus,
      notes || "",
      resolvedBillingDate
    ]
  );

  const nextBillingDate = advanceBillingDate(resolvedBillingDate, subscription.frequency);
  const updatedSub = await db.query(
    `
    UPDATE subscriptions
    SET
      last_billed_month = $1,
      last_billed_at = $2,
      last_billed_date = $2,
      next_billing_date = CASE
        WHEN next_billing_date IS NULL OR next_billing_date <= $2::date THEN $3::date
        ELSE next_billing_date
      END
    WHERE id = $4
      AND company_id = $5
    RETURNING *
    `,
    [billingMonth, resolvedBillingDate, nextBillingDate, subscriptionId, companyId]
  );

  return {
    skipped: false,
    subscription: updatedSub.rows[0] || subscription,
    billing: updatedBilling.rows[0] || billingRow,
    invoice_id: invoiceId,
    billing_month: billingMonth,
    billing_date: resolvedBillingDate,
    amount,
    created_invoice: createdInvoice,
    created_billing: createdBilling,
    next_billing_date: nextBillingDate
  };
}

async function createSubscriptionBillingInvoice(options) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await createSubscriptionBillingInvoiceInTransaction(db, options);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function processSubscriptions(options = {}) {
  const client = await pool.connect();
  let lockAcquired = false;
  const startedAt = Date.now();
  const onlySubscriptionId = Number(options && options.subscriptionId);
  const onlyCompanyId = Number(options && options.companyId);
  const scopedSubscriptionId = Number.isInteger(onlySubscriptionId) && onlySubscriptionId > 0 ? onlySubscriptionId : null;
  const scopedCompanyId = Number.isInteger(onlyCompanyId) && onlyCompanyId > 0 ? onlyCompanyId : null;

  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [SUBSCRIPTION_ENGINE_LOCK_KEY_1, SUBSCRIPTION_ENGINE_LOCK_KEY_2]
    );

    lockAcquired = lockResult.rows[0] && lockResult.rows[0].acquired === true;
    if (!lockAcquired) {
      logger.info("SUBSCRIPTION_ENGINE_RUN_SKIPPED", {
        reason: "lock_unavailable",
        duration_ms: Date.now() - startedAt
      });
      return { skipped: true, reason: "lock_unavailable" };
    }

    logger.info("SUBSCRIPTION_ENGINE_RUN_STARTED", {
      lock_acquired: true
    });

    // Tenant-isolation guard: a subscription with NULL/invalid company_id or
    // client_id has no owning tenant and MUST NOT produce subscription_visit
    // jobs. Filtering at the SELECT layer prevents downstream INSERTs from
    // ever materializing a job with company_id = NULL.
    const subs = await client.query(`
      SELECT * FROM subscriptions
      WHERE status = 'active'
        AND company_id IS NOT NULL
        AND client_id IS NOT NULL
        AND ($1::int IS NULL OR id = $1::int)
        AND ($2::int IS NULL OR company_id = $2::int)
    `, [scopedSubscriptionId, scopedCompanyId]);

    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() + 30);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let billingGenerated = 0;
    let billingSkipped = 0;

    for (const subscription of subs.rows) {
      // Defense-in-depth: even after the SELECT-side filter, refuse to act on
      // any subscription row whose company_id failed to resolve to a positive
      // integer. Without a resolved tenant we cannot insert a tenant-scoped
      // job; skipping is strictly safer than producing an orphan visit.
      const subscriptionCompanyId = Number(subscription.company_id);
      if (!Number.isInteger(subscriptionCompanyId) || subscriptionCompanyId <= 0) {
        logger.warn("SUBSCRIPTION_ENGINE_SKIP_MISSING_COMPANY_ID", {
          subscription_id: subscription.id,
          client_id: subscription.client_id,
          raw_company_id: subscription.company_id
        });
        continue;
      }

      const subscriptionClientId = Number(subscription.client_id);
      if (!Number.isInteger(subscriptionClientId) || subscriptionClientId <= 0) {
        logger.warn("SUBSCRIPTION_ENGINE_SKIP_MISSING_CLIENT_ID", {
          subscription_id: subscription.id,
          company_id: subscriptionCompanyId,
          raw_client_id: subscription.client_id
        });
        continue;
      }

      const rawBillingDate = subscription.next_billing_date || subscription.next_date;
      const dueBillingDate = rawBillingDate ? dateOnly(rawBillingDate) : null;
      if (dueBillingDate && dueBillingDate <= today.toISOString().split("T")[0]) {
        try {
          const billingResult = await createSubscriptionBillingInvoice({
            companyId: subscriptionCompanyId,
            subscriptionId: Number(subscription.id),
            billingDate: dueBillingDate,
            status: "generated",
            source: "subscription_scheduler"
          });
          if (billingResult && billingResult.created_invoice) {
            billingGenerated += 1;
            logger.info("SUBSCRIPTION_BILLING_INVOICE_CREATED", {
              company_id: subscriptionCompanyId,
              subscription_id: Number(subscription.id),
              invoice_id: billingResult.invoice_id,
              billing_month: billingResult.billing_month
            });
          } else {
            billingSkipped += 1;
          }
        } catch (billingErr) {
          if (billingErr && billingErr.code === "23505") {
            billingSkipped += 1;
            logger.warn("SUBSCRIPTION_BILLING_DUPLICATE_SKIPPED", {
              company_id: subscriptionCompanyId,
              subscription_id: Number(subscription.id),
              error: billingErr.message
            });
          } else {
            throw billingErr;
          }
        }
      }

      if (!subscription.next_date) continue;

      let currentDate = new Date(subscription.next_date);
      currentDate.setHours(0, 0, 0, 0);

      while (currentDate < today) {
        advanceSubscriptionDate(currentDate, subscription.frequency);
      }

      const nextDateCandidate = new Date(currentDate);
      while (nextDateCandidate <= today) {
        advanceSubscriptionDate(nextDateCandidate, subscription.frequency);
      }
      const nextDateAfterToday = nextDateCandidate.toISOString().split("T")[0];

      while (currentDate <= limitDate) {
        const dateStr = currentDate.toISOString().split("T")[0];

        const exists = await client.query(`
          SELECT id FROM jobs
          WHERE source_subscription_id = $1
            AND date = $2
            AND type = 'subscription_visit'
            AND company_id = $3
        `, [subscription.id, dateStr, subscriptionCompanyId]);

        if (exists.rows.length === 0) {
          const assignedWorkerId = subscription.worker_id || await suggestWorkerForSubscription(subscription, client);

          // SQL-level guard: refuse to materialize a row whose tenant ($5)
          // is NULL or non-positive. The application-side guards above
          // already prevent this; this is the final backstop.
          const inserted = await client.query(`
            INSERT INTO jobs
            (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
            SELECT $1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included'
            WHERE $5 IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM jobs
                WHERE source_subscription_id = $6
                  AND date = $3
                  AND type = 'subscription_visit'
                  AND company_id = $5
              )
            RETURNING id
          `, [
            subscriptionClientId,
            subscription.service,
            dateStr,
            assignedWorkerId,
            subscriptionCompanyId,
            subscription.id
          ]);

          if (inserted.rows.length > 0) {
            logger.info("Subscription visit created", {
              client_id: subscriptionClientId,
              date: dateStr,
              subscription_id: subscription.id,
              company_id: subscriptionCompanyId
            });
          }
        }

        advanceSubscriptionDate(currentDate, subscription.frequency);
      }

      await client.query(`
        UPDATE subscriptions
        SET next_date = $1::date
        WHERE id = $2
          AND company_id = $3
          AND status = 'active'
          AND next_date < $1::date
      `, [nextDateAfterToday, subscription.id, subscriptionCompanyId]);
    }

    logger.info("SUBSCRIPTION_ENGINE_RUN_COMPLETED", {
      processed: subs.rows.length,
      billing_generated: billingGenerated,
      billing_skipped: billingSkipped,
      duration_ms: Date.now() - startedAt
    });
    return { skipped: false, processed: subs.rows.length, billing_generated: billingGenerated, billing_skipped: billingSkipped };
  } catch (err) {
    if (err && err.code === "23505") {
      logger.warn("Subscription engine duplicate insert skipped by database uniqueness guard", {
        error: err.message,
        duration_ms: Date.now() - startedAt
      });
      return { skipped: false, duplicate_skipped: true };
    }

    logger.error("SUBSCRIPTION_ENGINE_RUN_ERROR", {
      duration_ms: Date.now() - startedAt,
      error: err
    });
    return { skipped: false, error: err && (err.message || String(err)) };
  } finally {
    if (lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock($1, $2)",
          [SUBSCRIPTION_ENGINE_LOCK_KEY_1, SUBSCRIPTION_ENGINE_LOCK_KEY_2]
        );
      } catch (unlockErr) {
        logger.error("SUBSCRIPTION ENGINE UNLOCK ERROR", unlockErr);
      }
    }

    client.release();
  }
}

function startSubscriptionEngine(intervalMs = 60 * 60 * 1000) {
  logger.info("Subscription interval engine started", {
    interval_ms: intervalMs
  });
  return setInterval(processSubscriptions, intervalMs);
}

module.exports = {
  processSubscriptions,
  startSubscriptionEngine,
  createSubscriptionBillingInvoice,
  createSubscriptionBillingInvoiceInTransaction,
  advanceBillingDate
};

const express = require("express");


const bcrypt = require("bcrypt");


const pool = require("../db/pool");


const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { generateInvoicePdf } = require("../services/pdfService");


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


  pickChangedFields,


  ensureNotificationsSchema,


  createNotification,


  ensureUniqueNotification,


  createNotificationIfMissing,


  
  createFinancialNotification,
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
const { buildInvoiceSentPayload, buildPaymentReminderPayload } = require("../services/emailService");
const logger = require("../services/logger");

const {
  assertInvoiceStatusTransition,
  validateLineItemsMatchAmount,
  appendPaymentLedgerEntrySafe,
  assertNewInvoiceTotalCoversNetPaid,
  runInvoiceIntegrityChecks
} = require("../services/financialIntegrityService");




const router = express.Router();





router.post("/workflow/invoices", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {


  try {


    await ensureWorkflowSchema();


    const companyId = Number(req.user.company_id);
    if (Number.isNaN(companyId)) {
      return res.status(400).json({ error: "Invalid company id" });
    }


    const { client_id, job_id, estimate_id, source_subscription_id, amount, due_date, notes, status, line_items } = req.body;





    if (!client_id) {


      return res.status(400).json({ error: "Client is required" });


    }





    const client = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [client_id, companyId]
    );

    if (client.rows.length === 0) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    let resolvedAmount = Number(amount || 0);
    let resolvedLineItems = Array.isArray(line_items) ? line_items : [];


    let sourceType = source_subscription_id ? "subscription" : "job";


    let fallbackDescription = "Service";





    if (job_id) {


      const jobResult = await pool.query(`


        SELECT * FROM jobs


        WHERE id = $1 AND company_id = $2 AND client_id = $3


        LIMIT 1


      `, [job_id, companyId, client_id]);





      if (jobResult.rows.length === 0) {


        return res.status(404).json({ error: "Job not found for this client" });


      }





      const job = jobResult.rows[0];


      fallbackDescription = job.service || "Job service";


      const existingJobInvoice = await pool.query(`
        SELECT id
        FROM invoices
        WHERE job_id = $1
          AND company_id = $2
          AND status <> 'cancelled'
        ORDER BY id DESC
        LIMIT 1
      `, [job_id, companyId]);


      if (existingJobInvoice.rows.length > 0) {
        const existingInvoice = await hydrateInvoice(companyId, existingJobInvoice.rows[0].id);
        return res.json(existingInvoice || existingJobInvoice.rows[0]);
      }


      if (!resolvedAmount) {


        resolvedAmount = Number(job.price || 0);


      }


    }
    if (estimate_id) {
      const estimateResult = await pool.query(`
        SELECT * FROM estimates
        WHERE id = $1 AND company_id = $2
          AND (client_id = $3 OR converted_client_id = $3)
        LIMIT 1
      `, [estimate_id, companyId, client_id]);
      if (estimateResult.rows.length === 0) {
        return res.status(404).json({ error: "Estimate not found for this client" });
      }
      const estimate = estimateResult.rows[0];
      if (!resolvedAmount) {
        resolvedAmount = Number(estimate.quoted_price || estimate.amount || 0);
      }
      fallbackDescription = estimate.service || "Estimate service";
    }





    if (source_subscription_id) {


      const subscriptionResult = await pool.query(`


        SELECT service, price


        FROM subscriptions


        WHERE id = $1 AND company_id = $2 AND client_id = $3


        LIMIT 1


      `, [source_subscription_id, companyId, client_id]);





      if (subscriptionResult.rows.length === 0) {


        return res.status(404).json({ error: "Subscription not found for this client" });


      }





      const subscription = subscriptionResult.rows[0];


      sourceType = "subscription";


      fallbackDescription = `${subscription.service || "Subscription service"} billing`;


      if (!resolvedAmount) {


        resolvedAmount = Number(subscription.price || 0);


      }


    }





    const normalizedInvoice = normalizeLineItems(resolvedLineItems, resolvedAmount, fallbackDescription);

    const lineErr = validateLineItemsMatchAmount(normalizedInvoice, normalizedInvoice.total);
    if (lineErr) {
      return res.status(lineErr.statusCode).json({
        error: lineErr.message,
        code: lineErr.code,
        details: lineErr.details || null
      });
    }

    const invoiceNumber = await nextInvoiceNumber(companyId);


    const invoice = await pool.query(`


      INSERT INTO invoices


      (company_id, client_id, job_id, estimate_id, source_subscription_id, source_type, invoice_number, status, issued_date, due_date, subtotal, amount, notes, line_items)


      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12,$13::jsonb)


      RETURNING *


    `, [


      companyId,


      client_id,


      job_id || null,


      estimate_id || null,


      source_subscription_id || null,


      sourceType,


      invoiceNumber,


      normalizeInvoiceStatus(status || "unpaid"),


      due_date || null,


      normalizedInvoice.subtotal,


      normalizedInvoice.total,


      notes || "",


      JSON.stringify(normalizedInvoice.line_items)


    ]);





    const hydratedInvoice = await hydrateInvoice(companyId, invoice.rows[0].id);





    if (hydratedInvoice && ["unpaid", "overdue"].includes(hydratedInvoice.status)) {


      await createFinancialNotification({


        companyId,


        type: hydratedInvoice.status === "overdue" ? "alert_overdue_invoice" : "alert_unpaid_invoice",


        title: hydratedInvoice.status === "overdue" ? "Overdue invoice" : "Unpaid invoice",


        message: `${hydratedInvoice.client_name || "Client"} invoice ${hydratedInvoice.invoice_number || `#${hydratedInvoice.id}`} is ${hydratedInvoice.status}.`


      });


    }





    await logActivity({


      companyId,


      userId: req.user.id,


      action: "invoice_created",


      entityType: "invoice",


      entityId: invoice.rows[0].id,


      details: {


        client_id,


        invoice_number: invoice.rows[0].invoice_number,


        job_id: job_id || null,


        source_subscription_id: source_subscription_id || null,


        amount: normalizedInvoice.total,


        status: hydratedInvoice ? hydratedInvoice.status : invoice.rows[0].status


      }


    });

    await appendPaymentLedgerEntrySafe(null, {
      company_id: companyId,
      event_type: "invoice_created",
      invoice_id: invoice.rows[0].id,
      amount: normalizedInvoice.total,
      metadata: {
        invoice_number: invoice.rows[0].invoice_number,
        subtotal: normalizedInvoice.subtotal,
        status: hydratedInvoice ? hydratedInvoice.status : invoice.rows[0].status
      },
      created_by: req.user.id
    });

    try {
      await createNotification({
        companyId,
        userId: null,
        type: "invoice_created",
        title: "Invoice created",
        message: `${(hydratedInvoice && hydratedInvoice.client_name) || "Client"} — invoice ${(hydratedInvoice && hydratedInvoice.invoice_number) || ("#" + invoice.rows[0].id)}.`,
        metadata: { invoice_id: invoice.rows[0].id }
      });
    } catch (notifErr) {
      logger.warn("INVOICE_CREATED_NOTIFICATION_FAILED", { error: notifErr && notifErr.message });
    }

    res.json(hydratedInvoice || { ...invoice.rows[0], line_items: safeJsonParse(invoice.rows[0].line_items, []) });


  } catch (err) {


    console.log("CREATE INVOICE ERROR:", err);


    sendSafeServerError(res, err, "routes/invoices");


  }


});





router.get("/workflow/invoices/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {


  try {


    await ensureWorkflowSchema();


    const invoice = await hydrateInvoice(req.user.company_id, req.params.id);





    if (!invoice) {


      return res.status(404).json({ error: "Invoice not found" });


    }





    res.json(invoice);


  } catch (err) {


    console.log("GET INVOICE ERROR:", err);


    sendSafeServerError(res, err, "routes/invoices");


  }


});

router.get("/workflow/invoices/:id/integrity", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const report = await runInvoiceIntegrityChecks(req.user.company_id, req.params.id);
    res.json({
      ...report,
      invoice_id: Number(req.params.id)
    });
  } catch (err) {
    console.log("INVOICE INTEGRITY CHECK ERROR:", err);
    sendSafeServerError(res, err, "routes/invoices");
  }
});

router.get("/workflow/invoices/:id/ledger", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    let rows = [];
    try {
      const result = await pool.query(
        `
        SELECT id, company_id, event_type, invoice_id, payment_id, refund_id, amount, metadata, created_at, created_by
        FROM payment_ledger
        WHERE company_id = $1 AND invoice_id = $2
        ORDER BY id ASC
        `,
        [req.user.company_id, req.params.id]
      );
      rows = result.rows || [];
    } catch (err) {
      if (err && err.code !== "42P01") {
        throw err;
      }
    }
    res.json({ invoice_id: Number(req.params.id), entries: rows });
  } catch (err) {
    console.log("INVOICE LEDGER READ ERROR:", err);
    sendSafeServerError(res, err, "routes/invoices");
  }
});

router.put("/workflow/invoices/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {


  try {


    await ensureWorkflowSchema();


    const current = await pool.query(`


      SELECT * FROM invoices


      WHERE id = $1 AND company_id = $2


      LIMIT 1


    `, [req.params.id, req.user.company_id]);





    if (current.rows.length === 0) {


      return res.status(404).json({ error: "Invoice not found" });


    }





    const row = current.rows[0];


    const status = normalizeInvoiceStatus(req.body.status || row.status);


    const normalizedInvoice = normalizeLineItems(


      Array.isArray(req.body.line_items) ? req.body.line_items : safeJsonParse(row.line_items, []),


      req.body.amount !== undefined ? req.body.amount : row.amount,


      "Service"


    );

    const lineErr = validateLineItemsMatchAmount(normalizedInvoice, normalizedInvoice.total);
    if (lineErr) {
      return res.status(lineErr.statusCode).json({
        error: lineErr.message,
        code: lineErr.code,
        details: lineErr.details || null
      });
    }

    if (row.status !== status) {
      const stErr = assertInvoiceStatusTransition(row.status, status);
      if (stErr) {
        return res.status(stErr.statusCode).json({
          error: stErr.message,
          code: stErr.code
        });
      }
    }

    try {
      await assertNewInvoiceTotalCoversNetPaid(null, req.user.company_id, req.params.id, normalizedInvoice.total);
    } catch (payErr) {
      if (payErr && payErr.statusCode) {
        return res.status(payErr.statusCode).json({
          error: payErr.message,
          code: payErr.code,
          details: payErr.details || null
        });
      }
      throw payErr;
    }

    const prevAmount = Number(row.amount || 0);
    const prevLineKey = JSON.stringify(safeJsonParse(row.line_items, []));
    const nextLineKey = JSON.stringify(normalizedInvoice.line_items || []);
    const amountChanged = Math.abs(prevAmount - Number(normalizedInvoice.total || 0)) > 0.009 || prevLineKey !== nextLineKey;

    const updated = await pool.query(`


      UPDATE invoices


      SET status = $1,


          due_date = $2,


          subtotal = $3,


          amount = $4,


          notes = $5,


          line_items = $6::jsonb,


          paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) WHEN $1 <> 'paid' THEN NULL ELSE paid_at END


      WHERE id = $7 AND company_id = $8


      RETURNING *


    `, [


      status,


      req.body.due_date || row.due_date,


      normalizedInvoice.subtotal,


      normalizedInvoice.total,


      req.body.notes !== undefined ? req.body.notes : row.notes,


      JSON.stringify(normalizedInvoice.line_items),


      req.params.id,


      req.user.company_id


    ]);





    const hydratedInvoice = await hydrateInvoice(req.user.company_id, req.params.id);





    if (hydratedInvoice && ["unpaid", "overdue"].includes(hydratedInvoice.status)) {


      await createFinancialNotification({


        companyId: req.user.company_id,


        type: hydratedInvoice.status === "overdue" ? "alert_overdue_invoice" : "alert_unpaid_invoice",


        title: hydratedInvoice.status === "overdue" ? "Overdue invoice" : "Unpaid invoice",


        message: `${hydratedInvoice.client_name || "Client"} invoice ${hydratedInvoice.invoice_number || `#${hydratedInvoice.id}`} is ${hydratedInvoice.status}.`


      });


    }





    const action = status === "paid" ? "invoice_marked_paid" : "invoice_updated";


    const changed = pickChangedFields(row, updated.rows[0], [
      "status",
      "due_date",
      "subtotal",
      "amount",
      "notes",
      "line_items"
    ]);




    await logChange({


      companyId: req.user.company_id,


      userId: req.user.id,


      action,


      entityType: "invoice",


      entityId: Number(req.params.id),


      before: changed.before,


      after: changed.after,


      metadata: {
        client_id: updated.rows[0].client_id,
        invoice_number: updated.rows[0].invoice_number,
        changed_fields: Object.keys(changed.after)
      }


    });

    if (amountChanged) {
      await appendPaymentLedgerEntrySafe(null, {
        company_id: req.user.company_id,
        event_type: "manual_adjustment",
        invoice_id: Number(req.params.id),
        amount: Number((Number(normalizedInvoice.total || 0) - prevAmount).toFixed(2)),
        metadata: {
          previous_amount: prevAmount,
          new_amount: normalizedInvoice.total,
          source: "invoice_put"
        },
        created_by: req.user.id
      });
    }

    res.json(hydratedInvoice || { ...updated.rows[0], line_items: safeJsonParse(updated.rows[0].line_items, []) });


  } catch (err) {


    console.log("UPDATE INVOICE ERROR:", err);


    sendSafeServerError(res, err, "routes/invoices");


  }


});





router.put("/workflow/invoices/:id/status", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {


  try {


    await ensureWorkflowSchema();


    const status = normalizeInvoiceStatus(req.body.status);


    const current = await pool.query(`


      SELECT *


      FROM invoices


      WHERE id = $1 AND company_id = $2


      LIMIT 1


    `, [req.params.id, req.user.company_id]);





    if (current.rows.length === 0) {


      return res.status(404).json({ error: "Invoice not found" });


    }

    const priorStatus = current.rows[0].status;
    if (priorStatus !== status) {
      const stErr = assertInvoiceStatusTransition(priorStatus, status);
      if (stErr) {
        return res.status(stErr.statusCode).json({
          error: stErr.message,
          code: stErr.code
        });
      }
    }

    let updatedInvoice = null;


    if (status === "paid") {


      const currentInvoice = await hydrateInvoice(req.user.company_id, req.params.id);


      const remainingBalance = Number(currentInvoice && currentInvoice.remaining_balance ? currentInvoice.remaining_balance : 0);





      if (remainingBalance > 0) {


        const payIns = await pool.query(`


          INSERT INTO payments (invoice_id, amount, method, date, notes, company_id)


          VALUES ($1,$2,'card',CURRENT_DATE,$3,$4)


          RETURNING *


        `, [


          req.params.id,


          remainingBalance,


          "Manual invoice status change marked this invoice paid.",


          req.user.company_id


        ]);

        if (payIns.rows[0]) {
          await appendPaymentLedgerEntrySafe(null, {
            company_id: req.user.company_id,
            event_type: "payment_received",
            invoice_id: Number(req.params.id),
            payment_id: payIns.rows[0].id,
            amount: remainingBalance,
            metadata: {
              method: payIns.rows[0].method,
              source: "invoice_status_mark_paid"
            },
            created_by: req.user.id
          });
        }


      }


      updatedInvoice = await hydrateInvoice(req.user.company_id, req.params.id);


    } else {


      const updated = await pool.query(`


        UPDATE invoices


        SET status = $1,


            paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) WHEN $1 <> 'paid' THEN NULL ELSE paid_at END


        WHERE id = $2 AND company_id = $3


        RETURNING *


      `, [status, req.params.id, req.user.company_id]);





      if (updated.rows.length === 0) {


        return res.status(404).json({ error: "Invoice not found" });


      }





      updatedInvoice = await hydrateInvoice(req.user.company_id, req.params.id);


    }





    if (updatedInvoice && ["unpaid", "overdue"].includes(updatedInvoice.status)) {


      await createFinancialNotification({


        companyId: req.user.company_id,


        type: updatedInvoice.status === "overdue" ? "alert_overdue_invoice" : "alert_unpaid_invoice",


        title: updatedInvoice.status === "overdue" ? "Overdue invoice" : "Unpaid invoice",


        message: `${updatedInvoice.client_name || "Client"} invoice ${updatedInvoice.invoice_number || `#${updatedInvoice.id}`} is ${updatedInvoice.status}.`


      });


    }





    await logChange({


      companyId: req.user.company_id,


      userId: req.user.id,


      action: status === "paid" ? "invoice_marked_paid" : "invoice_status_changed",


      entityType: "invoice",


      entityId: Number(req.params.id),


      before: {
        status: current.rows[0].status,
        amount: current.rows[0].amount
      },


      after: {
        status: updatedInvoice ? updatedInvoice.status : status,
        amount: updatedInvoice ? updatedInvoice.amount : current.rows[0].amount
      },


      metadata: {
        client_id: updatedInvoice ? updatedInvoice.client_id : current.rows[0].client_id,
        invoice_number: updatedInvoice ? updatedInvoice.invoice_number : current.rows[0].invoice_number
      }


    });





    res.json(updatedInvoice);


  } catch (err) {


    console.log("UPDATE INVOICE STATUS ERROR:", err);


    sendSafeServerError(res, err, "routes/invoices");


  }


});








// NOTE: Hard delete since invoices table does not have archived column
// Only for test or incorrect invoices
router.delete('/workflow/invoices/:id', auth, requireCompanyBillingForMutations, requireMinimumRole('manager'), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid invoice id" });
    }

    const company_id = req.user.company_id;
    const role = normalizeRole(req.user.role);

    const existing = await pool.query(
      `SELECT id, status FROM invoices WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [id, company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const paymentResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE invoice_id = $1 AND company_id = $2`,
      [id, company_id]
    );
    const hasPayments = Number(paymentResult.rows[0]?.count || 0) > 0;
    let hasRefunds = false;
    try {
      const refundResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM refunds WHERE invoice_id = $1 AND company_id = $2`,
        [id, company_id]
      );
      hasRefunds = Number(refundResult.rows[0]?.count || 0) > 0;
    } catch (refErr) {
      if (refErr && refErr.code !== "42P01") {
        throw refErr;
      }
    }
    const hasFinancialRecords = hasPayments || hasRefunds;
    const ownerAdmin = role === "owner" || role === "admin";

    if (hasFinancialRecords && !ownerAdmin) {
      return res.status(403).json({ error: "Invoice has payments or refunds. Owner/admin required." });
    }

    if (existing.rows[0].status === "paid" && !ownerAdmin) {
      return res.status(403).json({ error: "Paid invoices require owner/admin deletion." });
    }

    if (hasFinancialRecords || existing.rows[0].status === "paid") {
      await pool.query(
        `UPDATE invoices
         SET status = 'cancelled',
             paid_at = NULL
         WHERE id = $1 AND company_id = $2`,
        [id, company_id]
      );

      await logActivity({
        companyId: company_id,
        userId: req.user.id,
        action: 'invoice_cancelled',
        entityType: 'invoice',
        entityId: id,
        details: {
          reason: hasPayments ? "has_payments" : "paid_invoice"
        }
      });

      return res.json({ success: true, message: "Cancelled." });
    }

    await pool.query(
      `UPDATE subscription_billings SET invoice_id = NULL WHERE invoice_id = $1 AND company_id = $2`,
      [id, company_id]
    );

    await pool.query(
      `DELETE FROM invoices WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: 'invoice_deleted',
      entityType: 'invoice',
      entityId: id,
      details: {}
    });

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log('DELETE INVOICE ERROR:', err);
    sendSafeServerError(res, err, "routes/invoices");
  }
});

router.post("/workflow/invoices/:id/send-invoice-email", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const inv = await hydrateInvoice(req.user.company_id, req.params.id);
    if (!inv) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const payload = buildInvoiceSentPayload({
      invoice: inv,
      companyName: inv.company_name,
      overrideTo: req.body && req.body.to
    });
    if (!payload) {
      return res.status(400).json({
        error: "No recipient email — add a client email or company email, or pass `to` in the request body."
      });
    }
    try {
      enqueueEmailTask(payload);
    } catch (qErr) {
      logger.warn("INVOICE_EMAIL_ENQUEUE_FAILED", { error: qErr && qErr.message });
      return res.status(503).json({ error: "Mail queue unavailable. Try again shortly." });
    }
    res.json({ queued: true, to: payload.to });
  } catch (err) {
    sendSafeServerError(res, err, "routes/invoices");
  }
});

router.post("/workflow/invoices/:id/send-payment-reminder-email", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const inv = await hydrateInvoice(req.user.company_id, req.params.id);
    if (!inv) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    if (inv.status === "paid" || inv.status === "cancelled") {
      return res.status(400).json({ error: "Reminders apply only to open invoices" });
    }
    const payload = buildPaymentReminderPayload({
      invoice: inv,
      companyName: inv.company_name,
      overrideTo: req.body && req.body.to
    });
    if (!payload) {
      return res.status(400).json({
        error: "No recipient email — add a client email or company email, or pass `to` in the request body."
      });
    }
    try {
      enqueueEmailTask(payload);
    } catch (qErr) {
      logger.warn("PAYMENT_REMINDER_EMAIL_ENQUEUE_FAILED", { error: qErr && qErr.message });
      return res.status(503).json({ error: "Mail queue unavailable. Try again shortly." });
    }
    try {
      await createNotification({
        companyId: req.user.company_id,
        userId: null,
        type: "payment_due",
        title: "Payment reminder sent",
        message: `A payment reminder was queued for invoice ${inv.invoice_number || ("#" + inv.id)}.`,
        metadata: { invoice_id: Number(inv.id) }
      });
    } catch (notifErr) {
      logger.warn("PAYMENT_DUE_NOTIFICATION_FAILED", { error: notifErr && notifErr.message });
    }
    res.json({ queued: true, to: payload.to });
  } catch (err) {
    sendSafeServerError(res, err, "routes/invoices");
  }
});

router.get("/workflow/invoices/:id/pdf", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {


  try {


    await ensureWorkflowSchema();


    const invoice = await hydrateInvoice(req.user.company_id, req.params.id);




    if (!invoice) {


      return res.status(404).json({ error: "Invoice not found" });


    }


    const pdf = await generateInvoicePdf(invoice);
    const safeNumber = invoice.invoice_number ? String(invoice.invoice_number).replace(/[^a-zA-Z0-9_-]/g, "-") : String(invoice.id);
    const filename = invoice.invoice_number ? `invoice-${safeNumber}.pdf` : `invoice-${safeNumber}.pdf`;


    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "invoice_pdf_downloaded",
      entityType: "invoice",
      entityId: Number(req.params.id),
      details: {
        invoice_number: invoice.invoice_number || null,
        client_id: invoice.client_id || null
      }
    });


    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);


  } catch (err) {


    console.log("INVOICE PDF ERROR:", err);


    sendSafeServerError(res, err, "routes/invoices");


  }


});

module.exports = router;


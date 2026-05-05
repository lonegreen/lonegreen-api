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
const { buildPaymentReceiptPayload } = require("../services/emailService");
const logger = require("../services/logger");

const {
  assertPaymentWithinRemaining,
  appendPaymentLedgerEntrySafe,
  createRefundRecord
} = require("../services/financialIntegrityService");





const router = express.Router();





router.post("/workflow/invoices/:id/payments", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {


  try {


    await ensureWorkflowSchema();


    const invoice = await hydrateInvoice(req.user.company_id, req.params.id);





    if (!invoice) {


      return res.status(404).json({ error: "Invoice not found" });


    }
    if (invoice.status === "cancelled") {
      return res.status(400).json({ error: "Cannot add payment to cancelled invoice" });
    }






    const amount = Number(req.body.amount || 0);

    try {
      await assertPaymentWithinRemaining({
        companyId: req.user.company_id,
        invoiceId: req.params.id,
        proposedPaymentAmount: amount,
        invoiceTotalAmount: invoice.amount
      });
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

    const payment = await pool.query(`
      INSERT INTO payments (invoice_id, amount, method, date, notes, company_id)


      VALUES ($1,$2,$3,$4,$5,$6)


      RETURNING *


    `, [


      req.params.id,


      amount,


      normalizePaymentMethod(req.body.method),


      req.body.date || new Date().toISOString().split("T")[0],


      req.body.notes || "",


      req.user.company_id


    ]);





    const updatedInvoice = await hydrateInvoice(req.user.company_id, req.params.id);





    if (updatedInvoice && ["unpaid", "overdue"].includes(updatedInvoice.status)) {


      await createFinancialNotification({


        companyId: req.user.company_id,


        type: updatedInvoice.status === "overdue" ? "alert_overdue_invoice" : "alert_unpaid_invoice",


        title: updatedInvoice.status === "overdue" ? "Overdue invoice" : "Unpaid invoice",


        message: `${updatedInvoice.client_name || "Client"} invoice ${updatedInvoice.invoice_number || `#${updatedInvoice.id}`} is ${updatedInvoice.status}.`


      });


    }





    await logActivity({


      companyId: req.user.company_id,


      userId: req.user.id,


      action: "payment_recorded",


      entityType: "payment",


      entityId: payment.rows[0].id,


      details: {


        invoice_id: Number(req.params.id),


        client_id: invoice.client_id || null,


        amount,


        method: payment.rows[0].method,


        remaining_balance: updatedInvoice ? updatedInvoice.remaining_balance : null


      }


    });

    await appendPaymentLedgerEntrySafe(null, {
      company_id: req.user.company_id,
      event_type: "payment_received",
      invoice_id: Number(req.params.id),
      payment_id: payment.rows[0].id,
      amount,
      metadata: {
        method: payment.rows[0].method,
        source: "workflow_payment"
      },
      created_by: req.user.id
    });

    try {
      const mailPayload = buildPaymentReceiptPayload({
        invoice: updatedInvoice,
        payment: payment.rows[0],
        companyName: updatedInvoice && updatedInvoice.company_name,
        overrideTo: req.body && req.body.notify_email
      });
      if (mailPayload) {
        enqueueEmailTask(mailPayload);
      } else {
        logger.warn("PAYMENT_RECEIPT_EMAIL_SKIPPED", {
          company_id: req.user.company_id,
          invoice_id: Number(req.params.id)
        });
      }
    } catch (mailErr) {
      logger.warn("PAYMENT_RECEIPT_EMAIL_ENQUEUE_FAILED", { error: mailErr && mailErr.message });
    }

    try {
      await createNotification({
        companyId: req.user.company_id,
        userId: null,
        type: "payment_received",
        title: "Payment received",
        message: `Invoice ${updatedInvoice && updatedInvoice.invoice_number ? updatedInvoice.invoice_number : ("#" + req.params.id)}: $${Number(amount).toFixed(2)} recorded.`,
        metadata: {
          invoice_id: Number(req.params.id),
          payment_id: payment.rows[0].id
        }
      });
    } catch (notifErr) {
      logger.warn("PAYMENT_RECEIVED_NOTIFICATION_FAILED", { error: notifErr && notifErr.message });
    }

    res.json({


      payment: {


        ...payment.rows[0],


        amount: Number(payment.rows[0].amount || 0)


      },


      invoice: updatedInvoice


    });


  } catch (err) {


    console.log("CREATE PAYMENT ERROR:", err);


    sendSafeServerError(res, err, "routes/payments");


  }


});








router.post("/workflow/invoices/:id/payments/:paymentId/refunds", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureWorkflowSchema();

    const invoiceId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);

    if (!Number.isInteger(invoiceId) || invoiceId <= 0 || !Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({ error: "Invalid invoice or payment id" });
    }

    const refund = await createRefundRecord({
      companyId: req.user.company_id,
      invoiceId,
      paymentId,
      amount: Number(req.body && req.body.amount),
      reason: req.body && req.body.reason,
      notes: req.body && req.body.notes,
      userId: req.user.id
    });

    const updatedInvoice = await hydrateInvoice(req.user.company_id, String(invoiceId));

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "refund_recorded",
      entityType: "refund",
      entityId: refund.id,
      details: {
        invoice_id: invoiceId,
        payment_id: paymentId,
        amount: Number(refund.amount || 0),
        reason: (req.body && req.body.reason) || null,
        notes: (req.body && req.body.notes) || null
      }
    });

    try {
      await createNotification({
        companyId: req.user.company_id,
        userId: null,
        type: "system_alert",
        title: "Refund recorded",
        message: `Refund of $${Number(refund.amount || 0).toFixed(2)} for invoice #${invoiceId}.`,
        metadata: { invoice_id: invoiceId, refund_id: refund.id, payment_id: paymentId }
      });
    } catch (notifErr) {
      logger.warn("REFUND_SYSTEM_NOTIFICATION_FAILED", { error: notifErr && notifErr.message });
    }

    res.json({
      refund: {
        ...refund,
        amount: Number(refund.amount || 0)
      },
      invoice: updatedInvoice
    });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: err.details || null
      });
    }
    console.log("CREATE REFUND ERROR:", err);
    sendSafeServerError(res, err, "routes/payments");
  }
});

module.exports = router;



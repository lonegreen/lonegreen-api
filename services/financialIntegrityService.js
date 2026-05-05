const pool = require("../db/pool");

const LEDGER_EVENT_TYPES = new Set([
  "invoice_created",
  "payment_received",
  "refund_issued",
  "manual_adjustment",
  "balance_correction"
]);

const INVOICE_STATUSES = ["draft", "unpaid", "paid", "overdue", "cancelled"];

const STATUS_TRANSITIONS = {
  draft: new Set(["draft", "unpaid", "cancelled"]),
  unpaid: new Set(["draft", "unpaid", "paid", "overdue", "cancelled"]),
  overdue: new Set(["unpaid", "overdue", "paid", "cancelled"]),
  paid: new Set(["paid", "cancelled"]),
  cancelled: new Set(["cancelled"])
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeInvoiceStatusForIntegrity(status) {
  const s = String(status || "").trim().toLowerCase();
  return INVOICE_STATUSES.includes(s) ? s : "draft";
}

function assertInvoiceStatusTransition(fromStatus, toStatus) {
  const from = normalizeInvoiceStatusForIntegrity(fromStatus);
  const to = normalizeInvoiceStatusForIntegrity(toStatus);
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    const err = new Error(`Invalid invoice status transition: ${from} → ${to}`);
    err.code = "INVALID_INVOICE_STATUS_TRANSITION";
    err.statusCode = 400;
    return err;
  }
  return null;
}

function validateLineItemsMatchAmount(normalizedLineItems, amount) {
  const total = num(normalizedLineItems && normalizedLineItems.total);
  const target = num(amount);
  const items = Array.isArray(normalizedLineItems && normalizedLineItems.line_items)
    ? normalizedLineItems.line_items
    : [];

  if (target < 0 || total < 0) {
    const err = new Error("Invoice amount cannot be negative.");
    err.code = "INVOICE_NEGATIVE_TOTAL";
    err.statusCode = 400;
    err.details = { computed_total: total, stored_amount: target };
    return err;
  }

  const invalidItem = items.find(item => num(item.amount) < 0 || num(item.price) < 0 || num(item.quantity) < 0);
  if (invalidItem) {
    const err = new Error("Invoice line items cannot contain negative amounts.");
    err.code = "INVOICE_NEGATIVE_LINE_ITEM";
    err.statusCode = 400;
    err.details = { line_item: invalidItem };
    return err;
  }

  const diff = Math.abs(total - target);
  if (diff > 0.009) {
    const err = new Error("Invoice amount does not match line item totals.");
    err.code = "INVOICE_TOTAL_MISMATCH";
    err.statusCode = 400;
    err.details = { computed_total: total, stored_amount: target };
    return err;
  }
  return null;
}

async function appendPaymentLedgerEntrySafe(client, entry) {
  try {
    await appendPaymentLedgerEntry(client, entry);
    return true;
  } catch (err) {
    if (err && err.code === "42P01") {
      return false;
    }
    throw err;
  }
}

async function appendPaymentLedgerEntry(client, entry) {
  const {
    company_id,
    event_type,
    invoice_id,
    payment_id = null,
    refund_id = null,
    amount = 0,
    metadata = {},
    created_by = null
  } = entry;

  if (!company_id || !invoice_id) {
    const err = new Error("Ledger entry requires company_id and invoice_id");
    err.code = "LEDGER_INVALID";
    err.statusCode = 400;
    throw err;
  }

  if (!LEDGER_EVENT_TYPES.has(event_type)) {
    const err = new Error("Invalid ledger event_type");
    err.code = "LEDGER_INVALID_EVENT";
    err.statusCode = 400;
    throw err;
  }

  const db = client || pool;
  await db.query(
    `
    INSERT INTO payment_ledger (
      company_id,
      event_type,
      invoice_id,
      payment_id,
      refund_id,
      amount,
      metadata,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    `,
    [
      company_id,
      event_type,
      invoice_id,
      payment_id,
      refund_id,
      num(amount),
      JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
      created_by
    ]
  );
}

async function getRefundedTotalForPayment(client, companyId, paymentId) {
  const db = client || pool;
  try {
    const r = await db.query(
      `
      SELECT COALESCE(SUM(amount), 0)::numeric AS refunded
      FROM refunds
      WHERE company_id = $1 AND payment_id = $2
      `,
      [companyId, paymentId]
    );
    return num(r.rows[0] && r.rows[0].refunded);
  } catch (err) {
    if (err && err.code === "42P01") {
      return 0;
    }
    throw err;
  }
}

async function getNetPaidForInvoice(client, companyId, invoiceId) {
  const db = client || pool;
  try {
    const r = await db.query(
      `
      SELECT
        COALESCE((
          SELECT SUM(p.amount)::numeric
          FROM payments p
          WHERE p.invoice_id = $1 AND p.company_id = $2
        ), 0)::numeric
        - COALESCE((
          SELECT SUM(r.amount)::numeric
          FROM refunds r
          WHERE r.invoice_id = $1 AND r.company_id = $2
        ), 0)::numeric AS net_paid
      `,
      [invoiceId, companyId]
    );
    return num(r.rows[0] && r.rows[0].net_paid);
  } catch (err) {
    if (err && err.code === "42P01") {
      const r2 = await db.query(
        `
        SELECT COALESCE(SUM(amount), 0)::numeric AS net_paid
        FROM payments
        WHERE invoice_id = $1 AND company_id = $2
        `,
        [invoiceId, companyId]
      );
      return num(r2.rows[0] && r2.rows[0].net_paid);
    }
    throw err;
  }
}

async function assertPaymentWithinRemaining({
  companyId,
  invoiceId,
  proposedPaymentAmount,
  invoiceTotalAmount,
  client = null
}) {
  const netPaid = await getNetPaidForInvoice(client, companyId, invoiceId);
  const total = num(invoiceTotalAmount);
  const remaining = Number(Math.max(total - netPaid, 0).toFixed(2));
  const pay = num(proposedPaymentAmount);

  if (pay <= 0) {
    const err = new Error("Payment amount must be greater than zero");
    err.code = "INVALID_PAYMENT_AMOUNT";
    err.statusCode = 400;
    throw err;
  }

  if (pay > remaining + 0.009) {
    const err = new Error("Payment amount cannot exceed remaining balance");
    err.code = "OVERPAYMENT";
    err.statusCode = 400;
    err.details = { remaining_balance: remaining, proposed: pay, invoice_total: total, net_paid: netPaid };
    throw err;
  }

  return { netPaid, remaining, total };
}

async function createPaymentRecord({
  companyId,
  invoiceId,
  amount,
  method,
  date,
  notes,
  userId,
  metadata = {}
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const invoice = await client.query(
      `
      SELECT id, company_id, amount, status
      FROM invoices
      WHERE id = $1 AND company_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [invoiceId, companyId]
    );

    if (!invoice.rows.length) {
      const err = new Error("Invoice not found");
      err.code = "INVOICE_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    if (invoice.rows[0].status === "cancelled") {
      const err = new Error("Cannot add payment to cancelled invoice");
      err.code = "INVOICE_CANCELLED";
      err.statusCode = 400;
      throw err;
    }

    await assertPaymentWithinRemaining({
      companyId,
      invoiceId,
      proposedPaymentAmount: amount,
      invoiceTotalAmount: invoice.rows[0].amount,
      client
    });

    const payment = await client.query(
      `
      INSERT INTO payments (invoice_id, amount, method, date, notes, company_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        invoiceId,
        num(amount),
        method,
        date || new Date().toISOString().split("T")[0],
        notes || "",
        companyId
      ]
    );

    const paymentRow = payment.rows[0];

    await appendPaymentLedgerEntry(client, {
      company_id: companyId,
      event_type: "payment_received",
      invoice_id: Number(invoiceId),
      payment_id: paymentRow.id,
      amount: num(amount),
      metadata: {
        ...metadata,
        method: paymentRow.method
      },
      created_by: userId || null
    });

    await client.query("COMMIT");
    return paymentRow;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assertNewInvoiceTotalCoversNetPaid(client, companyId, invoiceId, newTotal) {
  const netPaid = await getNetPaidForInvoice(client, companyId, invoiceId);
  if (num(newTotal) + 0.009 < netPaid) {
    const err = new Error("Invoice total cannot be less than net payments minus refunds. Issue refunds first.");
    err.code = "INVOICE_AMOUNT_BELOW_NET_PAID";
    err.statusCode = 400;
    err.details = { net_paid: netPaid, new_total: num(newTotal) };
    throw err;
  }
}

async function runInvoiceIntegrityChecks(companyId, invoiceId) {
  const issues = [];

  const inv = await pool.query(
    `
    SELECT id, company_id, status, amount, subtotal, line_items, due_date
    FROM invoices
    WHERE id = $1 AND company_id = $2
    LIMIT 1
    `,
    [invoiceId, companyId]
  );

  if (!inv.rows.length) {
    issues.push({ code: "INVOICE_NOT_FOUND", message: "Invoice not found for company" });
    return { ok: false, issues };
  }

  const row = inv.rows[0];
  const { normalizeLineItems, safeJsonParse } = require("./invoiceService");
  const parsed = safeJsonParse(row.line_items, []);
  const normalized = normalizeLineItems(parsed, row.amount, "Service");

  const mismatch = validateLineItemsMatchAmount(normalized, row.amount);
  if (mismatch) {
    issues.push({
      code: mismatch.code,
      message: mismatch.message,
      details: mismatch.details
    });
  }

  const netPaid = await getNetPaidForInvoice(null, companyId, invoiceId);
  const total = num(row.amount);
  const impliedRemaining = Number((total - netPaid).toFixed(2));
  const remaining = Number(Math.max(impliedRemaining, 0).toFixed(2));

  if (impliedRemaining < -0.009) {
    issues.push({
      code: "NEGATIVE_REMAINING",
      message: "Net payments and refunds exceed invoice total",
      details: { invoice_total: total, net_paid: netPaid, implied_remaining: impliedRemaining }
    });
  }

  const today = new Date().toISOString().split("T")[0];
  const due = row.due_date ? String(row.due_date).split("T")[0] : null;
  let expectedStatus = row.status;
  if (row.status !== "cancelled") {
    if (row.status === "draft" && netPaid === 0) {
      expectedStatus = "draft";
    } else if (remaining <= 0 && total > 0) {
      expectedStatus = "paid";
    } else if (due && due < today) {
      expectedStatus = "overdue";
    } else {
      expectedStatus = "unpaid";
    }
  }

  if (normalizeInvoiceStatusForIntegrity(row.status) !== normalizeInvoiceStatusForIntegrity(expectedStatus)
    && row.status !== "cancelled") {
    issues.push({
      code: "STATUS_DRIFT",
      message: "Invoice status does not match computed status from balances and dates",
      details: {
        stored_status: row.status,
        computed_status: expectedStatus,
        net_paid: netPaid,
        remaining_balance: remaining
      }
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    snapshot: {
      invoice_total: total,
      net_paid: netPaid,
      remaining_balance: Math.max(remaining, 0),
      status: row.status
    }
  };
}

async function createRefundRecord({
  companyId,
  invoiceId,
  paymentId,
  amount,
  reason,
  notes,
  userId
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const pay = await client.query(
      `
      SELECT id, invoice_id, company_id, amount
      FROM payments
      WHERE id = $1 AND company_id = $2 AND invoice_id = $3
      LIMIT 1
      FOR UPDATE
      `,
      [paymentId, companyId, invoiceId]
    );

    if (!pay.rows.length) {
      const err = new Error("Payment not found for this invoice");
      err.code = "PAYMENT_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const paymentAmount = num(pay.rows[0].amount);
    const alreadyRefunded = await getRefundedTotalForPayment(client, companyId, paymentId);
    const refundable = Number(Math.max(paymentAmount - alreadyRefunded, 0).toFixed(2));
    const refundAmt = num(amount);

    if (!Number.isFinite(refundAmt) || refundAmt <= 0) {
      const err = new Error("Refund amount must be greater than zero");
      err.code = "INVALID_REFUND_AMOUNT";
      err.statusCode = 400;
      err.details = { refundable, requested: refundAmt, payment_amount: paymentAmount, already_refunded: alreadyRefunded };
      throw err;
    }

    if (refundAmt > refundable + 0.009) {
      const err = new Error("Refund amount exceeds refundable amount on this payment");
      err.code = "INVALID_REFUND_AMOUNT";
      err.statusCode = 400;
      err.details = { refundable, requested: refundAmt, payment_amount: paymentAmount, already_refunded: alreadyRefunded };
      throw err;
    }

    const inv = await client.query(
      `SELECT id, status, amount FROM invoices WHERE id = $1 AND company_id = $2 LIMIT 1 FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (!inv.rows.length) {
      const err = new Error("Invoice not found");
      err.code = "INVOICE_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    if (inv.rows[0].status === "cancelled") {
      const err = new Error("Cannot refund payments on a cancelled invoice");
      err.code = "INVOICE_CANCELLED";
      err.statusCode = 400;
      throw err;
    }

    const refundInsert = await client.query(
      `
      INSERT INTO refunds (company_id, invoice_id, payment_id, amount, reason, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        companyId,
        invoiceId,
        paymentId,
        refundAmt,
        reason || null,
        notes != null ? String(notes) : "",
        userId || null
      ]
    );

    const refundRow = refundInsert.rows[0];

    await appendPaymentLedgerEntry(client, {
      company_id: companyId,
      event_type: "refund_issued",
      invoice_id: invoiceId,
      payment_id: paymentId,
      refund_id: refundRow.id,
      amount: -Math.abs(refundAmt),
      metadata: {
        reason: reason || null,
        payment_id: paymentId,
        refund_id: refundRow.id
      },
      created_by: userId || null
    });

    await client.query("COMMIT");
    return refundRow;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function recordBalanceCorrectionEntry({
  companyId,
  invoiceId,
  amount,
  metadata,
  userId
}) {
  await appendPaymentLedgerEntrySafe(null, {
    company_id: companyId,
    event_type: "balance_correction",
    invoice_id: invoiceId,
    amount: num(amount),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    created_by: userId || null
  });
}

module.exports = {
  LEDGER_EVENT_TYPES,
  assertInvoiceStatusTransition,
  validateLineItemsMatchAmount,
  appendPaymentLedgerEntry,
  appendPaymentLedgerEntrySafe,
  recordBalanceCorrectionEntry,
  getNetPaidForInvoice,
  getRefundedTotalForPayment,
  assertPaymentWithinRemaining,
  assertNewInvoiceTotalCoversNetPaid,
  createPaymentRecord,
  runInvoiceIntegrityChecks,
  createRefundRecord
};

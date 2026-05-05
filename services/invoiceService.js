const pool = require("../db/pool");
const { ensureUniqueNotification } = require("./notificationService");
const PAYMENT_METHODS = ["cash", "zelle", "card"];
const INVOICE_STATUSES = ["draft", "unpaid", "paid", "overdue", "cancelled"];

function safeJsonParse(value, fallback = []) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function normalizePaymentMethod(method) {
  return PAYMENT_METHODS.includes(method) ? method : "cash";
}

function normalizeInvoiceStatus(status) {
  return INVOICE_STATUSES.includes(status) ? status : "draft";
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().split("T")[0];
  return String(value).split("T")[0];
}

async function nextInvoiceNumber(companyId, db = pool) {
  const companyIdInt = Number(companyId);
  const result = await db.query(`
    SELECT COALESCE(
      MAX(
        CASE
          WHEN invoice_number ~ ('^INV-' || LPAD($1::text, 3, '0') || '-[0-9]+$')
          THEN substring(invoice_number from '[0-9]+$')::int
          ELSE NULL
        END
      ),
      COUNT(*)::int,
      0
    ) AS last_number
    FROM invoices
    WHERE company_id = $2::int
  `, [companyIdInt, companyIdInt]);

  const next = Number(result.rows[0] && result.rows[0].last_number ? result.rows[0].last_number : 0) + 1;
  return `INV-${String(companyIdInt).padStart(3, "0")}-${String(next).padStart(5, "0")}`;
}

function normalizeLineItems(lineItems, fallbackAmount = 0, fallbackDescription = "Service") {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const normalized = items
    .map(item => {
      const description = String(item && item.description ? item.description : fallbackDescription).trim() || fallbackDescription;
      const quantity = Math.max(0, Number(item && item.quantity !== undefined ? item.quantity : 1) || 0) || 1;
      const price = Number(item && item.price !== undefined ? item.price : (item && item.amount !== undefined ? item.amount : 0)) || 0;
      const amount = Number((quantity * price).toFixed(2));
      return {
        description,
        quantity,
        price: Number(price.toFixed(2)),
        amount
      };
    })
    .filter(item => item.description || item.amount);

  const fallback = normalized.length > 0 ? normalized : [{
    description: fallbackDescription || "Service",
    quantity: 1,
    price: Number((Number(fallbackAmount || 0)).toFixed(2)),
    amount: Number((Number(fallbackAmount || 0)).toFixed(2))
  }];

  const subtotal = Number(fallback.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2));

  return {
    line_items: fallback,
    subtotal,
    total: subtotal
  };
}

async function recalculateInvoiceFinancials(companyId, invoiceId, db = pool) {
  const invoiceResult = await db.query(`
    SELECT *
    FROM invoices
    WHERE id = $1 AND company_id = $2
    LIMIT 1
  `, [invoiceId, companyId]);

  if (invoiceResult.rows.length === 0) {
    return null;
  }

  const invoice = invoiceResult.rows[0];
  let paymentsResult;
  try {
    paymentsResult = await db.query(`
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
        ), 0)::numeric AS paid_amount
    `, [invoiceId, companyId]);
  } catch (err) {
    if (err && err.code === "42P01") {
      paymentsResult = await db.query(`
        SELECT COALESCE(SUM(amount), 0)::numeric AS paid_amount
        FROM payments
        WHERE invoice_id = $1 AND company_id = $2
      `, [invoiceId, companyId]);
    } else {
      throw err;
    }
  }

  const paidAmount = Number(resultValue(paymentsResult.rows[0], "paid_amount", 0));
  const totalAmount = Number(invoice.amount || 0);
  const remainingBalance = Number(Math.max(totalAmount - paidAmount, 0).toFixed(2));
  const today = new Date().toISOString().split("T")[0];

  let nextStatus = invoice.status;
  if (invoice.status !== "cancelled") {
    if (invoice.status === "draft" && paidAmount === 0) {
      nextStatus = "draft";
    } else if (remainingBalance <= 0 && totalAmount >= 0) {
      nextStatus = "paid";
    } else if (invoice.due_date && dateOnly(invoice.due_date) < today) {
      nextStatus = "overdue";
    } else {
      nextStatus = "unpaid";
    }
  }

  const updated = await db.query(`
    UPDATE invoices
    SET status = $1,
        paid_at = CASE
          WHEN $1 = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP)
          WHEN $1 <> 'paid' THEN NULL
          ELSE paid_at
        END
    WHERE id = $2 AND company_id = $3
    RETURNING *
  `, [nextStatus, invoiceId, companyId]);

  return {
    ...updated.rows[0],
    paid_amount: paidAmount,
    remaining_balance: remainingBalance
  };
}

function resultValue(row, key, fallback) {
  return row && row[key] ? row[key] : fallback;
}

async function hydrateInvoice(companyId, invoiceId) {
  const result = await pool.query(`
    SELECT
      invoices.*,
      clients.name AS client_name,
      clients.email AS client_email,
      clients.phone AS client_phone,
      clients.address AS client_address,
      clients.zip AS client_zip,
      jobs.service AS job_service,
      jobs.date AS job_date,
      companies.name AS company_name,
      companies.phone AS company_phone,
      companies.email AS company_email,
      companies.address AS company_address,
      companies.service_area,
      companies.business_hours
    FROM invoices
    LEFT JOIN clients ON invoices.client_id = clients.id AND clients.company_id = invoices.company_id
    LEFT JOIN jobs ON invoices.job_id = jobs.id AND jobs.company_id = invoices.company_id
    LEFT JOIN companies ON invoices.company_id = companies.id
    WHERE invoices.id = $1 AND invoices.company_id = $2
    LIMIT 1
  `, [invoiceId, companyId]);

  if (result.rows.length === 0) {
    return null;
  }

  const invoice = await recalculateInvoiceFinancials(companyId, invoiceId);
  const payments = await pool.query(`
    SELECT id, invoice_id, amount, method, date, notes, company_id, created_at
    FROM payments
    WHERE invoice_id = $1 AND company_id = $2
    ORDER BY date DESC, id DESC
  `, [invoiceId, companyId]);

  let refunds = { rows: [] };
  try {
    refunds = await pool.query(`
      SELECT id, company_id, invoice_id, payment_id, amount, reason, notes, created_at, created_by
      FROM refunds
      WHERE invoice_id = $1 AND company_id = $2
      ORDER BY id ASC
    `, [invoiceId, companyId]);
  } catch (err) {
    if (err && err.code !== "42P01") {
      throw err;
    }
  }

  const merged = {
    ...result.rows[0],
    ...invoice,
    line_items: normalizeLineItems(safeJsonParse(result.rows[0].line_items, []), result.rows[0].amount, result.rows[0].job_service || "Service").line_items,
    payments: payments.rows.map(payment => ({
      ...payment,
      amount: Number(payment.amount || 0)
    })),
    refunds: (refunds.rows || []).map((refund) => ({
      ...refund,
      amount: Number(refund.amount || 0)
    })),
    subtotal: Number((invoice && invoice.subtotal !== undefined ? invoice.subtotal : result.rows[0].subtotal || 0)),
    amount: Number((invoice && invoice.amount !== undefined ? invoice.amount : result.rows[0].amount || 0)),
    paid_amount: Number(invoice && invoice.paid_amount ? invoice.paid_amount : 0),
    remaining_balance: Number(
      invoice && invoice.remaining_balance != null
        ? invoice.remaining_balance
        : Number(result.rows[0].amount || 0)
    )
  };

  return merged;
}

async function syncFinancialAlerts(companyId) {
  const unpaidInvoices = await pool.query(`
    SELECT invoices.id, invoices.invoice_number, invoices.status, clients.name AS client_name
    FROM invoices
    LEFT JOIN clients ON clients.id = invoices.client_id AND clients.company_id = invoices.company_id
    WHERE invoices.company_id = $1
      AND invoices.status IN ('unpaid', 'overdue')
  `, [companyId]);

  for (const invoice of unpaidInvoices.rows) {
    await ensureUniqueNotification({
      companyId,
      type: invoice.status === "overdue" ? "alert_overdue_invoice" : "alert_unpaid_invoice",
      title: invoice.status === "overdue" ? "Overdue invoice" : "Unpaid invoice",
      message: `${invoice.client_name || "Client"} invoice ${invoice.invoice_number || `#${invoice.id}`} is ${invoice.status}.`
    });
  }
}

module.exports = {
  safeJsonParse,
  normalizePaymentMethod,
  normalizeInvoiceStatus,
  nextInvoiceNumber,
  normalizeLineItems,
  recalculateInvoiceFinancials,
  hydrateInvoice,
  syncFinancialAlerts
};

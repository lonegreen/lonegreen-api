const express = require("express");
const pool = require("../db/pool");
const {
  safeJsonParse,
  normalizeJobStatus,
  normalizeEstimateStatus,
  hydrateInvoice,
  ensureWorkflowSchema,
  ensureSubscriptionBillingSchema,
  logActivity
} = require("../services/routeHelpers");
const { verifyCustomerBearerToken } = require("../middleware/auth");
const { generateInvoicePdf, generateEstimatePdf } = require("../services/pdfService");
const logger = require("../services/logger");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

function portalEstimateStatus(status) {
  return status === "converted" ? "converted" : normalizeEstimateStatus(status);
}

/**
 * Read-model only: align customer invoice JSON with staff list/detail (net paid, refunds total, display_status).
 * Does not change persisted invoice rows or financial calculations (hydrateInvoice already computes balances).
 */
function attachCustomerInvoicePresentation(invoice) {
  if (!invoice) {
    return null;
  }
  const netPaid = Number(
    invoice.paid_amount != null
      ? invoice.paid_amount
      : invoice.net_paid != null
        ? invoice.net_paid
        : 0
  );
  let refundedTotal = 0;
  if (Array.isArray(invoice.refunds)) {
    refundedTotal = invoice.refunds.reduce((sum, r) => sum + Number(r && r.amount != null ? r.amount : 0), 0);
  } else if (invoice.refunded_amount != null) {
    refundedTotal = Number(invoice.refunded_amount);
  }
  const remaining = Number(invoice.remaining_balance != null ? invoice.remaining_balance : 0);
  const total = Number(invoice.amount || 0);
  const st = String(invoice.status || "").toLowerCase();
  let display_status = st;
  if (st === "cancelled") {
    display_status = "cancelled";
  } else if (remaining <= 0.009 && total >= 0) {
    display_status = "paid";
  } else if (netPaid > 0.009 && remaining > 0.009) {
    display_status = "partially_paid";
  }
  return {
    ...invoice,
    net_paid: netPaid,
    refunded_total: refundedTotal,
    display_status
  };
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value) {
  return String(value || "").trim();
}

function sanitizeFilenamePart(value, fallback) {
  const clean = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return clean || fallback;
}

function buildInvoicePdfFilename(invoice) {
  const numberPart = sanitizeFilenamePart(invoice && invoice.invoice_number, String(invoice && invoice.id ? invoice.id : "invoice"));
  const clientPart = sanitizeFilenamePart(invoice && invoice.client_name, String(invoice && invoice.id ? invoice.id : "client"));
  return `FairLinx-${numberPart}-${clientPart}.pdf`;
}

function customerAuth(req, res, next) {
  try {
    req.customer = verifyCustomerBearerToken(req.headers.authorization);
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || "Invalid customer token" });
  }
}

async function getClient(customer) {
  const result = await pool.query("SELECT * FROM clients WHERE id=$1 LIMIT 1", [customer.client_id]);
  return result.rows[0] || null;
}

function ensureCustomerCompanyIsolation(customer, client) {
  if (!client) return false;
  if (!customer.company_id) return true;
  return String(customer.company_id) === String(client.company_id);
}

async function getCustomerAccountByClient(clientId) {
  const result = await pool.query(
    `
    SELECT
      id,
      client_id,
      email,
      first_name,
      last_name,
      phone,
      is_verified,
      created_at,
      updated_at
    FROM customer_accounts
    WHERE client_id = $1
    LIMIT 1
    `,
    [clientId]
  );
  return result.rows[0] || null;
}

async function getCustomerRequests(customer) {
  await ensureWorkflowSchema();
  const companyId = customer.company_id || null;
  if (!companyId) {
    return [];
  }
  const result = await pool.query(
    `
    SELECT id, service, status, visit_date, notes, created_at
    FROM estimates
    WHERE company_id = $1
      AND client_id = $2
      AND record_type = 'lead'
      AND COALESCE(archived, FALSE) = FALSE
    ORDER BY created_at DESC, id DESC
    `,
    [companyId, customer.client_id]
  );
  return result.rows;
}

async function getCompany(companyId) {
  const result = await pool.query("SELECT id, name, phone, email, address, service_area, business_hours FROM companies WHERE id=$1 LIMIT 1", [companyId]);
  return result.rows[0] || null;
}

async function getEstimates(customer) {
  await ensureWorkflowSchema();
  const result = await pool.query(
    "SELECT id, client_id, customer_name, phone, address, zip, service, status, quoted_price, visit_date, notes, created_at, company_id " +
    "FROM estimates WHERE company_id=$1 AND record_type = 'estimate' AND COALESCE(archived, FALSE) = FALSE AND (client_id=$2 OR converted_client_id=$2) ORDER BY id DESC",
    [customer.company_id, customer.client_id]
  );
  return result.rows.map(item => ({ ...item, status: portalEstimateStatus(item.status) }));
}

async function getCustomerEstimate(customer, id) {
  await ensureWorkflowSchema();
  const result = await pool.query(
    `SELECT *
     FROM estimates
     WHERE id = $1
       AND company_id = $2
       AND record_type = 'estimate'
       AND (client_id = $3 OR converted_client_id = $3)
     LIMIT 1`,
    [id, customer.company_id, customer.client_id]
  );
  return result.rows[0] || null;
}

async function updateCustomerEstimateStatus(req, res, status) {
  try {
    const estimate = await getCustomerEstimate(req.customer, req.params.id);
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });

    if (
      estimate.status === "converted" ||
      estimate.converted_job_id ||
      estimate.converted_client_id
    ) {
      return res.status(400).json({ error: "Estimate is already converted" });
    }

    const result = await pool.query(
      `UPDATE estimates
       SET status = $1
       WHERE id = $2
         AND company_id = $3
         AND record_type = 'estimate'
         AND (client_id = $4 OR converted_client_id = $4)
       RETURNING *`,
      [status, req.params.id, req.customer.company_id, req.customer.client_id]
    );

    await logActivity({
      companyId: req.customer.company_id,
      userId: null,
      action: status === "approved" ? "customer_estimate_approved" : "customer_estimate_rejected",
      entityType: "estimate",
      entityId: result.rows[0].id,
      details: {
        client_id: req.customer.client_id,
        before_status: estimate.status,
        after_status: status
      }
    });

    res.json({ ...result.rows[0], status: portalEstimateStatus(result.rows[0].status) });
  } catch (err) {
    console.log("CUSTOMER ESTIMATE STATUS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}

async function getJobs(customer) {
  const result = await pool.query(
    "SELECT jobs.id, jobs.client_id, jobs.service, jobs.type, jobs.date, jobs.start_time, jobs.end_time, jobs.status, jobs.price, jobs.payment_status, jobs.internal_notes, workers.name AS worker_name " +
    "FROM jobs LEFT JOIN workers ON workers.id = jobs.worker_id AND workers.company_id = jobs.company_id WHERE jobs.company_id=$1 AND jobs.client_id=$2 ORDER BY jobs.date DESC, jobs.start_time DESC, jobs.id DESC",
    [customer.company_id, customer.client_id]
  );
  return result.rows.map(item => ({ ...item, status: normalizeJobStatus(item.status) }));
}

async function getSubscriptions(customer) {
  await ensureSubscriptionBillingSchema();
  const result = await pool.query(
    "SELECT subscriptions.*, workers.name AS worker_name FROM subscriptions LEFT JOIN workers ON workers.id = subscriptions.worker_id AND workers.company_id = subscriptions.company_id WHERE subscriptions.company_id=$1 AND subscriptions.client_id=$2 ORDER BY subscriptions.id DESC",
    [customer.company_id, customer.client_id]
  );
  return result.rows;
}

async function getInvoices(customer) {
  const result = await pool.query("SELECT id FROM invoices WHERE company_id=$1 AND client_id=$2 ORDER BY id DESC", [customer.company_id, customer.client_id]);
  const invoices = [];
  for (const row of result.rows) {
    const invoice = await hydrateInvoice(customer.company_id, row.id);
    if (invoice && String(invoice.client_id) === String(customer.client_id)) {
      const parsed = attachCustomerInvoicePresentation({
        ...invoice,
        line_items: safeJsonParse(invoice.line_items, invoice.line_items || [])
      });
      if (parsed) {
        invoices.push(parsed);
      }
    }
  }
  return invoices;
}

router.post("/customer/login", async (req, res) => {
  logger.warn("LEGACY CUSTOMER LOGIN BLOCKED", {
    ip: req.ip || req.socket?.remoteAddress || "unknown"
  });
  return res.status(410).json({
    error: "Legacy customer login is disabled. Use /auth/customer-login."
  });
});

router.get("/customer/me", customerAuth, async (req, res) => {
  try {
    const client = await getClient(req.customer);
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!ensureCustomerCompanyIsolation(req.customer, client)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const account = await getCustomerAccountByClient(client.id);
    const companyId = req.customer.company_id || client.company_id || null;

    return res.json({
      id: account ? account.id : null,
      role: "customer",
      client_id: client.id,
      company_id: companyId,
      email: account ? account.email : client.email || null,
      first_name: account ? account.first_name : null,
      last_name: account ? account.last_name : null,
      phone: account ? account.phone : client.phone || null,
      is_verified: account ? account.is_verified : false,
      created_at: account ? account.created_at : null,
      updated_at: account ? account.updated_at : null,
      customer: {
        id: client.id,
        name: client.name || "",
        phone: client.phone || "",
        email: client.email || null,
        address: client.address || "",
        zip: client.zip || ""
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER ME ERROR");
  }
});

router.put("/customer/profile", customerAuth, async (req, res) => {
  try {
    const client = await getClient(req.customer);
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!ensureCustomerCompanyIsolation(req.customer, client)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const account = await getCustomerAccountByClient(client.id);
    if (!account) {
      return res.status(404).json({ error: "Customer account not found" });
    }

    const firstName = cleanText(req.body?.first_name);
    const lastName = cleanText(req.body?.last_name);
    const phone = cleanText(req.body?.phone);
    const email = cleanEmail(req.body?.email);
    const address = cleanText(req.body?.address);

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "First name, last name, and email are required" });
    }

    const emailConflict = await pool.query(
      `
      SELECT id
      FROM customer_accounts
      WHERE LOWER(email) = LOWER($1)
        AND id <> $2
      LIMIT 1
      `,
      [email, account.id]
    );
    if (emailConflict.rows.length) {
      return res.status(409).json({ error: "Email is already in use" });
    }

    const updatedAccountResult = await pool.query(
      `
      UPDATE customer_accounts
      SET
        first_name = $2,
        last_name = $3,
        phone = $4,
        email = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, client_id, email, first_name, last_name, phone, is_verified, created_at, updated_at
      `,
      [account.id, firstName, lastName, phone, email]
    );

    const updatedClientResult = await pool.query(
      `
      UPDATE clients
      SET
        name = $2,
        phone = $3,
        email = $4,
        address = $5
      WHERE id = $1
        AND company_id = $6
      RETURNING id, company_id, name, phone, email, address, zip
      `,
      [client.id, [firstName, lastName].filter(Boolean).join(" "), phone, email, address || client.address || "", client.company_id]
    );

    if (!updatedClientResult.rows.length) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updatedClient = updatedClientResult.rows[0];
    if (!ensureCustomerCompanyIsolation(req.customer, updatedClient)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json({
      profile: {
        ...updatedAccountResult.rows[0],
        role: "customer",
        company_id: updatedClient.company_id || null,
        customer: {
          id: updatedClient.id,
          name: updatedClient.name || "",
          phone: updatedClient.phone || "",
          email: updatedClient.email || null,
          address: updatedClient.address || "",
          zip: updatedClient.zip || ""
        }
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER PROFILE UPDATE ERROR");
  }
});

router.get("/customer/requests", customerAuth, async (req, res) => {
  try {
    const client = await getClient(req.customer);
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!ensureCustomerCompanyIsolation(req.customer, client)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const scopedCustomer = {
      ...req.customer,
      company_id: req.customer.company_id || client.company_id || null
    };
    const requests = await getCustomerRequests(scopedCustomer);
    return res.json(requests);
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER REQUESTS ERROR");
  }
});

router.get("/customer/dashboard", customerAuth, async (req, res) => {
  try {
    const client = await getClient(req.customer);
    if (!client) return res.status(404).json({ error: "Customer not found" });
    if (!ensureCustomerCompanyIsolation(req.customer, client)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const scopedCustomer = {
      ...req.customer,
      company_id: req.customer.company_id || client.company_id
    };
    const [company, estimates, invoices, jobs, subscriptions] = await Promise.all([
      getCompany(scopedCustomer.company_id),
      getEstimates(scopedCustomer),
      getInvoices(scopedCustomer),
      getJobs(scopedCustomer),
      getSubscriptions(scopedCustomer)
    ]);
    const today = new Date().toISOString().split("T")[0];
    res.json({
      client,
      customer: client,
      company,
      estimates,
      invoices,
      jobs,
      upcoming_jobs: jobs.filter(job => String(job.date || "").split("T")[0] >= today && !["completed", "cancelled"].includes(job.status)),
      job_history: jobs.filter(job => String(job.date || "").split("T")[0] < today || ["completed", "cancelled"].includes(job.status)),
      subscriptions
    });
  } catch (err) {
    console.log("CUSTOMER DASHBOARD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/customer/estimates", customerAuth, async (req, res) => {
  try { res.json(await getEstimates(req.customer)); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/customer/estimates/:id/status", customerAuth, async (req, res) => {
  const status = req.body.status;
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  return updateCustomerEstimateStatus(req, res, status);
});

router.post("/customer/estimates/:id/approve", customerAuth, async (req, res) => {
  return updateCustomerEstimateStatus(req, res, "approved");
});

router.post("/customer/estimates/:id/reject", customerAuth, async (req, res) => {
  return updateCustomerEstimateStatus(req, res, "rejected");
});

router.post("/customer/service-requests", customerAuth, async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const client = await getClient(req.customer);
    if (!client) return res.status(404).json({ error: "Customer not found" });

    const service = String(req.body.service || "").trim();
    if (!service) return res.status(400).json({ error: "Service is required" });

    const visitDate = req.body.visit_date || new Date().toISOString().split("T")[0];
    const result = await pool.query(
      `INSERT INTO estimates
        (record_type, customer_name, phone, address, zip, service, notes, visit_date, status, company_id, client_id)
       VALUES
        ('lead', $1, $2, $3, $4, $5, $6, $7, 'new', $8, $9)
       RETURNING *`,
      [
        client.name || req.customer.name || "Customer",
        client.phone || "",
        client.address || "",
        client.zip || "",
        service,
        req.body.notes || "",
        visitDate,
        req.customer.company_id,
        req.customer.client_id
      ]
    );

    await logActivity({
      companyId: req.customer.company_id,
      userId: null,
      action: "customer_service_request_created",
      entityType: "lead",
      entityId: result.rows[0].id,
      details: {
        client_id: req.customer.client_id,
        service,
        visit_date: visitDate
      }
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.log("CUSTOMER SERVICE REQUEST ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/customer/invoices", customerAuth, async (req, res) => {
  try { res.json(await getInvoices(req.customer)); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/customer/invoices/:id", customerAuth, async (req, res) => {
  try {
    const invoice = await hydrateInvoice(req.customer.company_id, req.params.id);
    if (!invoice || String(invoice.client_id) !== String(req.customer.client_id)) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const payload = attachCustomerInvoicePresentation({
      ...invoice,
      line_items: safeJsonParse(invoice.line_items, invoice.line_items || [])
    });
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/customer/invoices/:id/pdf", customerAuth, async (req, res) => {
  try {
    const invoice = await hydrateInvoice(req.customer.company_id, req.params.id);
    if (!invoice || String(invoice.client_id) !== String(req.customer.client_id)) return res.status(404).json({ error: "Invoice not found" });

    const pdf = await generateInvoicePdf(invoice);
    const filename = buildInvoicePdfFilename(invoice);

    await logActivity({
      companyId: req.customer.company_id,
      userId: null,
      action: "customer_invoice_pdf_downloaded",
      entityType: "invoice",
      entityId: invoice.id,
      details: {
        client_id: req.customer.client_id,
        invoice_number: invoice.invoice_number || null
      }
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.log("CUSTOMER INVOICE PDF ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/customer/estimates/:id/pdf", customerAuth, async (req, res) => {
  try {
    const estimate = await getCustomerEstimate(req.customer, req.params.id);
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });

    const company = await getCompany(req.customer.company_id);
    const pdf = await generateEstimatePdf(estimate, company || {});
    const safeId = String(estimate.id).replace(/[^a-zA-Z0-9_-]/g, "-");

    await logActivity({
      companyId: req.customer.company_id,
      userId: null,
      action: "customer_estimate_pdf_downloaded",
      entityType: "estimate",
      entityId: estimate.id,
      details: {
        client_id: req.customer.client_id,
        status: estimate.status
      }
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="estimate-${safeId}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.log("CUSTOMER ESTIMATE PDF ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/customer/jobs", customerAuth, async (req, res) => {
  try { res.json(await getJobs(req.customer)); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/customer/subscriptions", customerAuth, async (req, res) => {
  try { res.json(await getSubscriptions(req.customer)); } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

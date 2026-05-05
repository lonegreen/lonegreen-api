const express = require("express");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { SECRET } = require("../config/env");
const {
  safeJsonParse,
  normalizeJobStatus,
  normalizeEstimateStatus,
  hydrateInvoice,
  ensureWorkflowSchema,
  ensureSubscriptionBillingSchema,
  logActivity
} = require("../services/routeHelpers");
const { generateInvoicePdf, generateEstimatePdf } = require("../services/pdfService");
const logger = require("../services/logger");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

const CUSTOMER_LOGIN_GENERIC_FAILURE = "Unable to sign in. Verify your client ID and phone number.";
const CUSTOMER_LOGIN_RATE_MESSAGE = "Too many sign-in attempts from this address. Please try again later.";
const CUSTOMER_LOGIN_LOCKOUT_MESSAGE = "Too many failed attempts. Please try again later.";

const customerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: CUSTOMER_LOGIN_RATE_MESSAGE }
});

const CUSTOMER_LOGIN_MAX_FAILURES = 8;
const CUSTOMER_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

const customerLoginFailures = new Map();

function customerLoginThrottleKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function getCustomerLoginGate(key) {
  const row = customerLoginFailures.get(key);
  if (!row) {
    return { lockedUntil: 0, fails: 0 };
  }
  const now = Date.now();
  if (row.lockedUntil && row.lockedUntil > now) {
    return row;
  }
  if (row.lockedUntil && row.lockedUntil <= now) {
    customerLoginFailures.delete(key);
    return { lockedUntil: 0, fails: 0 };
  }
  if (row.firstFailAt && now - row.firstFailAt > 15 * 60 * 1000) {
    customerLoginFailures.delete(key);
    return { lockedUntil: 0, fails: 0 };
  }
  return row;
}

function recordCustomerLoginFailure(key) {
  const now = Date.now();
  const prev = customerLoginFailures.get(key);
  if (!prev || !prev.firstFailAt || now - prev.firstFailAt > 15 * 60 * 1000) {
    customerLoginFailures.set(key, {
      fails: 1,
      firstFailAt: now,
      lockedUntil: 0
    });
    logger.warn("CUSTOMER PORTAL LOGIN FAILED", {
      ip: key,
      failures: 1
    });
    return;
  }

  const fails = prev.fails + 1;
  let lockedUntil = prev.lockedUntil || 0;

  if (fails >= CUSTOMER_LOGIN_MAX_FAILURES) {
    lockedUntil = now + CUSTOMER_LOGIN_LOCKOUT_MS;
    logger.warn("CUSTOMER PORTAL LOCKOUT", {
      ip: key,
      failures: fails
    });
  } else {
    logger.warn("CUSTOMER PORTAL LOGIN FAILED", {
      ip: key,
      failures: fails
    });
  }

  customerLoginFailures.set(key, {
    fails,
    firstFailAt: prev.firstFailAt,
    lockedUntil
  });
}

function clearCustomerLoginFailures(key) {
  customerLoginFailures.delete(key);
}

function portalEstimateStatus(status) {
  return status === "converted" ? "converted" : normalizeEstimateStatus(status);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 24 ? digits.slice(0, 24) : digits;
}

function signCustomerToken(client) {
  return jwt.sign({
    portal: "customer",
    client_id: client.id,
    company_id: client.company_id,
    name: client.name || "Customer"
  }, SECRET, { expiresIn: "14d" });
}

function customerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const parts = String(header).trim().split(/\s+/);
  const token = parts.length === 2 && parts[0] === "Bearer" ? parts[1] : "";
  if (!token) return res.status(401).json({ error: "Customer login required" });

  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.portal !== "customer" || !decoded.client_id || !decoded.company_id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.customer = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid customer token" });
  }
}

async function getClient(customer) {
  const result = await pool.query("SELECT * FROM clients WHERE id=$1 AND company_id=$2 LIMIT 1", [customer.client_id, customer.company_id]);
  return result.rows[0] || null;
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
      invoices.push({ ...invoice, line_items: safeJsonParse(invoice.line_items, invoice.line_items || []) });
    }
  }
  return invoices;
}

router.post("/customer/login", customerLoginLimiter, async (req, res) => {
  const throttleKey = customerLoginThrottleKey(req);

  try {
    const gate = getCustomerLoginGate(throttleKey);
    if (gate.lockedUntil > Date.now()) {
      return res.status(429).json({ error: CUSTOMER_LOGIN_LOCKOUT_MESSAGE });
    }

    const clientId = Number(req.body.client_id);
    const phone = normalizePhone(req.body.phone);
    if (!clientId || !phone) {
      return res.status(400).json({ error: "Client ID and phone are required" });
    }

    const clientCheck = await pool.query("SELECT id, company_id FROM clients WHERE id=$1 LIMIT 1", [clientId]);
    if (!clientCheck.rows.length) {
      recordCustomerLoginFailure(throttleKey);
      return res.status(401).json({ error: CUSTOMER_LOGIN_GENERIC_FAILURE });
    }

    const companyId = clientCheck.rows[0].company_id;

    const result = await pool.query(
      "SELECT * FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [clientId, companyId]
    );
    const client = result.rows[0];
    if (!client || normalizePhone(client.phone) !== phone) {
      recordCustomerLoginFailure(throttleKey);
      return res.status(401).json({ error: CUSTOMER_LOGIN_GENERIC_FAILURE });
    }

    clearCustomerLoginFailures(throttleKey);
    res.json({
      token: signCustomerToken(client),
      customer: { id: client.id, name: client.name, phone: client.phone }
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER LOGIN ERROR");
  }
});

router.get("/customer/dashboard", customerAuth, async (req, res) => {
  try {
    const [client, company, estimates, invoices, jobs, subscriptions] = await Promise.all([
      getClient(req.customer),
      getCompany(req.customer.company_id),
      getEstimates(req.customer),
      getInvoices(req.customer),
      getJobs(req.customer),
      getSubscriptions(req.customer)
    ]);
    if (!client) return res.status(404).json({ error: "Customer not found" });
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
    if (!invoice || String(invoice.client_id) !== String(req.customer.client_id)) return res.status(404).json({ error: "Invoice not found" });
    res.json({ ...invoice, line_items: safeJsonParse(invoice.line_items, invoice.line_items || []) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/customer/invoices/:id/pdf", customerAuth, async (req, res) => {
  try {
    const invoice = await hydrateInvoice(req.customer.company_id, req.params.id);
    if (!invoice || String(invoice.client_id) !== String(req.customer.client_id)) return res.status(404).json({ error: "Invoice not found" });

    const pdf = await generateInvoicePdf(invoice);
    const number = invoice.invoice_number || invoice.id;
    const safeNumber = String(number).replace(/[^a-zA-Z0-9_-]/g, "-");

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
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${safeNumber}.pdf"`);
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

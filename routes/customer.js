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
const {
  resolveCustomerAccountId,
  loadPortalScopes,
  scopePairsInclude
} = require("../services/customerPortalScope");

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
    return (async () => {
      try {
        const accountId = await resolveCustomerAccountId(req.customer);
        if (!accountId) {
          return res.status(403).json({ error: "Customer account not found" });
        }
        const statusResult = await pool.query(
          `
          SELECT status, deactivated_at
          FROM customer_accounts
          WHERE id = $1
          LIMIT 1
          `,
          [accountId]
        );
        const row = statusResult.rows[0];
        if (!row) {
          return res.status(403).json({ error: "Customer account not found" });
        }
        const status = String(row.status || "").trim().toLowerCase();
        if (row.deactivated_at || status === "deactivated") {
          return res.status(403).json({ error: "Customer account is deactivated" });
        }
        if (status === "suspended") {
          return res.status(403).json({ error: "Customer account is suspended" });
        }
        return next();
      } catch (err) {
        return sendSafeServerError(res, err, "CUSTOMER AUTH STATUS CHECK ERROR");
      }
    })();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || "Invalid customer token" });
  }
}

async function getClient(customer) {
  const result = await pool.query("SELECT * FROM clients WHERE id=$1 LIMIT 1", [customer.client_id]);
  return result.rows[0] || null;
}

async function getPortalContext(customer) {
  const accountId = await resolveCustomerAccountId(customer);
  let scopes = accountId ? await loadPortalScopes(accountId) : [];
  if (!scopes.length && customer.client_id) {
    const client = await pool.query(
      "SELECT id, company_id FROM clients WHERE id = $1 LIMIT 1",
      [customer.client_id]
    );
    const row = client.rows[0];
    if (row && row.company_id) {
      scopes = [{
        company_id: Number(row.company_id),
        client_id: Number(row.id)
      }];
    }
  }
  return { accountId, scopes };
}

function portalScopeAllows(customer, clientRow, scopes) {
  if (!clientRow) {
    return false;
  }
  if (scopes.length) {
    return scopePairsInclude(scopes, clientRow.company_id, clientRow.id);
  }
  return ensureCustomerCompanyIsolation(customer, clientRow);
}

async function hydrateInvoiceForScopes(scopes, invoiceId) {
  const cleanId = Number(invoiceId);
  if (!Number.isInteger(cleanId) || cleanId <= 0) {
    return null;
  }
  for (const s of scopes) {
    const inv = await hydrateInvoice(s.company_id, cleanId);
    if (inv && Number(inv.client_id) === Number(s.client_id)) {
      return inv;
    }
  }
  return null;
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

async function getCustomerRequests(scopes) {
  await ensureWorkflowSchema();
  if (!scopes.length) {
    return [];
  }
  const parts = [];
  const params = [];
  let p = 1;
  for (const s of scopes) {
    parts.push(`(company_id = $${p} AND client_id = $${p + 1})`);
    params.push(s.company_id, s.client_id);
    p += 2;
  }
  const result = await pool.query(
    `
    SELECT id, service, status, visit_date, notes, created_at
    FROM estimates
    WHERE (${parts.join(" OR ")})
      AND record_type = 'lead'
      AND COALESCE(archived, FALSE) = FALSE
    ORDER BY created_at DESC, id DESC
    `,
    params
  );
  return result.rows;
}

async function getCompany(companyId) {
  const result = await pool.query("SELECT id, name, phone, email, address, service_area, business_hours FROM companies WHERE id=$1 LIMIT 1", [companyId]);
  return result.rows[0] || null;
}

async function getEstimates(scopes) {
  await ensureWorkflowSchema();
  if (!scopes.length) {
    return [];
  }
  const parts = [];
  const params = [];
  let p = 1;
  for (const s of scopes) {
    parts.push(`(company_id = $${p} AND (client_id = $${p + 1} OR converted_client_id = $${p + 1}))`);
    params.push(s.company_id, s.client_id);
    p += 2;
  }
  const result = await pool.query(
    "SELECT id, client_id, customer_name, phone, address, zip, service, status, quoted_price, visit_date, notes, created_at, company_id " +
      "FROM estimates WHERE record_type = 'estimate' AND COALESCE(archived, FALSE) = FALSE AND (" +
      parts.join(" OR ") +
      ") ORDER BY id DESC",
    params
  );
  return result.rows.map(item => ({ ...item, status: portalEstimateStatus(item.status) }));
}

async function getCustomerEstimate(scopes, id) {
  await ensureWorkflowSchema();
  const estimateId = Number(id);
  if (!Number.isInteger(estimateId) || estimateId <= 0 || !scopes.length) {
    return null;
  }
  const { parts, params } = buildEstimateScopeFilter(scopes, 2);
  params.unshift(estimateId);
  const result = await pool.query(
    `SELECT *
     FROM estimates
     WHERE id = $1
       AND record_type = 'estimate'
       AND (${parts.join(" OR ")})
     LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

function buildEstimateScopeFilter(scopes, startParam) {
  const parts = [];
  const params = [];
  let p = startParam;
  for (const s of scopes) {
    parts.push(`(company_id = $${p} AND (client_id = $${p + 1} OR converted_client_id = $${p + 1}))`);
    params.push(s.company_id, s.client_id);
    p += 2;
  }
  return { parts, params };
}

async function updateCustomerEstimateStatus(req, res, status) {
  try {
    const { scopes } = await getPortalContext(req.customer);
    const estimate = await getCustomerEstimate(scopes, req.params.id);
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });

    if (
      estimate.status === "converted" ||
      estimate.converted_job_id ||
      estimate.converted_client_id
    ) {
      return res.status(400).json({ error: "Estimate is already converted" });
    }

    const estimateId = Number(req.params.id);
    if (!Number.isInteger(estimateId) || estimateId <= 0) {
      return res.status(400).json({ error: "Invalid estimate id" });
    }

    const { parts, params } = buildEstimateScopeFilter(scopes, 3);
    const result = await pool.query(
      `UPDATE estimates
       SET status = $1
       WHERE id = $2
         AND record_type = 'estimate'
         AND (${parts.join(" OR ")})
       RETURNING *`,
      [status, estimateId, ...params]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    await logActivity({
      companyId: estimate.company_id,
      userId: null,
      action: status === "approved" ? "customer_estimate_approved" : "customer_estimate_rejected",
      entityType: "estimate",
      entityId: result.rows[0].id,
      details: {
        client_id: estimate.client_id,
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

async function getJobs(scopes) {
  if (!scopes.length) {
    return [];
  }
  const parts = [];
  const params = [];
  let p = 1;
  for (const s of scopes) {
    parts.push(`(jobs.company_id = $${p} AND jobs.client_id = $${p + 1})`);
    params.push(s.company_id, s.client_id);
    p += 2;
  }
  const result = await pool.query(
    "SELECT jobs.id, jobs.client_id, jobs.service, jobs.type, jobs.date, jobs.start_time, jobs.end_time, jobs.status, jobs.price, jobs.payment_status, jobs.internal_notes, workers.name AS worker_name " +
      "FROM jobs LEFT JOIN workers ON workers.id = jobs.worker_id AND workers.company_id = jobs.company_id WHERE (" +
      parts.join(" OR ") +
      ") ORDER BY jobs.date DESC, jobs.start_time DESC, jobs.id DESC",
    params
  );
  return result.rows.map(item => ({ ...item, status: normalizeJobStatus(item.status) }));
}

async function getSubscriptions(scopes) {
  await ensureSubscriptionBillingSchema();
  if (!scopes.length) {
    return [];
  }
  const parts = [];
  const params = [];
  let p = 1;
  for (const s of scopes) {
    parts.push(`(subscriptions.company_id = $${p} AND subscriptions.client_id = $${p + 1})`);
    params.push(s.company_id, s.client_id);
    p += 2;
  }
  const result = await pool.query(
    "SELECT subscriptions.*, workers.name AS worker_name FROM subscriptions LEFT JOIN workers ON workers.id = subscriptions.worker_id AND workers.company_id = subscriptions.company_id WHERE (" +
      parts.join(" OR ") +
      ") ORDER BY subscriptions.id DESC",
    params
  );
  return result.rows;
}

async function getInvoices(scopes) {
  if (!scopes.length) {
    return [];
  }
  const invoices = [];
  const seen = new Set();
  for (const s of scopes) {
    const result = await pool.query(
      "SELECT id FROM invoices WHERE company_id=$1 AND client_id=$2 ORDER BY id DESC",
      [s.company_id, s.client_id]
    );
    for (const row of result.rows) {
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      const invoice = await hydrateInvoice(s.company_id, row.id);
      if (invoice && String(invoice.client_id) === String(s.client_id)) {
        const parsed = attachCustomerInvoicePresentation({
          ...invoice,
          line_items: safeJsonParse(invoice.line_items, invoice.line_items || [])
        });
        if (parsed) {
          invoices.push(parsed);
        }
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
    const { scopes } = await getPortalContext(req.customer);
    const client = await getClient(req.customer);
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!portalScopeAllows(req.customer, client, scopes)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const accountId = await resolveCustomerAccountId(req.customer);
    let account = null;
    if (accountId) {
      const accountResult = await pool.query(
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
        WHERE id = $1
        LIMIT 1
        `,
        [accountId]
      );
      account = accountResult.rows[0] || null;
    }
    if (!account) {
      account = await getCustomerAccountByClient(client.id);
    }
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
    const { scopes } = await getPortalContext(req.customer);
    const client = await getClient(req.customer);
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!portalScopeAllows(req.customer, client, scopes)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const accountId = await resolveCustomerAccountId(req.customer);
    let account = null;
    if (accountId) {
      const accountResult = await pool.query(
        "SELECT id, client_id, email, first_name, last_name, phone, is_verified, created_at, updated_at FROM customer_accounts WHERE id = $1 LIMIT 1",
        [accountId]
      );
      account = accountResult.rows[0] || null;
    }
    if (!account) {
      account = await getCustomerAccountByClient(client.id);
    }
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

    // P1 isolation fix: customer profile edits update customer_accounts ONLY.
    // Companies own the canonical clients.* CRM record; portal must never overwrite
    // name/phone/email/address on the company's client row.
    const updatedAccountResult = await pool.query(
      `
      UPDATE customer_accounts
      SET
        first_name = $2,
        last_name = $3,
        phone = $4,
        email = $5,
        address = $6,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, client_id, email, first_name, last_name, phone, address, is_verified, created_at, updated_at
      `,
      [account.id, firstName, lastName, phone, email, address || null]
    );

    const updatedAccount = updatedAccountResult.rows[0];

    return res.json({
      profile: {
        ...updatedAccount,
        role: "customer",
        company_id: client.company_id || null,
        customer: {
          id: client.id,
          name: client.name || "",
          phone: client.phone || "",
          email: client.email || null,
          address: client.address || "",
          zip: client.zip || ""
        }
      }
    });
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER PROFILE UPDATE ERROR");
  }
});

router.get("/customer/requests", customerAuth, async (req, res) => {
  try {
    const { scopes } = await getPortalContext(req.customer);
    const client = await getClient(req.customer);
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!portalScopeAllows(req.customer, client, scopes)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const requests = await getCustomerRequests(scopes);
    return res.json(requests);
  } catch (err) {
    sendSafeServerError(res, err, "CUSTOMER REQUESTS ERROR");
  }
});

router.get("/customer/dashboard", customerAuth, async (req, res) => {
  try {
    const { scopes } = await getPortalContext(req.customer);
    const client = await getClient(req.customer);
    if (!client) return res.status(404).json({ error: "Customer not found" });
    if (!portalScopeAllows(req.customer, client, scopes)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const primaryScope = scopes.find(s => Number(s.client_id) === Number(req.customer.client_id))
      || scopes[0];
    const [company, estimates, invoices, jobs, subscriptions] = await Promise.all([
      primaryScope ? getCompany(primaryScope.company_id) : Promise.resolve(null),
      getEstimates(scopes),
      getInvoices(scopes),
      getJobs(scopes),
      getSubscriptions(scopes)
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
  try {
    const { scopes } = await getPortalContext(req.customer);
    res.json(await getEstimates(scopes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    if (!client.company_id) return res.status(403).json({ error: "Forbidden" });
    if (req.customer.company_id && String(req.customer.company_id) !== String(client.company_id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

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
        client.company_id,
        client.id
      ]
    );

    await logActivity({
      companyId: client.company_id,
      userId: null,
      action: "customer_service_request_created",
      entityType: "lead",
      entityId: result.rows[0].id,
      details: {
        client_id: client.id,
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
  try {
    const { scopes } = await getPortalContext(req.customer);
    res.json(await getInvoices(scopes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/customer/invoices/:id", customerAuth, async (req, res) => {
  try {
    const { scopes } = await getPortalContext(req.customer);
    const invoice = await hydrateInvoiceForScopes(scopes, req.params.id);
    if (!invoice) {
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
    const { scopes } = await getPortalContext(req.customer);
    const invoice = await hydrateInvoiceForScopes(scopes, req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const pdf = await generateInvoicePdf(invoice);
    const filename = buildInvoicePdfFilename(invoice);

    await logActivity({
      companyId: invoice.company_id,
      userId: null,
      action: "customer_invoice_pdf_downloaded",
      entityType: "invoice",
      entityId: invoice.id,
      details: {
        client_id: invoice.client_id,
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
    const { scopes } = await getPortalContext(req.customer);
    const estimate = await getCustomerEstimate(scopes, req.params.id);
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });

    const company = await getCompany(estimate.company_id);
    const pdf = await generateEstimatePdf(estimate, company || {});
    const safeId = String(estimate.id).replace(/[^a-zA-Z0-9_-]/g, "-");

    await logActivity({
      companyId: estimate.company_id,
      userId: null,
      action: "customer_estimate_pdf_downloaded",
      entityType: "estimate",
      entityId: estimate.id,
      details: {
        client_id: estimate.client_id,
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
  try {
    const { scopes } = await getPortalContext(req.customer);
    res.json(await getJobs(scopes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/customer/subscriptions", customerAuth, async (req, res) => {
  try {
    const { scopes } = await getPortalContext(req.customer);
    res.json(await getSubscriptions(scopes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

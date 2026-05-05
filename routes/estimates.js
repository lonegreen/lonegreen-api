const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { generateEstimatePdf } = require("../services/pdfService");
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

const router = express.Router();

async function resolveCompanyWorkerId(companyId, workerId) {
  if (workerId === undefined || workerId === null || String(workerId).trim() === "") {
    return { ok: true, workerId: null };
  }

  const parsedWorkerId = Number(workerId);
  if (!Number.isInteger(parsedWorkerId) || parsedWorkerId <= 0) {
    return { ok: false };
  }

  const worker = await pool.query(
    "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
    [parsedWorkerId, companyId]
  );

  if (worker.rows.length === 0) {
    return { ok: false };
  }

  return { ok: true, workerId: parsedWorkerId };
}

router.get("/workflow/estimates", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const result = await pool.query(`
      SELECT estimates.*, clients.name AS client_name
      FROM estimates
      LEFT JOIN clients ON estimates.client_id = clients.id AND clients.company_id = estimates.company_id
      WHERE estimates.company_id = $1
        AND estimates.record_type = 'estimate'
        AND COALESCE(estimates.archived, FALSE) = FALSE
      ORDER BY estimates.id DESC
    `, [req.user.company_id]);

    res.json(result.rows);
  } catch (err) {
    console.log("WORKFLOW ESTIMATES ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.get("/workflow/estimates/:id/pdf", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const estimate = await getEstimate(req.user.company_id, req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const companyResult = await pool.query(
      "SELECT id, name, phone, email, address FROM companies WHERE id=$1 LIMIT 1",
      [req.user.company_id]
    );
    const company = companyResult.rows[0] || {};
    const pdf = await generateEstimatePdf(estimate, company);
    const filename = `estimate-${String(estimate.id).replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "estimate_pdf_downloaded",
      entityType: "estimate",
      entityId: Number(req.params.id),
      details: {
        estimate_id: estimate.id,
        client_id: estimate.client_id || null,
        status: estimate.status || null
      }
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.log("ESTIMATE PDF ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.put("/workflow/estimates/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const estimate = await getEstimate(req.user.company_id, req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const allowedStatuses = [
      "new",
      "contacted",
      "quoted",
      "approved",
      "rejected",
      "converted"
    ];

    const status = req.body.status !== undefined ? String(req.body.status) : estimate.status;

    if (req.body.status !== undefined && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    if (req.body.client_id) {
      const clientCheck = await pool.query(
        "SELECT id FROM clients WHERE id=$1 AND company_id=$2 LIMIT 1",
        [req.body.client_id, req.user.company_id]
      );

      if (clientCheck.rows.length === 0) {
        return res.status(400).json({ error: "Client not found in this company" });
      }
    }

    const payload = {
      customer_name: req.body.customer_name || estimate.customer_name || "",
      phone: req.body.phone || estimate.phone || "",
      address: req.body.address || estimate.address || "",
      zip: req.body.zip || estimate.zip || "",
      service: req.body.service || estimate.service || "",
      visit_date: req.body.visit_date || estimate.visit_date,
      quoted_price: req.body.quoted_price !== undefined ? req.body.quoted_price : estimate.quoted_price,
      notes: req.body.notes !== undefined ? req.body.notes : estimate.notes,
      status,
      client_id: req.body.client_id !== undefined ? req.body.client_id : estimate.client_id
    };

    const result = await pool.query(`
      UPDATE estimates
      SET client_id = $1,
          customer_name = $2,
          phone = $3,
          address = $4,
          zip = $5,
          service = $6,
          visit_date = $7,
          quoted_price = $8,
          notes = $9,
          status = $10
      WHERE id = $11 AND company_id = $12 AND record_type = 'estimate'
      RETURNING *
    `, [
      payload.client_id || null,
      payload.customer_name,
      payload.phone,
      payload.address,
      payload.zip,
      payload.service,
      payload.visit_date,
      payload.quoted_price || 0,
      payload.notes || "",
      payload.status,
      req.params.id,
      req.user.company_id
    ]);

    const changed = pickChangedFields(estimate, result.rows[0], [
      "client_id",
      "customer_name",
      "phone",
      "address",
      "zip",
      "service",
      "visit_date",
      "quoted_price",
      "notes",
      "status"
    ]);

    await logChange({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "estimate_updated",
      entityType: "estimate",
      entityId: Number(req.params.id),
      before: changed.before,
      after: changed.after,
      metadata: { changed_fields: Object.keys(changed.after) }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("WORKFLOW UPDATE ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.put("/workflow/estimates/:id/archive", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const estimate = await getEstimate(req.user.company_id, req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const result = await pool.query(`
      UPDATE estimates
      SET archived = TRUE
      WHERE id = $1 AND company_id = $2 AND record_type = 'estimate'
      RETURNING *
    `, [req.params.id, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "estimate_archived",
      entityType: "estimate",
      entityId: Number(req.params.id),
      details: {
        status: estimate.status,
        service: estimate.service
      }
    });

    res.json({ ...result.rows[0], message: "Estimate archived." });
  } catch (err) {
    console.log("WORKFLOW ARCHIVE ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.delete("/workflow/estimates/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const estimate = await getEstimate(req.user.company_id, req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const status = normalizeEstimateStatus(estimate.status);
    const linked = await pool.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM jobs
          WHERE estimate_id = $1 AND company_id = $2
          LIMIT 1
        ) AS has_jobs,
        EXISTS (
          SELECT 1
          FROM invoices
          WHERE estimate_id = $1 AND company_id = $2
          LIMIT 1
        ) AS has_invoices,
        EXISTS (
          SELECT 1
          FROM payments
          JOIN invoices ON invoices.id = payments.invoice_id
            AND invoices.company_id = payments.company_id
          WHERE invoices.estimate_id = $1
            AND payments.company_id = $2
          LIMIT 1
        ) AS has_payments
    `, [req.params.id, req.user.company_id]);

    const linkedRow = linked.rows[0] || {};
    const hasLinkedRecords = Boolean(
      estimate.client_id ||
      estimate.converted_client_id ||
      estimate.converted_job_id ||
      estimate.source_lead_id ||
      linkedRow.has_jobs ||
      linkedRow.has_invoices ||
      linkedRow.has_payments ||
      ["approved", "converted"].includes(status)
    );

    if (hasLinkedRecords) {
      await pool.query(`
        UPDATE estimates
        SET archived = TRUE
        WHERE id = $1 AND company_id = $2 AND record_type = 'estimate'
      `, [req.params.id, req.user.company_id]);

      await logActivity({
        companyId: req.user.company_id,
        userId: req.user.id,
        action: "estimate_archived",
        entityType: "estimate",
        entityId: Number(req.params.id),
        details: {
          status: estimate.status,
          service: estimate.service,
          reason: "linked_records"
        }
      });

      return res.json({
        success: true,
        message: "Estimate archived.",
        notice: "Estimate has linked records. Archive instead."
      });
    }

    const result = await pool.query(`
      DELETE FROM estimates
      WHERE id = $1 AND company_id = $2 AND record_type = 'estimate'
    `, [req.params.id, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "estimate_deleted",
      entityType: "estimate",
      entityId: Number(req.params.id),
      details: {
        status: estimate.status,
        service: estimate.service
      }
    });

    res.json({ ok: true, message: "Estimate deleted." });
  } catch (err) {
    console.log("WORKFLOW DELETE ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.post("/workflow/estimates/:id/convert-to-client", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const estimate = await getEstimate(req.user.company_id, req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    let client = estimate.client_id ? await getClientById(req.user.company_id, estimate.client_id) : null;
    if (!client) {
      client = await createClientFromContact(req.user.company_id, {
        name: estimate.customer_name,
        phone: estimate.phone,
        address: estimate.address,
        zip: estimate.zip,
        notes: estimate.notes
      });
    }

    const result = await pool.query(`
      UPDATE estimates
      SET client_id = $1,
          converted_client_id = $1,
          converted_at = COALESCE(converted_at, CURRENT_TIMESTAMP)
      WHERE id = $2 AND company_id = $3 AND record_type = 'estimate'
      RETURNING *
    `, [client.id, estimate.id, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "estimate_converted_to_client",
      entityType: "estimate",
      entityId: estimate.id,
      details: {
        source_estimate_id: estimate.id,
        client_id: client.id,
        status: result.rows[0].status
      }
    });

    res.json({ client, estimate: result.rows[0] });
  } catch (err) {
    console.log("ESTIMATE TO CLIENT ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});
router.post("/workflow/estimates/:id/convert-to-job", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const estimate = await getEstimate(req.user.company_id, req.params.id);

    if (!estimate) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const existingJob = await pool.query(
      `SELECT *
       FROM jobs
       WHERE company_id = $1
         AND (estimate_id = $2 OR id = $3)
       ORDER BY id DESC
       LIMIT 1`,
      [req.user.company_id, estimate.id, estimate.converted_job_id || 0]
    );

    if (existingJob.rows.length > 0) {
      const existingClient = existingJob.rows[0].client_id
        ? await getClientById(req.user.company_id, existingJob.rows[0].client_id)
        : null;

      return res.json({ client: existingClient, job: existingJob.rows[0] });
    }

    if (normalizeEstimateStatus(estimate.status) !== "approved") {
      return res.status(400).json({ error: "Only approved estimates can be converted to jobs" });
    }

    let client = estimate.client_id ? await getClientById(req.user.company_id, estimate.client_id) : null;
    if (client && client.archived === true) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }
    if (!client) {
      client = await createClientFromContact(req.user.company_id, {
        name: estimate.customer_name,
        phone: estimate.phone,
        address: estimate.address,
        zip: estimate.zip,
        notes: estimate.notes
      });
    }

    const workerLookup = await resolveCompanyWorkerId(req.user.company_id, req.body.worker_id);
    if (!workerLookup.ok) {
      return res.status(400).json({ error: "Worker not found in this company" });
    }

    const job = await pool.query(`
      INSERT INTO jobs
      (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, payment_status, internal_notes, status_reason, estimate_id)
      VALUES ($1,$2,'one_time_job',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      client.id,
      req.body.service || estimate.service,
      req.body.date || estimate.visit_date,
      req.body.start_time || "08:00",
      req.body.end_time || "09:00",
      normalizeJobStatus(req.body.status || "scheduled"),
      workerLookup.workerId,
      req.body.price || estimate.quoted_price || 0,
      req.user.company_id,
      normalizePaymentStatus(req.body.payment_status, "one_time_job"),
      req.body.internal_notes || estimate.notes || "",
      req.body.status_reason || "",
      estimate.id
    ]);

    await pool.query(`
      UPDATE estimates
      SET client_id = $1,
          converted_client_id = $1,
          converted_job_id = $2,
          status = 'converted',
          converted_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND company_id = $4 AND record_type = 'estimate'
    `, [client.id, job.rows[0].id, estimate.id, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "estimate_converted_to_job",
      entityType: "estimate",
      entityId: estimate.id,
      details: {
        source_estimate_id: estimate.id,
        job_id: job.rows[0].id,
        client_id: client.id,
        service: job.rows[0].service
      }
    });

    res.json({ client, job: job.rows[0] });
  } catch (err) {
    console.log("ESTIMATE TO JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});


/* ================= ESTIMATES ================= */

router.get("/estimates", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/estimates", "/workflow/estimates");
    await ensureEstimateSchema();
    const company_id = req.user.company_id;

    const result = await pool.query(`
      SELECT
        estimates.*,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address
      FROM estimates
      LEFT JOIN clients ON estimates.client_id = clients.id AND clients.company_id = estimates.company_id
      WHERE estimates.company_id = $1
      ORDER BY estimates.id DESC
    `, [company_id]);

    res.json(result.rows);
  } catch (err) {
    console.log("GET ESTIMATES ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.post("/estimates", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureEstimateSchema();
    const {
      client_id,
      customer_name,
      phone,
      address,
      zip,
      service,
      quoted_price,
      visit_date,
      notes,
      status
    } = req.body;
    const company_id = req.user.company_id;

    if (client_id) {
      const clientCheck = await pool.query(
        "SELECT id FROM clients WHERE id=$1 AND company_id=$2 LIMIT 1",
        [client_id, company_id]
      );

      if (clientCheck.rows.length === 0) {
        return res.status(400).json({ error: "Client not found in this company" });
      }
    }

    let leadName = customer_name;
    let leadPhone = phone;
    let leadAddress = address;
    let leadZip = zip;

    if (client_id && (!leadName || !leadPhone || !leadAddress || !leadZip)) {
      const clientLookup = await pool.query(`
        SELECT name, phone, address, zip
        FROM clients
        WHERE id = $1 AND company_id = $2
      `, [client_id, company_id]);

      if (clientLookup.rows.length > 0) {
        const client = clientLookup.rows[0];
        leadName = leadName || client.name || "";
        leadPhone = leadPhone || client.phone || "";
        leadAddress = leadAddress || client.address || "";
        leadZip = leadZip || client.zip || "";
      }
    }

    if (!leadName || !leadPhone || !leadAddress || !service || !visit_date) {
      return res.status(400).json({ error: "Missing data" });
    }

    const result = await pool.query(`
      INSERT INTO estimates
      (client_id, customer_name, phone, address, zip, service, status, quoted_price, visit_date, notes, company_id, record_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'estimate')
      RETURNING *
    `, [
      client_id || null,
      leadName,
      leadPhone,
      leadAddress,
      leadZip || "",
      service,
      status || "new",
      quoted_price || 0,
      visit_date,
      notes || "",
      company_id
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.put("/estimates/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureEstimateSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;
    const {
      client_id,
      customer_name,
      phone,
      address,
      zip,
      service,
      quoted_price,
      visit_date,
      status,
      notes
    } = req.body;

    const allowedStatuses = [
      "new",
      "contacted",
      "quoted",
      "approved",
      "rejected",
      "converted"
    ];

    if (client_id) {
      const clientCheck = await pool.query(
        "SELECT id FROM clients WHERE id=$1 AND company_id=$2 LIMIT 1",
        [client_id, company_id]
      );

      if (clientCheck.rows.length === 0) {
        return res.status(400).json({ error: "Client not found in this company" });
      }
    }

    let leadName = customer_name;
    let leadPhone = phone;
    let leadAddress = address;
    let leadZip = zip;

    if (client_id && (!leadName || !leadPhone || !leadAddress || !leadZip)) {
      const clientLookup = await pool.query(`
        SELECT name, phone, address, zip
        FROM clients
        WHERE id = $1 AND company_id = $2
      `, [client_id, company_id]);

      if (clientLookup.rows.length > 0) {
        const client = clientLookup.rows[0];
        leadName = leadName || client.name || "";
        leadPhone = leadPhone || client.phone || "";
        leadAddress = leadAddress || client.address || "";
        leadZip = leadZip || client.zip || "";
      }
    }

    if (!leadName || !leadPhone || !leadAddress || !service || !visit_date || !status) {
      return res.status(400).json({ error: "Missing data" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const before = await pool.query(`
      SELECT id, status
      FROM estimates
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [id, company_id]);

    if (before.rows.length === 0) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const result = await pool.query(`
      UPDATE estimates
      SET
        client_id = $1,
        customer_name = $2,
        phone = $3,
        address = $4,
        zip = $5,
        service = $6,
        quoted_price = $7,
        visit_date = $8,
        status = $9,
        notes = $10
      WHERE id = $11 AND company_id = $12
      RETURNING *
    `, [
      client_id || null,
      leadName,
      leadPhone,
      leadAddress,
      leadZip || "",
      service,
      quoted_price || 0,
      visit_date,
      status,
      notes || "",
      id,
      company_id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    await logChange({
      companyId: company_id,
      userId: req.user.id,
      action: "estimate_status_changed",
      entityType: "estimate",
      entityId: Number(id),
      before: { status: before.rows[0].status },
      after: { status: result.rows[0].status },
      metadata: {}
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("UPDATE ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.put("/estimates/:id/status", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureEstimateSchema();
    const id = req.params.id;
    const { status } = req.body;
    const company_id = req.user.company_id;

    const allowedStatuses = [
      "new",
      "contacted",
      "quoted",
      "approved",
      "rejected",
      "converted"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await pool.query(`
      UPDATE estimates
      SET status = $1
      WHERE id = $2 AND company_id = $3
      RETURNING *
    `, [status, id, company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log("UPDATE ESTIMATE STATUS ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.delete("/estimates/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureEstimateSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;

    const existing = await pool.query(`
      SELECT id, status, record_type
      FROM estimates
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [id, company_id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const current = existing.rows[0];
    await pool.query(
      "UPDATE estimates SET archived=TRUE WHERE id=$1 AND company_id=$2",
      [id, company_id]
    );

    res.json({ success: true, message: "Archived." });
  } catch (err) {
    console.log("DELETE ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.post("/estimates/:id/convert-to-job", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureEstimateSchema();
    const id = req.params.id;
    const { date, start_time, end_time, worker_id, price } = req.body;
    const company_id = req.user.company_id;

    const estimate = await pool.query(`
      SELECT * FROM estimates
      WHERE id = $1 AND company_id = $2
    `, [id, company_id]);

    if (estimate.rows.length === 0) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const e = estimate.rows[0];

    if (e.status === "converted") {
      return res.status(400).json({ error: "Estimate already converted to job" });
    }

    if (e.status !== "approved") {
      return res.status(400).json({ error: "Estimate must be approved before conversion" });
    }

    const existingJob = await pool.query(
      "SELECT * FROM jobs WHERE estimate_id=$1 AND company_id=$2 LIMIT 1",
      [id, company_id]
    );

    if (existingJob.rows.length > 0) {
      return res.json(existingJob.rows[0]);
    }

    let resolvedClientId = e.client_id;

    if (!resolvedClientId) {
      const clientResult = await pool.query(`
        INSERT INTO clients (name, phone, address, zip, company_id)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
      `, [
        e.customer_name || "New Lead",
        e.phone || "",
        e.address || "",
        e.zip || "",
        company_id
      ]);

      resolvedClientId = clientResult.rows[0].id;
    }

    const activeClient = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [resolvedClientId, company_id]
    );

    if (activeClient.rows.length === 0) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    const workerLookup = await resolveCompanyWorkerId(company_id, worker_id);
    if (!workerLookup.ok) {
      return res.status(400).json({ error: "Worker not found in this company" });
    }

    const jobResult = await pool.query(`
      INSERT INTO jobs
      (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, payment_status, internal_notes, estimate_id)
      VALUES ($1,$2,'one_time_job',$3,$4,$5,'scheduled',$6,$7,$8,'unpaid',$9,$10)
      RETURNING *
    `, [
      resolvedClientId,
      e.service,
      date,
      start_time || "08:00",
      end_time || "09:00",
      workerLookup.workerId,
      price || e.quoted_price || 0,
      company_id,
      e.notes || "",
      id
    ]);

    await pool.query(`
      UPDATE estimates
      SET status = 'converted',
          client_id = $3,
          converted_client_id = $3,
          converted_job_id = $4,
          converted_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND company_id = $2
    `, [id, company_id, resolvedClientId, jobResult.rows[0].id]);

    res.json(jobResult.rows[0]);
  } catch (err) {
    console.log("CONVERT ESTIMATE TO JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});

router.post("/estimates/:id/convert-to-subscription", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureEstimateSchema();
    await ensureSubscriptionBillingSchema();
    const id = req.params.id;
    const { frequency, next_date, worker_id, price, start_date } = req.body;
    const company_id = req.user.company_id;

    const estimate = await pool.query(`
      SELECT * FROM estimates
      WHERE id = $1 AND company_id = $2
    `, [id, company_id]);

    if (estimate.rows.length === 0) {
      return res.status(404).json({ error: "Estimate not found" });
    }

    const e = estimate.rows[0];

    if (e.status === "converted") {
      return res.status(400).json({ error: "Estimate already converted to subscription" });
    }

    let resolvedClientId = e.client_id;

    if (!resolvedClientId) {
      const clientResult = await pool.query(`
        INSERT INTO clients (name, phone, address, zip, company_id)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
      `, [
        e.customer_name || "New Lead",
        e.phone || "",
        e.address || "",
        e.zip || "",
        company_id
      ]);

      resolvedClientId = clientResult.rows[0].id;
    }

    const activeClient = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [resolvedClientId, company_id]
    );

    if (activeClient.rows.length === 0) {
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
      resolvedClientId,
      e.service,
      frequency,
      next_date,
      price || e.quoted_price || 0,
      workerLookup.workerId,
      company_id,
      start_date || next_date,
      next_date
    ]);

    const createdSub = subResult.rows[0];

    const visitDates = buildSubscriptionVisitDates(next_date, frequency, 8);

    for (const visitDate of visitDates) {
      const exists = await pool.query(`
        SELECT id FROM jobs
        WHERE source_subscription_id = $1
          AND date = $2
          AND type = 'subscription_visit'
          AND company_id = $3
      `, [createdSub.id, visitDate, company_id]);

      if (exists.rows.length === 0) {
        await pool.query(`
          INSERT INTO jobs
          (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, source_subscription_id, payment_status)
          VALUES ($1,$2,'subscription_visit',$3,'08:00','09:00','scheduled',$4,0,$5,$6,'included')
        `, [
          resolvedClientId,
          e.service,
          visitDate,
          workerLookup.workerId,
          company_id,
          createdSub.id
        ]);
      }
    }

    await pool.query(`
      UPDATE estimates
      SET status = 'converted', client_id = $3
      WHERE id = $1 AND company_id = $2
    `, [id, company_id, resolvedClientId]);

    res.json(createdSub);
  } catch (err) {
    console.log("CONVERT ESTIMATE TO SUBSCRIPTION ERROR:", err);
    sendSafeServerError(res, err, "routes/estimates");
  }
});



module.exports = router;

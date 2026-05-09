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
  assertLeadStatusTransition,
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

function normalizeQuotedPrice(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Number(n.toFixed(2));
}

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

router.get("/workflow/leads", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const result = await pool.query(`
      SELECT estimates.*, clients.name AS client_name
      FROM estimates
      LEFT JOIN clients ON estimates.client_id = clients.id AND clients.company_id = estimates.company_id
      WHERE estimates.company_id = $1
        AND estimates.record_type = 'lead'
        AND COALESCE(estimates.archived, FALSE) = FALSE
      ORDER BY estimates.id DESC
    `, [req.user.company_id]);

    res.json(result.rows);
  } catch (err) {
    console.log("WORKFLOW LEADS ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  }
});

router.post("/workflow/leads", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const { customer_name, phone, address, zip, service, visit_date, quoted_price, notes, status } = req.body;

    if (!customer_name || !phone || !address || !service || !visit_date) {
      return res.status(400).json({ error: "Missing lead data" });
    }

    const result = await pool.query(`
      INSERT INTO estimates
      (customer_name, phone, address, zip, service, visit_date, quoted_price, notes, status, company_id, record_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'lead')
      RETURNING *
    `, [
      customer_name,
      phone,
      address,
      zip || "",
      service,
      visit_date,
      normalizeQuotedPrice(quoted_price),
      notes || "",
      normalizeLeadStatus(status),
      req.user.company_id
    ]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "lead_created",
      entityType: "lead",
      entityId: result.rows[0].id,
      details: {
        customer_name,
        service
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("WORKFLOW CREATE LEAD ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  }
});

router.put("/workflow/leads/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const current = await getLead(req.user.company_id, req.params.id);

    if (!current) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const payload = {
      customer_name: req.body.customer_name || current.customer_name || "",
      phone: req.body.phone || current.phone || "",
      address: req.body.address || current.address || "",
      zip: req.body.zip || current.zip || "",
      service: req.body.service || current.service || "",
      visit_date: req.body.visit_date || current.visit_date,
      quoted_price: req.body.quoted_price !== undefined
        ? normalizeQuotedPrice(req.body.quoted_price)
        : current.quoted_price,
      notes: req.body.notes !== undefined ? req.body.notes : current.notes,
      status: normalizeLeadStatus(req.body.status || current.status)
    };

    const statusErr = assertLeadStatusTransition(current.status, payload.status);
    if (statusErr) {
      return res.status(statusErr.statusCode || 400).json({ error: statusErr.message, code: statusErr.code });
    }

    const result = await pool.query(`
      UPDATE estimates
      SET customer_name = $1,
          phone = $2,
          address = $3,
          zip = $4,
          service = $5,
          visit_date = $6,
          quoted_price = $7,
          notes = $8,
          status = $9
      WHERE id = $10 AND company_id = $11 AND record_type = 'lead'
      RETURNING *
    `, [
      payload.customer_name,
      payload.phone,
      payload.address,
      payload.zip,
      payload.service,
      payload.visit_date,
      normalizeQuotedPrice(payload.quoted_price),
      payload.notes || "",
      payload.status,
      req.params.id,
      req.user.company_id
    ]);

    const changed = pickChangedFields(current, result.rows[0], [
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
      action: "lead_updated",
      entityType: "lead",
      entityId: Number(req.params.id),
      before: changed.before,
      after: changed.after,
      metadata: { changed_fields: Object.keys(changed.after) }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("WORKFLOW UPDATE LEAD ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  }
});
router.post("/workflow/leads/:id/convert-to-estimate", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureWorkflowSchema();
    await client.query("BEGIN");
    const leadResult = await client.query(`
      SELECT *
      FROM estimates
      WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
      LIMIT 1
      FOR UPDATE
    `, [req.params.id, req.user.company_id]);
    const lead = leadResult.rows[0] || null;

    if (!lead) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Lead not found" });
    }

    const existing = await client.query(`
      SELECT *
      FROM estimates
      WHERE company_id = $1 AND record_type = 'estimate' AND source_lead_id = $2
      ORDER BY id DESC
      LIMIT 1
    `, [req.user.company_id, lead.id]);

    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return res.json(existing.rows[0]);
    }

    const estimate = await client.query(`
      INSERT INTO estimates
      (client_id, customer_name, phone, address, zip, service, status, quoted_price, visit_date, notes, company_id, record_type, source_lead_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'estimate',$12)
      RETURNING *
    `, [
      lead.client_id || null,
      lead.customer_name,
      lead.phone,
      lead.address,
      lead.zip || "",
      lead.service,
      "draft",
      normalizeQuotedPrice(lead.quoted_price),
      lead.visit_date,
      lead.notes || "",
      req.user.company_id,
      lead.id
    ]);

    await client.query(`
      UPDATE estimates
      SET status = 'converted', converted_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
    `, [lead.id, req.user.company_id]);
    await client.query("COMMIT");

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "lead_converted_to_estimate",
      entityType: "lead",
      entityId: lead.id,
      details: {
        source_lead_id: lead.id,
        estimate_id: estimate.rows[0].id,
        customer_name: lead.customer_name
      }
    });

    res.json(estimate.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.log("LEAD TO ESTIMATE ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  } finally {
    client.release();
  }
});

router.put("/workflow/leads/:id/archive", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const current = await getLead(req.user.company_id, req.params.id);

    if (!current) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const result = await pool.query(`
      UPDATE estimates
      SET archived = TRUE
      WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
      RETURNING *
    `, [req.params.id, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "lead_archived",
      entityType: "lead",
      entityId: Number(req.params.id),
      details: {
        status: current.status,
        service: current.service
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("WORKFLOW ARCHIVE LEAD ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  }
});

router.delete("/workflow/leads/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const lead = await getLead(req.user.company_id, req.params.id);

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const normalizedStatus = normalizeLeadStatus(lead.status);
    if (normalizedStatus === "converted" || lead.converted_client_id || lead.converted_job_id) {
      await pool.query(`
        UPDATE estimates
        SET archived = TRUE
        WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
        RETURNING *
      `, [req.params.id, req.user.company_id]);

      await logActivity({
        companyId: req.user.company_id,
        userId: req.user.id,
        action: "lead_archived",
        entityType: "lead",
        entityId: Number(req.params.id),
        details: {
          status: lead.status,
          service: lead.service,
          safeDelete: true
        }
      });

      return res.json({ success: true, message: "Archived." });
    }

    await pool.query(`
      DELETE FROM estimates
      WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
    `, [req.params.id, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "lead_deleted",
      entityType: "lead",
      entityId: Number(req.params.id),
      details: {
        status: lead.status,
        service: lead.service
      }
    });

    res.json({ ok: true, message: "Deleted." });
  } catch (err) {
    console.log("WORKFLOW DELETE LEAD ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  }
});

router.post("/workflow/leads/:id/convert-to-client", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  const txClient = await pool.connect();
  try {
    await ensureWorkflowSchema();
    await txClient.query("BEGIN");

    const leadResult = await txClient.query(
      `SELECT *
       FROM estimates
       WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
       LIMIT 1
       FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    const lead = leadResult.rows[0] || null;

    if (!lead) {
      await txClient.query("ROLLBACK");
      return res.status(404).json({ error: "Lead not found" });
    }

    if (lead.converted_job_id) {
      const existingJob = await txClient.query(
        `SELECT *
         FROM jobs
         WHERE id = $1 AND company_id = $2
         LIMIT 1`,
        [lead.converted_job_id, req.user.company_id]
      );

      if (existingJob.rows.length > 0) {
        const existingClientRow = existingJob.rows[0].client_id
          ? (await txClient.query(
              `SELECT * FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1`,
              [existingJob.rows[0].client_id, req.user.company_id]
            )).rows[0] || null
          : null;

        await txClient.query("COMMIT");
        return res.json({ client: existingClientRow, job: existingJob.rows[0] });
      }
    }

    if (lead.converted_client_id) {
      const existingConvertedClient = await txClient.query(
        `SELECT * FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [lead.converted_client_id, req.user.company_id]
      );
      if (existingConvertedClient.rows.length > 0) {
        await txClient.query("COMMIT");
        return res.json(existingConvertedClient.rows[0]);
      }
    }

    let clientRow = null;
    if (lead.client_id) {
      const existingClientResult = await txClient.query(
        `SELECT * FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [lead.client_id, req.user.company_id]
      );
      clientRow = existingClientResult.rows[0] || null;
    }

    if (clientRow && clientRow.archived === true) {
      await txClient.query("ROLLBACK");
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    if (!clientRow) {
      const insertedClient = await txClient.query(
        `INSERT INTO clients (name, phone, address, zip, notes, company_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          lead.customer_name || "New Client",
          lead.phone || "",
          lead.address || "",
          lead.zip || "",
          lead.notes || "",
          req.user.company_id
        ]
      );
      clientRow = insertedClient.rows[0];
    }

    await txClient.query(
      `UPDATE estimates
       SET client_id = $1,
           converted_client_id = $1,
           status = 'converted',
           converted_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND company_id = $3 AND record_type = 'lead'`,
      [clientRow.id, lead.id, req.user.company_id]
    );

    await txClient.query("COMMIT");

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "lead_converted_to_client",
      entityType: "lead",
      entityId: lead.id,
      details: {
        source_lead_id: lead.id,
        client_id: clientRow.id,
        customer_name: lead.customer_name
      }
    });

    res.json(clientRow);
  } catch (err) {
    try { await txClient.query("ROLLBACK"); } catch (_) {}
    console.log("LEAD TO CLIENT ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  } finally {
    txClient.release();
  }
});

router.post("/workflow/leads/:id/convert-to-job", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  const txClient = await pool.connect();
  try {
    await ensureWorkflowSchema();
    await txClient.query("BEGIN");
    const leadResult = await txClient.query(`
      SELECT *
      FROM estimates
      WHERE id = $1 AND company_id = $2 AND record_type = 'lead'
      LIMIT 1
      FOR UPDATE
    `, [req.params.id, req.user.company_id]);
    const lead = leadResult.rows[0] || null;

    if (!lead) {
      await txClient.query("ROLLBACK");
      return res.status(404).json({ error: "Lead not found" });
    }

    if (lead.converted_job_id) {
      const existingJob = await txClient.query(
        `SELECT * FROM jobs WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [lead.converted_job_id, req.user.company_id]
      );
      if (existingJob.rows.length > 0) {
        await txClient.query("COMMIT");
        const existingClient = existingJob.rows[0].client_id
          ? await getClientById(req.user.company_id, existingJob.rows[0].client_id)
          : null;
        return res.json({ client: existingClient, job: existingJob.rows[0] });
      }
    }

    let leadClient = lead.client_id ? await getClientById(req.user.company_id, lead.client_id) : null;
    if (!leadClient) {
      leadClient = await createClientFromContact(req.user.company_id, {
        name: lead.customer_name,
        phone: lead.phone,
        address: lead.address,
        zip: lead.zip,
        notes: lead.notes
      });
    }

    const status = normalizeJobStatus(req.body.status || "scheduled");
    const workerLookup = await resolveCompanyWorkerId(req.user.company_id, req.body.worker_id);
    if (!workerLookup.ok) {
      await txClient.query("ROLLBACK");
      return res.status(400).json({ error: "Worker not found in this company" });
    }

    const job = await txClient.query(`
      INSERT INTO jobs
      (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, payment_status, internal_notes, status_reason, estimate_id)
      VALUES ($1,$2,'one_time_job',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL)
      RETURNING *
    `, [
      leadClient.id,
      req.body.service || lead.service,
      req.body.date || lead.visit_date,
      req.body.start_time || "08:00",
      req.body.end_time || "09:00",
      status,
      workerLookup.workerId,
      normalizeQuotedPrice(
        req.body.price !== undefined && req.body.price !== null && req.body.price !== ""
          ? req.body.price
          : lead.quoted_price
      ),
      req.user.company_id,
      normalizePaymentStatus(req.body.payment_status, "one_time_job"),
      req.body.internal_notes || lead.notes || "",
      req.body.status_reason || ""
    ]);

    await txClient.query(`
      UPDATE estimates
      SET client_id = $1,
          converted_client_id = $1,
          converted_job_id = $2,
          status = 'converted',
          converted_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND company_id = $4 AND record_type = 'lead'
    `, [leadClient.id, job.rows[0].id, lead.id, req.user.company_id]);
    await txClient.query("COMMIT");

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "lead_converted_to_job",
      entityType: "lead",
      entityId: lead.id,
      details: {
        source_lead_id: lead.id,
        job_id: job.rows[0].id,
        client_id: leadClient.id,
        service: job.rows[0].service
      }
    });

    res.json({ client: leadClient, job: job.rows[0] });
  } catch (err) {
    try {
      await txClient.query("ROLLBACK");
    } catch (_) {}
    console.log("LEAD TO JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/leads");
  } finally {
    txClient.release();
  }
});


module.exports = router;

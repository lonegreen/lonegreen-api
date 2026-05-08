const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { enforcePlanLimits } = require("../middleware/enforcePlanLimits");
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
const enforceJobPlanLimit = enforcePlanLimits("jobs");
const DEPRECATED_ENDPOINT_ERROR = { error: "Deprecated endpoint. Use canonical API route." };

function parsePagination(query) {
  const parsedLimit = Number(query && query.limit);
  const parsedOffset = Number(query && query.offset);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;
  return { limit, offset };
}

function lockDeprecatedLegacyMutations(req, res, next) {
  const method = req.method;
  const path = req.path;
  const isLockedLegacyMutation = (
    (method === "POST" && path === "/jobs") ||
    (method === "POST" && /^\/jobs\/[^/]+\/photos$/.test(path)) ||
    (method === "PUT" && /^\/jobs\/update\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/jobs\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/jobs\/[^/]+\/status$/.test(path)) ||
    (method === "DELETE" && /^\/jobs\/[^/]+$/.test(path))
  );
  if (isLockedLegacyMutation) {
    return res.status(410).json(DEPRECATED_ENDPOINT_ERROR);
  }
  return next();
}
router.use(lockDeprecatedLegacyMutations);

const JOB_STATUS_TRANSITIONS = {
  scheduled: new Set(["scheduled", "assigned", "cancelled"]),
  assigned: new Set(["assigned", "in_progress", "scheduled", "cancelled"]),
  in_progress: new Set(["in_progress", "completed", "cancelled"]),
  completed: new Set(["completed", "cancelled"]),
  cancelled: new Set(["cancelled", "scheduled"])
};

function assertJobStatusTransition(fromStatus, toStatus) {
  const from = normalizeJobStatus(fromStatus);
  const to = normalizeJobStatus(toStatus);
  const allowed = JOB_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    const err = new Error(`Invalid job status transition: ${from} -> ${to}`);
    err.code = "INVALID_JOB_STATUS_TRANSITION";
    err.statusCode = 400;
    return err;
  }
  return null;
}

/* ================= JOBS ================= */

router.post("/jobs", auth, requireCompanyBillingForMutations, enforceJobPlanLimit, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/jobs", "/workflow/jobs");
    const {
      client_id,
      service,
      type,
      date,
      start_time,
      end_time,
      worker_id,
      price,
      status,
      payment_status,
      internal_notes,
      status_reason
    } = req.body;

    if (!client_id || !service || !date || !start_time || !end_time) {
      return res.status(400).json({ error: "Missing data" });
    }

    const company_id = req.user.company_id;

    const client = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [client_id, company_id]
    );

    if (client.rows.length === 0) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    if (worker_id) {
      const workerCheck = await pool.query(
        "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
        [worker_id, company_id]
      );

      if (workerCheck.rows.length === 0) {
        return res.status(400).json({
          error: "Worker not found in this company"
        });
      }
    }

    const resolvedType = type || "one_time_job";
    const resolvedPaymentStatus = normalizeJobPaymentStatus(
      resolvedType,
      payment_status
    );

    const result = await pool.query(
      `
      INSERT INTO jobs
      (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, payment_status, internal_notes, status_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `,
      [
        client_id,
        service,
        resolvedType,
        date,
        start_time,
        end_time,
        status || "scheduled",
        worker_id || null,
        resolvedType === "subscription_visit" ? 0 : price || 0,
        company_id,
        resolvedPaymentStatus,
        internal_notes || "",
        status_reason || ""
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.get("/jobs", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/jobs", "/workflow/jobs");
    await ensureWorkflowSchema();
    const company_id = req.user.company_id;
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(
      `
      SELECT
        jobs.*,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address,
        clients.zip AS client_zip,
        workers.name AS worker_name,
        estimates.status AS estimate_status,
        estimates.record_type AS estimate_record_type,
        invoices.id AS invoice_id,
        invoices.status AS invoice_status,
        invoices.invoice_number
      FROM jobs
      LEFT JOIN clients ON jobs.client_id = clients.id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON jobs.worker_id = workers.id AND workers.company_id = jobs.company_id
      LEFT JOIN estimates ON jobs.estimate_id = estimates.id AND estimates.company_id = jobs.company_id
      LEFT JOIN LATERAL (
        SELECT id, status, invoice_number
        FROM invoices
        WHERE invoices.job_id = jobs.id AND invoices.company_id = jobs.company_id
        ORDER BY invoices.id DESC
        LIMIT 1
      ) invoices ON true
      WHERE jobs.company_id = $1
      ORDER BY jobs.date DESC, jobs.id DESC
      LIMIT $2 OFFSET $3
    `,
      [company_id, limit, offset]
    );

    res.json(
      result.rows.map((job) => ({
        ...job,
        status: normalizeJobStatus(job.status)
      }))
    );
  } catch (err) {
    console.log("JOBS ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.get("/jobs/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const id = req.params.id;

    const result = await pool.query(
      `
      SELECT
        jobs.*,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address,
        workers.name AS worker_name
      FROM jobs
      LEFT JOIN clients ON jobs.client_id = clients.id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON jobs.worker_id = workers.id AND workers.company_id = jobs.company_id
      WHERE jobs.id = $1 AND jobs.company_id = $2
    `,
      [id, company_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log("GET JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.get("/jobs/:id/photos", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureJobPhotoSchema();
    const company_id = req.user.company_id;
    const id = req.params.id;

    const result = await pool.query(
      `
      SELECT id, job_id, photo_type, image_url, created_at
      FROM job_photos
      WHERE job_id = $1 AND company_id = $2
      ORDER BY created_at ASC, id ASC
    `,
      [id, company_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.log("GET JOB PHOTOS ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.post("/jobs/:id/photos", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureJobPhotoSchema();
    const company_id = req.user.company_id;
    const id = req.params.id;
    const { photo_type, image_url } = req.body;

    if (!photo_type || !image_url) {
      return res.status(400).json({ error: "Missing photo data" });
    }

    const allowedPhotoTypes = ["before", "after"];
    if (!allowedPhotoTypes.includes(photo_type)) {
      return res.status(400).json({ error: "Invalid photo type" });
    }

    const jobCheck = await pool.query(
      `
      SELECT id
      FROM jobs
      WHERE id = $1 AND company_id = $2
    `,
      [id, company_id]
    );

    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const result = await pool.query(
      `
      INSERT INTO job_photos (job_id, photo_type, image_url, company_id)
      VALUES ($1,$2,$3,$4)
      RETURNING id, job_id, photo_type, image_url, created_at
    `,
      [id, photo_type, image_url, company_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD JOB PHOTO ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.put("/jobs/update/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { date, start_time, end_time, service, price } = req.body;

    await pool.query(
      `
      UPDATE jobs 
      SET 
        date = COALESCE($1, date),
        start_time = COALESCE($2, start_time),
        end_time = COALESCE($3, end_time),
        service = COALESCE($4, service),
        price = COALESCE($5, price)
      WHERE id=$6 AND company_id=$7
    `,
      [
        date || null,
        start_time || null,
        end_time || null,
        service || null,
        price || null,
        req.params.id,
        company_id
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.log("UPDATE JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.put("/jobs/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const id = req.params.id;
    const {
      client_id,
      service,
      type,
      date,
      start_time,
      end_time,
      worker_id,
      price,
      status,
      payment_status,
      internal_notes,
      status_reason
    } = req.body;

    const allowedStatuses = [
      "draft",
      "scheduled",
      "confirmed",
      "assigned",
      "en_route",
      "arrived",
      "in_progress",
      "completed",
      "rescheduled",
      "cancelled",
      "skipped",
      "no_access",
      "no_show",
      "weather_delay",
      "needs_followup",
      "needs_rework",
      "quoted",
      "approved",
      "rejected"
    ];

    const allowedPaymentStatuses = [
      "unpaid",
      "paid",
      "included",
      "included_in_subscription"
    ];

    if (!client_id || !service || !type || !date || !start_time || !end_time || !status) {
      return res.status(400).json({ error: "Missing data" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid job status" });
    }

    if (payment_status && !allowedPaymentStatuses.includes(payment_status)) {
      return res.status(400).json({ error: "Invalid payment status" });
    }

    const clientCheck = await pool.query(
      `
      SELECT id
      FROM clients
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `,
      [client_id, company_id]
    );

    if (clientCheck.rows.length === 0) {
      return res.status(400).json({
        error: "Client not found in this company"
      });
    }

    if (worker_id) {
      const workerCheck = await pool.query(
        `
        SELECT id
        FROM workers
        WHERE id = $1 AND company_id = $2
        LIMIT 1
      `,
        [worker_id, company_id]
      );

      if (workerCheck.rows.length === 0) {
        return res.status(400).json({
          error: "Worker not found in this company"
        });
      }
    }

    const resolvedPaymentStatus = normalizeJobPaymentStatus(type, payment_status);

    const currentJobResult = await pool.query(
      `
      SELECT id, status
      FROM jobs
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `,
      [id, company_id]
    );
    if (!currentJobResult.rows.length) {
      return res.status(404).json({ error: "Job not found" });
    }
    const transitionErr = assertJobStatusTransition(currentJobResult.rows[0].status, status);
    if (transitionErr) {
      return res.status(transitionErr.statusCode || 400).json({ error: transitionErr.message, code: transitionErr.code });
    }

    const result = await pool.query(
      `
      UPDATE jobs
      SET
        client_id = $1,
        service = $2,
        type = $3,
        date = $4,
        start_time = $5,
        end_time = $6,
        worker_id = $7,
        price = $8,
        status = $9,
        payment_status = $10,
        internal_notes = $11,
        status_reason = $12
      WHERE id = $13 AND company_id = $14
      RETURNING *
    `,
      [
        client_id,
        service,
        type,
        date,
        start_time,
        end_time,
        worker_id || null,
        type === "subscription_visit" ? 0 : price || 0,
        status,
        resolvedPaymentStatus,
        internal_notes || "",
        status_reason || "",
        id,
        company_id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log("UPDATE FULL JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.put("/jobs/:id/status", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/jobs/:id/status", "/workflow/jobs/:id/status");
    const company_id = req.user.company_id;
    const id = req.params.id;
    const { status, status_reason, internal_notes, payment_status, worker_id } = req.body;

    const allowedStatuses = [
      "draft",
      "scheduled",
      "confirmed",
      "assigned",
      "en_route",
      "arrived",
      "in_progress",
      "completed",
      "rescheduled",
      "cancelled",
      "skipped",
      "no_access",
      "no_show",
      "weather_delay",
      "needs_followup",
      "needs_rework",
      "quoted",
      "approved",
      "rejected"
    ];

    const allowedPaymentStatuses = [
      "unpaid",
      "paid",
      "included",
      "included_in_subscription"
    ];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid job status" });
    }

    if (payment_status && !allowedPaymentStatuses.includes(payment_status)) {
      return res.status(400).json({ error: "Invalid payment status" });
    }

    const existing = await pool.query(
      `
      SELECT id, type, status, worker_id
      FROM jobs
      WHERE id = $1 AND company_id = $2
    `,
      [id, company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const currentJob = existing.rows[0];
    const nextStatus = status || currentJob.status;
    const resolvedWorkerId = worker_id || currentJob.worker_id || null;

    if (["assigned", "in_progress", "completed"].includes(nextStatus) && !resolvedWorkerId) {
      return res.status(400).json({ error: "Worker is required for this status" });
    }

    if (
      normalizeJobStatus(currentJob.status) === "completed" &&
      !["completed", "cancelled"].includes(normalizeJobStatus(nextStatus))
    ) {
      return res.status(400).json({ error: "Completed jobs cannot be reverted" });
    }
    const transitionErr = assertJobStatusTransition(currentJob.status, nextStatus);
    if (transitionErr) {
      return res.status(transitionErr.statusCode || 400).json({ error: transitionErr.message, code: transitionErr.code });
    }

    if (resolvedWorkerId) {
      const workerCheck = await pool.query(
        `
        SELECT id
        FROM workers
        WHERE id = $1 AND company_id = $2
        LIMIT 1
      `,
        [resolvedWorkerId, company_id]
      );

      if (workerCheck.rows.length === 0) {
        return res.status(400).json({
          error: "Worker not found in this company"
        });
      }
    }

    const result = await pool.query(
      `
      UPDATE jobs
      SET
        status = COALESCE($1, status),
        status_reason = COALESCE($2, status_reason),
        internal_notes = COALESCE($3, internal_notes),
        payment_status = COALESCE($4, payment_status),
        worker_id = COALESCE($5, worker_id)
      WHERE id = $6 AND company_id = $7
      RETURNING *
    `,
      [
        status || null,
        status_reason || null,
        internal_notes || null,
        payment_status
          ? normalizeJobPaymentStatus(currentJob.type, payment_status)
          : null,
        resolvedWorkerId,
        id,
        company_id
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("UPDATE JOB STATUS ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.delete("/jobs/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ error: "Invalid job id" });
    }

    const company_id = req.user.company_id;
    const existing = await pool.query(
      `
      SELECT id, status, type, source_subscription_id
      FROM jobs
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `,
      [jobId, company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const linked = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM invoices WHERE job_id=$1 AND company_id=$2 LIMIT 1) AS has_invoices,
        EXISTS (
          SELECT 1
          FROM payments
          JOIN invoices ON invoices.id=payments.invoice_id
            AND invoices.company_id=payments.company_id
          WHERE invoices.job_id=$1 AND payments.company_id=$2
          LIMIT 1
        ) AS has_payments,
        EXISTS (
          SELECT 1
          FROM invoices
          WHERE job_id=$1
            AND company_id=$2
            AND source_subscription_id IS NOT NULL
          LIMIT 1
        ) AS has_subscription_invoice
    `, [jobId, company_id]);
    const linkedRow = linked.rows[0] || {};
    const job = existing.rows[0];
    const hasSubscriptionReference =
      job.source_subscription_id ||
      String(job.type || "") === "subscription_visit" ||
      linkedRow.has_subscription_invoice;

    if (String(existing.rows[0].status || "") !== "scheduled" || linkedRow.has_invoices || linkedRow.has_payments || hasSubscriptionReference) {
      await pool.query(
        `UPDATE jobs
         SET status='cancelled',
             status_reason = COALESCE(NULLIF(status_reason, ''), 'Safe delete cancelled this job.')
         WHERE id=$1 AND company_id=$2`,
        [jobId, company_id]
      );

      return res.json({
        success: true,
        message: "Job cancelled.",
        notice: "Job has linked records. Archive instead."
      });
    }

    await pool.query(
      "UPDATE invoices SET job_id=NULL WHERE job_id=$1 AND company_id=$2",
      [jobId, company_id]
    );

    await pool.query(
      "DELETE FROM job_photos WHERE job_id=$1 AND company_id=$2",
      [jobId, company_id]
    );

    await pool.query(
      "DELETE FROM jobs WHERE id=$1 AND company_id=$2",
      [jobId, company_id]
    );

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log("DELETE JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.get("/workflow/jobs", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(
      `
      SELECT
        jobs.*,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address,
        clients.zip AS client_zip,
        workers.name AS worker_name,
        estimates.status AS estimate_status,
        estimates.record_type AS estimate_record_type,
        invoices.id AS invoice_id,
        invoices.status AS invoice_status,
        invoices.invoice_number
      FROM jobs
      LEFT JOIN clients ON jobs.client_id = clients.id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON jobs.worker_id = workers.id AND workers.company_id = jobs.company_id
      LEFT JOIN estimates ON jobs.estimate_id = estimates.id AND estimates.company_id = jobs.company_id
      LEFT JOIN LATERAL (
        SELECT id, status, invoice_number
        FROM invoices
        WHERE invoices.job_id = jobs.id AND invoices.company_id = jobs.company_id
        ORDER BY invoices.id DESC
        LIMIT 1
      ) invoices ON true
      WHERE jobs.company_id = $1
      ORDER BY jobs.date DESC, jobs.id DESC
      LIMIT $2 OFFSET $3
    `,
      [req.user.company_id, limit, offset]
    );

    res.json(
      result.rows.map((job) => ({
        ...job,
        status: normalizeJobStatus(job.status)
      }))
    );
  } catch (err) {
    console.log("WORKFLOW JOBS ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.post("/workflow/jobs", auth, requireCompanyBillingForMutations, enforceJobPlanLimit, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const companyId = req.user.company_id;
    let clientId = req.body.client_id || null;
    let estimateId = req.body.estimate_id || null;
    let estimate = null;

    if (estimateId) {
      estimate = await getEstimate(companyId, estimateId);
      if (!estimate) {
        return res.status(404).json({ error: "Estimate not found" });
      }

      const existingEstimateJob = await pool.query(
        `SELECT *
         FROM jobs
         WHERE company_id = $1
           AND (estimate_id = $2 OR id = $3)
         ORDER BY id DESC
         LIMIT 1`,
        [companyId, estimate.id, estimate.converted_job_id || 0]
      );

      if (existingEstimateJob.rows.length > 0) {
        return res.json(existingEstimateJob.rows[0]);
      }

      clientId = clientId || estimate.client_id || null;
    }

    if (!clientId) {
      return res.status(400).json({ error: "Client is required" });
    }

    const client = await pool.query(
      "SELECT id FROM clients WHERE id=$1 AND company_id=$2 AND COALESCE(archived, FALSE)=FALSE LIMIT 1",
      [clientId, companyId]
    );

    if (client.rows.length === 0) {
      return res.status(400).json({ error: "Client is archived or not found" });
    }

    if (req.body.worker_id) {
      const workerCheck = await pool.query(
        "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
        [req.body.worker_id, companyId]
      );

      if (workerCheck.rows.length === 0) {
        return res.status(400).json({
          error: "Worker not found in this company"
        });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO jobs
      (client_id, service, type, date, start_time, end_time, status, worker_id, price, company_id, payment_status, internal_notes, status_reason, estimate_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `,
      [
        clientId,
        req.body.service,
        req.body.type || "one_time_job",
        req.body.date,
        req.body.start_time || "08:00",
        req.body.end_time || "09:00",
        normalizeJobStatus(req.body.status || "scheduled"),
        req.body.worker_id || null,
        req.body.type === "subscription_visit" ? 0 : req.body.price || 0,
        companyId,
        normalizePaymentStatus(
          req.body.payment_status,
          req.body.type || "one_time_job"
        ),
        req.body.internal_notes || "",
        req.body.status_reason || "",
        estimateId || null
      ]
    );

    if (estimate) {
      await pool.query(
        `
        UPDATE estimates
        SET client_id = $1,
            converted_client_id = $1,
            converted_job_id = $2,
            status = 'converted',
            converted_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND company_id = $4 AND record_type = 'estimate'
      `,
        [clientId, result.rows[0].id, estimate.id, companyId]
      );

      await logActivity({
        companyId,
        userId: req.user.id,
        action: "estimate_converted_to_job",
        entityType: "estimate",
        entityId: estimate.id,
        details: {
          job_id: result.rows[0].id,
          created_from: "jobs_page"
        }
      });
    }

    await logActivity({
      companyId,
      userId: req.user.id,
      action: "job_created",
      entityType: "job",
      entityId: result.rows[0].id,
      details: {
        client_id: clientId,
        estimate_id: estimateId || null,
        service: result.rows[0].service,
        type: result.rows[0].type,
        status: result.rows[0].status,
        worker_id: result.rows[0].worker_id,
        date: result.rows[0].date,
        start_time: result.rows[0].start_time,
        end_time: result.rows[0].end_time,
        price: result.rows[0].price
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("WORKFLOW CREATE JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.put("/workflow/jobs/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();

    const clientCheck = await pool.query(
      `
      SELECT id
      FROM clients
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `,
      [req.body.client_id, req.user.company_id]
    );

    if (clientCheck.rows.length === 0) {
      return res.status(400).json({
        error: "Client not found in this company"
      });
    }

    if (req.body.worker_id) {
      const workerCheck = await pool.query(
        `
        SELECT id
        FROM workers
        WHERE id = $1 AND company_id = $2
        LIMIT 1
      `,
        [req.body.worker_id, req.user.company_id]
      );

      if (workerCheck.rows.length === 0) {
        return res.status(400).json({
          error: "Worker not found in this company"
        });
      }
    }

    const beforeJob = await pool.query(
      `SELECT * FROM jobs WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.id, req.user.company_id]
    );

    if (beforeJob.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const nextStatus = normalizeJobStatus(req.body.status || beforeJob.rows[0].status);
    const transitionErr = assertJobStatusTransition(beforeJob.rows[0].status, nextStatus);
    if (transitionErr) {
      return res.status(transitionErr.statusCode || 400).json({ error: transitionErr.message, code: transitionErr.code });
    }

    const result = await pool.query(
      `
      UPDATE jobs
      SET client_id = $1,
          service = $2,
          type = $3,
          date = $4,
          start_time = $5,
          end_time = $6,
          status = $7,
          worker_id = $8,
          price = $9,
          payment_status = $10,
          internal_notes = $11,
          status_reason = $12,
          estimate_id = $13
      WHERE id = $14 AND company_id = $15
      RETURNING *
    `,
      [
        req.body.client_id,
        req.body.service,
        req.body.type || "one_time_job",
        req.body.date,
        req.body.start_time || "08:00",
        req.body.end_time || "09:00",
        nextStatus,
        req.body.worker_id || null,
        req.body.type === "subscription_visit" ? 0 : req.body.price || 0,
        normalizePaymentStatus(
          req.body.payment_status,
          req.body.type || "one_time_job"
        ),
        req.body.internal_notes || "",
        req.body.status_reason || "",
        req.body.estimate_id || null,
        req.params.id,
        req.user.company_id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const changed = pickChangedFields(beforeJob.rows[0], result.rows[0], [
      "client_id",
      "service",
      "type",
      "date",
      "start_time",
      "end_time",
      "status",
      "worker_id",
      "price",
      "payment_status",
      "internal_notes",
      "status_reason",
      "estimate_id"
    ]);

    await logChange({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "job_updated",
      entityType: "job",
      entityId: Number(req.params.id),
      before: changed.before,
      after: changed.after,
      metadata: { changed_fields: Object.keys(changed.after) }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("WORKFLOW UPDATE JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.put("/workflow/jobs/:id/status", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const allowedStatuses = [
      "scheduled",
      "assigned",
      "in_progress",
      "completed",
      "cancelled"
    ];
    const status = req.body.status;

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid job status" });
    }

    const existing = await pool.query(
      `
      SELECT * FROM jobs
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `,
      [req.params.id, req.user.company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = existing.rows[0];
    const nextStatus = normalizeJobStatus(status || job.status);
    const resolvedWorkerId =
      req.body.worker_id !== undefined ? req.body.worker_id : job.worker_id;
    const currentStatus = normalizeJobStatus(job.status);

    if (["assigned", "in_progress", "completed"].includes(nextStatus) && !resolvedWorkerId) {
      return res.status(400).json({ error: "Worker is required for this status" });
    }

    if (
      currentStatus === "completed" &&
      !["completed", "cancelled"].includes(nextStatus)
    ) {
      return res.status(400).json({ error: "Completed jobs cannot be reverted" });
    }
    const transitionErr = assertJobStatusTransition(job.status, nextStatus);
    if (transitionErr) {
      return res.status(transitionErr.statusCode || 400).json({ error: transitionErr.message, code: transitionErr.code });
    }

    if (resolvedWorkerId) {
      const workerCheck = await pool.query(
        `
        SELECT id
        FROM workers
        WHERE id = $1 AND company_id = $2
        LIMIT 1
      `,
        [resolvedWorkerId, req.user.company_id]
      );

      if (workerCheck.rows.length === 0) {
        return res.status(400).json({
          error: "Worker not found in this company"
        });
      }
    }

    const updated = await pool.query(
      `
      UPDATE jobs
      SET status = $1,
          payment_status = $2,
          internal_notes = $3,
          status_reason = $4,
          worker_id = $5
      WHERE id = $6 AND company_id = $7
      RETURNING *
    `,
      [
        nextStatus,
        normalizePaymentStatus(
          req.body.payment_status || job.payment_status,
          job.type
        ),
        req.body.internal_notes !== undefined
          ? req.body.internal_notes
          : job.internal_notes,
        req.body.status_reason !== undefined
          ? req.body.status_reason
          : job.status_reason,
        resolvedWorkerId,
        req.params.id,
        req.user.company_id
      ]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    await logChange({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "job_status_changed",
      entityType: "job",
      entityId: Number(req.params.id),
      before: {
        status: normalizeJobStatus(job.status),
        worker_id: job.worker_id,
        date: job.date,
        start_time: job.start_time,
        end_time: job.end_time
      },
      after: {
        status: updated.rows[0].status,
        worker_id: updated.rows[0].worker_id,
        date: updated.rows[0].date,
        start_time: updated.rows[0].start_time,
        end_time: updated.rows[0].end_time
      },
      metadata: {
        payment_status: updated.rows[0].payment_status
      }
    });

    res.json(updated.rows[0]);
  } catch (err) {
    console.log("WORKFLOW JOB STATUS ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

router.delete("/workflow/jobs/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ error: "Invalid job id" });
    }

    const existing = await pool.query(
      `
      SELECT id, status, type, source_subscription_id
      FROM jobs
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `,
      [jobId, req.user.company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const linked = await pool.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM invoices
          WHERE job_id = $1 AND company_id = $2
          LIMIT 1
        ) AS has_invoices,
        EXISTS (
          SELECT 1
          FROM payments
          JOIN invoices ON invoices.id = payments.invoice_id
            AND invoices.company_id = payments.company_id
          WHERE invoices.job_id = $1
            AND payments.company_id = $2
          LIMIT 1
        ) AS has_payments,
        EXISTS (
          SELECT 1
          FROM invoices
          WHERE job_id = $1
            AND company_id = $2
            AND source_subscription_id IS NOT NULL
          LIMIT 1
        ) AS has_subscription_invoice
    `, [jobId, req.user.company_id]);

    const linkedRow = linked.rows[0] || {};
    const job = existing.rows[0];
    const hasSubscriptionReference =
      job.source_subscription_id ||
      String(job.type || "") === "subscription_visit" ||
      linkedRow.has_subscription_invoice;
    const canHardDelete = String(existing.rows[0].status || "") === "scheduled" &&
      !linkedRow.has_invoices &&
      !linkedRow.has_payments &&
      !hasSubscriptionReference;

    if (!canHardDelete) {
      await pool.query(
        `UPDATE jobs
         SET status = 'cancelled',
             status_reason = COALESCE(NULLIF(status_reason, ''), 'Safe delete cancelled this linked job.')
         WHERE id = $1 AND company_id = $2`,
        [jobId, req.user.company_id]
      );

      await logActivity({
        companyId: req.user.company_id,
        userId: req.user.id,
        action: "job_cancelled",
        entityType: "job",
        entityId: jobId,
        details: {
          reason: "safe_delete",
          previous_status: existing.rows[0].status
        }
      });

      return res.json({
        success: true,
        message: "Job cancelled.",
        notice: "Job has linked records. Archive instead."
      });
    }

    await pool.query(
      `UPDATE invoices SET job_id = NULL WHERE job_id = $1 AND company_id = $2`,
      [jobId, req.user.company_id]
    );

    await pool.query(
      `DELETE FROM job_photos WHERE job_id = $1 AND company_id = $2`,
      [jobId, req.user.company_id]
    );

    const deleted = await pool.query(
      `DELETE FROM jobs WHERE id = $1 AND company_id = $2`,
      [jobId, req.user.company_id]
    );

    if (!deleted.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "job_deleted",
      entityType: "job",
      entityId: jobId,
      details: {}
    });

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log("WORKFLOW DELETE JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/jobs");
  }
});

module.exports = router;

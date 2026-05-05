const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { requireMinimumRole, normalizeRole, isOwnerAdmin, isManagerOrAbove, isWorker, workerIdForUser } = auth;
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

function forbidden(res) {
  return res.status(403).json({ error: "Forbidden" });
}

function requireWorkerRouteAccess(req, res, next) {
  if (isOwnerAdmin(req.user)) {
    return next();
  }

  if (isWorker(req.user) && String(req.params.workerId) === String(workerIdForUser(req.user))) {
    return next();
  }

  return forbidden(res);
}

async function requireWorkerJobMutationAccess(req, res, next) {
  if (isOwnerAdmin(req.user)) {
    return next();
  }

  if (!isWorker(req.user)) {
    return forbidden(res);
  }

  const requestedStatus = req.body && req.body.status;
  if (requestedStatus && !["in_progress", "completed"].includes(requestedStatus)) {
    return forbidden(res);
  }

  const workerId = workerIdForUser(req.user);
  if (req.body && req.body.worker_id && String(req.body.worker_id) !== String(workerId)) {
    return forbidden(res);
  }

  try {
    const existing = await pool.query(
      "SELECT id FROM jobs WHERE id=$1 AND company_id=$2 AND worker_id=$3 LIMIT 1",
      [req.params.jobId, req.user.company_id, workerId]
    );

    if (existing.rows.length === 0) {
      return forbidden(res);
    }

    req.body.worker_id = workerId;
    return next();
  } catch (err) {
    console.log("WORKER JOB ACCESS ERROR:", err);
    return sendSafeServerError(res, err, "routes/workers");
  }
}

/* ================= WORKERS ================= */

router.get("/workers", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/workers", "/ops/workers");
    const company_id = req.user.company_id;

    const result = await pool.query(
      "SELECT * FROM workers WHERE company_id=$1 ORDER BY id DESC",
      [company_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.log("GET WORKERS ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.post("/workers", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const { name } = req.body;
    const company_id = req.user.company_id;

    if (!name) {
      return res.status(400).json({ error: "Name required" });
    }

    const result = await pool.query(
      "INSERT INTO workers (name, company_id) VALUES ($1,$2) RETURNING *",
      [name.trim(), company_id]
    );

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "worker_created",
      entityType: "worker",
      entityId: result.rows[0].id,
      details: {
        name: result.rows[0].name
      }
    });

    await createNotification({
      companyId: company_id,
      type: "worker_update",
      title: "Worker added",
      message: `${req.user.username} added worker ${result.rows[0].name}.`
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD WORKER ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.delete("/workers/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const company_id = req.user.company_id;
    const id = req.params.id;

    const result = await pool.query(
      "UPDATE workers SET active=FALSE WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, company_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Worker not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE WORKER ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.delete("/ops/workers/:id/permanent", auth, requireCompanyBillingForMutations, requireMinimumRole("owner"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const company_id = req.user.company_id;
    const id = req.params.id;

    const existing = await pool.query(
      "SELECT id, name FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
      [id, company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Worker not found" });
    }

    const activeJobs = await pool.query(`
      SELECT id
      FROM jobs
      WHERE worker_id = $1
        AND company_id = $2
        AND status IN ('assigned', 'in_progress', 'scheduled')
      LIMIT 1
    `, [id, company_id]);

    if (activeJobs.rows.length > 0) {
      await pool.query(
        "UPDATE workers SET active=FALSE WHERE id=$1 AND company_id=$2",
        [id, company_id]
      );

      await logActivity({
        companyId: company_id,
        userId: req.user.id,
        action: "worker_deactivated",
        entityType: "worker",
        entityId: Number(id),
        details: {
          name: existing.rows[0].name,
          reason: "active_jobs"
        }
      });

      return res.json({
        success: true,
        message: "Deactivated.",
        notice: "Worker has assigned jobs. Reassign or complete them first."
      });
    }

    await pool.query(
      "UPDATE users SET worker_id=NULL WHERE worker_id=$1 AND company_id=$2",
      [id, company_id]
    );

    await pool.query(
      "DELETE FROM worker_zip_groups WHERE worker_id=$1 AND company_id=$2",
      [id, company_id]
    );

    await pool.query(
      "UPDATE jobs SET worker_id=NULL WHERE worker_id=$1 AND company_id=$2",
      [id, company_id]
    );

    await pool.query(
      "UPDATE subscriptions SET worker_id=NULL WHERE worker_id=$1 AND company_id=$2",
      [id, company_id]
    );

    await pool.query(
      "DELETE FROM workers WHERE id=$1 AND company_id=$2",
      [id, company_id]
    );

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "worker_permanent_deleted",
      entityType: "worker",
      entityId: Number(id),
      details: {
        name: existing.rows[0].name,
        permanent: true
      }
    });

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log("PERMANENT DELETE WORKER ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});


router.get("/ops/workers", auth, async (req, res) => {
  try {
    await ensureOperationsSchema();
    const workerId = workerIdForUser(req.user);

    if (!isManagerOrAbove(req.user) && !workerId) {
      return forbidden(res);
    }

    try {
      await syncAlerts(req.user.company_id);
    } catch (alertErr) {
      console.log("OPS WORKERS ALERT SYNC ERROR:", alertErr);
    }

    const result = await pool.query(`
      SELECT
        workers.*,
        COALESCE(job_stats.jobs_assigned, 0) AS jobs_assigned,
        COALESCE(job_stats.jobs_completed, 0) AS jobs_completed
      FROM workers
      LEFT JOIN (
        SELECT
          worker_id,
          COUNT(*) AS jobs_assigned,
          COUNT(*) FILTER (WHERE status = 'completed') AS jobs_completed
        FROM jobs
        WHERE company_id = $1
          AND worker_id IS NOT NULL
        GROUP BY worker_id
      ) job_stats ON job_stats.worker_id = workers.id
      WHERE workers.company_id = $1
        AND ($2::int IS NULL OR workers.id = $2)
      ORDER BY COALESCE(workers.active, TRUE) DESC, workers.name ASC, workers.id ASC
    `, [req.user.company_id, isManagerOrAbove(req.user) ? null : workerId]);

    res.json(Array.isArray(result.rows) ? result.rows : []);
  } catch (err) {
    console.log("OPS WORKERS ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.get("/operations/workers", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    warnDeprecatedRoute("/operations/workers", "/ops/workers");
    await ensureOperationsSchema();
    const result = await pool.query(`
      SELECT
        workers.*,
        (
          SELECT COUNT(*)
          FROM jobs
          WHERE jobs.company_id = workers.company_id
            AND jobs.worker_id = workers.id
        ) AS jobs_assigned,
        (
          SELECT COUNT(*)
          FROM jobs
          WHERE jobs.company_id = workers.company_id
            AND jobs.worker_id = workers.id
            AND jobs.status = 'completed'
        ) AS jobs_completed
      FROM workers
      WHERE workers.company_id = $1
      ORDER BY workers.name ASC, workers.id ASC
    `, [req.user.company_id]);

    res.json(result.rows);
  } catch (err) {
    console.log("OPS GET WORKERS ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.post("/ops/workers", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const { name, phone, active } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Worker name is required" });
    }

    const result = await pool.query(`
      INSERT INTO workers (name, phone, active, company_id)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `, [name.trim(), phone || "", active !== false, req.user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "worker_created",
      entityType: "worker",
      entityId: result.rows[0].id,
      details: { name: result.rows[0].name }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("OPS CREATE WORKER ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.put("/ops/workers/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const { name, phone, active } = req.body;
    const result = await pool.query(`
      UPDATE workers
      SET
        name = $1,
        phone = $2,
        active = $3
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [name, phone || "", active !== false, req.params.id, req.user.company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Worker not found" });
    }

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: active === false ? "worker_deactivated" : "worker_updated",
      entityType: "worker",
      entityId: Number(req.params.id),
      details: { name: result.rows[0].name, active: result.rows[0].active }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("OPS UPDATE WORKER ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});


router.get("/ops/worker-suggestion", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const suggestion = await getSuggestedWorker(
      req.user.company_id,
      req.query.client_id ? Number(req.query.client_id) : null,
      req.query.zip || ""
    );
    res.json({ suggestion });
  } catch (err) {
    console.log("OPS WORKER SUGGESTION ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});


router.get("/ops/unassigned-jobs", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT jobs.*, clients.name AS client_name, clients.address AS client_address, clients.zip AS client_zip
      FROM jobs
      LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
      WHERE jobs.company_id = $1
        AND jobs.worker_id IS NULL
        AND jobs.status IN ('scheduled', 'assigned', 'in_progress')
      ORDER BY jobs.date ASC, jobs.start_time ASC
    `, [req.user.company_id]);

    res.json(result.rows.map(job => ({ ...job, status: normalizeJobStatus(job.status) })));
  } catch (err) {
    console.log("OPS UNASSIGNED JOBS ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});


router.get("/worker-jobs/:workerId", auth, requireWorkerRouteAccess, async (req, res) => {
  try {
    const workerId = req.params.workerId;
    const company_id = req.user.company_id;

    // Validate worker exists in same company
    const workerCheck = await pool.query(
      "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
      [workerId, company_id]
    );
    if (workerCheck.rows.length === 0) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await pool.query(`
      SELECT 
        jobs.*,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address
      FROM jobs
      LEFT JOIN clients ON jobs.client_id = clients.id AND clients.company_id = jobs.company_id
      WHERE jobs.worker_id = $1
        AND jobs.date = CURRENT_DATE
        AND jobs.company_id = $2
      ORDER BY jobs.start_time ASC
    `, [workerId, company_id]);

    res.json(result.rows);
  } catch (err) {
    console.log("WORKER JOBS ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});


router.get("/ops/worker-jobs/:workerId", auth, requireWorkerRouteAccess, async (req, res) => {
  try {
    await ensureOperationsSchema();
    await syncAlerts(req.user.company_id);

    // Validate worker exists in same company
    const workerCheck = await pool.query(
      "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
      [req.params.workerId, req.user.company_id]
    );
    if (workerCheck.rows.length === 0) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await pool.query(`
      SELECT
        jobs.*,
        clients.name AS client_name,
        clients.phone AS client_phone,
        clients.address AS client_address,
        workers.name AS worker_name
      FROM jobs
      LEFT JOIN clients ON clients.id = jobs.client_id AND clients.company_id = jobs.company_id
      LEFT JOIN workers ON workers.id = jobs.worker_id AND workers.company_id = jobs.company_id
      WHERE jobs.company_id = $1
        AND jobs.date = CURRENT_DATE
        AND jobs.worker_id = $2
      ORDER BY jobs.start_time ASC, jobs.id ASC
    `, [req.user.company_id, req.params.workerId]);

    res.json(result.rows.map(job => ({ ...job, status: normalizeJobStatus(job.status) })));
  } catch (err) {
    console.log("OPS WORKER JOBS ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});

router.put("/ops/worker-jobs/:jobId", auth, requireCompanyBillingForMutations, requireWorkerJobMutationAccess, async (req, res) => {
  try {
    const { status, internal_notes, worker_id } = req.body;
    const result = await pool.query(`
      UPDATE jobs
      SET
        status = COALESCE($1, status),
        internal_notes = COALESCE($2, internal_notes),
        worker_id = COALESCE($3, worker_id)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [
      status ? normalizeJobStatus(status) : null,
      internal_notes !== undefined ? internal_notes : null,
      worker_id || null,
      req.params.jobId,
      req.user.company_id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });

    }
    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "worker_job_updated",
      entityType: "job",
      entityId: Number(req.params.jobId),
      details: {
        status: result.rows[0].status,
        worker_id: result.rows[0].worker_id
      }
    });

    res.json({ ...result.rows[0], status: normalizeJobStatus(result.rows[0].status) });
  } catch (err) {
    console.log("OPS UPDATE WORKER JOB ERROR:", err);
    sendSafeServerError(res, err, "routes/workers");
  }
});


module.exports = router;

const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const { enrichInvoiceRowsWithFinancials } = require("../services/invoiceService");
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
const enforceClientPlanLimit = enforcePlanLimits("clients");
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
    (method === "POST" && path === "/clients") ||
    (method === "PUT" && /^\/clients\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/clients\/[^/]+\/archive$/.test(path)) ||
    (method === "DELETE" && /^\/clients\/[^/]+$/.test(path)) ||
    (method === "DELETE" && /^\/clients\/[^/]+\/permanent$/.test(path)) ||
    (method === "DELETE" && /^\/clients\/[^/]+\/jobs\/[^/]+\/subscription-visit$/.test(path))
  );
  if (isLockedLegacyMutation) {
    return res.status(410).json(DEPRECATED_ENDPOINT_ERROR);
  }
  return next();
}
router.use(lockDeprecatedLegacyMutations);

/* ================= CLIENTS ================= */

router.get("/clients", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureClientLifecycleSchema();
    const company_id = req.user.company_id;
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(`
      SELECT
        clients.id,
        clients.name,
        clients.phone,
        clients.address,
        clients.zip,
        clients.notes,
        COALESCE(clients.archived, FALSE) AS archived,
        clients.company_id,

        CASE
          WHEN EXISTS (
            SELECT 1
            FROM subscriptions
            WHERE subscriptions.client_id = clients.id
              AND subscriptions.company_id = clients.company_id
              AND subscriptions.status = 'active'
          )
          THEN true
          ELSE false
        END AS has_active_subscription,

        (
          SELECT COUNT(*)
          FROM jobs
          WHERE jobs.client_id = clients.id
            AND jobs.company_id = clients.company_id
            AND jobs.date >= CURRENT_DATE
            AND jobs.status IN ('scheduled', 'confirmed', 'assigned', 'en_route', 'arrived', 'in_progress')
        ) AS upcoming_jobs_count,

        (
          SELECT jobs.date
          FROM jobs
          WHERE jobs.client_id = clients.id
            AND jobs.company_id = clients.company_id
          ORDER BY jobs.date DESC, jobs.id DESC
          LIMIT 1
        ) AS last_job_date,

        (
          SELECT jobs.status
          FROM jobs
          WHERE jobs.client_id = clients.id
            AND jobs.company_id = clients.company_id
          ORDER BY jobs.date DESC, jobs.id DESC
          LIMIT 1
        ) AS last_job_status,

        (
          SELECT estimates.status
          FROM estimates
          WHERE estimates.client_id = clients.id
            AND estimates.company_id = clients.company_id
          ORDER BY estimates.id DESC
          LIMIT 1
        ) AS last_estimate_status

      FROM clients
      WHERE clients.company_id = $1
        AND COALESCE(clients.archived, FALSE) = FALSE
      ORDER BY clients.id DESC
      LIMIT $2 OFFSET $3
    `, [company_id, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.log("GET CLIENTS ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
});

async function createClientMutation(req, res) {
  try {
    await ensureClientLifecycleSchema();
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const address = String(req.body?.address || "").trim();
    const zip = String(req.body?.zip || "").trim();

    if (!name) {
      return res.status(400).json({ error: "Name required" });
    }

    const company_id = req.user.company_id;

    const result = await pool.query(
      "INSERT INTO clients (name, phone, address, zip, company_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [name, phone, address, zip, company_id]
    );

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "client_created",
      entityType: "client",
      entityId: result.rows[0].id,
      details: {
        name: result.rows[0].name,
        phone: result.rows[0].phone
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD CLIENT ERROR:", err);
    res.status(500).json({ error: "Error" });
  }
}

router.post("/clients", auth, requireCompanyBillingForMutations, enforceClientPlanLimit, requireMinimumRole("manager"), createClientMutation);
router.post("/workflow/clients", auth, requireCompanyBillingForMutations, enforceClientPlanLimit, requireMinimumRole("manager"), createClientMutation);

async function updateClientMutation(req, res) {
  try {
    await ensureClientLifecycleSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;

    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const address = String(req.body?.address || "").trim();
    const zip = String(req.body?.zip || "").trim();
    const notes = String(req.body?.notes || "").trim();

    if (!name) {
      return res.status(400).json({ error: "Name required" });
    }

    const existing = await pool.query(`
  SELECT *
  FROM clients
  WHERE id=$1 AND company_id=$2
  LIMIT 1
`, [id, company_id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updated = await pool.query(`
  UPDATE clients
  SET name=$1, phone=$2, address=$3, zip=$4, notes=$5
  WHERE id=$6 AND company_id=$7
  RETURNING *
`, [name, phone, address, zip, notes, id, company_id]);

    const changed = pickChangedFields(existing.rows[0], updated.rows[0], [
      "name",
      "phone",
      "address",
      "zip",
      "notes"
    ]);

    await logChange({
      companyId: company_id,
      userId: req.user.id,
      action: "client_updated",
      entityType: "client",
      entityId: Number(id),
      before: changed.before,
      after: changed.after,
      metadata: { changed_fields: Object.keys(changed.after) }
    });

    res.json({ success: true });
  } catch (err) {
    console.log("UPDATE CLIENT ERROR:", err);
    res.status(500).json({ error: "update failed" });
  }
}

router.put("/clients/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), updateClientMutation);
router.put("/workflow/clients/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), updateClientMutation);

async function archiveClientMutation(req, res) {
  try {
    await ensureClientLifecycleSchema();
    const company_id = req.user.company_id;
    const id = req.params.id;

    const existing = await pool.query(`
      SELECT id, name
      FROM clients
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [id, company_id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    const result = await pool.query(`
      UPDATE clients
      SET archived = TRUE
      WHERE id = $1 AND company_id = $2
      RETURNING *
    `, [id, company_id]);

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "client_archived",
      entityType: "client",
      entityId: Number(id),
      details: {
        name: existing.rows[0].name
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ARCHIVE CLIENT ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
}

router.put("/clients/:id/archive", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), archiveClientMutation);
router.put("/workflow/clients/:id/archive", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), archiveClientMutation);

router.delete("/clients/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const id = req.params.id;
    const company_id = req.user.company_id;

    const result = await pool.query(
      "UPDATE clients SET archived=TRUE WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, company_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "client_archived",
      entityType: "client",
      entityId: Number(id),
      details: { client_id: Number(id) }
    });

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE CLIENT ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
});

async function permanentDeleteClientMutation(req, res) {
  try {
    await ensureClientLifecycleSchema();
    await ensureWorkflowSchema();
    await ensureSubscriptionBillingSchema();
    const id = req.params.id;
    const company_id = req.user.company_id;

    const existing = await pool.query(
      "SELECT id, name FROM clients WHERE id=$1 AND company_id=$2 LIMIT 1",
      [id, company_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    const linked = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM jobs WHERE client_id=$1 AND company_id=$2 LIMIT 1) AS has_jobs,
        EXISTS (SELECT 1 FROM invoices WHERE client_id=$1 AND company_id=$2 LIMIT 1) AS has_invoices,
        EXISTS (SELECT 1 FROM subscriptions WHERE client_id=$1 AND company_id=$2 LIMIT 1) AS has_subscriptions,
        EXISTS (
          SELECT 1
          FROM estimates
          WHERE company_id=$2
            AND (client_id=$1 OR converted_client_id=$1)
          LIMIT 1
        ) AS has_estimates
    `, [id, company_id]);

    const row = linked.rows[0] || {};
    if (row.has_jobs || row.has_invoices || row.has_subscriptions || row.has_estimates) {
      const archived = await pool.query(
        "UPDATE clients SET archived=TRUE WHERE id=$1 AND company_id=$2",
        [id, company_id]
      );
      if (!archived.rowCount) {
        return res.status(404).json({ error: "Not found" });
      }

      await logActivity({
        companyId: company_id,
        userId: req.user.id,
        action: "client_archived",
        entityType: "client",
        entityId: Number(id),
        details: {
          name: existing.rows[0].name,
          reason: "linked_records"
        }
      });

      return res.json({
        success: true,
        message: "Archived.",
        notice: "Client has linked records. Archive instead."
      });
    }

    const deleted = await pool.query(
      "DELETE FROM clients WHERE id=$1 AND company_id=$2",
      [id, company_id]
    );

    if (!deleted.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "client_permanent_deleted",
      entityType: "client",
      entityId: Number(id),
      details: {
        name: existing.rows[0].name,
        permanent: true
      }
    });

    res.json({ success: true, message: "Deleted." });
  } catch (err) {
    console.log("PERMANENT DELETE CLIENT ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
}

router.delete("/clients/:id/permanent", auth, requireCompanyBillingForMutations, requireMinimumRole("owner"), permanentDeleteClientMutation);
router.delete("/workflow/clients/:id/permanent", auth, requireCompanyBillingForMutations, requireMinimumRole("owner"), permanentDeleteClientMutation);

// Delete subscription-generated job from client profile
async function cancelSubscriptionVisitMutation(req, res) {
  try {
    const jobId = req.params.jobId;
    const clientId = req.params.clientId;
    const company_id = req.user.company_id;

    // Verify the job exists and is a subscription visit
    const jobResult = await pool.query(
      `SELECT id, type, source_subscription_id FROM jobs
       WHERE id = $1 AND client_id = $2 AND company_id = $3
         AND (type = 'subscription_visit' OR source_subscription_id IS NOT NULL)
       LIMIT 1`,
      [jobId, clientId, company_id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: "Subscription visit not found" });
    }

    const cancelled = await pool.query(
      `UPDATE jobs
       SET status = 'cancelled',
           status_reason = COALESCE(NULLIF(status_reason, ''), 'Subscription visit cancelled from client profile.')
       WHERE id = $1 AND company_id = $2`,
      [jobId, company_id]
    );

    if (!cancelled.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "subscription_visit_cancelled",
      entityType: "job",
      entityId: Number(jobId),
      details: { clientId: Number(clientId) }
    });

    res.json({ success: true, message: "Subscription visit cancelled." });
  } catch (err) {
    console.log("DELETE SUBSCRIPTION VISIT ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
}

router.delete("/clients/:clientId/jobs/:jobId/subscription-visit", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), cancelSubscriptionVisitMutation);
router.delete("/workflow/clients/:clientId/jobs/:jobId/subscription-visit", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), cancelSubscriptionVisitMutation);


/* ================= CLIENT DETAILS ================= */

router.get("/clients/:id/jobs", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const clientId = req.params.id;
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(`
      SELECT
        jobs.*,
        workers.name AS worker_name
      FROM jobs
      LEFT JOIN workers ON jobs.worker_id = workers.id AND workers.company_id = jobs.company_id
      WHERE jobs.client_id = $1 AND jobs.company_id = $2
      ORDER BY jobs.date DESC, jobs.id DESC
      LIMIT $3 OFFSET $4
    `, [clientId, company_id, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.log("CLIENT JOBS ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
});

router.get("/clients/:id/subscriptions", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureSubscriptionBillingSchema();
    const company_id = req.user.company_id;
    const clientId = req.params.id;
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(`
      SELECT
        subscriptions.*,
        workers.name AS worker_name
      FROM subscriptions
      LEFT JOIN workers ON subscriptions.worker_id = workers.id AND workers.company_id = subscriptions.company_id
      WHERE subscriptions.client_id = $1 AND subscriptions.company_id = $2
      ORDER BY subscriptions.id DESC
      LIMIT $3 OFFSET $4
    `, [clientId, company_id, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.log("CLIENT SUBSCRIPTIONS ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
});


router.get("/workflow/clients/:id/timeline", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureWorkflowSchema();
    const companyId = req.user.company_id;
    const clientId = req.params.id;

    const clientResult = await pool.query(`
      SELECT *
      FROM clients
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [clientId, companyId]);

    if (clientResult.rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    const [leads, estimates, jobs, subscriptions, invoices, activity] = await Promise.all([
      pool.query(`
        SELECT *
        FROM estimates
        WHERE company_id = $1
          AND record_type = 'lead'
          AND (client_id = $2 OR converted_client_id = $2)
        ORDER BY id DESC
      `, [companyId, clientId]),
      pool.query(`
        SELECT *
        FROM estimates
        WHERE company_id = $1
          AND record_type = 'estimate'
          AND (client_id = $2 OR converted_client_id = $2)
        ORDER BY id DESC
      `, [companyId, clientId]),
      pool.query(`
        SELECT jobs.*, workers.name AS worker_name
        FROM jobs
        LEFT JOIN workers ON jobs.worker_id = workers.id AND workers.company_id = jobs.company_id
        WHERE jobs.company_id = $1 AND jobs.client_id = $2
        ORDER BY jobs.date DESC, jobs.id DESC
      `, [companyId, clientId]),
      pool.query(`
        SELECT subscriptions.*, workers.name AS worker_name
        FROM subscriptions
        LEFT JOIN workers ON subscriptions.worker_id = workers.id AND workers.company_id = subscriptions.company_id
        WHERE subscriptions.company_id = $1 AND subscriptions.client_id = $2
        ORDER BY subscriptions.id DESC
      `, [companyId, clientId]),
      pool.query(`
        SELECT *
        FROM invoices
        WHERE company_id = $1 AND client_id = $2
        ORDER BY id DESC
      `, [companyId, clientId]),
      pool.query(`
        SELECT *
        FROM activity_log
        WHERE company_id = $1
          AND (
            details::text ILIKE '%' || '"client_id":' || $2 || '%'
            OR details::text ILIKE '%' || '"converted_client_id":' || $2 || '%'
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 50
      `, [companyId, String(clientId)])
    ]);

    const timeline = [];

    leads.rows.forEach(item => {
      timeline.push(formatTimelineItem("lead", item.created_at || item.visit_date, item.customer_name || "Lead", item.status, item.service || "", { id: item.id }));
    });

    estimates.rows.forEach(item => {
      timeline.push(formatTimelineItem("estimate", item.created_at || item.visit_date, item.customer_name || "Estimate", item.status, item.service || "", { id: item.id }));
    });

    jobs.rows.forEach(item => {
      timeline.push(formatTimelineItem("job", item.date || item.created_at, item.service || "Job", normalizeJobStatus(item.status), item.internal_notes || "", { id: item.id }));
    });

    subscriptions.rows.forEach(item => {
      timeline.push(formatTimelineItem("subscription", item.next_date || item.created_at, item.service || "Subscription", item.status, item.frequency || "", { id: item.id }));
    });

    invoices.rows.forEach(item => {
      timeline.push(formatTimelineItem("invoice", item.issued_date || item.created_at, item.invoice_number || `Invoice #${item.id}`, item.status, `$${Number(item.amount || 0)}`, { id: item.id }));
    });

    if (clientResult.rows[0].notes) {
      timeline.push(formatTimelineItem("note", new Date().toISOString(), "Client note", "saved", clientResult.rows[0].notes, { id: clientId }));
    }

    activity.rows.forEach(item => {
      const details = safeJsonParse(item.details, {});
      timeline.push(formatTimelineItem("activity", item.created_at, item.action, "logged", JSON.stringify(details), { id: item.id }));
    });

    timeline.sort((a, b) => new Date(b.event_date || 0) - new Date(a.event_date || 0));

    const enrichedInvoices = await enrichInvoiceRowsWithFinancials(companyId, invoices.rows);

    res.json({
      client: clientResult.rows[0],
      leads: leads.rows,
      estimates: estimates.rows,
      jobs: jobs.rows,
      subscriptions: subscriptions.rows,
      invoices: enrichedInvoices.map(item => ({ ...item, line_items: safeJsonParse(item.line_items, []) })),
      timeline
    });
  } catch (err) {
    console.log("CLIENT TIMELINE ERROR:", err);
    sendSafeServerError(res, err, "routes/clients");
  }
});


module.exports = router;

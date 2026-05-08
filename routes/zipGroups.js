const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { sendSafeServerError } = require("../services/safeServerError");
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

const router = express.Router();
const DEPRECATED_ENDPOINT_ERROR = { error: "Deprecated endpoint. Use canonical API route." };

function lockDeprecatedLegacyMutations(req, res, next) {
  const method = req.method;
  const path = req.path;
  const isLockedLegacyMutation = (
    (method === "POST" && path === "/zip-groups") ||
    (method === "DELETE" && /^\/zip-groups\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/zip-codes") ||
    (method === "DELETE" && /^\/zip-codes\/[^/]+$/.test(path))
  );
  if (isLockedLegacyMutation) {
    return res.status(410).json(DEPRECATED_ENDPOINT_ERROR);
  }
  return next();
}
router.use(lockDeprecatedLegacyMutations);

/* ================= ZIP GROUPS ================= */

router.get("/zip-groups-full", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/zip-groups-full", "/ops/zip-groups-full");
    const company_id = req.user.company_id;

    const groups = await pool.query(
      "SELECT * FROM zip_groups WHERE company_id=$1 ORDER BY id DESC",
      [company_id]
    );

    const zips = await pool.query(
      "SELECT * FROM zip_codes WHERE company_id=$1 ORDER BY id DESC",
      [company_id]
    );

    res.json({
      groups: groups.rows,
      zips: zips.rows
    });
  } catch (err) {
    console.log("ZIP FULL ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.post("/zip-groups", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/zip-groups", "/ops/zip-groups");
    const { name, day } = req.body;
    const company_id = req.user.company_id;

    if (!name || day === undefined || day === null) {
      return res.status(400).json({ error: "Missing data" });
    }

    const result = await pool.query(
      "INSERT INTO zip_groups (name, day, company_id) VALUES ($1,$2,$3) RETURNING *",
      [name, day, company_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD ZIP GROUP ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.delete("/zip-groups/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/zip-groups/:id", "/ops/zip-groups/:id");
    const company_id = req.user.company_id;
    const id = req.params.id;

    await pool.query(
      "DELETE FROM zip_codes WHERE group_id=$1 AND company_id=$2",
      [id, company_id]
    );

    await pool.query(
      "DELETE FROM zip_groups WHERE id=$1 AND company_id=$2",
      [id, company_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE ZIP GROUP ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.post("/zip-codes", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/zip-codes", "/ops/zip-codes");
    const { zip, group_id } = req.body;
    const company_id = req.user.company_id;

    if (!zip || !group_id) {
      return res.status(400).json({ error: "Missing data" });
    }

    const group = await pool.query(
      "SELECT id FROM zip_groups WHERE id=$1 AND company_id=$2 LIMIT 1",
      [group_id, company_id]
    );

    if (group.rows.length === 0) {
      return res.status(400).json({ error: "Zip group not found" });
    }

    const result = await pool.query(
      "INSERT INTO zip_codes (zip, group_id, company_id) VALUES ($1,$2,$3) RETURNING *",
      [zip, group_id, company_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("ADD ZIP CODE ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.delete("/zip-codes/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    warnDeprecatedRoute("/zip-codes/:id", "/ops/zip-codes/:id");
    const company_id = req.user.company_id;
    const id = req.params.id;

    await pool.query(
      "DELETE FROM zip_codes WHERE id=$1 AND company_id=$2",
      [id, company_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE ZIP CODE ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});


router.get("/ops/zip-groups-full", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const companyId = req.user.company_id;
    const groups = await pool.query(`
      SELECT *
      FROM zip_groups
      WHERE company_id = $1
      ORDER BY day ASC, name ASC
    `, [companyId]);

    const zips = await pool.query(`
      SELECT *
      FROM zip_codes
      WHERE company_id = $1
      ORDER BY zip ASC
    `, [companyId]);

    const workerLinks = await pool.query(`
      SELECT
        worker_zip_groups.group_id,
        workers.id AS worker_id,
        workers.name AS worker_name,
        workers.active
      FROM worker_zip_groups
      JOIN workers ON workers.id = worker_zip_groups.worker_id AND workers.company_id = worker_zip_groups.company_id
      WHERE worker_zip_groups.company_id = $1
      ORDER BY workers.name ASC
    `, [companyId]);

    res.json({
      groups: groups.rows.map(group => ({
        ...group,
        zips: zips.rows.filter(zip => String(zip.group_id) === String(group.id)),
        workers: workerLinks.rows.filter(link => String(link.group_id) === String(group.id))
      }))
    });
  } catch (err) {
    console.log("OPS ZIP GROUPS ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.put("/ops/zip-groups/:id/workers", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    await ensureOperationsSchema();
    const workerIds = Array.isArray(req.body.worker_ids) ? req.body.worker_ids : [];
    const companyId = req.user.company_id;
    const groupId = Number(req.params.id);

    if (!Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ error: "Invalid zip group id" });
    }

    const groupLookup = await pool.query(
      "SELECT id FROM zip_groups WHERE id=$1 AND company_id=$2 LIMIT 1",
      [groupId, companyId]
    );

    if (groupLookup.rows.length === 0) {
      return res.status(404).json({ error: "Zip group not found" });
    }

    const resolvedWorkerIds = [];
    for (const workerId of workerIds) {
      const parsedWorkerId = Number(workerId);
      if (!Number.isInteger(parsedWorkerId) || parsedWorkerId <= 0) {
        return res.status(400).json({ error: "Worker not found in this company" });
      }

      const workerLookup = await pool.query(
        "SELECT id FROM workers WHERE id=$1 AND company_id=$2 LIMIT 1",
        [parsedWorkerId, companyId]
      );

      if (workerLookup.rows.length === 0) {
        return res.status(400).json({ error: "Worker not found in this company" });
      }

      resolvedWorkerIds.push(parsedWorkerId);
    }

    await pool.query(`
      DELETE FROM worker_zip_groups
      WHERE company_id = $1 AND group_id = $2
    `, [companyId, groupId]);

    for (const workerId of resolvedWorkerIds) {
      await pool.query(`
        INSERT INTO worker_zip_groups (company_id, worker_id, group_id)
        VALUES ($1,$2,$3)
      `, [companyId, workerId, groupId]);

    }
    await logActivity({
      companyId,
      userId: req.user.id,
      action: "zip_group_workers_updated",
      entityType: "zip_group",
      entityId: groupId,
      details: { worker_ids: resolvedWorkerIds }
    });

    res.json({ success: true });
  } catch (err) {
    console.log("OPS ZIP WORKERS ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});


router.post("/ops/zip-groups", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const { name, day } = req.body;

    if (!name || day === undefined || day === null) {
      return res.status(400).json({ error: "Missing data" });
    }

    const result = await pool.query(
      "INSERT INTO zip_groups (name, day, company_id) VALUES ($1,$2,$3) RETURNING *",
      [name, day, req.user.company_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("OPS ADD ZIP GROUP ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.delete("/ops/zip-groups/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const id = req.params.id;
    const companyId = req.user.company_id;

    await pool.query("DELETE FROM zip_codes WHERE group_id=$1 AND company_id=$2", [id, companyId]);
    await pool.query("DELETE FROM worker_zip_groups WHERE group_id=$1 AND company_id=$2", [id, companyId]);
    const deleted = await pool.query("DELETE FROM zip_groups WHERE id=$1 AND company_id=$2", [id, companyId]);

    if (!deleted.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.log("OPS DELETE ZIP GROUP ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.post("/ops/zip-codes", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const { zip, group_id } = req.body;

    if (!zip || !group_id) {
      return res.status(400).json({ error: "Missing data" });
    }

    const group = await pool.query(
      "SELECT id FROM zip_groups WHERE id=$1 AND company_id=$2 LIMIT 1",
      [group_id, req.user.company_id]
    );

    if (group.rows.length === 0) {
      return res.status(400).json({ error: "Zip group not found" });
    }

    const result = await pool.query(
      "INSERT INTO zip_codes (zip, group_id, company_id) VALUES ($1,$2,$3) RETURNING *",
      [zip, group_id, req.user.company_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log("OPS ADD ZIP CODE ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});

router.delete("/ops/zip-codes/:id", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const deleted = await pool.query(
      "DELETE FROM zip_codes WHERE id=$1 AND company_id=$2",
      [req.params.id, req.user.company_id]
    );

    if (!deleted.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.log("OPS DELETE ZIP CODE ERROR:", err);
    sendSafeServerError(res, err, "routes/zipGroups");
  }
});


module.exports = router;

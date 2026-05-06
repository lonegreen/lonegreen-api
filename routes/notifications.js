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

/* ================= ACCOUNT / COMPANY / ACTIVITY / NOTIFICATIONS ================= */

router.get("/me", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, role, company_id
      FROM users
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [req.user.id, req.user.company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    res.json({
      id: user.id,
      username: user.username,
      role: normalizeRole(user.role),
      company_id: user.company_id
    });
  } catch (err) {
    console.log("GET ME ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.get("/company", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        phone,
        email,
        address,
        service_area,
        business_hours,
        invoice_logo_url,
        invoice_display_name,
        invoice_phone,
        invoice_email,
        invoice_website,
        invoice_address,
        invoice_footer,
        payment_instructions,
        zelle_name,
        zelle_contact,
        invoice_prefix,
        created_at
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [req.user.company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Company not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log("GET COMPANY ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.put("/company", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const {
      name,
      phone,
      email,
      address,
      service_area,
      business_hours,
      invoice_logo_url,
      invoice_display_name,
      invoice_phone,
      invoice_email,
      invoice_website,
      invoice_address,
      invoice_footer,
      payment_instructions,
      zelle_name,
      zelle_contact,
      invoice_prefix
    } = req.body;

    const current = await pool.query(`
      SELECT
        id,
        name,
        phone,
        email,
        address,
        service_area,
        business_hours,
        invoice_logo_url,
        invoice_display_name,
        invoice_phone,
        invoice_email,
        invoice_website,
        invoice_address,
        invoice_footer,
        payment_instructions,
        zelle_name,
        zelle_contact,
        invoice_prefix
      FROM companies
      WHERE id = $1
      LIMIT 1
    `, [company_id]);

    if (current.rows.length === 0) {
      return res.status(404).json({ error: "Company not found" });
    }

    const existing = current.rows[0];

    const updated = await pool.query(`
      UPDATE companies
      SET
        name = $1,
        phone = $2,
        email = $3,
        address = $4,
        service_area = $5,
        business_hours = $6,
        invoice_logo_url = $7,
        invoice_display_name = $8,
        invoice_phone = $9,
        invoice_email = $10,
        invoice_website = $11,
        invoice_address = $12,
        invoice_footer = $13,
        payment_instructions = $14,
        zelle_name = $15,
        zelle_contact = $16,
        invoice_prefix = $17
      WHERE id = $18
      RETURNING
        id,
        name,
        phone,
        email,
        address,
        service_area,
        business_hours,
        invoice_logo_url,
        invoice_display_name,
        invoice_phone,
        invoice_email,
        invoice_website,
        invoice_address,
        invoice_footer,
        payment_instructions,
        zelle_name,
        zelle_contact,
        invoice_prefix,
        created_at
    `, [
      name || existing.name || "",
      phone || "",
      email || "",
      address || "",
      service_area || "",
      business_hours || "",
      invoice_logo_url !== undefined ? invoice_logo_url || "" : existing.invoice_logo_url || "",
      invoice_display_name !== undefined ? invoice_display_name || "" : existing.invoice_display_name || "",
      invoice_phone !== undefined ? invoice_phone || "" : existing.invoice_phone || "",
      invoice_email !== undefined ? invoice_email || "" : existing.invoice_email || "",
      invoice_website !== undefined ? invoice_website || "" : existing.invoice_website || "",
      invoice_address !== undefined ? invoice_address || "" : existing.invoice_address || "",
      invoice_footer !== undefined ? invoice_footer || "" : existing.invoice_footer || "",
      payment_instructions !== undefined ? payment_instructions || "" : existing.payment_instructions || "",
      zelle_name !== undefined ? zelle_name || "" : existing.zelle_name || "",
      zelle_contact !== undefined ? zelle_contact || "" : existing.zelle_contact || "",
      invoice_prefix !== undefined ? invoice_prefix || "" : existing.invoice_prefix || "",
      company_id
    ]);

    await logActivity({
      companyId: company_id,
      userId: req.user.id,
      action: "company_updated",
      entityType: "company",
      entityId: company_id,
      details: {
        before: existing,
        after: updated.rows[0]
      }
    });

    await createNotification({
      companyId: company_id,
      type: "company_update",
      title: "Company settings updated",
      message: `${req.user.username} updated company profile settings.`
    });

    res.json(updated.rows[0]);
  } catch (err) {
    console.log("UPDATE COMPANY ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.put("/me/password", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }

    if (String(new_password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const result = await pool.query(`
      SELECT id, username, password, company_id
      FROM users
      WHERE id = $1 AND company_id = $2
      LIMIT 1
    `, [req.user.id, req.user.company_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    const isMatch = await require("bcrypt").compare(current_password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const hashedPassword = await require("bcrypt").hash(new_password, 10);

    await pool.query(`
      UPDATE users
      SET password = $1
      WHERE id = $2 AND company_id = $3
    `, [hashedPassword, user.id, user.company_id]);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "password_changed",
      entityType: "user",
      entityId: req.user.id,
      details: {
        username: user.username
      }
    });

    await createNotification({
      companyId: req.user.company_id,
      userId: req.user.id,
      type: "security",
      title: "Password changed",
      message: "Your account password was changed successfully."
    });

    res.json({ success: true });
  } catch (err) {
    console.log("CHANGE PASSWORD ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.get("/activity-log", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureActivityLogSchema();
    const result = await pool.query(`
      SELECT id, company_id, user_id, action, entity_type, entity_id, details, created_at
      FROM activity_log
      WHERE company_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `, [req.user.company_id]);

    res.json(result.rows.map(item => ({
      ...item,
      details: safeJsonParse(item.details, {})
    })));
  } catch (err) {
    console.log("GET ACTIVITY LOG ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.get("/notifications", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureNotificationsSchema();
    const result = await pool.query(`
      SELECT id, company_id, user_id, type, title, message, is_read, metadata, created_at
      FROM notifications
      WHERE company_id = $1
        AND (user_id IS NULL OR user_id = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `, [req.user.company_id, req.user.id]);

    res.json(result.rows.map((row) => ({
      ...row,
      metadata: safeJsonParse(row.metadata, {})
    })));
  } catch (err) {
    console.log("GET NOTIFICATIONS ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.get("/notifications/unread-count", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureNotificationsSchema();
    const result = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM notifications
      WHERE company_id = $1
        AND is_read = FALSE
        AND (user_id IS NULL OR user_id = $2)
    `, [req.user.company_id, req.user.id]);

    res.json({ unread_count: result.rows[0] ? result.rows[0].c : 0 });
  } catch (err) {
    console.log("GET NOTIFICATIONS UNREAD ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.put("/notifications/read-all", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureNotificationsSchema();
    const result = await pool.query(`
      UPDATE notifications
      SET is_read = TRUE
      WHERE company_id = $1
        AND is_read = FALSE
        AND (user_id IS NULL OR user_id = $2)
      RETURNING id
    `, [req.user.company_id, req.user.id]);

    res.json({ updated: result.rowCount });
  } catch (err) {
    console.log("READ ALL NOTIFICATIONS ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

router.put("/notifications/:id/read", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureNotificationsSchema();
    const id = req.params.id;

    const result = await pool.query(`
      UPDATE notifications
      SET is_read = TRUE
      WHERE id = $1
        AND company_id = $2
        AND (user_id IS NULL OR user_id = $3)
      RETURNING id, company_id, user_id, type, title, message, is_read, metadata, created_at
    `, [id, req.user.company_id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }

    const row = result.rows[0];

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "notification_read",
      entityType: "notification",
      entityId: Number(id),
      details: {
        title: row.title,
        type: row.type
      }
    });

    res.json({
      ...row,
      metadata: safeJsonParse(row.metadata, {})
    });
  } catch (err) {
    console.log("READ NOTIFICATION ERROR:", err);
    sendSafeServerError(res, err, "routes/notifications");
  }
});

module.exports = router;

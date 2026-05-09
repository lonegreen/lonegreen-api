const express = require("express");
const rateLimit = require("express-rate-limit");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");

const {
  requireMinimumRole,
  requirePlatformOwner,
  getBearerToken,
  verifyCustomerBearerToken
} = auth;
const {
  getTrustExpiryWindowDays,
  getExpiringTrustItems,
  syncExpiredTrustStatuses,
  buildTrustAlertsForCompany
} = require("../services/trustExpiryService");

const router = express.Router();

const companyPublicReportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" }
});

function cleanText(value) {
  return String(value || "").trim();
}

function cleanDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(text);
  return match ? text : null;
}

function trustR2PublicBaseUrl() {
  return String(process.env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function hasUnsafeTrustDocumentPath(pathOrKey) {
  const raw = String(pathOrKey || "");
  if (!raw || raw.includes("\\") || raw.includes("\u0000")) {
    return true;
  }
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.split("/").some((part) => part === "..");
  } catch {
    return true;
  }
}

function isAllowedTrustDocumentUrl(fileUrl) {
  const raw = cleanText(fileUrl);
  if (!raw) {
    return false;
  }

  if (raw.startsWith("/uploads/")) {
    return !hasUnsafeTrustDocumentPath(raw.slice("/uploads/".length));
  }

  const r2Base = trustR2PublicBaseUrl();
  if (!r2Base || !raw.startsWith(`${r2Base}/`)) {
    return false;
  }

  const key = raw.slice(r2Base.length + 1);
  if (hasUnsafeTrustDocumentPath(key)) {
    return false;
  }

  try {
    const base = new URL(r2Base);
    const url = new URL(raw);
    return url.origin === base.origin && url.href.startsWith(`${base.href.replace(/\/+$/, "")}/`);
  } catch {
    return false;
  }
}

function normalizeTrustStatus(value, fallback = "pending") {
  const candidate = cleanText(value).toLowerCase();
  if (candidate === "pending" || candidate === "submitted" || candidate === "approved" || candidate === "rejected") {
    return candidate;
  }
  return fallback;
}

async function writeModerationEvent({
  companyId,
  actorUserId,
  eventType,
  targetType,
  targetId,
  notes
}) {
  await pool.query(
    `
    INSERT INTO trust_moderation_events
      (company_id, actor_user_id, event_type, target_type, target_id, notes)
    VALUES
      ($1, $2, $3, $4, $5, $6)
    `,
    [companyId, actorUserId || null, eventType, targetType, targetId || null, notes || null]
  );
}

router.post(
  "/ops/company/verification/submit",
  auth,
  requireCompanyBillingForMutations,
  requireMinimumRole("admin"),
  async (req, res) => {
    try {
      const companyId = Number(req.user && req.user.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const notes = cleanText(req.body && req.body.verification_notes);
      const result = await pool.query(
        `
        UPDATE companies
        SET
          verification_status = 'submitted',
          verification_submitted_at = CURRENT_TIMESTAMP,
          verification_reviewed_at = NULL,
          verification_notes = $2
        WHERE id = $1
        RETURNING id, verification_status, verification_submitted_at, verification_reviewed_at, verification_notes
        `,
        [companyId, notes || null]
      );

      return res.json(result.rows[0] || null);
    } catch (err) {
      return res.status(500).json({ error: "Unable to submit verification" });
    }
  }
);

router.post(
  "/ops/company/verification/resubmit",
  auth,
  requireCompanyBillingForMutations,
  requireMinimumRole("admin"),
  async (req, res) => {
    try {
      const companyId = Number(req.user && req.user.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const notes = cleanText(req.body && req.body.verification_notes);
      const result = await pool.query(
        `
        UPDATE companies
        SET
          verification_status = 'submitted',
          verification_submitted_at = CURRENT_TIMESTAMP,
          verification_reviewed_at = NULL,
          verification_notes = CASE
            WHEN $2 IS NULL OR $2 = '' THEN verification_notes
            ELSE $2
          END
        WHERE id = $1
          AND verification_status IN ('rejected', 'pending', 'submitted')
        RETURNING id, verification_status, verification_submitted_at, verification_reviewed_at, verification_notes
        `,
        [companyId, notes || null]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Company not found" });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      return res.status(500).json({ error: "Unable to resubmit verification" });
    }
  }
);

router.post(
  "/ops/company/insurance/upload",
  auth,
  requireCompanyBillingForMutations,
  requireMinimumRole("admin"),
  async (req, res) => {
    try {
      const companyId = Number(req.user && req.user.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const provider = cleanText(req.body && req.body.insurance_provider);
      const documentUrl = cleanText(req.body && req.body.insurance_document_url);
      const expiry = cleanDate(req.body && req.body.insurance_expiry_date);
      const status = "submitted";
      if (documentUrl && !isAllowedTrustDocumentUrl(documentUrl)) {
        return res.status(400).json({ error: "Document URL must use FairLinx upload storage" });
      }

      const result = await pool.query(
        `
        UPDATE companies
        SET
          insurance_provider = $2,
          insurance_expiry_date = $3,
          insurance_document_url = $4,
          insurance_status = $5
        WHERE id = $1
        RETURNING id, insurance_status, insurance_provider, insurance_expiry_date, insurance_document_url
        `,
        [companyId, provider || null, expiry, documentUrl || null, status]
      );

      return res.json(result.rows[0] || null);
    } catch (err) {
      return res.status(500).json({ error: "Unable to upload insurance details" });
    }
  }
);

router.post(
  "/ops/company/license/upload",
  auth,
  requireCompanyBillingForMutations,
  requireMinimumRole("admin"),
  async (req, res) => {
    try {
      const companyId = Number(req.user && req.user.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const licenseNumber = cleanText(req.body && req.body.license_number);
      const licenseState = cleanText(req.body && req.body.license_state).toUpperCase().slice(0, 2);
      const documentUrl = cleanText(req.body && req.body.license_document_url);
      const expiry = cleanDate(req.body && req.body.license_expiry_date);
      const status = "submitted";
      if (documentUrl && !isAllowedTrustDocumentUrl(documentUrl)) {
        return res.status(400).json({ error: "Document URL must use FairLinx upload storage" });
      }

      const result = await pool.query(
        `
        UPDATE companies
        SET
          license_number = $2,
          license_state = $3,
          license_expiry_date = $4,
          license_document_url = $5,
          license_status = $6
        WHERE id = $1
        RETURNING id, license_number, license_state, license_expiry_date, license_status, license_document_url
        `,
        [companyId, licenseNumber || null, licenseState || null, expiry, documentUrl || null, status]
      );

      return res.json(result.rows[0] || null);
    } catch (err) {
      return res.status(500).json({ error: "Unable to upload license details" });
    }
  }
);

router.post("/companies/:id/report", companyPublicReportLimiter, async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    let customerId = null;
    const header = req.headers && req.headers.authorization;
    const token = getBearerToken(header);
    if (token) {
      try {
        const principal = verifyCustomerBearerToken(header);
        customerId = Number(principal && (principal.customer_account_id || principal.id)) || null;
      } catch (_) {
        customerId = null;
      }
    }

    const reportType = cleanText(req.body && req.body.report_type).toLowerCase() || "general";
    const reason = cleanText(req.body && req.body.reason);
    if (!reason) {
      return res.status(400).json({ error: "reason is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO company_reports (company_id, customer_id, report_type, reason, status)
      VALUES ($1, $2, $3, $4, 'open')
      RETURNING id, company_id, customer_id, report_type, reason, status, created_at
      `,
      [companyId, customerId, reportType, reason]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Unable to submit report" });
  }
});

router.get("/platform/verifications", auth, requirePlatformOwner, async (req, res) => {
  try {
    const rows = await pool.query(
      `
      SELECT
        id,
        name,
        verification_status,
        verification_submitted_at,
        verification_reviewed_at,
        verification_notes,
        insurance_status,
        insurance_provider,
        insurance_expiry_date,
        insurance_document_url,
        license_number,
        license_state,
        license_expiry_date,
        license_status,
        license_document_url
      FROM companies
      WHERE verification_status = 'submitted'
         OR insurance_status = 'submitted'
         OR license_status = 'submitted'
      ORDER BY verification_submitted_at DESC NULLS LAST, id DESC
      `
    );
    return res.json(rows.rows);
  } catch (err) {
    return res.status(500).json({ error: "Unable to load verifications" });
  }
});

router.put("/platform/verifications/:companyId/notes", auth, requirePlatformOwner, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const notes = cleanText(req.body && req.body.verification_notes);
    const result = await pool.query(
      `
      UPDATE companies
      SET
        verification_notes = $2,
        verification_reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, verification_notes, verification_reviewed_at
      `,
      [companyId, notes || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    await writeModerationEvent({
      companyId,
      actorUserId: req.user && req.user.id,
      eventType: "verification_notes_updated",
      targetType: "company_verification",
      targetId: companyId,
      notes: notes || null
    });

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Unable to update verification notes" });
  }
});

router.put("/platform/verifications/:companyId/suspend", auth, requirePlatformOwner, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const notes = cleanText(req.body && req.body.verification_notes) || "Suspended by trust moderation";
    const result = await pool.query(
      `
      UPDATE companies
      SET
        verification_status = 'rejected',
        verification_reviewed_at = CURRENT_TIMESTAMP,
        verification_notes = $2,
        platform_suspended_at = CURRENT_TIMESTAMP,
        platform_suspension_reason = $2,
        is_verified = FALSE,
        verified_at = NULL
      WHERE id = $1
      RETURNING id, verification_status, verification_reviewed_at, verification_notes, platform_suspended_at, platform_suspension_reason
      `,
      [companyId, notes]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    await writeModerationEvent({
      companyId,
      actorUserId: req.user && req.user.id,
      eventType: "verification_suspended",
      targetType: "company_verification",
      targetId: companyId,
      notes
    });

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Unable to suspend company verification" });
  }
});

router.put("/platform/verifications/:companyId/approve", auth, requirePlatformOwner, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const notes = cleanText(req.body && req.body.verification_notes);
    const result = await pool.query(
      `
      UPDATE companies
      SET
        verification_status = 'approved',
        insurance_status = CASE WHEN insurance_document_url IS NOT NULL AND insurance_document_url <> '' THEN 'approved' ELSE insurance_status END,
        license_status = CASE WHEN license_document_url IS NOT NULL AND license_document_url <> '' THEN 'approved' ELSE license_status END,
        verification_reviewed_at = CURRENT_TIMESTAMP,
        verification_notes = $2,
        is_verified = TRUE,
        verified_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, verification_status, insurance_status, license_status, verification_reviewed_at, verification_notes, is_verified, verified_at
      `,
      [companyId, notes || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    await writeModerationEvent({
      companyId,
      actorUserId: req.user && req.user.id,
      eventType: "verification_approved",
      targetType: "company_verification",
      targetId: companyId,
      notes: notes || null
    });

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Unable to approve verification" });
  }
});

router.put("/platform/verifications/:companyId/reject", auth, requirePlatformOwner, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const notes = cleanText(req.body && req.body.verification_notes);
    const result = await pool.query(
      `
      UPDATE companies
      SET
        verification_status = 'rejected',
        insurance_status = CASE WHEN insurance_status = 'submitted' THEN 'rejected' ELSE insurance_status END,
        license_status = CASE WHEN license_status = 'submitted' THEN 'rejected' ELSE license_status END,
        verification_reviewed_at = CURRENT_TIMESTAMP,
        verification_notes = $2,
        is_verified = FALSE,
        verified_at = NULL
      WHERE id = $1
      RETURNING id, verification_status, insurance_status, license_status, verification_reviewed_at, verification_notes, is_verified, verified_at
      `,
      [companyId, notes || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    await writeModerationEvent({
      companyId,
      actorUserId: req.user && req.user.id,
      eventType: "verification_rejected",
      targetType: "company_verification",
      targetId: companyId,
      notes: notes || null
    });

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Unable to reject verification" });
  }
});

router.get("/platform/reports", auth, requirePlatformOwner, async (req, res) => {
  try {
    const rows = await pool.query(
      `
      SELECT
        company_reports.id,
        company_reports.company_id,
        companies.name AS company_name,
        company_reports.customer_id,
        company_reports.report_type,
        company_reports.reason,
        company_reports.status,
        company_reports.created_at,
        company_reports.reviewed_at,
        company_reports.reviewed_by_user_id,
        company_reports.resolution_notes
      FROM company_reports
      JOIN companies ON companies.id = company_reports.company_id
      ORDER BY company_reports.created_at DESC, company_reports.id DESC
      `
    );
    return res.json(rows.rows);
  } catch (err) {
    return res.status(500).json({ error: "Unable to load reports" });
  }
});

router.get("/platform/reports/:id", auth, requirePlatformOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid report id" });
    }

    const rows = await pool.query(
      `
      SELECT
        company_reports.id,
        company_reports.company_id,
        companies.name AS company_name,
        company_reports.customer_id,
        company_reports.report_type,
        company_reports.reason,
        company_reports.status,
        company_reports.created_at,
        company_reports.reviewed_at,
        company_reports.reviewed_by_user_id,
        company_reports.resolution_notes
      FROM company_reports
      JOIN companies ON companies.id = company_reports.company_id
      WHERE company_reports.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!rows.rows.length) {
      return res.status(404).json({ error: "Report not found" });
    }
    return res.json(rows.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Unable to load report detail" });
  }
});

router.put("/platform/reports/:id/resolve", auth, requirePlatformOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid report id" });
    }

    const notes = cleanText(req.body && req.body.resolution_notes);
    const status = cleanText(req.body && req.body.status).toLowerCase() || "resolved";
    const normalizedStatus = status === "dismissed" ? "dismissed" : "resolved";

    const result = await pool.query(
      `
      UPDATE company_reports
      SET
        status = $2,
        reviewed_at = CURRENT_TIMESTAMP,
        reviewed_by_user_id = $3,
        resolution_notes = $4
      WHERE id = $1
      RETURNING id, company_id, customer_id, report_type, reason, status, created_at, reviewed_at, reviewed_by_user_id, resolution_notes
      `,
      [id, normalizedStatus, req.user && req.user.id, notes || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Report not found" });
    }

    const report = result.rows[0];
    await writeModerationEvent({
      companyId: report.company_id,
      actorUserId: req.user && req.user.id,
      eventType: "report_resolved",
      targetType: "company_report",
      targetId: report.id,
      notes: notes || normalizedStatus
    });

    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: "Unable to resolve report" });
  }
});

router.get(
  "/ops/company/trust/alerts",
  auth,
  requireCompanyBillingForMutations,
  requireMinimumRole("admin"),
  async (req, res) => {
    try {
      const companyId = Number(req.user && req.user.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const alerts = await buildTrustAlertsForCompany(companyId);
      return res.json({
        company_id: companyId,
        expiry_window_days: getTrustExpiryWindowDays(),
        alerts
      });
    } catch (err) {
      return res.status(500).json({ error: "Unable to load trust alerts" });
    }
  }
);

router.get("/platform/trust/kpis", auth, requirePlatformOwner, async (req, res) => {
  try {
    const [companiesResult, reportsResult, expiringItems] = await Promise.all([
      pool.query(
        `
        SELECT
          id,
          verification_status,
          insurance_status,
          license_status,
          platform_suspended_at
        FROM companies
        `
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS pending_reports
        FROM company_reports
        WHERE status = 'open'
        `
      ),
      getExpiringTrustItems()
    ]);

    const companies = companiesResult.rows || [];
    const pendingVerifications = companies.filter((row) => String(row.verification_status || "").toLowerCase() === "submitted").length;
    const verifiedCompanies = companies.filter((row) => {
      const status = String(row.verification_status || "").toLowerCase();
      return status === "approved" || status === "verified";
    }).length;
    const rejectedCompanies = companies.filter((row) => String(row.verification_status || "").toLowerCase() === "rejected").length;
    const suspendedCompanies = companies.filter((row) => Boolean(row.platform_suspended_at)).length;
    const pendingReports = Number(reportsResult.rows[0] && reportsResult.rows[0].pending_reports) || 0;

    const expiringInsurance = expiringItems.filter((item) => item.insurance_expiring_soon).length;
    const expiredInsurance = expiringItems.filter((item) => item.insurance_expired).length;
    const expiringLicenses = expiringItems.filter((item) => item.license_expiring_soon).length;
    const expiredLicenses = expiringItems.filter((item) => item.license_expired).length;

    return res.json({
      pending_verifications: pendingVerifications,
      verified_companies: verifiedCompanies,
      rejected_companies: rejectedCompanies,
      suspended_companies: suspendedCompanies,
      pending_reports: pendingReports,
      expiring_insurance: expiringInsurance,
      expired_insurance: expiredInsurance,
      expiring_licenses: expiringLicenses,
      expired_licenses: expiredLicenses,
      expiry_window_days: getTrustExpiryWindowDays()
    });
  } catch (err) {
    return res.status(500).json({ error: "Unable to load trust KPIs" });
  }
});

router.post("/platform/trust/sync-expired", auth, requirePlatformOwner, async (req, res) => {
  try {
    const summary = await syncExpiredTrustStatuses();
    return res.json({
      success: true,
      updated_count: Number(summary && summary.updated_count) || 0
    });
  } catch (err) {
    return res.status(500).json({ error: "Unable to sync expired trust statuses" });
  }
});

module.exports = router;

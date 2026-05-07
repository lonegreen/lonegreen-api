const express = require("express");
const rateLimit = require("express-rate-limit");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { requireMinimumRole, isManagerOrAbove, isWorker, workerIdForUser } = auth;
const {
  upload,
  publicUploadUrl,
  deleteLocalUpload,
  assertUploadContentMatchesMime
} = require("../services/uploadService");
const { ensureJobPhotoSchema, logActivity } = require("../services/routeHelpers");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload attempts, please try again later" }
});

const PHOTO_TYPES = new Set(["before", "after"]);
const COMPANY_LOGO_ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const JOB_PHOTO_ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const COMPANY_LOGO_MAX_SIZE = 2 * 1024 * 1024;

function forbidden(res) {
  return res.status(403).json({ error: "Forbidden" });
}

async function getAccessibleJob(req, res, jobId) {
  const result = await pool.query(
    `SELECT id, company_id, worker_id
     FROM jobs
     WHERE id = $1 AND company_id = $2
     LIMIT 1`,
    [jobId, req.user.company_id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Job not found" });
    return null;
  }

  const job = result.rows[0];

  if (isManagerOrAbove(req.user)) {
    return job;
  }

  if (isWorker(req.user) && String(job.worker_id || "") === String(workerIdForUser(req.user) || "")) {
    return job;
  }

  forbidden(res);
  return null;
}

function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Max size is 8MB." });
    }

    return res.status(400).json({ error: err.message || "Upload failed" });
  });
}

async function verifyUploadContent(req, res, next) {
  if (!req.file || !req.file.path) {
    return next();
  }

  try {
    await assertUploadContentMatchesMime(req.file.path, req.file.mimetype);
    return next();
  } catch (err) {
    try {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
    } catch {
      /* ignore */
    }
    return res.status(400).json({ error: err.message || "File content validation failed" });
  }
}

function isSafeLocalUploadUrl(value) {
  const url = String(value || "").trim();
  return /^\/uploads\/[a-zA-Z0-9._-]+$/.test(url);
}

router.post("/uploads/job/:jobId/photo", auth, requireCompanyBillingForMutations, uploadLimiter, handleUpload, verifyUploadContent, async (req, res) => {
  try {
    await ensureJobPhotoSchema();

    const photoType = String(req.body.photo_type || "").toLowerCase();
    if (!PHOTO_TYPES.has(photoType)) {
      if (req.file) {
        await deleteLocalUpload(publicUploadUrl(req.file.filename));
      }
      return res.status(400).json({ error: "photo_type must be before or after" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }
    const photoMime = String(req.file.mimetype || "").toLowerCase();
    if (!JOB_PHOTO_ALLOWED_MIME.has(photoMime)) {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
      return res.status(400).json({ error: "Only JPG, PNG, and WEBP job photos are allowed" });
    }

    const job = await getAccessibleJob(req, res, req.params.jobId);
    if (!job) {
      if (req.file) {
        await deleteLocalUpload(publicUploadUrl(req.file.filename));
      }
      return;
    }

    const imageUrl = publicUploadUrl(req.file.filename);
    const result = await pool.query(
      `INSERT INTO job_photos (job_id, photo_type, image_url, company_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [job.id, photoType, imageUrl, req.user.company_id]
    );

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "job_photo_uploaded",
      entityType: "job_photo",
      entityId: result.rows[0].id,
      details: {
        job_id: Number(job.id),
        photo_type: photoType,
        image_url: imageUrl
      }
    });

    res.json(result.rows[0]);
  } catch (err) {
    if (req.file) {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
    }

    console.log("UPLOAD JOB PHOTO ERROR:", err);
    sendSafeServerError(res, err, "routes/uploads");
  }
});

router.get("/uploads/job/:jobId/photos", auth, async (req, res) => {
  try {
    await ensureJobPhotoSchema();

    const job = await getAccessibleJob(req, res, req.params.jobId);
    if (!job) {
      return;
    }

    const result = await pool.query(
      `SELECT *
       FROM job_photos
       WHERE job_id = $1 AND company_id = $2
       ORDER BY created_at DESC, id DESC`,
      [job.id, req.user.company_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.log("GET JOB PHOTOS ERROR:", err);
    sendSafeServerError(res, err, "routes/uploads");
  }
});

router.delete("/uploads/job/photos/:photoId", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
  try {
    await ensureJobPhotoSchema();

    const current = await pool.query(
      `SELECT *
       FROM job_photos
       WHERE id = $1 AND company_id = $2
       LIMIT 1`,
      [req.params.photoId, req.user.company_id]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const photo = current.rows[0];

    await pool.query(
      `DELETE FROM job_photos
       WHERE id = $1 AND company_id = $2`,
      [req.params.photoId, req.user.company_id]
    );

    await deleteLocalUpload(photo.image_url);

    await logActivity({
      companyId: req.user.company_id,
      userId: req.user.id,
      action: "job_photo_deleted",
      entityType: "job_photo",
      entityId: Number(req.params.photoId),
      details: {
        job_id: photo.job_id,
        photo_type: photo.photo_type,
        image_url: photo.image_url
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE JOB PHOTO ERROR:", err);
    sendSafeServerError(res, err, "routes/uploads");
  }
});

router.post("/uploads/company/logo", auth, requireCompanyBillingForMutations, requireMinimumRole("manager"), uploadLimiter, handleUpload, verifyUploadContent, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      if (req.file) {
        await deleteLocalUpload(publicUploadUrl(req.file.filename));
      }
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    const mimeType = String(req.file.mimetype || "").toLowerCase();
    if (!COMPANY_LOGO_ALLOWED_MIME.has(mimeType)) {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
      return res.status(400).json({ error: "Only JPG, PNG, and WEBP logo images are allowed" });
    }

    if (Number(req.file.size || 0) > COMPANY_LOGO_MAX_SIZE) {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
      return res.status(400).json({ error: "Logo file too large. Max size is 2MB." });
    }

    const currentCompany = await pool.query(
      `
      SELECT id, invoice_logo_url
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [companyId]
    );

    if (!currentCompany.rows.length) {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
      return res.status(404).json({ error: "Company not found" });
    }

    const previousLogoUrl = String(currentCompany.rows[0].invoice_logo_url || "");
    const nextLogoUrl = publicUploadUrl(req.file.filename);

    await pool.query(
      `
      UPDATE companies
      SET invoice_logo_url = $2
      WHERE id = $1
      `,
      [companyId, nextLogoUrl]
    );

    if (previousLogoUrl && previousLogoUrl !== nextLogoUrl && isSafeLocalUploadUrl(previousLogoUrl)) {
      await deleteLocalUpload(previousLogoUrl);
    }

    await logActivity({
      companyId,
      userId: req.user.id,
      action: "company_logo_uploaded",
      entityType: "company",
      entityId: Number(companyId),
      details: {
        invoice_logo_url: nextLogoUrl
      }
    });

    return res.json({ url: nextLogoUrl });
  } catch (err) {
    if (req.file) {
      await deleteLocalUpload(publicUploadUrl(req.file.filename));
    }
    sendSafeServerError(res, err, "UPLOAD COMPANY LOGO ERROR");
  }
});

module.exports = router;

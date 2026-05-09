const express = require("express");
const rateLimit = require("express-rate-limit");
const pool = require("../db/pool");
const { requireActiveCustomer } = require("../middleware/auth");
const { validateReviewContent } = require("../middleware/abuseGuards");
const { sendSafeServerError } = require("../services/safeServerError");
const activityLogService = require("../services/activityLogService");
const { sendOperationalEmailSafe } = require("../services/emailService");
const {
  resolveCustomerAccountId,
  loadPortalScopes,
  scopePairsInclude
} = require("../services/customerPortalScope");

const router = express.Router();

function queueSafeEmail(payload, options) {
  Promise.resolve()
    .then(() => sendOperationalEmailSafe(payload, options))
    .catch(() => {});
}

const customerAuth = requireActiveCustomer;
const reviewReportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false
});


function cleanReviewText(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function withModerationFlag(payload, res) {
  if (!res || !res.locals || res.locals.moderationFlagged !== true) {
    return payload;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...payload, moderation_flagged: true };
}

router.post("/reviews", customerAuth, validateReviewContent, async (req, res) => {
  try {
    const jobId = Number(req.body && req.body.job_id);
    const rating = Number(req.body && req.body.rating);
    const reviewText = cleanReviewText(req.body && req.body.review_text);

    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ error: "Invalid job_id" });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "rating must be an integer between 1 and 5" });
    }

    const accountId = await resolveCustomerAccountId(req.customer);
    const scopes = accountId ? await loadPortalScopes(accountId) : [];
    if (!scopes.length) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const jobResult = await pool.query(
      `
      SELECT id, company_id, client_id, status
      FROM jobs
      WHERE id = $1
      LIMIT 1
      `,
      [jobId]
    );
    const job = jobResult.rows[0];
    if (!job || String(job.status || "").toLowerCase() !== "completed") {
      return res.status(403).json({ error: "You can only review your own completed jobs" });
    }

    if (!scopePairsInclude(scopes, job.company_id, job.client_id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const inserted = await pool.query(
      `
      INSERT INTO company_reviews (company_id, client_id, job_id, rating, review_text)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, company_id, client_id, job_id, rating, review_text, is_public, created_at
      `,
      [job.company_id, job.client_id, job.id, rating, reviewText]
    );
    if (!inserted.rows.length) {
      return res.status(403).json({ error: "You can only review your own completed jobs" });
    }

    const review = inserted.rows[0];
    try {
      await activityLogService.logActivity({
        companyId: job.company_id,
        userId: null,
        action: "review_created",
        entityType: "company_review",
        entityId: review.id,
        details: {
          job_id: job.id,
          client_id: job.client_id,
          rating
        }
      });
    } catch (logErr) {
      console.log("REVIEW FOUNDATION LOG ERROR:", logErr && logErr.message);
    }
    const companyResult = await pool.query(
      "SELECT id, name, email FROM companies WHERE id = $1 LIMIT 1",
      [job.company_id]
    );
    const company = companyResult.rows[0] || null;
    const companyEmail = company ? String(company.email || "").trim() : "";
    if (companyEmail) {
      queueSafeEmail({
        to: companyEmail,
        subject: "New review received",
        text: `You received a new ${rating}-star review.${reviewText ? `\n\n"${reviewText}"` : ""}`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px">
            <h2>New review received</h2>
            <p>Your company received a new <strong>${rating}</strong>-star review.</p>
            ${reviewText ? `<p style="white-space:pre-wrap">"${String(reviewText).replace(/</g, "&lt;").replace(/>/g, "&gt;")}"</p>` : ""}
          </div>
        `
      }, { kind: "new_review" });
    }

    return res.status(201).json(withModerationFlag(review, res));
  } catch (err) {
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "A review already exists for this job" });
    }
    if (err && (err.code === "23514" || err.code === "23503")) {
      return res.status(400).json({ error: "Invalid review relationship" });
    }
    return sendSafeServerError(res, err, "REVIEWS CREATE ERROR");
  }
});

router.get("/companies/:id/reviews", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const result = await pool.query(
      `
      SELECT rating, review_text, created_at
      FROM company_reviews
      WHERE company_id = $1
        AND is_public = TRUE
      ORDER BY created_at DESC, id DESC
      `,
      [companyId]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY PUBLIC REVIEWS LIST ERROR");
  }
});

router.get("/companies/:id/reviews/summary", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const result = await pool.query(
      `
      SELECT
        COALESCE(ROUND(AVG(rating)::numeric, 1), 0.0) AS average_rating,
        COUNT(*)::INTEGER AS total_reviews
      FROM company_reviews
      WHERE company_id = $1
        AND is_public = TRUE
      `,
      [companyId]
    );

    return res.json(result.rows[0] || { average_rating: 0.0, total_reviews: 0 });
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY PUBLIC REVIEWS SUMMARY ERROR");
  }
});

router.post("/reviews/:id/report", customerAuth, reviewReportLimiter, async (req, res) => {
  try {
    const reviewId = Number(req.params.id);
    const reason = String((req.body && req.body.reason) || "").trim().slice(0, 200);
    const details = String((req.body && req.body.details) || "").trim().slice(0, 4000);
    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: "Invalid review id" });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: "Reason is required" });
    }

    const reviewResult = await pool.query(
      "SELECT id, company_id FROM company_reviews WHERE id = $1 LIMIT 1",
      [reviewId]
    );
    if (!reviewResult.rows.length) {
      return res.status(404).json({ error: "Review not found" });
    }
    const review = reviewResult.rows[0];

    const inserted = await pool.query(
      `
      INSERT INTO abuse_reports (
        reporter_customer_id,
        company_id,
        target_type,
        target_id,
        reason,
        details
      )
      VALUES ($1, $2, 'review', $3, $4, $5)
      RETURNING id, target_type, target_id, reason, details, status, priority, created_at
      `,
      [req.customer.client_id, review.company_id, reviewId, reason, details || null]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "REVIEW REPORT CREATE ERROR");
  }
});

module.exports = router;

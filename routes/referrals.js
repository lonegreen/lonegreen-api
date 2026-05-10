const express = require("express");
const rateLimit = require("express-rate-limit");
const auth = require("../middleware/auth");
const { requireMinimumRole } = auth;
const referralEngineService = require("../services/referralEngineService");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

const companyReferralHandlers = [auth, requireMinimumRole("manager")];

const referralPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many referral tracking requests" }
});

router.get("/referrals/company", companyReferralHandlers, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const limit = req.query.limit;
    const offset = req.query.offset;
    const [summary, referrals] = await Promise.all([
      referralEngineService.getCompanyReferralSummary(companyId),
      referralEngineService.listCompanyReferrals(companyId, { limit, offset })
    ]);

    res.json({
      summary,
      referrals
    });
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY REFERRALS LIST ERROR");
  }
});

router.get("/referrals/company/leaderboard", companyReferralHandlers, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const rows = await referralEngineService.getCompanyReferralLeaderboard(companyId, {
      limit: req.query.limit
    });
    res.json({
      company_id: companyId,
      generated_at: new Date().toISOString(),
      leaderboard: rows
    });
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY REFERRAL LEADERBOARD ERROR");
  }
});

router.get("/referrals/company/events", companyReferralHandlers, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const rows = await referralEngineService.listCompanyReferralEvents(companyId, {
      limit: req.query.limit,
      offset: req.query.offset
    });
    res.json({
      company_id: companyId,
      generated_at: new Date().toISOString(),
      events: rows
    });
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY REFERRAL EVENTS ERROR");
  }
});

router.post("/referrals/company/code", companyReferralHandlers, async (req, res) => {
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const row = await referralEngineService.getOrCreateReferralCode({
      ownerType: "company",
      ownerId: companyId,
      companyId
    });

    res.status(200).json({
      code: row.code,
      id: row.id,
      status: row.status,
      owner_type: row.owner_type
    });
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY REFERRAL CODE ERROR");
  }
});

router.post("/referrals/track-visit", referralPublicLimiter, async (req, res) => {
  try {
    const raw =
      req.body &&
      (req.body.code || req.body.referral_code || req.body.ref || req.body.r);
    const result = await referralEngineService.trackReferralVisit(raw, {
      path: req.body && req.body.path ? String(req.body.path).slice(0, 500) : "",
      referrer_header: req.headers.referer ? String(req.headers.referer).slice(0, 500) : "",
      source: "public_track_visit"
    });
    res.json({
      ok: result.ok,
      reason: result.reason || undefined
    });
  } catch (err) {
    sendSafeServerError(res, err, "REFERRAL TRACK VISIT ERROR");
  }
});

router.post("/referrals/track-lead", referralPublicLimiter, async (req, res) => {
  try {
    const raw =
      req.body &&
      (req.body.code || req.body.referral_code || req.body.ref || req.body.r);
    const leadId = req.body && (req.body.lead_id || req.body.estimate_id);
    const meta = {};
    if (req.body && req.body.source) {
      meta.public_source = String(req.body.source).slice(0, 120);
    }
    const result = await referralEngineService.trackReferralLead(raw, leadId, meta);
    res.json({
      ok: result.ok,
      reason: result.reason || undefined
    });
  } catch (err) {
    sendSafeServerError(res, err, "REFERRAL TRACK LEAD ERROR");
  }
});

router.post("/referrals/track-request", referralPublicLimiter, async (req, res) => {
  try {
    const raw =
      req.body &&
      (req.body.code || req.body.referral_code || req.body.ref || req.body.r);
    const requestId = req.body && (req.body.marketplace_request_id || req.body.request_id);
    const result = await referralEngineService.trackReferralMarketplaceRequest(
      raw,
      requestId,
      {}
    );
    res.json({
      ok: result.ok,
      reason: result.reason || undefined
    });
  } catch (err) {
    sendSafeServerError(res, err, "REFERRAL TRACK REQUEST ERROR");
  }
});

module.exports = router;

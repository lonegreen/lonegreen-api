const express = require("express");
const auth = require("../middleware/auth");
const { requireMinimumRole } = auth;
const referralEngineService = require("../services/referralEngineService");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

const companyReferralHandlers = [auth, requireMinimumRole("admin")];

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

module.exports = router;

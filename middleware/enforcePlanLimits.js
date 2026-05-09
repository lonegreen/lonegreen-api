const pool = require("../db/pool");
const { sendSafeServerError } = require("../services/safeServerError");

const LIMIT_COLUMN_BY_RESOURCE = {
  users: "max_users",
  clients: "max_clients",
  jobs: "max_jobs",
  invoices: "max_invoices",
  workers: "max_workers"
};

/** Table names allowed in COUNT queries; must stay in sync with LIMIT_COLUMN_BY_RESOURCE keys. */
const ALLOWED_PLAN_LIMIT_TABLE_NAMES = new Set(Object.keys(LIMIT_COLUMN_BY_RESOURCE));

function formatResourceLabel(resourceKey) {
  return String(resourceKey || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildUpgradeSuggestion(planName) {
  const safePlanName = String(planName || "current");
  return `You reached the limit for your ${safePlanName} plan. Upgrade your plan to continue creating new records.`;
}

function enforcePlanLimits(resourceKey) {
  const normalizedKey = String(resourceKey || "").toLowerCase();
  if (!ALLOWED_PLAN_LIMIT_TABLE_NAMES.has(normalizedKey)) {
    throw new Error(`Unsupported plan limit resource: ${resourceKey}`);
  }
  const limitColumn = LIMIT_COLUMN_BY_RESOURCE[normalizedKey];
  if (!limitColumn) {
    throw new Error(`Unsupported plan limit resource: ${resourceKey}`);
  }

  return async function enforcePlanLimitForResource(req, res, next) {
    try {
      const companyId = Number(req.user && req.user.company_id);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return next();
      }

      const planResult = await pool.query(
        `
        SELECT
          c.id AS company_id,
          c.plan_id,
          c.billing_status,
          p.id AS subscription_plan_id,
          p.name AS plan_name,
          p.slug AS plan_slug,
          p.${limitColumn} AS plan_limit
        FROM companies c
        LEFT JOIN subscription_plans p
          ON p.id = c.plan_id
        WHERE c.id = $1
        LIMIT 1
        `,
        [companyId]
      );

      if (!planResult.rows.length) {
        return next();
      }

      const plan = planResult.rows[0];
      const hasPlan = Number.isInteger(Number(plan.plan_id));
      if (!hasPlan) {
        return next();
      }

      const planLimit = Number(plan.plan_limit);
      if (!Number.isFinite(planLimit) || planLimit < 0) {
        return next();
      }

      const usageResult = await pool.query(
        `
        SELECT COUNT(*)::int AS current_count
        FROM ${normalizedKey}
        WHERE company_id = $1
        `,
        [companyId]
      );

      const currentCount = Number(usageResult.rows[0] && usageResult.rows[0].current_count) || 0;

      if (currentCount >= planLimit) {
        return res.status(403).json({
          error: `${formatResourceLabel(normalizedKey)} limit reached`,
          code: "PLAN_LIMIT_REACHED",
          resource: normalizedKey,
          current_count: currentCount,
          max_allowed: planLimit,
          plan: {
            id: plan.subscription_plan_id || null,
            name: plan.plan_name || null,
            slug: plan.plan_slug || null
          },
          billing_status: plan.billing_status || null,
          suggestion: buildUpgradeSuggestion(plan.plan_name)
        });
      }

      return next();
    } catch (err) {
      return sendSafeServerError(res, err, "PLAN LIMIT ENFORCEMENT ERROR");
    }
  };
}

module.exports = {
  enforcePlanLimits
};

/**
 * Phase 5 marketplace ranking: deterministic 0–100 score from trust/reputation inputs,
 * marketplace outcomes, subscription status, and Growth OS foundation signals.
 */
const pool = require("../db/pool");
const activityLogService = require("./activityLogService");
const trustReputationService = require("./trustReputationService");

function clamp100(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function round2(value) {
  return Number(clamp100(value).toFixed(2));
}

async function upsertRankingRow(companyId, rankingScore, components) {
  await pool.query(
    `
    INSERT INTO company_marketplace_rankings (
      company_id,
      ranking_score,
      ranking_components,
      calculated_at
    )
    VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
    ON CONFLICT (company_id) DO UPDATE SET
      ranking_score = EXCLUDED.ranking_score,
      ranking_components = EXCLUDED.ranking_components,
      calculated_at = EXCLUDED.calculated_at
    `,
    [companyId, rankingScore, JSON.stringify(components || {})]
  );
}

/**
 * Compute marketplace ranking_score (0–100) without persisting.
 * Reuses trust/reputation pipeline + billing + Growth OS metrics from trust inputs.
 */
async function calculateCompanyRanking(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("Invalid company id");
    err.code = "INVALID_COMPANY_ID";
    throw err;
  }

  const profile = await trustReputationService.buildCompanyTrustProfile(id, { detail: true });
  const inputs = profile.detail.inputs;

  const billingRow = await pool.query(
    `SELECT billing_status FROM companies WHERE id = $1 LIMIT 1`,
    [id]
  );
  const billingStatus = billingRow.rows[0] ? billingRow.rows[0].billing_status : null;

  const trust = Number(profile.trust_score || 0);
  const rep = Number(profile.reputation_score || 0);

  const rc = Number(inputs.review_count || 0);
  const avg = Number(inputs.avg_rating || 0);
  const ratingNorm = rc >= 1 ? clamp100((avg / 5) * 100) : 62;

  const offersTotal = Number(inputs.marketplace_offers_total || 0);
  const avgSec =
    inputs.avg_response_seconds != null ? Number(inputs.avg_response_seconds) : null;
  let responseNorm = 62;
  if (offersTotal <= 0) {
    responseNorm = 62;
  } else if (avgSec != null && Number.isFinite(avgSec)) {
    responseNorm = clamp100(100 * (1 - Math.min(1, avgSec / 86400)));
  } else {
    responseNorm = 65;
  }

  const accepted = Number(inputs.marketplace_offers_accepted || 0);
  const rejected = Number(inputs.marketplace_offers_rejected || 0);
  const conversions = Number(inputs.marketplace_conversions || 0);

  let completionNorm = 62;
  if (accepted > 0) {
    completionNorm = clamp100(100 * Math.min(1, conversions / accepted));
  }

  let winNorm = 62;
  const terminal = accepted + rejected;
  if (terminal > 0) {
    winNorm = clamp100(100 * (accepted / terminal));
  }

  const activeClients = Number(inputs.active_clients || 0);
  const repeatClients = Number(inputs.repeat_clients || 0);
  let repeatNorm = 62;
  if (activeClients >= 3) {
    repeatNorm = clamp100(100 * Math.min(1, repeatClients / Math.max(1, activeClients)));
  }

  const subscriptionNorm =
    billingStatus === "active" || billingStatus === "trialing" || billingStatus == null
      ? 100
      : 55;

  let growthNorm = 62;
  const gf = inputs.growth_foundation;
  if (gf && gf.foundation_events_last_90d && typeof gf.foundation_events_last_90d === "object") {
    const total = Object.values(gf.foundation_events_last_90d).reduce(
      (acc, v) => acc + Number(v || 0),
      0
    );
    growthNorm = clamp100(Math.min(100, 12 + total * 1.5));
  }

  const ranking_score = round2(
    0.26 * trust +
      0.26 * rep +
      0.12 * ratingNorm +
      0.1 * responseNorm +
      0.08 * completionNorm +
      0.06 * repeatNorm +
      0.06 * winNorm +
      0.04 * subscriptionNorm +
      0.02 * growthNorm
  );

  const components = {
    trust_score: trust,
    reputation_score: rep,
    rating_norm: ratingNorm,
    response_speed_norm: responseNorm,
    completion_norm: completionNorm,
    repeat_client_norm: repeatNorm,
    marketplace_win_rate_norm: winNorm,
    subscription_norm: subscriptionNorm,
    growth_activity_norm: growthNorm,
    billing_status: billingStatus,
    review_count: rc,
    marketplace_offers_terminal: terminal,
    average_rating: round2(avg)
  };

  return {
    company_id: id,
    ranking_score,
    components
  };
}

async function refreshCompanyRanking(companyId, options = {}) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("Invalid company id");
    err.code = "INVALID_COMPANY_ID";
    throw err;
  }

  try {
    await trustReputationService.persistCompanyTrustScores(id);
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      throw err;
    }
    if (err && err.code !== "42P01") {
      throw err;
    }
  }

  const calc = await calculateCompanyRanking(id);

  try {
    await upsertRankingRow(id, calc.ranking_score, calc.components);
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "company_marketplace_rankings_missing",
        company_id: id,
        message: err.message
      }));
      return { ...calc, persisted: false };
    }
    throw err;
  }

  if (options.logActivity) {
    await activityLogService.logActivity({
      companyId: id,
      userId: options.userId || null,
      action: "marketplace_ranking_recomputed",
      entityType: "company_marketplace_rankings",
      entityId: id,
      details: { scope: "single", ranking_score: calc.ranking_score }
    });
  }

  return { ...calc, persisted: true };
}

async function refreshAllRankings(limit, options = {}) {
  const cap = Number(limit);
  const safeCap =
    Number.isInteger(cap) && cap > 0 ? Math.min(cap, 5000) : 5000;

  const rows = await pool.query(
    `
    SELECT id
    FROM companies
    WHERE COALESCE(is_public, FALSE) = TRUE
    ORDER BY id ASC
    LIMIT $1
    `,
    [safeCap]
  );

  let processed = 0;
  let persisted = 0;
  const failures = [];

  for (const row of rows.rows) {
    try {
      const r = await refreshCompanyRanking(row.id, { logActivity: false });
      processed += 1;
      if (r.persisted) persisted += 1;
    } catch (err) {
      failures.push({ company_id: row.id, message: err.message || String(err) });
    }
  }

  await activityLogService.logActivity({
    companyId: null,
    userId: options.userId || null,
    action: "marketplace_ranking_recomputed",
    entityType: "marketplace_rankings",
    entityId: null,
    details: {
      scope: "all",
      processed,
      persisted,
      limit: safeCap,
      failures: failures.slice(0, 25),
      failures_count: failures.length
    }
  });

  return { processed, persisted, limit: safeCap, failures };
}

/**
 * Ranked company rows for admin/debug (filters optional).
 */
async function getRankedCompanies(filters = {}) {
  const parsedLimit = Number(filters.limit);
  const parsedOffset = Number(filters.offset);
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;
  const offset =
    Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  const onlyPublic = filters.is_public !== false;

  try {
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.public_slug,
        COALESCE(cmr.ranking_score, 50)::numeric AS ranking_score,
        cmr.calculated_at,
        COALESCE(cts.trust_score, 0)::numeric AS trust_score,
        COALESCE(cts.reputation_score, 0)::numeric AS reputation_score
      FROM companies c
      LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
      LEFT JOIN company_trust_scores cts ON cts.company_id = c.id
      WHERE ${onlyPublic ? "COALESCE(c.is_public, FALSE) = TRUE" : "TRUE"}
      ORDER BY
        COALESCE(cmr.ranking_score, 50) DESC,
        COALESCE(cts.trust_score, 0) DESC,
        COALESCE(cts.reputation_score, 0) DESC,
        c.name ASC NULLS LAST,
        c.id ASC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    return result.rows;
  } catch (err) {
    if (err && err.code === "42P01") {
      return [];
    }
    throw err;
  }
}

async function getMarketplaceRankingPublic(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("Invalid company id");
    err.code = "INVALID_COMPANY_ID";
    throw err;
  }

  let stored = null;
  try {
    const row = await pool.query(
      `
      SELECT
        cmr.ranking_score,
        cmr.ranking_components,
        cmr.calculated_at,
        COALESCE(cts.trust_score, 0)::numeric AS trust_score,
        COALESCE(cts.reputation_score, 0)::numeric AS reputation_score,
        COALESCE(cts.badges, '[]'::jsonb) AS trust_badges
      FROM companies c
      LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
      LEFT JOIN company_trust_scores cts ON cts.company_id = c.id
      WHERE c.id = $1
      LIMIT 1
      `,
      [id]
    );
    stored = row.rows[0] || null;
  } catch (err) {
    if (err && err.code === "42P01") {
      stored = {};
    } else {
      throw err;
    }
  }

  let ranking_score = stored && stored.ranking_score != null ? Number(stored.ranking_score) : null;
  let components = stored && stored.ranking_components ? stored.ranking_components : {};
  let calculated_at = stored && stored.calculated_at ? stored.calculated_at : null;

  if (ranking_score == null || Number.isNaN(ranking_score)) {
    const calc = await calculateCompanyRanking(id);
    ranking_score = calc.ranking_score;
    components = calc.components;
    calculated_at = null;
  }

  let marketplace_rank = null;
  try {
    const rankRow = await pool.query(
      `
      SELECT 1 + COUNT(*)::int AS rnk
      FROM companies c2
      INNER JOIN company_marketplace_rankings r2 ON r2.company_id = c2.id
      WHERE COALESCE(c2.is_public, FALSE) = TRUE
        AND COALESCE(NULLIF(TRIM(c2.public_slug), ''), '') <> ''
        AND r2.ranking_score > $1::numeric
      `,
      [ranking_score]
    );
    marketplace_rank = rankRow.rows[0] ? Number(rankRow.rows[0].rnk) : null;
  } catch (err) {
    if (err && err.code !== "42P01") {
      throw err;
    }
    marketplace_rank = null;
  }

  const mini = await trustReputationService.buildCompanyTrustProfile(id, { detail: false });

  return {
    company_id: id,
    ranking_score,
    ranking_components: components && typeof components === "object" ? components : {},
    calculated_at,
    marketplace_rank,
    trust_score: mini.trust_score,
    reputation_score: mini.reputation_score,
    trust_badges: mini.badges
  };
}

module.exports = {
  calculateCompanyRanking,
  getRankedCompanies,
  refreshCompanyRanking,
  refreshAllRankings,
  getMarketplaceRankingPublic
};

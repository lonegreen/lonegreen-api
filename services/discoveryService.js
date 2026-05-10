/**
 * Phase 7 discovery: search/filter helpers, marketplace discovery blocks, analytics logging.
 * Uses activity_log only — no external APIs.
 */
const pool = require("../db/pool");
const activityLogService = require("./activityLogService");

const ALLOWED_BADGE_IDS = new Set([
  "verified",
  "top_rated",
  "fast_responder",
  "reliable",
  "trusted_pro",
  "rising_pro"
]);

function cleanText(value) {
  return String(value || "").trim();
}

function sanitizeLikeFragment(value) {
  return cleanText(value).slice(0, 120).replace(/\\/g, "").replace(/%/g, "").replace(/_/g, "");
}

function parseDiscoverySearchQuery(query = {}) {
  const serviceRaw = cleanText(query.service);
  const cityRaw = cleanText(query.city);
  const stateRaw = cleanText(query.state).toUpperCase().slice(0, 2);
  const zipRaw = String(query.zip || "").replace(/\D/g, "").slice(0, 5);
  const qRaw = cleanText(query.q !== undefined ? query.q : query.keyword);
  const qToken = sanitizeLikeFragment(qRaw).toLowerCase();

  const categoryIdRaw = query.category_id != null ? Number(query.category_id) : null;
  const categoryId =
    Number.isInteger(categoryIdRaw) && categoryIdRaw > 0 ? categoryIdRaw : null;

  let categorySlug = cleanText(query.category_slug || query.category || "");
  categorySlug = categorySlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const minRatingRaw = query.min_rating != null ? Number(query.min_rating) : null;
  const minRating =
    Number.isFinite(minRatingRaw) && minRatingRaw >= 0 && minRatingRaw <= 5
      ? minRatingRaw
      : null;

  let badgeId = cleanText(query.badge || query.trust_badge || "").toLowerCase();
  if (badgeId && !ALLOWED_BADGE_IDS.has(badgeId)) {
    badgeId = "";
  }

  const availDayRaw =
    query.availability_day != null ? Number(query.availability_day) : null;
  const availabilityDay =
    Number.isInteger(availDayRaw) && availDayRaw >= 0 && availDayRaw <= 6 ? availDayRaw : null;

  const availabilityToday =
    String(query.availability_today || "").toLowerCase() === "true" ||
    query.availability_today === true ||
    query.availability_today === 1;

  let forcedAvailDay = availabilityDay;
  if (availabilityToday && forcedAvailDay == null) {
    forcedAvailDay = new Date().getUTCDay();
  }

  const searchLimitRaw = query.limit != null ? Number(query.limit) : 100;
  const searchLimit =
    Number.isInteger(searchLimitRaw) && searchLimitRaw > 0
      ? Math.min(searchLimitRaw, 200)
      : 100;

  const searchOffsetRaw = query.offset != null ? Number(query.offset) : 0;
  const searchOffset =
    Number.isInteger(searchOffsetRaw) && searchOffsetRaw >= 0 ? searchOffsetRaw : 0;

  const listLimitRaw = query.limit != null ? Number(query.limit) : null;
  const publicListLimit =
    listLimitRaw != null && Number.isInteger(listLimitRaw) && listLimitRaw > 0
      ? Math.min(listLimitRaw, 200)
      : null;
  const publicListOffsetRaw = query.offset != null ? Number(query.offset) : 0;
  const publicListOffset =
    Number.isInteger(publicListOffsetRaw) && publicListOffsetRaw >= 0 ? publicListOffsetRaw : 0;

  return {
    serviceRaw,
    cityRaw,
    stateRaw,
    zipRaw,
    qToken,
    categoryId,
    categorySlug,
    minRating,
    badgeId,
    availabilityDay: forcedAvailDay,
    searchLimit,
    searchOffset,
    publicListLimit,
    publicListOffset
  };
}

function badgeJsonParam(badgeId) {
  if (!badgeId) return "";
  return JSON.stringify([{ id: badgeId }]);
}

function hasStructuredFilters(parsed) {
  return !!(
    parsed.categoryId ||
    parsed.categorySlug ||
    parsed.minRating != null ||
    parsed.badgeId ||
    parsed.availabilityDay != null ||
    parsed.cityRaw ||
    parsed.stateRaw ||
    parsed.zipRaw ||
    cleanText(parsed.serviceRaw) ||
    parsed.qToken
  );
}

function summarizeAppliedFilters(parsed) {
  return {
    service: cleanText(parsed.serviceRaw) || null,
    q: parsed.qToken || null,
    category_id: parsed.categoryId,
    category_slug: parsed.categorySlug || null,
    min_rating: parsed.minRating,
    badge: parsed.badgeId || null,
    availability_day: parsed.availabilityDay,
    city: parsed.cityRaw || null,
    state: parsed.stateRaw || null,
    zip: parsed.zipRaw || null,
    limit: parsed.searchLimit,
    offset: parsed.searchOffset
  };
}

async function logDiscoveryEvent({
  action,
  userId = null,
  customerAccountId = null,
  details = {}
}) {
  try {
    await activityLogService.ensureActivityLogSchema();
    await activityLogService.logActivity({
      companyId: null,
      userId: userId || null,
      action,
      entityType: "discovery",
      entityId: null,
      details: {
        ...details,
        customer_account_id: customerAccountId
      }
    });
  } catch (err) {
    console.log(JSON.stringify({
      level: "warn",
      event: "discovery_log_failed",
      action,
      message: err && err.message
    }));
  }
}

function queueDiscoveryLog(payload) {
  Promise.resolve()
    .then(() => logDiscoveryEvent(payload))
    .catch(() => {});
}

async function getDiscoveryTopRated(limit = 12) {
  const cap = Number(limit);
  const safe = Number.isInteger(cap) && cap > 0 ? Math.min(cap, 50) : 12;

  const result = await pool.query(
    `
    SELECT
      ranked.id,
      ranked.name,
      ranked.public_slug,
      ranked.logo_url,
      ranked.public_description,
      ranked.average_rating,
      ranked.review_count,
      ranked.ranking_score,
      ranked.trust_score,
      ranked.reputation_score,
      ranked.trust_badges
    FROM (
      SELECT
        c.id,
        c.name,
        c.public_slug,
        c.logo_url,
        c.public_description,
        COALESCE(rev.average_rating, 0)::numeric AS average_rating,
        COALESCE(rev.review_count, 0)::int AS review_count,
        COALESCE(cmr.ranking_score, (
          (COALESCE(rev.average_rating, 0) / 5.0) * 32 +
          (LEAST(1, LN(1 + COALESCE(rev.review_count, 0)) / LN(51))) * 8
        ))::numeric(10,4) AS ranking_score,
        COALESCE(cts.trust_score, 0)::numeric AS trust_score,
        COALESCE(cts.reputation_score, LEAST(100, COALESCE(rev.average_rating, 0) * 20))::numeric AS reputation_score,
        COALESCE(cts.badges, '[]'::jsonb) AS trust_badges
      FROM companies c
      LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
      LEFT JOIN company_trust_scores cts ON cts.company_id = c.id
      LEFT JOIN (
        SELECT company_id, AVG(rating)::numeric AS average_rating, COUNT(*)::int AS review_count
        FROM company_reviews
        GROUP BY company_id
      ) rev ON rev.company_id = c.id
      WHERE c.is_public = TRUE
        AND c.platform_suspended_at IS NULL
        AND COALESCE(NULLIF(TRIM(c.public_slug), ''), '') <> ''
    ) ranked
    ORDER BY ranked.ranking_score DESC, ranked.average_rating DESC, ranked.review_count DESC, ranked.name ASC
    LIMIT $1
    `,
    [safe]
  );

  return result.rows;
}

async function getDiscoveryFastestResponders(limit = 12) {
  const cap = Number(limit);
  const safe = Number.isInteger(cap) && cap > 0 ? Math.min(cap, 50) : 12;

  const result = await pool.query(
    `
    SELECT
      c.id,
      c.name,
      c.public_slug,
      c.logo_url,
      c.public_description,
      COALESCE(rev.average_rating, 0)::numeric AS average_rating,
      COALESCE(rev.review_count, 0)::int AS review_count,
      GREATEST(0, LEAST(1, 1 - (COALESCE(resp.avg_response_seconds, 86400) / 86400.0)))::numeric AS response_speed_score,
      COALESCE(cmr.ranking_score, 0)::numeric AS ranking_score,
      COALESCE(cts.trust_score, 0)::numeric AS trust_score,
      COALESCE(cts.badges, '[]'::jsonb) AS trust_badges
    FROM companies c
    INNER JOIN (
      SELECT
        mo.company_id,
        AVG(EXTRACT(EPOCH FROM (mo.created_at - mr.created_at)))::numeric AS avg_response_seconds
      FROM marketplace_offers mo
      JOIN marketplace_requests mr ON mr.id = mo.request_id
      WHERE mo.created_at >= mr.created_at
      GROUP BY mo.company_id
      HAVING COUNT(*) >= 1
    ) resp ON resp.company_id = c.id
    LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
    LEFT JOIN company_trust_scores cts ON cts.company_id = c.id
    LEFT JOIN (
      SELECT company_id, AVG(rating)::numeric AS average_rating, COUNT(*)::int AS review_count
      FROM company_reviews
      GROUP BY company_id
    ) rev ON rev.company_id = c.id
    WHERE c.is_public = TRUE
      AND c.platform_suspended_at IS NULL
      AND COALESCE(NULLIF(TRIM(c.public_slug), ''), '') <> ''
    ORDER BY resp.avg_response_seconds ASC NULLS LAST, COALESCE(cmr.ranking_score, 0) DESC, c.name ASC
    LIMIT $1
    `,
    [safe]
  );

  return result.rows;
}

async function getDiscoveryTrendingServices(categoryLimit = 8, companiesPerCategory = 4) {
  const catCap = Math.min(Math.max(Number(categoryLimit) || 8, 1), 30);
  const coCap = Math.min(Math.max(Number(companiesPerCategory) || 4, 1), 12);

  const trending = await pool.query(
    `
    SELECT
      mr.category_id,
      sc.name AS category_name,
      sc.slug AS category_slug,
      COUNT(*)::int AS request_count_30d
    FROM marketplace_requests mr
    JOIN service_categories sc ON sc.id = mr.category_id AND sc.active = TRUE
    WHERE mr.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    GROUP BY mr.category_id, sc.name, sc.slug
    ORDER BY request_count_30d DESC, sc.name ASC
    LIMIT $1
    `,
    [catCap]
  );

  const blocks = [];
  for (const row of trending.rows) {
    const categoryId = Number(row.category_id);
    const companies = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.public_slug,
        c.logo_url,
        COALESCE(rev.average_rating, 0)::numeric AS average_rating,
        COALESCE(rev.review_count, 0)::int AS review_count,
        COALESCE(cmr.ranking_score, 0)::numeric AS ranking_score
      FROM companies c
      LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
      LEFT JOIN (
        SELECT company_id, AVG(rating)::numeric AS average_rating, COUNT(*)::int AS review_count
        FROM company_reviews
        GROUP BY company_id
      ) rev ON rev.company_id = c.id
      WHERE c.is_public = TRUE
        AND c.platform_suspended_at IS NULL
        AND COALESCE(NULLIF(TRIM(c.public_slug), ''), '') <> ''
        AND EXISTS (
          SELECT 1
          FROM company_services cs
          JOIN service_categories sc ON sc.id = cs.category_id AND sc.active = TRUE
          WHERE cs.company_id = c.id
            AND cs.active = TRUE
            AND cs.category_id = $2
        )
      ORDER BY COALESCE(cmr.ranking_score, 0) DESC, COALESCE(rev.average_rating, 0) DESC, c.name ASC
      LIMIT $1
      `,
      [coCap, categoryId]
    );

    blocks.push({
      category_id: categoryId,
      category_name: row.category_name || "",
      category_slug: row.category_slug || "",
      request_count_30d: Number(row.request_count_30d || 0),
      companies: companies.rows
    });
  }

  return {
    window_days: 30,
    trending: blocks
  };
}

module.exports = {
  ALLOWED_BADGE_IDS,
  parseDiscoverySearchQuery,
  badgeJsonParam,
  hasStructuredFilters,
  summarizeAppliedFilters,
  logDiscoveryEvent,
  queueDiscoveryLog,
  getDiscoveryTopRated,
  getDiscoveryFastestResponders,
  getDiscoveryTrendingServices
};

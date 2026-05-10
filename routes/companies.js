const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { SECRET } = require("../config/env");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const {
  requireMinimumRole,
  requirePlatformOwner,
  getBearerToken,
  classifyTokenBoundary,
  normalizeRole,
  verifyActiveCustomerBearerToken,
  validateStaffTokenAgainstDatabase
} = auth;
const { sendSafeServerError } = require("../services/safeServerError");
const { sendOperationalEmailSafe } = require("../services/emailService");
const { refreshCompanyReputation } = require("../services/reputationService");
const trustReputationService = require("../services/trustReputationService");
const marketplaceRankingService = require("../services/marketplaceRankingService");
const discoveryService = require("../services/discoveryService");
const reputationExpansionService = require("../services/reputationExpansionService");

const router = express.Router();
const companyReportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
const discoveryClickLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

function queueSafeEmail(payload, options) {
  Promise.resolve()
    .then(() => sendOperationalEmailSafe(payload, options))
    .catch(() => {});
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanUrl(value) {
  const url = cleanText(value);
  return url || "";
}

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanSearchToken(value) {
  return cleanSlug(value).replace(/-/g, " ");
}

function normalizeGallery(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanUrl(item))
    .filter(Boolean)
    .slice(0, 20);
}

async function getPublicServices(companyId) {
  const result = await pool.query(
    `
    SELECT
      cs.id,
      cs.category_id,
      cs.custom_name,
      cs.active,
      sc.name AS category_name,
      sc.slug AS category_slug,
      sc.description AS category_description,
      sc.icon AS category_icon,
      sc.sort_order AS category_sort_order
    FROM company_services cs
    JOIN service_categories sc
      ON sc.id = cs.category_id
    WHERE cs.company_id = $1
      AND cs.active = TRUE
      AND sc.active = TRUE
    ORDER BY sc.sort_order ASC, sc.name ASC, cs.id ASC
    `,
    [companyId]
  );

  const marketplaceServices = result.rows.map((row) => ({
    id: row.id,
    category_id: row.category_id,
    custom_name: row.custom_name || "",
    active: row.active === true,
    category: {
      id: row.category_id,
      name: row.category_name || "",
      slug: row.category_slug || "",
      description: row.category_description || "",
      icon: row.category_icon || "",
      sort_order: row.category_sort_order
    },
    display_name: row.custom_name || row.category_name || ""
  }));

  const services = marketplaceServices
    .map((service) => service.display_name)
    .filter(Boolean);

  return { services, marketplaceServices };
}

async function getPublicServiceAreas(companyId) {
  const result = await pool.query(
    `
    SELECT
      id,
      zip_code,
      city,
      state,
      radius_miles,
      active
    FROM company_service_areas
    WHERE company_id = $1
      AND active = TRUE
    ORDER BY id ASC
    `,
    [companyId]
  );

  const marketplaceServiceAreas = result.rows.map((row) => ({
    id: row.id,
    zip_code: row.zip_code || "",
    city: row.city || "",
    state: row.state || "",
    radius_miles: Number(row.radius_miles || 0),
    active: row.active === true
  }));

  const serviceAreas = marketplaceServiceAreas
    .map((row) => [row.city, row.state, row.zip_code].filter(Boolean).join(", ").replace(/, ([A-Z]{2}),/, ", $1 "))
    .filter(Boolean);

  return { serviceAreas, marketplaceServiceAreas };
}

function dayLabel(dayOfWeek) {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return labels[Number(dayOfWeek)] || "Day";
}

async function getPublicAvailability(companyId) {
  const result = await pool.query(
    `
    SELECT
      id,
      day_of_week,
      start_time,
      end_time,
      is_closed
    FROM company_availability
    WHERE company_id = $1
    ORDER BY day_of_week ASC
    `,
    [companyId]
  );

  const availability = result.rows.map((row) => ({
    id: row.id,
    day_of_week: Number(row.day_of_week),
    start_time: row.start_time || "",
    end_time: row.end_time || "",
    is_closed: row.is_closed === true
  }));

  const businessHours = availability.map((slot) => {
    if (slot.is_closed) {
      return `${dayLabel(slot.day_of_week)}: Closed`;
    }
    return `${dayLabel(slot.day_of_week)}: ${slot.start_time}-${slot.end_time}`;
  });

  return { availability, businessHours };
}

async function shapePublicCompany(row) {
  const [{ services, marketplaceServices }, { serviceAreas, marketplaceServiceAreas }, { availability, businessHours }] = await Promise.all([
    getPublicServices(row.id),
    getPublicServiceAreas(row.id),
    getPublicAvailability(row.id)
  ]);

  let reputationExpansion = null;
  try {
    reputationExpansion = await reputationExpansionService.buildCompanyReputationExpansion(row.id);
  } catch (_) {
    reputationExpansion = null;
  }

  const marketplaceRankingSnapshot =
    row.marketplace_ranking_calculated_at || row.marketplace_ranking_components
      ? {
          ranking_score: Number(row.ranking_score || 0),
          calculated_at: row.marketplace_ranking_calculated_at || null,
          components:
            row.marketplace_ranking_components && typeof row.marketplace_ranking_components === "object"
              ? row.marketplace_ranking_components
              : {}
        }
      : null;

  return {
    id: row.id,
    name: row.name || "",
    public_slug: row.public_slug || "",
    public_description: row.public_description || "",
    logo_url: row.logo_url || "",
    cover_image_url: row.cover_image_url || "",
    gallery_urls: Array.isArray(row.gallery_urls) ? row.gallery_urls : [],
    website_url: row.website_url || "",
    facebook_url: row.facebook_url || "",
    instagram_url: row.instagram_url || "",
    is_verified: row.is_verified === true,
    trust: {
      verification_status: row.verification_status || "unverified",
      verified_at: row.verified_at || null,
      insurance_status: row.insurance_status || "unknown",
      license_status: row.license_status || "unknown",
      identity_status: row.identity_status || "unknown",
      insurance_expiry_date: row.insurance_expiry_date || null,
      license_expiry_date: row.license_expiry_date || null,
      insurance_expired: row.insurance_expired === true,
      license_expired: row.license_expired === true
    },
    trust_score: Number(row.trust_score || 0),
    trust_badges: Array.isArray(row.trust_badges) ? row.trust_badges : [],
    ranking_score: Number(row.ranking_score || 0),
    reputation_score: Number(row.reputation_score || 0),
    reputation_expansion_score: reputationExpansion ? reputationExpansion.reputation_expansion_score : null,
    reputation_badge_candidates: reputationExpansion ? reputationExpansion.reputation_badge_candidates : [],
    reputation_risk_level: reputationExpansion ? reputationExpansion.reputation_risk_level : "unknown",
    marketplace_rank: row.marketplace_rank != null ? Number(row.marketplace_rank) : null,
    marketplace_ranking: marketplaceRankingSnapshot,
    rating_summary: {
      average_rating: Number(row.average_rating || 0),
      review_count: Number(row.review_count || 0)
    },
    marketplace_rank_signals: {
      response_speed_score: Number(row.response_speed_score || 0),
      acceptance_rate: Number(row.acceptance_rate || 0),
      completion_rate: Number(row.completion_rate || 0),
      favorites_count: Number(row.favorites_count || 0),
      follows_count: Number(row.follows_count || 0),
      billing_bonus: Number(row.billing_bonus || 0),
      verified_bonus: Number(row.verified_bonus || 0)
    },
    services,
    service_areas: serviceAreas,
    business_hours: businessHours,
    marketplace_services: marketplaceServices,
    marketplace_service_areas: marketplaceServiceAreas,
    availability,
    contact: {
      phone: row.phone || "",
      email: row.email || "",
      address: row.address || ""
    }
  };
}

function cleanCustomServiceName(value) {
  return cleanText(value).slice(0, 120);
}

function normalizeZipCode(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.slice(0, 5);
}

function normalizeState(value) {
  return cleanText(value).toUpperCase().slice(0, 2);
}

function normalizeRadiusMiles(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(250, Math.round(n));
}

function normalizeDayOfWeek(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 6) return null;
  return n;
}

function normalizeTime(value) {
  const text = cleanText(value);
  if (!text) return "";
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return "";
  return `${match[1]}:${match[2]}`;
}

function toMinutes(timeText) {
  const parts = String(timeText || "").split(":");
  if (parts.length !== 2) return NaN;
  return Number(parts[0]) * 60 + Number(parts[1]);
}

async function canReadCompanyPrivateMetadata(req, targetCompanyId) {
  try {
    const token = getBearerToken(req && req.headers && req.headers.authorization);
    if (!token) return false;
    const decoded = jwt.verify(token, SECRET);
    const boundary = classifyTokenBoundary(decoded);
    if (boundary.type !== "staff") return false;
    const role = boundary.role || normalizeRole(decoded && decoded.role);
    if (!role) return false;
    try {
      await validateStaffTokenAgainstDatabase(decoded, role);
    } catch {
      return false;
    }
    if (role === "platform_owner") return true;
    if (role !== "admin" && role !== "owner") return false;

    const decodedCompanyId = Number(decoded && decoded.company_id);
    const requestedCompanyId = Number(targetCompanyId);
    if (!Number.isInteger(decodedCompanyId) || decodedCompanyId <= 0) return false;
    if (!Number.isInteger(requestedCompanyId) || requestedCompanyId <= 0) return false;
    return decodedCompanyId === requestedCompanyId;
  } catch {
    return false;
  }
}

async function resolveReportActor(req) {
  const token = getBearerToken(req && req.headers && req.headers.authorization);
  if (!token) {
    return null;
  }
  const decoded = jwt.verify(token, SECRET);
  const boundary = classifyTokenBoundary(decoded);
  if (boundary.type === "mixed") {
    return null;
  }
  if (boundary.type === "customer") {
    const active = await verifyActiveCustomerBearerToken(req.headers.authorization);
    return {
      reporter_user_id: null,
      reporter_customer_id: Number(active.customer && active.customer.client_id) || null
    };
  }
  if (boundary.type !== "staff") {
    return null;
  }
  const userId = Number(decoded && decoded.id);
  const role = boundary.role || normalizeRole(decoded && decoded.role);
  const companyId = Number(decoded && decoded.company_id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return null;
  }
  if (!["owner", "admin", "manager", "worker", "platform_owner"].includes(role || "")) {
    return null;
  }
  if (role !== "platform_owner" && (!Number.isInteger(companyId) || companyId <= 0)) {
    return null;
  }
  try {
    await validateStaffTokenAgainstDatabase(decoded, role);
  } catch {
    return null;
  }
  return {
    reporter_user_id: userId,
    reporter_customer_id: null
  };
}

router.get("/companies/public", async (req, res) => {
  try {
    const discList = discoveryService.parseDiscoverySearchQuery(req.query);
    let limitClause = "";
    const listExtraParams = [];
    if (discList.publicListLimit != null) {
      limitClause = ` LIMIT $1 OFFSET $2`;
      listExtraParams.push(discList.publicListLimit, discList.publicListOffset);
    }

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        is_verified,
        public_slug,
        public_description,
        logo_url,
        cover_image_url,
        gallery_urls,
        website_url,
        facebook_url,
        instagram_url,
        phone,
        email,
        address,
        average_rating,
        review_count,
        response_speed_score,
        acceptance_rate,
        completion_rate,
        favorites_count,
        follows_count,
        billing_bonus,
        verified_bonus,
        verification_status,
        verified_at,
        insurance_status,
        license_status,
        identity_status,
        insurance_expiry_date,
        license_expiry_date,
        insurance_expired,
        license_expired,
        ranking_score
        ,
        reputation_score,
        trust_score,
        trust_badges,
        marketplace_ranking_calculated_at,
        marketplace_ranking_components
      FROM (
        SELECT
          c.id,
          c.name,
          c.is_verified,
          c.public_slug,
          c.public_description,
          c.logo_url,
          c.cover_image_url,
          c.gallery_urls,
          c.website_url,
          c.facebook_url,
          c.instagram_url,
          c.phone,
          c.email,
          c.address,
          COALESCE(rev.average_rating, 0)::numeric AS average_rating,
          COALESCE(rev.review_count, 0)::int AS review_count,
          GREATEST(0, LEAST(1, 1 - (COALESCE(resp.avg_response_seconds, 86400) / 86400.0)))::numeric AS response_speed_score,
          COALESCE(acc.acceptance_rate, 0)::numeric AS acceptance_rate,
          COALESCE(comp.completion_rate, 0)::numeric AS completion_rate,
          COALESCE(fav.favorites_count, 0)::int AS favorites_count,
          COALESCE(fol.follows_count, 0)::int AS follows_count,
          CASE WHEN c.billing_status IN ('active', 'trialing') OR c.billing_status IS NULL THEN 1 ELSE 0 END::numeric AS billing_bonus,
          CASE WHEN c.is_verified = TRUE THEN 1 ELSE 0 END::numeric AS verified_bonus,
          c.verification_status,
          c.verified_at,
          c.insurance_status,
          c.license_status,
          c.identity_status,
          c.insurance_expiry_date,
          c.license_expiry_date,
          CASE
            WHEN c.insurance_expiry_date IS NOT NULL AND c.insurance_expiry_date < CURRENT_DATE THEN TRUE
            ELSE FALSE
          END AS insurance_expired,
          CASE
            WHEN c.license_expiry_date IS NOT NULL AND c.license_expiry_date < CURRENT_DATE THEN TRUE
            ELSE FALSE
          END AS license_expired,
          COALESCE(
            cmr.ranking_score,
            (
              (COALESCE(rev.average_rating, 0) / 5.0) * 32 +
              (LEAST(1, LN(1 + COALESCE(rev.review_count, 0)) / LN(51))) * 8 +
              (GREATEST(0, LEAST(1, 1 - (COALESCE(resp.avg_response_seconds, 86400) / 86400.0)))) * 12 +
              (COALESCE(acc.acceptance_rate, 0)) * 12 +
              (COALESCE(comp.completion_rate, 0)) * 10 +
              (CASE WHEN c.billing_status IN ('active', 'trialing') OR c.billing_status IS NULL THEN 1 ELSE 0 END) * 7 +
              (CASE WHEN c.is_verified = TRUE THEN 1 ELSE 0 END) * 7 +
              (LEAST(1, LN(1 + COALESCE(fav.favorites_count, 0)) / LN(51))) * 6 +
              (LEAST(1, LN(1 + COALESCE(fol.follows_count, 0)) / LN(51))) * 6
            )
          )::numeric(10,4) AS ranking_score,
          COALESCE(
            cts.reputation_score,
            (
              LEAST(
                100,
                GREATEST(0, COALESCE(rev.average_rating, 0) * 20)
              )
            )
          )::numeric AS reputation_score,
          COALESCE(cts.trust_score, 0)::numeric AS trust_score,
          COALESCE(cts.badges, '[]'::jsonb) AS trust_badges,
          cmr.calculated_at AS marketplace_ranking_calculated_at,
          cmr.ranking_components AS marketplace_ranking_components
        FROM companies c
        LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
        LEFT JOIN company_trust_scores cts ON cts.company_id = c.id
        LEFT JOIN (
          SELECT
            company_id,
            AVG(rating)::numeric AS average_rating,
            COUNT(*)::int AS review_count
          FROM company_reviews
          GROUP BY company_id
        ) rev
          ON rev.company_id = c.id
        LEFT JOIN (
          SELECT
            mo.company_id,
            AVG(EXTRACT(EPOCH FROM (mo.created_at - mr.created_at)))::numeric AS avg_response_seconds
          FROM marketplace_offers mo
          JOIN marketplace_requests mr
            ON mr.id = mo.request_id
          WHERE mo.created_at >= mr.created_at
          GROUP BY mo.company_id
        ) resp
          ON resp.company_id = c.id
        LEFT JOIN (
          SELECT
            company_id,
            (COUNT(*) FILTER (WHERE status = 'accepted'))::numeric / NULLIF(COUNT(*)::numeric, 0) AS acceptance_rate
          FROM marketplace_offers
          GROUP BY company_id
        ) acc
          ON acc.company_id = c.id
        LEFT JOIN (
          SELECT
            mo.company_id,
            (COUNT(*) FILTER (WHERE mo.status = 'accepted' AND mr.converted_at IS NOT NULL))::numeric
              / NULLIF((COUNT(*) FILTER (WHERE mo.status = 'accepted'))::numeric, 0) AS completion_rate
          FROM marketplace_offers mo
          LEFT JOIN marketplace_requests mr
            ON mr.accepted_offer_id = mo.id
          GROUP BY mo.company_id
        ) comp
          ON comp.company_id = c.id
        LEFT JOIN (
          SELECT company_id, COUNT(*)::int AS favorites_count
          FROM customer_favorites
          GROUP BY company_id
        ) fav
          ON fav.company_id = c.id
        LEFT JOIN (
          SELECT company_id, COUNT(*)::int AS follows_count
          FROM customer_company_follows
          GROUP BY company_id
        ) fol
          ON fol.company_id = c.id
        WHERE c.is_public = TRUE
          AND COALESCE(NULLIF(TRIM(c.public_slug), ''), '') <> ''
      ) ranked
      ORDER BY
        ranking_score DESC,
        COALESCE(trust_score, 50) DESC,
        COALESCE(reputation_score, 0) DESC,
        name ASC,
        id ASC
      ` +
        limitClause +
        `
    `,
      listExtraParams
    );

    const items = await Promise.all(result.rows.map(shapePublicCompany));
    res.json(items);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANIES PUBLIC LIST ERROR");
  }
});

router.post("/companies/public/discovery/click", discoveryClickLimiter, async (req, res) => {
  try {
    const companyId = Number(req.body && req.body.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    let userId = null;
    let customerAccountId = null;
    try {
      const active = await verifyActiveCustomerBearerToken(req.headers.authorization);
      if (active && active.customer && active.customer.customer_account_id != null) {
        customerAccountId = Number(active.customer.customer_account_id);
      }
    } catch (_) {
      /* anonymous discovery click */
    }

    discoveryService.queueDiscoveryLog({
      action: "discovery_click",
      userId,
      customerAccountId,
      details: {
        company_id: companyId,
        context: cleanText(req.body && req.body.context),
        referrer: cleanText(req.headers.referer || req.headers.referrer)
      }
    });

    return res.status(204).send();
  } catch (err) {
    return sendSafeServerError(res, err, "DISCOVERY CLICK ERROR");
  }
});

router.get("/companies/public/search", async (req, res) => {
  try {
    const serviceRaw = cleanText(req.query && req.query.service);
    const cityRaw = cleanText(req.query && req.query.city);
    const stateRaw = cleanText(req.query && req.query.state).toUpperCase().slice(0, 2);
    const zipRaw = String(req.query && req.query.zip || "").replace(/\D/g, "").slice(0, 5);
    const serviceToken = cleanSearchToken(serviceRaw);
    const serviceSlug = cleanSlug(serviceRaw);
    const cityToken = cityRaw.toLowerCase();

    const parsed = discoveryService.parseDiscoverySearchQuery(req.query);
    const badgeJsonb =
      parsed.badgeId ? JSON.stringify([{ id: parsed.badgeId }]) : null;

    const result = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.is_verified,
        c.public_slug,
        c.public_description,
        c.logo_url,
        c.cover_image_url,
        c.gallery_urls,
        c.website_url,
        c.facebook_url,
        c.instagram_url,
        c.phone,
        c.email,
        c.address,
        COALESCE(rev.average_rating, 0)::numeric AS average_rating,
        COALESCE(rev.review_count, 0)::int AS review_count,
        c.verification_status,
        c.verified_at,
        c.insurance_status,
        c.license_status,
        c.identity_status,
        c.insurance_expiry_date,
        c.license_expiry_date,
        CASE
          WHEN c.insurance_expiry_date IS NOT NULL AND c.insurance_expiry_date < CURRENT_DATE THEN TRUE
          ELSE FALSE
        END AS insurance_expired,
        CASE
          WHEN c.license_expiry_date IS NOT NULL AND c.license_expiry_date < CURRENT_DATE THEN TRUE
          ELSE FALSE
        END AS license_expired,
        0::numeric AS response_speed_score,
        0::numeric AS acceptance_rate,
        0::numeric AS completion_rate,
        0::int AS favorites_count,
        0::int AS follows_count,
        0::numeric AS billing_bonus,
        0::numeric AS verified_bonus,
        COALESCE(
          cmr.ranking_score,
          (
            LEAST(
              100,
              GREATEST(0, COALESCE(rev.average_rating, 0) * 20)
            )
          )
        )::numeric AS ranking_score
        ,
        COALESCE(
          cts.reputation_score,
          (
            LEAST(
              100,
              GREATEST(0, COALESCE(rev.average_rating, 0) * 20)
            )
          )
        )::numeric AS reputation_score,
        COALESCE(cts.trust_score, 0)::numeric AS trust_score,
        COALESCE(cts.badges, '[]'::jsonb) AS trust_badges,
        cmr.calculated_at AS marketplace_ranking_calculated_at,
        cmr.ranking_components AS marketplace_ranking_components
      FROM companies c
      LEFT JOIN company_marketplace_rankings cmr ON cmr.company_id = c.id
      LEFT JOIN company_trust_scores cts ON cts.company_id = c.id
      LEFT JOIN (
        SELECT
          company_id,
          AVG(rating)::numeric AS average_rating,
          COUNT(*)::int AS review_count
        FROM company_reviews
        GROUP BY company_id
      ) rev
        ON rev.company_id = c.id
      WHERE c.is_public = TRUE
        AND c.platform_suspended_at IS NULL
        AND COALESCE(NULLIF(TRIM(c.public_slug), ''), '') <> ''
        AND (
          (
            $6::text = ''
            AND EXISTS (
              SELECT 1
              FROM company_services cs
              JOIN service_categories sc
                ON sc.id = cs.category_id
              WHERE cs.company_id = c.id
                AND cs.active = TRUE
                AND sc.active = TRUE
                AND (
                  $1 = ''
                  OR LOWER(sc.slug) = LOWER($2)
                  OR LOWER(sc.name) LIKE '%' || LOWER($1) || '%'
                  OR LOWER(cs.custom_name) LIKE '%' || LOWER($1) || '%'
                )
            )
          )
          OR (
            $6::text <> ''
            AND (
              LOWER(c.name) LIKE '%' || $6 || '%'
              OR LOWER(COALESCE(c.public_description, '')) LIKE '%' || $6 || '%'
              OR EXISTS (
                SELECT 1
                FROM company_services cs
                JOIN service_categories sc
                  ON sc.id = cs.category_id
                WHERE cs.company_id = c.id
                  AND cs.active = TRUE
                  AND sc.active = TRUE
                  AND (
                    LOWER(sc.name) LIKE '%' || $6 || '%'
                    OR LOWER(COALESCE(cs.custom_name, '')) LIKE '%' || $6 || '%'
                    OR LOWER(sc.slug) LIKE '%' || $6 || '%'
                  )
              )
            )
            AND (
              $1::text = ''
              OR EXISTS (
                SELECT 1
                FROM company_services cs
                JOIN service_categories sc
                  ON sc.id = cs.category_id
                WHERE cs.company_id = c.id
                  AND cs.active = TRUE
                  AND sc.active = TRUE
                  AND (
                    LOWER(sc.slug) = LOWER($2)
                    OR LOWER(sc.name) LIKE '%' || LOWER($1) || '%'
                    OR LOWER(cs.custom_name) LIKE '%' || LOWER($1) || '%'
                  )
              )
            )
          )
        )
        AND EXISTS (
          SELECT 1
          FROM company_service_areas csa
          WHERE csa.company_id = c.id
            AND csa.active = TRUE
            AND (
              ($3 = '' AND $4 = '' AND $5 = '')
              OR ($3 <> '' AND LOWER(csa.city) = LOWER($3) AND ($4 = '' OR UPPER(csa.state) = UPPER($4)))
              OR ($5 <> '' AND csa.zip_code = $5)
              OR ($4 <> '' AND UPPER(csa.state) = UPPER($4))
            )
        )
        AND ($7::int IS NULL OR EXISTS (
          SELECT 1
          FROM company_services csf
          WHERE csf.company_id = c.id
            AND csf.active = TRUE
            AND csf.category_id = $7::int
        ))
        AND ($8::text = '' OR EXISTS (
          SELECT 1
          FROM company_services csu
          JOIN service_categories scu ON scu.id = csu.category_id
          WHERE csu.company_id = c.id
            AND csu.active = TRUE
            AND scu.active = TRUE
            AND LOWER(scu.slug) = LOWER($8::text)
        ))
        AND ($9::numeric IS NULL OR COALESCE(rev.average_rating, 0) >= $9::numeric)
        AND (
          $10::jsonb IS NULL
          OR COALESCE(cts.badges, '[]'::jsonb) @> $10::jsonb
        )
        AND (
          $11::int IS NULL
          OR EXISTS (
            SELECT 1
            FROM company_availability ca
            WHERE ca.company_id = c.id
              AND ca.day_of_week = $11::int
              AND ca.is_closed = FALSE
          )
        )
      ORDER BY
        COALESCE(cmr.ranking_score, 0) DESC,
        COALESCE(cts.trust_score, 50) DESC,
        COALESCE(cts.reputation_score, LEAST(100, COALESCE(rev.average_rating, 0) * 20)) DESC,
        c.created_at DESC NULLS LAST,
        c.name ASC,
        c.id ASC
      LIMIT $12 OFFSET $13
      `,
      [
        serviceToken,
        serviceSlug,
        cityToken,
        stateRaw,
        zipRaw,
        parsed.qToken,
        parsed.categoryId,
        parsed.categorySlug || "",
        parsed.minRating,
        badgeJsonb,
        parsed.availabilityDay,
        parsed.searchLimit,
        parsed.searchOffset
      ]
    );

    const shaped = await Promise.all(result.rows.map(shapePublicCompany));
    const items = shaped.map((company) => ({
      id: company.id,
      name: company.name,
      slug: company.public_slug,
      logo_url: company.logo_url,
      public_description: company.public_description,
      services: company.services,
      service_areas: company.service_areas,
      trust: company.trust,
      is_verified: company.is_verified,
      rating_summary: company.rating_summary,
      ranking_score: company.ranking_score,
      reputation_expansion_score: company.reputation_expansion_score,
      reputation_badge_candidates: company.reputation_badge_candidates,
      reputation_risk_level: company.reputation_risk_level,
      trust_badges: company.trust_badges
    }));

    discoveryService.queueDiscoveryLog({
      action: "discovery_search",
      details: {
        result_count: items.length,
        filters: discoveryService.summarizeAppliedFilters(parsed),
        raw_query: {
          service: serviceRaw,
          city: cityRaw,
          state: stateRaw,
          zip: zipRaw,
          q: cleanText(req.query && (req.query.q || req.query.keyword))
        }
      }
    });

    if (discoveryService.hasStructuredFilters(parsed)) {
      discoveryService.queueDiscoveryLog({
        action: "discovery_filter",
        details: {
          result_count: items.length,
          filters: discoveryService.summarizeAppliedFilters(parsed)
        }
      });
    }

    return res.json({
      query: {
        service: serviceRaw,
        city: cityRaw,
        state: stateRaw,
        zip: zipRaw,
        q: cleanText(req.query && (req.query.q || req.query.keyword)),
        category_id: parsed.categoryId,
        category_slug: parsed.categorySlug || "",
        min_rating: parsed.minRating,
        badge: parsed.badgeId || "",
        availability_day: parsed.availabilityDay,
        limit: parsed.searchLimit,
        offset: parsed.searchOffset
      },
      count: items.length,
      companies: items
    });
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANIES PUBLIC SEARCH ERROR");
  }
});

router.get("/companies/public/:slug", async (req, res) => {
  try {
    const slug = cleanSlug(req.params.slug);
    if (!slug) {
      return res.status(400).json({ error: "Invalid slug" });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        is_verified,
        public_slug,
        public_description,
        logo_url,
        cover_image_url,
        gallery_urls,
        website_url,
        facebook_url,
        instagram_url,
        verification_status,
        verified_at,
        insurance_status,
        license_status,
        identity_status,
        insurance_expiry_date,
        license_expiry_date,
        CASE
          WHEN insurance_expiry_date IS NOT NULL AND insurance_expiry_date < CURRENT_DATE THEN TRUE
          ELSE FALSE
        END AS insurance_expired,
        CASE
          WHEN license_expiry_date IS NOT NULL AND license_expiry_date < CURRENT_DATE THEN TRUE
          ELSE FALSE
        END AS license_expired,
        phone,
        email,
        address,
        (
          LEAST(
            100,
            GREATEST(
              0,
              COALESCE((
                SELECT AVG(rating)::numeric
                FROM company_reviews
                WHERE company_id = companies.id
              ), 0) * 20
            )
          )
        )::numeric AS reputation_score
      FROM companies
      WHERE is_public = TRUE
        AND LOWER(public_slug) = LOWER($1)
      LIMIT 1
      `,
      [slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    const row = result.rows[0];
    const payload = await shapePublicCompany(row);
    try {
      const snap = await marketplaceRankingService.getMarketplaceRankingPublic(row.id);
      payload.ranking_score = snap.ranking_score;
      payload.reputation_score = snap.reputation_score;
      payload.trust_score = snap.trust_score;
      payload.trust_badges = snap.trust_badges;
      payload.reputation_expansion_score = snap.reputation_expansion_score;
      payload.reputation_badge_candidates = snap.reputation_badge_candidates;
      payload.reputation_risk_level = snap.reputation_risk_level;
      payload.marketplace_rank = snap.marketplace_rank;
      payload.marketplace_ranking = {
        ranking_score: snap.ranking_score,
        calculated_at: snap.calculated_at,
        components: snap.ranking_components || {}
      };
    } catch {
      /* ranking snapshot optional when deps unavailable */
    }
    res.json(payload);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY PUBLIC DETAIL ERROR");
  }
});

router.get("/companies/public/:slug/trust-profile", async (req, res) => {
  try {
    const slug = cleanSlug(req.params.slug);
    if (!slug) {
      return res.status(400).json({ error: "Invalid slug" });
    }

    const found = await pool.query(
      `
      SELECT id
      FROM companies
      WHERE is_public = TRUE
        AND LOWER(public_slug) = LOWER($1)
      LIMIT 1
      `,
      [slug]
    );

    if (!found.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    const companyId = found.rows[0].id;
    const full = await trustReputationService.buildCompanyTrustProfile(companyId, { detail: false });
    res.json(trustReputationService.buildPublicTrustProfile(full));
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ error: "Company not found" });
    }
    sendSafeServerError(res, err, "PUBLIC TRUST PROFILE ERROR");
  }
});

router.get("/companies/public/:id/activity", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const companyResult = await pool.query(
      `
      SELECT
        id,
        is_public,
        is_verified,
        verification_status,
        verified_at,
        insurance_status,
        license_status,
        identity_status
      FROM companies
      WHERE id = $1
      LIMIT 1
      `,
      [companyId]
    );
    if (!companyResult.rows.length || companyResult.rows[0].is_public !== true) {
      return res.status(404).json({ error: "Company not found" });
    }
    const company = companyResult.rows[0];

    const [reviewsResult, servicesResult, areasResult] = await Promise.all([
      pool.query(
        `
        SELECT rating, created_at
        FROM company_reviews
        WHERE company_id = $1
          AND is_public = TRUE
        ORDER BY created_at DESC, id DESC
        LIMIT 3
        `,
        [companyId]
      ),
      pool.query(
        `
        SELECT
          COALESCE(NULLIF(TRIM(cs.custom_name), ''), sc.name) AS service_name,
          cs.created_at
        FROM company_services cs
        JOIN service_categories sc
          ON sc.id = cs.category_id
        WHERE cs.company_id = $1
          AND cs.active = TRUE
          AND sc.active = TRUE
        ORDER BY cs.created_at DESC, cs.id DESC
        LIMIT 3
        `,
        [companyId]
      ),
      pool.query(
        `
        SELECT city, state, zip_code, created_at
        FROM company_service_areas
        WHERE company_id = $1
          AND active = TRUE
        ORDER BY created_at DESC, id DESC
        LIMIT 3
        `,
        [companyId]
      )
    ]);

    const activities = [];

    reviewsResult.rows.forEach((row) => {
      activities.push({
        type: "review_added",
        title: "New public review",
        detail: `${Number(row.rating || 0).toFixed(1)} star rating`,
        occurred_at: row.created_at || null
      });
    });

    servicesResult.rows.forEach((row) => {
      activities.push({
        type: "service_added",
        title: "Service listed",
        detail: row.service_name || "Service",
        occurred_at: row.created_at || null
      });
    });

    areasResult.rows.forEach((row) => {
      const area = [row.city, row.state, row.zip_code].filter(Boolean).join(", ").replace(/, ([A-Z]{2}),/, ", $1 ");
      activities.push({
        type: "area_added",
        title: "Coverage updated",
        detail: area || "Service area listed",
        occurred_at: row.created_at || null
      });
    });

    activities.push({
      type: "trust_badge_updated",
      title: "Trust badge status",
      detail: [
        company.verification_status === "verified" ? "Verified" : null,
        company.identity_status === "verified" ? "Identity Verified" : null,
        company.insurance_status === "verified" ? "Insured" : null,
        company.license_status === "verified" ? "Licensed" : null
      ].filter(Boolean).join(" • ") || "Trust status available",
      occurred_at: null
    });

    activities.sort((a, b) => {
      const at = a.occurred_at ? new Date(a.occurred_at).getTime() : -1;
      const bt = b.occurred_at ? new Date(b.occurred_at).getTime() : -1;
      return bt - at;
    });

    return res.json({
      company_id: companyId,
      items: activities.slice(0, 12)
    });
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY PUBLIC ACTIVITY ERROR");
  }
});

router.post("/companies/:id/report", companyReportLimiter, async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    const reason = cleanText(req.body && req.body.reason).slice(0, 200);
    const details = cleanText(req.body && req.body.details).slice(0, 4000);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: "Reason is required" });
    }
    let actor;
    try {
      actor = await resolveReportActor(req);
    } catch (_) {
      actor = null;
    }
    if (!actor) {
      return res.status(401).json({ error: "Login required to submit a report" });
    }

    const exists = await pool.query(
      "SELECT id FROM companies WHERE id = $1 LIMIT 1",
      [companyId]
    );
    if (!exists.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    const inserted = await pool.query(
      `
      INSERT INTO abuse_reports (
        reporter_user_id,
        reporter_customer_id,
        company_id,
        target_type,
        target_id,
        reason,
        details
      )
      VALUES ($1, $2, $3, 'company', $3, $4, $5)
      RETURNING id, target_type, target_id, reason, details, status, priority, created_at
      `,
      [
        actor.reporter_user_id,
        actor.reporter_customer_id,
        companyId,
        reason,
        details || null
      ]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY REPORT CREATE ERROR");
  }
});

router.put("/companies/public-profile", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const publicDescription = cleanText(req.body?.public_description);
    const logoUrl = cleanUrl(req.body?.logo_url);
    const coverImageUrl = cleanUrl(req.body?.cover_image_url);
    const galleryUrls = normalizeGallery(req.body?.gallery_urls);
    const websiteUrl = cleanUrl(req.body?.website_url);
    const facebookUrl = cleanUrl(req.body?.facebook_url);
    const instagramUrl = cleanUrl(req.body?.instagram_url);
    const isPublic = req.body?.is_public === true;

    let publicSlug = cleanSlug(req.body?.public_slug);
    if (!publicSlug) {
      const companyResult = await pool.query(
        `SELECT name FROM companies WHERE id = $1 LIMIT 1`,
        [companyId]
      );
      if (!companyResult.rows.length) {
        return res.status(404).json({ error: "Company not found" });
      }
      publicSlug = cleanSlug(companyResult.rows[0].name || "");
    }

    if (!publicSlug) {
      return res.status(400).json({ error: "Public slug is required" });
    }

    const slugConflict = await pool.query(
      `
      SELECT id
      FROM companies
      WHERE LOWER(public_slug) = LOWER($1)
        AND id <> $2
      LIMIT 1
      `,
      [publicSlug, companyId]
    );
    if (slugConflict.rows.length) {
      return res.status(409).json({ error: "Public slug is already in use" });
    }

    const result = await pool.query(
      `
      UPDATE companies
      SET
        public_slug = $2,
        public_description = $3,
        logo_url = $4,
        cover_image_url = $5,
        gallery_urls = $6::jsonb,
        is_public = $7,
        website_url = $8,
        facebook_url = $9,
        instagram_url = $10
      WHERE id = $1
      RETURNING
        id,
        name,
        public_slug,
        public_description,
        logo_url,
        cover_image_url,
        gallery_urls,
        is_public,
        website_url,
        facebook_url,
        instagram_url
      `,
      [
        companyId,
        publicSlug,
        publicDescription,
        logoUrl,
        coverImageUrl,
        JSON.stringify(galleryUrls),
        isPublic,
        websiteUrl,
        facebookUrl,
        instagramUrl
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY PUBLIC PROFILE UPDATE ERROR");
  }
});

router.post("/companies/verify/:companyId", auth, requirePlatformOwner, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const verificationNotes = cleanText(req.body && req.body.verification_notes);
    const result = await pool.query(
      `
      UPDATE companies
      SET
        is_verified = TRUE,
        verified_at = CURRENT_TIMESTAMP,
        verification_notes = $2
      WHERE id = $1
      RETURNING id, name, email, is_verified, verified_at, verification_notes
      `,
      [companyId, verificationNotes || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    const company = result.rows[0];
    const companyEmail = String(company.email || "").trim();
    if (companyEmail) {
      queueSafeEmail({
        to: companyEmail,
        subject: "Your company is now verified",
        text: `Congratulations! ${company.name || "Your company"} is now verified on the platform.`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px">
            <h2>Company verified</h2>
            <p>Congratulations! <strong>${String(company.name || "Your company").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong> is now verified on the platform.</p>
          </div>
        `
      }, { kind: "company_verified" });
    }

    return res.json({
      id: company.id,
      is_verified: company.is_verified,
      verified_at: company.verified_at,
      verification_notes: company.verification_notes
    });
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY VERIFY ERROR");
  }
});

router.post("/companies/unverify/:companyId", auth, requirePlatformOwner, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const verificationNotes = cleanText(req.body && req.body.verification_notes);
    const result = await pool.query(
      `
      UPDATE companies
      SET
        is_verified = FALSE,
        verified_at = NULL,
        verification_notes = $2
      WHERE id = $1
      RETURNING id, is_verified, verified_at, verification_notes
      `,
      [companyId, verificationNotes || null]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Company not found" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY UNVERIFY ERROR");
  }
});

router.put("/companies/services", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const incoming = Array.isArray(req.body?.services) ? req.body.services : [];
    const normalized = incoming
      .map((item) => ({
        category_id: Number(item && item.category_id),
        custom_name: cleanCustomServiceName(item && item.custom_name),
        active: item && item.active !== false
      }))
      .filter((item) => Number.isInteger(item.category_id) && item.category_id > 0);

    const uniqueByCategory = [];
    const seen = new Set();
    for (const item of normalized) {
      if (seen.has(item.category_id)) continue;
      seen.add(item.category_id);
      uniqueByCategory.push(item);
    }

    const activeCategoryIds = uniqueByCategory
      .filter((item) => item.active)
      .map((item) => item.category_id);

    await client.query("BEGIN");

    if (activeCategoryIds.length) {
      const categoryCheck = await client.query(
        `
        SELECT id
        FROM service_categories
        WHERE active = TRUE
          AND id = ANY($1::int[])
        `,
        [activeCategoryIds]
      );
      const validIds = new Set(categoryCheck.rows.map((row) => Number(row.id)));
      const invalid = activeCategoryIds.filter((id) => !validIds.has(Number(id)));
      if (invalid.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "One or more service categories are invalid or inactive" });
      }
    }

    await client.query(
      `
      UPDATE company_services
      SET active = FALSE
      WHERE company_id = $1
      `,
      [companyId]
    );

    for (const item of uniqueByCategory) {
      await client.query(
        `
        INSERT INTO company_services (company_id, category_id, custom_name, active)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (company_id, category_id)
        DO UPDATE SET
          custom_name = EXCLUDED.custom_name,
          active = EXCLUDED.active
        `,
        [companyId, item.category_id, item.custom_name, item.active]
      );
    }

    const result = await client.query(
      `
      SELECT
        cs.id,
        cs.company_id,
        cs.category_id,
        cs.custom_name,
        cs.active,
        cs.created_at,
        sc.name,
        sc.slug,
        sc.description,
        sc.icon,
        sc.sort_order
      FROM company_services cs
      JOIN service_categories sc
        ON sc.id = cs.category_id
      WHERE cs.company_id = $1
        AND cs.active = TRUE
      ORDER BY sc.sort_order ASC, sc.name ASC, cs.id ASC
      `,
      [companyId]
    );

    await client.query("COMMIT");

    res.json(
      result.rows.map((row) => ({
        id: row.id,
        company_id: row.company_id,
        category_id: row.category_id,
        custom_name: row.custom_name || "",
        active: row.active,
        created_at: row.created_at,
        category: {
          id: row.category_id,
          name: row.name,
          slug: row.slug,
          description: row.description || "",
          icon: row.icon || "",
          sort_order: row.sort_order
        },
        display_name: row.custom_name || row.name
      }))
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    sendSafeServerError(res, err, "COMPANY SERVICES UPDATE ERROR");
  } finally {
    client.release();
  }
});

router.get("/companies/:id/marketplace-ranking", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const pub = await pool.query(
      `
      SELECT id
      FROM companies
      WHERE id = $1
        AND is_public = TRUE
        AND COALESCE(NULLIF(TRIM(public_slug), ''), '') <> ''
      LIMIT 1
      `,
      [companyId]
    );

    if (!pub.rows.length) {
      return res.status(404).json({ error: "Not found" });
    }

    const payload = await marketplaceRankingService.getMarketplaceRankingPublic(companyId);
    res.json(payload);
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ error: "Company not found" });
    }
    sendSafeServerError(res, err, "COMPANY MARKETPLACE RANKING ERROR");
  }
});

router.get("/companies/:id/service-areas", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!companyId) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const canReadPrivate = await canReadCompanyPrivateMetadata(req, companyId);
    const result = await pool.query(
      `
      SELECT
        id,
        company_id,
        zip_code,
        city,
        state,
        radius_miles,
        active,
        created_at
      FROM company_service_areas
      WHERE company_id = $1
        AND active = TRUE
        AND ($2::boolean = TRUE OR EXISTS (
          SELECT 1
          FROM companies c
          WHERE c.id = company_service_areas.company_id
            AND c.is_public = TRUE
        ))
      ORDER BY id ASC
      `,
      [companyId, canReadPrivate]
    );

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY SERVICE AREAS LIST ERROR");
  }
});

router.put("/companies/service-areas", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const incoming = Array.isArray(req.body?.service_areas) ? req.body.service_areas : [];
    const normalized = incoming
      .map((item) => ({
        zip_code: normalizeZipCode(item && item.zip_code),
        city: cleanText(item && item.city).slice(0, 120),
        state: normalizeState(item && item.state),
        radius_miles: normalizeRadiusMiles(item && item.radius_miles),
        active: item && item.active !== false
      }))
      .filter((item) => item.zip_code);

    const uniqueRows = [];
    const seen = new Set();
    for (const item of normalized) {
      const key = [item.zip_code, item.city.toLowerCase(), item.state, item.radius_miles].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueRows.push(item);
    }

    await client.query("BEGIN");

    await client.query(
      `
      UPDATE company_service_areas
      SET active = FALSE
      WHERE company_id = $1
      `,
      [companyId]
    );

    for (const item of uniqueRows) {
      if (!item.active) continue;
      await client.query(
        `
        INSERT INTO company_service_areas
          (company_id, zip_code, city, state, radius_miles, active)
        VALUES
          ($1, $2, $3, $4, $5, TRUE)
        `,
        [companyId, item.zip_code, item.city, item.state, item.radius_miles]
      );
    }

    const result = await client.query(
      `
      SELECT
        id,
        company_id,
        zip_code,
        city,
        state,
        radius_miles,
        active,
        created_at
      FROM company_service_areas
      WHERE company_id = $1
        AND active = TRUE
      ORDER BY id ASC
      `,
      [companyId]
    );

    await client.query("COMMIT");
    res.json(result.rows);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    sendSafeServerError(res, err, "COMPANY SERVICE AREAS UPDATE ERROR");
  } finally {
    client.release();
  }
});

router.get("/companies/:id/availability", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!companyId) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const canReadPrivate = await canReadCompanyPrivateMetadata(req, companyId);
    const result = await pool.query(
      `
      SELECT
        id,
        company_id,
        day_of_week,
        start_time,
        end_time,
        is_closed,
        created_at
      FROM company_availability
      WHERE company_id = $1
        AND ($2::boolean = TRUE OR EXISTS (
          SELECT 1
          FROM companies c
          WHERE c.id = company_availability.company_id
            AND c.is_public = TRUE
        ))
      ORDER BY day_of_week ASC
      `,
      [companyId, canReadPrivate]
    );

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY AVAILABILITY LIST ERROR");
  }
});

router.put("/companies/availability", auth, requireCompanyBillingForMutations, requireMinimumRole("admin"), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.user && req.user.company_id;
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const incoming = Array.isArray(req.body?.availability) ? req.body.availability : [];
    const normalized = [];
    const seenDays = new Set();

    for (const item of incoming) {
      const dayOfWeek = normalizeDayOfWeek(item && item.day_of_week);
      if (dayOfWeek === null) {
        return res.status(400).json({ error: "day_of_week must be an integer between 0 and 6" });
      }
      if (seenDays.has(dayOfWeek)) {
        return res.status(400).json({ error: "Only one availability row is allowed per day" });
      }
      seenDays.add(dayOfWeek);

      const isClosed = item && item.is_closed === true;
      const startTime = normalizeTime(item && item.start_time);
      const endTime = normalizeTime(item && item.end_time);

      if (!isClosed) {
        if (!startTime || !endTime) {
          return res.status(400).json({ error: "start_time and end_time are required for open days (HH:MM)" });
        }
        const startMinutes = toMinutes(startTime);
        const endMinutes = toMinutes(endTime);
        if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || startMinutes >= endMinutes) {
          return res.status(400).json({ error: "Invalid time range. start_time must be before end_time." });
        }
      }

      normalized.push({
        day_of_week: dayOfWeek,
        start_time: isClosed ? "" : startTime,
        end_time: isClosed ? "" : endTime,
        is_closed: isClosed
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM company_availability
      WHERE company_id = $1
      `,
      [companyId]
    );

    for (const row of normalized) {
      await client.query(
        `
        INSERT INTO company_availability
          (company_id, day_of_week, start_time, end_time, is_closed)
        VALUES
          ($1, $2, $3, $4, $5)
        `,
        [companyId, row.day_of_week, row.start_time, row.end_time, row.is_closed]
      );
    }

    const result = await client.query(
      `
      SELECT
        id,
        company_id,
        day_of_week,
        start_time,
        end_time,
        is_closed,
        created_at
      FROM company_availability
      WHERE company_id = $1
      ORDER BY day_of_week ASC
      `,
      [companyId]
    );

    await client.query("COMMIT");
    res.json(result.rows);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    sendSafeServerError(res, err, "COMPANY AVAILABILITY UPDATE ERROR");
  } finally {
    client.release();
  }
});

router.post("/companies/reputation/refresh", auth, requireMinimumRole("admin"), async (req, res) => {
  try {
    const companyId = Number(req.user && req.user.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const refreshed = await refreshCompanyReputation(companyId);
    return res.json({
      company_id: companyId,
      reputation_score: refreshed.score,
      factors: refreshed.factors
    });
  } catch (err) {
    return sendSafeServerError(res, err, "COMPANY REPUTATION REFRESH ERROR");
  }
});

router.get("/companies/:id/trust-profile", auth, requireMinimumRole("manager"), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const role = normalizeRole(req.user && req.user.role);
    const requesterCompany = Number(req.user && req.user.company_id);
    if (role !== "platform_owner") {
      if (!Number.isInteger(requesterCompany) || requesterCompany !== targetId) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const profile = await trustReputationService.buildCompanyTrustProfile(targetId, { detail: true });
    res.json(profile);
  } catch (err) {
    if (err && err.code === "COMPANY_NOT_FOUND") {
      return res.status(404).json({ error: "Company not found" });
    }
    sendSafeServerError(res, err, "COMPANY TRUST PROFILE ERROR");
  }
});

module.exports = router;

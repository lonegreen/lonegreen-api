const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const pool = require("../db/pool");
const companyAuth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { SECRET } = require("../config/env");
const { requireMinimumRole, requireActiveCustomer, getBearerToken, classifyTokenBoundary, normalizeRole, verifyActiveCustomerBearerToken, validateStaffTokenAgainstDatabase } = require("../middleware/auth");
const {
  marketplaceCustomerRequestCreateLimiter,
  marketplaceOfferAcceptLimiter,
  marketplaceCompanyOfferCreateLimiter,
  marketplaceCompanyConvertLimiter
} = require("../middleware/rateLimits");
const { validateMarketplaceContent } = require("../middleware/abuseGuards");
const { sendSafeServerError } = require("../services/safeServerError");
const {
  resolveCustomerAccountId,
  loadPortalScopes,
  tokenClientBelongsToScopes
} = require("../services/customerPortalScope");

const router = express.Router();

function parsePagination(query) {
  const parsedLimit = Number(query && query.limit);
  const parsedOffset = Number(query && query.offset);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;
  return { limit, offset };
}

const customerAuth = requireActiveCustomer;
const marketplaceReportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
const marketplaceDisputeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});


function cleanText(value) {
  return String(value || "").trim();
}

function normalizeStatus(value) {
  const normalized = String(value || "open").trim().toLowerCase();
  return ["open", "matched", "closed", "cancelled"].includes(normalized) ? normalized : null;
}

function normalizeZip(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function normalizeCity(value) {
  return cleanText(value).toLowerCase();
}

function normalizeState(value) {
  return cleanText(value).toUpperCase().slice(0, 2);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function safeTime(value, fallback) {
  const raw = cleanText(value);
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(raw)) {
    return raw;
  }
  return fallback;
}

function plusOneHour(timeText) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeText || ""));
  if (!match) {
    return "09:00";
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  const next = (h + 1) % 24;
  return `${String(next).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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

async function getCustomerAccountId(clientId) {
  const accountResult = await pool.query(
    `
    SELECT id
    FROM customer_accounts
    WHERE client_id = $1
    LIMIT 1
    `,
    [clientId]
  );
  return accountResult.rows[0] ? accountResult.rows[0].id : null;
}

async function getOwnedRequest(requestId, customerPayload) {
  const clientId = customerPayload && customerPayload.client_id;
  const accountId = await resolveCustomerAccountId(customerPayload);
  if (accountId) {
    const result = await pool.query(
      `
      SELECT *
      FROM marketplace_requests
      WHERE id = $1
        AND (
          client_id = $2
          OR customer_account_id = $3
        )
      LIMIT 1
      `,
      [requestId, clientId, accountId]
    );
    return result.rows[0] || null;
  }

  const result = await pool.query(
    `
    SELECT *
    FROM marketplace_requests
    WHERE id = $1
      AND client_id = $2
    LIMIT 1
    `,
    [requestId, clientId]
  );
  return result.rows[0] || null;
}

async function getRequestById(requestId) {
  const result = await pool.query(
    `
    SELECT *
    FROM marketplace_requests
    WHERE id = $1
    LIMIT 1
    `,
    [requestId]
  );
  return result.rows[0] || null;
}

async function canCompanyMatchRequest(companyId, requestRow) {
  if (!requestRow) {
    return false;
  }

  const requestZip = normalizeZip(requestRow.zip_code);
  const requestCity = normalizeCity(requestRow.city);
  const requestState = normalizeState(requestRow.state);

  const result = await pool.query(
    `
    SELECT 1
    FROM companies c
    JOIN company_services cs
      ON cs.company_id = c.id
     AND cs.active = TRUE
     AND cs.category_id = $2
    JOIN company_service_areas csa
      ON csa.company_id = c.id
     AND csa.active = TRUE
    WHERE c.id = $1
      AND c.is_public = TRUE
      AND c.platform_suspended_at IS NULL
      AND c.billing_status IN ('trialing', 'active')
      AND (
        ($3 <> '' AND LEFT(REGEXP_REPLACE(COALESCE(csa.zip_code, ''), '[^0-9]', '', 'g'), 5) = $3)
        OR ($4 <> '' AND LOWER(csa.city) = $4)
        OR ($5 <> '' AND UPPER(csa.state) = $5)
      )
    LIMIT 1
    `,
    [companyId, requestRow.category_id, requestZip, requestCity, requestState]
  );

  return result.rows.length > 0;
}

async function marketplaceDisputeAuth(req, res, next) {
  try {
    const token = getBearerToken(req && req.headers && req.headers.authorization);
    if (!token) {
      return res.status(401).json({ error: "Authorization required" });
    }
    const decoded = jwt.verify(token, SECRET);
    const boundary = classifyTokenBoundary(decoded);
    if (boundary.type === "mixed") {
      return res.status(403).json({ error: "Mixed auth boundary token" });
    }
    if (boundary.type === "customer") {
      const active = await verifyActiveCustomerBearerToken(req.headers.authorization);
      req.disputeActor = {
        actor_type: "customer",
        customer_id: Number(active.customer && active.customer.client_id) || null
      };
      req.customer = active.customer;
      return next();
    }
    if (boundary.type !== "staff") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const userId = Number(decoded && decoded.id);
    const companyId = Number(decoded && decoded.company_id);
    const role = normalizeRole(decoded && decoded.role);
    if (!Number.isInteger(userId) || userId <= 0 || !["owner", "admin", "manager", "worker", "platform_owner"].includes(role || "")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (role !== "platform_owner" && (!Number.isInteger(companyId) || companyId <= 0)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await validateStaffTokenAgainstDatabase(decoded, role);
    req.disputeActor = {
      actor_type: role === "platform_owner" ? "platform" : "company",
      user_id: userId,
      company_id: role === "platform_owner" ? null : companyId
    };
    return next();
  } catch (err) {
    return res.status(err && err.status ? err.status : 401).json({
      error: (err && err.status) ? err.message : "Invalid token"
    });
  }
}

router.get("/marketplace/opportunities", companyAuth, requireMinimumRole("manager"), async (req, res) => {
  try {
    const companyId = Number(req.user && req.user.company_id);
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(
      `
      SELECT
        mr.id,
        mr.category_id,
        sc.name AS category_name,
        mr.title,
        mr.description,
        mr.requested_date,
        mr.requested_time,
        mr.address,
        mr.city,
        mr.state,
        mr.zip_code,
        mr.status,
        mr.created_at
      FROM marketplace_requests mr
      LEFT JOIN service_categories sc
        ON sc.id = mr.category_id
      WHERE mr.status = 'open'
        AND EXISTS (
          SELECT 1
          FROM companies c
          JOIN company_services cs
            ON cs.company_id = c.id
           AND cs.active = TRUE
           AND cs.category_id = mr.category_id
          JOIN company_service_areas csa
            ON csa.company_id = c.id
           AND csa.active = TRUE
          WHERE c.id = $1
            AND c.is_public = TRUE
            AND c.platform_suspended_at IS NULL
            AND c.billing_status IN ('trialing', 'active')
            AND (
              (
                mr.zip_code <> ''
                AND LEFT(REGEXP_REPLACE(COALESCE(csa.zip_code, ''), '[^0-9]', '', 'g'), 5)
                  = LEFT(REGEXP_REPLACE(COALESCE(mr.zip_code, ''), '[^0-9]', '', 'g'), 5)
              )
              OR (mr.city <> '' AND LOWER(csa.city) = LOWER(mr.city))
              OR (mr.state <> '' AND UPPER(csa.state) = UPPER(mr.state))
            )
        )
      ORDER BY mr.created_at DESC, mr.id DESC
      LIMIT $2 OFFSET $3
      `,
      [companyId, limit, offset]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE OPPORTUNITIES LIST ERROR");
  }
});

router.get("/marketplace/offers/me", companyAuth, requireMinimumRole("manager"), async (req, res) => {
  try {
    const companyId = Number(req.user && req.user.company_id);
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { limit, offset } = parsePagination(req.query);
    const result = await pool.query(
      `
      SELECT
        mo.id,
        mo.request_id,
        mo.company_id,
        mo.price,
        mo.message,
        mo.estimated_start_date,
        mo.status,
        mo.created_at,
        mr.title AS request_title,
        mr.description AS request_description,
        mr.category_id,
        mr.requested_date,
        mr.requested_time,
        mr.city,
        mr.state,
        mr.zip_code,
        mr.address,
        mr.status AS request_status
      FROM marketplace_offers mo
      JOIN marketplace_requests mr
        ON mr.id = mo.request_id
      WHERE mo.company_id = $1
      ORDER BY mo.created_at DESC, mo.id DESC
      LIMIT $2 OFFSET $3
      `,
      [companyId, limit, offset]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE COMPANY OFFERS LIST ERROR");
  }
});

router.post("/marketplace/requests", customerAuth, marketplaceCustomerRequestCreateLimiter, validateMarketplaceContent, async (req, res) => {
  try {
    const categoryId = Number(req.body?.category_id);
    const title = cleanText(req.body?.title);
    const description = cleanText(req.body?.description);
    const requestedDate = cleanText(req.body?.requested_date) || null;
    const requestedTime = cleanText(req.body?.requested_time) || null;
    const address = cleanText(req.body?.address);
    const city = cleanText(req.body?.city);
    const state = cleanText(req.body?.state);
    const zipCode = cleanText(req.body?.zip_code);
    const status = "open";

    if (!categoryId || !title) {
      return res.status(400).json({ error: "category_id and title are required" });
    }

    const categoryCheck = await pool.query(
      "SELECT id FROM service_categories WHERE id = $1 LIMIT 1",
      [categoryId]
    );
    if (!categoryCheck.rows.length) {
      return res.status(400).json({ error: "Invalid category_id" });
    }

    const customerAccountId = await getCustomerAccountId(req.customer.client_id);
    const created = await pool.query(
      `
      INSERT INTO marketplace_requests (
        customer_account_id,
        client_id,
        category_id,
        title,
        description,
        requested_date,
        requested_time,
        address,
        city,
        state,
        zip_code,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      `,
      [
        customerAccountId,
        req.customer.client_id,
        categoryId,
        title,
        description,
        requestedDate,
        requestedTime,
        address,
        city,
        state,
        zipCode,
        status
      ]
    );

    return res.status(201).json(withModerationFlag(created.rows[0], res));
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST CREATE ERROR");
  }
});

router.post("/marketplace/requests/:id/cancel", customerAuth, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    await dbClient.query("BEGIN");

    const owned = await getOwnedRequest(requestId, req.customer);
    if (!owned) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }

    const lockResult = await dbClient.query(
      `
      SELECT id, status
      FROM marketplace_requests
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [requestId]
    );
    const current = lockResult.rows[0];
    if (!current) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }

    const status = String(current.status || "").toLowerCase();
    if (status === "cancelled") {
      await dbClient.query("COMMIT");
      return res.json({
        request_id: requestId,
        status: "cancelled",
        already_cancelled: true
      });
    }
    if (status !== "open") {
      await dbClient.query("ROLLBACK");
      return res.status(409).json({
        error: "Only open requests can be cancelled"
      });
    }

    await dbClient.query(
      `
      UPDATE marketplace_offers
      SET status = 'rejected'
      WHERE request_id = $1
        AND status = 'pending'
      `,
      [requestId]
    );

    const cancelled = await dbClient.query(
      `
      UPDATE marketplace_requests
      SET status = 'cancelled'
      WHERE id = $1
        AND status = 'open'
      RETURNING id, status
      `,
      [requestId]
    );

    await dbClient.query("COMMIT");

    if (!cancelled.rows.length) {
      return res.status(409).json({
        error: "Request was modified by another action"
      });
    }

    return res.json({
      request_id: requestId,
      status: "cancelled",
      already_cancelled: false
    });
  } catch (err) {
    try { await dbClient.query("ROLLBACK"); } catch (_) {}
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST CANCEL ERROR");
  } finally {
    dbClient.release();
  }
});

router.get("/marketplace/requests/me", customerAuth, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const accountId = await resolveCustomerAccountId(req.customer);
    let result;
    if (accountId) {
      result = await pool.query(
        `
        SELECT *
        FROM marketplace_requests
        WHERE customer_account_id = $1
           OR (customer_account_id IS NULL AND client_id = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4
        `,
        [accountId, req.customer.client_id, limit, offset]
      );
    } else {
      result = await pool.query(
        `
        SELECT *
        FROM marketplace_requests
        WHERE client_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3
        `,
        [req.customer.client_id, limit, offset]
      );
    }
    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST LIST ERROR");
  }
});

router.get("/marketplace/requests/:id/matches", customerAuth, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const { limit, offset } = parsePagination(req.query);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const accountId = await resolveCustomerAccountId(req.customer);
    const requestResult = await pool.query(
      `
      SELECT
        id,
        client_id,
        category_id,
        zip_code,
        city,
        state
      FROM marketplace_requests
      WHERE id = $1
        AND (
          client_id = $2
          OR ($3::INT IS NOT NULL AND customer_account_id = $3)
        )
      LIMIT 1
      `,
      [requestId, req.customer.client_id, accountId]
    );

    if (!requestResult.rows.length) {
      return res.status(404).json({ error: "Request not found" });
    }

    const request = requestResult.rows[0];
    const requestZip = normalizeZip(request.zip_code);
    const requestCity = normalizeCity(request.city);
    const requestState = normalizeState(request.state);

    const matches = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.phone,
        c.email,
        c.address,
        c.public_slug,
        c.public_description,
        c.logo_url,
        c.cover_image_url,
        c.gallery_urls,
        c.website_url,
        c.facebook_url,
        c.instagram_url,
        c.is_public,
        c.billing_status,
        c.platform_suspended_at,
        COALESCE(rev.average_rating, 0)::numeric AS average_rating,
        COALESCE(rev.review_count, 0)::int AS review_count,
        GREATEST(0, LEAST(1, 1 - (COALESCE(resp.avg_response_seconds, 86400) / 86400.0)))::numeric AS response_speed_score,
        COALESCE(acc.acceptance_rate, 0)::numeric AS acceptance_rate,
        COALESCE(comp.completion_rate, 0)::numeric AS completion_rate,
        COALESCE(fav.favorites_count, 0)::int AS favorites_count,
        COALESCE(fol.follows_count, 0)::int AS follows_count,
        MAX(
          CASE
            WHEN $2 <> '' AND LEFT(REGEXP_REPLACE(COALESCE(csa.zip_code, ''), '[^0-9]', '', 'g'), 5) = $2 THEN 1.0
            WHEN $3 <> '' AND LOWER(csa.city) = $3 THEN 0.65
            WHEN $4 <> '' AND UPPER(csa.state) = $4 THEN 0.35
            ELSE 0
          END
        )::numeric AS proximity_score,
        (
          (COALESCE(rev.average_rating, 0) / 5.0) * 24 +
          (LEAST(1, LN(1 + COALESCE(rev.review_count, 0)) / LN(51))) * 7 +
          (GREATEST(0, LEAST(1, 1 - (COALESCE(resp.avg_response_seconds, 86400) / 86400.0)))) * 11 +
          (COALESCE(acc.acceptance_rate, 0)) * 11 +
          (COALESCE(comp.completion_rate, 0)) * 10 +
          (MAX(
            CASE
              WHEN $2 <> '' AND LEFT(REGEXP_REPLACE(COALESCE(csa.zip_code, ''), '[^0-9]', '', 'g'), 5) = $2 THEN 1.0
              WHEN $3 <> '' AND LOWER(csa.city) = $3 THEN 0.65
              WHEN $4 <> '' AND UPPER(csa.state) = $4 THEN 0.35
              ELSE 0
            END
          )) * 18 +
          (CASE WHEN c.billing_status IN ('active', 'trialing') THEN 1 ELSE 0 END) * 6 +
          (CASE WHEN c.is_verified = TRUE THEN 1 ELSE 0 END) * 6 +
          (LEAST(1, LN(1 + COALESCE(fav.favorites_count, 0)) / LN(51))) * 4 +
          (LEAST(1, LN(1 + COALESCE(fol.follows_count, 0)) / LN(51))) * 3
        )::numeric(10,4) AS ranking_score
      FROM companies c
      JOIN company_services cs
        ON cs.company_id = c.id
       AND cs.active = TRUE
       AND cs.category_id = $1
      JOIN company_service_areas csa
        ON csa.company_id = c.id
       AND csa.active = TRUE
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
        AND c.platform_suspended_at IS NULL
        AND c.billing_status IN ('trialing', 'active')
        AND (
          ($2 <> '' AND LEFT(REGEXP_REPLACE(COALESCE(csa.zip_code, ''), '[^0-9]', '', 'g'), 5) = $2)
          OR ($3 <> '' AND LOWER(csa.city) = $3)
          OR ($4 <> '' AND UPPER(csa.state) = $4)
        )
      GROUP BY
        c.id,
        c.name,
        c.phone,
        c.email,
        c.address,
        c.public_slug,
        c.public_description,
        c.logo_url,
        c.cover_image_url,
        c.gallery_urls,
        c.website_url,
        c.facebook_url,
        c.instagram_url,
        c.is_public,
        c.billing_status,
        c.platform_suspended_at,
        rev.average_rating,
        rev.review_count,
        resp.avg_response_seconds,
        acc.acceptance_rate,
        comp.completion_rate,
        fav.favorites_count,
        fol.follows_count
      ORDER BY ranking_score DESC, c.id ASC
      LIMIT $5 OFFSET $6
      `,
      [request.category_id, requestZip, requestCity, requestState, limit, offset]
    );

    return res.json({
      request_id: request.id,
      matches: matches.rows
    });
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST MATCHES ERROR");
  }
});

router.post("/marketplace/requests/:id/offers", companyAuth, requireCompanyBillingForMutations, requireMinimumRole("manager"), marketplaceCompanyOfferCreateLimiter, validateMarketplaceContent, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const companyId = Number(req.user && req.user.company_id);
    const price = Number(req.body?.price);
    const message = cleanText(req.body?.message);
    const estimatedStartDate = cleanText(req.body?.estimated_start_date) || null;

    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "Valid price is required" });
    }

    const requestRow = await getRequestById(requestId);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found" });
    }
    if (String(requestRow.status || "").toLowerCase() !== "open") {
      return res.status(409).json({ error: "Request is locked for new offers" });
    }

    const isMatched = await canCompanyMatchRequest(companyId, requestRow);
    if (!isMatched) {
      return res.status(403).json({ error: "Company is not matched to this request" });
    }

    const created = await pool.query(
      `
      INSERT INTO marketplace_offers (
        request_id,
        company_id,
        price,
        message,
        estimated_start_date,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (request_id, company_id)
      DO UPDATE SET
        price = EXCLUDED.price,
        message = EXCLUDED.message,
        estimated_start_date = EXCLUDED.estimated_start_date,
        status = 'pending'
      RETURNING *
      `,
      [requestId, companyId, price, message, estimatedStartDate]
    );

    return res.status(201).json(withModerationFlag(created.rows[0], res));
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE OFFER CREATE ERROR");
  }
});

router.post("/marketplace/offers/:id/accept", customerAuth, marketplaceOfferAcceptLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const offerId = Number(req.params.id);
    if (!offerId) {
      return res.status(400).json({ error: "Invalid offer id" });
    }

    const accountId = await resolveCustomerAccountId(req.customer);
    if (accountId) {
      const scopes = await loadPortalScopes(accountId);
      if (scopes.length && !tokenClientBelongsToScopes(scopes, req.customer.client_id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    await client.query("BEGIN");

    const offerResult = await client.query(
      `
      SELECT
        mo.id,
        mo.request_id,
        mo.company_id,
        mo.price,
        mo.message,
        mo.estimated_start_date,
        mo.status,
        mo.created_at
      FROM marketplace_offers mo
      JOIN marketplace_requests mr
        ON mr.id = mo.request_id
      WHERE mo.id = $1
        AND (
          mr.client_id = $2
          OR ($3::INT IS NOT NULL AND mr.customer_account_id = $3)
        )
      LIMIT 1
      FOR UPDATE
      `,
      [offerId, req.customer.client_id, accountId]
    );

    if (!offerResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Offer not found" });
    }

    const selectedOffer = offerResult.rows[0];
    const requestId = Number(selectedOffer.request_id);

    const requestLockResult = await client.query(
      `
      SELECT id, status
      FROM marketplace_requests
      WHERE id = $1
        AND (
          client_id = $2
          OR ($3::INT IS NOT NULL AND customer_account_id = $3)
        )
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, req.customer.client_id, accountId]
    );

    if (!requestLockResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }

    const requestRow = requestLockResult.rows[0];
    if (String(requestRow.status || "").toLowerCase() !== "open") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Request is not open for acceptance" });
    }

    await client.query(
      `
      UPDATE marketplace_offers
      SET status = CASE WHEN id = $1 THEN 'accepted' ELSE 'rejected' END
      WHERE request_id = $2
      `,
      [offerId, requestId]
    );

    await client.query(
      `
      UPDATE marketplace_requests
      SET
        status = 'matched',
        accepted_offer_id = $2
      WHERE id = $1
      `,
      [requestId, offerId]
    );

    const acceptedResult = await client.query(
      `
      SELECT
        id,
        request_id,
        company_id,
        price,
        message,
        estimated_start_date,
        status,
        created_at
      FROM marketplace_offers
      WHERE id = $1
      LIMIT 1
      `,
      [offerId]
    );

    await client.query("COMMIT");

    return res.json({
      request_id: requestId,
      request_status: "matched",
      accepted_offer: acceptedResult.rows[0]
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    return sendSafeServerError(res, err, "MARKETPLACE OFFER ACCEPT ERROR");
  } finally {
    client.release();
  }
});

router.post("/marketplace/requests/:id/convert", companyAuth, requireCompanyBillingForMutations, requireMinimumRole("manager"), marketplaceCompanyConvertLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const requestId = Number(req.params.id);
    const companyId = Number(req.user && req.user.company_id);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    if (!companyId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await client.query("BEGIN");

    const conversionSource = await client.query(
      `
      SELECT
        mr.*,
        mo.id AS accepted_offer_id,
        mo.price AS accepted_offer_price,
        mo.message AS accepted_offer_message,
        mo.estimated_start_date AS accepted_offer_start_date,
        ca.first_name AS account_first_name,
        ca.last_name AS account_last_name,
        ca.phone AS account_phone,
        ca.email AS account_email
      FROM marketplace_requests mr
      JOIN marketplace_offers mo
        ON mo.request_id = mr.id
       AND mo.status = 'accepted'
      LEFT JOIN customer_accounts ca
        ON ca.id = mr.customer_account_id
      WHERE mr.id = $1
        AND mo.company_id = $2
      LIMIT 1
      FOR UPDATE OF mr, mo
      `,
      [requestId, companyId]
    );

    if (!conversionSource.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Accepted offer not found for this company and request" });
    }

    const source = conversionSource.rows[0];
    if (source.converted_at) {
      // Idempotency path: request already converted in a previous successful transaction.
      // Return existing references instead of attempting to create duplicate workflow rows.
      const [leadResult, estimateResult, clientResult, jobResult] = await Promise.all([
        source.converted_lead_id
          ? client.query(
              `
              SELECT *
              FROM estimates
              WHERE id = $1
                AND company_id = $2
              LIMIT 1
              `,
              [source.converted_lead_id, companyId]
            )
          : Promise.resolve({ rows: [] }),
        source.converted_estimate_id
          ? client.query(
              `
              SELECT *
              FROM estimates
              WHERE id = $1
                AND company_id = $2
              LIMIT 1
              `,
              [source.converted_estimate_id, companyId]
            )
          : Promise.resolve({ rows: [] }),
        source.converted_client_id
          ? client.query(
              `
              SELECT *
              FROM clients
              WHERE id = $1
                AND company_id = $2
              LIMIT 1
              `,
              [source.converted_client_id, companyId]
            )
          : Promise.resolve({ rows: [] }),
        source.converted_job_id
          ? client.query(
              `
              SELECT *
              FROM jobs
              WHERE id = $1
                AND company_id = $2
              LIMIT 1
              `,
              [source.converted_job_id, companyId]
            )
          : Promise.resolve({ rows: [] })
      ]);

      await client.query("COMMIT");
      return res.json({
        request_id: requestId,
        converted: true,
        converted_already: true,
        reused_client: true,
        accepted_offer_id: source.accepted_offer_id,
        lead: leadResult.rows[0] || null,
        estimate: estimateResult.rows[0] || {
          id: source.converted_estimate_id || null,
          converted_client_id: source.converted_client_id || null,
          converted_job_id: source.converted_job_id || null
        },
        client: clientResult.rows[0] || null,
        job: jobResult.rows[0] || null
      });
    }

    const customerName = cleanText(
      [source.account_first_name, source.account_last_name].filter(Boolean).join(" ")
    ) || "Marketplace Customer";
    const phone = cleanText(source.account_phone) || "";
    const normalizedPhone = normalizePhone(phone);
    const address = cleanText(source.address) || "";
    const zip = normalizeZip(source.zip_code) || "";
    const serviceTitle = cleanText(source.title) || "Marketplace Service Request";
    const serviceNotes = cleanText(source.description);
    const requestDate = source.requested_date || new Date().toISOString().slice(0, 10);
    const startTime = safeTime(source.requested_time, "08:00");
    const endTime = plusOneHour(startTime);
    const offerPrice = Number(source.accepted_offer_price || 0);
    const offerMessage = cleanText(source.accepted_offer_message);

    let companyClient = null;
    if (normalizedPhone) {
      const existingClientByPhone = await client.query(
        `
        SELECT id, name, phone, address, zip, notes, company_id
        FROM clients
        WHERE company_id = $1
          AND COALESCE(archived, FALSE) = FALSE
          AND REGEXP_REPLACE(COALESCE(phone, ''), '\D', '', 'g') = $2
        ORDER BY id ASC
        LIMIT 1
        `,
        [companyId, normalizedPhone]
      );
      companyClient = existingClientByPhone.rows[0] || null;
    }

    if (!companyClient && customerName && zip) {
      const existingClientByIdentity = await client.query(
        `
        SELECT id, name, phone, address, zip, notes, company_id
        FROM clients
        WHERE company_id = $1
          AND COALESCE(archived, FALSE) = FALSE
          AND LOWER(COALESCE(name, '')) = LOWER($2)
          AND COALESCE(zip, '') = $3
        ORDER BY id ASC
        LIMIT 1
        `,
        [companyId, customerName, zip]
      );
      companyClient = existingClientByIdentity.rows[0] || null;
    }

    const clientWasReused = Boolean(companyClient);
    if (!companyClient) {
      const createdClient = await client.query(
        `
        INSERT INTO clients (name, phone, address, zip, notes, company_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [
          customerName,
          phone,
          address,
          zip,
          `Marketplace request #${requestId}`,
          companyId
        ]
      );
      companyClient = createdClient.rows[0];
    }

    if (source.customer_account_id && companyClient && companyClient.id) {
      await client.query(
        `
        INSERT INTO customer_account_clients (customer_account_id, client_id, company_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
        `,
        [source.customer_account_id, companyClient.id, companyId]
      );
    }

    const leadInsert = await client.query(
      `
      INSERT INTO estimates (
        client_id,
        customer_name,
        phone,
        address,
        zip,
        service,
        status,
        quoted_price,
        visit_date,
        notes,
        company_id,
        record_type,
        marketplace_request_id,
        marketplace_offer_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'new', $7, $8, $9, $10, 'lead', $11, $12)
      RETURNING *
      `,
      [
        companyClient.id,
        customerName,
        phone,
        address,
        zip,
        serviceTitle,
        offerPrice,
        requestDate,
        `Marketplace lead from request #${requestId}. ${serviceNotes}`.trim(),
        companyId,
        requestId,
        source.accepted_offer_id
      ]
    );
    const lead = leadInsert.rows[0];

    const estimateInsert = await client.query(
      `
      INSERT INTO estimates (
        client_id,
        customer_name,
        phone,
        address,
        zip,
        service,
        status,
        quoted_price,
        visit_date,
        notes,
        company_id,
        record_type,
        source_lead_id,
        marketplace_request_id,
        marketplace_offer_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, $9, $10, 'estimate', $11, $12, $13)
      RETURNING *
      `,
      [
        companyClient.id,
        customerName,
        phone,
        address,
        zip,
        serviceTitle,
        offerPrice,
        requestDate,
        `Marketplace estimate from accepted offer #${source.accepted_offer_id}. ${offerMessage}`.trim(),
        companyId,
        lead.id,
        requestId,
        source.accepted_offer_id
      ]
    );
    const estimate = estimateInsert.rows[0];

    const jobInsert = await client.query(
      `
      INSERT INTO jobs (
        client_id,
        service,
        type,
        date,
        start_time,
        end_time,
        status,
        worker_id,
        price,
        company_id,
        payment_status,
        internal_notes,
        status_reason,
        estimate_id,
        marketplace_request_id,
        marketplace_offer_id
      )
      VALUES ($1, $2, 'one_time_job', $3, $4, $5, 'scheduled', NULL, $6, $7, 'unpaid', $8, '', $9, $10, $11)
      RETURNING *
      `,
      [
        companyClient.id,
        serviceTitle,
        requestDate,
        startTime,
        endTime,
        offerPrice,
        companyId,
        `Marketplace job from request #${requestId}.`,
        estimate.id,
        requestId,
        source.accepted_offer_id
      ]
    );
    const job = jobInsert.rows[0];

    await client.query(
      `
      UPDATE estimates
      SET
        status = 'converted',
        converted_client_id = $1,
        converted_job_id = $2,
        converted_at = CURRENT_TIMESTAMP
      WHERE id = $3
        AND company_id = $4
        AND record_type = 'estimate'
      `,
      [companyClient.id, job.id, estimate.id, companyId]
    );

    await client.query(
      `
      UPDATE marketplace_requests
      SET
        status = 'matched',
        accepted_offer_id = $2,
        converted_at = CURRENT_TIMESTAMP,
        converted_by_company_id = $3,
        converted_lead_id = $4,
        converted_estimate_id = $5,
        converted_client_id = $6,
        converted_job_id = $7
      WHERE id = $1
        AND accepted_offer_id = $2
      `,
      [
        requestId,
        source.accepted_offer_id,
        companyId,
        lead.id,
        estimate.id,
        companyClient.id,
        job.id
      ]
    );

    await client.query("COMMIT");

    return res.json({
      request_id: requestId,
      converted: true,
      reused_client: clientWasReused,
      accepted_offer_id: source.accepted_offer_id,
      lead,
      estimate: {
        ...estimate,
        status: "converted",
        converted_client_id: companyClient.id,
        converted_job_id: job.id
      },
      client: companyClient,
      job
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST CONVERT ERROR");
  } finally {
    client.release();
  }
});

router.get("/marketplace/requests/:id/offers", customerAuth, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const { limit, offset } = parsePagination(req.query);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const ownedRequest = await getOwnedRequest(requestId, req.customer);
    if (!ownedRequest) {
      return res.status(404).json({ error: "Request not found" });
    }

    const result = await pool.query(
      `
      SELECT
        mo.id,
        mo.request_id,
        mo.company_id,
        mo.price,
        mo.message,
        mo.estimated_start_date,
        mo.status,
        mo.created_at,
        c.name AS company_name,
        c.public_slug,
        c.logo_url
      FROM marketplace_offers mo
      JOIN companies c
        ON c.id = mo.company_id
      WHERE mo.request_id = $1
      ORDER BY mo.created_at DESC, mo.id DESC
      LIMIT $2 OFFSET $3
      `,
      [requestId, limit, offset]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE OFFERS LIST ERROR");
  }
});

router.get("/marketplace/requests/:id", customerAuth, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const requestRow = await getOwnedRequest(requestId, req.customer);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found" });
    }

    return res.json(requestRow);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST DETAIL ERROR");
  }
});

router.post("/marketplace/requests/:id/dispute", marketplaceDisputeAuth, marketplaceDisputeLimiter, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const reason = cleanText(req.body && req.body.reason).slice(0, 200);
    const details = cleanText(req.body && req.body.details).slice(0, 4000);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: "Reason is required" });
    }

    const actor = req.disputeActor || {};
    let requestRow = null;
    if (actor.actor_type === "customer") {
      requestRow = await getOwnedRequest(requestId, req.customer);
      if (!requestRow) {
        return res.status(404).json({ error: "Request not found" });
      }
    } else if (actor.actor_type === "company") {
      const companyId = Number(actor.company_id || 0);
      const requestResult = await pool.query(
        `
        SELECT mr.id, mr.client_id
        FROM marketplace_requests mr
        WHERE mr.id = $1
          AND (
            EXISTS (
              SELECT 1
              FROM marketplace_offers mo
              WHERE mo.request_id = mr.id
                AND mo.company_id = $2
            )
            OR EXISTS (
              SELECT 1
              FROM marketplace_offers mo
              WHERE mo.id = mr.accepted_offer_id
                AND mo.company_id = $2
            )
          )
        LIMIT 1
        `,
        [requestId, companyId]
      );
      requestRow = requestResult.rows[0] || null;
      if (!requestRow) {
        return res.status(404).json({ error: "Request not found" });
      }
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }

    const inserted = await pool.query(
      `
      INSERT INTO disputes (
        marketplace_request_id,
        support_ticket_id,
        company_id,
        customer_id,
        opened_by_type,
        opened_by_user_id,
        opened_by_customer_id,
        reason,
        details,
        status,
        priority
      )
      VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'open', 'medium')
      RETURNING id, marketplace_request_id, support_ticket_id, company_id, customer_id, opened_by_type, reason, details, status, priority, created_at
      `,
      [
        requestId,
        actor.actor_type === "company" ? Number(actor.company_id || 0) : null,
        actor.actor_type === "customer" ? Number(requestRow.client_id || actor.customer_id || 0) : Number(requestRow.client_id || 0) || null,
        actor.actor_type,
        actor.actor_type === "company" ? Number(actor.user_id || 0) : null,
        actor.actor_type === "customer" ? Number(actor.customer_id || 0) : null,
        reason,
        details || null
      ]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST DISPUTE CREATE ERROR");
  }
});

router.post("/marketplace/requests/:id/report", customerAuth, marketplaceReportLimiter, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const reason = cleanText(req.body && req.body.reason).slice(0, 200);
    const details = cleanText(req.body && req.body.details).slice(0, 4000);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Invalid request id" });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: "Reason is required" });
    }

    const requestRow = await getOwnedRequest(requestId, req.customer);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found" });
    }

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
      VALUES ($1, NULL, 'marketplace_request', $2, $3, $4)
      RETURNING id, target_type, target_id, reason, details, status, priority, created_at
      `,
      [req.customer.client_id, requestId, reason, details || null]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST REPORT CREATE ERROR");
  }
});

module.exports = router;

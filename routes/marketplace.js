const express = require("express");
const pool = require("../db/pool");
const companyAuth = require("../middleware/auth");
const requireCompanyBillingForMutations = require("../middleware/requireCompanyBillingForMutations");
const { requireMinimumRole, verifyCustomerBearerToken } = require("../middleware/auth");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

function customerAuth(req, res, next) {
  try {
    req.customer = verifyCustomerBearerToken(req.headers.authorization);
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || "Invalid customer token" });
  }
}

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

async function getOwnedRequest(requestId, clientId) {
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
      AND (
        c.billing_status IS NULL
        OR c.billing_status IN ('trialing', 'active')
      )
      AND (
        ($3 <> '' AND csa.zip_code = $3)
        OR ($4 <> '' AND LOWER(csa.city) = $4)
        OR ($5 <> '' AND UPPER(csa.state) = $5)
      )
    LIMIT 1
    `,
    [companyId, requestRow.category_id, requestZip, requestCity, requestState]
  );

  return result.rows.length > 0;
}

router.post("/marketplace/requests", customerAuth, async (req, res) => {
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
    const status = normalizeStatus(req.body?.status || "open");

    if (!categoryId || !title) {
      return res.status(400).json({ error: "category_id and title are required" });
    }
    if (!status) {
      return res.status(400).json({ error: "Invalid status" });
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

    return res.status(201).json(created.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST CREATE ERROR");
  }
});

router.get("/marketplace/requests/me", customerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM marketplace_requests
      WHERE client_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [req.customer.client_id]
    );
    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST LIST ERROR");
  }
});

router.get("/marketplace/requests/:id/matches", customerAuth, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }

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
        AND client_id = $2
      LIMIT 1
      `,
      [requestId, req.customer.client_id]
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
            WHEN $2 <> '' AND csa.zip_code = $2 THEN 1.0
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
              WHEN $2 <> '' AND csa.zip_code = $2 THEN 1.0
              WHEN $3 <> '' AND LOWER(csa.city) = $3 THEN 0.65
              WHEN $4 <> '' AND UPPER(csa.state) = $4 THEN 0.35
              ELSE 0
            END
          )) * 18 +
          (CASE WHEN c.billing_status IN ('active', 'trialing') OR c.billing_status IS NULL THEN 1 ELSE 0 END) * 6 +
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
        AND (
          c.billing_status IS NULL
          OR c.billing_status IN ('trialing', 'active')
        )
        AND (
          ($2 <> '' AND csa.zip_code = $2)
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
      `,
      [request.category_id, requestZip, requestCity, requestState]
    );

    return res.json({
      request_id: request.id,
      matches: matches.rows
    });
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST MATCHES ERROR");
  }
});

router.post("/marketplace/requests/:id/offers", companyAuth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
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

    return res.status(201).json(created.rows[0]);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE OFFER CREATE ERROR");
  }
});

router.post("/marketplace/offers/:id/accept", customerAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const offerId = Number(req.params.id);
    if (!offerId) {
      return res.status(400).json({ error: "Invalid offer id" });
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
        AND mr.client_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [offerId, req.customer.client_id]
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
        AND client_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, req.customer.client_id]
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

router.post("/marketplace/requests/:id/convert", companyAuth, requireCompanyBillingForMutations, requireMinimumRole("manager"), async (req, res) => {
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
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Request already converted",
        conversion: {
          converted_at: source.converted_at,
          converted_lead_id: source.converted_lead_id || null,
          converted_estimate_id: source.converted_estimate_id || null,
          converted_client_id: source.converted_client_id || null,
          converted_job_id: source.converted_job_id || null
        }
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
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const ownedRequest = await getOwnedRequest(requestId, req.customer.client_id);
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
      `,
      [requestId]
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

    const requestRow = await getOwnedRequest(requestId, req.customer.client_id);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found" });
    }

    return res.json(requestRow);
  } catch (err) {
    return sendSafeServerError(res, err, "MARKETPLACE REQUEST DETAIL ERROR");
  }
});

module.exports = router;

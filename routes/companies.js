const express = require("express");
const pool = require("../db/pool");
const auth = require("../middleware/auth");
const { requireMinimumRole, requirePlatformOwner } = auth;
const { sendSafeServerError } = require("../services/safeServerError");
const { sendOperationalEmailSafe } = require("../services/emailService");

const router = express.Router();

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
    ranking_score: Number(row.ranking_score || 0),
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

router.get("/companies/public", async (req, res) => {
  try {
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
        ranking_score
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
          )::numeric(10,4) AS ranking_score
        FROM companies c
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
      ORDER BY ranking_score DESC, name ASC, id ASC
      `
    );

    const items = await Promise.all(result.rows.map(shapePublicCompany));
    res.json(items);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANIES PUBLIC LIST ERROR");
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
        phone,
        email,
        address
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

    const payload = await shapePublicCompany(result.rows[0]);
    res.json(payload);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY PUBLIC DETAIL ERROR");
  }
});

router.put("/companies/public-profile", auth, requireMinimumRole("admin"), async (req, res) => {
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

router.put("/companies/services", auth, requireMinimumRole("admin"), async (req, res) => {
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

router.get("/companies/:id/service-areas", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!companyId) {
      return res.status(400).json({ error: "Invalid company id" });
    }

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
      ORDER BY id ASC
      `,
      [companyId]
    );

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY SERVICE AREAS LIST ERROR");
  }
});

router.put("/companies/service-areas", auth, requireMinimumRole("admin"), async (req, res) => {
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
      ORDER BY day_of_week ASC
      `,
      [companyId]
    );

    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "COMPANY AVAILABILITY LIST ERROR");
  }
});

router.put("/companies/availability", auth, requireMinimumRole("admin"), async (req, res) => {
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

module.exports = router;

/**
 * Phase 4 referral engine — codes, tracking, eligibility (no automated payouts).
 */
const crypto = require("crypto");
const pool = require("../db/pool");
const activityLogService = require("./activityLogService");

const OWNER_TYPES = new Set(["company", "customer", "user"]);
const REFERRED_TYPES = new Set(["company", "customer"]);
const REFERRAL_STATUSES = new Set(["pending", "qualified", "rejected", "rewarded"]);

const JOURNEY_STATUSES = new Set([
  "pending",
  "visited",
  "lead_created",
  "request_created",
  "converted",
  "expired",
  "cancelled"
]);

function normalizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function generateReferralCode(prefix = "FLX", ownerType = "x", ownerId = 0) {
  const safePrefix = String(prefix || "FLX")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8) || "FLX";
  const ot = String(ownerType || "x")[0] || "x";
  const noise = crypto.randomBytes(12).toString("base64url").replace(/=/g, "").slice(0, 14);
  const idHint = crypto.createHash("sha256").update(`${ownerType}:${ownerId}`).digest("hex").slice(0, 4);
  return `${safePrefix}-${ot}-${noise}${idHint}`.toUpperCase();
}

async function ensureUniqueCode(candidate, attempts = 12) {
  let code = candidate;
  for (let i = 0; i < attempts; i += 1) {
    const check = await pool.query(
      `SELECT 1 FROM referral_codes WHERE UPPER(code) = UPPER($1) LIMIT 1`,
      [code]
    );
    if (!check.rows.length) {
      return code;
    }
    code = generateReferralCode("FLX", "r", Date.now() + i);
  }
  throw new Error("Unable to allocate unique referral code");
}

function normalizeScopeCompanyId(scopeCompanyId) {
  if (scopeCompanyId == null || scopeCompanyId === "") {
    return null;
  }
  const n = Number(scopeCompanyId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveLogCompanyIdFromCodeRow(rc) {
  if (!rc) {
    return null;
  }
  if (rc.owner_type === "company" && rc.owner_company_id != null) {
    return Number(rc.owner_company_id);
  }
  if (rc.owner_type === "customer" && rc.scope_company_id != null) {
    return Number(rc.scope_company_id);
  }
  return null;
}

async function selectExistingReferralCode(client, { ot, oc, oca, ou, scopeCompanyId }) {
  if (ot === "customer") {
    const scope = normalizeScopeCompanyId(scopeCompanyId);
    const result = await client.query(
      `
      SELECT *
      FROM referral_codes
      WHERE status = 'active'
        AND owner_type = 'customer'
        AND owner_customer_account_id = $1
        AND COALESCE(scope_company_id, 0) = COALESCE($2::int, 0)
      LIMIT 1
      `,
      [oca, scope]
    );
    return result.rows[0] || null;
  }

  const result = await client.query(
    `
    SELECT *
    FROM referral_codes
    WHERE status = 'active'
      AND owner_type = $1
      AND (
        ($2::int IS NOT NULL AND owner_company_id = $2)
        OR ($3::int IS NOT NULL AND owner_customer_account_id = $3)
        OR ($4::int IS NOT NULL AND owner_user_id = $4)
      )
    LIMIT 1
    `,
    [ot, oc, oca, ou]
  );
  return result.rows[0] || null;
}

async function getOrCreateReferralCode({
  ownerType,
  ownerId,
  companyId = null,
  customerAccountId = null,
  userId = null,
  scopeCompanyId = null,
  prefix = "FLX"
}) {
  const ot = String(ownerType || "").trim().toLowerCase();
  if (!OWNER_TYPES.has(ot)) {
    throw new Error("Invalid owner type");
  }

  const cid =
    companyId != null && Number.isInteger(Number(companyId)) ? Number(companyId) : null;
  const caid =
    customerAccountId != null && Number.isInteger(Number(customerAccountId))
      ? Number(customerAccountId)
      : null;
  const uid =
    userId != null && Number.isInteger(Number(userId)) ? Number(userId) : null;

  const scope = normalizeScopeCompanyId(scopeCompanyId);

  const existingOuter = await selectExistingReferralCode(pool, {
    ot,
    oc: cid,
    oca: caid,
    ou: uid,
    scopeCompanyId: ot === "customer" ? scope : null
  });
  if (existingOuter) {
    return existingOuter;
  }

  let oc = cid;
  let oca = caid;
  let ou = uid;
  if (ot === "company") {
    if (!oc || oc <= 0) throw new Error("companyId required");
    oca = null;
    ou = null;
  } else if (ot === "customer") {
    if (!oca || oca <= 0) throw new Error("customerAccountId required");
    oc = null;
    ou = null;
  } else if (ot === "user") {
    if (!ou || ou <= 0) throw new Error("userId required");
    oc = null;
    oca = null;
  }

  const raw = generateReferralCode(prefix, ot, ownerId || oc || oca || ou || 0);
  const code = await ensureUniqueCode(raw);

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const existingTxn = await selectExistingReferralCode(dbClient, {
      ot,
      oc,
      oca,
      ou,
      scopeCompanyId: ot === "customer" ? scope : null
    });
    if (existingTxn) {
      await dbClient.query("COMMIT");
      return existingTxn;
    }

    const scopeInsert = ot === "customer" ? scope : null;

    let row;
    try {
      const ins = await dbClient.query(
        `
        INSERT INTO referral_codes (
          code,
          owner_type,
          owner_company_id,
          owner_customer_account_id,
          owner_user_id,
          scope_company_id,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
        `,
        [code, ot, oc, oca, ou, scopeInsert]
      );
      row = ins.rows[0];
    } catch (insertErr) {
      if (insertErr && insertErr.code === "23505") {
        const again = await selectExistingReferralCode(dbClient, {
          ot,
          oc,
          oca,
          ou,
          scopeCompanyId: ot === "customer" ? scope : null
        });
        row = again;
      } else {
        throw insertErr;
      }
    }

    if (!row) {
      await dbClient.query("ROLLBACK");
      throw new Error("Referral code creation failed");
    }

    await insertReferralEvent(dbClient, null, row.id, "code_created", {
      owner_type: ot,
      scope_company_id: scopeInsert
    });

    await dbClient.query("COMMIT");

    const logCompanyId = resolveLogCompanyIdFromCodeRow(row);
    await activityLogService.logActivity({
      companyId: logCompanyId,
      userId: ou || null,
      action: "referral_code_created",
      entityType: "referral_code",
      entityId: row.id,
      details: {
        owner_type: ot,
        owner_company_id: oc,
        owner_customer_account_id: oca,
        owner_user_id: ou,
        scope_company_id: scopeInsert
      }
    });

    return row;
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    dbClient.release();
  }
}

async function getOrCreateCustomerReferralCode(customerAccountId, companyId) {
  const aid = Number(customerAccountId);
  const cid = Number(companyId);
  if (!Number.isInteger(aid) || aid <= 0) {
    throw new Error("Invalid customer account id");
  }
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error("Invalid company id");
  }
  return getOrCreateReferralCode({
    ownerType: "customer",
    ownerId: aid,
    customerAccountId: aid,
    scopeCompanyId: cid,
    prefix: "FLX"
  });
}

async function insertReferralEvent(clientOrPool, referralId, codeId, eventType, metadata) {
  const exec = clientOrPool && clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : pool.query.bind(pool);
  await exec(
    `
    INSERT INTO referral_events (referral_id, code_id, event_type, metadata)
    VALUES ($1, $2, $3, $4::jsonb)
    `,
    [referralId, codeId, eventType, JSON.stringify(metadata || {})]
  );
}

async function recordReferralVisit({ code, source = "", metadata = {} }) {
  const normalized = normalizeCode(code);
  if (!normalized) {
    return { ok: false, reason: "empty_code" };
  }
  let rcRow;
  try {
    const row = await pool.query(
      `
      SELECT id, owner_type, status, owner_company_id, scope_company_id
      FROM referral_codes
      WHERE UPPER(code) = UPPER($1)
      LIMIT 1
      `,
      [normalized]
    );
    rcRow = row.rows[0];
  } catch (err) {
    if (err && err.code === "42703") {
      const row = await pool.query(
        `
        SELECT id, owner_type, status, owner_company_id
        FROM referral_codes
        WHERE UPPER(code) = UPPER($1)
        LIMIT 1
        `,
        [normalized]
      );
      rcRow = row.rows[0];
    } else {
      throw err;
    }
  }
  const rc = rcRow;
  if (!rc || rc.status !== "active") {
    return { ok: false, reason: "invalid_or_inactive" };
  }
  await insertReferralEvent(pool, null, rc.id, "visit", {
    source: String(source || "").slice(0, 200),
    ...metadata
  });

  const logCompanyId = resolveLogCompanyIdFromCodeRow(rc);
  await activityLogService.logActivity({
    companyId: logCompanyId,
    userId: null,
    action: "referral_visit_tracked",
    entityType: "referral_code",
    entityId: rc.id,
    details: {
      source: String(source || "").slice(0, 120)
    }
  });

  return { ok: true, code_id: rc.id, owner_type: rc.owner_type };
}

async function trackReferralVisit(referralCode, metadata = {}) {
  const safeCode = referralCode != null ? String(referralCode) : "";
  const result = await recordReferralVisit({
    code: safeCode,
    source: metadata.source || metadata.page || "",
    metadata
  });
  return { ok: result.ok, reason: result.reason };
}

function validateCodeMatchesTenantCompany(rc, companyId) {
  const cid = Number(companyId);
  if (!rc || !Number.isInteger(cid) || cid <= 0) {
    return false;
  }
  if (rc.owner_type === "company") {
    return Number(rc.owner_company_id) === cid;
  }
  if (rc.owner_type === "customer") {
    if (rc.scope_company_id != null) {
      return Number(rc.scope_company_id) === cid;
    }
    return true;
  }
  return false;
}

async function trackReferralLead(referralCode, leadId, metadata = {}) {
  const normalized = normalizeCode(referralCode);
  const eid = Number(leadId);
  if (!normalized || !Number.isInteger(eid) || eid <= 0) {
    return { ok: false, reason: "invalid_payload" };
  }

  const rcResult = await pool.query(
    `
    SELECT *
    FROM referral_codes
    WHERE UPPER(code) = UPPER($1) AND status = 'active'
    LIMIT 1
    `,
    [normalized]
  );
  const rc = rcResult.rows[0];
  if (!rc) {
    return { ok: false, reason: "invalid_code" };
  }

  const est = await pool.query(
    `
    SELECT id, company_id, client_id
    FROM estimates
    WHERE id = $1
    LIMIT 1
    `,
    [eid]
  );
  if (!est.rows.length) {
    return { ok: false, reason: "lead_not_found" };
  }
  const companyId = Number(est.rows[0].company_id);
  if (!validateCodeMatchesTenantCompany(rc, companyId)) {
    return { ok: false, reason: "company_mismatch" };
  }

  await insertReferralEvent(pool, null, rc.id, "lead_created", {
    estimate_id: eid,
    ...metadata
  });

  await activityLogService.logActivity({
    companyId,
    userId: null,
    action: "referral_lead_tracked",
    entityType: "referral_code",
    entityId: rc.id,
    details: { estimate_id: eid }
  });

  return { ok: true };
}

async function trackReferralMarketplaceRequest(referralCode, marketplaceRequestId, metadata = {}) {
  const normalized = normalizeCode(referralCode);
  const rid = Number(marketplaceRequestId);
  if (!normalized || !Number.isInteger(rid) || rid <= 0) {
    return { ok: false, reason: "invalid_payload" };
  }

  const rcResult = await pool.query(
    `
    SELECT *
    FROM referral_codes
    WHERE UPPER(code) = UPPER($1) AND status = 'active'
    LIMIT 1
    `,
    [normalized]
  );
  const rc = rcResult.rows[0];
  if (!rc) {
    return { ok: false, reason: "invalid_code" };
  }

  const mr = await pool.query(
    `
    SELECT mr.id, c.company_id
    FROM marketplace_requests mr
    INNER JOIN clients c ON c.id = mr.client_id
    WHERE mr.id = $1
    LIMIT 1
    `,
    [rid]
  );
  if (!mr.rows.length) {
    return { ok: false, reason: "request_not_found" };
  }
  const companyId = Number(mr.rows[0].company_id);
  if (!validateCodeMatchesTenantCompany(rc, companyId)) {
    return { ok: false, reason: "company_mismatch" };
  }

  await insertReferralEvent(pool, null, rc.id, "request_created", {
    marketplace_request_id: rid,
    ...metadata
  });

  await activityLogService.logActivity({
    companyId,
    userId: null,
    action: "referral_request_tracked",
    entityType: "referral_code",
    entityId: rc.id,
    details: { marketplace_request_id: rid }
  });

  return { ok: true };
}

async function markReferralConverted(referralCode, clientId, sourceType, sourceId) {
  const normalized = normalizeCode(referralCode);
  const cid = Number(clientId);
  const st = String(sourceType || "").trim().slice(0, 64);
  const sid =
    sourceId != null && Number.isInteger(Number(sourceId)) ? Number(sourceId) : null;
  if (!normalized || !Number.isInteger(cid) || cid <= 0 || !st) {
    return { ok: false, reason: "invalid_payload" };
  }

  const rcResult = await pool.query(
    `
    SELECT *
    FROM referral_codes
    WHERE UPPER(code) = UPPER($1) AND status = 'active'
    LIMIT 1
    `,
    [normalized]
  );
  const rc = rcResult.rows[0];
  if (!rc) {
    return { ok: false, reason: "invalid_code" };
  }

  const clientRow = await pool.query(
    `SELECT id, company_id FROM clients WHERE id = $1 LIMIT 1`,
    [cid]
  );
  if (!clientRow.rows.length) {
    return { ok: false, reason: "client_not_found" };
  }
  const companyId = Number(clientRow.rows[0].company_id);
  if (!validateCodeMatchesTenantCompany(rc, companyId)) {
    return { ok: false, reason: "company_mismatch" };
  }

  const accountLookup = await pool.query(
    `SELECT id FROM customer_accounts WHERE client_id = $1 LIMIT 1`,
    [cid]
  );
  const referredAccountId = accountLookup.rows[0] ? Number(accountLookup.rows[0].id) : null;

  let referralId = null;
  if (referredAccountId) {
    const rFound = await pool.query(
      `
      SELECT id FROM referrals
      WHERE code_id = $1 AND referred_type = 'customer'
        AND referred_customer_account_id = $2
      LIMIT 1
      `,
      [rc.id, referredAccountId]
    );
    referralId = rFound.rows[0] ? Number(rFound.rows[0].id) : null;
  }

  if (!referredAccountId) {
    return { ok: false, reason: "customer_account_not_linked" };
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    if (!referralId && referredAccountId) {
      const dup = await dbClient.query(
        `
        SELECT id FROM referrals
        WHERE code_id = $1 AND referred_type = 'customer'
          AND referred_customer_account_id = $2
        LIMIT 1
        `,
        [rc.id, referredAccountId]
      );
      if (dup.rows.length) {
        referralId = Number(dup.rows[0].id);
      } else {
        const ins = await dbClient.query(
          `
          INSERT INTO referrals (
            code_id,
            referred_type,
            referred_customer_account_id,
            status,
            journey_status,
            metadata,
            created_at,
            updated_at
          )
          VALUES ($1, 'customer', $2, 'pending', 'converted', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING id
          `,
          [rc.id, referredAccountId]
        );
        referralId = ins.rows[0] ? Number(ins.rows[0].id) : null;
      }
    }

    if (referralId) {
      await dbClient.query(
        `
        UPDATE referrals
        SET journey_status = 'converted',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [referralId]
      );

      await dbClient.query(
        `
        INSERT INTO referral_conversions (referral_id, client_id, source_type, source_id, metadata)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        `,
        [
          referralId,
          cid,
          st,
          sid,
          JSON.stringify({ referral_code: normalized })
        ]
      );

      await insertReferralEvent(dbClient, referralId, rc.id, "converted", {
        client_id: cid,
        source_type: st,
        source_id: sid
      });
    }

    await dbClient.query("COMMIT");
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    dbClient.release();
  }

  await activityLogService.logActivity({
    companyId,
    userId: null,
    action: "referral_converted",
    entityType: "referral_code",
    entityId: rc.id,
    details: {
      client_id: cid,
      source_type: st,
      source_id: sid,
      referral_id: referralId
    }
  });

  return { ok: true, referral_id: referralId };
}

async function getCompanyReferralLeaderboard(companyId, { limit = 10 } = {}) {
  const cid = Number(companyId);
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 100);
  if (!Number.isInteger(cid) || cid <= 0) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT
      rc.id AS referral_code_id,
      rc.owner_type,
      rc.owner_customer_account_id AS customer_account_id,
      COUNT(conv.id)::int AS conversions
    FROM referral_codes rc
    INNER JOIN referrals r ON r.code_id = rc.id
    INNER JOIN referral_conversions conv ON conv.referral_id = r.id
    WHERE rc.owner_company_id = $1 OR rc.scope_company_id = $1
    GROUP BY rc.id, rc.owner_type, rc.owner_customer_account_id
    ORDER BY conversions DESC, rc.id ASC
    LIMIT $2
    `,
    [cid, lim]
  );

  return result.rows.map((row) => ({
    referral_code_id: Number(row.referral_code_id),
    owner_type: row.owner_type || "",
    customer_account_id:
      row.customer_account_id != null ? Number(row.customer_account_id) : null,
    conversions: Number(row.conversions || 0)
  }));
}

async function listCompanyReferralEvents(companyId, { limit = 50, offset = 0 } = {}) {
  const cid = Number(companyId);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  if (!Number.isInteger(cid) || cid <= 0) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT
      re.id,
      re.referral_id,
      re.code_id,
      re.event_type,
      re.metadata,
      re.created_at
    FROM referral_events re
    INNER JOIN referral_codes rc ON rc.id = re.code_id
    WHERE rc.owner_company_id = $1
       OR rc.scope_company_id = $1
    ORDER BY re.created_at DESC, re.id DESC
    LIMIT $2 OFFSET $3
    `,
    [cid, lim, off]
  );
  return result.rows;
}

async function createReferralSignup({
  code: rawCode,
  referredType,
  referredCompanyId = null,
  referredCustomerAccountId = null,
  metadata = {}
}) {
  const normalized = normalizeCode(rawCode);
  if (!normalized) {
    return { ok: false, reason: "empty_code" };
  }
  const rt = String(referredType || "").trim().toLowerCase();
  if (!REFERRED_TYPES.has(rt)) {
    return { ok: false, reason: "invalid_referred_type" };
  }

  const rcResult = await pool.query(
    `
    SELECT *
    FROM referral_codes
    WHERE UPPER(code) = UPPER($1) AND status = 'active'
    LIMIT 1
    `,
    [normalized]
  );
  const rc = rcResult.rows[0];
  if (!rc) {
    return { ok: false, reason: "invalid_code" };
  }

  let referredCompany = null;
  let referredCustomer = null;
  if (rt === "company") {
    referredCompany =
      referredCompanyId != null && Number.isInteger(Number(referredCompanyId))
        ? Number(referredCompanyId)
        : null;
    if (!referredCompany || referredCompany <= 0) {
      return { ok: false, reason: "missing_referred_company" };
    }
    if (
      rc.owner_type === "company" &&
      rc.owner_company_id != null &&
      Number(rc.owner_company_id) === referredCompany
    ) {
      return { ok: false, reason: "self_referral" };
    }
  } else {
    referredCustomer =
      referredCustomerAccountId != null && Number.isInteger(Number(referredCustomerAccountId))
        ? Number(referredCustomerAccountId)
        : null;
    if (!referredCustomer || referredCustomer <= 0) {
      return { ok: false, reason: "missing_referred_customer" };
    }
    if (
      rc.owner_type === "customer" &&
      rc.owner_customer_account_id != null &&
      Number(rc.owner_customer_account_id) === referredCustomer
    ) {
      return { ok: false, reason: "self_referral" };
    }
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const ins = await dbClient.query(
      `
      INSERT INTO referrals (
        code_id,
        referred_type,
        referred_company_id,
        referred_customer_account_id,
        status,
        metadata,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING
      RETURNING id
      `,
      [
        rc.id,
        rt,
        rt === "company" ? referredCompany : null,
        rt === "customer" ? referredCustomer : null,
        JSON.stringify(metadata || {})
      ]
    );

    let referralId = ins.rows[0] && ins.rows[0].id;
    if (!referralId) {
      const dup = await dbClient.query(
        `
        SELECT id FROM referrals
        WHERE code_id = $1
          AND referred_type = $2
          AND (
            ($3::int IS NOT NULL AND referred_company_id = $3)
            OR ($4::int IS NOT NULL AND referred_customer_account_id = $4)
          )
        LIMIT 1
        `,
        [
          rc.id,
          rt,
          rt === "company" ? referredCompany : null,
          rt === "customer" ? referredCustomer : null
        ]
      );
      referralId = dup.rows[0] && dup.rows[0].id;
      await dbClient.query("COMMIT");
      return {
        ok: true,
        duplicate: true,
        referral_id: referralId,
        code_id: rc.id
      };
    }

    await insertReferralEvent(dbClient, referralId, rc.id, "signup_recorded", {
      referred_type: rt,
      referred_company_id: referredCompany,
      referred_customer_account_id: referredCustomer
    });

    await dbClient.query("COMMIT");

    const logCompanyId =
      rt === "company"
        ? referredCompany
        : rc.owner_company_id != null
          ? Number(rc.owner_company_id)
          : null;

    await activityLogService.logActivity({
      companyId: logCompanyId,
      userId: null,
      action: "referral_signup_recorded",
      entityType: "referral",
      entityId: referralId,
      details: {
        code_id: rc.id,
        referred_type: rt,
        referred_company_id: referredCompany,
        referred_customer_account_id: referredCustomer
      }
    });

    return {
      ok: true,
      duplicate: false,
      referral_id: referralId,
      code_id: rc.id
    };
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    if (err && err.code === "23505") {
      return { ok: true, duplicate: true, reason: "duplicate" };
    }
    throw err;
  } finally {
    dbClient.release();
  }
}

async function markReferralQualified({
  referralId,
  qualificationEvent,
  metadata = {},
  actorUserId = null
}) {
  const rid = Number(referralId);
  if (!Number.isInteger(rid) || rid <= 0) {
    throw new Error("Invalid referral id");
  }
  const ev = String(qualificationEvent || "").trim().slice(0, 120);
  if (!ev) {
    throw new Error("qualificationEvent required");
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const upd = await dbClient.query(
      `
      UPDATE referrals
      SET
        status = 'qualified',
        qualification_event = $2,
        qualified_at = CURRENT_TIMESTAMP,
        metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('pending', 'qualified')
      RETURNING id, code_id, referred_type, referred_company_id, referred_customer_account_id
      `,
      [rid, ev, JSON.stringify(metadata || {})]
    );
    if (!upd.rows.length) {
      await dbClient.query("ROLLBACK");
      throw new Error("Referral not found or not eligible");
    }
    const row = upd.rows[0];
    await insertReferralEvent(dbClient, rid, row.code_id, "qualified", {
      qualification_event: ev
    });
    await dbClient.query("COMMIT");

    await activityLogService.logActivity({
      companyId: row.referred_company_id || null,
      userId: actorUserId || null,
      action: "referral_qualified",
      entityType: "referral",
      entityId: rid,
      details: {
        qualification_event: ev,
        referred_type: row.referred_type
      }
    });

    return { ok: true, referral_id: rid };
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    dbClient.release();
  }
}

async function countSummaryForCodes(whereClause, params) {
  const r = await pool.query(
    `
    SELECT status, COUNT(*)::int AS n
    FROM referrals
    WHERE ${whereClause}
    GROUP BY status
    `,
    params
  );
  const byStatus = {};
  let total = 0;
  for (const row of r.rows) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return { total, by_status: byStatus };
}

async function getCompanyReferralSummary(companyId) {
  const cid = Number(companyId);
  if (!Number.isInteger(cid) || cid <= 0) return null;

  const codes = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM referral_codes
    WHERE owner_type = 'company' AND owner_company_id = $1 AND status = 'active'
    `,
    [cid]
  );

  const referrals = await countSummaryForCodes(
    "code_id IN (SELECT id FROM referral_codes WHERE owner_type = 'company' AND owner_company_id = $1)",
    [cid]
  );

  return {
    company_id: cid,
    active_codes: codes.rows[0] ? codes.rows[0].n : 0,
    referrals: referrals
  };
}

async function getCustomerReferralSummary(customerAccountId) {
  const aid = Number(customerAccountId);
  if (!Number.isInteger(aid) || aid <= 0) return null;

  const codes = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM referral_codes
    WHERE owner_type = 'customer' AND owner_customer_account_id = $1 AND status = 'active'
    `,
    [aid]
  );

  const referrals = await countSummaryForCodes(
    "code_id IN (SELECT id FROM referral_codes WHERE owner_type = 'customer' AND owner_customer_account_id = $1)",
    [aid]
  );

  let conversion_count = 0;
  try {
    const conv = await pool.query(
      `
      SELECT COUNT(*)::int AS n
      FROM referral_conversions conv
      INNER JOIN referrals r ON r.id = conv.referral_id
      INNER JOIN referral_codes rc ON rc.id = r.code_id
      WHERE rc.owner_type = 'customer' AND rc.owner_customer_account_id = $1
      `,
      [aid]
    );
    conversion_count = conv.rows[0] ? Number(conv.rows[0].n) : 0;
  } catch (err) {
    if (!err || err.code !== "42P01") {
      throw err;
    }
  }

  return {
    customer_account_id: aid,
    active_codes: codes.rows[0] ? codes.rows[0].n : 0,
    referrals: referrals,
    conversion_count
  };
}

async function getPlatformReferralSummary() {
  const codes = await pool.query(`SELECT COUNT(*)::int AS n FROM referral_codes`);
  const referrals = await pool.query(
    `
    SELECT status, COUNT(*)::int AS n
    FROM referrals
    GROUP BY status
    `
  );
  const events = await pool.query(`SELECT COUNT(*)::int AS n FROM referral_events`);

  const byStatus = {};
  let refTotal = 0;
  for (const row of referrals.rows) {
    byStatus[row.status] = row.n;
    refTotal += row.n;
  }

  return {
    referral_codes_total: codes.rows[0] ? codes.rows[0].n : 0,
    referrals_total: refTotal,
    referrals_by_status: byStatus,
    referral_events_total: events.rows[0] ? events.rows[0].n : 0,
    generated_at: new Date().toISOString()
  };
}

async function listCompanyReferrals(companyId, { limit = 50, offset = 0 } = {}) {
  const cid = Number(companyId);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const result = await pool.query(
    `
    SELECT
      r.id,
      r.code_id,
      r.referred_type,
      r.referred_company_id,
      r.referred_customer_account_id,
      r.status,
      r.qualification_event,
      r.qualified_at,
      r.rewarded_at,
      r.metadata,
      r.created_at,
      r.updated_at,
      rc.code AS referral_code
    FROM referrals r
    INNER JOIN referral_codes rc ON rc.id = r.code_id
    WHERE rc.owner_type = 'company' AND rc.owner_company_id = $1
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT $2 OFFSET $3
    `,
    [cid, lim, off]
  );
  return result.rows;
}

async function listCustomerReferrals(customerAccountId, { limit = 50, offset = 0 } = {}) {
  const aid = Number(customerAccountId);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const result = await pool.query(
    `
    SELECT
      r.id,
      r.code_id,
      r.referred_type,
      r.referred_company_id,
      r.referred_customer_account_id,
      r.status,
      r.qualification_event,
      r.qualified_at,
      r.rewarded_at,
      r.metadata,
      r.created_at,
      r.updated_at,
      rc.code AS referral_code
    FROM referrals r
    INNER JOIN referral_codes rc ON rc.id = r.code_id
    WHERE rc.owner_type = 'customer' AND rc.owner_customer_account_id = $1
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT $2 OFFSET $3
    `,
    [aid, lim, off]
  );
  return result.rows;
}

async function listPlatformReferrals({ limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const result = await pool.query(
    `
    SELECT
      r.id,
      r.code_id,
      r.referred_type,
      r.referred_company_id,
      r.referred_customer_account_id,
      r.status,
      r.qualification_event,
      r.qualified_at,
      r.rewarded_at,
      r.metadata,
      r.created_at,
      r.updated_at,
      rc.code AS referral_code,
      rc.owner_type AS code_owner_type,
      rc.owner_company_id,
      rc.owner_customer_account_id
    FROM referrals r
    INNER JOIN referral_codes rc ON rc.id = r.code_id
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT $1 OFFSET $2
    `,
    [lim, off]
  );
  return result.rows;
}

async function updateReferralStatusByPlatform({
  referralId,
  status,
  qualificationEvent = null,
  rewardPayload = null,
  actorUserId = null
}) {
  const rid = Number(referralId);
  if (!Number.isInteger(rid) || rid <= 0) {
    throw new Error("Invalid referral id");
  }
  const st = String(status || "").trim().toLowerCase();
  if (!REFERRAL_STATUSES.has(st)) {
    throw new Error("Invalid status");
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const cur = await dbClient.query(
      `SELECT * FROM referrals WHERE id = $1 LIMIT 1`,
      [rid]
    );
    if (!cur.rows.length) {
      await dbClient.query("ROLLBACK");
      throw new Error("Referral not found");
    }

    const updates = [`status = $2`, `updated_at = CURRENT_TIMESTAMP`];
    const params = [rid, st];
    let p = 3;

    if (st === "qualified") {
      const ev =
        qualificationEvent != null && String(qualificationEvent).trim()
          ? String(qualificationEvent).trim().slice(0, 120)
          : "manual_qualified";
      updates.push(`qualification_event = $${p}`);
      params.push(ev);
      p += 1;
      updates.push(`qualified_at = CURRENT_TIMESTAMP`);
    } else if (st === "rewarded") {
      updates.push(`rewarded_at = CURRENT_TIMESTAMP`);
      if (qualificationEvent != null && String(qualificationEvent).trim()) {
        updates.push(`qualification_event = $${p}`);
        params.push(String(qualificationEvent).trim().slice(0, 120));
        p += 1;
      }
    } else if (st === "pending") {
      updates.push(`qualification_event = NULL`);
      updates.push(`qualified_at = NULL`);
      updates.push(`rewarded_at = NULL`);
    } else if (st === "rejected") {
      updates.push(`qualification_event = NULL`);
    }

    const setClause = updates.join(", ");

    const upd = await dbClient.query(
      `
      UPDATE referrals
      SET ${setClause}
      WHERE id = $1
      RETURNING *
      `,
      params
    );

    const row = upd.rows[0];
    await insertReferralEvent(dbClient, rid, row.code_id, `status_${st}`, {
      qualification_event: row.qualification_event,
      reward: rewardPayload || null
    });

    if (st === "rewarded" && rewardPayload && typeof rewardPayload === "object") {
      const rewardType = String(rewardPayload.reward_type || "eligibility").slice(0, 80);
      const rewardStatus = String(rewardPayload.reward_status || "pending").slice(0, 32);
      const amount =
        rewardPayload.reward_amount != null && rewardPayload.reward_amount !== ""
          ? Number(rewardPayload.reward_amount)
          : null;
      const unit = rewardPayload.reward_unit != null ? String(rewardPayload.reward_unit).slice(0, 32) : null;
      const notes = rewardPayload.notes != null ? String(rewardPayload.notes).slice(0, 2000) : null;

      await dbClient.query(
        `
        INSERT INTO referral_rewards (
          referral_id,
          reward_type,
          reward_status,
          reward_amount,
          reward_unit,
          notes,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        [rid, rewardType, rewardStatus, amount, unit, notes]
      );
    }

    await dbClient.query("COMMIT");

    if (st === "rewarded" && rewardPayload && typeof rewardPayload === "object") {
      const rewardType = String(rewardPayload.reward_type || "eligibility").slice(0, 80);
      const rewardStatus = String(rewardPayload.reward_status || "pending").slice(0, 32);
      await activityLogService.logActivity({
        companyId: row.referred_company_id || null,
        userId: actorUserId || null,
        action: "referral_reward_marked",
        entityType: "referral",
        entityId: rid,
        details: {
          reward_type: rewardType,
          reward_status: rewardStatus
        }
      });
    } else {
      await activityLogService.logActivity({
        companyId: row.referred_company_id || null,
        userId: actorUserId || null,
        action: st === "qualified" ? "referral_qualified" : "referral_status_updated",
        entityType: "referral",
        entityId: rid,
        details: {
          status: st,
          qualification_event: row.qualification_event || null
        }
      });
    }

    return row;
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    dbClient.release();
  }
}

module.exports = {
  generateReferralCode,
  getOrCreateReferralCode,
  getOrCreateCustomerReferralCode,
  recordReferralVisit,
  trackReferralVisit,
  trackReferralLead,
  trackReferralMarketplaceRequest,
  markReferralConverted,
  getCompanyReferralLeaderboard,
  listCompanyReferralEvents,
  createReferralSignup,
  markReferralQualified,
  getCompanyReferralSummary,
  getCustomerReferralSummary,
  getPlatformReferralSummary,
  listCompanyReferrals,
  listCustomerReferrals,
  listPlatformReferrals,
  updateReferralStatusByPlatform,
  normalizeCode,
  REFERRAL_STATUSES,
  JOURNEY_STATUSES
};

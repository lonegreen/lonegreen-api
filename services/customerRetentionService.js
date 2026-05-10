/**
 * Phase 3 customer retention — read models + rebook intent + saved addresses (company scoped).
 */
const pool = require("../db/pool");
const activityLogService = require("./activityLogService");
const growthFoundationService = require("./growthFoundationService");
const growthOsService = require("./growthOsService");
const trustReputationService = require("./trustReputationService");

const REBOOK_IDLE_DAYS = 45;
const REACTIVATION_IDLE_DAYS = 120;
const REMINDER_DAYS = 7;
const RENEWAL_WINDOW_DAYS = 14;

function assertCompanyId(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function round2(v) {
  const x = n(v);
  return Number(x.toFixed(2));
}

async function queryRows(sql, params, label) {
  try {
    const result = await pool.query(sql, params);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "customer_retention_table_missing",
        query: label,
        message: err.message
      }));
      return [];
    }
    throw err;
  }
}

async function queryOne(sql, params, label) {
  const rows = await queryRows(sql, params, label);
  return rows[0] || {};
}

async function getRebookCandidates(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const rows = await queryRows(
    `
    WITH jc AS (
      SELECT
        j.client_id,
        MAX(j.date) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed') AS last_completed_date,
        AVG(j.price::numeric) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed') AS avg_completed_price,
        MAX(j.service) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed') AS last_service
      FROM jobs j
      WHERE j.company_id = $1
        AND j.client_id IS NOT NULL
      GROUP BY j.client_id
    )
    SELECT
      c.id AS client_id,
      c.name AS client_name,
      jc.last_completed_date,
      jc.last_service AS suggested_service,
      ROUND(COALESCE(jc.avg_completed_price, 0)::numeric, 2) AS estimated_value_approx,
      DATE_PART('day', CURRENT_DATE - jc.last_completed_date::date)::int AS days_since_last_completed
    FROM clients c
    INNER JOIN jc ON jc.client_id = c.id
    WHERE c.company_id = $1
      AND COALESCE(c.archived, FALSE) = FALSE
      AND jc.last_completed_date IS NOT NULL
      AND jc.last_completed_date::date <= CURRENT_DATE - ($2::int * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1
        FROM jobs u
        WHERE u.company_id = c.company_id
          AND u.client_id = c.id
          AND u.date >= CURRENT_DATE
          AND LOWER(TRIM(u.status)) NOT IN (
            'cancelled', 'completed', 'skipped', 'no_show', 'rejected'
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM subscriptions s
        WHERE s.company_id = c.company_id
          AND s.client_id = c.id
          AND LOWER(TRIM(s.status)) = 'active'
      )
    ORDER BY jc.last_completed_date ASC, c.name ASC
    LIMIT 200
    `,
    [cid, REBOOK_IDLE_DAYS],
    "cr_rebook"
  );

  return {
    idle_days_threshold: REBOOK_IDLE_DAYS,
    candidates: rows.map((r) => ({
      client_id: r.client_id,
      client_name: r.client_name || "",
      last_completed_job_date: r.last_completed_date,
      last_service: r.last_service || "",
      suggested_service: r.last_service || "",
      estimated_value_approx: round2(r.estimated_value_approx),
      days_since_last_completed: n(r.days_since_last_completed)
    }))
  };
}

async function getReactivationCandidates(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const rows = await queryRows(
    `
    WITH payers AS (
      SELECT DISTINCT i.client_id
      FROM invoices i
      INNER JOIN payments p ON p.invoice_id = i.id AND p.company_id = i.company_id
      WHERE i.company_id = $1 AND i.client_id IS NOT NULL
    ),
    last_job AS (
      SELECT client_id, MAX(date) AS last_any_job_date
      FROM jobs
      WHERE company_id = $1 AND client_id IS NOT NULL
      GROUP BY client_id
    ),
    last_pay AS (
      SELECT i.client_id, MAX(p.date) AS last_payment_date
      FROM payments p
      INNER JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
      WHERE p.company_id = $1 AND i.client_id IS NOT NULL
      GROUP BY i.client_id
    )
    SELECT
      c.id AS client_id,
      c.name AS client_name,
      COALESCE(c.archived, FALSE) AS archived,
      CASE
        WHEN COALESCE(c.archived, FALSE)
          AND EXISTS (SELECT 1 FROM payers x WHERE x.client_id = c.id)
          THEN 'archived_with_payment_history'
        WHEN EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.company_id = c.company_id AND s.client_id = c.id
            AND LOWER(TRIM(s.status)) = 'cancelled'
        )
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s2
          WHERE s2.company_id = c.company_id AND s2.client_id = c.id
            AND LOWER(TRIM(s2.status)) = 'active'
        )
          THEN 'cancelled_subscription_no_active'
        WHEN lj.last_any_job_date IS NOT NULL
          AND lj.last_any_job_date <= CURRENT_DATE - ($2::int * INTERVAL '1 day')
          AND EXISTS (SELECT 1 FROM payers x WHERE x.client_id = c.id)
          THEN 'dormant_with_payment_history'
        ELSE 'other'
      END AS reactivation_reason,
      lj.last_any_job_date,
      lp.last_payment_date
    FROM clients c
    LEFT JOIN last_job lj ON lj.client_id = c.id
    LEFT JOIN last_pay lp ON lp.client_id = c.id
    WHERE c.company_id = $1
      AND (
        (COALESCE(c.archived, FALSE) AND EXISTS (SELECT 1 FROM payers x WHERE x.client_id = c.id))
        OR (
          EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.company_id = c.company_id AND s.client_id = c.id
              AND LOWER(TRIM(s.status)) = 'cancelled'
          )
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s2
            WHERE s2.company_id = c.company_id AND s2.client_id = c.id
              AND LOWER(TRIM(s2.status)) = 'active'
          )
        )
        OR (
          lj.last_any_job_date IS NOT NULL
          AND lj.last_any_job_date <= CURRENT_DATE - ($2::int * INTERVAL '1 day')
          AND EXISTS (SELECT 1 FROM payers x WHERE x.client_id = c.id)
        )
      )
    ORDER BY COALESCE(lp.last_payment_date, lj.last_any_job_date) ASC NULLS LAST, c.name ASC
    LIMIT 200
    `,
    [cid, REACTIVATION_IDLE_DAYS],
    "cr_reactivation"
  );

  return {
    idle_days_threshold: REACTIVATION_IDLE_DAYS,
    candidates: rows
      .filter((r) => r.reactivation_reason && r.reactivation_reason !== "other")
      .map((r) => ({
        client_id: r.client_id,
        client_name: r.client_name || "",
        archived: r.archived === true,
        reactivation_reason: r.reactivation_reason,
        last_job_date: r.last_any_job_date || null,
        last_payment_date: r.last_payment_date || null
      }))
  };
}

async function getSubscriptionRenewalCandidates(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const rows = await queryRows(
    `
    SELECT
      s.id AS subscription_id,
      s.client_id,
      c.name AS client_name,
      s.service,
      s.status,
      s.frequency,
      s.price,
      s.next_date,
      s.next_billing_date,
      COALESCE(s.next_billing_date, s.next_date)::date AS renewal_anchor_date,
      CASE
        WHEN LOWER(TRIM(s.status)) = 'active'
          AND COALESCE(s.next_billing_date, s.next_date)::date <= CURRENT_DATE + ($2::int * INTERVAL '1 day')
          THEN 'renewal_window'
        WHEN LOWER(TRIM(s.status)) = 'paused' THEN 'paused_follow_up'
        WHEN LOWER(TRIM(s.status)) = 'cancelled' THEN 'cancelled_review'
        ELSE 'watch'
      END AS renewal_bucket
    FROM subscriptions s
    INNER JOIN clients c
      ON c.id = s.client_id AND c.company_id = s.company_id
    WHERE s.company_id = $1
      AND (
        (
          LOWER(TRIM(s.status)) = 'active'
          AND COALESCE(s.next_billing_date, s.next_date)::date <= CURRENT_DATE + ($2::int * INTERVAL '1 day')
        )
        OR LOWER(TRIM(s.status)) = 'paused'
        OR LOWER(TRIM(s.status)) = 'cancelled'
      )
    ORDER BY renewal_anchor_date ASC NULLS LAST, s.id ASC
    LIMIT 150
    `,
    [cid, RENEWAL_WINDOW_DAYS],
    "cr_sub_renewal"
  );

  return {
    renewal_window_days: RENEWAL_WINDOW_DAYS,
    candidates: rows.map((r) => ({
      subscription_id: r.subscription_id,
      client_id: r.client_id,
      client_name: r.client_name || "",
      service: r.service || "",
      status: r.status || "",
      frequency: r.frequency || "",
      price: round2(r.price),
      next_date: r.next_date || null,
      next_billing_date: r.next_billing_date || null,
      renewal_anchor_date: r.renewal_anchor_date || null,
      renewal_bucket: r.renewal_bucket || ""
    }))
  };
}

async function getReminderCandidates(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const invoiceRows = await queryRows(
    `
    SELECT
      i.client_id,
      c.name AS client_name,
      i.id AS invoice_id,
      i.invoice_number,
      i.amount,
      i.due_date,
      i.status,
      GREATEST(i.amount::numeric - COALESCE((
        SELECT SUM(p.amount)::numeric FROM payments p
        WHERE p.invoice_id = i.id AND p.company_id = i.company_id
      ), 0), 0)::numeric AS balance_due
    FROM invoices i
    INNER JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
    WHERE i.company_id = $1
      AND i.client_id IS NOT NULL
      AND LOWER(TRIM(i.status)) IN ('unpaid', 'overdue', 'draft')
      AND i.due_date IS NOT NULL
      AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2::int * INTERVAL '1 day')
    ORDER BY i.due_date ASC, i.id ASC
    LIMIT 100
    `,
    [cid, REMINDER_DAYS],
    "cr_rem_inv"
  );

  const subRows = await queryRows(
    `
    SELECT
      s.id AS subscription_id,
      s.client_id,
      c.name AS client_name,
      s.service,
      COALESCE(s.next_billing_date, s.next_date)::date AS billing_date,
      s.price,
      s.status
    FROM subscriptions s
    INNER JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
    WHERE s.company_id = $1
      AND LOWER(TRIM(s.status)) = 'active'
      AND COALESCE(s.next_billing_date, s.next_date)::date BETWEEN CURRENT_DATE
        AND CURRENT_DATE + ($2::int * INTERVAL '1 day')
    ORDER BY billing_date ASC, s.id ASC
    LIMIT 100
    `,
    [cid, REMINDER_DAYS],
    "cr_rem_sub"
  );

  return {
    reminder_window_days: REMINDER_DAYS,
    invoice_due_reminders: invoiceRows.map((r) => ({
      client_id: r.client_id,
      client_name: r.client_name || "",
      invoice_id: r.invoice_id,
      invoice_number: r.invoice_number || "",
      amount: round2(r.amount),
      balance_due: round2(r.balance_due),
      due_date: r.due_date,
      status: r.status || ""
    })),
    subscription_billing_reminders: subRows.map((r) => ({
      subscription_id: r.subscription_id,
      client_id: r.client_id,
      client_name: r.client_name || "",
      service: r.service || "",
      billing_date: r.billing_date,
      price: round2(r.price),
      status: r.status || ""
    }))
  };
}

async function getSavedAddressSummary(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const row = await queryOne(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT client_id)::int AS clients_distinct
    FROM customer_saved_addresses
    WHERE company_id = $1
    `,
    [cid],
    "cr_saved_summary"
  );

  return {
    total_saved_addresses: n(row.total),
    clients_with_saved_addresses: n(row.clients_distinct),
    note:
      "Primary client address still lives on clients.address; saved rows are optional extras per customer."
  };
}

async function listSavedAddressesForCompany(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return [];

  return queryRows(
    `
    SELECT
      sa.id,
      sa.company_id,
      sa.client_id,
      sa.customer_account_id,
      sa.label,
      sa.address,
      sa.city,
      sa.state,
      sa.zip,
      sa.is_default,
      sa.created_at,
      sa.updated_at,
      c.name AS client_name
    FROM customer_saved_addresses sa
    INNER JOIN clients c ON c.id = sa.client_id AND c.company_id = sa.company_id
    WHERE sa.company_id = $1
    ORDER BY c.name ASC, sa.is_default DESC, sa.label ASC, sa.id ASC
    LIMIT 500
    `,
    [cid],
    "cr_saved_list_company"
  );
}

async function listSavedAddresses({ companyId, clientId }) {
  const cid = assertCompanyId(companyId);
  const cl = Number(clientId);
  if (!cid || !Number.isInteger(cl) || cl <= 0) return [];

  return queryRows(
    `
    SELECT
      id,
      company_id,
      client_id,
      customer_account_id,
      label,
      address,
      city,
      state,
      zip,
      is_default,
      created_at,
      updated_at
    FROM customer_saved_addresses
    WHERE company_id = $1 AND client_id = $2
    ORDER BY is_default DESC, label ASC, id ASC
    `,
    [cid, cl],
    "cr_saved_list_client"
  );
}

async function upsertSavedAddress({
  companyId,
  clientId,
  customerAccountId = null,
  label = "",
  address = "",
  city = "",
  state = "",
  zip = "",
  isDefault = false,
  id = null
}) {
  const cid = assertCompanyId(companyId);
  const cl = Number(clientId);
  if (!cid || !Number.isInteger(cl) || cl <= 0) {
    throw new Error("Invalid company or client");
  }

  const clientCheck = await pool.query(
    `SELECT id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [cl, cid]
  );
  if (!clientCheck.rows.length) {
    throw new Error("Client not found for company");
  }

  const cleanLabel = String(label || "").trim().slice(0, 120);
  const cleanAddr = String(address || "").trim().slice(0, 500);
  const cleanCity = String(city || "").trim().slice(0, 120);
  const cleanState = String(state || "").trim().slice(0, 32);
  const cleanZip = String(zip || "").trim().slice(0, 32);
  const accId =
    customerAccountId != null && Number.isInteger(Number(customerAccountId))
      ? Number(customerAccountId)
      : null;

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    let rowId = id != null && Number.isInteger(Number(id)) ? Number(id) : null;
    let action = "saved_address_created";

    if (rowId && rowId > 0) {
      const upd = await dbClient.query(
        `
        UPDATE customer_saved_addresses
        SET
          label = $1,
          address = $2,
          city = $3,
          state = $4,
          zip = $5,
          is_default = $6,
          customer_account_id = COALESCE($7, customer_account_id),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $8 AND company_id = $9 AND client_id = $10
        RETURNING id
        `,
        [
          cleanLabel,
          cleanAddr,
          cleanCity,
          cleanState,
          cleanZip,
          !!isDefault,
          accId,
          rowId,
          cid,
          cl
        ]
      );
      if (!upd.rows.length) {
        throw new Error("Saved address not found");
      }
      action = "saved_address_updated";
    } else {
      const ins = await dbClient.query(
        `
        INSERT INTO customer_saved_addresses (
          company_id,
          client_id,
          customer_account_id,
          label,
          address,
          city,
          state,
          zip,
          is_default,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
        `,
        [
          cid,
          cl,
          accId,
          cleanLabel,
          cleanAddr,
          cleanCity,
          cleanState,
          cleanZip,
          !!isDefault
        ]
      );
      rowId = ins.rows[0].id;
    }

    if (isDefault) {
      await dbClient.query(
        `
        UPDATE customer_saved_addresses
        SET is_default = FALSE, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1
          AND client_id = $2
          AND id <> $3
        `,
        [cid, cl, rowId]
      );
    }

    await dbClient.query("COMMIT");

    await activityLogService.logActivity({
      companyId: cid,
      userId: null,
      action,
      entityType: "saved_address",
      entityId: rowId,
      details: {
        client_id: cl,
        customer_account_id: accId,
        label: cleanLabel,
        is_default: !!isDefault
      }
    });

    const rows = await listSavedAddresses({ companyId: cid, clientId: cl });
    const saved = rows.find((r) => Number(r.id) === Number(rowId)) || null;
    return { id: rowId, saved, action };
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    dbClient.release();
  }
}

async function createRebookRequest({
  companyId,
  clientId,
  sourceJobId = null,
  sourceRequestId = null,
  requestedDate = null,
  notes = "",
  userId = null
}) {
  const cid = assertCompanyId(companyId);
  const cl = Number(clientId);
  if (!cid || !Number.isInteger(cl) || cl <= 0) {
    throw new Error("Invalid company or client");
  }

  const clientCheck = await pool.query(
    `SELECT id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [cl, cid]
  );
  if (!clientCheck.rows.length) {
    throw new Error("Client not found for company");
  }

  if (sourceJobId != null) {
    const jid = Number(sourceJobId);
    if (Number.isInteger(jid) && jid > 0) {
      const jobCheck = await pool.query(
        `
        SELECT id FROM jobs
        WHERE id = $1 AND company_id = $2 AND client_id = $3
        LIMIT 1
        `,
        [jid, cid, cl]
      );
      if (!jobCheck.rows.length) {
        throw new Error("Source job not found for this customer");
      }
    }
  }

  if (sourceRequestId != null) {
    const rid = Number(sourceRequestId);
    if (Number.isInteger(rid) && rid > 0) {
      const rq = await pool.query(
        `
        SELECT mr.id
        FROM marketplace_requests mr
        INNER JOIN clients cl ON cl.id = mr.client_id
        WHERE mr.id = $1
          AND cl.company_id = $2
          AND mr.client_id = $3
        LIMIT 1
        `,
        [rid, cid, cl]
      );
      if (!rq.rows.length) {
        throw new Error("Marketplace request not found for this customer");
      }
    }
  }

  await activityLogService.logActivity({
    companyId: cid,
    userId: userId || null,
    action: "rebook_intent_created",
    entityType: "client",
    entityId: cl,
    details: {
      source_job_id: sourceJobId != null ? Number(sourceJobId) : null,
      source_marketplace_request_id:
        sourceRequestId != null ? Number(sourceRequestId) : null,
      requested_date: requestedDate || null,
      notes: String(notes || "").slice(0, 2000)
    }
  });

  let recommended = "post_customer_service_request";
  if (sourceRequestId) {
    recommended = "review_marketplace_thread";
  } else if (sourceJobId) {
    recommended = "post_customer_service_request";
  }

  return {
    success: true,
    recommended_next_action: recommended,
    message:
      "Rebook intent recorded. Scheduling still uses existing staff workflow or POST /customer/service-requests from the customer portal.",
    client_id: cl,
    company_id: cid
  };
}

async function getRetentionOverview(companyId) {
  const cid = assertCompanyId(companyId);
  if (!cid) return null;

  const [
    growthFoundation,
    growthRetention,
    trust,
    rebook,
    reactivation,
    renewals,
    reminders,
    savedSummary,
    favorites
  ] = await Promise.all([
    growthFoundationService.getCompanyMetrics(cid).catch(() => null),
    growthOsService.getRetentionAnalytics(cid).catch(() => null),
    trustReputationService.buildCompanyTrustProfile(cid, { detail: false }).catch(() => null),
    getRebookCandidates(cid),
    getReactivationCandidates(cid),
    getSubscriptionRenewalCandidates(cid),
    getReminderCandidates(cid),
    getSavedAddressSummary(cid),
    queryOne(
      `
      SELECT COUNT(*)::int AS favorites_total
      FROM customer_favorites
      WHERE company_id = $1
      `,
      [cid],
      "cr_fav"
    ).catch(() => ({ favorites_total: 0 }))
  ]);

  return {
    company_id: cid,
    generated_at: new Date().toISOString(),
    growth_foundation: growthFoundation,
    growth_os_retention: growthRetention,
    trust_snapshot: trust
      ? {
          trust_score: trust.trust_score,
          reputation_score: trust.reputation_score
        }
      : null,
    favorites_bookmarks: n(favorites.favorites_total),
    saved_address_summary: savedSummary,
    rebook,
    reactivation,
    subscription_renewals: renewals,
    reminders,
    definitions: {
      rebook_idle_days: REBOOK_IDLE_DAYS,
      reactivation_idle_days: REACTIVATION_IDLE_DAYS,
      reminder_window_days: REMINDER_DAYS
    }
  };
}

module.exports = {
  getRetentionOverview,
  getRebookCandidates,
  getReactivationCandidates,
  getSubscriptionRenewalCandidates,
  getSavedAddressSummary,
  listSavedAddresses,
  listSavedAddressesForCompany,
  upsertSavedAddress,
  createRebookRequest,
  getReminderCandidates
};

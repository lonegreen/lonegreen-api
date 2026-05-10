/**
 * Phase 8 — Trust Graph read models (derived from existing tenant tables).
 * All queries are parameterized; company and customer boundaries are enforced in-SQL.
 */
const pool = require("../db/pool");

function assertPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isoNow() {
  return new Date().toISOString();
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function queryRows(sql, params, label) {
  try {
    const result = await pool.query(sql, params);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    if (err && err.code === "42P01") {
      console.log(JSON.stringify({
        level: "warn",
        event: "trust_graph_table_missing",
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
  return rows[0] || null;
}

/**
 * All client IDs linked to a customer account (junction + primary).
 */
async function resolveAccountClientIds(customerAccountId) {
  const cid = assertPositiveInt(customerAccountId);
  if (!cid) return [];

  const rows = await queryRows(
    `
    SELECT DISTINCT s.client_id
    FROM (
      SELECT cac.client_id
      FROM customer_account_clients cac
      WHERE cac.customer_account_id = $1
      UNION ALL
      SELECT ca.client_id
      FROM customer_accounts ca
      WHERE ca.id = $1 AND ca.client_id IS NOT NULL
    ) s
    WHERE s.client_id IS NOT NULL
    `,
    [cid],
    "resolveAccountClientIds"
  );

  return rows.map((r) => Number(r.client_id)).filter((id) => Number.isInteger(id) && id > 0);
}

function restrictClientIds(allIds, restrict) {
  if (!restrict || !restrict.length) return allIds;
  const allow = new Set(restrict.map((x) => Number(x)));
  return allIds.filter((id) => allow.has(Number(id)));
}

/**
 * @param {number} customerAccountId
 * @param {{ clientIds?: number[] }} [options] When clientIds set, aggregate only those clients (portal scope).
 */
async function buildCustomerTrustGraph(customerAccountId, options = {}) {
  const cid = assertPositiveInt(customerAccountId);
  if (!cid) {
    return {
      customer_account_id: null,
      generated_at: isoNow(),
      clients: [],
      edges: {
        customer_to_company: [],
        customer_to_category: [],
        customer_to_company_service: [],
        customer_to_marketplace_request: []
      },
      metrics: {}
    };
  }

  let clientIds = await resolveAccountClientIds(cid);
  clientIds = restrictClientIds(clientIds, options.clientIds);
  if (!clientIds.length) {
    return {
      customer_account_id: cid,
      generated_at: isoNow(),
      clients: [],
      edges: {
        customer_to_company: [],
        customer_to_category: [],
        customer_to_company_service: [],
        customer_to_marketplace_request: []
      },
      metrics: { client_count: 0 }
    };
  }

  const clientParams = clientIds.map((_, i) => `$${i + 1}`).join(", ");

  const companyEdges = await queryRows(
    `
    WITH pair_stats AS (
      SELECT
        j.company_id,
        j.client_id,
        COUNT(*) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed')::int AS completed_n
      FROM jobs j
      WHERE j.client_id IN (${clientParams})
        AND j.company_id IS NOT NULL
      GROUP BY j.company_id, j.client_id
    ),
    company_roll AS (
      SELECT
        ps.company_id,
        SUM(ps.completed_n)::int AS completed_jobs,
        SUM(GREATEST(ps.completed_n - 1, 0))::int AS repeat_bookings
      FROM pair_stats ps
      GROUP BY ps.company_id
    )
    SELECT
      cr.company_id,
      COALESCE(c.name, '') AS company_name,
      cr.completed_jobs,
      cr.repeat_bookings
    FROM company_roll cr
    LEFT JOIN companies c ON c.id = cr.company_id
    `,
    clientIds,
    "buildCustomerTrustGraph_company_edges"
  );

  const invoiceAgg = await queryRows(
    `
    SELECT
      i.company_id,
      COUNT(*)::int AS paid_invoices
    FROM invoices i
    WHERE i.client_id IN (${clientParams})
      AND LOWER(TRIM(i.status)) = 'paid'
    GROUP BY i.company_id
    `,
    clientIds,
    "buildCustomerTrustGraph_invoices"
  );

  const invMap = new Map(invoiceAgg.map((r) => [Number(r.company_id), n(r.paid_invoices)]));

  const subAgg = await queryRows(
    `
    SELECT
      s.company_id,
      COUNT(*)::int AS active_subscriptions
    FROM subscriptions s
    WHERE s.client_id IN (${clientParams})
      AND LOWER(TRIM(COALESCE(s.status, ''))) = 'active'
    GROUP BY s.company_id
    `,
    clientIds,
    "buildCustomerTrustGraph_subscriptions"
  );

  const subMap = new Map(subAgg.map((r) => [Number(r.company_id), n(r.active_subscriptions)]));

  const mpOffers = await queryRows(
    `
    SELECT
      mo.company_id,
      COUNT(*)::int AS accepted_offers
    FROM marketplace_requests mr
    INNER JOIN marketplace_offers mo ON mo.id = mr.accepted_offer_id
    WHERE mr.customer_account_id = $${clientIds.length + 1}
      AND mo.status = 'accepted'
    GROUP BY mo.company_id
    `,
    [...clientIds, cid],
    "buildCustomerTrustGraph_marketplace"
  );

  const mpMap = new Map(mpOffers.map((r) => [Number(r.company_id), n(r.accepted_offers)]));

  const customer_to_company = companyEdges.map((row) => {
    const companyId = Number(row.company_id);
    const completed_jobs = n(row.completed_jobs);
    const repeat_bookings = n(row.repeat_bookings);
    const paid_invoices = invMap.get(companyId) || 0;
    const active_subscriptions = subMap.get(companyId) || 0;
    const accepted_marketplace_offers = mpMap.get(companyId) || 0;
    const trust_weight =
      3 * completed_jobs +
      5 * paid_invoices +
      4 * repeat_bookings +
      6 * accepted_marketplace_offers +
      7 * active_subscriptions;

    return {
      company_id: companyId,
      company_name: row.company_name || "",
      signals: {
        completed_jobs,
        paid_invoices,
        repeat_bookings,
        accepted_marketplace_offers,
        active_subscriptions
      },
      trust_weight
    };
  });

  const catEdges = await queryRows(
    `
    SELECT
      sc.id AS category_id,
      COALESCE(sc.name, '') AS category_name,
      COALESCE(sc.slug, '') AS slug,
      COUNT(*)::int AS request_count
    FROM marketplace_requests mr
    INNER JOIN service_categories sc ON sc.id = mr.category_id
    WHERE mr.customer_account_id = $1
    GROUP BY sc.id, sc.name, sc.slug
    `,
    [cid],
    "buildCustomerTrustGraph_categories"
  );

  const customer_to_category = catEdges.map((row) => ({
    category_id: Number(row.category_id),
    category_name: row.category_name || "",
    slug: row.slug || "",
    request_count: n(row.request_count)
  }));

  const csEdges = await queryRows(
    `
    SELECT
      cs.id AS company_service_id,
      cs.company_id,
      cs.category_id,
      COALESCE(cs.custom_name, '') AS custom_name,
      COUNT(*)::int AS touches
    FROM jobs j
    INNER JOIN company_services cs
      ON cs.company_id = j.company_id
     AND cs.active = TRUE
    INNER JOIN service_categories cat ON cat.id = cs.category_id
    WHERE j.client_id IN (${clientParams})
      AND LOWER(TRIM(COALESCE(j.service, ''))) <> ''
      AND LOWER(TRIM(j.service)) = LOWER(TRIM(cat.name))
    GROUP BY cs.id, cs.company_id, cs.category_id, cs.custom_name
    `,
    clientIds,
    "buildCustomerTrustGraph_company_services"
  );

  const customer_to_company_service = csEdges.map((row) => ({
    company_service_id: Number(row.company_service_id),
    company_id: Number(row.company_id),
    category_id: Number(row.category_id),
    custom_name: row.custom_name || "",
    touches: n(row.touches)
  }));

  const mrRows = await queryRows(
    `
    SELECT id, status, category_id, created_at
    FROM marketplace_requests
    WHERE customer_account_id = $1
    ORDER BY created_at DESC
    LIMIT 200
    `,
    [cid],
    "buildCustomerTrustGraph_mr"
  );

  const customer_to_marketplace_request = mrRows.map((row) => ({
    marketplace_request_id: Number(row.id),
    status: row.status || "",
    category_id: row.category_id != null ? Number(row.category_id) : null,
    created_at: row.created_at
  }));

  return {
    customer_account_id: cid,
    generated_at: isoNow(),
    clients: clientIds,
    edges: {
      customer_to_company,
      customer_to_category,
      customer_to_company_service,
      customer_to_marketplace_request
    },
    metrics: {
      client_count: clientIds.length,
      company_edge_count: customer_to_company.length,
      category_edge_count: customer_to_category.length
    }
  };
}

function normalizeWeights(rows, key) {
  const maxW = Math.max(1, ...rows.map((r) => n(r[key])));
  return rows.map((r) => ({
    ...r,
    preference_score: Math.round((100 * n(r[key])) / maxW)
  }));
}

async function getCustomerPreferredCompanies(customerAccountId, options = {}) {
  const graph = await buildCustomerTrustGraph(customerAccountId, options);
  const edges = graph.edges.customer_to_company || [];
  const ranked = edges
    .map((e) => ({
      company_id: e.company_id,
      company_name: e.company_name,
      trust_weight: e.trust_weight,
      signals: e.signals
    }))
    .sort((a, b) => n(b.trust_weight) - n(a.trust_weight));

  return normalizeWeights(ranked, "trust_weight");
}

async function getCustomerPreferredServices(customerAccountId, options = {}) {
  const cid = assertPositiveInt(customerAccountId);
  if (!cid) return [];

  let clientIds = await resolveAccountClientIds(cid);
  clientIds = restrictClientIds(clientIds, options.clientIds);
  if (!clientIds.length) return [];

  const clientParams = clientIds.map((_, i) => `$${i + 1}`).join(", ");

  const byCategory = await queryRows(
    `
    SELECT
      sc.id AS category_id,
      COALESCE(sc.name, '') AS category_name,
      COALESCE(sc.slug, '') AS slug,
      COUNT(*)::int AS booking_weight
    FROM marketplace_requests mr
    INNER JOIN service_categories sc ON sc.id = mr.category_id
    WHERE mr.customer_account_id = $1
    GROUP BY sc.id, sc.name, sc.slug
    `,
    [cid],
    "preferred_services_category"
  );

  const byJobPattern = await queryRows(
    `
    SELECT
      LOWER(TRIM(j.service)) AS pattern_key,
      MAX(j.service) AS label,
      COUNT(*)::int AS job_count
    FROM jobs j
    WHERE j.client_id IN (${clientParams})
      AND LOWER(TRIM(COALESCE(j.service, ''))) <> ''
      AND LOWER(TRIM(j.status)) = 'completed'
    GROUP BY LOWER(TRIM(j.service))
    `,
    clientIds,
    "preferred_services_jobs"
  );

  const merged = [];

  for (const row of byCategory) {
    merged.push({
      kind: "category",
      category_id: Number(row.category_id),
      category_name: row.category_name || "",
      slug: row.slug || "",
      booking_weight: n(row.booking_weight)
    });
  }

  for (const row of byJobPattern) {
    merged.push({
      kind: "service_pattern",
      pattern_key: row.pattern_key || "",
      label: row.label || row.pattern_key || "",
      booking_weight: n(row.job_count)
    });
  }

  merged.sort((a, b) => n(b.booking_weight) - n(a.booking_weight));
  return normalizeWeights(merged, "booking_weight");
}

async function buildCompanyTrustGraph(companyId) {
  const cid = assertPositiveInt(companyId);
  if (!cid) {
    return {
      company_id: null,
      generated_at: isoNow(),
      nodes: {},
      edges: [],
      metrics: {}
    };
  }

  const companyRow = await queryOne(
    "SELECT id, name, service_area FROM companies WHERE id = $1 LIMIT 1",
    [cid],
    "buildCompanyTrustGraph_company"
  );

  const repeatCustomers = await queryOne(
    `
    WITH per_client AS (
      SELECT
        j.client_id,
        COUNT(*) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed')::int AS completed_n
      FROM jobs j
      WHERE j.company_id = $1 AND j.client_id IS NOT NULL
      GROUP BY j.client_id
    )
    SELECT
      COUNT(*)::int AS clients_with_completed,
      COUNT(*) FILTER (WHERE completed_n >= 2)::int AS repeat_clients
    FROM per_client
    `,
    [cid],
    "buildCompanyTrustGraph_repeat"
  );

  const areaRows = await queryRows(
    `
    SELECT id, zip_code, city, state, active
    FROM company_service_areas
    WHERE company_id = $1 AND active = TRUE
    ORDER BY id ASC
    LIMIT 500
    `,
    [cid],
    "buildCompanyTrustGraph_areas"
  );

  const subs = await queryOne(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active')::int AS active_n
    FROM subscriptions
    WHERE company_id = $1
    `,
    [cid],
    "buildCompanyTrustGraph_sub_counts"
  );

  return {
    company_id: cid,
    generated_at: isoNow(),
    nodes: {
      company: companyRow
        ? {
            id: Number(companyRow.id),
            name: companyRow.name || "",
            legacy_service_area: companyRow.service_area || ""
          }
        : { id: cid, name: "", legacy_service_area: "" },
      repeat_customers: {
        clients_with_completed: repeatCustomers ? n(repeatCustomers.clients_with_completed) : 0,
        repeat_clients: repeatCustomers ? n(repeatCustomers.repeat_clients) : 0
      },
      service_areas: areaRows.map((r) => ({
        id: Number(r.id),
        zip_code: r.zip_code || "",
        city: r.city || "",
        state: r.state || "",
        active: Boolean(r.active)
      })),
      subscriptions_summary: {
        total: subs ? n(subs.total) : 0,
        active: subs ? n(subs.active_n) : 0
      }
    },
    edges: [],
    metrics: {
      service_area_count: areaRows.length
    }
  };
}

async function getCompanyLoyalCustomerSegments(companyId) {
  const cid = assertPositiveInt(companyId);
  if (!cid) return [];

  const rows = await queryRows(
    `
    WITH jc AS (
      SELECT
        j.client_id,
        COUNT(*) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed')::int AS completed_n,
        MAX(j.date) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed') AS last_completed
      FROM jobs j
      WHERE j.company_id = $1 AND j.client_id IS NOT NULL
      GROUP BY j.client_id
    ),
    sc AS (
      SELECT
        s.client_id,
        BOOL_OR(LOWER(TRIM(COALESCE(s.status, ''))) = 'active') AS has_active
      FROM subscriptions s
      WHERE s.company_id = $1
      GROUP BY s.client_id
    ),
    mv AS (
      SELECT DISTINCT mr.client_id
      FROM marketplace_requests mr
      INNER JOIN jobs j ON j.marketplace_request_id = mr.id
      WHERE j.company_id = $1
    )
    SELECT
      c.id AS client_id,
      COALESCE(c.name, '') AS client_name,
      jc.completed_n,
      jc.last_completed,
      COALESCE(sc.has_active, FALSE) AS subscription_active,
      (mv.client_id IS NOT NULL) AS marketplace_converted
    FROM clients c
    INNER JOIN jc ON jc.client_id = c.id
    LEFT JOIN sc ON sc.client_id = c.id
    LEFT JOIN mv ON mv.client_id = c.id
    WHERE c.company_id = $1
    `,
    [cid],
    "loyal_segments"
  );

  const segments = [];

  const repeatBuyers = rows.filter((r) => n(r.completed_n) >= 2);
  if (repeatBuyers.length) {
    segments.push({
      segment_key: "repeat_buyers",
      label: "Repeat buyers (2+ completed jobs)",
      client_count: repeatBuyers.length,
      clients: repeatBuyers.slice(0, 50).map((r) => ({
        client_id: Number(r.client_id),
        client_name: r.client_name || "",
        completed_jobs: n(r.completed_n),
        last_completed: r.last_completed
      }))
    });
  }

  const subLoyal = rows.filter((r) => r.subscription_active);
  if (subLoyal.length) {
    segments.push({
      segment_key: "subscription_loyal",
      label: "Active subscription clients",
      client_count: subLoyal.length,
      clients: subLoyal.slice(0, 50).map((r) => ({
        client_id: Number(r.client_id),
        client_name: r.client_name || "",
        completed_jobs: n(r.completed_n)
      }))
    });
  }

  const mpConv = rows.filter((r) => r.marketplace_converted);
  if (mpConv.length) {
    segments.push({
      segment_key: "marketplace_converted",
      label: "Marketplace-attributed jobs",
      client_count: mpConv.length,
      clients: mpConv.slice(0, 50).map((r) => ({
        client_id: Number(r.client_id),
        client_name: r.client_name || ""
      }))
    });
  }

  return segments;
}

async function getCompanyTrustNetwork(companyId) {
  const cid = assertPositiveInt(companyId);
  if (!cid) {
    return {
      company_id: null,
      repeat_clients_ratio: 0,
      returning_customer_ratio: 0,
      average_lifecycle_value: 0,
      subscription_retention_ratio: 0
    };
  }

  const repeatRow = await queryOne(
    `
    WITH jc AS (
      SELECT
        j.client_id,
        COUNT(*) FILTER (WHERE LOWER(TRIM(j.status)) = 'completed')::int AS n
      FROM jobs j
      WHERE j.company_id = $1 AND j.client_id IS NOT NULL
      GROUP BY j.client_id
    )
    SELECT
      COUNT(*) FILTER (WHERE n >= 1)::numeric AS with_completed,
      COUNT(*) FILTER (WHERE n >= 2)::numeric AS repeat_clients
    FROM jc
    `,
    [cid],
    "trust_network_repeat"
  );

  const withCompleted = repeatRow ? n(repeatRow.with_completed) : 0;
  const repeatClients = repeatRow ? n(repeatRow.repeat_clients) : 0;
  const repeat_clients_ratio = withCompleted > 0 ? repeatClients / withCompleted : 0;

  const returningRow = await queryOne(
    `
    WITH client_activity AS (
      SELECT
        j.client_id,
        BOOL_OR(j.date < CURRENT_DATE - INTERVAL '90 days') AS had_prior_completed,
        BOOL_OR(j.date >= CURRENT_DATE - INTERVAL '90 days') AS recent_completed
      FROM jobs j
      WHERE j.company_id = $1
        AND j.client_id IS NOT NULL
        AND LOWER(TRIM(j.status)) = 'completed'
      GROUP BY j.client_id
    )
    SELECT
      COUNT(*) FILTER (WHERE recent_completed)::numeric AS recent_base,
      COUNT(*) FILTER (WHERE recent_completed AND had_prior_completed)::numeric AS returning
    FROM client_activity
    `,
    [cid],
    "trust_network_returning"
  );

  const recentBase = returningRow ? n(returningRow.recent_base) : 0;
  const returning = returningRow ? n(returningRow.returning) : 0;
  const returning_customer_ratio = recentBase > 0 ? returning / recentBase : 0;

  const lifeRow = await queryOne(
    `
    SELECT COALESCE(AVG(t.client_total), 0)::numeric AS avg_life
    FROM (
      SELECT i.client_id, SUM(i.amount::numeric) AS client_total
      FROM invoices i
      WHERE i.company_id = $1
        AND LOWER(TRIM(i.status)) = 'paid'
      GROUP BY i.client_id
    ) t
    `,
    [cid],
    "trust_network_lifecycle"
  );

  const subRow = await queryOne(
    `
    SELECT
      COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('active', 'paused', 'cancelled'))::numeric AS denom,
      COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active')::numeric AS active_n
    FROM subscriptions
    WHERE company_id = $1
    `,
    [cid],
    "trust_network_sub"
  );

  const denom = subRow ? n(subRow.denom) : 0;
  const activeN = subRow ? n(subRow.active_n) : 0;
  const subscription_retention_ratio = denom > 0 ? activeN / denom : 0;

  return {
    company_id: cid,
    generated_at: isoNow(),
    repeat_clients_ratio: Number(repeat_clients_ratio.toFixed(4)),
    returning_customer_ratio: Number(returning_customer_ratio.toFixed(4)),
    average_lifecycle_value: Number(n(lifeRow && lifeRow.avg_life).toFixed(2)),
    subscription_retention_ratio: Number(subscription_retention_ratio.toFixed(4)),
    counts: {
      clients_with_completed_jobs: withCompleted,
      repeat_clients: repeatClients,
      returning_recent_window: returning,
      recent_completed_clients: recentBase,
      subscriptions_tracked: denom,
      active_subscriptions: activeN
    }
  };
}

/**
 * Company-level category / pattern affinity across its clients (read-model).
 */
async function getCompanyServiceAffinity(companyId) {
  const cid = assertPositiveInt(companyId);
  if (!cid) {
    return { category_affinity: [], service_patterns: [] };
  }

  const categories = await queryRows(
    `
    SELECT
      sc.id AS category_id,
      COALESCE(sc.name, '') AS category_name,
      COALESCE(sc.slug, '') AS slug,
      COUNT(*)::int AS completed_jobs
    FROM jobs j
    INNER JOIN company_services cs ON cs.company_id = j.company_id AND cs.active = TRUE
    INNER JOIN service_categories sc ON sc.id = cs.category_id
    WHERE j.company_id = $1
      AND LOWER(TRIM(j.status)) = 'completed'
      AND LOWER(TRIM(COALESCE(j.service, ''))) <> ''
      AND (
        LOWER(TRIM(j.service)) = LOWER(TRIM(sc.name))
        OR LOWER(TRIM(j.service)) LIKE '%' || LOWER(TRIM(sc.slug)) || '%'
      )
    GROUP BY sc.id, sc.name, sc.slug
    ORDER BY completed_jobs DESC
    LIMIT 40
    `,
    [cid],
    "company_service_affinity_cat"
  );

  const patterns = await queryRows(
    `
    SELECT
      LOWER(TRIM(j.service)) AS pattern_key,
      MAX(j.service) AS label,
      COUNT(*)::int AS completed_jobs
    FROM jobs j
    WHERE j.company_id = $1
      AND LOWER(TRIM(j.status)) = 'completed'
      AND LOWER(TRIM(COALESCE(j.service, ''))) <> ''
    GROUP BY LOWER(TRIM(j.service))
    ORDER BY completed_jobs DESC
    LIMIT 40
    `,
    [cid],
    "company_service_affinity_patterns"
  );

  return {
    category_affinity: categories.map((r) => ({
      category_id: Number(r.category_id),
      category_name: r.category_name || "",
      slug: r.slug || "",
      completed_jobs: n(r.completed_jobs)
    })),
    service_patterns: patterns.map((r) => ({
      pattern_key: r.pattern_key || "",
      label: r.label || "",
      completed_jobs: n(r.completed_jobs)
    }))
  };
}

module.exports = {
  buildCustomerTrustGraph,
  buildCompanyTrustGraph,
  getCustomerPreferredCompanies,
  getCustomerPreferredServices,
  getCompanyLoyalCustomerSegments,
  getCompanyTrustNetwork,
  getCompanyServiceAffinity,
  resolveAccountClientIds
};

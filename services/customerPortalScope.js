const pool = require("../db/pool");

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve stable customer account id from JWT (prefers explicit customer_account_id,
 * falls back to lookup by primary clients.id on the token).
 */
async function resolveCustomerAccountId(customerPayload) {
  const fromToken = toPositiveInt(customerPayload && customerPayload.customer_account_id);
  if (fromToken) {
    const check = await pool.query(
      "SELECT id FROM customer_accounts WHERE id = $1 LIMIT 1",
      [fromToken]
    );
    if (check.rows.length) {
      return fromToken;
    }
  }
  const clientId = toPositiveInt(customerPayload && customerPayload.client_id);
  if (!clientId) {
    return null;
  }
  const result = await pool.query(
    "SELECT id FROM customer_accounts WHERE client_id = $1 LIMIT 1",
    [clientId]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

/**
 * All (company_id, client_id) pairs this account may access in the portal.
 */
async function loadPortalScopes(customerAccountId) {
  if (!customerAccountId) {
    return [];
  }
  const result = await pool.query(
    `
    SELECT DISTINCT company_id, client_id
    FROM (
      SELECT cac.company_id, cac.client_id
      FROM customer_account_clients cac
      WHERE cac.customer_account_id = $1
      UNION ALL
      SELECT c.company_id, ca.client_id
      FROM customer_accounts ca
      INNER JOIN clients c ON c.id = ca.client_id
      WHERE ca.id = $1 AND ca.client_id IS NOT NULL
    ) s
    `,
    [customerAccountId]
  );
  return result.rows.map((r) => ({
    company_id: Number(r.company_id),
    client_id: Number(r.client_id)
  }));
}

function scopePairsInclude(scopes, companyId, clientId) {
  const c = Number(companyId);
  const cl = Number(clientId);
  return scopes.some(
    (s) => Number(s.company_id) === c && Number(s.client_id) === cl
  );
}

/**
 * Verify JWT primary client_id is still linked to this account (prevents stale-token confusion).
 */
function tokenClientBelongsToScopes(scopes, tokenClientId) {
  const id = Number(tokenClientId);
  if (!Number.isInteger(id) || id <= 0) {
    return false;
  }
  return scopes.some((s) => Number(s.client_id) === id);
}

module.exports = {
  toPositiveInt,
  resolveCustomerAccountId,
  loadPortalScopes,
  scopePairsInclude,
  tokenClientBelongsToScopes
};

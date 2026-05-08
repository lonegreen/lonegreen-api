const express = require("express");
const pool = require("../db/pool");
const { requireActiveCustomer } = require("../middleware/auth");
const { sendSafeServerError } = require("../services/safeServerError");
const {
  resolveCustomerAccountId,
  loadPortalScopes,
  tokenClientBelongsToScopes
} = require("../services/customerPortalScope");

const router = express.Router();

const customerAuth = requireActiveCustomer;


async function getScopedCustomer(req) {
  const accountId = await resolveCustomerAccountId(req.customer);
  let scopes = accountId ? await loadPortalScopes(accountId) : [];
  if (!scopes.length && req.customer.client_id) {
    const clientResult = await pool.query(
      "SELECT id, company_id FROM clients WHERE id = $1 LIMIT 1",
      [req.customer.client_id]
    );
    const row = clientResult.rows[0];
    if (row && row.company_id) {
      scopes = [{
        company_id: Number(row.company_id),
        client_id: Number(row.id)
      }];
    }
  }
  if (!scopes.length) {
    return null;
  }
  if (!tokenClientBelongsToScopes(scopes, req.customer.client_id)) {
    return null;
  }
  return { scopes };
}

router.post("/follows", customerAuth, async (req, res) => {
  try {
    const companyId = Number(req.body && req.body.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company_id" });
    }

    const scopedCustomer = await getScopedCustomer(req);
    if (!scopedCustomer) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const pair = scopedCustomer.scopes.find(s => Number(s.company_id) === companyId);
    if (!pair) {
      return res.status(403).json({
        error: "Open a service relationship with this company before following."
      });
    }

    const companyResult = await pool.query(
      "SELECT id FROM companies WHERE id = $1 AND is_public = TRUE LIMIT 1",
      [companyId]
    );
    if (!companyResult.rows.length) {
      const existsResult = await pool.query(
        "SELECT id FROM companies WHERE id = $1 LIMIT 1",
        [companyId]
      );
      if (!existsResult.rows.length) {
        return res.status(404).json({ error: "Company not found" });
      }
      return res.status(403).json({ error: "Company is not public" });
    }

    const inserted = await pool.query(
      `
      INSERT INTO customer_company_follows (client_id, company_id)
      VALUES ($1, $2)
      ON CONFLICT (client_id, company_id)
      DO NOTHING
      RETURNING id, client_id, company_id, created_at
      `,
      [pair.client_id, companyId]
    );

    if (inserted.rows.length) {
      return res.status(201).json(inserted.rows[0]);
    }

    const existing = await pool.query(
      `
      SELECT id, client_id, company_id, created_at
      FROM customer_company_follows
      WHERE client_id = $1 AND company_id = $2
      LIMIT 1
      `,
      [pair.client_id, companyId]
    );
    return res.json(existing.rows[0] || null);
  } catch (err) {
    return sendSafeServerError(res, err, "FOLLOWS CREATE ERROR");
  }
});

router.delete("/follows/:companyId", customerAuth, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const scopedCustomer = await getScopedCustomer(req);
    if (!scopedCustomer) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const pair = scopedCustomer.scopes.find(s => Number(s.company_id) === companyId);
    if (!pair) {
      return res.status(404).json({ error: "Not found" });
    }

    const result = await pool.query(
      `
      DELETE FROM customer_company_follows
      WHERE client_id = $1
        AND company_id = $2
      `,
      [pair.client_id, companyId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    return sendSafeServerError(res, err, "FOLLOWS DELETE ERROR");
  }
});

router.get("/follows", customerAuth, async (req, res) => {
  try {
    const scopedCustomer = await getScopedCustomer(req);
    if (!scopedCustomer) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const clientIds = scopedCustomer.scopes.map(s => s.client_id);
    const result = await pool.query(
      `
      SELECT id, client_id, company_id, created_at
      FROM customer_company_follows
      WHERE client_id = ANY($1::int[])
      ORDER BY created_at DESC, id DESC
      `,
      [clientIds]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "FOLLOWS LIST ERROR");
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db/pool");
const { verifyCustomerBearerToken } = require("../middleware/auth");
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

async function getScopedCustomer(req) {
  const tokenCompanyId = req.customer.company_id ? Number(req.customer.company_id) : null;
  const clientResult = tokenCompanyId
    ? await pool.query(
      "SELECT id, company_id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1",
      [req.customer.client_id, tokenCompanyId]
    )
    : await pool.query(
      "SELECT id, company_id FROM clients WHERE id = $1 LIMIT 1",
      [req.customer.client_id]
    );
  if (!clientResult.rows.length) {
    return null;
  }

  const client = clientResult.rows[0];
  const clientCompanyId = Number(client.company_id);
  if (tokenCompanyId && tokenCompanyId !== clientCompanyId) {
    return null;
  }

  return {
    client_id: Number(client.id),
    company_id: clientCompanyId
  };
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
      [scopedCustomer.client_id, companyId]
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
      [scopedCustomer.client_id, companyId]
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

    await pool.query(
      `
      DELETE FROM customer_company_follows
      WHERE client_id = $1
        AND company_id = $2
      `,
      [scopedCustomer.client_id, companyId]
    );

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

    const result = await pool.query(
      `
      SELECT id, client_id, company_id, created_at
      FROM customer_company_follows
      WHERE client_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [scopedCustomer.client_id]
    );

    return res.json(result.rows);
  } catch (err) {
    return sendSafeServerError(res, err, "FOLLOWS LIST ERROR");
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db/pool");
const { sendSafeServerError } = require("../services/safeServerError");

const router = express.Router();

router.get("/services/categories", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        slug,
        description,
        icon,
        active,
        sort_order,
        created_at
      FROM service_categories
      WHERE active = TRUE
      ORDER BY sort_order ASC, name ASC, id ASC
      `
    );
    res.json(result.rows);
  } catch (err) {
    sendSafeServerError(res, err, "SERVICES CATEGORIES LIST ERROR");
  }
});

router.get("/companies/:id/services", async (req, res) => {
  try {
    const companyId = Number(req.params.id);
    if (!companyId) {
      return res.status(400).json({ error: "Invalid company id" });
    }

    const result = await pool.query(
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
        AND sc.active = TRUE
      ORDER BY sc.sort_order ASC, sc.name ASC, cs.id ASC
      `,
      [companyId]
    );

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
    sendSafeServerError(res, err, "COMPANY SERVICES LIST ERROR");
  }
});

module.exports = router;

#!/usr/bin/env node
"use strict";

const pool = require("../db/pool");

const ORPHAN_QUERY = `
SELECT
  ca.id AS customer_account_id,
  ca.client_id
FROM customer_accounts ca
JOIN clients c ON c.id = ca.client_id
WHERE ca.client_id IS NOT NULL
  AND c.company_id IS NULL;
`;

async function main() {
  try {
    const result = await pool.query(ORPHAN_QUERY);
    console.log(result.rows);
    await pool.end();
    process.exit(result.rows.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(err);
    try {
      await pool.end();
    } catch (_) {}
    process.exit(1);
  }
}

main();

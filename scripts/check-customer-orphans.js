#!/usr/bin/env node
"use strict";

const pool = require("../db/pool");

const ORPHAN_QUERY = `
SELECT
  ca.id AS customer_account_id,
  ca.client_id,
  EXISTS (
    SELECT 1 FROM estimates e
    WHERE e.client_id = ca.client_id
      AND e.company_id IS NOT NULL
  ) AS has_company_estimate,
  EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.client_id = ca.client_id
      AND j.company_id IS NOT NULL
  ) AS has_company_job,
  EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.client_id = ca.client_id
      AND i.company_id IS NOT NULL
  ) AS has_company_invoice,
  EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.client_id = ca.client_id
      AND s.company_id IS NOT NULL
  ) AS has_company_subscription,
  EXISTS (
    SELECT 1 FROM customer_account_clients cac
    WHERE cac.customer_account_id = ca.id
      AND cac.company_id IS NOT NULL
  ) AS has_company_mapping,
  EXISTS (
    SELECT 1 FROM marketplace_requests mr
    WHERE (mr.client_id = ca.client_id OR mr.customer_account_id = ca.id)
      AND mr.converted_by_company_id IS NOT NULL
  ) AS has_converted_marketplace_request,
  EXISTS (
    SELECT 1
    FROM marketplace_offers mo
    JOIN marketplace_requests mr ON mr.id = mo.request_id
    WHERE (mr.client_id = ca.client_id OR mr.customer_account_id = ca.id)
      AND mo.company_id IS NOT NULL
  ) AS has_company_offer
FROM customer_accounts ca
JOIN clients c ON c.id = ca.client_id
WHERE ca.client_id IS NOT NULL
  AND c.company_id IS NULL;
`;

function requiresCompanyRepair(row) {
  return Boolean(
    row.has_company_estimate ||
    row.has_company_job ||
    row.has_company_invoice ||
    row.has_company_subscription ||
    row.has_company_mapping ||
    row.has_converted_marketplace_request ||
    row.has_company_offer
  );
}

async function main() {
  try {
    const result = await pool.query(ORPHAN_QUERY);
    const repairRequired = result.rows.filter(requiresCompanyRepair);
    const whitelistedStandalone = result.rows
      .filter((row) => !requiresCompanyRepair(row))
      .map((row) => ({
        customer_account_id: row.customer_account_id,
        client_id: row.client_id,
        reason: "standalone_customer_account_client"
      }));

    console.log({
      repair_required: repairRequired,
      whitelisted_standalone: whitelistedStandalone
    });
    await pool.end();
    process.exit(repairRequired.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(err);
    try {
      await pool.end();
    } catch (_) {}
    process.exit(1);
  }
}

main();

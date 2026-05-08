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
  AND c.company_id IS NULL
ORDER BY ca.id ASC;
`;

async function inferCompanyId(client, customerAccountId, clientId) {
  const estimateCompanies = await client.query(
    `
    SELECT DISTINCT company_id
    FROM estimates
    WHERE client_id = $1
      AND company_id IS NOT NULL
    `,
    [clientId]
  );

  const jobCompanies = await client.query(
    `
    SELECT DISTINCT company_id
    FROM jobs
    WHERE client_id = $1
      AND company_id IS NOT NULL
    `,
    [clientId]
  );

  const invoiceCompanies = await client.query(
    `
    SELECT DISTINCT company_id
    FROM invoices
    WHERE client_id = $1
      AND company_id IS NOT NULL
    `,
    [clientId]
  );

  const mappedCompanies = await client.query(
    `
    SELECT DISTINCT company_id
    FROM customer_account_clients
    WHERE customer_account_id = $1
      AND company_id IS NOT NULL
    `,
    [customerAccountId]
  );

  const subscriptionCompanies = await client.query(
    `
    SELECT DISTINCT company_id
    FROM subscriptions
    WHERE client_id = $1
      AND company_id IS NOT NULL
    `,
    [clientId]
  );

  const marketplaceRequestCompanies = await client.query(
    `
    SELECT DISTINCT converted_by_company_id AS company_id
    FROM marketplace_requests
    WHERE (client_id = $1 OR customer_account_id = $2)
      AND converted_by_company_id IS NOT NULL
    `,
    [clientId, customerAccountId]
  );

  const marketplaceOfferCompanies = await client.query(
    `
    SELECT DISTINCT mo.company_id
    FROM marketplace_offers mo
    JOIN marketplace_requests mr ON mr.id = mo.request_id
    WHERE (mr.client_id = $1 OR mr.customer_account_id = $2)
      AND mo.company_id IS NOT NULL
    `,
    [clientId, customerAccountId]
  );

  const candidates = new Set();
  const bySource = {
    estimates: estimateCompanies.rows.map((r) => Number(r.company_id)),
    jobs: jobCompanies.rows.map((r) => Number(r.company_id)),
    invoices: invoiceCompanies.rows.map((r) => Number(r.company_id)),
    subscriptions: subscriptionCompanies.rows.map((r) => Number(r.company_id)),
    customer_account_clients: mappedCompanies.rows.map((r) => Number(r.company_id)),
    marketplace_requests: marketplaceRequestCompanies.rows.map((r) => Number(r.company_id)),
    marketplace_offers: marketplaceOfferCompanies.rows.map((r) => Number(r.company_id))
  };
  for (const id of bySource.estimates) candidates.add(id);
  for (const id of bySource.jobs) candidates.add(id);
  for (const id of bySource.invoices) candidates.add(id);
  for (const id of bySource.subscriptions) candidates.add(id);
  for (const id of bySource.customer_account_clients) candidates.add(id);
  for (const id of bySource.marketplace_requests) candidates.add(id);
  for (const id of bySource.marketplace_offers) candidates.add(id);

  if (candidates.size === 1) {
    return {
      companyId: Array.from(candidates)[0],
      candidates: Array.from(candidates),
      bySource
    };
  }

  return {
    companyId: null,
    candidates: Array.from(candidates).sort((a, b) => a - b),
    bySource,
    standaloneCustomerClient: candidates.size === 0
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const client = await pool.connect();
  const repaired = [];
  const unresolved = [];
  const whitelisted = [];

  try {
    await client.query("BEGIN");
    const orphans = await client.query(ORPHAN_QUERY);

    for (const orphan of orphans.rows) {
      const customerAccountId = Number(orphan.customer_account_id);
      const clientId = Number(orphan.client_id);
      const inferred = await inferCompanyId(client, customerAccountId, clientId);

      if (inferred.standaloneCustomerClient) {
        whitelisted.push({
          customer_account_id: customerAccountId,
          client_id: clientId,
          reason: "standalone_customer_account_client",
          inferred_company_sources: inferred.bySource
        });
        continue;
      }

      if (!inferred.companyId) {
        unresolved.push({
          customer_account_id: customerAccountId,
          client_id: clientId,
          inferred_company_candidates: inferred.candidates,
          inferred_company_sources: inferred.bySource,
          manual_sql_recommendation: `-- Not auto-applied: no single safe inference\nUPDATE clients\nSET company_id = <confirmed_company_id>\nWHERE id = ${clientId}\n  AND company_id IS NULL;`
        });
        continue;
      }

      if (apply) {
        const updated = await client.query(
          `
          UPDATE clients
          SET company_id = $1
          WHERE id = $2
            AND company_id IS NULL
          RETURNING id, company_id
          `,
          [inferred.companyId, clientId]
        );

        if (updated.rows.length) {
          repaired.push({
            customer_account_id: customerAccountId,
            client_id: clientId,
            company_id: updated.rows[0].company_id
          });
        }
      } else {
        repaired.push({
          customer_account_id: customerAccountId,
          client_id: clientId,
          company_id: inferred.companyId,
          inferred_company_sources: inferred.bySource
        });
      }
    }

    if (apply) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      repaired_rows: repaired,
      whitelisted_rows: whitelisted,
      unresolved_rows: unresolved
    }, null, 2));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

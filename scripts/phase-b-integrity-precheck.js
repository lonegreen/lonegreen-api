const pool = require("../db/pool");

async function main() {
  const duplicateEstimateJobs = await pool.query(
    `
    SELECT company_id, estimate_id, COUNT(*)::int AS duplicate_count, ARRAY_AGG(id ORDER BY id ASC) AS job_ids
    FROM jobs
    WHERE estimate_id IS NOT NULL
    GROUP BY company_id, estimate_id
    HAVING COUNT(*) > 1
    ORDER BY company_id ASC, estimate_id ASC
    `
  );

  const duplicateCustomerEmails = await pool.query(
    `
    SELECT LOWER(TRIM(email)) AS email_key, COUNT(*)::int AS duplicate_count, ARRAY_AGG(id ORDER BY id ASC) AS account_ids
    FROM customer_accounts
    GROUP BY LOWER(TRIM(email))
    HAVING COUNT(*) > 1
    ORDER BY email_key ASC
    `
  );

  const hasDuplicates = duplicateEstimateJobs.rows.length > 0 || duplicateCustomerEmails.rows.length > 0;

  console.log("Phase B integrity precheck");
  console.log("=========================");
  console.log(`duplicate_estimate_jobs: ${duplicateEstimateJobs.rows.length}`);
  if (duplicateEstimateJobs.rows.length) {
    console.log(JSON.stringify(duplicateEstimateJobs.rows, null, 2));
  }
  console.log(`duplicate_customer_email_variants: ${duplicateCustomerEmails.rows.length}`);
  if (duplicateCustomerEmails.rows.length) {
    console.log(JSON.stringify(duplicateCustomerEmails.rows, null, 2));
  }

  if (hasDuplicates) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("phase-b-integrity-precheck failed:", err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

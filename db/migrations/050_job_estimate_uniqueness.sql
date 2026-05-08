DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE estimate_id IS NOT NULL
    GROUP BY company_id, estimate_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique estimate->job index: duplicate jobs exist for the same estimate. Run scripts/phase-b-integrity-precheck.js and clean duplicates first.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_estimate_per_company
ON jobs (company_id, estimate_id)
WHERE estimate_id IS NOT NULL;

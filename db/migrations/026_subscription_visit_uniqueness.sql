DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE source_subscription_id IS NOT NULL
      AND type = 'subscription_visit'
    GROUP BY company_id, source_subscription_id, date, type
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create idx_jobs_unique_subscription_visit: duplicate subscription visits exist. Run npm run integrity:audit -- --strict and repair duplicates first.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_subscription_visit
ON jobs (company_id, source_subscription_id, date, type)
WHERE source_subscription_id IS NOT NULL
  AND type = 'subscription_visit';

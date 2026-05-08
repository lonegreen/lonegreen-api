DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM customer_accounts
    GROUP BY LOWER(TRIM(email))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce case-insensitive customer email uniqueness: duplicate email variants exist. Run scripts/phase-b-integrity-precheck.js and resolve duplicates first.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_accounts_email_lower
ON customer_accounts ((LOWER(TRIM(email))));

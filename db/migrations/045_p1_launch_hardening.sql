-- P1 launch hardening:
-- 1) Prevent duplicate active invoices per job
-- 2) Add customer ownership verification claims (OTP/invite-ready gating)

WITH duplicate_active_job_invoices AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY company_id, job_id ORDER BY id ASC) AS rn
  FROM invoices
  WHERE job_id IS NOT NULL
    AND status <> 'cancelled'
)
UPDATE invoices i
SET
  status = 'cancelled',
  notes = CONCAT(
    COALESCE(i.notes, ''),
    CASE WHEN COALESCE(i.notes, '') = '' THEN '' ELSE ' ' END,
    '[auto-cancelled duplicate active invoice during P1 hardening]'
  )
FROM duplicate_active_job_invoices d
WHERE i.id = d.id
  AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_job_active_unique
ON invoices (company_id, job_id)
WHERE job_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS customer_signup_claims (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  verification_type TEXT NOT NULL DEFAULT 'email_otp',
  verification_code_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_signup_claims_client_email
ON customer_signup_claims (client_id, email, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customer_signup_claims_verification_type_check'
  ) THEN
    ALTER TABLE customer_signup_claims
      ADD CONSTRAINT customer_signup_claims_verification_type_check
      CHECK (verification_type IN ('email_otp', 'invite_token'));
  END IF;
END $$;

-- 055_company_verification_engine.sql
-- Idempotent verification engine fields + constraints + indexes for companies.

BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by INTEGER NULL,
  ADD COLUMN IF NOT EXISTS verification_notes TEXT,
  ADD COLUMN IF NOT EXISTS license_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS insurance_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'unknown';

-- Normalize NULLs for legacy rows before tightening defaults/constraints.
UPDATE companies
SET verification_status = COALESCE(NULLIF(TRIM(verification_status), ''), 'unverified')
WHERE verification_status IS NULL OR TRIM(verification_status) = '';

UPDATE companies
SET license_status = COALESCE(NULLIF(TRIM(license_status), ''), 'unknown')
WHERE license_status IS NULL OR TRIM(license_status) = '';

UPDATE companies
SET insurance_status = COALESCE(NULLIF(TRIM(insurance_status), ''), 'unknown')
WHERE insurance_status IS NULL OR TRIM(insurance_status) = '';

UPDATE companies
SET identity_status = COALESCE(NULLIF(TRIM(identity_status), ''), 'unknown')
WHERE identity_status IS NULL OR TRIM(identity_status) = '';

ALTER TABLE companies
  ALTER COLUMN verification_status SET DEFAULT 'unverified',
  ALTER COLUMN verification_status SET NOT NULL,
  ALTER COLUMN license_status SET DEFAULT 'unknown',
  ALTER COLUMN license_status SET NOT NULL,
  ALTER COLUMN insurance_status SET DEFAULT 'unknown',
  ALTER COLUMN insurance_status SET NOT NULL,
  ALTER COLUMN identity_status SET DEFAULT 'unknown',
  ALTER COLUMN identity_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'companies_verification_status_check'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_verification_status_check
      CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'companies_license_status_check'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_license_status_check
      CHECK (license_status IN ('unknown', 'pending', 'verified', 'rejected', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'companies_insurance_status_check'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_insurance_status_check
      CHECK (insurance_status IN ('unknown', 'pending', 'verified', 'rejected', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'companies_identity_status_check'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_identity_status_check
      CHECK (identity_status IN ('unknown', 'pending', 'verified', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_companies_verification_status
  ON companies (verification_status);

CREATE INDEX IF NOT EXISTS idx_companies_license_status
  ON companies (license_status);

CREATE INDEX IF NOT EXISTS idx_companies_insurance_status
  ON companies (insurance_status);

CREATE INDEX IF NOT EXISTS idx_companies_identity_status
  ON companies (identity_status);

COMMIT;

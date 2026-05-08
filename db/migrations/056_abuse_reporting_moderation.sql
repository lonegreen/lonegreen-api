-- 056_abuse_reporting_moderation.sql
-- Idempotent abuse reporting + moderation table for marketplace safety.

BEGIN;

CREATE TABLE IF NOT EXISTS abuse_reports (
  id SERIAL PRIMARY KEY,
  reporter_user_id INTEGER NULL,
  reporter_customer_id INTEGER NULL,
  company_id INTEGER NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  resolution_notes TEXT,
  resolved_by INTEGER NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE abuse_reports
  ADD COLUMN IF NOT EXISTS reporter_user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS reporter_customer_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS company_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS target_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'general_safety',
  ADD COLUMN IF NOT EXISTS details TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by INTEGER NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE abuse_reports
SET target_type = COALESCE(NULLIF(TRIM(target_type), ''), 'company')
WHERE target_type IS NULL OR TRIM(target_type) = '';

UPDATE abuse_reports
SET status = COALESCE(NULLIF(TRIM(status), ''), 'open')
WHERE status IS NULL OR TRIM(status) = '';

UPDATE abuse_reports
SET priority = COALESCE(NULLIF(TRIM(priority), ''), 'medium')
WHERE priority IS NULL OR TRIM(priority) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'abuse_reports_target_type_check'
  ) THEN
    ALTER TABLE abuse_reports
      ADD CONSTRAINT abuse_reports_target_type_check
      CHECK (target_type IN ('company', 'review', 'message', 'marketplace_request'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'abuse_reports_status_check'
  ) THEN
    ALTER TABLE abuse_reports
      ADD CONSTRAINT abuse_reports_status_check
      CHECK (status IN ('open', 'reviewing', 'action_taken', 'dismissed', 'closed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'abuse_reports_priority_check'
  ) THEN
    ALTER TABLE abuse_reports
      ADD CONSTRAINT abuse_reports_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_abuse_reports_target
  ON abuse_reports (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_company_id
  ON abuse_reports (company_id);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_status
  ON abuse_reports (status);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_priority
  ON abuse_reports (priority);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_created_at
  ON abuse_reports (created_at DESC);

COMMIT;

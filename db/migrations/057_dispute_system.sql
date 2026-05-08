-- 057_dispute_system.sql
-- Idempotent dispute workflow foundation (no payment/refund logic).

BEGIN;

CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  marketplace_request_id INTEGER NULL,
  support_ticket_id INTEGER NULL,
  company_id INTEGER NULL,
  customer_id INTEGER NULL,
  opened_by_type TEXT NOT NULL,
  opened_by_user_id INTEGER NULL,
  opened_by_customer_id INTEGER NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  resolution TEXT,
  resolution_notes TEXT,
  resolved_by INTEGER NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS marketplace_request_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS support_ticket_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS company_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS customer_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS opened_by_type TEXT NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS opened_by_user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS opened_by_customer_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'general_dispute',
  ADD COLUMN IF NOT EXISTS details TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS resolution TEXT,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by INTEGER NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE disputes
SET opened_by_type = COALESCE(NULLIF(TRIM(opened_by_type), ''), 'customer')
WHERE opened_by_type IS NULL OR TRIM(opened_by_type) = '';

UPDATE disputes
SET status = COALESCE(NULLIF(TRIM(status), ''), 'open')
WHERE status IS NULL OR TRIM(status) = '';

UPDATE disputes
SET priority = COALESCE(NULLIF(TRIM(priority), ''), 'medium')
WHERE priority IS NULL OR TRIM(priority) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'disputes_opened_by_type_check'
  ) THEN
    ALTER TABLE disputes
      ADD CONSTRAINT disputes_opened_by_type_check
      CHECK (opened_by_type IN ('customer', 'company', 'platform'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'disputes_status_check'
  ) THEN
    ALTER TABLE disputes
      ADD CONSTRAINT disputes_status_check
      CHECK (status IN ('open', 'reviewing', 'waiting_customer', 'waiting_company', 'resolved', 'closed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'disputes_priority_check'
  ) THEN
    ALTER TABLE disputes
      ADD CONSTRAINT disputes_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_disputes_marketplace_request_id
  ON disputes (marketplace_request_id);

CREATE INDEX IF NOT EXISTS idx_disputes_support_ticket_id
  ON disputes (support_ticket_id);

CREATE INDEX IF NOT EXISTS idx_disputes_company_id
  ON disputes (company_id);

CREATE INDEX IF NOT EXISTS idx_disputes_customer_id
  ON disputes (customer_id);

CREATE INDEX IF NOT EXISTS idx_disputes_status
  ON disputes (status);

CREATE INDEX IF NOT EXISTS idx_disputes_priority
  ON disputes (priority);

CREATE INDEX IF NOT EXISTS idx_disputes_created_at
  ON disputes (created_at DESC);

COMMIT;

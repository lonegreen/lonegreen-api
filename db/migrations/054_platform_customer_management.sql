-- Platform customer management soft-status fields.
-- Adds non-destructive controls for suspend/deactivate workflows.

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customer_accounts_status
ON customer_accounts (status);

CREATE INDEX IF NOT EXISTS idx_customer_accounts_deactivated_at
ON customer_accounts (deactivated_at);

UPDATE customer_accounts
SET status = 'active'
WHERE status IS NULL OR TRIM(status) = '';

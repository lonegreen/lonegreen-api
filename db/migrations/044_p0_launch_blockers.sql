-- P0 launch blockers hardening:
-- 1) Atomic invoice numbering counter
-- 2) Subscription billing idempotency uniqueness
-- 3) Durable DB-backed job queue tables

CREATE TABLE IF NOT EXISTS invoice_counters (
  company_id INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO invoice_counters (company_id, last_value)
SELECT
  company_id,
  COALESCE(
    MAX(
      CASE
        WHEN invoice_number ~ ('^INV-' || LPAD(company_id::text, 3, '0') || '-[0-9]+$')
          THEN substring(invoice_number from '[0-9]+$')::int
        ELSE NULL
      END
    ),
    0
  ) AS last_value
FROM invoices
GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE
SET last_value = GREATEST(invoice_counters.last_value, EXCLUDED.last_value),
    updated_at = CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_company_invoice_number_unique'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_company_invoice_number_unique
      UNIQUE (company_id, invoice_number);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscription_billings_company_subscription_month_unique'
  ) THEN
    ALTER TABLE subscription_billings
      ADD CONSTRAINT subscription_billings_company_subscription_month_unique
      UNIQUE (company_id, subscription_id, billing_month);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS background_jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at TIMESTAMP,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  dead_letter_at TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'background_jobs_status_check'
  ) THEN
    ALTER TABLE background_jobs
      ADD CONSTRAINT background_jobs_status_check
      CHECK (status IN ('pending', 'retry', 'running', 'completed', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_background_jobs_status_run_at
ON background_jobs (status, run_at, id);

CREATE INDEX IF NOT EXISTS idx_background_jobs_locked_at
ON background_jobs (locked_at)
WHERE status = 'running';

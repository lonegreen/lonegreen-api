-- Phase 3: Database integrity stabilization.
-- Idempotent, backward-compatible tenant backfills and critical indexes.

UPDATE jobs
SET company_id = clients.company_id
FROM clients
WHERE jobs.client_id = clients.id
  AND jobs.company_id IS NULL
  AND clients.company_id IS NOT NULL;

UPDATE subscriptions
SET company_id = clients.company_id
FROM clients
WHERE subscriptions.client_id = clients.id
  AND subscriptions.company_id IS NULL
  AND clients.company_id IS NOT NULL;

UPDATE estimates
SET company_id = clients.company_id
FROM clients
WHERE estimates.client_id = clients.id
  AND estimates.company_id IS NULL
  AND clients.company_id IS NOT NULL;

UPDATE payments
SET company_id = invoices.company_id
FROM invoices
WHERE payments.invoice_id = invoices.id
  AND payments.company_id IS NULL
  AND invoices.company_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_role_valid_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_valid_check;
  END IF;

  ALTER TABLE users
  ADD CONSTRAINT users_role_valid_check
  CHECK (role IN ('platform_owner', 'owner', 'admin', 'manager', 'worker'));
END $$;

CREATE INDEX IF NOT EXISTS idx_clients_company_id
ON clients (company_id, id);

CREATE INDEX IF NOT EXISTS idx_jobs_company_client_date
ON jobs (company_id, client_id, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_company_worker_date
ON jobs (company_id, worker_id, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_company_status_date
ON jobs (company_id, status, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_company_subscription_date
ON jobs (company_id, source_subscription_id, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_company_job_id
ON invoices (company_id, job_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_company_status_due
ON invoices (company_id, status, due_date, id DESC);

CREATE INDEX IF NOT EXISTS idx_payments_company_invoice_date
ON payments (company_id, invoice_id, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_company_client_id
ON subscriptions (company_id, client_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_company_worker_id
ON subscriptions (company_id, worker_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_company_status_next_date
ON subscriptions (company_id, status, next_date, id DESC);

CREATE INDEX IF NOT EXISTS idx_job_photos_company_job_id
ON job_photos (company_id, job_id, id DESC);

-- A19: Move runtime schema mutations out of schemaService.js.
-- Idempotent consolidation migration for schema pieces previously ensured at runtime.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimate_id INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_subscription_id INTEGER;

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_price NUMERIC DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS visit_date DATE;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'quoted';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS client_id INTEGER;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS record_type TEXT DEFAULT 'lead';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS source_lead_id INTEGER;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS converted_client_id INTEGER;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS converted_job_id INTEGER;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP;

ALTER TABLE estimates ALTER COLUMN client_id DROP NOT NULL;

UPDATE estimates
SET record_type = 'lead'
WHERE record_type IS NULL OR record_type = '';

CREATE TABLE IF NOT EXISTS job_photos (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL,
  photo_type TEXT NOT NULL,
  image_url TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS worker_zip_groups (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  worker_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL
);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billed_month TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billed_at DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billed_date DATE;

UPDATE subscriptions
SET next_billing_date = COALESCE(next_billing_date, next_date, start_date, CURRENT_DATE)
WHERE next_billing_date IS NULL;

CREATE TABLE IF NOT EXISTS subscription_billings (
  id SERIAL PRIMARY KEY,
  subscription_id INTEGER NOT NULL,
  invoice_id INTEGER,
  billing_month TEXT NOT NULL,
  billing_date DATE NOT NULL,
  amount NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'generated',
  notes TEXT,
  company_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_estimates_company_record_type
ON estimates (company_id, record_type, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_company_estimate_id
ON jobs (company_id, estimate_id);

CREATE INDEX IF NOT EXISTS idx_invoices_company_client_id
ON invoices (company_id, client_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_company_source_type
ON invoices (company_id, source_type, issued_date DESC);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id
ON payments (invoice_id, date DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_zip_groups_unique
ON worker_zip_groups (company_id, worker_id, group_id);

CREATE INDEX IF NOT EXISTS idx_subscription_billings_subscription_month
ON subscription_billings (subscription_id, billing_month);

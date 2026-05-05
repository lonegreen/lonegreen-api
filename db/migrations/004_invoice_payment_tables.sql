CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  job_id INTEGER,
  estimate_id INTEGER,
  source_subscription_id INTEGER,
  source_type TEXT DEFAULT 'job',
  invoice_number TEXT,
  status TEXT DEFAULT 'draft',
  issued_date DATE DEFAULT CURRENT_DATE,
  due_date DATE,
  paid_at TIMESTAMP,
  subtotal NUMERIC DEFAULT 0,
  amount NUMERIC DEFAULT 0,
  notes TEXT,
  line_items JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_subscription_id INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'job';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC DEFAULT 0;

UPDATE invoices
SET subtotal = COALESCE(subtotal, amount, 0),
    source_type = COALESCE(NULLIF(source_type, ''), CASE WHEN source_subscription_id IS NOT NULL THEN 'subscription' ELSE 'job' END);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL,
  date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  company_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_run DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pause_reason TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billed_month TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billed_at DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_billed_date DATE;

UPDATE subscriptions
SET next_billing_date = COALESCE(next_billing_date, next_date, start_date, CURRENT_DATE)
WHERE next_billing_date IS NULL;

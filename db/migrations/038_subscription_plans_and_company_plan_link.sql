CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  monthly_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  max_users INTEGER NOT NULL DEFAULT 1,
  max_clients INTEGER NOT NULL DEFAULT 0,
  max_jobs INTEGER NOT NULL DEFAULT 0,
  max_invoices INTEGER NOT NULL DEFAULT 0,
  max_workers INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO subscription_plans (
  name,
  slug,
  monthly_price,
  max_users,
  max_clients,
  max_jobs,
  max_invoices,
  max_workers,
  active
)
VALUES
  ('Starter', 'starter', 29.00, 1, 250, 500, 500, 3, TRUE),
  ('Pro', 'pro', 99.00, 5, 2500, 5000, 5000, 20, TRUE),
  ('Growth', 'growth', 249.00, 25, 20000, 50000, 50000, 100, TRUE)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  monthly_price = EXCLUDED.monthly_price,
  max_users = EXCLUDED.max_users,
  max_clients = EXCLUDED.max_clients,
  max_jobs = EXCLUDED.max_jobs,
  max_invoices = EXCLUDED.max_invoices,
  max_workers = EXCLUDED.max_workers,
  active = EXCLUDED.active;

ALTER TABLE companies
ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES subscription_plans(id);

ALTER TABLE companies
ADD COLUMN IF NOT EXISTS billing_status TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_plan_id
ON companies (plan_id);

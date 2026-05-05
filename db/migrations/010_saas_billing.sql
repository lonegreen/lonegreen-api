ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_status TEXT DEFAULT 'trial';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_started_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_cancelled_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS monthly_price NUMERIC DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_users INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_clients INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_jobs_per_month INTEGER;

UPDATE companies
SET plan = 'starter'
WHERE plan IS NULL OR plan = '';

UPDATE companies
SET billing_status = 'trial'
WHERE billing_status IS NULL OR billing_status = '';

UPDATE companies
SET trial_ends_at = CURRENT_TIMESTAMP + INTERVAL '14 days'
WHERE trial_ends_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_companies_plan
ON companies (plan);

CREATE INDEX IF NOT EXISTS idx_companies_billing_status
ON companies (billing_status);

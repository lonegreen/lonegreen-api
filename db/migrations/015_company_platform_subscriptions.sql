CREATE TABLE IF NOT EXISTS company_subscriptions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'trialing',
  billing_status TEXT NOT NULL DEFAULT 'trialing',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  price_monthly NUMERIC NOT NULL DEFAULT 0,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT company_subscriptions_plan_check
    CHECK (plan IN ('starter', 'pro', 'enterprise')),
  CONSTRAINT company_subscriptions_status_check
    CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  CONSTRAINT company_subscriptions_billing_status_check
    CHECK (billing_status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  CONSTRAINT company_subscriptions_billing_cycle_check
    CHECK (billing_cycle IN ('monthly', 'yearly'))
);

DROP INDEX IF EXISTS idx_company_subscriptions_one_open;

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_subscriptions_one_open
ON company_subscriptions (company_id)
WHERE status IN ('trialing', 'active', 'past_due')
   OR billing_status IN ('trialing', 'active', 'past_due');

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company_id
ON company_subscriptions (company_id);

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_status
ON company_subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_current_period_end
ON company_subscriptions (current_period_end);

INSERT INTO company_subscriptions (
  company_id,
  plan,
  status,
  billing_status,
  billing_cycle,
  price_monthly,
  trial_started_at,
  trial_ends_at,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  cancelled_at,
  created_at,
  updated_at
)
SELECT
  c.id,
  CASE WHEN c.plan IN ('starter', 'pro', 'enterprise') THEN c.plan ELSE 'starter' END,
  CASE
    WHEN c.billing_status = 'active' THEN 'active'
    WHEN c.billing_status = 'past_due' THEN 'past_due'
    WHEN c.billing_status = 'cancelled' THEN 'cancelled'
    WHEN c.trial_ends_at IS NOT NULL AND c.trial_ends_at < CURRENT_TIMESTAMP THEN 'expired'
    ELSE 'trialing'
  END,
  CASE
    WHEN c.billing_status = 'active' THEN 'active'
    WHEN c.billing_status = 'past_due' THEN 'past_due'
    WHEN c.billing_status = 'cancelled' THEN 'cancelled'
    WHEN c.trial_ends_at IS NOT NULL AND c.trial_ends_at < CURRENT_TIMESTAMP THEN 'expired'
    ELSE 'trialing'
  END,
  'monthly',
  COALESCE(c.monthly_price, CASE
    WHEN c.plan = 'enterprise' THEN 149
    WHEN c.plan = 'pro' THEN 49
    ELSE 0
  END),
  CASE WHEN c.trial_ends_at IS NOT NULL THEN COALESCE(c.created_at, CURRENT_TIMESTAMP) ELSE NULL END,
  c.trial_ends_at,
  COALESCE(c.billing_started_at, c.created_at, CURRENT_TIMESTAMP),
  CASE
    WHEN c.billing_status = 'active' THEN CURRENT_TIMESTAMP + INTERVAL '1 month'
    ELSE c.trial_ends_at
  END,
  FALSE,
  c.billing_cancelled_at,
  COALESCE(c.created_at, CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM companies c
WHERE NOT EXISTS (
  SELECT 1
  FROM company_subscriptions cs
  WHERE cs.company_id = c.id
);

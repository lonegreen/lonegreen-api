-- Phase 8: billing period end + expanded subscription state machine.
-- Safe/idempotent: no table drops, no destructive rewrites.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_period_end TIMESTAMPTZ;

UPDATE companies
SET billing_period_end = stripe_current_period_end
WHERE billing_period_end IS NULL
  AND stripe_current_period_end IS NOT NULL;

UPDATE company_subscriptions
SET status = CASE
      WHEN status = 'canceled' THEN 'cancelled'
      WHEN status = 'trial' THEN 'trialing'
      WHEN status = 'suspended' THEN 'past_due'
      WHEN status = 'incomplete_expired' THEN 'expired'
      ELSE status
    END,
    billing_status = CASE
      WHEN billing_status = 'canceled' THEN 'cancelled'
      WHEN billing_status = 'trial' THEN 'trialing'
      WHEN billing_status = 'suspended' THEN 'past_due'
      WHEN billing_status = 'incomplete_expired' THEN 'expired'
      ELSE billing_status
    END
WHERE status IN ('canceled', 'trial', 'suspended', 'incomplete_expired')
   OR billing_status IN ('canceled', 'trial', 'suspended', 'incomplete_expired');

ALTER TABLE company_subscriptions DROP CONSTRAINT IF EXISTS company_subscriptions_status_check;
ALTER TABLE company_subscriptions DROP CONSTRAINT IF EXISTS company_subscriptions_billing_status_check;

ALTER TABLE company_subscriptions ADD CONSTRAINT company_subscriptions_status_check
  CHECK (status IN (
    'trialing',
    'active',
    'past_due',
    'cancelled',
    'expired',
    'unpaid',
    'incomplete',
    'paused'
  ));

ALTER TABLE company_subscriptions ADD CONSTRAINT company_subscriptions_billing_status_check
  CHECK (billing_status IN (
    'trialing',
    'active',
    'past_due',
    'cancelled',
    'expired',
    'unpaid',
    'incomplete',
    'paused'
  ));

DROP INDEX IF EXISTS idx_company_subscriptions_one_open;

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_subscriptions_one_open
ON company_subscriptions (company_id)
WHERE status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused')
   OR billing_status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused');

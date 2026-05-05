-- Group 6C: payment lifecycle automation fields (non-destructive).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_grace_until TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_last_payment_failed_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_last_payment_succeeded_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_suspended_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_billing_grace_until
ON companies (billing_grace_until)
WHERE billing_status = 'past_due';

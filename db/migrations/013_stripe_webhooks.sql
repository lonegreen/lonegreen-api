-- Group 6B: Stripe webhooks + subscription sync (non-destructive).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_current_period_end TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_plan_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_stripe_subscription_id_unique
ON companies (stripe_subscription_id)
WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> '';

CREATE TABLE IF NOT EXISTS stripe_processed_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stripe_processed_events_received_at
ON stripe_processed_events (received_at);

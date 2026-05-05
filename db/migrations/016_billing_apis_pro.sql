ALTER TABLE company_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE company_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE company_subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE company_subscriptions ADD COLUMN IF NOT EXISTS stripe_plan_key TEXT;
ALTER TABLE company_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_subscriptions_stripe_subscription_id_unique
ON company_subscriptions (stripe_subscription_id)
WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> '';

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_stripe_customer_id
ON company_subscriptions (stripe_customer_id)
WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> '';

CREATE TABLE IF NOT EXISTS stripe_events (
  id SERIAL PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_processed_at
ON stripe_events (processed_at);

INSERT INTO stripe_events (stripe_event_id, event_type, processed_at, created_at)
SELECT stripe_event_id, event_type, received_at, received_at
FROM stripe_processed_events
ON CONFLICT (stripe_event_id) DO NOTHING;

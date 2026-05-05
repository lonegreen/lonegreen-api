-- Group C: billing production hardening (non-destructive).

ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS object_id TEXT;
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS retryable BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_stripe_events_company_id
ON stripe_events (company_id)
WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_events_object_id
ON stripe_events (object_id)
WHERE object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_events_retryable
ON stripe_events (retryable, created_at)
WHERE retryable = TRUE AND processed_at IS NULL;

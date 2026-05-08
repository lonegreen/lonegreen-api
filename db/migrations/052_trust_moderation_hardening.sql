CREATE TABLE IF NOT EXISTS trust_moderation_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR NOT NULL,
  target_type VARCHAR NOT NULL,
  target_id INTEGER,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trust_moderation_events_company_created
  ON trust_moderation_events(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trust_moderation_events_event_type
  ON trust_moderation_events(event_type);

ALTER TABLE company_reports
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

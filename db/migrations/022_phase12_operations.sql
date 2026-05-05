-- Phase 12: operations — client contact email, notification metadata, internal error logs.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_notifications_company_unread
ON notifications (company_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS error_logs (
  id BIGSERIAL PRIMARY KEY,
  route TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  stack TEXT,
  company_id INTEGER,
  user_id INTEGER,
  severity TEXT NOT NULL DEFAULT 'error',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_error_logs_created
ON error_logs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_company
ON error_logs (company_id, created_at DESC);

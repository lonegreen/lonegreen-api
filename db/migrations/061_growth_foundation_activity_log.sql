-- Phase 0 growth foundation: allow platform-scoped rows in activity_log (NULL company_id).
-- Existing company-scoped rows are unchanged; application writes still pass company_id for tenant events.

ALTER TABLE activity_log
  ALTER COLUMN company_id DROP NOT NULL;

COMMENT ON COLUMN activity_log.company_id IS 'Tenant scope when set; NULL reserved for platform-scoped foundation events (e.g. marketplace_request_created).';

CREATE INDEX IF NOT EXISTS idx_activity_log_platform_created_at
ON activity_log (created_at DESC)
WHERE company_id IS NULL;

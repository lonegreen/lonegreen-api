-- Phase 11: platform suspension + platform audit trail (non-destructive).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS platform_suspended_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS platform_suspension_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_platform_suspended_at
ON companies (platform_suspended_at)
WHERE platform_suspended_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_company_audit (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_company_audit_company
ON platform_company_audit (company_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_platform_company_audit_created
ON platform_company_audit (created_at DESC, id DESC);

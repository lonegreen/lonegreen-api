-- Phase 12: production hardening bundle (additive only)

ALTER TABLE company_invites
  ADD COLUMN IF NOT EXISTS accepted_by_platform_user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS accepted_company_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS acceptance_notes TEXT;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS reputation_last_calculated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS reputation_score_audits (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  score NUMERIC(5,2) NOT NULL DEFAULT 0,
  factors JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_score_audits_company_id ON reputation_score_audits(company_id);
CREATE INDEX IF NOT EXISTS idx_reputation_score_audits_calculated_at ON reputation_score_audits(calculated_at);

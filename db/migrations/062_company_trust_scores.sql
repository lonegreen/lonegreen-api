-- Phase 1 trust + reputation snapshot cache (optional persistence from platform recompute).

CREATE TABLE IF NOT EXISTS company_trust_scores (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  trust_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  reputation_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  badges JSONB NOT NULL DEFAULT '[]'::jsonb,
  components JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_trust_scores_calculated_at
ON company_trust_scores (calculated_at DESC);

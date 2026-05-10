-- Phase 5: persisted marketplace ranking snapshot (additive).

CREATE TABLE IF NOT EXISTS company_marketplace_rankings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  ranking_score NUMERIC(10,4) NOT NULL DEFAULT 50,
  ranking_components JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_marketplace_rankings_score_desc
  ON company_marketplace_rankings (ranking_score DESC);

CREATE INDEX IF NOT EXISTS idx_company_marketplace_rankings_calculated_at
  ON company_marketplace_rankings (calculated_at DESC);

CREATE TABLE IF NOT EXISTS company_reviews (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_company_reviews_company_public_created
ON company_reviews (company_id, is_public, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_reviews_client
ON company_reviews (client_id);

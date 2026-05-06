CREATE TABLE IF NOT EXISTS marketplace_offers (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  price NUMERIC(12, 2) NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  estimated_start_date DATE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_marketplace_offers_status
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT ux_marketplace_offers_request_company
    UNIQUE (request_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_offers_request_created
ON marketplace_offers (request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_offers_company_created
ON marketplace_offers (company_id, created_at DESC);

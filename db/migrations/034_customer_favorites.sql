CREATE TABLE IF NOT EXISTS customer_favorites (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_favorites_client_created
ON customer_favorites (client_id, created_at DESC);

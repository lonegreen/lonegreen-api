CREATE TABLE IF NOT EXISTS customer_company_follows (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_company_follows_client_created
ON customer_company_follows (client_id, created_at DESC);

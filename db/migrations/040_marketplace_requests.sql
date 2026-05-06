CREATE TABLE IF NOT EXISTS marketplace_requests (
  id SERIAL PRIMARY KEY,
  customer_account_id INTEGER REFERENCES customer_accounts(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  requested_date DATE,
  requested_time TEXT,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_marketplace_requests_status
    CHECK (status IN ('open', 'matched', 'closed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_requests_client_created
ON marketplace_requests (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_requests_customer_account_created
ON marketplace_requests (customer_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_requests_status_created
ON marketplace_requests (status, created_at DESC);

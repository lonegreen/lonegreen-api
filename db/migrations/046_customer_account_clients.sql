-- Links one customer_account to multiple clients rows (one per tenant company).
-- Enables marketplace conversions to attach company-specific clients without breaking portal identity.

CREATE TABLE IF NOT EXISTS customer_account_clients (
  customer_account_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_account_id, client_id),
  CONSTRAINT uq_customer_account_clients_client UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_account_clients_account
ON customer_account_clients (customer_account_id);

CREATE INDEX IF NOT EXISTS idx_customer_account_clients_company
ON customer_account_clients (company_id);

-- Backfill: primary client row already on customer_accounts
INSERT INTO customer_account_clients (customer_account_id, client_id, company_id)
SELECT ca.id, ca.client_id, c.company_id
FROM customer_accounts ca
INNER JOIN clients c ON c.id = ca.client_id
WHERE ca.client_id IS NOT NULL
ON CONFLICT (customer_account_id, client_id) DO NOTHING;

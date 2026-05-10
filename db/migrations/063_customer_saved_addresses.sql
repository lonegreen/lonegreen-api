-- Phase 3: optional multi-address book per client per company (portal + retention).

CREATE TABLE IF NOT EXISTS customer_saved_addresses (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_account_id INTEGER REFERENCES customer_accounts(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_customer_saved_addresses_actor
    CHECK (client_id IS NOT NULL OR customer_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_customer_saved_addresses_company_client
ON customer_saved_addresses (company_id, client_id);

CREATE INDEX IF NOT EXISTS idx_customer_saved_addresses_company_account
ON customer_saved_addresses (company_id, customer_account_id);

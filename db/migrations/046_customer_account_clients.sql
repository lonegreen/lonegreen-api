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

-- Backfill: primary client row already on customer_accounts.
--
-- Tenant isolation guard:
--   The legacy clients table allows clients.company_id to be NULL (no NOT NULL
--   constraint declared in earlier migrations). The new customer_account_clients
--   table requires company_id NOT NULL (we WILL NOT relax that). Therefore any
--   customer_account whose linked client row has NULL company_id is an ORPHAN
--   that cannot be safely attributed to any tenant.
--
--   We deliberately SKIP those rows here. Linking an orphan to "some" company
--   would silently leak that customer's portal scope into the wrong tenant.
--   Operators can re-run the backfill after the orphan clients are repaired
--   (clients.company_id populated) — the ON CONFLICT clause keeps re-runs safe.
--
-- Idempotency: ON CONFLICT DO NOTHING (no target) covers both unique
-- constraints on this table — the primary key (customer_account_id, client_id)
-- and uq_customer_account_clients_client (client_id) — so re-running the
-- migration after partial application or after manual repairs never errors.
INSERT INTO customer_account_clients (customer_account_id, client_id, company_id)
SELECT ca.id, ca.client_id, c.company_id
FROM customer_accounts ca
INNER JOIN clients c ON c.id = ca.client_id
WHERE ca.client_id IS NOT NULL
  AND c.company_id IS NOT NULL
ON CONFLICT DO NOTHING;

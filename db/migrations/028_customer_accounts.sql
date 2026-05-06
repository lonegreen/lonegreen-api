CREATE TABLE IF NOT EXISTS customer_accounts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER UNIQUE REFERENCES clients(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_accounts_email
ON customer_accounts (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_customer_accounts_client_id
ON customer_accounts (client_id);

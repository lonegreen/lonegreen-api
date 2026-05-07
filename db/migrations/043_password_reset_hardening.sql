-- Password reset hardening:
-- 1) staff reset delivery requires users.email
-- 2) hashed token storage support
-- 3) one-time + expiry behavior support

ALTER TABLE users
ADD COLUMN IF NOT EXISTS email TEXT;

CREATE INDEX IF NOT EXISTS idx_users_email_lower
ON users (LOWER(email))
WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT,
  code_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE password_resets
ADD COLUMN IF NOT EXISTS code_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_password_resets_user_id
ON password_resets (user_id);

CREATE INDEX IF NOT EXISTS idx_password_resets_code_hash
ON password_resets (code_hash);

DELETE FROM password_resets
WHERE used = FALSE;

ALTER TABLE customer_accounts
ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_customer_accounts_reset_token_hash
ON customer_accounts (reset_token_hash)
WHERE reset_token_hash IS NOT NULL;

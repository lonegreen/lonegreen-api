
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS worker_id INTEGER;

UPDATE users SET active = TRUE WHERE active IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_company_active
ON users (company_id, active);

CREATE INDEX IF NOT EXISTS idx_users_company_role
ON users (company_id, role);

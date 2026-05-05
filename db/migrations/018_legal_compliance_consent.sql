ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_users_legal_consent_versions
ON users (terms_version, privacy_version);

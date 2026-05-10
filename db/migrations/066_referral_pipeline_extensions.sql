-- Phase 4 referral pipeline: company-scoped customer codes, journey states, conversions.

ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS chk_referral_codes_owner_shape;

ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS scope_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE referral_codes ADD CONSTRAINT chk_referral_codes_owner_shape CHECK (
  (owner_type = 'company' AND owner_company_id IS NOT NULL AND owner_customer_account_id IS NULL AND owner_user_id IS NULL AND scope_company_id IS NULL)
  OR (owner_type = 'customer' AND owner_customer_account_id IS NOT NULL AND owner_company_id IS NULL AND owner_user_id IS NULL)
  OR (owner_type = 'user' AND owner_user_id IS NOT NULL AND owner_company_id IS NULL AND owner_customer_account_id IS NULL AND scope_company_id IS NULL)
);

DROP INDEX IF EXISTS idx_referral_codes_one_active_customer;

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_customer_scope_active
ON referral_codes (owner_customer_account_id, COALESCE(scope_company_id, 0))
WHERE owner_type = 'customer' AND status = 'active';

ALTER TABLE referrals ADD COLUMN IF NOT EXISTS journey_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE referrals DROP CONSTRAINT IF EXISTS chk_referrals_journey_status;

ALTER TABLE referrals ADD CONSTRAINT chk_referrals_journey_status CHECK (
  journey_status IN ('pending', 'visited', 'lead_created', 'request_created', 'converted', 'expired', 'cancelled')
);

CREATE TABLE IF NOT EXISTS referral_conversions (
  id SERIAL PRIMARY KEY,
  referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_conversions_referral ON referral_conversions(referral_id);
CREATE INDEX IF NOT EXISTS idx_referral_conversions_client ON referral_conversions(client_id);

CREATE OR REPLACE VIEW customer_referral_codes AS
SELECT
  rc.id,
  rc.owner_customer_account_id AS customer_account_id,
  rc.scope_company_id AS company_id,
  rc.code,
  rc.id AS referral_code_id,
  rc.status,
  rc.created_at,
  rc.updated_at
FROM referral_codes rc
WHERE rc.owner_type = 'customer';

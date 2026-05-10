-- Phase 4: referral engine — codes, referrals, events, optional rewards.

CREATE TABLE IF NOT EXISTS referral_codes (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('company', 'customer', 'user')),
  owner_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  owner_customer_account_id INTEGER REFERENCES customer_accounts(id) ON DELETE CASCADE,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_referral_codes_owner_shape CHECK (
    (owner_type = 'company' AND owner_company_id IS NOT NULL AND owner_customer_account_id IS NULL AND owner_user_id IS NULL)
    OR (owner_type = 'customer' AND owner_customer_account_id IS NOT NULL AND owner_company_id IS NULL AND owner_user_id IS NULL)
    OR (owner_type = 'user' AND owner_user_id IS NOT NULL AND owner_company_id IS NULL AND owner_customer_account_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_upper ON referral_codes (UPPER(code));

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_one_active_company
ON referral_codes (owner_company_id)
WHERE owner_type = 'company' AND status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_one_active_customer
ON referral_codes (owner_customer_account_id)
WHERE owner_type = 'customer' AND status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_one_active_user
ON referral_codes (owner_user_id)
WHERE owner_type = 'user' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_referral_codes_owner_company ON referral_codes (owner_company_id)
WHERE owner_company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_referral_codes_owner_customer ON referral_codes (owner_customer_account_id)
WHERE owner_customer_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  code_id INTEGER NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT,
  referred_type TEXT NOT NULL CHECK (referred_type IN ('company', 'customer')),
  referred_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  referred_customer_account_id INTEGER REFERENCES customer_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rejected', 'rewarded')),
  qualification_event TEXT,
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_referrals_referred_shape CHECK (
    (referred_type = 'company' AND referred_company_id IS NOT NULL AND referred_customer_account_id IS NULL)
    OR (referred_type = 'customer' AND referred_customer_account_id IS NOT NULL AND referred_company_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_unique_referred_company
ON referrals (code_id, referred_company_id)
WHERE referred_company_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_unique_referred_customer
ON referrals (code_id, referred_customer_account_id)
WHERE referred_customer_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_referrals_code_id ON referrals (code_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status);

CREATE TABLE IF NOT EXISTS referral_events (
  id SERIAL PRIMARY KEY,
  referral_id INTEGER REFERENCES referrals(id) ON DELETE SET NULL,
  code_id INTEGER REFERENCES referral_codes(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_events_code ON referral_events (code_id);
CREATE INDEX IF NOT EXISTS idx_referral_events_referral ON referral_events (referral_id);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id SERIAL PRIMARY KEY,
  referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL DEFAULT 'eligibility',
  reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (reward_status IN ('pending', 'approved', 'issued', 'cancelled')),
  reward_amount NUMERIC(14, 2),
  reward_unit TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_referral ON referral_rewards (referral_id);

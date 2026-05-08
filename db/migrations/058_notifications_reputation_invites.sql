-- Phase 11: notifications + reputation + invites foundations (additive only)

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NULL,
  user_id INTEGER NULL,
  customer_id INTEGER NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link_url TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS company_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS customer_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS link_url TEXT,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

ALTER TABLE notifications
  ALTER COLUMN created_at SET DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'notifications'
      AND column_name = 'message'
  ) THEN
    EXECUTE 'UPDATE notifications SET body = COALESCE(body, message) WHERE body IS NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'notifications'
      AND column_name = 'is_read'
  ) THEN
    EXECUTE 'UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE read_at IS NULL AND is_read = TRUE';
  END IF;
END $$;

-- B. Normalize legacy notification types before any CHECK on type (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  END IF;
END $$;

UPDATE notifications
SET type = CASE
  WHEN type IS NULL THEN 'system'
  WHEN lower(trim(type)) IN (
    'marketplace', 'support', 'dispute', 'verification', 'billing', 'system'
  ) THEN lower(trim(type))
  ELSE 'system'
END;

UPDATE notifications
SET title = 'Notification'
WHERE COALESCE(NULLIF(TRIM(title), ''), '') = '';

ALTER TABLE notifications
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

-- C. Recreate notifications_type_check after normalization (drop first avoids duplicates / stale defs).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  END IF;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('marketplace', 'support', 'dispute', 'verification', 'billing', 'system'));

-- D. Indexes after constraints.
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON notifications(customer_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS reputation_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reputation_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS company_invites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NULL,
  invited_email TEXT NOT NULL,
  invited_by_user_id INTEGER NULL,
  invite_type TEXT NOT NULL DEFAULT 'founding_partner',
  status TEXT NOT NULL DEFAULT 'pending',
  token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ
);

ALTER TABLE company_invites
  ADD COLUMN IF NOT EXISTS company_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS invited_email TEXT,
  ADD COLUMN IF NOT EXISTS invited_by_user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS invite_type TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS token_hash TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

-- B. Normalize invite_type / status before CHECK constraints (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_invites_type_check'
      AND conrelid = 'company_invites'::regclass
  ) THEN
    ALTER TABLE company_invites DROP CONSTRAINT company_invites_type_check;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_invites_status_check'
      AND conrelid = 'company_invites'::regclass
  ) THEN
    ALTER TABLE company_invites DROP CONSTRAINT company_invites_status_check;
  END IF;
END $$;

UPDATE company_invites
SET invite_type = CASE
  WHEN invite_type IS NULL THEN 'founding_partner'
  WHEN lower(trim(invite_type)) IN ('founding_partner', 'company_user', 'referral') THEN lower(trim(invite_type))
  ELSE 'founding_partner'
END;

UPDATE company_invites
SET status = CASE
  WHEN status IS NULL THEN 'pending'
  WHEN lower(trim(status)) IN ('pending', 'accepted', 'expired', 'canceled') THEN lower(trim(status))
  ELSE 'pending'
END;

ALTER TABLE company_invites
  ALTER COLUMN invited_email SET NOT NULL,
  ALTER COLUMN invite_type SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_invites_type_check'
      AND conrelid = 'company_invites'::regclass
  ) THEN
    ALTER TABLE company_invites DROP CONSTRAINT company_invites_type_check;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_invites_status_check'
      AND conrelid = 'company_invites'::regclass
  ) THEN
    ALTER TABLE company_invites DROP CONSTRAINT company_invites_status_check;
  END IF;
END $$;

ALTER TABLE company_invites
  ADD CONSTRAINT company_invites_type_check
  CHECK (invite_type IN ('founding_partner', 'company_user', 'referral'));

ALTER TABLE company_invites
  ADD CONSTRAINT company_invites_status_check
  CHECK (status IN ('pending', 'accepted', 'expired', 'canceled'));

CREATE INDEX IF NOT EXISTS idx_company_invites_company_id ON company_invites(company_id);
CREATE INDEX IF NOT EXISTS idx_company_invites_invited_email ON company_invites(invited_email);
CREATE INDEX IF NOT EXISTS idx_company_invites_status ON company_invites(status);
CREATE INDEX IF NOT EXISTS idx_company_invites_invite_type ON company_invites(invite_type);
CREATE INDEX IF NOT EXISTS idx_company_invites_created_at ON company_invites(created_at);

-- Adds email-OTP login support to customer_accounts.
-- Backward compatible: existing email+password login (POST /auth/customer-login)
-- continues to work; OTP fields are optional state on the existing row, used
-- only by the new email+OTP login flow (POST /auth/customer-otp/request and
-- POST /auth/customer-otp/verify).
--
-- Columns:
--   customer_email_verified     - flipped to TRUE the first time the customer
--                                 successfully verifies an OTP for their email.
--   customer_otp_hash           - bcrypt hash of the active 6-digit code
--                                 (NULL when no code is outstanding).
--   customer_otp_expires_at     - UTC expiry; codes are valid for 10 minutes.
--   customer_otp_attempts       - per-issued-code verify counter; OTP is
--                                 invalidated after 5 failed attempts.
--   customer_otp_last_sent_at   - per-account resend throttle anchor; new
--                                 codes within RESEND_THROTTLE_SECONDS are
--                                 rejected before any email is queued.

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS customer_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS customer_otp_hash TEXT,
  ADD COLUMN IF NOT EXISTS customer_otp_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_otp_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_otp_last_sent_at TIMESTAMPTZ;

-- Speeds the resend-throttle and active-OTP lookups during /auth/customer-otp/* flows.
CREATE INDEX IF NOT EXISTS idx_customer_accounts_otp_active
  ON customer_accounts (customer_otp_expires_at)
  WHERE customer_otp_hash IS NOT NULL;

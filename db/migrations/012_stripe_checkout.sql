-- Group 6A: Stripe Checkout — store Stripe Customer ID per company (no destructive changes).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_stripe_customer_id_unique
ON companies (stripe_customer_id)
WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> '';

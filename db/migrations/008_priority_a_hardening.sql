UPDATE users
SET role = 'admin'
WHERE role IS NULL
   OR role = ''
   OR role NOT IN ('platform_owner', 'owner', 'admin', 'manager', 'worker');

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'admin';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_role_valid_check'
  ) THEN
    ALTER TABLE users
    ADD CONSTRAINT users_role_valid_check
    CHECK (role IN ('platform_owner', 'owner', 'admin', 'manager', 'worker'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_company_invoice_number_unique'
  ) THEN
    ALTER TABLE invoices
    ADD CONSTRAINT invoices_company_invoice_number_unique
    UNIQUE (company_id, invoice_number);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscription_billings_company_subscription_month_unique'
  ) THEN
    ALTER TABLE subscription_billings
    ADD CONSTRAINT subscription_billings_company_subscription_month_unique
    UNIQUE (company_id, subscription_id, billing_month);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_amount_positive_check'
  ) THEN
    ALTER TABLE payments
    ADD CONSTRAINT payments_amount_positive_check
    CHECK (amount > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_amount_nonnegative_check'
  ) THEN
    ALTER TABLE invoices
    ADD CONSTRAINT invoices_amount_nonnegative_check
    CHECK (amount >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_status_valid_check'
  ) THEN
    ALTER TABLE invoices
    ADD CONSTRAINT invoices_status_valid_check
    CHECK (status IN ('draft', 'unpaid', 'paid', 'overdue', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_method_valid_check'
  ) THEN
    ALTER TABLE payments
    ADD CONSTRAINT payments_method_valid_check
    CHECK (method IN ('cash', 'zelle', 'card'));
  END IF;
END $$;

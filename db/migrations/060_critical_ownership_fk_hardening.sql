-- Phase 13: critical ownership FK hardening (additive, idempotent, safe-staged).
--
-- Scope: critical ownership tables only — users, clients, jobs, invoices,
-- payments, subscriptions. Adds missing tenant/parent foreign keys that were
-- never declared in the original 001_base_tables.sql (and were intentionally
-- left off later additive migrations to avoid blocking on legacy orphan rows).
--
-- Safety contract:
--   * Additive only. Does not modify column types, defaults, or nullability.
--   * Each constraint is added inside a DO block that:
--       1. exits silently if the constraint already exists,
--       2. counts orphan rows for the (column -> parent) pair,
--       3. RAISES NOTICE and SKIPS the constraint if orphans are found
--          (so production data is preserved and the migration never aborts),
--       4. otherwise creates the FK with the appropriate ON DELETE rule.
--   * Companies are protected by ON DELETE RESTRICT for billing-critical rows
--     (clients, jobs, invoices, payments, subscriptions) so a tenant company
--     cannot be hard-deleted while still owning rows.
--   * users.company_id uses ON DELETE SET NULL because platform_owner accounts
--     legitimately have no company and we must not lock the account row to a
--     specific tenant lifecycle.
--   * NOT VALID is intentionally NOT used: we only add the constraint when the
--     orphan check shows the data is already clean for that pair, so the FK is
--     fully validated from the moment it is created.
--
-- Operator workflow if a NOTICE reports skipped constraints:
--   1. Run scripts/fk-preflight-audit.js to enumerate orphan rows.
--   2. Repair the orphan data (re-attribute or remove dangling references).
--   3. Re-run migrations — this file is idempotent and will pick up any
--      constraints that are now safe to add.

-- ---------------------------------------------------------------------------
-- users.company_id -> companies(id) ON DELETE SET NULL
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_company_id'
  ) THEN
    RAISE NOTICE 'fk_users_company_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM users u
    WHERE u.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = u.company_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_users_company_id: % orphan users.company_id rows detected. Run scripts/fk-preflight-audit.js and repair before re-running migrations.', orphan_count;
    ELSE
      ALTER TABLE users
        ADD CONSTRAINT fk_users_company_id
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
      RAISE NOTICE 'fk_users_company_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- clients.company_id -> companies(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_clients_company_id'
  ) THEN
    RAISE NOTICE 'fk_clients_company_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM clients c
    WHERE c.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_clients_company_id: % orphan clients.company_id rows detected. Run scripts/fk-preflight-audit.js and repair before re-running migrations.', orphan_count;
    ELSE
      ALTER TABLE clients
        ADD CONSTRAINT fk_clients_company_id
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_clients_company_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- jobs.company_id -> companies(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_jobs_company_id'
  ) THEN
    RAISE NOTICE 'fk_jobs_company_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM jobs j
    WHERE j.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = j.company_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_jobs_company_id: % orphan jobs.company_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE jobs
        ADD CONSTRAINT fk_jobs_company_id
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_jobs_company_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- jobs.client_id -> clients(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_jobs_client_id'
  ) THEN
    RAISE NOTICE 'fk_jobs_client_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM jobs j
    WHERE j.client_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = j.client_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_jobs_client_id: % orphan jobs.client_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE jobs
        ADD CONSTRAINT fk_jobs_client_id
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_jobs_client_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- invoices.company_id -> companies(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_company_id'
  ) THEN
    RAISE NOTICE 'fk_invoices_company_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM invoices i
    WHERE i.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = i.company_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_invoices_company_id: % orphan invoices.company_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE invoices
        ADD CONSTRAINT fk_invoices_company_id
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_invoices_company_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- invoices.client_id -> clients(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_client_id'
  ) THEN
    RAISE NOTICE 'fk_invoices_client_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM invoices i
    WHERE i.client_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = i.client_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_invoices_client_id: % orphan invoices.client_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE invoices
        ADD CONSTRAINT fk_invoices_client_id
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_invoices_client_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- payments.company_id -> companies(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_company_id'
  ) THEN
    RAISE NOTICE 'fk_payments_company_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM payments p
    WHERE p.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.company_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_payments_company_id: % orphan payments.company_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE payments
        ADD CONSTRAINT fk_payments_company_id
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_payments_company_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- payments.invoice_id -> invoices(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_invoice_id'
  ) THEN
    RAISE NOTICE 'fk_payments_invoice_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM payments p
    WHERE p.invoice_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = p.invoice_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_payments_invoice_id: % orphan payments.invoice_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE payments
        ADD CONSTRAINT fk_payments_invoice_id
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_payments_invoice_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- subscriptions.company_id -> companies(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscriptions_company_id'
  ) THEN
    RAISE NOTICE 'fk_subscriptions_company_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM subscriptions s
    WHERE s.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = s.company_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_subscriptions_company_id: % orphan subscriptions.company_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE subscriptions
        ADD CONSTRAINT fk_subscriptions_company_id
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_subscriptions_company_id added';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- subscriptions.client_id -> clients(id) ON DELETE RESTRICT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscriptions_client_id'
  ) THEN
    RAISE NOTICE 'fk_subscriptions_client_id already present; skipping';
  ELSE
    SELECT COUNT(*) INTO orphan_count
    FROM subscriptions s
    WHERE s.client_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = s.client_id);

    IF orphan_count > 0 THEN
      RAISE NOTICE 'Skipping fk_subscriptions_client_id: % orphan subscriptions.client_id rows detected.', orphan_count;
    ELSE
      ALTER TABLE subscriptions
        ADD CONSTRAINT fk_subscriptions_client_id
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
      RAISE NOTICE 'fk_subscriptions_client_id added';
    END IF;
  END IF;
END $$;

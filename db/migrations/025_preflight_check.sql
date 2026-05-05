-- Preflight checks for 008_priority_a_hardening.sql
-- Read-only: these queries do not modify data.

-- 1. Duplicate invoice numbers by company
SELECT
  company_id,
  invoice_number,
  COUNT(*) AS duplicate_count,
  ARRAY_AGG(id ORDER BY id) AS invoice_ids
FROM invoices
WHERE invoice_number IS NOT NULL
GROUP BY company_id, invoice_number
HAVING COUNT(*) > 1
ORDER BY company_id, invoice_number;

-- 2. Duplicate subscription billing month rows
SELECT
  company_id,
  subscription_id,
  billing_month,
  COUNT(*) AS duplicate_count,
  ARRAY_AGG(id ORDER BY id) AS billing_ids
FROM subscription_billings
GROUP BY company_id, subscription_id, billing_month
HAVING COUNT(*) > 1
ORDER BY company_id, subscription_id, billing_month;

-- 3. Payments with amount <= 0
SELECT
  id,
  company_id,
  invoice_id,
  amount,
  method,
  date,
  created_at
FROM payments
WHERE amount <= 0
ORDER BY company_id, id;

-- 4. Invoices with amount < 0
SELECT
  id,
  company_id,
  invoice_number,
  status,
  amount,
  issued_date,
  created_at
FROM invoices
WHERE amount < 0
ORDER BY company_id, id;

-- 5. Invalid invoice statuses
SELECT
  id,
  company_id,
  invoice_number,
  status,
  amount,
  created_at
FROM invoices
WHERE status IS NULL
   OR status NOT IN ('draft', 'unpaid', 'paid', 'overdue', 'cancelled')
ORDER BY company_id, id;

-- 6. Invalid payment methods
SELECT
  id,
  company_id,
  invoice_id,
  amount,
  method,
  date,
  created_at
FROM payments
WHERE method IS NULL
   OR method NOT IN ('cash', 'zelle', 'card')
ORDER BY company_id, id;

-- 7. Invalid or null user roles
SELECT
  id,
  company_id,
  username,
  role
FROM users
WHERE role IS NULL
   OR role = ''
   OR role NOT IN ('owner', 'admin', 'manager', 'worker')
ORDER BY company_id, id;

-- 8. Existing constraint name conflicts
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.conname IN (
  'users_role_valid_check',
  'invoices_company_invoice_number_unique',
  'subscription_billings_company_subscription_month_unique',
  'payments_amount_positive_check',
  'invoices_amount_nonnegative_check',
  'invoices_status_valid_check',
  'payments_method_valid_check'
)
ORDER BY con.conname, schema_name, table_name;

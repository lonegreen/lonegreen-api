-- Adds optional address on customer_accounts so the customer portal can store
-- a self-managed address without overwriting the tenant-owned clients.address row.

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS address TEXT;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS service_area TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_hours TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'admin';
UPDATE users SET role = 'admin' WHERE role IS NULL OR role = '';
UPDATE users SET role = 'admin' WHERE role NOT IN ('owner', 'admin', 'manager', 'worker');

ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

ALTER TABLE workers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'not_applicable';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_subscription_id INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimate_id INTEGER;
UPDATE jobs SET status = 'scheduled' WHERE status = 'pending';
UPDATE jobs SET status = 'completed' WHERE status = 'done';

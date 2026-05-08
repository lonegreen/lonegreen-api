ALTER TABLE companies
ADD COLUMN IF NOT EXISTS verification_status VARCHAR DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS verification_submitted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS verification_reviewed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS verification_notes TEXT,
ADD COLUMN IF NOT EXISTS insurance_status VARCHAR DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS insurance_provider VARCHAR,
ADD COLUMN IF NOT EXISTS insurance_expiry_date DATE,
ADD COLUMN IF NOT EXISTS insurance_document_url TEXT,
ADD COLUMN IF NOT EXISTS license_number VARCHAR,
ADD COLUMN IF NOT EXISTS license_state VARCHAR,
ADD COLUMN IF NOT EXISTS license_expiry_date DATE,
ADD COLUMN IF NOT EXISTS license_status VARCHAR DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS license_document_url TEXT;

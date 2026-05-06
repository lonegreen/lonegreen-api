CREATE TABLE IF NOT EXISTS company_service_areas (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  radius_miles INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_service_areas_company_active
ON company_service_areas (company_id, active, id);

CREATE INDEX IF NOT EXISTS idx_company_service_areas_zip
ON company_service_areas (zip_code);

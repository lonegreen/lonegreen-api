CREATE TABLE IF NOT EXISTS company_reports (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER,
  report_type VARCHAR NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_reports_company_id_created_at
  ON company_reports(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_reports_status
  ON company_reports(status);

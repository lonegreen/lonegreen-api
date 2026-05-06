CREATE TABLE IF NOT EXISTS company_availability (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_company_availability_company_day
ON company_availability (company_id, day_of_week);

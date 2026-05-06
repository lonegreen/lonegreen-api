CREATE TABLE IF NOT EXISTS service_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_categories_active_sort
ON service_categories (active, sort_order, id);

CREATE TABLE IF NOT EXISTS company_services (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  custom_name TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_company_services_company_active
ON company_services (company_id, active, category_id);

INSERT INTO service_categories (name, slug, description, icon, active, sort_order)
VALUES
  ('Lawn Care', 'lawn-care', '', '', TRUE, 10),
  ('Tree Trimming', 'tree-trimming', '', '', TRUE, 20),
  ('Pressure Washing', 'pressure-washing', '', '', TRUE, 30),
  ('Landscaping', 'landscaping', '', '', TRUE, 40),
  ('Fence Installation', 'fence-installation', '', '', TRUE, 50),
  ('Fence Repair', 'fence-repair', '', '', TRUE, 60),
  ('Yard Cleanup', 'yard-cleanup', '', '', TRUE, 70),
  ('Weed Control', 'weed-control', '', '', TRUE, 80),
  ('Mulch Installation', 'mulch-installation', '', '', TRUE, 90),
  ('Rock Installation', 'rock-installation', '', '', TRUE, 100)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order,
  active = TRUE;

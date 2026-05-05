-- Phase 14: company isolation repair and quarantine.
-- Non-destructive: safely infers company_id where possible; otherwise moves
-- unresolved legacy rows into an inaccessible quarantine company and logs them.

CREATE TABLE IF NOT EXISTS company_isolation_repair_log (
  id SERIAL PRIMARY KEY,
  operation_key TEXT UNIQUE NOT NULL,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  previous_company_id INTEGER,
  new_company_id INTEGER,
  reason TEXT NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_isolation_quarantine (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  previous_company_id INTEGER,
  quarantine_company_id INTEGER NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_name, row_id, reason)
);

WITH inserted AS (
  INSERT INTO companies (name, phone, email, address, service_area, business_hours)
  SELECT
    'Quarantine - Legacy Unassigned Records',
    '',
    '',
    '',
    'Internal quarantine for records that could not be safely assigned to a tenant',
    ''
  WHERE NOT EXISTS (
    SELECT 1
    FROM companies
    WHERE name = 'Quarantine - Legacy Unassigned Records'
  )
  RETURNING id
),
quarantine_company AS (
  SELECT id FROM inserted
  UNION ALL
  SELECT id
  FROM companies
  WHERE name = 'Quarantine - Legacy Unassigned Records'
  ORDER BY id
  LIMIT 1
),
client_candidates AS (
  SELECT client_id AS id, company_id
  FROM jobs
  WHERE client_id IS NOT NULL AND company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = jobs.company_id)
  UNION ALL
  SELECT client_id AS id, company_id
  FROM invoices
  WHERE client_id IS NOT NULL AND company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = invoices.company_id)
  UNION ALL
  SELECT client_id AS id, company_id
  FROM subscriptions
  WHERE client_id IS NOT NULL AND company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = subscriptions.company_id)
  UNION ALL
  SELECT client_id AS id, company_id
  FROM estimates
  WHERE client_id IS NOT NULL AND company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = estimates.company_id)
),
client_infer AS (
  SELECT id, MIN(company_id) AS company_id
  FROM client_candidates
  GROUP BY id
  HAVING COUNT(DISTINCT company_id) = 1
),
client_targets AS (
  SELECT c.*, ci.company_id AS inferred_company_id
  FROM clients c
  INNER JOIN client_infer ci ON ci.id = c.id
  WHERE c.company_id IS NULL
),
log_client_repairs AS (
  INSERT INTO company_isolation_repair_log (
    operation_key, action, table_name, row_id, previous_company_id, new_company_id, reason, snapshot
  )
  SELECT
    'repair:clients:' || id,
    'repair',
    'clients',
    id,
    company_id,
    inferred_company_id,
    'single related tenant reference',
    to_jsonb(client_targets)
  FROM client_targets
  ON CONFLICT (operation_key) DO NOTHING
)
UPDATE clients c
SET company_id = ct.inferred_company_id
FROM client_targets ct
WHERE c.id = ct.id
  AND c.company_id IS NULL;

WITH job_candidates AS (
  SELECT j.id, c.company_id
  FROM jobs j
  INNER JOIN clients c ON c.id = j.client_id
  WHERE j.company_id IS NULL AND c.company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = c.company_id)
  UNION ALL
  SELECT j.id, s.company_id
  FROM jobs j
  INNER JOIN subscriptions s ON s.id = j.source_subscription_id
  WHERE j.company_id IS NULL AND s.company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = s.company_id)
),
job_infer AS (
  SELECT id, MIN(company_id) AS company_id
  FROM job_candidates
  GROUP BY id
  HAVING COUNT(DISTINCT company_id) = 1
),
job_targets AS (
  SELECT j.*, ji.company_id AS inferred_company_id
  FROM jobs j
  INNER JOIN job_infer ji ON ji.id = j.id
  WHERE j.company_id IS NULL
),
log_job_repairs AS (
  INSERT INTO company_isolation_repair_log (
    operation_key, action, table_name, row_id, previous_company_id, new_company_id, reason, snapshot
  )
  SELECT
    'repair:jobs:' || id,
    'repair',
    'jobs',
    id,
    company_id,
    inferred_company_id,
    'single related tenant reference',
    to_jsonb(job_targets)
  FROM job_targets
  ON CONFLICT (operation_key) DO NOTHING
)
UPDATE jobs j
SET company_id = jt.inferred_company_id
FROM job_targets jt
WHERE j.id = jt.id
  AND j.company_id IS NULL;

WITH worker_candidates AS (
  SELECT worker_id AS id, company_id
  FROM jobs
  WHERE worker_id IS NOT NULL AND company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = jobs.company_id)
  UNION ALL
  SELECT worker_id AS id, company_id
  FROM subscriptions
  WHERE worker_id IS NOT NULL AND company_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM companies WHERE companies.id = subscriptions.company_id)
),
worker_infer AS (
  SELECT id, MIN(company_id) AS company_id
  FROM worker_candidates
  GROUP BY id
  HAVING COUNT(DISTINCT company_id) = 1
),
worker_targets AS (
  SELECT w.*, wi.company_id AS inferred_company_id
  FROM workers w
  INNER JOIN worker_infer wi ON wi.id = w.id
  WHERE w.company_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = w.company_id)
),
log_worker_repairs AS (
  INSERT INTO company_isolation_repair_log (
    operation_key, action, table_name, row_id, previous_company_id, new_company_id, reason, snapshot
  )
  SELECT
    'repair:workers:' || id,
    'repair',
    'workers',
    id,
    company_id,
    inferred_company_id,
    'single related tenant reference',
    to_jsonb(worker_targets)
  FROM worker_targets
  ON CONFLICT (operation_key) DO NOTHING
)
UPDATE workers w
SET company_id = wt.inferred_company_id
FROM worker_targets wt
WHERE w.id = wt.id
  AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = w.company_id);

WITH quarantine_company AS (
  SELECT id
  FROM companies
  WHERE name = 'Quarantine - Legacy Unassigned Records'
  ORDER BY id
  LIMIT 1
),
targets AS (
  SELECT c.*, qc.id AS quarantine_company_id
  FROM clients c
  CROSS JOIN quarantine_company qc
  WHERE c.company_id IS NULL
),
quarantine_rows AS (
  INSERT INTO company_isolation_quarantine (
    table_name, row_id, reason, previous_company_id, quarantine_company_id, snapshot
  )
  SELECT
    'clients',
    id,
    'unable to infer tenant company',
    company_id,
    quarantine_company_id,
    to_jsonb(targets)
  FROM targets
  ON CONFLICT (table_name, row_id, reason) DO NOTHING
),
log_rows AS (
  INSERT INTO company_isolation_repair_log (
    operation_key, action, table_name, row_id, previous_company_id, new_company_id, reason, snapshot
  )
  SELECT
    'quarantine:clients:' || id,
    'quarantine',
    'clients',
    id,
    company_id,
    quarantine_company_id,
    'unable to infer tenant company',
    to_jsonb(targets)
  FROM targets
  ON CONFLICT (operation_key) DO NOTHING
)
UPDATE clients c
SET company_id = t.quarantine_company_id
FROM targets t
WHERE c.id = t.id
  AND c.company_id IS NULL;

WITH quarantine_company AS (
  SELECT id
  FROM companies
  WHERE name = 'Quarantine - Legacy Unassigned Records'
  ORDER BY id
  LIMIT 1
),
targets AS (
  SELECT j.*, qc.id AS quarantine_company_id
  FROM jobs j
  CROSS JOIN quarantine_company qc
  WHERE j.company_id IS NULL
),
quarantine_rows AS (
  INSERT INTO company_isolation_quarantine (
    table_name, row_id, reason, previous_company_id, quarantine_company_id, snapshot
  )
  SELECT
    'jobs',
    id,
    'unable to infer tenant company',
    company_id,
    quarantine_company_id,
    to_jsonb(targets)
  FROM targets
  ON CONFLICT (table_name, row_id, reason) DO NOTHING
),
log_rows AS (
  INSERT INTO company_isolation_repair_log (
    operation_key, action, table_name, row_id, previous_company_id, new_company_id, reason, snapshot
  )
  SELECT
    'quarantine:jobs:' || id,
    'quarantine',
    'jobs',
    id,
    company_id,
    quarantine_company_id,
    'unable to infer tenant company',
    to_jsonb(targets)
  FROM targets
  ON CONFLICT (operation_key) DO NOTHING
)
UPDATE jobs j
SET company_id = t.quarantine_company_id
FROM targets t
WHERE j.id = t.id
  AND j.company_id IS NULL;

WITH quarantine_company AS (
  SELECT id
  FROM companies
  WHERE name = 'Quarantine - Legacy Unassigned Records'
  ORDER BY id
  LIMIT 1
),
targets AS (
  SELECT w.*, qc.id AS quarantine_company_id
  FROM workers w
  CROSS JOIN quarantine_company qc
  WHERE w.company_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = w.company_id)
),
quarantine_rows AS (
  INSERT INTO company_isolation_quarantine (
    table_name, row_id, reason, previous_company_id, quarantine_company_id, snapshot
  )
  SELECT
    'workers',
    id,
    'company reference is missing',
    company_id,
    quarantine_company_id,
    to_jsonb(targets)
  FROM targets
  ON CONFLICT (table_name, row_id, reason) DO NOTHING
),
log_rows AS (
  INSERT INTO company_isolation_repair_log (
    operation_key, action, table_name, row_id, previous_company_id, new_company_id, reason, snapshot
  )
  SELECT
    'quarantine:workers:' || id,
    'quarantine',
    'workers',
    id,
    company_id,
    quarantine_company_id,
    'company reference is missing',
    to_jsonb(targets)
  FROM targets
  ON CONFLICT (operation_key) DO NOTHING
)
UPDATE workers w
SET company_id = t.quarantine_company_id
FROM targets t
WHERE w.id = t.id
  AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = w.company_id);

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS accepted_offer_id INTEGER REFERENCES marketplace_offers(id) ON DELETE SET NULL;

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS converted_by_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS converted_lead_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL;

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS converted_estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL;

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS converted_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;

ALTER TABLE marketplace_requests
ADD COLUMN IF NOT EXISTS converted_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE estimates
ADD COLUMN IF NOT EXISTS marketplace_request_id INTEGER REFERENCES marketplace_requests(id) ON DELETE SET NULL;

ALTER TABLE estimates
ADD COLUMN IF NOT EXISTS marketplace_offer_id INTEGER REFERENCES marketplace_offers(id) ON DELETE SET NULL;

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS marketplace_request_id INTEGER REFERENCES marketplace_requests(id) ON DELETE SET NULL;

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS marketplace_offer_id INTEGER REFERENCES marketplace_offers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_requests_converted_company
ON marketplace_requests (converted_by_company_id, converted_at DESC);

CREATE INDEX IF NOT EXISTS idx_estimates_marketplace_request
ON estimates (marketplace_request_id);

CREATE INDEX IF NOT EXISTS idx_jobs_marketplace_request
ON jobs (marketplace_request_id);

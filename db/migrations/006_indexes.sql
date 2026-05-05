CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_zip_groups_unique
ON worker_zip_groups (company_id, worker_id, group_id);

CREATE INDEX IF NOT EXISTS idx_activity_log_company_created_at
ON activity_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_company_user_read
ON notifications (company_id, user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_billings_subscription_month
ON subscription_billings (subscription_id, billing_month);

CREATE INDEX IF NOT EXISTS idx_estimates_company_record_type
ON estimates (company_id, record_type, id DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_company_estimate_id
ON jobs (company_id, estimate_id);

CREATE INDEX IF NOT EXISTS idx_invoices_company_client_id
ON invoices (company_id, client_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_company_source_type
ON invoices (company_id, source_type, issued_date DESC);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id
ON payments (invoice_id, date DESC, id DESC);

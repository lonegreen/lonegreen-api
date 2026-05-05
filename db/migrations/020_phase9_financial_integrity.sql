-- Phase 9: refunds + append-only payment ledger (non-destructive).

CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount NUMERIC NOT NULL,
  reason TEXT,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER,
  CONSTRAINT refunds_amount_positive_check CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_refunds_company_invoice
ON refunds (company_id, invoice_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_refunds_payment
ON refunds (company_id, payment_id, id DESC);

CREATE TABLE IF NOT EXISTS payment_ledger (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT,
  refund_id INTEGER REFERENCES refunds(id) ON DELETE RESTRICT,
  amount NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER,
  CONSTRAINT payment_ledger_event_type_check CHECK (event_type IN (
    'invoice_created',
    'payment_received',
    'refund_issued',
    'manual_adjustment',
    'balance_correction'
  ))
);

CREATE INDEX IF NOT EXISTS idx_payment_ledger_company_invoice
ON payment_ledger (company_id, invoice_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_payment_ledger_company_created
ON payment_ledger (company_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_payment_ledger_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_ledger_no_update ON payment_ledger;
CREATE TRIGGER trg_payment_ledger_no_update
BEFORE UPDATE ON payment_ledger
FOR EACH ROW EXECUTE PROCEDURE prevent_payment_ledger_update();

CREATE OR REPLACE FUNCTION prevent_payment_ledger_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_ledger_no_delete ON payment_ledger;
CREATE TRIGGER trg_payment_ledger_no_delete
BEFORE DELETE ON payment_ledger
FOR EACH ROW EXECUTE PROCEDURE prevent_payment_ledger_delete();

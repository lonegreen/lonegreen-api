-- Support lifecycle + extended thread entities (additive).

CREATE TABLE IF NOT EXISTS support_replies (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT support_replies_message_len_chk
    CHECK (char_length(message) BETWEEN 1 AND 5000)
);

CREATE INDEX IF NOT EXISTS idx_support_replies_ticket_id_created_at
  ON support_replies(ticket_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS support_attachments (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket_id_created_at
  ON support_attachments(ticket_id, created_at ASC, id ASC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'support_tickets_status_chk'
  ) THEN
    ALTER TABLE support_tickets DROP CONSTRAINT support_tickets_status_chk;
  END IF;
END $$;

ALTER TABLE support_tickets
ADD CONSTRAINT support_tickets_status_chk
CHECK (
  status IN (
    'open',
    'in_progress',
    'waiting_customer',
    'resolved',
    'closed',
    'pending'
  )
);

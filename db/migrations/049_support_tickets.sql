-- Internal support system (Phase 1).
-- Two tables: support_tickets (one row per case) and support_ticket_messages
-- (thread of replies, including the originating message).
--
-- Company isolation: every ticket carries the owning company_id. All company
-- side queries in routes/support.js MUST scope by req.user.company_id. The
-- platform_owner role is allowed to read/assign/status across companies via
-- the dedicated /platform/support/* endpoints.

CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT support_tickets_status_chk
    CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  CONSTRAINT support_tickets_priority_chk
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT support_tickets_category_chk
    CHECK (category IN ('general', 'billing', 'bug', 'feature_request', 'account', 'marketplace')),
  CONSTRAINT support_tickets_subject_len_chk
    CHECK (char_length(subject) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_company_id
  ON support_tickets (company_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON support_tickets (status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at
  ON support_tickets (created_at DESC);


CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT support_ticket_messages_message_len_chk
    CHECK (char_length(message) BETWEEN 1 AND 5000),
  CONSTRAINT support_ticket_messages_sender_role_chk
    CHECK (sender_role IN ('worker', 'manager', 'admin', 'owner', 'platform_owner', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_id
  ON support_ticket_messages (ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_created_at
  ON support_ticket_messages (created_at);

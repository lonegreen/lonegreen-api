CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_company_created
ON conversations (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_client_created
ON conversations (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'company')),
  sender_id INTEGER NOT NULL,
  message_text TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
ON messages (conversation_id, created_at ASC);

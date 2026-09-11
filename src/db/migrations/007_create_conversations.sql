-- Migration 007: conversations
-- One conversation per photographer–client pair.
-- Auto-created in the same DB transaction as the client record on invite acceptance.
--
-- most_recent_message_id and number_of_unread are DENORMALISED fields:
--   - most_recent_message_id avoids a subquery to find the latest message for inbox preview
--   - number_of_unread avoids a COUNT(*) on messages for every inbox load
-- Both must be kept in sync in your route handlers when messages are sent/read.

CREATE TABLE conversations (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id         UUID        NOT NULL REFERENCES photographers(user_id) ON DELETE CASCADE,
  client_id               UUID        NOT NULL REFERENCES clients(user_id) ON DELETE CASCADE,
  -- nullable until the first message is sent
  most_recent_message_id  UUID,
  number_of_unread        INTEGER     NOT NULL DEFAULT 0,
  last_message_at         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one conversation per pair
  UNIQUE (photographer_id, client_id)
);

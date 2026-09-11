-- Migration 008: messages + conversation most_recent_message FK
-- A single message within a conversation.
-- read_at = NULL means the message is unread.

CREATE TABLE messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = unread. Set to NOW() when the recipient views the message.
  read_at         TIMESTAMPTZ
);

-- Add the FK constraint deferred from migration 007.
-- Conversations couldn't reference messages until the messages table existed.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_most_recent_message_id_fkey
  FOREIGN KEY (most_recent_message_id) REFERENCES messages(id) ON DELETE SET NULL;

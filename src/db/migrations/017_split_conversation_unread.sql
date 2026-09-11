-- Migration 017: split conversations.number_of_unread into per-participant counters
-- A single shared counter can't express "unread for whom" — every send
-- incremented it, so the sender's own messages inflated the badge the sender
-- saw on their own inbox. Two counters let a send increment only the
-- recipient's side, and let "mark as read" zero only the caller's side.

ALTER TABLE conversations ADD COLUMN unread_for_photographer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN unread_for_client INTEGER NOT NULL DEFAULT 0;

-- Backfill: the old counter can't be split retroactively (it never recorded
-- who a message was for), so recompute both sides from messages instead —
-- a participant's unread count is the unread messages the OTHER party sent.
UPDATE conversations c
SET unread_for_photographer = (
      SELECT COUNT(*)
      FROM messages m
      WHERE m.conversation_id = c.id
        AND m.sender_id = c.client_id
        AND m.read_at IS NULL
    ),
    unread_for_client = (
      SELECT COUNT(*)
      FROM messages m
      WHERE m.conversation_id = c.id
        AND m.sender_id = c.photographer_id
        AND m.read_at IS NULL
    );

ALTER TABLE conversations DROP COLUMN number_of_unread;

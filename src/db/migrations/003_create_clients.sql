-- Migration 003: clients
-- Client profile. One-to-one with users where role = 'client'.
-- Always linked to exactly one photographer (invite-only model).

CREATE TABLE clients (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  photographer_id UUID NOT NULL REFERENCES photographers(user_id) ON DELETE CASCADE
);

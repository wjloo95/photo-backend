-- Migration 013: invites
-- Photographer-initiated client onboarding link.
-- token is a cryptographically random one-time string (generated in application code).
-- Expires 30 days from creation. accepted_at is set when the client completes signup.

CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired');

CREATE TABLE invites (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id UUID          NOT NULL REFERENCES photographers(user_id) ON DELETE CASCADE,
  email           TEXT          NOT NULL,
  client_name     TEXT          NOT NULL,
  token           TEXT          NOT NULL UNIQUE,
  status          invite_status NOT NULL DEFAULT 'pending',
  expires_at      TIMESTAMPTZ   NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

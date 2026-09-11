-- Migration 011: form_responses
-- One instance of a template assigned to a specific client.
-- submitted_at = NULL means the client has started but not yet submitted.

CREATE TABLE form_responses (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  UUID        NOT NULL REFERENCES form_templates(id) ON DELETE CASCADE,
  client_id    UUID        NOT NULL REFERENCES clients(user_id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = in progress. Set to NOW() when the client submits.
  submitted_at TIMESTAMPTZ
);

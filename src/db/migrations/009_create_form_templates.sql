-- Migration 009: form_templates
-- A reusable questionnaire created by a photographer.
-- Can be assigned to multiple clients via form_responses.

CREATE TABLE form_templates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id UUID        NOT NULL REFERENCES photographers(user_id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

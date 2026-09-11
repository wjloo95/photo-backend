-- Migration 010: form_questions
-- Individual questions within a form template.
-- order controls display sequence (1-based, managed by application).

CREATE TYPE answer_type AS ENUM ('text', 'multiple_choice', 'date', 'boolean');

CREATE TABLE form_questions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID        NOT NULL REFERENCES form_templates(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL,
  answer_type answer_type NOT NULL,
  "order"     INTEGER     NOT NULL  -- quoted because ORDER is a reserved SQL keyword
);

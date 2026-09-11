-- Migration 012: form_answers
-- A client's answer to one question within a form response.
-- content is TEXT for all answer types — booleans stored as 'true'/'false',
-- dates stored as ISO strings. Parsing is handled in application code.

CREATE TABLE form_answers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id UUID NOT NULL REFERENCES form_responses(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES form_questions(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  -- A client can only answer each question once per response
  UNIQUE (response_id, question_id)
);

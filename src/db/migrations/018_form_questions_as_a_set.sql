-- Migration 018: form_questions are written as a set, not incrementally
-- A template and all of its questions are now created in one request (and
-- edited by replacing the whole set), so "order" is simply the index of the
-- submitted array. Nothing computes MAX("order") + 1 any more, and nothing
-- mutates a single question's position, which makes the uniqueness of
-- (template_id, "order") both true and worth enforcing — it now catches an
-- application bug instead of fighting the ordering scheme.
ALTER TABLE form_questions
  ADD CONSTRAINT form_questions_template_order_unique UNIQUE (template_id, "order");

-- multiple_choice is removed from answer_type: the enum offered it but
-- form_questions has nowhere to store the choices themselves, so an answer of
-- that type could never be validated against anything.
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so the type is recreated and the
-- column cast across. The USING cast fails loudly if any existing row still
-- holds 'multiple_choice' — that's deliberate: those rows need a decision
-- (delete or convert to 'text'), not a silent rewrite.
CREATE TYPE answer_type_new AS ENUM ('text', 'date', 'boolean');

ALTER TABLE form_questions
  ALTER COLUMN answer_type TYPE answer_type_new
  USING answer_type::text::answer_type_new;

DROP TYPE answer_type;
ALTER TYPE answer_type_new RENAME TO answer_type;

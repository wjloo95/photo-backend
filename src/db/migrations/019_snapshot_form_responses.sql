-- Migration 019: a form response becomes a self-contained record
--
-- Until now a response was only meaningful alongside its template: it stored
-- nothing but two foreign keys, and its answers pointed at live
-- form_questions rows. That coupling is what forced the template lock — a
-- replace-all edit deletes and recreates question rows, which would orphan
-- form_answers.question_id, so an assigned template had to be frozen and
-- edited by duplication instead.
--
-- Responses now snapshot the questions they were assigned. A template is a
-- drafting surface and a response is a record; once a response is created the
-- template can no longer change what that client was asked. With nothing
-- referencing question rows, PUT /templates/:id needs no lock at all.
--
-- The same move collapses form_answers into a JSONB column. Answers are only
-- ever read one response at a time, so a table whose sole purpose was to hang
-- <=25 strings off a parent row was buying referential integrity we no longer
-- need and paying for it with a join, a UNIQUE constraint and a cross-entity
-- validation query.

-- questions is added nullable so existing rows can be backfilled, then locked
-- down. answers can take its default immediately — an empty object is a
-- truthful starting value for every existing row.
ALTER TABLE form_responses
  ADD COLUMN questions JSONB,
  ADD COLUMN answers   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill the snapshot from the questions as they stand today. This is the
-- one moment where a response's snapshot is derived rather than frozen at
-- assign time; for existing rows it is the best available answer, and the
-- template lock guarantees these questions have not changed since assignment.
--
-- The key names are camelCase because this JSON is served to clients as-is,
-- matching the FormQuestion interface in src/types/index.ts. Everywhere else
-- in this schema the boundary between snake_case columns and camelCase
-- entities is a mapper function; here the column holds the entity directly.
UPDATE form_responses r
SET questions = COALESCE(
  (
    SELECT jsonb_agg(
             jsonb_build_object(
               'id',         q.id,
               'templateId', q.template_id,
               'content',    q.content,
               'answerType', q.answer_type,
               'order',      q."order"
             )
             ORDER BY q."order"
           )
    FROM form_questions q
    WHERE q.template_id = r.template_id
  ),
  '[]'::jsonb
);

-- Fold each response's answers into one object keyed by question id. The
-- UNIQUE (response_id, question_id) constraint on form_answers guarantees
-- jsonb_object_agg cannot collide here.
UPDATE form_responses r
SET answers = COALESCE(
  (
    SELECT jsonb_object_agg(a.question_id::text, a.content)
    FROM form_answers a
    WHERE a.response_id = r.id
  ),
  '{}'::jsonb
);

ALTER TABLE form_responses ALTER COLUMN questions SET NOT NULL;

DROP TABLE form_answers;

-- started_at was never set when the client started: it defaults to NOW() when
-- the photographer assigns the template. Repeat assignments of one template to
-- one client are distinguished by this column, so it is worth naming honestly.
ALTER TABLE form_responses RENAME COLUMN started_at TO assigned_at;

-- The FK was ON DELETE CASCADE, which made sense while a response was
-- worthless without its template. A response now carries its own questions and
-- answers, so cascading a template delete would destroy standalone records of
-- what clients submitted. RESTRICT moves that rule into the database:
-- DELETE /templates/:id already checks and returns 409, and this makes the
-- check a courtesy on top of a real constraint rather than the only guard.
--
-- template_id stays NOT NULL. It is no longer needed to render a response, but
-- it is still the response's provenance and the path by which the owning
-- photographer is authorised (form_responses has no photographer_id).
ALTER TABLE form_responses
  DROP CONSTRAINT form_responses_template_id_fkey;

ALTER TABLE form_responses
  ADD CONSTRAINT form_responses_template_id_fkey
  FOREIGN KEY (template_id) REFERENCES form_templates(id) ON DELETE RESTRICT;

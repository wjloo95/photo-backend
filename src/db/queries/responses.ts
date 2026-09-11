/**
 * src/db/queries/responses.ts
 *
 * Query functions for form_responses.
 *
 * Since migration 019 a response is a self-contained record: it carries a
 * frozen copy of the questions it was assigned and an object of answers keyed
 * by question id, so rendering one never touches form_questions and editing a
 * template can never reach back and change what a client was asked. There is
 * no form_answers table.
 *
 * Two structural facts shape this file:
 *
 *   1. form_responses has no photographer_id. A response knows its client and
 *      its template, and the template knows the photographer — so "may this
 *      caller see it?" is a join through form_templates rather than a column
 *      comparison. That join is the only reason template_id is still needed
 *      on the read path.
 *
 *   2. questions and answers are JSONB. node-postgres parses them into JS
 *      values before the mapper ever sees them, so the row types below declare
 *      them as the shapes they arrive as, not as strings to be JSON.parse'd.
 */

import { pool } from '../../config/database';
import { FormAnswerMap, FormQuestion, FormResponse } from '../../types';

export interface FormResponseRow {
  id: string;
  template_id: string; // FK → FormTemplate.id
  client_id: string; // FK → Client.userId
  questions: FormQuestion[]; // JSONB snapshot, already camelCase (migration 019)
  answers: FormAnswerMap; // JSONB, question id → answer
  assigned_at: Date;
  submitted_at: Date | null; // null = in progress
}

export function toFormResponse(row: FormResponseRow): FormResponse {
  return {
    id: row.id,
    templateId: row.template_id,
    clientId: row.client_id,
    questions: row.questions,
    answers: row.answers,
    assignedAt: row.assigned_at,
    submittedAt: row.submitted_at,
  };
}

/**
 * A response plus the id that the row itself cannot supply: the photographer
 * who owns the underlying template. Together with the response's own clientId
 * these are the two ids every authorisation check in this phase compares
 * against. Spans two tables, so like TemplateWithQuestions it lives here
 * rather than in types/index.ts.
 */
export interface ResponseWithOwners extends FormResponse {
  photographerId: string;
}

/**
 * The columns a list view needs. `questions` and `answers` are deliberately
 * absent: an inbox rendering twenty responses has no use for twenty question
 * snapshots, and SELECT * would drag every one of them across the wire.
 */
const LIST_COLUMNS = 'id, template_id, client_id, assigned_at, submitted_at';

/**
 * A response as it appears in a list — no questions, no answers. Callers get
 * the metadata and follow up with GET /responses/:id for a form they actually
 * intend to render.
 */
export type FormResponseSummary = Omit<FormResponse, 'questions' | 'answers'>;

function toFormResponseSummary(
  row: Omit<FormResponseRow, 'questions' | 'answers'>,
): FormResponseSummary {
  return {
    id: row.id,
    templateId: row.template_id,
    clientId: row.client_id,
    assignedAt: row.assigned_at,
    submittedAt: row.submitted_at,
  };
}

/**
 * POST /templates/:id/responses — a photographer assigns a template to one of
 * their clients.
 *
 * INSERT ... SELECT, so the snapshot is taken inside the same statement that
 * creates the row: the questions are read and frozen atomically, and there is
 * no window in which a concurrent PUT /templates/:id could swap them out
 * halfway through. That is also why this needs no transaction despite writing
 * data derived from another table.
 *
 * The aggregate runs over zero rows for a template with no questions and still
 * produces one row, so COALESCE turns a NULL aggregate into '[]' rather than
 * violating the NOT NULL. A nonexistent template id is caught by the FK, and
 * the route has already 404'd on it long before.
 *
 * assigned_at takes its column DEFAULT NOW() and submitted_at is left unset —
 * NULL is what "in progress" means, so naming either column here would only be
 * a chance to disagree with the schema.
 *
 * Note what is deliberately NOT enforced: there is no
 * UNIQUE (template_id, client_id) on form_responses, so the same template can
 * be assigned to the same client more than once — one questionnaire per shoot,
 * each its own instance distinguished by assigned_at. Since migration 019 this
 * is no longer an escape hatch for a locked template (there is no lock on
 * edits any more), just an ordinary product requirement.
 */
export async function insertResponse(templateId: string, clientId: string): Promise<FormResponse> {
  const result = await pool.query<FormResponseRow>(
    `INSERT INTO form_responses (template_id, client_id, questions)
     SELECT $1, $2,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id',         q.id,
                  'templateId', q.template_id,
                  'content',    q.content,
                  'answerType', q.answer_type,
                  'order',      q."order"
                )
                ORDER BY q."order"
              ),
              '[]'::jsonb
            )
     FROM form_questions q
     WHERE q.template_id = $1
     RETURNING *`,
    [templateId, clientId],
  );

  return toFormResponse(result.rows[0]);
}

/**
 * The one read on the response path. Every endpoint in 8.2 starts here: the
 * write paths (answers, submit) need the two owner ids to authorise, and the
 * read path needs those plus the questions and answers the row already
 * carries. Before migration 019 this was two functions, because rendering a
 * response meant a second and third query for its questions and answers.
 *
 * An INNER JOIN is right here, unlike the LEFT JOIN in queries/templates.ts:
 * template_id is NOT NULL with a FK, so a response without a template cannot
 * exist and there is no missing-parent row to preserve.
 *
 * `r.*, t.photographer_id` rather than `r.*, t.*` — node-postgres keys each
 * row by column name and keeps only the last of a duplicated one, so selecting
 * both tables whole would silently overwrite the response's id with the
 * template's.
 *
 * Guards on rows[0] before mapping — pg types rows[0] as present even when the
 * result is empty, so `toFormResponse(rows[0]) ?? null` would throw on a miss
 * instead of returning null (the ?? applies to the call's result, not its
 * argument). The route turns null into a 404.
 */
export async function getResponseWithOwners(id: string): Promise<ResponseWithOwners | null> {
  const result = await pool.query<FormResponseRow & { photographer_id: string }>(
    `SELECT r.*, t.photographer_id
     FROM form_responses r
     JOIN form_templates t ON t.id = r.template_id
     WHERE r.id = $1`,
    [id],
  );

  const [row] = result.rows;

  return row ? { ...toFormResponse(row), photographerId: row.photographer_id } : null;
}

/**
 * POST /responses/:id/answers — save (or overwrite) one answer.
 *
 * `||` merges two JSONB objects with the right-hand side winning on a shared
 * key, so a one-key object merged into `answers` is insert-or-overwrite in a
 * single expression. That is what lets a save-as-you-go client re-send the
 * same question without tracking what it has already saved, and it is why
 * there is no PATCH /responses/:id/answers/:id.
 *
 * The read-modify-write happens inside one statement, so Postgres holds a row
 * lock for its duration: two clients saving different questions at the same
 * moment both land, rather than the second overwriting the first's object.
 *
 * `AND submitted_at IS NULL` is the interesting half. The route rejects a
 * write to a submitted response with 409 before calling this, but a submit can
 * land between that check and this statement; putting the condition in the
 * same UPDATE that performs the write closes the gap entirely, rather than
 * narrowing it. A caller that loses that race matches no row and gets null
 * back.
 *
 * So null means "not writable" — either no such response, or it was submitted
 * in the meantime. The route has loaded the response moments earlier and can
 * tell those apart; this function does not need to.
 */
export async function upsertAnswer(
  responseId: string,
  questionId: string,
  content: string,
): Promise<FormResponse | null> {
  const result = await pool.query<FormResponseRow>(
    `UPDATE form_responses
     SET answers = answers || jsonb_build_object($2::text, $3::text)
     WHERE id = $1 AND submitted_at IS NULL
     RETURNING *`,
    [responseId, questionId, content],
  );

  const [row] = result.rows;

  return row ? toFormResponse(row) : null;
}

/**
 * PATCH /responses/:id/submit — flip the response to submitted.
 *
 * Submit does not require a complete form: an unanswered question simply has
 * no key in `answers`, and there is no `required` concept anywhere in the
 * schema. All this does is set the timestamp.
 *
 * `AND submitted_at IS NULL` for the same reason as upsertAnswer, with one
 * extra benefit: the original submitted_at survives a double-tap, so the
 * column stays an honest record of when the client actually finished rather
 * than a timestamp that creeps forward on every retry.
 *
 * null means "nothing to submit" — either no such response, or it was already
 * submitted.
 */
export async function submitResponse(id: string): Promise<FormResponse | null> {
  const result = await pool.query<FormResponseRow>(
    `UPDATE form_responses
     SET submitted_at = NOW()
     WHERE id = $1 AND submitted_at IS NULL
     RETURNING *`,
    [id],
  );

  const [row] = result.rows;

  return row ? toFormResponse(row) : null;
}

/**
 * GET /clients/:id/responses — every response belonging to one client.
 *
 * Summary rows only. Since migration 019 every response carries its own
 * question snapshot, so SELECT * here would return the client's entire form
 * history — questions and all — to render a list of names and dates.
 *
 * Newest first: assigned_at is what distinguishes repeat assignments of the
 * same template to the same client, so it is the only ordering that reads as
 * a history.
 *
 * Filters on client_id alone. The caller may be the client themselves or their
 * photographer, and the photographer's claim runs through form_templates — but
 * that check stays in the route rather than becoming an extra joined arm here.
 * Filtering by photographer in SQL would turn "not your client" into an empty
 * list, and empty means "nothing here", which invites the caller to retry; the
 * route's 403 says "not yours". Either way the client_id in the URL is never
 * trusted on its own — the JWT identity decides.
 */
export async function getResponsesByClientId(clientId: string): Promise<FormResponseSummary[]> {
  const result = await pool.query<Omit<FormResponseRow, 'questions' | 'answers'>>(
    `SELECT ${LIST_COLUMNS}
     FROM form_responses
     WHERE client_id = $1
     ORDER BY assigned_at DESC`,
    [clientId],
  );

  return result.rows.map(toFormResponseSummary);
}

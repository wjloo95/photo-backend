jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import {
  insertResponse,
  getResponseWithOwners,
  upsertAnswer,
  submitResponse,
  getResponsesByClientId,
} from '../responses';
import { pool } from '../../../config/database';
import { AnswerType } from '../../../types';

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
});

const ASSIGNED_AT = new Date('2026-09-01T00:00:00Z');
const SUBMITTED_AT = new Date('2026-09-02T00:00:00Z');

// node-postgres parses JSONB before the mapper ever sees it, so these arrive as
// real arrays and objects rather than strings to be JSON.parse'd.
const question = {
  id: 'question-1',
  templateId: 'template-1',
  content: 'What time is the ceremony?',
  answerType: AnswerType.text,
  order: 0,
};

const responseRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'response-1',
  template_id: 'template-1',
  client_id: 'client-1',
  questions: [question],
  answers: {},
  assigned_at: ASSIGNED_AT,
  submitted_at: null,
  ...overrides,
});

const response = {
  id: 'response-1',
  templateId: 'template-1',
  clientId: 'client-1',
  questions: [question],
  answers: {},
  assignedAt: ASSIGNED_AT,
  submittedAt: null,
};

describe('insertResponse', () => {
  it('maps the inserted row, snapshot and all', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow()] });

    await expect(insertResponse('template-1', 'client-1')).resolves.toEqual(response);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['template-1', 'client-1']);
  });

  // The snapshot is built inside the same statement that creates the row, so
  // the questions are read and frozen atomically — no window for a concurrent
  // PUT /templates/:id to swap them out halfway through.
  it('snapshots the template questions in the INSERT itself', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow()] });

    await insertResponse('template-1', 'client-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO form_responses');
    expect(sql).toContain('FROM form_questions');
    expect(sql).toContain('jsonb_agg');
    expect(sql).toContain('ORDER BY q."order"');
    expect(sql).toContain('RETURNING *');
  });

  // A template with no questions makes the aggregate NULL over zero rows,
  // which would violate the NOT NULL on questions.
  it("COALESCEs an empty template's snapshot to an empty array", async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow({ questions: [] })] });

    await insertResponse('template-1', 'client-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('COALESCE');
    expect(sql).toContain("'[]'::jsonb");
  });

  // assigned_at has a column DEFAULT NOW() and submitted_at is NULL by
  // omission — NULL is what "in progress" means.
  it('leaves the timestamps to the schema', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow()] });

    await insertResponse('template-1', 'client-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('submitted_at');
    expect(sql).not.toContain('assigned_at');
  });

  it('runs a single statement, with no transaction', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow()] });

    await insertResponse('template-1', 'client-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('getResponseWithOwners', () => {
  it('returns the response with the photographer who owns its template', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...responseRow(), photographer_id: 'photog-1' }] });

    await expect(getResponseWithOwners('response-1')).resolves.toEqual({
      ...response,
      photographerId: 'photog-1',
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['response-1']);
  });

  // One query serves the whole read path now: the row already carries the
  // questions and the answers, so there is nothing left to join or assemble.
  it('returns questions and answers from the row itself, in one query', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          ...responseRow({ answers: { 'question-1': '3pm' } }),
          photographer_id: 'photog-1',
        },
      ],
    });

    const result = await getResponseWithOwners('response-1');

    expect(result).toMatchObject({
      questions: [question],
      answers: { 'question-1': '3pm' },
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('carries submitted_at through, so callers can tell in-progress from locked', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...responseRow({ submitted_at: SUBMITTED_AT }), photographer_id: 'photog-1' }],
    });

    await expect(getResponseWithOwners('response-1')).resolves.toMatchObject({
      submittedAt: SUBMITTED_AT,
    });
  });

  // Regression: mapping before the guard throws a TypeError on a miss, which
  // surfaces as a 500 instead of the 404 every response endpoint expects.
  it('returns null rather than throwing when no row matches', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(getResponseWithOwners('missing')).resolves.toBeNull();
  });

  // template_id is NOT NULL with a FK, so a response without a template can't
  // exist — an inner join here, unlike the LEFT JOIN in queries/templates.ts.
  // Selecting t.photographer_id rather than t.* matters: node-postgres keeps
  // only the last of a duplicated column name, so t.* would overwrite the
  // response's id with the template's.
  it('inner joins form_templates for one named column', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getResponseWithOwners('response-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('FROM form_responses');
    expect(sql).toContain('JOIN form_templates');
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).toContain('t.photographer_id');
    expect(sql).not.toContain('t.*');
  });
});

describe('upsertAnswer', () => {
  it('returns the whole updated response, not just the answer', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow({ answers: { 'question-1': '3pm' } })] });

    await expect(upsertAnswer('response-1', 'question-1', '3pm')).resolves.toEqual({
      ...response,
      answers: { 'question-1': '3pm' },
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['response-1', 'question-1', '3pm']);
  });

  // `||` merges two JSONB objects with the right-hand side winning, so a
  // one-key object merged into `answers` is insert-or-overwrite in a single
  // expression. That is what lets a save-as-you-go client re-send freely.
  it('merges one key into answers rather than replacing the object', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow()] });

    await upsertAnswer('response-1', 'question-1', '3pm');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('UPDATE form_responses');
    expect(sql).toContain('answers = answers || jsonb_build_object');
    expect(sql).toContain('RETURNING *');
  });

  // The lock is enforced in the same statement as the write, so a submit that
  // lands between the route's 409 check and this UPDATE cannot be written past.
  it('refuses to write to a submitted response, in the UPDATE itself', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(upsertAnswer('response-1', 'question-1', '3pm')).resolves.toBeNull();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('submitted_at IS NULL');
  });

  it('overwrites an existing answer for the same question', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [responseRow({ answers: { 'question-1': '3pm' } })] })
      .mockResolvedValueOnce({ rows: [responseRow({ answers: { 'question-1': '4pm' } })] });

    await upsertAnswer('response-1', 'question-1', '3pm');

    await expect(upsertAnswer('response-1', 'question-1', '4pm')).resolves.toMatchObject({
      answers: { 'question-1': '4pm' },
    });
  });

  it('preserves answers to other questions', async () => {
    mockQuery.mockResolvedValue({
      rows: [responseRow({ answers: { 'question-1': '3pm', 'question-2': '2026-10-01' } })],
    });

    await expect(upsertAnswer('response-1', 'question-2', '2026-10-01')).resolves.toMatchObject({
      answers: { 'question-1': '3pm', 'question-2': '2026-10-01' },
    });
  });
});

describe('submitResponse', () => {
  it('sets submitted_at and returns the updated response', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow({ submitted_at: SUBMITTED_AT })] });

    await expect(submitResponse('response-1')).resolves.toEqual({
      ...response,
      submittedAt: SUBMITTED_AT,
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('UPDATE form_responses');
    expect(sql).toContain('submitted_at = NOW()');
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual(['response-1']);
  });

  // Submit does not require a complete form: an unanswered question simply has
  // no key in `answers`, and nothing in the schema marks a question required.
  it('never inspects the answers', async () => {
    mockQuery.mockResolvedValue({ rows: [responseRow({ submitted_at: SUBMITTED_AT })] });

    await submitResponse('response-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('answers');
    expect(sql).not.toContain('questions');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Two concurrent submits both pass the route's 409; the loser matches no row
  // here, so the original submitted_at survives rather than creeping forward.
  it('guards on submitted_at IS NULL and returns null on a re-submit', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(submitResponse('response-1')).resolves.toBeNull();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('submitted_at IS NULL');
  });
});

describe('getResponsesByClientId', () => {
  const summaryRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'response-1',
    template_id: 'template-1',
    client_id: 'client-1',
    assigned_at: ASSIGNED_AT,
    submitted_at: null,
    ...overrides,
  });

  const summary = {
    id: 'response-1',
    templateId: 'template-1',
    clientId: 'client-1',
    assignedAt: ASSIGNED_AT,
    submittedAt: null,
  };

  it('maps every row to a summary, newest first', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        summaryRow(),
        summaryRow({ id: 'response-2', assigned_at: SUBMITTED_AT, submitted_at: SUBMITTED_AT }),
      ],
    });

    await expect(getResponsesByClientId('client-1')).resolves.toEqual([
      summary,
      {
        ...summary,
        id: 'response-2',
        assignedAt: SUBMITTED_AT,
        submittedAt: SUBMITTED_AT,
      },
    ]);
  });

  // Every response carries its own question snapshot, so SELECT * here would
  // return the client's entire form history to render a list of names and
  // dates.
  it('omits the question snapshot and the answers from a list view', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getResponsesByClientId('client-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('SELECT *');
    expect(sql).not.toContain('questions');
    expect(sql).not.toContain('answers');
  });

  // assigned_at is what distinguishes repeat assignments of the same template
  // to the same client — there is no UNIQUE (template_id, client_id).
  it('filters on client_id alone and orders by assigned_at DESC', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getResponsesByClientId('client-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE client_id = $1');
    expect(sql).toContain('ORDER BY assigned_at DESC');
    // Authorisation is the route's job (see routes/clients.ts) — filtering by
    // photographer here would turn "not yours" into an empty list, which
    // invites the caller to retry.
    expect(sql).not.toContain('photographer_id');
    expect(params).toEqual(['client-1']);
  });

  it('returns an empty array when the client has no responses', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(getResponsesByClientId('client-1')).resolves.toEqual([]);
  });
});

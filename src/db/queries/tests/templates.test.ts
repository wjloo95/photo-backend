jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import {
  insertTemplateWithQuestions,
  getTemplateById,
  getTemplateWithQuestionsById,
  getTemplatesByPhotographerId,
  templateHasResponses,
  replaceTemplateQuestions,
  deleteTemplateById,
} from '../templates';
import { pool } from '../../../config/database';
import { AnswerType } from '../../../types';

const mockQuery = pool.query as jest.Mock;
const mockConnect = pool.connect as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
});

const CREATED_AT = new Date('2026-09-01T00:00:00Z');

const templateRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'template-1',
  photographer_id: 'photog-1',
  name: 'Wedding intake',
  created_at: CREATED_AT,
  ...overrides,
});

// A checked-out client for the two transactions. Statements are routed by the
// SQL they contain rather than by call order, so a test doesn't break when a
// statement is added; `failOn` makes one chosen statement reject, which is how
// the rollback paths are exercised.
const makeTxClient = (
  opts: { templateRows?: object[]; failOn?: string } = {},
): { query: jest.Mock; release: jest.Mock } => {
  let inserted = 0;
  const query = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (opts.failOn && sql.includes(opts.failOn)) {
      return Promise.reject(new Error('db exploded'));
    }
    if (sql.includes('INSERT INTO form_templates') || sql.includes('UPDATE form_templates')) {
      return Promise.resolve({ rows: opts.templateRows ?? [templateRow()] });
    }
    if (sql.includes('INSERT INTO form_questions')) {
      const [template_id, content, answer_type, order] = params as [
        string,
        string,
        AnswerType,
        number,
      ];
      inserted += 1;
      return Promise.resolve({
        rows: [{ id: `question-${inserted}`, template_id, content, answer_type, order }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
};

const twoQuestions = [
  { content: 'What time is the ceremony?', answerType: AnswerType.text },
  { content: 'Date of the shoot?', answerType: AnswerType.date },
];

describe('insertTemplateWithQuestions', () => {
  it('inserts the template, then one question per array entry, and commits', async () => {
    const txClient = makeTxClient();
    mockConnect.mockResolvedValue(txClient);

    const result = await insertTemplateWithQuestions('photog-1', {
      name: 'Wedding intake',
      questions: twoQuestions,
    });

    expect(result).toEqual({
      id: 'template-1',
      photographerId: 'photog-1',
      name: 'Wedding intake',
      createdAt: CREATED_AT,
      questions: [
        {
          id: 'question-1',
          templateId: 'template-1',
          content: 'What time is the ceremony?',
          answerType: AnswerType.text,
          order: 0,
        },
        {
          id: 'question-2',
          templateId: 'template-1',
          content: 'Date of the shoot?',
          answerType: AnswerType.date,
          order: 1,
        },
      ],
    });

    const statements = txClient.query.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(txClient.release).toHaveBeenCalled();
  });

  it('writes "order" as the array index, not from the input', async () => {
    const txClient = makeTxClient();
    mockConnect.mockResolvedValue(txClient);

    await insertTemplateWithQuestions('photog-1', { name: 'T', questions: twoQuestions });

    const orders = txClient.query.mock.calls
      .filter((call) => String(call[0]).includes('INSERT INTO form_questions'))
      .map((call) => (call[1] as unknown[])[3]);
    expect(orders).toEqual([0, 1]);
  });

  it('quotes "order" — the column name is a reserved SQL keyword', async () => {
    const txClient = makeTxClient();
    mockConnect.mockResolvedValue(txClient);

    await insertTemplateWithQuestions('photog-1', { name: 'T', questions: twoQuestions });

    const [sql] = txClient.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO form_questions'),
    )!;
    expect(sql).toContain('"order"');
    expect(sql).toContain('RETURNING *');
  });

  it('rolls back and rethrows when a question insert fails, so no partial template survives', async () => {
    const txClient = makeTxClient({ failOn: 'INSERT INTO form_questions' });
    mockConnect.mockResolvedValue(txClient);

    await expect(
      insertTemplateWithQuestions('photog-1', { name: 'T', questions: twoQuestions }),
    ).rejects.toThrow('db exploded');

    const statements = txClient.query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(txClient.release).toHaveBeenCalled();
  });
});

describe('getTemplateById', () => {
  it('maps the row from snake_case to the FormTemplate shape', async () => {
    mockQuery.mockResolvedValue({ rows: [templateRow()] });

    await expect(getTemplateById('template-1')).resolves.toEqual({
      id: 'template-1',
      photographerId: 'photog-1',
      name: 'Wedding intake',
      createdAt: CREATED_AT,
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM form_templates'), [
      'template-1',
    ]);
  });

  // Regression: mapping before the guard (toFormTemplate(rows[0]) ?? null)
  // throws a TypeError on a miss, which surfaces as a 500 instead of a 404.
  it('returns null rather than throwing when no row matches', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(getTemplateById('missing')).resolves.toBeNull();
  });
});

describe('getTemplateWithQuestionsById', () => {
  const joinRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...templateRow(),
    question_id: 'question-1',
    question_content: 'What time is the ceremony?',
    answer_type: AnswerType.text,
    order: 0,
    ...overrides,
  });

  it('folds the repeated template columns into one object with its questions', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        joinRow(),
        joinRow({
          question_id: 'question-2',
          question_content: 'Date of the shoot?',
          answer_type: AnswerType.date,
          order: 1,
        }),
      ],
    });

    await expect(getTemplateWithQuestionsById('template-1')).resolves.toEqual({
      id: 'template-1',
      photographerId: 'photog-1',
      name: 'Wedding intake',
      createdAt: CREATED_AT,
      questions: [
        {
          id: 'question-1',
          templateId: 'template-1',
          content: 'What time is the ceremony?',
          answerType: AnswerType.text,
          order: 0,
        },
        {
          id: 'question-2',
          templateId: 'template-1',
          content: 'Date of the shoot?',
          answerType: AnswerType.date,
          order: 1,
        },
      ],
    });
  });

  // The LEFT JOIN's non-match: one row with every q.* column NULL. It must
  // become questions: [], not a question full of nulls.
  it('returns an empty questions array for a template with no questions', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        joinRow({ question_id: null, question_content: null, answer_type: null, order: null }),
      ],
    });

    await expect(getTemplateWithQuestionsById('template-1')).resolves.toEqual({
      id: 'template-1',
      photographerId: 'photog-1',
      name: 'Wedding intake',
      createdAt: CREATED_AT,
      questions: [],
    });
  });

  it('returns null when the template itself does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(getTemplateWithQuestionsById('missing')).resolves.toBeNull();
  });

  // Regression: a predicate on q.* in WHERE would demote this to an inner
  // join and 404 a template that exists but has no questions.
  it('LEFT JOINs and filters on the template id alone, ordered by "order"', async () => {
    mockQuery.mockResolvedValue({ rows: [joinRow()] });

    await getTemplateWithQuestionsById('template-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('LEFT JOIN form_questions');
    expect(sql).toContain('WHERE t.id = $1');
    expect(sql).toContain('ORDER BY q."order" ASC');
    expect(sql).not.toContain('WHERE q.');
    expect(params).toEqual(['template-1']);
  });
});

describe('getTemplatesByPhotographerId', () => {
  it('maps every row, newest first', async () => {
    mockQuery.mockResolvedValue({
      rows: [templateRow(), templateRow({ id: 'template-2', name: 'Portrait intake' })],
    });

    const result = await getTemplatesByPhotographerId('photog-1');

    expect(result).toEqual([
      {
        id: 'template-1',
        photographerId: 'photog-1',
        name: 'Wedding intake',
        createdAt: CREATED_AT,
      },
      {
        id: 'template-2',
        photographerId: 'photog-1',
        name: 'Portrait intake',
        createdAt: CREATED_AT,
      },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at DESC'), [
      'photog-1',
    ]);
  });

  it('returns an empty array when the photographer has no templates', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(getTemplatesByPhotographerId('photog-1')).resolves.toEqual([]);
  });
});

describe('templateHasResponses', () => {
  it('is true once any response references the template', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    await expect(templateHasResponses('template-1')).resolves.toBe(true);
  });

  it('is false when nothing references it', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(templateHasResponses('template-1')).resolves.toBe(false);
  });

  it('asks only for existence — SELECT 1 against form_responses, LIMIT 1', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await templateHasResponses('template-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('SELECT 1');
    expect(sql).toContain('FROM form_responses');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['template-1']);
  });
});

describe('replaceTemplateQuestions', () => {
  it('updates the name, deletes the old questions, inserts the new set, and commits', async () => {
    const txClient = makeTxClient({ templateRows: [templateRow({ name: 'Renamed' })] });
    mockConnect.mockResolvedValue(txClient);

    const result = await replaceTemplateQuestions('template-1', {
      name: 'Renamed',
      questions: [{ content: 'Only question', answerType: AnswerType.boolean }],
    });

    expect(result).toEqual({
      id: 'template-1',
      photographerId: 'photog-1',
      name: 'Renamed',
      createdAt: CREATED_AT,
      questions: [
        {
          id: 'question-1',
          templateId: 'template-1',
          content: 'Only question',
          answerType: AnswerType.boolean,
          order: 0,
        },
      ],
    });

    const statements = txClient.query.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    // The delete has to land before the inserts, or the new rows collide with
    // the old ones on UNIQUE (template_id, "order") from migration 018.
    const deleteAt = statements.findIndex((sql) => sql.includes('DELETE FROM form_questions'));
    const insertAt = statements.findIndex((sql) => sql.includes('INSERT INTO form_questions'));
    expect(deleteAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeLessThan(insertAt);
  });

  // Regression: returning null here instead of throwing would skip the catch,
  // and the finally would release a client with BEGIN still open — the next
  // borrower inherits the transaction.
  it('throws a 404 and rolls back when the template no longer exists', async () => {
    const txClient = makeTxClient({ templateRows: [] });
    mockConnect.mockResolvedValue(txClient);

    await expect(
      replaceTemplateQuestions('missing', {
        name: 'Renamed',
        questions: [{ content: 'Q', answerType: AnswerType.text }],
      }),
    ).rejects.toMatchObject({ status: 404 });

    const statements = txClient.query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.some((sql) => sql.includes('DELETE FROM form_questions'))).toBe(false);
    expect(txClient.release).toHaveBeenCalled();
  });

  it('rolls back and rethrows when an insert fails, leaving the old questions intact', async () => {
    const txClient = makeTxClient({ failOn: 'INSERT INTO form_questions' });
    mockConnect.mockResolvedValue(txClient);

    await expect(
      replaceTemplateQuestions('template-1', {
        name: 'Renamed',
        questions: [{ content: 'Q', answerType: AnswerType.text }],
      }),
    ).rejects.toThrow('db exploded');

    const statements = txClient.query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(txClient.release).toHaveBeenCalled();
  });
});

describe('deleteTemplateById', () => {
  it('deletes only the template row — the questions cascade (migration 010)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deleteTemplateById('template-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM form_templates');
    expect(sql).not.toContain('form_questions');
    expect(params).toEqual(['template-1']);
  });
});

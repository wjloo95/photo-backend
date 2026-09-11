import type { Request, Response, NextFunction } from 'express';
import { AnswerType, FormTemplate, User, UserRole } from '../../types';

jest.mock('../../db/queries/templates', () => ({
  insertTemplateWithQuestions: jest.fn(),
  getTemplateById: jest.fn(),
  getTemplateWithQuestionsById: jest.fn(),
  replaceTemplateQuestions: jest.fn(),
  templateHasResponses: jest.fn(),
  deleteTemplateById: jest.fn(),
}));

// createResponseForTemplate (8.2) sits on this router because the URL is
// nested under the template, but it reaches into two other query modules.
jest.mock('../../db/queries/responses', () => ({
  insertResponse: jest.fn(),
}));

jest.mock('../../db/queries/clients', () => ({
  getClientByUserId: jest.fn(),
}));

import {
  createTemplate as createTemplateHandler,
  getTemplateFromId as getTemplateFromIdHandler,
  replaceTemplateFromId as replaceTemplateFromIdHandler,
  deleteTemplateFromId as deleteTemplateFromIdHandler,
  createResponseForTemplate as createResponseForTemplateHandler,
  MAX_QUESTIONS,
} from '../templates';
import {
  insertTemplateWithQuestions,
  getTemplateById,
  getTemplateWithQuestionsById,
  replaceTemplateQuestions,
  templateHasResponses,
  deleteTemplateById,
} from '../../db/queries/templates';
import { insertResponse } from '../../db/queries/responses';
import { getClientByUserId } from '../../db/queries/clients';

const insertTemplateWithQuestionsMock = insertTemplateWithQuestions as jest.Mock;
const getTemplateByIdMock = getTemplateById as jest.Mock;
const getTemplateWithQuestionsByIdMock = getTemplateWithQuestionsById as jest.Mock;
const replaceTemplateQuestionsMock = replaceTemplateQuestions as jest.Mock;
const templateHasResponsesMock = templateHasResponses as jest.Mock;
const deleteTemplateByIdMock = deleteTemplateById as jest.Mock;
const insertResponseMock = insertResponse as jest.Mock;
const getClientByUserIdMock = getClientByUserId as jest.Mock;

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const createTemplate = createTemplateHandler as unknown as Handler;
const getTemplateFromId = getTemplateFromIdHandler as unknown as Handler;
const replaceTemplateFromId = replaceTemplateFromIdHandler as unknown as Handler;
const deleteTemplateFromId = deleteTemplateFromIdHandler as unknown as Handler;
const createResponseForTemplate = createResponseForTemplateHandler as unknown as Handler;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

const makeReq = (opts: { params?: object; user?: User; body?: unknown } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user, body: opts.body ?? {} }) as unknown as Request;

const owner: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const someoneElse: User = { ...owner, id: 'photog-2', providerId: 'auth0|photog-2' };

const template: FormTemplate = {
  id: 'template-1',
  photographerId: 'photog-1',
  name: 'Wedding intake',
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

const question = {
  id: 'question-1',
  templateId: 'template-1',
  content: 'What time is the ceremony?',
  answerType: AnswerType.text,
  order: 0,
};

const templateWithQuestions = { ...template, questions: [question] };

const validBody = {
  name: 'Wedding intake',
  questions: [{ content: 'What time is the ceremony?', answerType: AnswerType.text }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createTemplate', () => {
  it('creates the template under the caller identity and responds 201', async () => {
    insertTemplateWithQuestionsMock.mockResolvedValue(templateWithQuestions);
    const req = makeReq({ user: owner, body: validBody });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createTemplate(req, res, next);

    // photographer_id comes from the JWT identity, never the body (D-17).
    expect(insertTemplateWithQuestionsMock).toHaveBeenCalledWith('photog-1', validBody);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(templateWithQuestions);
    expect(next).not.toHaveBeenCalled();
  });

  it('trims name and content before they reach the DB', async () => {
    insertTemplateWithQuestionsMock.mockResolvedValue(templateWithQuestions);
    const req = makeReq({
      user: owner,
      body: { name: '  Wedding intake  ', questions: [{ content: '  Q  ', answerType: 'text' }] },
    });

    await createTemplate(req, makeRes(), jest.fn() as NextFunction);

    expect(insertTemplateWithQuestionsMock).toHaveBeenCalledWith('photog-1', {
      name: 'Wedding intake',
      questions: [{ content: 'Q', answerType: AnswerType.text }],
    });
  });

  // "order" is the array index, assigned by the query layer. Honouring a
  // caller-supplied one is what reintroduces the gaps and duplicates that
  // migration 018's UNIQUE (template_id, "order") rejects.
  it('ignores an order sent by the caller', async () => {
    insertTemplateWithQuestionsMock.mockResolvedValue(templateWithQuestions);
    const req = makeReq({
      user: owner,
      body: { name: 'T', questions: [{ content: 'Q', answerType: 'text', order: 99 }] },
    });

    await createTemplate(req, makeRes(), jest.fn() as NextFunction);

    expect(insertTemplateWithQuestionsMock).toHaveBeenCalledWith('photog-1', {
      name: 'T',
      questions: [{ content: 'Q', answerType: AnswerType.text }],
    });
  });

  describe('rejects a malformed body with 400 before opening a transaction', () => {
    const cases: [string, unknown][] = [
      ['an empty body', {}],
      ['a missing name', { questions: validBody.questions }],
      ['a blank name', { name: '   ', questions: validBody.questions }],
      ['missing questions', { name: 'T' }],
      ['zero questions', { name: 'T', questions: [] }],
      [
        'more than MAX_QUESTIONS questions',
        {
          name: 'T',
          questions: Array.from({ length: MAX_QUESTIONS + 1 }, () => ({
            content: 'Q',
            answerType: AnswerType.text,
          })),
        },
      ],
      ['blank question content', { name: 'T', questions: [{ content: ' ', answerType: 'text' }] }],
      [
        'an answerType outside the enum',
        { name: 'T', questions: [{ content: 'Q', answerType: 'multiple_choice' }] },
      ],
      ['questions that are not an array', { name: 'T', questions: 'nope' }],
    ];

    it.each(cases)('%s', async (_label, body) => {
      const req = makeReq({ user: owner, body });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      await createTemplate(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(insertTemplateWithQuestionsMock).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  it('names the offending field in the 400 message', async () => {
    const req = makeReq({
      user: owner,
      body: {
        name: 'T',
        questions: [
          { content: 'Q', answerType: 'text' },
          { content: '  ', answerType: 'text' },
        ],
      },
    });
    const next = jest.fn() as NextFunction;

    await createTemplate(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('questions.1.content') }),
    );
  });

  it('forwards an unexpected DB error rather than swallowing it', async () => {
    const dbError = new Error('db exploded');
    insertTemplateWithQuestionsMock.mockRejectedValue(dbError);
    const next = jest.fn() as NextFunction;

    await createTemplate(makeReq({ user: owner, body: validBody }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getTemplateFromId', () => {
  it('responds 200 with the template and its questions embedded', async () => {
    getTemplateWithQuestionsByIdMock.mockResolvedValue(templateWithQuestions);
    const req = makeReq({ params: { id: 'template-1' }, user: owner });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getTemplateFromId(req, res, next);

    expect(getTemplateWithQuestionsByIdMock).toHaveBeenCalledWith('template-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(templateWithQuestions);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 404 when no such template exists', async () => {
    getTemplateWithQuestionsByIdMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await getTemplateFromId(makeReq({ params: { id: 'missing' }, user: owner }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it("responds 403 for another photographer's template", async () => {
    getTemplateWithQuestionsByIdMock.mockResolvedValue(templateWithQuestions);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: someoneElse }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('replaceTemplateFromId', () => {
  it('replaces the template addressed by the URL and responds 200', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    replaceTemplateQuestionsMock.mockResolvedValue(templateWithQuestions);
    const req = makeReq({ params: { id: 'template-1' }, user: owner, body: validBody });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await replaceTemplateFromId(req, res, next);

    // Regression: both lookups must use the template id from the URL, not the
    // caller's user id — passing req.user.id 404s every PUT.
    expect(getTemplateByIdMock).toHaveBeenCalledWith('template-1');
    expect(replaceTemplateQuestionsMock).toHaveBeenCalledWith('template-1', validBody);
    // 200, not 201: the resource already exists at this URI.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(templateWithQuestions);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed body with 400 without touching the DB', async () => {
    const next = jest.fn() as NextFunction;

    await replaceTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: owner, body: { name: '', questions: [] } }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(getTemplateByIdMock).not.toHaveBeenCalled();
    expect(replaceTemplateQuestionsMock).not.toHaveBeenCalled();
  });

  it('responds 404 when no such template exists', async () => {
    getTemplateByIdMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await replaceTemplateFromId(
      makeReq({ params: { id: 'missing' }, user: owner, body: validBody }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(replaceTemplateQuestionsMock).not.toHaveBeenCalled();
  });

  it("responds 403 for another photographer's template, before any write", async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    const next = jest.fn() as NextFunction;

    await replaceTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: someoneElse, body: validBody }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(replaceTemplateQuestionsMock).not.toHaveBeenCalled();
  });

  // Migration 019 removed the edit lock rather than tightening it: responses
  // snapshot the questions they were assigned, so recreating question rows here
  // cannot orphan anything and a photographer can revise a template freely.
  it('edits a template that already has responses, without checking for them', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    templateHasResponsesMock.mockResolvedValue(true);
    replaceTemplateQuestionsMock.mockResolvedValue(templateWithQuestions);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await replaceTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: owner, body: validBody }),
      res,
      next,
    );

    expect(templateHasResponsesMock).not.toHaveBeenCalled();
    expect(replaceTemplateQuestionsMock).toHaveBeenCalledWith('template-1', validBody);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  // replaceTemplateQuestions never returns null — it throws AppError 404 from
  // inside its transaction so the rollback happens on the way out.
  it('forwards the 404 the query layer throws when the template vanishes mid-request', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    replaceTemplateQuestionsMock.mockRejectedValue(
      Object.assign(new Error('Template not found'), { status: 404 }),
    );
    const next = jest.fn() as NextFunction;

    await replaceTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: owner, body: validBody }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });
});

describe('deleteTemplateFromId', () => {
  // Regression: res.status(204) alone only sets the code — without send() the
  // row is deleted and the caller waits forever.
  it('deletes the template and sends an empty 204', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    templateHasResponsesMock.mockResolvedValue(false);
    const req = makeReq({ params: { id: 'template-1' }, user: owner });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deleteTemplateFromId(req, res, next);

    expect(deleteTemplateByIdMock).toHaveBeenCalledWith('template-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 404 when no such template exists', async () => {
    getTemplateByIdMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await deleteTemplateFromId(
      makeReq({ params: { id: 'missing' }, user: owner }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(deleteTemplateByIdMock).not.toHaveBeenCalled();
  });

  it("responds 403 for another photographer's template", async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    const next = jest.fn() as NextFunction;

    await deleteTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: someoneElse }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(templateHasResponsesMock).not.toHaveBeenCalled();
    expect(deleteTemplateByIdMock).not.toHaveBeenCalled();
  });

  // The one lock left. A response is a standalone record of what a client was
  // asked and answered, so it must outlive the template; form_responses.
  // template_id is ON DELETE RESTRICT (migration 019) and the database refuses
  // regardless — this check turns that into a 409 rather than a 500.
  it('responds 409 once the template has responses, and does not delete', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    templateHasResponsesMock.mockResolvedValue(true);
    const next = jest.fn() as NextFunction;

    await deleteTemplateFromId(
      makeReq({ params: { id: 'template-1' }, user: owner }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(deleteTemplateByIdMock).not.toHaveBeenCalled();
  });
});

// POST /templates/:id/responses (ASSIGNMENTS.md 8.2) — a photographer assigns
// one of their templates to one of their clients, creating the form_responses
// row the client then fills in.
describe('createResponseForTemplate', () => {
  const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
  const clientRecord = { userId: CLIENT_ID, photographerId: 'photog-1' };

  const response = {
    id: 'response-1',
    templateId: 'template-1',
    clientId: CLIENT_ID,
    // The snapshot, frozen at assign time (migration 019).
    questions: [question],
    answers: {},
    assignedAt: new Date('2026-09-02T00:00:00Z'),
    submittedAt: null,
  };

  const assignReq = (user: User = owner, body: unknown = { clientId: CLIENT_ID }): Request =>
    makeReq({ params: { id: 'template-1' }, user, body });

  it('creates the response and responds 201', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    getClientByUserIdMock.mockResolvedValue(clientRecord);
    insertResponseMock.mockResolvedValue(response);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), res, next);

    // Regression: the template id comes from the URL, not from req.user.id.
    expect(getTemplateByIdMock).toHaveBeenCalledWith('template-1');
    expect(getClientByUserIdMock).toHaveBeenCalledWith(CLIENT_ID);
    expect(insertResponseMock).toHaveBeenCalledWith('template-1', CLIENT_ID);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(response);
    expect(next).not.toHaveBeenCalled();
  });

  // This endpoint takes { clientId }, not a template body — reusing
  // templateBodySchema here rejects every valid assignment with a 400.
  describe('rejects a malformed body with 400 before any DB work', () => {
    const cases: [string, unknown][] = [
      ['an empty body', {}],
      ['a missing clientId', { name: 'Wedding intake' }],
      ['a clientId that is not a uuid', { clientId: 'not-a-uuid' }],
      ['a clientId that is not a string', { clientId: 42 }],
    ];

    it.each(cases)('%s', async (_label, body) => {
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      await createResponseForTemplate(assignReq(owner, body), res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(getTemplateByIdMock).not.toHaveBeenCalled();
      expect(insertResponseMock).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  it('responds 404 when no such template exists', async () => {
    getTemplateByIdMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(insertResponseMock).not.toHaveBeenCalled();
  });

  it("responds 403 for another photographer's template", async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(someoneElse), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(insertResponseMock).not.toHaveBeenCalled();
  });

  // clientId is caller-controlled: without this check a photographer could
  // assign their form to a stranger's client. POST /albums makes the same one.
  it("responds 403 when the client is not one of the caller's", async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    getClientByUserIdMock.mockResolvedValue({ ...clientRecord, photographerId: 'photog-2' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(insertResponseMock).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds 404 when the clientId matches no client at all', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    getClientByUserIdMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(insertResponseMock).not.toHaveBeenCalled();
  });

  // Assigning has never needed a lock check, and since migration 019 there is
  // no edit lock for it to interact with either.
  it('assigns a template that already has responses', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    getClientByUserIdMock.mockResolvedValue(clientRecord);
    insertResponseMock.mockResolvedValue(response);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), res, next);

    expect(templateHasResponsesMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  // The same template may be assigned to the same client more than once — one
  // questionnaire per shoot, each its own instance distinguished by assignedAt.
  it('allows a repeat assignment of the same template to the same client', async () => {
    getTemplateByIdMock.mockResolvedValue(template);
    getClientByUserIdMock.mockResolvedValue(clientRecord);
    insertResponseMock
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ ...response, id: 'response-2' });
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), makeRes(), next);
    const res = makeRes();
    await createResponseForTemplate(assignReq(), res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'response-2' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards an unexpected DB error rather than swallowing it', async () => {
    const dbError = new Error('db exploded');
    getTemplateByIdMock.mockResolvedValue(template);
    getClientByUserIdMock.mockResolvedValue(clientRecord);
    insertResponseMock.mockRejectedValue(dbError);
    const next = jest.fn() as NextFunction;

    await createResponseForTemplate(assignReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

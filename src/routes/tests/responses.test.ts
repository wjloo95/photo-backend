import type { Request, Response, NextFunction } from 'express';
import { AnswerType, FormResponse, User, UserRole } from '../../types';

jest.mock('../../db/queries/responses', () => ({
  getResponseWithOwners: jest.fn(),
  upsertAnswer: jest.fn(),
  submitResponse: jest.fn(),
}));

import {
  getResponseFromId as getResponseFromIdHandler,
  saveAnswer as saveAnswerHandler,
  submitResponseFromId as submitResponseFromIdHandler,
  MAX_ANSWER_LENGTH,
} from '../responses';
import { getResponseWithOwners, upsertAnswer, submitResponse } from '../../db/queries/responses';

const getResponseWithOwnersMock = getResponseWithOwners as jest.Mock;
const upsertAnswerMock = upsertAnswer as jest.Mock;
const submitResponseMock = submitResponse as jest.Mock;

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const getResponseFromId = getResponseFromIdHandler as unknown as Handler;
const saveAnswer = saveAnswerHandler as unknown as Handler;
const submitResponseFromId = submitResponseFromIdHandler as unknown as Handler;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

const makeReq = (opts: { params?: object; user?: User; body?: unknown } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user, body: opts.body ?? {} }) as unknown as Request;

const client: User = {
  id: 'client-1',
  email: 'client@example.com',
  name: 'Casey Client',
  role: UserRole.client,
  providerId: 'auth0|client-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

// The photographer who owns the template this response instantiates. May read
// the response; may never write to it.
const photographer: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const stranger: User = { ...client, id: 'client-2', providerId: 'auth0|client-2' };

const ASSIGNED_AT = new Date('2026-09-01T00:00:00Z');
const SUBMITTED_AT = new Date('2026-09-02T00:00:00Z');

// Real uuids: the body schema rejects anything else, and these ids are matched
// against the response's own question snapshot.
const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_QUESTION_ID = '33333333-3333-4333-8333-333333333333';

const question = {
  id: QUESTION_ID,
  templateId: 'template-1',
  content: 'What time is the ceremony?',
  answerType: AnswerType.text,
  order: 0,
};

const response: FormResponse = {
  id: 'response-1',
  templateId: 'template-1',
  clientId: 'client-1',
  questions: [question],
  answers: {},
  assignedAt: ASSIGNED_AT,
  submittedAt: null,
};

const withOwners = { ...response, photographerId: 'photog-1' };
const submittedWithOwners = { ...withOwners, submittedAt: SUBMITTED_AT };

const answered = { ...response, answers: { [QUESTION_ID]: '3pm' } };

const validBody = { questionId: QUESTION_ID, content: '3pm' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getResponseFromId', () => {
  it('responds 200 to the owning client with questions and answers on the row', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getResponseFromId(makeReq({ params: { id: 'response-1' }, user: client }), res, next);

    expect(getResponseWithOwnersMock).toHaveBeenCalledWith('response-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(withOwners);
    expect(next).not.toHaveBeenCalled();
  });

  // The first endpoint in the app where two different roles pass the same
  // check by different columns.
  it("responds 200 to the photographer who owns the response's template", async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getResponseFromId(
      makeReq({ params: { id: 'response-1' }, user: photographer }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  // This is the only way a client ever sees a template's questions — there is
  // no client-facing template endpoint, which is exactly why the snapshot
  // lives on the response.
  it('carries the question snapshot in the body', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const res = makeRes();

    await getResponseFromId(
      makeReq({ params: { id: 'response-1' }, user: client }),
      res,
      jest.fn() as NextFunction,
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ questions: [question] }));
  });

  // One query, because the row is the whole response now.
  it('reads the response exactly once', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);

    await getResponseFromId(
      makeReq({ params: { id: 'response-1' }, user: client }),
      makeRes(),
      jest.fn() as NextFunction,
    );

    expect(getResponseWithOwnersMock).toHaveBeenCalledTimes(1);
  });

  it('responds 404 when no such response exists', async () => {
    getResponseWithOwnersMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await getResponseFromId(makeReq({ params: { id: 'missing' }, user: client }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('responds 403 to anyone who is neither the client nor the template owner', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getResponseFromId(makeReq({ params: { id: 'response-1' }, user: stranger }), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('forwards an unexpected DB error rather than swallowing it', async () => {
    const dbError = new Error('db exploded');
    getResponseWithOwnersMock.mockRejectedValue(dbError);
    const next = jest.fn() as NextFunction;

    await getResponseFromId(
      makeReq({ params: { id: 'response-1' }, user: client }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('saveAnswer', () => {
  const okReq = (user: User = client, body: unknown = validBody): Request =>
    makeReq({ params: { id: 'response-1' }, user, body });

  it('saves the answer and responds 200 with the updated response', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    upsertAnswerMock.mockResolvedValue(answered);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(), res, next);

    expect(getResponseWithOwnersMock).toHaveBeenCalledWith('response-1');
    expect(upsertAnswerMock).toHaveBeenCalledWith('response-1', QUESTION_ID, '3pm');
    // 200, not 201: the caller can't tell whether their save inserted or
    // overwrote, and 201 would be a lie half the time. The body is the whole
    // response, so the client sees the canonical merged answers object.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(answered);
    expect(next).not.toHaveBeenCalled();
  });

  it('uses the response id from the URL, never anything in the body', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    upsertAnswerMock.mockResolvedValue(answered);

    await saveAnswer(
      okReq(client, { ...validBody, responseId: 'response-99' }),
      makeRes(),
      jest.fn() as NextFunction,
    );

    expect(upsertAnswerMock).toHaveBeenCalledWith('response-1', QUESTION_ID, '3pm');
  });

  it('trims content before it reaches the DB', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    upsertAnswerMock.mockResolvedValue(answered);

    await saveAnswer(
      okReq(client, { questionId: QUESTION_ID, content: '  3pm  ' }),
      makeRes(),
      jest.fn() as NextFunction,
    );

    expect(upsertAnswerMock).toHaveBeenCalledWith('response-1', QUESTION_ID, '3pm');
  });

  describe('rejects a malformed body with 400 before any DB work', () => {
    const cases: [string, unknown][] = [
      ['an empty body', {}],
      ['a missing questionId', { content: '3pm' }],
      // A malformed id must 400 here, not become a junk key in the JSONB
      // object that matches no question.
      ['a questionId that is not a uuid', { questionId: 'not-a-uuid', content: '3pm' }],
      ['a questionId that is not a string', { questionId: 42, content: '3pm' }],
      ['missing content', { questionId: QUESTION_ID }],
      ['blank content', { questionId: QUESTION_ID, content: '   ' }],
      ['content that is not a string', { questionId: QUESTION_ID, content: { a: 1 } }],
      [
        'content longer than MAX_ANSWER_LENGTH',
        { questionId: QUESTION_ID, content: 'x'.repeat(MAX_ANSWER_LENGTH + 1) },
      ],
    ];

    it.each(cases)('%s', async (_label, body) => {
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      await saveAnswer(okReq(client, body), res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
      expect(getResponseWithOwnersMock).not.toHaveBeenCalled();
      expect(upsertAnswerMock).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  it('accepts content of exactly MAX_ANSWER_LENGTH', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    upsertAnswerMock.mockResolvedValue(answered);
    const next = jest.fn() as NextFunction;

    await saveAnswer(
      okReq(client, { questionId: QUESTION_ID, content: 'x'.repeat(MAX_ANSWER_LENGTH) }),
      makeRes(),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(upsertAnswerMock).toHaveBeenCalled();
  });

  it('names the offending field in the 400 message', async () => {
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(client, { questionId: QUESTION_ID, content: '' }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('content') }),
    );
  });

  it('responds 404 when no such response exists', async () => {
    getResponseWithOwnersMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(upsertAnswerMock).not.toHaveBeenCalled();
  });

  // The one place the two owners diverge: the photographer may READ a response
  // but must not answer it, so the GET check cannot be reused here.
  it("responds 403 to the template's photographer — reading is not writing", async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(photographer), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(upsertAnswerMock).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds 403 to another client', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(stranger), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(upsertAnswerMock).not.toHaveBeenCalled();
  });

  // A submitted response is locked. 409, not 403: the caller does own it, the
  // state just forbids the write.
  it('responds 409 once the response has been submitted, and does not write', async () => {
    getResponseWithOwnersMock.mockResolvedValue(submittedWithOwners);
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(upsertAnswerMock).not.toHaveBeenCalled();
  });

  // Since migration 019 this is an array lookup against the response's own
  // snapshot rather than a cross-table query — the ids can't be related by a
  // foreign key, and the data is already in hand.
  it("responds 400 when the question is not in this response's snapshot", async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(client, { questionId: OTHER_QUESTION_ID, content: '3pm' }), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(upsertAnswerMock).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  // The 409 check and the write are two statements, so a submit can land in
  // between; upsertAnswer's `AND submitted_at IS NULL` makes the loser match
  // no row rather than writing to a submitted form.
  it('responds 409 when the response is submitted between the check and the write', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    upsertAnswerMock.mockResolvedValue(null);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('forwards an unexpected DB error rather than swallowing it', async () => {
    const dbError = new Error('db exploded');
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    upsertAnswerMock.mockRejectedValue(dbError);
    const next = jest.fn() as NextFunction;

    await saveAnswer(okReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('submitResponseFromId', () => {
  const okReq = (user: User = client): Request =>
    makeReq({ params: { id: 'response-1' }, user, body: {} });

  it('submits the response and responds 200 with the updated row', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    submitResponseMock.mockResolvedValue({ ...response, submittedAt: SUBMITTED_AT });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(), res, next);

    expect(getResponseWithOwnersMock).toHaveBeenCalledWith('response-1');
    expect(submitResponseMock).toHaveBeenCalledWith('response-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ...response, submittedAt: SUBMITTED_AT });
    expect(next).not.toHaveBeenCalled();
  });

  // No `required` concept exists anywhere in the schema — an unanswered
  // question simply has no key in `answers`.
  it('submits a form with no answers saved at all', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    submitResponseMock.mockResolvedValue({ ...response, submittedAt: SUBMITTED_AT });
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(), makeRes(), next);

    expect(submitResponseMock).toHaveBeenCalledWith('response-1');
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 404 when no such response exists', async () => {
    getResponseWithOwnersMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(
      makeReq({ params: { id: 'missing' }, user: client }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(submitResponseMock).not.toHaveBeenCalled();
  });

  it("responds 403 to the template's photographer — only the client submits", async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(photographer), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(submitResponseMock).not.toHaveBeenCalled();
  });

  it('responds 403 to another client', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(stranger), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(submitResponseMock).not.toHaveBeenCalled();
  });

  it('responds 409 on a second submit, without touching submitted_at again', async () => {
    getResponseWithOwnersMock.mockResolvedValue(submittedWithOwners);
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(submitResponseMock).not.toHaveBeenCalled();
  });

  // Two concurrent submits both pass the 409 above; the loser's UPDATE matches
  // no row because of the submitted_at IS NULL guard, which is what preserves
  // the original timestamp.
  it('responds 409 rather than 200 when the update matches no row', async () => {
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    submitResponseMock.mockResolvedValue(null);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('forwards an unexpected DB error rather than swallowing it', async () => {
    const dbError = new Error('db exploded');
    getResponseWithOwnersMock.mockResolvedValue(withOwners);
    submitResponseMock.mockRejectedValue(dbError);
    const next = jest.fn() as NextFunction;

    await submitResponseFromId(okReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

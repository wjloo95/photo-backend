import type { Request, Response, NextFunction } from 'express';
import { Client, User, UserRole } from '../../types';

jest.mock('../../db/queries/responses', () => ({
  getResponsesByClientId: jest.fn(),
}));

jest.mock('../../db/queries/clients', () => ({
  getClientByUserId: jest.fn(),
}));

import { getClientResponsesFromId as getClientResponsesFromIdHandler } from '../clients';
import { getResponsesByClientId, FormResponseSummary } from '../../db/queries/responses';
import { getClientByUserId } from '../../db/queries/clients';

const getResponsesByClientIdMock = getResponsesByClientId as jest.Mock;
const getClientByUserIdMock = getClientByUserId as jest.Mock;

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const getClientResponsesFromId = getClientResponsesFromIdHandler as unknown as Handler;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

const makeReq = (opts: { params?: object; user?: User } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user, body: {} }) as unknown as Request;

const client: User = {
  id: 'client-1',
  email: 'client@example.com',
  name: 'Casey Client',
  role: UserRole.client,
  providerId: 'auth0|client-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const otherClient: User = { ...client, id: 'client-2', providerId: 'auth0|client-2' };

const photographer: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const otherPhotographer: User = { ...photographer, id: 'photog-2', providerId: 'auth0|photog-2' };

const clientRecord: Client = { userId: 'client-1', photographerId: 'photog-1' };

// Summaries, not full responses: a list view has no use for twenty question
// snapshots, so getResponsesByClientId omits questions and answers entirely.
const responses: FormResponseSummary[] = [
  {
    id: 'response-1',
    templateId: 'template-1',
    clientId: 'client-1',
    assignedAt: new Date('2026-09-02T00:00:00Z'),
    submittedAt: null,
  },
  {
    id: 'response-2',
    templateId: 'template-1',
    clientId: 'client-1',
    assignedAt: new Date('2026-09-01T00:00:00Z'),
    submittedAt: new Date('2026-09-01T12:00:00Z'),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getClientResponsesFromId', () => {
  it('responds 200 with their own responses when the caller is the client', async () => {
    getResponsesByClientIdMock.mockResolvedValue(responses);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getClientResponsesFromId(
      makeReq({ params: { id: 'client-1' }, user: client }),
      res,
      next,
    );

    expect(getResponsesByClientIdMock).toHaveBeenCalledWith('client-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(responses);
    expect(next).not.toHaveBeenCalled();
  });

  // form_responses has no photographer_id, so the photographer's claim runs
  // through the client record — the same check POST /albums makes before
  // trusting a body's clientId.
  it("responds 200 when the caller is the client's own photographer", async () => {
    getClientByUserIdMock.mockResolvedValue(clientRecord);
    getResponsesByClientIdMock.mockResolvedValue(responses);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getClientResponsesFromId(
      makeReq({ params: { id: 'client-1' }, user: photographer }),
      res,
      next,
    );

    expect(getClientByUserIdMock).toHaveBeenCalledWith('client-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(responses);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 200 with an empty list when the client has no responses', async () => {
    getResponsesByClientIdMock.mockResolvedValue([]);
    const res = makeRes();

    await getClientResponsesFromId(
      makeReq({ params: { id: 'client-1' }, user: client }),
      res,
      jest.fn() as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([]);
  });

  // 403 rather than an empty list: empty means "nothing here" and invites the
  // caller to retry, which is why the photographer filter lives in this
  // handler and not in the SQL.
  it("responds 403 to a photographer asking about someone else's client", async () => {
    getClientByUserIdMock.mockResolvedValue(clientRecord);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getClientResponsesFromId(
      makeReq({ params: { id: 'client-1' }, user: otherPhotographer }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getResponsesByClientIdMock).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  // The client_id in the URL is never trusted on its own — the JWT identity
  // decides (D-17).
  it("responds 403 to a client asking for another client's responses", async () => {
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getClientResponsesFromId(
      makeReq({ params: { id: 'client-1' }, user: otherClient }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getResponsesByClientIdMock).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds 403 when the client in the URL does not exist', async () => {
    getClientByUserIdMock.mockResolvedValue(null);
    const next = jest.fn() as NextFunction;

    await getClientResponsesFromId(
      makeReq({ params: { id: 'nobody' }, user: photographer }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getResponsesByClientIdMock).not.toHaveBeenCalled();
  });

  it('forwards an unexpected DB error rather than swallowing it', async () => {
    const dbError = new Error('db exploded');
    getResponsesByClientIdMock.mockRejectedValue(dbError);
    const next = jest.fn() as NextFunction;

    await getClientResponsesFromId(
      makeReq({ params: { id: 'client-1' }, user: client }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

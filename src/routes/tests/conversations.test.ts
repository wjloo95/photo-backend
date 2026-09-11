import type { Request, Response, NextFunction } from 'express';
import { Conversation, Message, User, UserRole } from '../../types';

jest.mock('../../db/queries/conversations', () => ({
  getConversationById: jest.fn(),
  getConversationsByClientId: jest.fn(),
  getConversationsByPhotographerId: jest.fn(),
  getMessagesByConversation: jest.fn(),
  markConversationAsRead: jest.fn(),
  sendMessageByConversation: jest.fn(),
}));

jest.mock('../../cache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

import conversationsRouter, {
  getConversations as getConversationsHandler,
  getConversationFromId as getConversationFromIdHandler,
  getMessagesFromConversation as getMessagesFromConversationHandler,
  addMessageToConversation as addMessageToConversationHandler,
  markConversationRead as markConversationReadHandler,
} from '../conversations';
import {
  getConversationById,
  getConversationsByClientId,
  getConversationsByPhotographerId,
  getMessagesByConversation,
  markConversationAsRead,
  sendMessageByConversation,
} from '../../db/queries/conversations';
import cache from '../../cache';

const getConversationByIdMock = getConversationById as jest.Mock;
const getConversationsByClientIdMock = getConversationsByClientId as jest.Mock;
const getConversationsByPhotographerIdMock = getConversationsByPhotographerId as jest.Mock;
const getMessagesByConversationMock = getMessagesByConversation as jest.Mock;
const markConversationAsReadMock = markConversationAsRead as jest.Mock;
const sendMessageByConversationMock = sendMessageByConversation as jest.Mock;
const cacheGetMock = cache.get as jest.Mock;
const cacheSetMock = cache.set as jest.Mock;
const cacheDelMock = cache.del as jest.Mock;

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const getConversations = getConversationsHandler as unknown as Handler;
const getConversationFromId = getConversationFromIdHandler as unknown as Handler;
const getMessagesFromConversation = getMessagesFromConversationHandler as unknown as Handler;
const addMessageToConversation = addMessageToConversationHandler as unknown as Handler;
const markConversationRead = markConversationReadHandler as unknown as Handler;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }) as unknown as Response;

const makeReq = (
  opts: { params?: object; user?: User; body?: object; query?: object } = {},
): Request =>
  ({
    params: opts.params ?? {},
    user: opts.user,
    body: opts.body ?? {},
    query: opts.query ?? {},
  }) as unknown as Request;

const photographerUser: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const clientUser: User = {
  id: 'client-1',
  email: 'client@example.com',
  name: 'Jane Client',
  role: UserRole.client,
  providerId: 'auth0|client-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const someoneElse: User = { ...clientUser, id: 'someone-else', providerId: 'auth0|someone-else' };

const conversation: Conversation = {
  id: 'convo-1',
  photographerId: 'photog-1',
  clientId: 'client-1',
  mostRecentMessageId: null,
  unreadForPhotographer: 0,
  unreadForClient: 0,
  lastMessageAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const message: Message = {
  id: 'msg-1',
  conversationId: 'convo-1',
  senderId: 'photog-1',
  content: 'hello',
  sentAt: new Date('2026-01-02T00:00:00Z'),
  readAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default every test to a cache miss — tests that care about a hit
  // override this explicitly with cacheGetMock.mockResolvedValueOnce(...).
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(undefined);
  cacheDelMock.mockResolvedValue(undefined);
});

describe('getConversations', () => {
  it('queries by client id for a client caller', async () => {
    getConversationsByClientIdMock.mockResolvedValue([conversation]);
    const req = makeReq({ user: clientUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(getConversationsByClientIdMock).toHaveBeenCalledWith('client-1');
    expect(getConversationsByPhotographerIdMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([conversation]);
    expect(next).not.toHaveBeenCalled();
  });

  it('queries by photographer id for a photographer caller', async () => {
    const conversation2: Conversation = { ...conversation, id: 'convo-2', clientId: 'client-2' };
    getConversationsByPhotographerIdMock.mockResolvedValue([conversation, conversation2]);
    const req = makeReq({ user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(getConversationsByPhotographerIdMock).toHaveBeenCalledWith('photog-1');
    expect(getConversationsByClientIdMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([conversation, conversation2]);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with an empty array (not an error) when the caller has no conversations', async () => {
    getConversationsByPhotographerIdMock.mockResolvedValue([]);
    const req = makeReq({ user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(res.json).toHaveBeenCalledWith([]);
    expect(next).not.toHaveBeenCalled();
  });

  it('on a cache miss, queries the DB and populates conversations:<userId> with a 120s TTL', async () => {
    getConversationsByPhotographerIdMock.mockResolvedValue([conversation]);
    const req = makeReq({ user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(cacheSetMock).toHaveBeenCalledWith('conversations:photog-1', [conversation], 120);
  });

  it('keys the cache by the client caller too, not just the photographer', async () => {
    getConversationsByClientIdMock.mockResolvedValue([conversation]);
    const req = makeReq({ user: clientUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(cacheSetMock).toHaveBeenCalledWith('conversations:client-1', [conversation], 120);
  });

  it('on a cache hit, uses the cached list instead of querying the DB', async () => {
    cacheGetMock.mockResolvedValue([conversation]);
    const req = makeReq({ user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(getConversationsByPhotographerIdMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([conversation]);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getConversationsByPhotographerIdMock.mockRejectedValue(dbError);
    const req = makeReq({ user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversations(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getConversationFromId', () => {
  it('looks up the conversation from the route param, not the caller id', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversationFromId(req, res, next);

    expect(getConversationByIdMock).toHaveBeenCalledWith('convo-1');
  });

  it('forwards a 404 AppError when the conversation does not exist', async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversationFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds 403 when the caller is neither the photographer nor the client on the conversation', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: someoneElse });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversationFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds with the conversation when the caller is the photographer on it', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversationFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(conversation);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with the conversation when the caller is the client on it', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: clientUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversationFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(conversation);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getConversationByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getConversationFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getMessagesFromConversation', () => {
  it('responds 403 to a non-participant and never reads the messages', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: someoneElse });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getMessagesFromConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getMessagesByConversationMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the conversation does not exist', async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getMessagesFromConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(getMessagesByConversationMock).not.toHaveBeenCalled();
  });

  it('responds with the messages, not the conversation', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    getMessagesByConversationMock.mockResolvedValue([message]);
    const req = makeReq({ params: { id: 'convo-1' }, user: clientUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getMessagesFromConversation(req, res, next);

    expect(res.json).toHaveBeenCalledWith([message]);
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults to page 1 with a 50-message page', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    getMessagesByConversationMock.mockResolvedValue([]);
    const req = makeReq({ params: { id: 'convo-1' }, user: clientUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getMessagesFromConversation(req, res, next);

    expect(getMessagesByConversationMock).toHaveBeenCalledWith('convo-1', 50, 0);
  });

  it.each([
    ['page=0', { page: '0' }],
    ['a non-numeric page', { page: 'abc' }],
    ['a negative limit', { limit: '-5' }],
    ['a fractional page', { page: '1.5' }],
  ])('falls back to the defaults for %s rather than erroring', async (_label, query) => {
    getConversationByIdMock.mockResolvedValue(conversation);
    getMessagesByConversationMock.mockResolvedValue([]);
    const req = makeReq({ params: { id: 'convo-1' }, user: clientUser, query });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getMessagesFromConversation(req, res, next);

    expect(getMessagesByConversationMock).toHaveBeenCalledWith('convo-1', 50, 0);
    expect(next).not.toHaveBeenCalled();
  });

  it('translates ?page=&limit= into limit/offset and caps the page size at 100', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    getMessagesByConversationMock.mockResolvedValue([]);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: clientUser,
      query: { page: '3', limit: '500' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getMessagesFromConversation(req, res, next);

    expect(getMessagesByConversationMock).toHaveBeenCalledWith('convo-1', 100, 200);
  });
});

describe('addMessageToConversation', () => {
  it('responds 403 to a non-participant and never writes the message', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: someoneElse,
      body: { content: 'hello' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(sendMessageByConversationMock).not.toHaveBeenCalled();
    expect(cacheDelMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the conversation does not exist', async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const req = makeReq({
      params: { id: 'missing-id' },
      user: photographerUser,
      body: { content: 'hello' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(sendMessageByConversationMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['empty', { content: '   ' }],
    ['not a string', { content: 42 }],
  ])('responds 400 when content is %s', async (_label, body) => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser, body });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(sendMessageByConversationMock).not.toHaveBeenCalled();
  });

  it('responds 400 when content exceeds the 5000-character cap', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: photographerUser,
      body: { content: 'a'.repeat(5001) },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(sendMessageByConversationMock).not.toHaveBeenCalled();
  });

  it('accepts content exactly at the cap', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    sendMessageByConversationMock.mockResolvedValue(message);
    const atCap = 'a'.repeat(5000);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: photographerUser,
      body: { content: atCap },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(sendMessageByConversationMock).toHaveBeenCalledWith('convo-1', 'photog-1', atCap);
    expect(next).not.toHaveBeenCalled();
  });

  it('strips null bytes before the insert rather than letting Postgres reject them', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    sendMessageByConversationMock.mockResolvedValue(message);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: photographerUser,
      body: { content: 'hel\0lo' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(sendMessageByConversationMock).toHaveBeenCalledWith('convo-1', 'photog-1', 'hello');
    expect(next).not.toHaveBeenCalled();
  });

  it('stores other markup-ish content raw — escaping belongs at render time', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    sendMessageByConversationMock.mockResolvedValue(message);
    const raw = `<script>alert(1)</script> & <3 '); DROP TABLE messages; --`;
    const req = makeReq({
      params: { id: 'convo-1' },
      user: photographerUser,
      body: { content: raw },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(sendMessageByConversationMock).toHaveBeenCalledWith('convo-1', 'photog-1', raw);
  });

  it('responds 201 with the created message and invalidates both participants caches', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    sendMessageByConversationMock.mockResolvedValue(message);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: photographerUser,
      body: { content: 'hello' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(sendMessageByConversationMock).toHaveBeenCalledWith('convo-1', 'photog-1', 'hello');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(message);
    expect(cacheDelMock).toHaveBeenCalledWith('conversations:client-1');
    expect(cacheDelMock).toHaveBeenCalledWith('conversations:photog-1');
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getConversationByIdMock.mockResolvedValue(conversation);
    sendMessageByConversationMock.mockRejectedValue(dbError);
    const req = makeReq({
      params: { id: 'convo-1' },
      user: photographerUser,
      body: { content: 'hello' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addMessageToConversation(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('markConversationRead', () => {
  it('responds 403 to a non-participant WITHOUT zeroing any counter', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: someoneElse });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await markConversationRead(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(markConversationAsReadMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the conversation does not exist', async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await markConversationRead(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(markConversationAsReadMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 (not a 200 with a null body) when the row vanishes before the update', async () => {
    getConversationByIdMock.mockResolvedValue(conversation);
    markConversationAsReadMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await markConversationRead(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(res.json).not.toHaveBeenCalled();
    expect(cacheDelMock).not.toHaveBeenCalled();
  });

  it('marks read for the caller and invalidates only the callers list cache', async () => {
    const readConversation: Conversation = { ...conversation, unreadForPhotographer: 0 };
    getConversationByIdMock.mockResolvedValue(conversation);
    markConversationAsReadMock.mockResolvedValue(readConversation);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await markConversationRead(req, res, next);

    expect(markConversationAsReadMock).toHaveBeenCalledWith('convo-1', 'photog-1');
    expect(res.json).toHaveBeenCalledWith(readConversation);
    expect(cacheDelMock).toHaveBeenCalledWith('conversations:photog-1');
    expect(cacheDelMock).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getConversationByIdMock.mockResolvedValue(conversation);
    markConversationAsReadMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'convo-1' }, user: photographerUser });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await markConversationRead(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

// Every test above calls the exported handlers directly, which means nothing
// exercises the router.get/post/patch registrations themselves — a duplicate
// path, a typo'd one, or a handler wired to the wrong method would all go
// unnoticed. This block pins the routing table itself. (Same motivation as
// users.auth-integration.test.ts, which guards the users router's middleware.)
describe('router wiring', () => {
  type RouteLayer = {
    route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  };

  const registeredRoutes = () =>
    (conversationsRouter as unknown as { stack: RouteLayer[] }).stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        method: Object.keys(layer.route!.methods)[0],
        path: layer.route!.path,
        handler: layer.route!.stack[layer.route!.stack.length - 1].handle,
      }));

  it('registers exactly the five Phase 7 endpoints, with no strays', () => {
    expect(registeredRoutes()).toEqual([
      { method: 'get', path: '/', handler: getConversationsHandler },
      { method: 'get', path: '/:id', handler: getConversationFromIdHandler },
      { method: 'get', path: '/:id/messages', handler: getMessagesFromConversationHandler },
      { method: 'post', path: '/:id/messages', handler: addMessageToConversationHandler },
      { method: 'patch', path: '/:id/read', handler: markConversationReadHandler },
    ]);
  });

  it('exposes no route more than once', () => {
    const keys = registeredRoutes().map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

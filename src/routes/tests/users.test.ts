import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { User, UserRole } from '../../types';

jest.mock('../../config/env', () => ({
  env: { AUTH0_WEBHOOK_SECRET: 'test-webhook-secret' },
}));

jest.mock('../../db/queries/users', () => ({
  insertUserFromWebhook: jest.fn(),
  insertClientFromInvite: jest.fn(),
  updateUserById: jest.fn(),
}));

// auth/loadUser are applied directly on the PATCH route (this router is
// mounted before the global auth chain in app.ts) — stub them as pass-through
// so the handler test can drive req.user itself.
jest.mock('../../middleware/auth', () => ({
  auth: (_req: Request, _res: Response, next: NextFunction) => next(),
  loadUser: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import {
  verifyWebhookSignature,
  createUserFromWebhook as createUserFromWebhookHandler,
  updateUserFromId as updateUserFromIdHandler,
} from '../users';
import { insertUserFromWebhook, insertClientFromInvite, updateUserById } from '../../db/queries/users';

const insertUserFromWebhookMock = insertUserFromWebhook as jest.Mock;
const insertClientFromInviteMock = insertClientFromInvite as jest.Mock;
const updateUserByIdMock = updateUserById as jest.Mock;

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const createUserFromWebhook = createUserFromWebhookHandler as unknown as Handler;
const updateUserFromId = updateUserFromIdHandler as unknown as Handler;

const SECRET = 'test-webhook-secret';

const sign = (body: Buffer): string => crypto.createHmac('sha256', SECRET).update(body).digest('hex');

const makeReq = (body: unknown, opts: { signed?: boolean; badSignature?: boolean; header?: string } = {}): Request => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {};
  if (opts.signed !== false) {
    headers['x-webhook-signature'] = opts.badSignature ? 'a'.repeat(64) : sign(rawBody);
  }
  return { headers, rawBody, body } as unknown as Request;
};

describe('verifyWebhookSignature', () => {
  it('returns true when the signature header matches the HMAC of the raw body', () => {
    const req = makeReq({ email: 'a@example.com' });
    expect(verifyWebhookSignature(req)).toBe(true);
  });

  it('returns false when the signature header is missing', () => {
    const req = makeReq({ email: 'a@example.com' }, { signed: false });
    expect(verifyWebhookSignature(req)).toBe(false);
  });

  it('returns false when the signature header does not match', () => {
    const req = makeReq({ email: 'a@example.com' }, { badSignature: true });
    expect(verifyWebhookSignature(req)).toBe(false);
  });

  it('returns false when req.rawBody was never captured', () => {
    const req = { headers: { 'x-webhook-signature': 'deadbeef' } } as unknown as Request;
    expect(verifyWebhookSignature(req)).toBe(false);
  });
});

describe('createUserFromWebhook', () => {
  const makeRes = (): Response =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }) as unknown as Response;

  beforeEach(() => {
    insertUserFromWebhookMock.mockReset();
    insertClientFromInviteMock.mockReset();
  });

  it('responds 401 and does not call insertUserFromWebhook when the signature is invalid', async () => {
    const req = makeReq({ email: 'a@example.com' }, { badSignature: true });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(insertUserFromWebhookMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 201 with the created user when the signature is valid and the insert succeeds', async () => {
    const payload = { email: 'a@example.com', name: 'A Client', role: UserRole.client, providerId: 'auth0|1' };
    const createdUser: User = { id: 'user-1', joinedAt: new Date('2026-01-01T00:00:00Z'), ...payload };
    insertUserFromWebhookMock.mockResolvedValue(createdUser);

    const req = makeReq(payload);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(insertUserFromWebhookMock).toHaveBeenCalledWith(payload);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(createdUser);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from insertUserFromWebhook to next(err) rather than throwing', async () => {
    const payload = { email: 'a@example.com', name: 'A Client', role: UserRole.client, providerId: 'auth0|1' };
    const dbError = new Error('insert failed');
    insertUserFromWebhookMock.mockRejectedValue(dbError);

    const req = makeReq(payload);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.status).not.toHaveBeenCalled();
  });

  // A payload carrying inviteToken means this signup came from an invite
  // link (a client), not a direct Auth0 signup (a photographer) — the two
  // paths funnel through this one webhook per D-08, dispatched here.
  it('calls insertClientFromInvite (not insertUserFromWebhook) when the payload includes an inviteToken', async () => {
    const payload = {
      email: 'invited-client@example.com',
      name: 'Jane Client',
      providerId: 'auth0|client-5',
      inviteToken: 'a'.repeat(64),
    };
    const createdUser: User = {
      id: 'user-5',
      email: payload.email,
      name: payload.name,
      role: UserRole.client,
      providerId: payload.providerId,
      joinedAt: new Date('2026-08-27T00:00:00Z'),
    };
    insertClientFromInviteMock.mockResolvedValue(createdUser);

    const req = makeReq(payload);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(insertClientFromInviteMock).toHaveBeenCalledWith({
      email: payload.email,
      name: payload.name,
      providerId: payload.providerId,
      inviteToken: payload.inviteToken,
    });
    expect(insertUserFromWebhookMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(createdUser);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from insertClientFromInvite (e.g. an expired invite) to next(err)', async () => {
    const payload = {
      email: 'invited-client@example.com',
      name: 'Jane Client',
      providerId: 'auth0|client-5',
      inviteToken: 'a'.repeat(64),
    };
    const inviteError = Object.assign(new Error('Invite is invalid or expired'), { status: 410 });
    insertClientFromInviteMock.mockRejectedValue(inviteError);

    const req = makeReq(payload);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(inviteError);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('updateUserFromId', () => {
  const makeRes = (): Response =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }) as unknown as Response;

  const makeReq = (opts: { params?: object; user?: User; body?: object } = {}): Request =>
    ({ params: opts.params ?? {}, user: opts.user, body: opts.body ?? {} }) as unknown as Request;

  const owner: User = {
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Original Name',
    role: UserRole.client,
    providerId: 'auth0|user-1',
    joinedAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(() => {
    updateUserByIdMock.mockReset();
  });

  it('responds 403 and never calls updateUserById when the caller is not the user in the URL', async () => {
    const req = makeReq({
      params: { id: 'user-1' },
      user: { ...owner, id: 'someone-else' },
      body: { name: 'New Name' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await updateUserFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('updates and responds with the user when the caller owns the record', async () => {
    const updated = { ...owner, email: 'new@example.com', name: 'New Name' };
    updateUserByIdMock.mockResolvedValue(updated);
    const req = makeReq({
      params: { id: 'user-1' },
      user: owner,
      body: { email: 'new@example.com', name: 'New Name' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await updateUserFromId(req, res, next);

    expect(updateUserByIdMock).toHaveBeenCalledWith('user-1', {
      email: 'new@example.com',
      name: 'New Name',
    });
    expect(res.json).toHaveBeenCalledWith(updated);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the user does not exist', async () => {
    updateUserByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'user-1' }, user: owner, body: { name: 'New Name' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await updateUserFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    updateUserByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'user-1' }, user: owner, body: { name: 'New Name' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await updateUserFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

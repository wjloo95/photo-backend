import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { User, UserRole } from '../../types';

vi.mock('../../config/env', () => ({
  env: { AUTH0_WEBHOOK_SECRET: 'test-webhook-secret' },
}));

const { insertUserFromWebhookMock } = vi.hoisted(() => ({ insertUserFromWebhookMock: vi.fn() }));
vi.mock('../../db/queries/users', () => ({
  insertUserFromWebhook: insertUserFromWebhookMock,
}));

import { verifyWebhookSignature, createUserFromWebhook as createUserFromWebhookHandler } from '../users';

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
const createUserFromWebhook = createUserFromWebhookHandler as unknown as (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

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
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }) as unknown as Response;

  beforeEach(() => {
    insertUserFromWebhookMock.mockReset();
  });

  it('responds 401 and does not call insertUserFromWebhook when the signature is invalid', async () => {
    const req = makeReq({ email: 'a@example.com' }, { badSignature: true });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(insertUserFromWebhookMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 201 with the created user when the signature is valid and the insert succeeds', async () => {
    const payload = { email: 'a@example.com', role: UserRole.client, providerId: 'auth0|1' };
    const createdUser: User = { id: 'user-1', joinedAt: new Date('2026-01-01T00:00:00Z'), ...payload };
    insertUserFromWebhookMock.mockResolvedValue(createdUser);

    const req = makeReq(payload);
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(insertUserFromWebhookMock).toHaveBeenCalledWith(payload);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(createdUser);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from insertUserFromWebhook to next(err) rather than throwing', async () => {
    const payload = { email: 'a@example.com', role: UserRole.client, providerId: 'auth0|1' };
    const dbError = new Error('insert failed');
    insertUserFromWebhookMock.mockRejectedValue(dbError);

    const req = makeReq(payload);
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createUserFromWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.status).not.toHaveBeenCalled();
  });
});

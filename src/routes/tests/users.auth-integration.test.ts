import type { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';
import { User, UserRole } from '../../types';

// This file exercises the PATCH /users/:id route through its *real*
// auth + loadUser middleware (not the pass-through stubs used in
// users.test.ts) to guard against a regression where someone removes
// `auth, loadUser` from the `router.patch('/:id', ...)` call in users.ts.
// Since usersRouter is mounted in app.ts *before* the global auth/loadUser
// (to let the unauthenticated webhook route work), this route only stays
// protected because it applies auth/loadUser directly — nothing upstream
// of the router enforces it.

jest.mock('../../config/env', () => ({
  env: { AUTH0_WEBHOOK_SECRET: 'test-webhook-secret' },
}));

// NOTE: unlike the vi.hoisted version, this plain const is safe here (not
// wrapped in the mock factory) because `../users` — which transitively
// requires 'jwks-rsa' — is only ever loaded via a *dynamic* import() inside
// beforeAll below, never a static top-level import. By the time that dynamic
// import runs (after all module-level code, including this assignment, has
// executed), publicKey/privateKey are already populated, so the jwks-rsa
// mock factory's closure over `publicKey` sees a real value, not TDZ.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: {
    expressJwtSecret: () => async () => publicKey,
  },
}));

jest.mock('../../db/queries/users', () => ({
  getUserByProviderId: jest.fn(),
  updateUserById: jest.fn(),
  insertUserFromWebhook: jest.fn(),
}));

import { getUserByProviderId, updateUserById } from '../../db/queries/users';

const getUserByProviderIdMock = getUserByProviderId as jest.Mock;
const updateUserByIdMock = updateUserById as jest.Mock;

process.env.AUTH0_DOMAIN = 'test-tenant.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.local';

const issuer = `https://${process.env.AUTH0_DOMAIN}/`;
const audience = process.env.AUTH0_AUDIENCE;

const signToken = (sub = 'auth0|user-1'): string =>
  jwt.sign({ sub }, privateKey, { algorithm: 'RS256', audience, issuer, expiresIn: '1h' });

let usersRouter: Router;

beforeAll(async () => {
  usersRouter = (await import('../users')).default;
});

const makeReq = (authorization?: string, params: object = { id: 'user-1' }): Request =>
  ({ headers: authorization ? { authorization } : {}, params, body: {} }) as unknown as Request;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }) as unknown as Response;

// Pulls the middleware chain registered for PATCH /:id off the real router
// (auth, loadUser, updateUserFromId) and runs it end-to-end, resolving as
// soon as either next(err) is called (rejected) or the handler sends a
// response via res.json/res.status (succeeded) — exactly what Express does,
// minus the HTTP layer.
const runPatchChain = (req: Request, res: Response): Promise<{ err?: { status?: number } }> => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } };
  type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;
  const stack = (usersRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === '/:id' && l.route.methods.patch);
  if (!layer?.route) throw new Error('PATCH /:id route not found');
  const handlers = layer.route.stack.map((s) => s.handle);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      resolve({ err: err as { status?: number } | undefined });
    };
    (res.json as ReturnType<typeof jest.fn>).mockImplementation(() => finish());
    (res.status as ReturnType<typeof jest.fn>).mockImplementation(() => res);

    let i = 0;
    const next = (err?: unknown) => {
      if (err) return finish(err);
      if (i >= handlers.length) return finish();
      const handler = handlers[i++];
      void handler(req, res, next as NextFunction);
    };
    next();
  });
};

describe('PATCH /users/:id — real auth chain', () => {
  it('rejects with 401 and never touches the DB when no Authorization header is present', async () => {
    const req = makeReq();
    const res = makeRes();

    const { err } = await runPatchChain(req, res);

    expect(err?.status).toBe(401);
    expect(getUserByProviderIdMock).not.toHaveBeenCalled();
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token is signed with an unrecognized key', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = jwt.sign({ sub: 'auth0|user-1' }, otherKey, {
      algorithm: 'RS256',
      audience,
      issuer,
      expiresIn: '1h',
    });
    const req = makeReq(`Bearer ${forged}`);
    const res = makeRes();

    const { err } = await runPatchChain(req, res);

    expect(err?.status).toBe(401);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the JWT is valid but no matching user exists in the DB', async () => {
    getUserByProviderIdMock.mockResolvedValue(null);
    const req = makeReq(`Bearer ${signToken()}`);
    const res = makeRes();

    const { err } = await runPatchChain(req, res);

    expect(err?.status).toBe(401);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('reaches the handler and updates when the token is valid and the caller owns the record', async () => {
    const user: User = {
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Original Name',
      role: UserRole.client,
      providerId: 'auth0|user-1',
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    };
    getUserByProviderIdMock.mockResolvedValue(user);
    updateUserByIdMock.mockResolvedValue({ ...user, name: 'New Name' });

    const req = makeReq(`Bearer ${signToken()}`, { id: 'user-1' });
    req.body = { name: 'New Name' };
    const res = makeRes();

    const { err } = await runPatchChain(req, res);

    expect(err).toBeUndefined();
    expect(updateUserByIdMock).toHaveBeenCalledWith('user-1', { email: undefined, name: 'New Name' });
    expect(res.json).toHaveBeenCalledWith({ ...user, name: 'New Name' });
  });
});

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';
import { User, UserRole } from '../../types';

const generateRsaKeyPair = (): { publicKey: string; privateKey: string } =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

// Generate a real RSA key pair once. `auth` runs the actual express-jwt /
// jsonwebtoken verification logic against tokens we sign with `privateKey`;
// only the JWKS network lookup (jwks-rsa) is stubbed, so failure states
// (missing/expired/wrong-audience/wrong-signature tokens) are exercised for real.
//
// jest.mock factories are hoisted above imports/consts, so they can't reference
// outer-scope variables (that would be a TDZ ReferenceError at runtime). The key
// pair is therefore generated fully inside the factory, and the private key is
// re-exported off the mocked module so the rest of this file can sign tokens
// against the same key the mock hands back for verification.
jest.mock('jwks-rsa', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    __esModule: true,
    default: {
      // express-jwt v8 calls `secret` as `(req, token) => Promise<key>`.
      expressJwtSecret: () => async () => publicKey,
    },
    __testPrivateKey: privateKey,
  };
});

jest.mock('../../db/queries/users', () => ({
  getUserByProviderId: jest.fn(),
}));

import * as jwksRsaModule from 'jwks-rsa';
import { getUserByProviderId } from '../../db/queries/users';

const getUserByProviderIdMock = getUserByProviderId as jest.Mock;
const privateKey = (jwksRsaModule as unknown as { __testPrivateKey: string }).__testPrivateKey;

process.env.AUTH0_DOMAIN = 'test-tenant.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.local';

const issuer = `https://${process.env.AUTH0_DOMAIN}/`;
const audience = process.env.AUTH0_AUDIENCE;

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

let auth: AsyncHandler;
let loadUser: AsyncHandler;

beforeAll(async () => {
  const mod = await import('../auth');
  auth = mod.auth as unknown as AsyncHandler;
  loadUser = mod.loadUser as unknown as AsyncHandler;
});

const signToken = (overrides: Record<string, unknown> = {}, sub = 'auth0|abc123'): string => {
  const options: jwt.SignOptions = { algorithm: 'RS256', audience, issuer };
  if (overrides.exp === undefined) options.expiresIn = '1h';
  return jwt.sign({ sub, ...overrides }, privateKey, options);
};

const makeReq = (authorization?: string): Request =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as Request;

// Runs `auth` and resolves with whatever error (if any) it forwards to next().
const runAuth = (req: Request): Promise<{ err?: { status?: number } }> =>
  new Promise((resolve) => {
    const res = {} as Response;
    const next = ((err?: unknown) => resolve({ err: err as { status?: number } | undefined })) as NextFunction;
    void auth(req, res, next);
  });

describe('auth — JWT verification middleware', () => {
  it('calls next() with no error and attaches the token payload to req.auth on a valid token', async () => {
    const req = makeReq(`Bearer ${signToken()}`);
    const { err } = await runAuth(req);

    expect(err).toBeUndefined();
    expect(req.auth?.sub).toBe('auth0|abc123');
  });

  it('calls next(err) with a 401 when no Authorization header is present', async () => {
    const req = makeReq();
    const { err } = await runAuth(req);

    expect(err).toBeDefined();
    expect(err?.status).toBe(401);
  });

  it('calls next(err) with a 401 for an expired token', async () => {
    const expired = signToken({ exp: Math.floor(Date.now() / 1000) - 10 });
    const { err } = await runAuth(makeReq(`Bearer ${expired}`));

    expect(err).toBeDefined();
    expect(err?.status).toBe(401);
  });

  it('calls next(err) with a 401 when the audience does not match', async () => {
    const wrongAudience = jwt.sign({ sub: 'auth0|abc123' }, privateKey, {
      algorithm: 'RS256',
      audience: 'https://wrong-audience.local',
      issuer,
      expiresIn: '1h',
    });
    const { err } = await runAuth(makeReq(`Bearer ${wrongAudience}`));

    expect(err).toBeDefined();
    expect(err?.status).toBe(401);
  });

  it('calls next(err) with a 401 when the token was signed with a different key', async () => {
    const { privateKey: otherPrivateKey } = generateRsaKeyPair();
    const forged = jwt.sign({ sub: 'auth0|abc123' }, otherPrivateKey, {
      algorithm: 'RS256',
      audience,
      issuer,
      expiresIn: '1h',
    });
    const { err } = await runAuth(makeReq(`Bearer ${forged}`));

    expect(err).toBeDefined();
    expect(err?.status).toBe(401);
  });
});

describe('loadUser — attaches the DB user to req.user', () => {
  const makeLoadUserReq = (sub: string): Request => ({ auth: { sub } }) as unknown as Request;
  const makeRes = (): Response =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }) as unknown as Response;

  beforeEach(() => {
    getUserByProviderIdMock.mockReset();
  });

  it('looks up the user by req.auth.sub, attaches it to req.user, and calls next() on success', async () => {
    const user: User = {
      id: 'user-1',
      email: 'photographer@example.com',
      name: 'Alex Photographer',
      role: UserRole.photographer,
      providerId: 'auth0|abc123',
      joinedAt: new Date('2026-01-01T00:00:00Z'),
    };
    getUserByProviderIdMock.mockResolvedValue(user);

    const req = makeLoadUserReq('auth0|abc123');
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await loadUser(req, res, next);

    expect(getUserByProviderIdMock).toHaveBeenCalledWith('auth0|abc123');
    expect(req.user).toEqual(user);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next(err) with a 401 AppError and does not set req.user when no user matches the provider id', async () => {
    getUserByProviderIdMock.mockResolvedValue(null);

    const req = makeLoadUserReq('auth0|unknown');
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await loadUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof jest.fn>).mock.calls[0][0] as { status?: number; message?: string };
    expect(err.status).toBe(401);
    expect(err.message).toBe('User not found');
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });
});

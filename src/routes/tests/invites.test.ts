import type { Request, Response, NextFunction } from 'express';
import { Invite, InviteStatus, User, UserRole } from '../../types';

jest.mock('../../db/queries/invites', () => ({
  insertInvite: jest.fn(),
  getInviteByToken: jest.fn(),
  expireInvite: jest.fn(),
  getInviteById: jest.fn(),
  refreshInviteToken: jest.fn(),
  deleteInviteById: jest.fn(),
}));

// Deterministic "random" bytes so the test can assert on the exact token
// passed through to insertInvite, without needing real randomness.
jest.mock('node:crypto', () => {
  const randomBytesMock = jest.fn();
  return { default: { randomBytes: randomBytesMock }, randomBytes: randomBytesMock };
});

// auth/loadUser are applied directly on the POST route (this router is
// mounted before the global auth chain in app.ts) — stub them as pass-through
// so the handler tests can drive req.user themselves. Real auth/loadUser
// behavior for this route is covered separately, the same way
// users.auth-integration.test.ts covers PATCH /users/:id.
jest.mock('../../middleware/auth', () => ({
  auth: (_req: Request, _res: Response, next: NextFunction) => next(),
  loadUser: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import {
  createInvite as createInviteHandler,
  validateInvite as validateInviteHandler,
  resendInvite as resendInviteHandler,
  cancelInvite as cancelInviteHandler,
} from '../invites';
import {
  insertInvite,
  getInviteByToken,
  expireInvite,
  getInviteById,
  refreshInviteToken,
  deleteInviteById,
} from '../../db/queries/invites';
import { randomBytes } from 'node:crypto';

const insertInviteMock = insertInvite as jest.Mock;
const getInviteByTokenMock = getInviteByToken as jest.Mock;
const expireInviteMock = expireInvite as jest.Mock;
const getInviteByIdMock = getInviteById as jest.Mock;
const refreshInviteTokenMock = refreshInviteToken as jest.Mock;
const deleteInviteByIdMock = deleteInviteById as jest.Mock;
const randomBytesMock = randomBytes as jest.Mock;

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const createInvite = createInviteHandler as unknown as Handler;
const validateInvite = validateInviteHandler as unknown as Handler;
const resendInvite = resendInviteHandler as unknown as Handler;
const cancelInvite = cancelInviteHandler as unknown as Handler;

const photographer: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const someoneElse: User = { ...photographer, id: 'someone-else', providerId: 'auth0|someone-else' };

const makeReq = (opts: { user?: User; body?: object } = {}): Request =>
  ({ user: opts.user, body: opts.body ?? {} }) as unknown as Request;

const makeParamsReq = (opts: { params?: object; user?: User } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user }) as unknown as Request;

const makeValidateReq = (token?: string): Request =>
  ({ query: token !== undefined ? { token } : {} }) as unknown as Request;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

const FAKE_TOKEN = 'b'.repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
  randomBytesMock.mockReturnValue({ toString: () => FAKE_TOKEN });
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-26T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createInvite', () => {
  it('creates an invite scoped to the requesting photographer with a random token expiring in 30 days', async () => {
    const createdInvite: Invite = {
      id: 'invite-1',
      photographerId: 'photog-1',
      email: 'client@example.com',
      clientName: 'Jane Client',
      token: FAKE_TOKEN,
      status: InviteStatus.pending,
      expiresAt: new Date('2026-09-25T00:00:00Z'),
      acceptedAt: null,
      createdAt: new Date('2026-08-26T00:00:00Z'),
    };
    insertInviteMock.mockResolvedValue(createdInvite);

    const req = makeReq({
      user: photographer,
      body: { email: 'client@example.com', clientName: 'Jane Client' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createInvite(req, res, next);

    expect(insertInviteMock).toHaveBeenCalledWith({
      photographerId: 'photog-1',
      email: 'client@example.com',
      clientName: 'Jane Client',
      token: FAKE_TOKEN,
      expiresAt: new Date('2026-09-25T00:00:00Z'),
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(createdInvite);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    insertInviteMock.mockRejectedValue(dbError);

    const req = makeReq({
      user: photographer,
      body: { email: 'client@example.com', clientName: 'Jane Client' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('validateInvite', () => {
  const pendingInvite: Invite = {
    id: 'invite-1',
    photographerId: 'photog-1',
    email: 'client@example.com',
    clientName: 'Jane Client',
    token: FAKE_TOKEN,
    status: InviteStatus.pending,
    expiresAt: new Date('2026-09-25T00:00:00Z'), // in the future relative to the frozen clock
    acceptedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('forwards a 404 AppError when no invite matches the token', async () => {
    getInviteByTokenMock.mockResolvedValue(null);
    const req = makeValidateReq('does-not-exist');
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await validateInvite(req, res, next);

    expect(getInviteByTokenMock).toHaveBeenCalledWith('does-not-exist');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('forwards a 410 AppError when the invite has already been accepted', async () => {
    getInviteByTokenMock.mockResolvedValue({ ...pendingInvite, status: InviteStatus.accepted });
    const req = makeValidateReq(FAKE_TOKEN);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await validateInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 410 }));
    expect(expireInviteMock).not.toHaveBeenCalled();
  });

  it('forwards a 410 AppError when the invite status is already expired', async () => {
    getInviteByTokenMock.mockResolvedValue({ ...pendingInvite, status: InviteStatus.expired });
    const req = makeValidateReq(FAKE_TOKEN);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await validateInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 410 }));
    expect(expireInviteMock).not.toHaveBeenCalled();
  });

  it('marks a still-pending-but-past-due invite as expired and forwards a 410', async () => {
    getInviteByTokenMock.mockResolvedValue({
      ...pendingInvite,
      expiresAt: new Date('2026-08-20T00:00:00Z'), // before the frozen clock (2026-08-26)
    });
    const req = makeValidateReq(FAKE_TOKEN);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await validateInvite(req, res, next);

    expect(expireInviteMock).toHaveBeenCalledWith('invite-1');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 410 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds with email, clientName, and photographerId for a valid, unexpired, pending invite', async () => {
    getInviteByTokenMock.mockResolvedValue(pendingInvite);
    const req = makeValidateReq(FAKE_TOKEN);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await validateInvite(req, res, next);

    expect(expireInviteMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      email: pendingInvite.email,
      clientName: pendingInvite.clientName,
      photographerId: pendingInvite.photographerId,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getInviteByTokenMock.mockRejectedValue(dbError);
    const req = makeValidateReq(FAKE_TOKEN);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await validateInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('resendInvite', () => {
  const pendingInvite: Invite = {
    id: 'invite-1',
    photographerId: 'photog-1',
    email: 'client@example.com',
    clientName: 'Jane Client',
    token: 'a'.repeat(64),
    status: InviteStatus.pending,
    expiresAt: new Date('2026-08-20T00:00:00Z'), // already past the frozen clock — resend should revive it anyway
    acceptedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('forwards a 404 AppError when no invite matches the id', async () => {
    getInviteByIdMock.mockResolvedValue(null);
    const req = makeParamsReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await resendInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(refreshInviteTokenMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller does not own the invite, and never touches the DB', async () => {
    getInviteByIdMock.mockResolvedValue(pendingInvite);
    const req = makeParamsReq({ params: { id: 'invite-1' }, user: someoneElse });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await resendInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(refreshInviteTokenMock).not.toHaveBeenCalled();
  });

  it('forwards a 409 AppError when the invite has already been accepted', async () => {
    getInviteByIdMock.mockResolvedValue({ ...pendingInvite, status: InviteStatus.accepted });
    const req = makeParamsReq({ params: { id: 'invite-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await resendInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(refreshInviteTokenMock).not.toHaveBeenCalled();
  });

  it('regenerates the token and expiry (reviving an expired invite) when the caller owns it', async () => {
    getInviteByIdMock.mockResolvedValue(pendingInvite);
    const refreshedInvite: Invite = {
      ...pendingInvite,
      token: FAKE_TOKEN,
      status: InviteStatus.pending,
      expiresAt: new Date('2026-09-25T00:00:00Z'),
    };
    refreshInviteTokenMock.mockResolvedValue(refreshedInvite);

    const req = makeParamsReq({ params: { id: 'invite-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await resendInvite(req, res, next);

    expect(refreshInviteTokenMock).toHaveBeenCalledWith('invite-1', {
      token: FAKE_TOKEN,
      expiresAt: new Date('2026-09-25T00:00:00Z'),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(refreshedInvite);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getInviteByIdMock.mockRejectedValue(dbError);
    const req = makeParamsReq({ params: { id: 'invite-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await resendInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('cancelInvite', () => {
  const pendingInvite: Invite = {
    id: 'invite-1',
    photographerId: 'photog-1',
    email: 'client@example.com',
    clientName: 'Jane Client',
    token: 'a'.repeat(64),
    status: InviteStatus.pending,
    expiresAt: new Date('2026-09-25T00:00:00Z'),
    acceptedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('forwards a 404 AppError when no invite matches the id', async () => {
    getInviteByIdMock.mockResolvedValue(null);
    const req = makeParamsReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await cancelInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(deleteInviteByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller does not own the invite, and never deletes it', async () => {
    getInviteByIdMock.mockResolvedValue(pendingInvite);
    const req = makeParamsReq({ params: { id: 'invite-1' }, user: someoneElse });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await cancelInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deleteInviteByIdMock).not.toHaveBeenCalled();
  });

  it('deletes the invite and responds 204 when the caller owns it', async () => {
    getInviteByIdMock.mockResolvedValue(pendingInvite);
    deleteInviteByIdMock.mockResolvedValue(undefined);

    const req = makeParamsReq({ params: { id: 'invite-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await cancelInvite(req, res, next);

    expect(deleteInviteByIdMock).toHaveBeenCalledWith('invite-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getInviteByIdMock.mockRejectedValue(dbError);
    const req = makeParamsReq({ params: { id: 'invite-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await cancelInvite(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

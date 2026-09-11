import type { Request, Response, NextFunction } from 'express';
import { requireRole } from '../requireRole';
import { User, UserRole } from '../../types';

const makeUser = (role: UserRole): User => ({
  id: 'user-1',
  email: 'someone@example.com',
  name: 'Someone',
  role,
  providerId: 'auth0|abc123',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
});

const makeReq = (user?: User): Request => ({ user }) as unknown as Request;
const res = {} as Response;

describe('requireRole', () => {
  it('calls next() with no error when req.user.role matches the required role', () => {
    const req = makeReq(makeUser(UserRole.photographer));
    const next = jest.fn() as NextFunction;

    requireRole(UserRole.photographer)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(err) with a 403 when req.user.role does not match the required role', () => {
    const req = makeReq(makeUser(UserRole.client));
    const next = jest.fn() as NextFunction;

    requireRole(UserRole.photographer)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof jest.fn>).mock.calls[0][0] as { status?: number; message?: string };
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden');
  });

  it('calls next(err) with a 403 when req.user is not set', () => {
    const req = makeReq(undefined);
    const next = jest.fn() as NextFunction;

    requireRole(UserRole.client)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof jest.fn>).mock.calls[0][0] as { status?: number };
    expect(err.status).toBe(403);
  });
});

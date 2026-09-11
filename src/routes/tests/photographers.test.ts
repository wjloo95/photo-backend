import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { AlbumType, InviteStatus, Photographer, User, UserRole, VisibilityType } from '../../types';

const { getPhotographerByUserIdMock, updatePhotographerByUserIdMock } = vi.hoisted(() => ({
  getPhotographerByUserIdMock: vi.fn(),
  updatePhotographerByUserIdMock: vi.fn(),
}));
vi.mock('../../db/queries/photographers', () => ({
  getPhotographerByUserId: getPhotographerByUserIdMock,
  updatePhotographerByUserId: updatePhotographerByUserIdMock,
}));

const { getPhotographerClientsByUserIdMock } = vi.hoisted(() => ({
  getPhotographerClientsByUserIdMock: vi.fn(),
}));
vi.mock('../../db/queries/clients', () => ({
  getPhotographerClientsByUserId: getPhotographerClientsByUserIdMock,
}));

const { getPhotographerAlbumsByUserIdMock } = vi.hoisted(() => ({
  getPhotographerAlbumsByUserIdMock: vi.fn(),
}));
vi.mock('../../db/queries/albums', () => ({
  getPhotographerAlbumsByUserId: getPhotographerAlbumsByUserIdMock,
}));

const { getPendingInvitesByPhotographerIdMock } = vi.hoisted(() => ({
  getPendingInvitesByPhotographerIdMock: vi.fn(),
}));
vi.mock('../../db/queries/invites', () => ({
  getPendingInvitesByPhotographerId: getPendingInvitesByPhotographerIdMock,
}));

import {
  getPhotographerFromId as getPhotographerFromIdHandler,
  getPhotographerClientsFromId as getPhotographerClientsFromIdHandler,
  getPhotographerAlbumsFromId as getPhotographerAlbumsFromIdHandler,
  getPhotographerInvitesFromId as getPhotographerInvitesFromIdHandler,
  updatePhotographerFromId as updatePhotographerFromIdHandler,
} from '../photographers';

// RequestHandler's type signature says it returns void, but the actual
// implementation is async — cast so tests can await it.
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const getPhotographerFromId = getPhotographerFromIdHandler as unknown as Handler;
const getPhotographerClientsFromId = getPhotographerClientsFromIdHandler as unknown as Handler;
const getPhotographerAlbumsFromId = getPhotographerAlbumsFromIdHandler as unknown as Handler;
const getPhotographerInvitesFromId = getPhotographerInvitesFromIdHandler as unknown as Handler;
const updatePhotographerFromId = updatePhotographerFromIdHandler as unknown as Handler;

const makeRes = (): Response =>
  ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  }) as unknown as Response;

const makeReq = (opts: { params?: object; user?: User; body?: object } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user, body: opts.body ?? {} }) as unknown as Request;

const owner: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const someoneElse: User = { ...owner, id: 'someone-else', providerId: 'auth0|someone-else' };

const photographer: Photographer = {
  userId: 'photog-1',
  bio: 'Wedding photographer',
  profilePhotoUrl: 'https://cdn.example.com/photog-1.jpg',
  instagramHandle: '@photog1',
  visibility: VisibilityType.public,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPhotographerFromId', () => {
  it('responds with the photographer when found', async () => {
    getPhotographerByUserIdMock.mockResolvedValue(photographer);
    const req = makeReq({ params: { id: 'photog-1' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerFromId(req, res, next);

    expect(getPhotographerByUserIdMock).toHaveBeenCalledWith('photog-1');
    expect(res.json).toHaveBeenCalledWith(photographer);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when no photographer is found', async () => {
    getPhotographerByUserIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getPhotographerByUserIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'photog-1' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });

  it('responds with a public profile to a non-owner viewer', async () => {
    getPhotographerByUserIdMock.mockResolvedValue(photographer);
    const req = makeReq({ params: { id: 'photog-1' }, user: someoneElse });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(photographer);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 404 (not 403) for a private profile viewed by a non-owner', async () => {
    const privatePhotographer: Photographer = { ...photographer, visibility: VisibilityType.private };
    getPhotographerByUserIdMock.mockResolvedValue(privatePhotographer);
    const req = makeReq({ params: { id: 'photog-1' }, user: someoneElse });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('responds with a private profile to its own owner', async () => {
    const privatePhotographer: Photographer = { ...photographer, visibility: VisibilityType.private };
    getPhotographerByUserIdMock.mockResolvedValue(privatePhotographer);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(privatePhotographer);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('getPhotographerClientsFromId', () => {
  it('responds 403 when the caller is not the photographer in the URL', async () => {
    const req = makeReq({ params: { id: 'photog-1' }, user: someoneElse });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerClientsFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getPhotographerClientsByUserIdMock).not.toHaveBeenCalled();
  });

  it('responds with the client list when the caller owns the photographer profile', async () => {
    const clients = [{ userId: 'client-1', name: 'Jane Client', email: 'jane@example.com' }];
    getPhotographerClientsByUserIdMock.mockResolvedValue(clients);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerClientsFromId(req, res, next);

    expect(getPhotographerClientsByUserIdMock).toHaveBeenCalledWith('photog-1');
    expect(res.json).toHaveBeenCalledWith(clients);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with an empty array (not 404) when the photographer has no clients', async () => {
    getPhotographerClientsByUserIdMock.mockResolvedValue([]);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerClientsFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith([]);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getPhotographerClientsByUserIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerClientsFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getPhotographerAlbumsFromId', () => {
  const fullAlbum = {
    id: 'album-1',
    photographerId: 'photog-1',
    clientId: 'client-1',
    thumbnailPhotoId: 'photo-1',
    type: AlbumType.shoot,
    shootDate: new Date('2026-01-01'),
    accessExpiresAt: new Date('2029-01-01'),
    warned90At: new Date('2028-10-01'),
    warned30At: null,
    warned7At: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('responds 403 when the caller is not the photographer in the URL', async () => {
    const req = makeReq({ params: { id: 'photog-1' }, user: someoneElse });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerAlbumsFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getPhotographerAlbumsByUserIdMock).not.toHaveBeenCalled();
  });

  it('strips warned90At/warned30At/warned7At from the response', async () => {
    getPhotographerAlbumsByUserIdMock.mockResolvedValue([fullAlbum]);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerAlbumsFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith([
      {
        id: 'album-1',
        photographerId: 'photog-1',
        clientId: 'client-1',
        thumbnailPhotoId: 'photo-1',
        type: AlbumType.shoot,
        shootDate: fullAlbum.shootDate,
        accessExpiresAt: fullAlbum.accessExpiresAt,
        createdAt: fullAlbum.createdAt,
      },
    ]);
    const sentAlbum = (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
    expect(sentAlbum).not.toHaveProperty('warned90At');
    expect(sentAlbum).not.toHaveProperty('warned30At');
    expect(sentAlbum).not.toHaveProperty('warned7At');
  });

  it('responds with an empty array (not 404) when the photographer has no albums', async () => {
    getPhotographerAlbumsByUserIdMock.mockResolvedValue([]);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerAlbumsFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith([]);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getPhotographerAlbumsByUserIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerAlbumsFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getPhotographerInvitesFromId', () => {
  const pendingInvite = {
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

  it('responds 403 when the caller is not the photographer in the URL', async () => {
    const req = makeReq({ params: { id: 'photog-1' }, user: someoneElse });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerInvitesFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getPendingInvitesByPhotographerIdMock).not.toHaveBeenCalled();
  });

  it('responds with the pending invites when the caller owns the photographer profile', async () => {
    getPendingInvitesByPhotographerIdMock.mockResolvedValue([pendingInvite]);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerInvitesFromId(req, res, next);

    expect(getPendingInvitesByPhotographerIdMock).toHaveBeenCalledWith('photog-1');
    expect(res.json).toHaveBeenCalledWith([pendingInvite]);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with an empty array (not 404) when the photographer has no pending invites', async () => {
    getPendingInvitesByPhotographerIdMock.mockResolvedValue([]);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerInvitesFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith([]);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getPendingInvitesByPhotographerIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getPhotographerInvitesFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('updatePhotographerFromId', () => {
  it('responds 403 when the caller is not the photographer in the URL, and never touches the DB', async () => {
    const req = makeReq({
      params: { id: 'photog-1' },
      user: someoneElse,
      body: { bio: 'new bio' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updatePhotographerFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(updatePhotographerByUserIdMock).not.toHaveBeenCalled();
  });

  it('updates and responds with the photographer when the caller owns the profile', async () => {
    const updated = { ...photographer, bio: 'new bio' };
    updatePhotographerByUserIdMock.mockResolvedValue(updated);
    const req = makeReq({
      params: { id: 'photog-1' },
      user: owner,
      body: { bio: 'new bio', instagramHandle: '@photog1', profilePhotoUrl: photographer.profilePhotoUrl },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updatePhotographerFromId(req, res, next);

    expect(updatePhotographerByUserIdMock).toHaveBeenCalledWith('photog-1', {
      bio: 'new bio',
      instagramHandle: '@photog1',
      profilePhotoUrl: photographer.profilePhotoUrl,
    });
    expect(res.json).toHaveBeenCalledWith(updated);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the photographer does not exist', async () => {
    updatePhotographerByUserIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner, body: { bio: 'new bio' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updatePhotographerFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    updatePhotographerByUserIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'photog-1' }, user: owner, body: { bio: 'new bio' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updatePhotographerFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

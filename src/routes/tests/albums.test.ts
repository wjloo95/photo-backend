import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { Album, AlbumType, User, UserRole } from '../../types';

const {
  insertAlbumMock,
  getAlbumByIdMock,
  updateAlbumByIdMock,
  deleteAlbumByIdMock,
} = vi.hoisted(() => ({
  insertAlbumMock: vi.fn(),
  getAlbumByIdMock: vi.fn(),
  updateAlbumByIdMock: vi.fn(),
  deleteAlbumByIdMock: vi.fn(),
}));
vi.mock('../../db/queries/albums', () => ({
  insertAlbum: insertAlbumMock,
  getAlbumById: getAlbumByIdMock,
  updateAlbumById: updateAlbumByIdMock,
  deleteAlbumById: deleteAlbumByIdMock,
}));

const { getClientByUserIdMock } = vi.hoisted(() => ({ getClientByUserIdMock: vi.fn() }));
vi.mock('../../db/queries/clients', () => ({
  getClientByUserId: getClientByUserIdMock,
}));

import {
  createAlbum as createAlbumHandler,
  getAlbumFromId as getAlbumFromIdHandler,
  updateAlbumFromId as updateAlbumFromIdHandler,
  deleteAlbumFromId as deleteAlbumFromIdHandler,
} from '../albums';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const createAlbum = createAlbumHandler as unknown as Handler;
const getAlbumFromId = getAlbumFromIdHandler as unknown as Handler;
const updateAlbumFromId = updateAlbumFromIdHandler as unknown as Handler;
const deleteAlbumFromId = deleteAlbumFromIdHandler as unknown as Handler;

const photographer: User = {
  id: 'photog-1',
  email: 'photog@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photog-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const someoneElsePhotographer: User = {
  ...photographer,
  id: 'someone-else',
  providerId: 'auth0|someone-else',
};

const client: User = {
  id: 'client-1',
  email: 'client@example.com',
  name: 'Jane Client',
  role: UserRole.client,
  providerId: 'auth0|client-1',
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

const someoneElseClient: User = { ...client, id: 'someone-else-client', providerId: 'auth0|c2' };

const shootAlbum: Album = {
  id: 'album-1',
  photographerId: 'photog-1',
  clientId: 'client-1',
  thumbnailPhotoId: null,
  type: AlbumType.shoot,
  shootDate: new Date('2026-01-01'),
  accessExpiresAt: new Date('2029-01-01'),
  warned90At: null,
  warned30At: null,
  warned7At: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const portfolioAlbum: Album = { ...shootAlbum, id: 'album-2', clientId: null, type: AlbumType.portfolio };

const makeReq = (opts: { params?: object; user?: User; body?: object } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user, body: opts.body ?? {} }) as unknown as Request;

const makeRes = (): Response =>
  ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createAlbum', () => {
  it('creates a shoot album, computing accessExpiresAt as shootDate + 3 years, after verifying the client belongs to this photographer', async () => {
    getClientByUserIdMock.mockResolvedValue({ userId: 'client-1', photographerId: 'photog-1' });
    insertAlbumMock.mockResolvedValue(shootAlbum);

    const req = makeReq({
      user: photographer,
      body: { clientId: 'client-1', type: AlbumType.shoot, shootDate: '2026-01-01' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(getClientByUserIdMock).toHaveBeenCalledWith('client-1');
    expect(insertAlbumMock).toHaveBeenCalledWith({
      photographerId: 'photog-1',
      clientId: 'client-1',
      type: AlbumType.shoot,
      shootDate: new Date('2026-01-01'),
      accessExpiresAt: new Date('2029-01-01'),
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(shootAlbum);
    expect(next).not.toHaveBeenCalled();
  });

  it('creates a portfolio album with a null clientId, skipping the client ownership check entirely', async () => {
    insertAlbumMock.mockResolvedValue(portfolioAlbum);

    const req = makeReq({
      user: photographer,
      body: { clientId: 'someone-elses-client', type: AlbumType.portfolio, shootDate: '2026-01-01' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(getClientByUserIdMock).not.toHaveBeenCalled();
    expect(insertAlbumMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: null, type: AlbumType.portfolio }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('forwards a 400 AppError when creating a shoot album without a clientId', async () => {
    const req = makeReq({
      user: photographer,
      body: { type: AlbumType.shoot, shootDate: '2026-01-01' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(insertAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when clientId does not belong to the requesting photographer', async () => {
    getClientByUserIdMock.mockResolvedValue({ userId: 'client-1', photographerId: 'a-different-photog' });

    const req = makeReq({
      user: photographer,
      body: { clientId: 'client-1', type: AlbumType.shoot, shootDate: '2026-01-01' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(insertAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getClientByUserIdMock.mockResolvedValue({ userId: 'client-1', photographerId: 'photog-1' });
    insertAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({
      user: photographer,
      body: { clientId: 'client-1', type: AlbumType.shoot, shootDate: '2026-01-01' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getAlbumFromId', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('responds with the album when the caller is the owning photographer', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(shootAlbum);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with the album when the caller is the linked client', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: client });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(shootAlbum);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when a different photographer requests it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards a 403 AppError when a different client requests it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElseClient });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards a 403 AppError when a client requests a portfolio album (no linked client)', async () => {
    getAlbumByIdMock.mockResolvedValue(portfolioAlbum);
    const req = makeReq({ params: { id: 'album-2' }, user: client });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('updateAlbumFromId', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer, body: {} });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updateAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(updateAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is not the owning photographer, and never touches the DB', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({
      params: { id: 'album-1' },
      user: someoneElsePhotographer,
      body: { thumbnailPhotoId: 'photo-2' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updateAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(updateAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('updates the thumbnail and responds with the updated album when the caller owns it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const updated = { ...shootAlbum, thumbnailPhotoId: 'photo-2' };
    updateAlbumByIdMock.mockResolvedValue(updated);

    const req = makeReq({
      params: { id: 'album-1' },
      user: photographer,
      body: { thumbnailPhotoId: 'photo-2' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updateAlbumFromId(req, res, next);

    expect(updateAlbumByIdMock).toHaveBeenCalledWith('album-1', { thumbnailPhotoId: 'photo-2' });
    expect(res.json).toHaveBeenCalledWith(updated);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, body: {} });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await updateAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('deleteAlbumFromId', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(deleteAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is not the owning photographer, and never deletes it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deleteAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('deletes the album and responds 204 when the caller owns it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

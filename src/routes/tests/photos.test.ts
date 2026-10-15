import type { Request, Response, NextFunction } from 'express';
import { Photo, PhotoStatus, User, UserRole } from '../../types';

jest.mock('../../db/queries/photos', () => ({
  getPhotoById: jest.fn(),
  getAlbumOwnersForPhoto: jest.fn(),
  deletePhotoById: jest.fn(),
}));

jest.mock('../../cache', () => ({
  __esModule: true,
  default: { del: jest.fn() },
}));

import { getPhotoFromId as getPhotoFromIdHandler, deletePhotoFromId as deletePhotoFromIdHandler } from '../photos';
import { getPhotoById, getAlbumOwnersForPhoto, deletePhotoById } from '../../db/queries/photos';
import cache from '../../cache';

const getPhotoByIdMock = getPhotoById as jest.Mock;
const getAlbumOwnersForPhotoMock = getAlbumOwnersForPhoto as jest.Mock;
const deletePhotoByIdMock = deletePhotoById as jest.Mock;
const cacheDelMock = cache.del as jest.Mock;

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const getPhotoFromId = getPhotoFromIdHandler as unknown as Handler;
const deletePhotoFromId = deletePhotoFromIdHandler as unknown as Handler;

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

const photo: Photo = {
  id: 'photo-1',
  basePath: 'cloudinary/key',
  status: PhotoStatus.ready,
  width: 1920,
  height: 1080,
  uploadedAt: new Date('2026-01-01T00:00:00Z'),
};

const makeReq = (opts: { params?: object; user?: User } = {}): Request =>
  ({ params: opts.params ?? {}, user: opts.user }) as unknown as Request;

const makeRes = (): Response =>
  ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getPhotoFromId', () => {
  it('forwards a 404 AppError when no photo matches the id', async () => {
    getPhotoByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(getAlbumOwnersForPhotoMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is a photographer who owns none of the photo’s albums', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'a-different-photog', clientId: 'client-1' },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards a 403 AppError when the caller is a client not linked to any of the photo’s albums', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'client-1' },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: someoneElseClient });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards a 403 AppError when the photo belongs to no album at all', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([]);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('responds with the photo when the caller owns one of its albums', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'client-1' },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(photo);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with the photo when the caller is a client linked to one of its albums', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'client-1' },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: client });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(photo);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with the photo when the photo belongs to multiple albums and the caller owns just one of them', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'a-different-photog', clientId: 'some-client' },
      { photographerId: 'photog-1', clientId: 'client-1' },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(photo);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getPhotoByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getPhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('deletePhotoFromId', () => {
  it('forwards a 404 AppError when no photo matches the id', async () => {
    getPhotoByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(deletePhotoByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller owns none of the photo’s albums', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'a-different-photog', clientId: null },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deletePhotoByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the photo belongs to no album at all', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([]);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deletePhotoByIdMock).not.toHaveBeenCalled();
  });

  it('permanently deletes the photo and responds 204 when the caller owns one of its albums', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'client-1' },
    ]);
    deletePhotoByIdMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(deletePhotoByIdMock).toHaveBeenCalledWith('photo-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });

  it('clears the cached photo list of every album that contained the photo, after deleting it', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { albumId: 'album-1', photographerId: 'photog-1', clientId: 'client-1' },
      { albumId: 'album-2', photographerId: 'photog-1', clientId: null },
    ]);
    deletePhotoByIdMock.mockResolvedValue(undefined);
    cacheDelMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(cacheDelMock).toHaveBeenCalledTimes(2);
    expect(cacheDelMock).toHaveBeenCalledWith('album:photos:album-1');
    expect(cacheDelMock).toHaveBeenCalledWith('album:photos:album-2');
    expect(deletePhotoByIdMock.mock.invocationCallOrder[0]).toBeLessThan(
      cacheDelMock.mock.invocationCallOrder[0],
    );
  });

  it('clears no cache when the caller is not allowed to delete the photo', async () => {
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { albumId: 'album-1', photographerId: 'someone-else', clientId: null },
    ]);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(cacheDelMock).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getPhotoByIdMock.mockResolvedValue(photo);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'client-1' },
    ]);
    deletePhotoByIdMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deletePhotoFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

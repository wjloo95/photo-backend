import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import os from 'node:os';
import path from 'node:path';
import { Album, AlbumType, Photo, PhotoStatus, User, UserRole } from '../../types';

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

const {
  insertPhotosForAlbumMock,
  getPhotoByIdMock,
  getPhotosForAlbumMock,
  getAlbumOwnersForPhotoMock,
  addPhotoToAlbumMock,
  removePhotoFromAlbumMock,
  deletePhotosFromAlbumMock,
} = vi.hoisted(() => ({
  insertPhotosForAlbumMock: vi.fn(),
  getPhotoByIdMock: vi.fn(),
  getPhotosForAlbumMock: vi.fn(),
  getAlbumOwnersForPhotoMock: vi.fn(),
  addPhotoToAlbumMock: vi.fn(),
  removePhotoFromAlbumMock: vi.fn(),
  deletePhotosFromAlbumMock: vi.fn(),
}));
vi.mock('../../db/queries/photos', () => ({
  insertPhotosForAlbum: insertPhotosForAlbumMock,
  getPhotoById: getPhotoByIdMock,
  getPhotosForAlbum: getPhotosForAlbumMock,
  getAlbumOwnersForPhoto: getAlbumOwnersForPhotoMock,
  addPhotoToAlbum: addPhotoToAlbumMock,
  removePhotoFromAlbum: removePhotoFromAlbumMock,
  deletePhotosFromAlbum: deletePhotosFromAlbumMock,
}));

const { photoQueueAddMock } = vi.hoisted(() => ({ photoQueueAddMock: vi.fn() }));
vi.mock('../../jobs/queues/photoQueue', () => ({
  photoQueue: { add: photoQueueAddMock },
  // Real enum value, not the mock — routes/tests assert against this string.
  PhotoJobName: { ProcessBatch: 'process-batch' },
}));

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  default: { rename: renameMock },
  rename: renameMock,
}));

import {
  createAlbum as createAlbumHandler,
  getAlbumFromId as getAlbumFromIdHandler,
  updateAlbumFromId as updateAlbumFromIdHandler,
  deleteAlbumFromId as deleteAlbumFromIdHandler,
  createAlbumPhotosBatch as createAlbumPhotosBatchHandler,
  getAlbumPhotos as getAlbumPhotosHandler,
  deleteAlbumPhotosBatch as deleteAlbumPhotosBatchHandler,
  addAlbumPhoto as addAlbumPhotoHandler,
  removeAlbumPhoto as removeAlbumPhotoHandler,
} from '../albums';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const createAlbum = createAlbumHandler as unknown as Handler;
const getAlbumFromId = getAlbumFromIdHandler as unknown as Handler;
const updateAlbumFromId = updateAlbumFromIdHandler as unknown as Handler;
const deleteAlbumFromId = deleteAlbumFromIdHandler as unknown as Handler;
const createAlbumPhotosBatch = createAlbumPhotosBatchHandler as unknown as Handler;
const getAlbumPhotos = getAlbumPhotosHandler as unknown as Handler;
const deleteAlbumPhotosBatch = deleteAlbumPhotosBatchHandler as unknown as Handler;
const addAlbumPhoto = addAlbumPhotoHandler as unknown as Handler;
const removeAlbumPhoto = removeAlbumPhotoHandler as unknown as Handler;

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

const makeReq = (
  opts: { params?: object; user?: User; body?: object; files?: unknown; query?: object } = {},
): Request =>
  ({
    params: opts.params ?? {},
    user: opts.user,
    body: opts.body ?? {},
    files: opts.files,
    query: opts.query ?? {},
  }) as unknown as Request;

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

const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'sys-photo-uploads');

const uploadedFiles: { path: string; originalname: string }[] = [
  { path: '/tmp/sys-photo-uploads/multer-tmp-a', originalname: 'a.jpg' },
  { path: '/tmp/sys-photo-uploads/multer-tmp-b', originalname: 'b.jpg' },
];

const createdPhotos: Photo[] = [
  {
    id: 'photo-1',
    basePath: '',
    status: PhotoStatus.processing,
    width: null,
    height: null,
    uploadedAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'photo-2',
    basePath: '',
    status: PhotoStatus.processing,
    width: null,
    height: null,
    uploadedAt: new Date('2026-01-01T00:00:00Z'),
  },
];

describe('createAlbumPhotosBatch', () => {
  beforeEach(() => {
    renameMock.mockResolvedValue(undefined);
    photoQueueAddMock.mockResolvedValue(undefined);
  });

  it('forwards a 404 AppError when no album matches the id, and never inserts photos', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is not the owning photographer, and never inserts photos', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({
      params: { id: 'album-1' },
      user: someoneElsePhotographer,
      files: uploadedFiles,
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when req.files is missing', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when req.files is an empty array', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: [] });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('inserts one photo per file, renames each temp file to its photo id, enqueues one job, and responds 202', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    insertPhotosForAlbumMock.mockResolvedValue(createdPhotos);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(insertPhotosForAlbumMock).toHaveBeenCalledWith('album-1', 2);

    expect(renameMock).toHaveBeenNthCalledWith(
      1,
      uploadedFiles[0].path,
      path.join(UPLOAD_TMP_DIR, 'photo-1'),
    );
    expect(renameMock).toHaveBeenNthCalledWith(
      2,
      uploadedFiles[1].path,
      path.join(UPLOAD_TMP_DIR, 'photo-2'),
    );

    expect(photoQueueAddMock).toHaveBeenCalledWith('process-batch', {
      photoIds: ['photo-1', 'photo-2'],
      albumId: 'album-1',
    });

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(createdPhotos);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from insertPhotosForAlbum, without renaming files or enqueuing a job', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    insertPhotosForAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
    expect(renameMock).not.toHaveBeenCalled();
    expect(photoQueueAddMock).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards errors from the file rename step, without enqueuing a job or responding', async () => {
    const fsError = new Error('EACCES: permission denied');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    insertPhotosForAlbumMock.mockResolvedValue(createdPhotos);
    renameMock.mockRejectedValueOnce(fsError);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(fsError);
    expect(photoQueueAddMock).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards errors from enqueuing the job, without responding', async () => {
    const queueError = new Error('Redis connection refused');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    insertPhotosForAlbumMock.mockResolvedValue(createdPhotos);
    photoQueueAddMock.mockRejectedValue(queueError);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(queueError);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('getAlbumPhotos', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(getPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is neither the owning photographer nor the linked client', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('responds with photos for the owning photographer, defaulting to page 1 / limit 20', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotosForAlbumMock.mockResolvedValue(createdPhotos);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(getPhotosForAlbumMock).toHaveBeenCalledWith('album-1', 20, 0);
    expect(res.json).toHaveBeenCalledWith(createdPhotos);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with photos for the linked client', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotosForAlbumMock.mockResolvedValue(createdPhotos);

    const req = makeReq({ params: { id: 'album-1' }, user: client });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(res.json).toHaveBeenCalledWith(createdPhotos);
    expect(next).not.toHaveBeenCalled();
  });

  it('computes OFFSET as (page - 1) * limit from ?page=&limit=', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotosForAlbumMock.mockResolvedValue([]);

    const req = makeReq({
      params: { id: 'album-1' },
      user: photographer,
      query: { page: '3', limit: '10' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(getPhotosForAlbumMock).toHaveBeenCalledWith('album-1', 10, 20);
  });

  it('caps limit at 100 even when a larger value is requested', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotosForAlbumMock.mockResolvedValue([]);

    const req = makeReq({
      params: { id: 'album-1' },
      user: photographer,
      query: { limit: '10000' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(getPhotosForAlbumMock).toHaveBeenCalledWith('album-1', 100, 0);
  });

  it.each([['0'], ['-1'], ['abc'], ['1.5']])(
    'falls back to defaults for an invalid page value (%s)',
    async (page) => {
      getAlbumByIdMock.mockResolvedValue(shootAlbum);
      getPhotosForAlbumMock.mockResolvedValue([]);

      const req = makeReq({ params: { id: 'album-1' }, user: photographer, query: { page } });
      const res = makeRes();
      const next = vi.fn() as NextFunction;

      await getAlbumPhotos(req, res, next);

      expect(getPhotosForAlbumMock).toHaveBeenCalledWith('album-1', 20, 0);
    },
  );

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotosForAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await getAlbumPhotos(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('deleteAlbumPhotosBatch', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({
      params: { id: 'missing-id' },
      user: photographer,
      body: { photoIds: ['photo-1'] },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(deletePhotosFromAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is not the owning photographer', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({
      params: { id: 'album-1' },
      user: someoneElsePhotographer,
      body: { photoIds: ['photo-1'] },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deletePhotosFromAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when photoIds is missing', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, body: {} });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(deletePhotosFromAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when photoIds is an empty array', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, body: { photoIds: [] } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(deletePhotosFromAlbumMock).not.toHaveBeenCalled();
  });

  it('removes the listed photos from the album and responds 204', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    deletePhotosFromAlbumMock.mockResolvedValue(undefined);

    const req = makeReq({
      params: { id: 'album-1' },
      user: photographer,
      body: { photoIds: ['photo-1', 'photo-2'] },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(deletePhotosFromAlbumMock).toHaveBeenCalledWith('album-1', ['photo-1', 'photo-2']);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    deletePhotosFromAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({
      params: { id: 'album-1' },
      user: photographer,
      body: { photoIds: ['photo-1'] },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('addAlbumPhoto', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(getPhotoByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller does not own the destination album', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({
      params: { id: 'album-1', photoId: 'photo-1' },
      user: someoneElsePhotographer,
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getPhotoByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the photo does not exist', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotoByIdMock.mockResolvedValue(null);

    const req = makeReq({ params: { id: 'album-1', photoId: 'missing-photo' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(addPhotoToAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller has no access to the photo through any of their own albums', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotoByIdMock.mockResolvedValue(createdPhotos[0]);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'a-different-photographer', clientId: null },
    ]);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(addPhotoToAlbumMock).not.toHaveBeenCalled();
  });

  it('links the photo into the album and responds 201 when the caller already has access to it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotoByIdMock.mockResolvedValue(createdPhotos[0]);
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'some-other-client' },
    ]);
    addPhotoToAlbumMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(addPhotoToAlbumMock).toHaveBeenCalledWith('album-1', 'photo-1');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(createdPhotos[0]);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotoByIdMock.mockResolvedValue(createdPhotos[0]);
    getAlbumOwnersForPhotoMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('removeAlbumPhoto', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(removePhotoFromAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is not the owning photographer', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({
      params: { id: 'album-1', photoId: 'photo-1' },
      user: someoneElsePhotographer,
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(removePhotoFromAlbumMock).not.toHaveBeenCalled();
  });

  it('removes the photo from the album only, and responds 204', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    removePhotoFromAlbumMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(removePhotoFromAlbumMock).toHaveBeenCalledWith('album-1', 'photo-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    removePhotoFromAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

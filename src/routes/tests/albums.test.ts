import type { Request, Response, NextFunction } from 'express';
import os from 'node:os';
import path from 'node:path';
import { Album, AlbumType, Photo, PhotoStatus, User, UserRole } from '../../types';

jest.mock('../../db/queries/albums', () => ({
  insertAlbum: jest.fn(),
  getAlbumById: jest.fn(),
  updateAlbumById: jest.fn(),
  deleteAlbumById: jest.fn(),
  // Real implementation, not a stub — tests need the actual date coercion
  // to verify a cache hit really does come back rehydrated.
  rehydrateAlbumDates: (album: Album) => ({
    ...album,
    shootDate: new Date(album.shootDate),
    accessExpiresAt: album.accessExpiresAt ? new Date(album.accessExpiresAt) : null,
    warned90At: album.warned90At ? new Date(album.warned90At) : null,
    warned30At: album.warned30At ? new Date(album.warned30At) : null,
    warned7At: album.warned7At ? new Date(album.warned7At) : null,
    createdAt: new Date(album.createdAt),
  }),
}));

jest.mock('../../db/queries/clients', () => ({
  getClientByUserId: jest.fn(),
}));

jest.mock('../../db/queries/photos', () => ({
  insertPhotosForAlbum: jest.fn(),
  getPhotoById: jest.fn(),
  getAllPhotosForAlbum: jest.fn(),
  // Real implementation, not a stub — same reasoning as rehydrateAlbumDates.
  rehydrateAlbumPhotoDates: (photo: AlbumPhoto) => ({
    ...photo,
    uploadedAt: new Date(photo.uploadedAt),
    addedAt: new Date(photo.addedAt),
  }),
  getAlbumOwnersForPhoto: jest.fn(),
  addPhotoToAlbum: jest.fn(),
  removePhotoFromAlbum: jest.fn(),
  deletePhotosFromAlbum: jest.fn(),
}));

jest.mock('../../cache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock('../../jobs/queues/photoQueue', () => ({
  photoQueue: { add: jest.fn() },
  // Real enum value, not the mock — routes/tests assert against this string.
  PhotoJobName: { ProcessBatch: 'process-batch' },
}));

jest.mock('node:fs/promises', () => {
  const renameMock = jest.fn();
  return { __esModule: true, default: { rename: renameMock }, rename: renameMock };
});

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
import { insertAlbum, getAlbumById, updateAlbumById, deleteAlbumById } from '../../db/queries/albums';
import { getClientByUserId } from '../../db/queries/clients';
import {
  insertPhotosForAlbum,
  getPhotoById,
  getAllPhotosForAlbum,
  getAlbumOwnersForPhoto,
  addPhotoToAlbum,
  removePhotoFromAlbum,
  deletePhotosFromAlbum,
} from '../../db/queries/photos';
import cache from '../../cache';
import { photoQueue } from '../../jobs/queues/photoQueue';
import { rename } from 'node:fs/promises';
import type { AlbumPhoto } from '../../db/queries/photos';

const insertAlbumMock = insertAlbum as jest.Mock;
const getAlbumByIdMock = getAlbumById as jest.Mock;
const updateAlbumByIdMock = updateAlbumById as jest.Mock;
const deleteAlbumByIdMock = deleteAlbumById as jest.Mock;
const getClientByUserIdMock = getClientByUserId as jest.Mock;
const insertPhotosForAlbumMock = insertPhotosForAlbum as jest.Mock;
const getPhotoByIdMock = getPhotoById as jest.Mock;
const getAllPhotosForAlbumMock = getAllPhotosForAlbum as jest.Mock;
const getAlbumOwnersForPhotoMock = getAlbumOwnersForPhoto as jest.Mock;
const addPhotoToAlbumMock = addPhotoToAlbum as jest.Mock;
const removePhotoFromAlbumMock = removePhotoFromAlbum as jest.Mock;
const deletePhotosFromAlbumMock = deletePhotosFromAlbum as jest.Mock;
const cacheGetMock = cache.get as jest.Mock;
const cacheSetMock = cache.set as jest.Mock;
const cacheDelMock = cache.del as jest.Mock;
const photoQueueAddMock = photoQueue.add as jest.Mock;
const renameMock = rename as jest.Mock;

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

// Portfolio albums never expire (migration 020), so the fixture carries the
// null the CHECK constraint requires — not shootAlbum's date.
const portfolioAlbum: Album = {
  ...shootAlbum,
  id: 'album-2',
  clientId: null,
  type: AlbumType.portfolio,
  accessExpiresAt: null,
};

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
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  // Default every test to a cache miss — tests that care about a hit
  // override this explicitly with cacheGetMock.mockResolvedValueOnce(...).
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(undefined);
  cacheDelMock.mockResolvedValue(undefined);
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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(getClientByUserIdMock).not.toHaveBeenCalled();
    expect(insertAlbumMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: null, type: AlbumType.portfolio }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // Expiry exists because a client's access to their shoot is time-limited. A
  // portfolio album belongs to the photographer and has no client to lose
  // access, so it never expires — which is also what keeps it out of the
  // warning and deletion pipelines, since both filter on a non-null date.
  it('creates a portfolio album with a null accessExpiresAt, so it never expires', async () => {
    insertAlbumMock.mockResolvedValue(portfolioAlbum);

    await createAlbum(
      makeReq({
        user: photographer,
        body: { type: AlbumType.portfolio, shootDate: '2026-01-01' },
      }),
      makeRes(),
      jest.fn() as NextFunction,
    );

    expect(insertAlbumMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessExpiresAt: null }),
    );
  });

  // Regression: computing the date unconditionally and only branching on
  // clientId is the easy mistake — it type-checks, inserts fine, and puts
  // portfolio albums back on the deletion path three years later.
  it('still computes shootDate + 3 years for a shoot album', async () => {
    insertAlbumMock.mockResolvedValue(shootAlbum);
    getClientByUserIdMock.mockResolvedValue({ userId: 'client-1', photographerId: 'photog-1' });

    await createAlbum(
      makeReq({
        user: photographer,
        body: { clientId: 'client-1', type: AlbumType.shoot, shootDate: '2026-01-01' },
      }),
      makeRes(),
      jest.fn() as NextFunction,
    );

    expect(insertAlbumMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessExpiresAt: new Date('2029-01-01') }),
    );
  });

  it('forwards a 400 AppError when creating a shoot album without a clientId', async () => {
    const req = makeReq({
      user: photographer,
      body: { type: AlbumType.shoot, shootDate: '2026-01-01' },
    });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await createAlbum(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('getAlbumFromId', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('on a cache miss, queries the DB and populates album:meta: with a 900s TTL', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(getAlbumByIdMock).toHaveBeenCalledWith('album-1');
    expect(cacheSetMock).toHaveBeenCalledWith('album:meta:album-1', shootAlbum, 900);
  });

  it('on a cache hit, uses the cached album instead of querying the DB', async () => {
    cacheGetMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(getAlbumByIdMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(shootAlbum);
  });

  it('responds with the album when the caller is the owning photographer', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(shootAlbum);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds with the album when the caller is the linked client', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: client });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(res.json).toHaveBeenCalledWith(shootAlbum);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when a different photographer requests it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards a 403 AppError when a different client requests it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElseClient });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards a 403 AppError when a client requests a portfolio album (no linked client)', async () => {
    getAlbumByIdMock.mockResolvedValue(portfolioAlbum);
    const req = makeReq({ params: { id: 'album-2' }, user: client });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('updateAlbumFromId', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer, body: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await updateAlbumFromId(req, res, next);

    expect(updateAlbumByIdMock).toHaveBeenCalledWith('album-1', { thumbnailPhotoId: 'photo-2' });
    expect(res.json).toHaveBeenCalledWith(updated);
    expect(next).not.toHaveBeenCalled();
    // Invalidates the album's own metadata, not the (unrelated) photo list.
    expect(cacheDelMock).toHaveBeenCalledWith('album:meta:album-1');
    expect(cacheDelMock).not.toHaveBeenCalledWith('album:photos:album-1');
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, body: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await updateAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('deleteAlbumFromId', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(deleteAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is not the owning photographer, and never deletes it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: someoneElsePhotographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deleteAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('deletes the album and responds 204 when the caller owns it', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deleteAlbumFromId(req, res, next);

    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(cacheDelMock).toHaveBeenCalledWith('album:meta:album-1');
    expect(cacheDelMock).not.toHaveBeenCalledWith('album:photos:album-1');
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockRejectedValue(dbError);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when req.files is missing', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when req.files is an empty array', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: [] });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(insertPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('inserts one photo per file, renames each temp file to its photo id, enqueues one job, and responds 202', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    insertPhotosForAlbumMock.mockResolvedValue(createdPhotos);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    // New photos change album membership, not the album's own fields.
    expect(cacheDelMock).toHaveBeenCalledWith('album:photos:album-1');
    expect(cacheDelMock).not.toHaveBeenCalledWith('album:meta:album-1');
  });

  it('forwards errors from insertPhotosForAlbum, without renaming files or enqueuing a job', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    insertPhotosForAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1' }, user: photographer, files: uploadedFiles });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await createAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(queueError);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('getAlbumPhotos', () => {
  // An album's photos in the order getAllPhotosForAlbum returns them:
  // (addedAt, id). Photos 1–3 share an addedAt (one batch upload), so the id
  // tie-break is exercised; the last two are still processing.
  const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 2, 0, minute));
  function albumPhoto(n: number, addedAt: Date, status = PhotoStatus.ready): AlbumPhoto {
    return {
      id: `photo-${String(n).padStart(2, '0')}`,
      basePath: status === PhotoStatus.ready ? `photo-${n}` : '',
      status,
      width: status === PhotoStatus.ready ? 800 : null,
      height: status === PhotoStatus.ready ? 600 : null,
      uploadedAt: new Date('2026-01-01T00:00:00Z'),
      addedAt,
    };
  }
  const albumPhotos: AlbumPhoto[] = [
    albumPhoto(1, at(0)),
    albumPhoto(2, at(0)),
    albumPhoto(3, at(0)),
    albumPhoto(4, at(1)),
    albumPhoto(5, at(2)),
    albumPhoto(6, at(3), PhotoStatus.processing),
    albumPhoto(7, at(3), PhotoStatus.processing),
  ];
  const ids = (photos: { id: string }[]): string[] => photos.map((photo) => photo.id);
  // What a cache hit hands the handler: the list after a JSON round trip.
  const asCached = (photos: AlbumPhoto[]): unknown => JSON.parse(JSON.stringify(photos));

  interface PhotosBody {
    data: Photo[];
    nextCursor: string | null;
    total: number;
    processingCount: number;
  }

  async function request(
    query: object = {},
    user: User = photographer,
  ): Promise<{ res: Response; next: NextFunction; body: PhotosBody | undefined }> {
    const req = makeReq({ params: { id: 'album-1' }, user, query });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    await getAlbumPhotos(req, res, next);
    const body = (res.json as jest.Mock).mock.calls[0]?.[0] as PhotosBody | undefined;
    return { res, next, body };
  }

  // Follows nextCursor from the first page to null, returning every page.
  async function walk(query: object = {}): Promise<PhotosBody[]> {
    const pages: PhotosBody[] = [];
    let cursor: string | null | undefined;
    do {
      const { body } = await request(cursor ? { ...query, cursor } : query);
      pages.push(body!);
      cursor = body!.nextCursor;
    } while (cursor && pages.length < 50);
    return pages;
  }

  beforeEach(() => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getAllPhotosForAlbumMock.mockResolvedValue(albumPhotos);
  });

  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);

    const { next } = await request();

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(getAllPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError when the caller is neither the owning photographer nor the linked client', async () => {
    const { next } = await request({}, someoneElsePhotographer);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getAllPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 403 AppError for a client who is not the linked client', async () => {
    const { next } = await request({}, someoneElseClient);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('responds with photos for the linked client', async () => {
    const { body, next } = await request({}, client);

    expect(body!.data).toHaveLength(7);
    expect(next).not.toHaveBeenCalled();
  });

  it('on a full cache miss, fetches the album and the full photo list and populates both caches', async () => {
    await request();

    expect(getAlbumByIdMock).toHaveBeenCalledWith('album-1');
    expect(cacheSetMock).toHaveBeenCalledWith('album:meta:album-1', shootAlbum, 900);
    expect(getAllPhotosForAlbumMock).toHaveBeenCalledWith('album-1');
    expect(cacheSetMock).toHaveBeenCalledWith('album:photos:album-1', albumPhotos, 300);
  });

  it('reuses a cached album instead of querying the DB again', async () => {
    cacheGetMock.mockImplementation((key: string) =>
      Promise.resolve(key === 'album:meta:album-1' ? shootAlbum : null),
    );

    const { body } = await request();

    expect(getAlbumByIdMock).not.toHaveBeenCalled();
    expect(body!.total).toBe(7);
  });

  it('reuses a cached photo list instead of querying the DB again, rehydrating its dates', async () => {
    cacheGetMock.mockImplementation((key: string) =>
      Promise.resolve(key === 'album:photos:album-1' ? asCached(albumPhotos) : null),
    );

    const { body } = await request();

    expect(getAllPhotosForAlbumMock).not.toHaveBeenCalled();
    expect(body!.data[0].uploadedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('responds with the { data, nextCursor, total, processingCount } envelope, without the internal addedAt', async () => {
    const { body } = await request({ limit: '2' });

    expect(Object.keys(body!).sort()).toEqual(['data', 'nextCursor', 'processingCount', 'total']);
    expect(body!.data[0]).toEqual({
      id: 'photo-01',
      basePath: 'photo-1',
      status: PhotoStatus.ready,
      width: 800,
      height: 600,
      uploadedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(typeof body!.nextCursor).toBe('string');
  });

  it('counts every photo in total without a filter, and the processing ones in processingCount', async () => {
    const { body } = await request();

    expect(body!.total).toBe(7);
    expect(body!.processingCount).toBe(2);
  });

  it('with ?status=ready, leaves processing photos out of data and total but still reports processingCount', async () => {
    const { body } = await request({ status: 'ready' });

    expect(ids(body!.data)).toEqual(['photo-01', 'photo-02', 'photo-03', 'photo-04', 'photo-05']);
    expect(body!.total).toBe(5);
    expect(body!.processingCount).toBe(2);
  });

  it('reports processingCount 0 when nothing is processing', async () => {
    getAllPhotosForAlbumMock.mockResolvedValue(albumPhotos.slice(0, 5));

    const { body } = await request();

    expect(body!.processingCount).toBe(0);
  });

  describe('with a failed photo', () => {
    // photo-07 used to be processing; its upload job then failed for good.
    beforeEach(() => {
      getAllPhotosForAlbumMock.mockResolvedValue([
        ...albumPhotos.slice(0, 6),
        albumPhoto(7, at(3), PhotoStatus.failed),
      ]);
    });

    it('drops it from processingCount, which counts processing photos only', async () => {
      const { body } = await request();

      expect(body!.processingCount).toBe(1);
    });

    it('leaves it out of ?status=ready', async () => {
      const { body } = await request({ status: 'ready' });

      expect(ids(body!.data)).not.toContain('photo-07');
      expect(body!.total).toBe(5);
    });

    it('includes it, with empty dimensions, in the unfiltered (studio) list', async () => {
      const { body } = await request();

      expect(body!.total).toBe(7);
      expect(body!.data[6]).toMatchObject({
        id: 'photo-07',
        status: PhotoStatus.failed,
        basePath: '',
        width: null,
        height: null,
      });
    });
  });

  it.each([['processing'], ['READY'], ['bogus']])(
    'treats an unknown status (%s) as absent',
    async (status) => {
      const { body } = await request({ status });

      expect(body!.total).toBe(7);
    },
  );

  it('treats a repeated status param as absent', async () => {
    const { body } = await request({ status: ['ready', 'ready'] });

    expect(body!.total).toBe(7);
  });

  it('walking every cursor returns each photo exactly once, in (addedAt, id) order', async () => {
    const pages = await walk({ limit: '2' });

    expect(pages).toHaveLength(4);
    expect(ids(pages.flatMap((page) => page.data))).toEqual(ids(albumPhotos));
    expect(pages[pages.length - 1].nextCursor).toBeNull();
    // Fetched from the DB on every request here (the cache mock never hits),
    // but always the full list — never a per-page query.
    expect(getAllPhotosForAlbumMock).toHaveBeenCalledTimes(4);
  });

  it('walking every cursor with ?status=ready returns each ready photo exactly once, in order', async () => {
    const pages = await walk({ limit: '2', status: 'ready' });

    expect(ids(pages.flatMap((page) => page.data))).toEqual([
      'photo-01',
      'photo-02',
      'photo-03',
      'photo-04',
      'photo-05',
    ]);
    expect(pages.every((page) => page.total === 5 && page.processingCount === 2)).toBe(true);
  });

  it('pages photos that share an addedAt in id order, with none duplicated or lost across a page boundary', async () => {
    // The page boundary falls between photo-02 and photo-03, which share
    // at(0) with photo-01, so only the id tie-break places photo-03.
    const pages = await walk({ limit: '2' });

    expect(ids(pages[0].data)).toEqual(['photo-01', 'photo-02']);
    expect(ids(pages[1].data)).toEqual(['photo-03', 'photo-04']);
  });

  it('returns nextCursor null when the page reaches exactly the last photo', async () => {
    const { body } = await request({ limit: '7' });

    expect(body!.data).toHaveLength(7);
    expect(body!.nextCursor).toBeNull();
  });

  it('responds with an empty first page for an album with no photos', async () => {
    getAllPhotosForAlbumMock.mockResolvedValue([]);

    const { body } = await request();

    expect(body).toEqual({ data: [], nextCursor: null, total: 0, processingCount: 0 });
  });

  it('does not skip a photo when one is removed from inside page 1 before page 2 is fetched', async () => {
    const { body: page1 } = await request({ limit: '3' });
    // photo-02 is removed from the album between the two requests.
    getAllPhotosForAlbumMock.mockResolvedValue(albumPhotos.filter((p) => p.id !== 'photo-02'));

    const { body: page2 } = await request({ limit: '3', cursor: page1!.nextCursor });

    expect(ids(page1!.data)).toEqual(['photo-01', 'photo-02', 'photo-03']);
    expect(ids(page2!.data)).toEqual(['photo-04', 'photo-05', 'photo-06']);
  });

  it("still returns the photos after a cursor's position when the cursor's own photo was removed", async () => {
    const { body: page1 } = await request({ limit: '3' });
    // photo-03 was the last photo on page 1, the one the cursor encodes.
    getAllPhotosForAlbumMock.mockResolvedValue(albumPhotos.filter((p) => p.id !== 'photo-03'));

    const { body: page2 } = await request({ limit: '3', cursor: page1!.nextCursor });

    expect(ids(page2!.data)).toEqual(['photo-04', 'photo-05', 'photo-06']);
  });

  it('includes a photo added to the album after the cursor was issued, at the end', async () => {
    const { body: page1 } = await request({ limit: '5' });
    getAllPhotosForAlbumMock.mockResolvedValue([...albumPhotos, albumPhoto(8, at(4))]);

    const { body: page2 } = await request({ limit: '5', cursor: page1!.nextCursor });

    expect(ids(page2!.data)).toEqual(['photo-06', 'photo-07', 'photo-08']);
  });

  it('returns an empty last page when nothing sorts after the cursor any more', async () => {
    const { body: page1 } = await request({ limit: '5' });
    getAllPhotosForAlbumMock.mockResolvedValue(albumPhotos.slice(0, 5));

    const { body: page2 } = await request({ limit: '5', cursor: page1!.nextCursor });

    expect(page2).toEqual({ data: [], nextCursor: null, total: 5, processingCount: 0 });
  });

  it('accepts a cursor issued on a cache miss on a cache-hit request', async () => {
    const { body: page1 } = await request({ limit: '3' });
    cacheGetMock.mockImplementation((key: string) =>
      Promise.resolve(key === 'album:photos:album-1' ? asCached(albumPhotos) : null),
    );

    const { body: page2 } = await request({ limit: '3', cursor: page1!.nextCursor });

    expect(getAllPhotosForAlbumMock).toHaveBeenCalledTimes(1);
    expect(ids(page2!.data)).toEqual(['photo-04', 'photo-05', 'photo-06']);
  });

  it('accepts a cursor issued on a cache hit on a cache-miss request', async () => {
    cacheGetMock.mockImplementation((key: string) =>
      Promise.resolve(key === 'album:photos:album-1' ? asCached(albumPhotos) : null),
    );
    const { body: page1 } = await request({ limit: '3' });
    cacheGetMock.mockResolvedValue(null);

    const { body: page2 } = await request({ limit: '3', cursor: page1!.nextCursor });

    expect(getAllPhotosForAlbumMock).toHaveBeenCalledTimes(1);
    expect(ids(page2!.data)).toEqual(['photo-04', 'photo-05', 'photo-06']);
  });

  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['not base64 JSON', 'not-a-cursor'],
    ['empty', ''],
    ['the wrong shape', encode({ at: '2026-01-02T00:00:00.000Z', id: 'photo-01' })],
    ['a missing id', encode(['2026-01-02T00:00:00.000Z', ''])],
    ['an invalid date', encode(['not-a-date', 'photo-01'])],
    ['a non-ISO date', encode(['2026-01-02', 'photo-01'])],
    ['a repeated param', ['a', 'b']],
  ])('responds 400 for a malformed cursor (%s)', async (_label, cursor) => {
    const { next, res } = await request({ cursor });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, message: 'Invalid cursor' }),
    );
    expect(res.json).not.toHaveBeenCalled();
    expect(getAllPhotosForAlbumMock).not.toHaveBeenCalled();
  });

  it('caps limit at 100 even when a larger value is requested', async () => {
    getAllPhotosForAlbumMock.mockResolvedValue(
      Array.from({ length: 150 }, (_, i) => albumPhoto(i + 1, at(i))),
    );

    const { body } = await request({ limit: '10000' });

    expect(body!.data).toHaveLength(100);
    expect(body!.nextCursor).not.toBeNull();
  });

  it.each([['0'], ['-1'], ['abc'], ['1.5']])(
    'falls back to a limit of 20 for an invalid limit value (%s)',
    async (limit) => {
      getAllPhotosForAlbumMock.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => albumPhoto(i + 1, at(i))),
      );

      const { body } = await request({ limit });

      expect(body!.data).toHaveLength(20);
    },
  );

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAllPhotosForAlbumMock.mockRejectedValue(dbError);

    const { next } = await request();

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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(deletePhotosFromAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when photoIds is missing', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, body: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(deletePhotosFromAlbumMock).not.toHaveBeenCalled();
  });

  it('forwards a 400 AppError when photoIds is an empty array', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    const req = makeReq({ params: { id: 'album-1' }, user: photographer, body: { photoIds: [] } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(deletePhotosFromAlbumMock).toHaveBeenCalledWith('album-1', ['photo-1', 'photo-2']);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
    // Removing photos changes album membership, not the album's own fields —
    // regression check for the album:meta:/album:photos: key mixup.
    expect(cacheDelMock).toHaveBeenCalledWith('album:photos:album-1');
    expect(cacheDelMock).not.toHaveBeenCalledWith('album:meta:album-1');
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
    const next = jest.fn() as NextFunction;

    await deleteAlbumPhotosBatch(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('addAlbumPhoto', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(getPhotoByIdMock).not.toHaveBeenCalled();
  });

  it('forwards a 404 AppError when the photo does not exist', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotoByIdMock.mockResolvedValue(null);

    const req = makeReq({ params: { id: 'album-1', photoId: 'missing-photo' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(addPhotoToAlbumMock).toHaveBeenCalledWith('album-1', 'photo-1');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(createdPhotos[0]);
    expect(next).not.toHaveBeenCalled();
    // Linking a photo in changes album membership, not the album's own fields —
    // regression check for the album:meta:/album:photos: key mixup.
    expect(cacheDelMock).toHaveBeenCalledWith('album:photos:album-1');
    expect(cacheDelMock).not.toHaveBeenCalledWith('album:meta:album-1');
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    getPhotoByIdMock.mockResolvedValue(createdPhotos[0]);
    getAlbumOwnersForPhotoMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await addAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe('removeAlbumPhoto', () => {
  it('forwards a 404 AppError when no album matches the id', async () => {
    getAlbumByIdMock.mockResolvedValue(null);
    const req = makeReq({ params: { id: 'missing-id', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

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
    const next = jest.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(removePhotoFromAlbumMock).not.toHaveBeenCalled();
  });

  it('removes the photo from the album only, and responds 204', async () => {
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    removePhotoFromAlbumMock.mockResolvedValue(undefined);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(removePhotoFromAlbumMock).toHaveBeenCalledWith('album-1', 'photo-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
    // Unlinking a photo changes album membership, not the album's own fields —
    // regression check for the album:meta:/album:photos: key mixup.
    expect(cacheDelMock).toHaveBeenCalledWith('album:photos:album-1');
    expect(cacheDelMock).not.toHaveBeenCalledWith('album:meta:album-1');
  });

  it('forwards errors from the query layer to next(err)', async () => {
    const dbError = new Error('connection lost');
    getAlbumByIdMock.mockResolvedValue(shootAlbum);
    removePhotoFromAlbumMock.mockRejectedValue(dbError);

    const req = makeReq({ params: { id: 'album-1', photoId: 'photo-1' }, user: photographer });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await removeAlbumPhoto(req, res, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

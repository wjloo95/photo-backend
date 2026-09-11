import { Router, RequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import { UPLOAD_TMP_DIR } from '../config/uploads';
import {
  insertAlbum,
  getAlbumById,
  updateAlbumById,
  deleteAlbumById,
  rehydrateAlbumDates,
} from '../db/queries/albums';
import { getClientByUserId } from '../db/queries/clients';
import { Album, AlbumType, Photo, UserRole } from '../types';
import { requireRole } from '../middleware/requireRole';
import { AppError } from '../types/AppError';
import {
  insertPhotosForAlbum,
  getPhotoById,
  getAllPhotosForAlbum,
  rehydratePhotoDates,
  getAlbumOwnersForPhoto,
  addPhotoToAlbum,
  removePhotoFromAlbum,
  deletePhotosFromAlbum,
} from '../db/queries/photos';
import { photoQueue, PhotoJobName } from '../jobs/queues/photoQueue';
import fs from 'node:fs/promises';
import cache from '../cache';

const router = Router();

// Uploaded files land here temporarily (see config/uploads.ts), under their
// *original* multer-generated names — see createAlbumPhotosBatch below for
// why they get renamed before the background job ever looks at them.
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_TMP_DIR }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB/file — arbitrary but non-infinite; unbounded multipart bodies are a DoS vector
});

// Using setFullYear (not adding a fixed millisecond offset) so this is
// correct across leap years.
function addThreeYears(date: Date): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + 3);
  return result;
}

// POST /albums — photographer only.
// accessExpiresAt is always computed server-side from shootDate — never
// accepted from the request body, so a caller can't grant themselves a
// longer (or shorter) retention window than the shoot_date + 3 years policy.
export const createAlbum: RequestHandler = async (req, res, next) => {
  try {
    const { clientId, type, shootDate } = req.body;

    // clientId is caller-controlled — verify it's actually one of this
    // photographer's clients before linking an album to it. Portfolio
    // albums have no client at all, by design (migration 004).
    if (type === AlbumType.shoot) {
      if (!clientId) {
        return next(new AppError('clientId is required for shoot albums', 400));
      }
      const client = await getClientByUserId(clientId);
      if (!client || client.photographerId !== req.user!.id) {
        return next(new AppError('Client not found', 404));
      }
    }

    const shootDateObj = new Date(shootDate);
    const accessExpiresAt = addThreeYears(shootDateObj);

    const album = await insertAlbum({
      photographerId: req.user!.id,
      clientId: type === AlbumType.shoot ? clientId : null,
      type,
      shootDate: shootDateObj,
      accessExpiresAt,
    });

    res.status(201).json(album);
  } catch (err) {
    next(err);
  }
};

// GET /albums/:id — both roles, but scoped: a photographer may only view
// their own albums, a client may only view an album where they're the
// linked client (per 4.1). Neither is a public/portfolio-viewing case here.
export const getAlbumFromId: RequestHandler = async (req, res, next) => {
  try {
    const cacheKey = `album:meta:${req.params.id}`;
    let album = await cache.get<Album>(cacheKey);

    if (album) {
      album = rehydrateAlbumDates(album);
    } else {
      album = await getAlbumById(req.params.id);

      if (album) {
        await cache.set(cacheKey, album, 900);
      } else {
        return next(new AppError('Album not found', 404));
      }
    }

    const isOwnerPhotographer =
      req.user?.role === UserRole.photographer && album.photographerId === req.user.id;
    const isOwnerClient = req.user?.role === UserRole.client && album.clientId === req.user.id;

    if (!isOwnerPhotographer && !isOwnerClient) {
      return next(new AppError('Forbidden', 403));
    }

    res.json(album);
  } catch (err) {
    next(err);
  }
};

// PATCH /albums/:id — photographer only, own albums only.
export const updateAlbumFromId: RequestHandler = async (req, res, next) => {
  try {
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
    }

    if (album.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    const { thumbnailPhotoId } = req.body;
    const updatedAlbum = await updateAlbumById(req.params.id, { thumbnailPhotoId });

    await cache.del(`album:meta:${req.params.id}`);

    res.json(updatedAlbum);
  } catch (err) {
    next(err);
  }
};

// DELETE /albums/:id — photographer only, own albums only.
export const deleteAlbumFromId: RequestHandler = async (req, res, next) => {
  try {
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
    }

    if (album.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    await deleteAlbumById(req.params.id);

    await cache.del(`album:meta:${req.params.id}`);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

// POST /albums/:id/photos/batch — photographer only, own albums only.
// Accepts multipart file uploads (field name 'photos', see the `upload`
// multer instance above), inserts a `photos` row per file (status =
// 'processing'), enqueues one ProcessBatch job on photoQueue, and responds
// 202 immediately — it must NOT wait for Cloudinary. The actual upload to
// Cloudinary happens later, in the background worker (5.2).
//
// multer's diskStorage writes each upload to UPLOAD_TMP_DIR under a
// temporary filename it generates (available as `file.path` on each entry
// in req.files). The background worker only ever receives `{ photoIds,
// albumId }` as job data (see ProcessBatchJobData in
// jobs/queues/photoQueue.ts) — no file paths. So once insertPhotosForAlbum
// returns real photo ids, each temp file is renamed so its filename ON DISK
// *is* its photo id. That lets the worker find "the file for photo X" later
// by re-deriving path.join(UPLOAD_TMP_DIR, photoId) — no path needs to
// travel through Redis at all.
export const createAlbumPhotosBatch: RequestHandler = async (req, res, next) => {
  try {
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
    }

    if (album.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    const fileArr = req.files;

    if (!Array.isArray(fileArr) || fileArr.length === 0) {
      return next(new AppError('No files uploaded', 400));
    }

    const photos = await insertPhotosForAlbum(album.id, fileArr.length);

    await Promise.all(
      fileArr.map((file, i) => fs.rename(file.path, path.join(UPLOAD_TMP_DIR, photos[i].id))),
    );

    await photoQueue.add(PhotoJobName.ProcessBatch, {
      photoIds: photos.map((p) => p.id),
      albumId: album.id,
    });

    await cache.del(`album:photos:${album.id}`);

    res.status(202).json(photos);
  } catch (err) {
    next(err);
  }
};

// GET /albums/:id/photos — both roles, same ownership rule as GET /albums/:id.
// Paginated via ?page=&limit= (both optional) — offset = (page - 1) * limit.
// limit is capped at MAX_PHOTOS_PAGE_SIZE so a caller can't request an
// unbounded page in one request; either param falls back to its default
// when missing or not a positive integer, rather than erroring.
const DEFAULT_PHOTOS_PAGE_SIZE = 20;
const MAX_PHOTOS_PAGE_SIZE = 100;

function parsePaginationParam(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return max ? Math.min(parsed, max) : parsed;
}

export const getAlbumPhotos: RequestHandler = async (req, res, next) => {
  try {
    // Reuses the same album:meta: cache entry getAlbumFromId populates —
    // this handler only needs the album for the ownership check below, no
    // reason to hit the DB (or a second cache key) separately for it.
    const albumCacheKey = `album:meta:${req.params.id}`;
    let album = await cache.get<Album>(albumCacheKey);

    if (album) {
      album = rehydrateAlbumDates(album);
    } else {
      album = await getAlbumById(req.params.id);

      if (album) {
        await cache.set(albumCacheKey, album, 900);
      } else {
        return next(new AppError('Album not found', 404));
      }
    }

    const isOwnerPhotographer =
      req.user?.role === UserRole.photographer && album.photographerId === req.user.id;
    const isOwnerClient = req.user?.role === UserRole.client && album.clientId === req.user.id;

    if (!isOwnerPhotographer && !isOwnerClient) {
      return next(new AppError('Forbidden', 403));
    }

    // Cached as the FULL photo list under one key per album, not one key
    // per (page, limit) — see the design note in MEMORY.md. Pagination is
    // applied in application code below, against whatever came back from
    // cache or DB, so a single cache.del('album:photos:{id}') on any photo
    // add/remove invalidates every page at once.
    const photosCacheKey = `album:photos:${req.params.id}`;
    let allPhotos = await cache.get<Photo[]>(photosCacheKey);

    if (allPhotos) {
      allPhotos = allPhotos.map(rehydratePhotoDates);
    } else {
      allPhotos = await getAllPhotosForAlbum(album.id);
      await cache.set(photosCacheKey, allPhotos, 300);
    }

    const page = parsePaginationParam(req.query.page, 1);
    const limit = parsePaginationParam(
      req.query.limit,
      DEFAULT_PHOTOS_PAGE_SIZE,
      MAX_PHOTOS_PAGE_SIZE,
    );
    const offset = (page - 1) * limit;

    res.json(allPhotos.slice(offset, offset + limit));
  } catch (err) {
    next(err);
  }
};

// DELETE /albums/:id/photos/batch — bulk remove from this album only (the
// photo_albums link), not from the system. Photographer only, own albums.
export const deleteAlbumPhotosBatch: RequestHandler = async (req, res, next) => {
  try {
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
    }

    if (album.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    const { photoIds } = req.body;

    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return next(new AppError('photoIds is required', 400));
    }

    await deletePhotosFromAlbum(album.id, photoIds);

    await cache.del(`album:photos:${req.params.id}`);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

// POST /albums/:id/photos/:photoId — link an existing photo into another
// album. Photographer only, own albums only — and the photo itself must
// already belong to at least one album owned by this same photographer
// (checked via getAlbumOwnersForPhoto). Without that second check, any
// photographer could link in an arbitrary photo id — including another
// photographer's private client photos — just by knowing/guessing its UUID.
export const addAlbumPhoto: RequestHandler = async (req, res, next) => {
  try {
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
    }

    if (album.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    const photo = await getPhotoById(req.params.photoId);

    if (!photo) {
      return next(new AppError('Photo not found', 404));
    }

    const owners = await getAlbumOwnersForPhoto(photo.id);
    const hasAccess = owners.some((owner) => owner.photographerId === req.user!.id);

    if (!hasAccess) {
      return next(new AppError('Forbidden', 403));
    }

    await addPhotoToAlbum(album.id, photo.id);

    await cache.del(`album:photos:${req.params.id}`);

    res.status(201).json(photo);
  } catch (err) {
    next(err);
  }
};

// DELETE /albums/:id/photos/:photoId — remove from this album only, not
// from the system. Photographer only, own albums only.
export const removeAlbumPhoto: RequestHandler = async (req, res, next) => {
  try {
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
    }

    if (album.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    await removePhotoFromAlbum(album.id, req.params.photoId);

    await cache.del(`album:photos:${req.params.id}`);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

router.post('/', requireRole(UserRole.photographer), createAlbum);
router.get('/:id', getAlbumFromId);
router.get('/:id/photos', getAlbumPhotos);
router.patch('/:id', requireRole(UserRole.photographer), updateAlbumFromId);
router.delete('/:id', requireRole(UserRole.photographer), deleteAlbumFromId);
router.post(
  '/:id/photos/batch',
  requireRole(UserRole.photographer),
  upload.array('photos'),
  createAlbumPhotosBatch,
);
// Registered before '/:id/photos/:photoId' below — Express matches routes in
// registration order, and 'batch' would otherwise be captured as :photoId.
router.delete('/:id/photos/batch', requireRole(UserRole.photographer), deleteAlbumPhotosBatch);
router.post('/:id/photos/:photoId', requireRole(UserRole.photographer), addAlbumPhoto);
router.delete('/:id/photos/:photoId', requireRole(UserRole.photographer), removeAlbumPhoto);

export default router;

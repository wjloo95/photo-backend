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
import { Album, AlbumType, Photo, PhotoStatus, UserRole } from '../types';
import { requireRole } from '../middleware/requireRole';
import { AppError } from '../types/AppError';
import {
  insertPhotosForAlbum,
  getPhotoById,
  getAllPhotosForAlbum,
  rehydrateAlbumPhotoDates,
  AlbumPhoto,
  getAlbumOwnersForPhoto,
  addPhotoToAlbum,
  removePhotoFromAlbum,
  deletePhotosFromAlbum,
} from '../db/queries/photos';
import { photoQueue, PhotoJobName } from '../jobs/queues/photoQueue';
import fs from 'node:fs/promises';
import cache from '../cache';
import { albumPhotosCacheKey } from '../cache/keys';
import { parsePaginationParam } from '../utils/pagination';
import { CursorPosition, decodeCursor, encodeCursor, isAfterCursor } from '../utils/cursor';

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
//
// Only shoot albums get one. Expiry exists because a client's access to their
// shoot is time-limited; a portfolio album belongs to the photographer, has no
// client, and never expires — so it is created with null (migration 020),
// which is what keeps it out of the warning and deletion pipelines.
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
    const isShoot = type === AlbumType.shoot;

    const album = await insertAlbum({
      photographerId: req.user!.id,
      clientId: isShoot ? clientId : null,
      type,
      shootDate: shootDateObj,
      accessExpiresAt: isShoot ? addThreeYears(shootDateObj) : null,
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

    await cache.del(albumPhotosCacheKey(album.id));

    res.status(202).json(photos);
  } catch (err) {
    next(err);
  }
};

// GET /albums/:id/photos — both roles, same ownership rule as GET /albums/:id.
//
// Cursor-paginated: ?limit= (default 20, capped at 100, invalid falls back to
// the default) and an optional ?cursor=, the nextCursor of the previous page.
// No cursor means the first page. A malformed cursor is a 400 rather than a
// fallback; see decodeCursor for why. Photos come in the album's (added_at,
// id) order from getAllPhotosForAlbum, and a page is the first `limit` photos
// strictly after the cursor's position, so removing or adding photos between
// requests never makes a client's scroll skip or repeat one.
//
// ?status=ready keeps only ready photos in data, total and the cursor walk:
// the client portal can't lay out a photo with null dimensions. Any other
// value, including a repeated param, is treated as absent, the same way limit
// falls back. The filter is an explicit parameter rather than inferred from
// the caller's role, so one URL always gives one answer and the shared cache
// entry can't leak a photographer's view to a client. processingCount is
// always the album-wide count, so the client can show "N more on the way"
// while paging ready photos only.
//
// Responds { data, nextCursor, total, processingCount }; nextCursor is null
// on the last page.
const DEFAULT_PHOTOS_PAGE_SIZE = 20;
const MAX_PHOTOS_PAGE_SIZE = 100;

// addedAt is the listing's internal sort key, not part of the response.
function toPhotoResponse({ id, basePath, status, width, height, uploadedAt }: AlbumPhoto): Photo {
  return { id, basePath, status, width, height, uploadedAt };
}

function photoPosition(photo: AlbumPhoto): CursorPosition {
  return { at: photo.addedAt, id: photo.id };
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

    const limit = parsePaginationParam(
      req.query.limit,
      DEFAULT_PHOTOS_PAGE_SIZE,
      MAX_PHOTOS_PAGE_SIZE,
    );
    let cursor: CursorPosition | null = null;

    if (req.query.cursor !== undefined) {
      cursor = decodeCursor(req.query.cursor);

      if (!cursor) {
        return next(new AppError('Invalid cursor', 400));
      }
    }

    // Cached as the FULL photo list under one key per album, not one key per
    // page, filter or cursor (see "The opinionated call" in
    // SYSTEM_DESIGN_STUDY.md). Filtering, counting and the cursor step all
    // run below, in application code, on whatever came back from cache or
    // DB, so a single cache.del(albumPhotosCacheKey(id)) on any photo change
    // invalidates every page under every filter at once.
    const photosCacheKey = albumPhotosCacheKey(req.params.id);
    let allPhotos = await cache.get<AlbumPhoto[]>(photosCacheKey);

    if (allPhotos) {
      allPhotos = allPhotos.map(rehydrateAlbumPhotoDates);
    } else {
      allPhotos = await getAllPhotosForAlbum(album.id);
      await cache.set(photosCacheKey, allPhotos, 300);
    }

    const processingCount = allPhotos.filter(
      (photo) => photo.status === PhotoStatus.processing,
    ).length;
    const visiblePhotos =
      req.query.status === PhotoStatus.ready
        ? allPhotos.filter((photo) => photo.status === PhotoStatus.ready)
        : allPhotos;

    // -1 when nothing sorts after the cursor: the walk is already past the end.
    const start = cursor
      ? visiblePhotos.findIndex((photo) => isAfterCursor(photoPosition(photo), cursor))
      : 0;
    const page = start === -1 ? [] : visiblePhotos.slice(start, start + limit);
    const hasMore = start !== -1 && start + limit < visiblePhotos.length;

    res.json({
      data: page.map(toPhotoResponse),
      nextCursor: hasMore ? encodeCursor(photoPosition(page[page.length - 1])) : null,
      total: visiblePhotos.length,
      processingCount,
    });
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

    await cache.del(albumPhotosCacheKey(req.params.id));

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

    await cache.del(albumPhotosCacheKey(req.params.id));

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

    await cache.del(albumPhotosCacheKey(req.params.id));

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

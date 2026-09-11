import { Router, RequestHandler } from 'express';
import { getPhotographerByUserId, updatePhotographerByUserId } from '../db/queries/photographers';
import { getPhotographerClientsByUserId } from '../db/queries/clients';
import { getPhotographerAlbumsByUserId } from '../db/queries/albums';
import { getPendingInvitesByPhotographerId } from '../db/queries/invites';
import { Album, Photographer, VisibilityType } from '../types';
import { AppError } from '../types/AppError';
import cache from '../cache';
import { getTemplatesByPhotographerId } from '../db/queries/templates';
import multer from 'multer';
import fs from 'node:fs/promises';
import { v2 as cloudinary } from 'cloudinary';
import { UPLOAD_TMP_DIR } from '../config/uploads';

const router = Router();

// Public response shape for an album — leaves out warned90At/warned30At/
// warned7At, which are internal bookkeeping for the expiry-warning job, not
// something a photographer or client needs to see.
interface AlbumSummary {
  id: string;
  photographerId: string;
  clientId: string | null;
  thumbnailPhotoId: string | null;
  type: Album['type'];
  shootDate: Date;
  accessExpiresAt: Date | null; // null for portfolio albums
  createdAt: Date;
}

function toAlbumSummary(album: Album): AlbumSummary {
  return {
    id: album.id,
    photographerId: album.photographerId,
    clientId: album.clientId,
    thumbnailPhotoId: album.thumbnailPhotoId,
    type: album.type,
    shootDate: album.shootDate,
    accessExpiresAt: album.accessExpiresAt,
    createdAt: album.createdAt,
  };
}

// GET /photographers/:id
// auth + loadUser already run globally in app.ts for everything mounted
// after /users, so req.user is populated by the time this handler runs.
export const getPhotographerFromId: RequestHandler = async (req, res, next) => {
  try {
    const cacheKey = `photographer:profile:${req.params.id}`;
    let photographer = await cache.get<Photographer>(cacheKey);

    if (!photographer) {
      photographer = await getPhotographerByUserId(req.params.id);
      if (photographer) {
        await cache.set(cacheKey, photographer, 3600);
      } else {
        return next(new AppError('Photographer not found', 404));
      }
    }
    const isOwner = req.params.id === req.user?.id;

    // 404 rather than 403 for a private, non-owned profile — same response
    // as a nonexistent id, so a caller can't distinguish "no such
    // photographer" from "exists but is private."
    if (photographer.visibility === VisibilityType.private && !isOwner) {
      return next(new AppError('Photographer not found', 404));
    }

    res.json(photographer);
  } catch (err) {
    next(err);
  }
};
// GET /photographers/:id/clients
// auth + loadUser already run globally in app.ts for everything mounted
// after /users, so req.user is populated by the time this handler runs.
export const getPhotographerClientsFromId: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    const clients = await getPhotographerClientsByUserId(req.params.id);
    res.json(clients);
  } catch (err) {
    next(err);
  }
};

// GET /photographers/:id/albums
// auth + loadUser already run globally in app.ts for everything mounted
// after /users, so req.user is populated by the time this handler runs.
export const getPhotographerAlbumsFromId: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }
    const albums = await getPhotographerAlbumsByUserId(req.params.id);

    res.json(albums.map(toAlbumSummary));
  } catch (err) {
    next(err);
  }
};

// GET /photographers/:id/invites
// auth + loadUser already run globally in app.ts for everything mounted
// after /users, so req.user is populated by the time this handler runs.
export const getPhotographerInvitesFromId: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    const invites = await getPendingInvitesByPhotographerId(req.params.id);
    res.json(invites);
  } catch (err) {
    next(err);
  }
};

// GET /photographers/:id/templates — photographer only, own templates only.
// In the architecture doc's endpoint table but missing from Phase 8's list;
// without it a photographer has no way to find their own templates at all.
//
// Identity-scoped the same way as getPhotographerInvitesFromId above: the :id
// must be the caller's own. List view only — no questions embedded, and no
// cache (see routes/templates.ts for why templates aren't cached yet).
export const getPhotographerTemplatesFromId: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    const templates = await getTemplatesByPhotographerId(req.params.id);
    res.json(templates);
  } catch (err) {
    next(err);
  }
};

// PATCH /photographers/:id
// auth + loadUser already run globally in app.ts for everything mounted
// after /users, so req.user is populated by the time this handler runs.
export const updatePhotographerFromId: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    const { bio, instagramHandle, profilePhotoUrl } = req.body;
    const photographer = await updatePhotographerByUserId(req.params.id, {
      bio,
      instagramHandle,
      profilePhotoUrl,
    });

    if (!photographer) {
      return next(new AppError('Photographer not found', 404));
    }

    await cache.del(`photographer:profile:${req.params.id}`);

    res.json(photographer);
  } catch (err) {
    next(err);
  }
};

/**
 * A profile photo is one small image, so the ceiling is far below the 25MB
 * allowed per album photo, and the type is checked up front — Cloudinary would
 * reject a PDF anyway, but doing it here turns a provider error into a 400 and
 * avoids paying for the upload first.
 */
const profilePhotoUpload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_TMP_DIR }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// POST /photographers/:id/photo — own profile only, enforced by the same
// id-vs-caller check PATCH /photographers/:id uses. No requireRole guard, per
// this router's convention: the ownership check subsumes it, since only a
// photographer can be the subject of a photographers row.
//
// Synchronous, unlike POST /albums/:id/photos/batch. That endpoint takes many
// large files, does real processing on each, and returns 202 so the request
// isn't held open; here there is one small file, no derivative work, and a
// photographer who has just picked an avatar expects to see it. A 202 would
// mean showing the old photo for an indeterminate time. There is also no
// `photos` row involved — a profile photo is a URL on the photographers table,
// with no status machine and no album to join.
//
// The Cloudinary public_id is deterministic: `photographers/<id>/profile` with
// overwrite. Replacing an avatar therefore replaces the same asset instead of
// leaving the previous one orphaned, which means no column tracking the old
// public id and no cleanup job. It also makes the write idempotent — if the DB
// update below fails after a successful upload, a retry overwrites the same
// asset rather than accumulating copies.
//
// `invalidate` clears Cloudinary's CDN cache for that id. Without it the URL
// is unchanged but the bytes behind it are stale, so the new photo would not
// appear for viewers holding the old cached copy.
export const uploadPhotographerPhoto: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    // multer leaves req.file undefined both when no file was sent and when
    // fileFilter rejected the one that was — a 400 covers both.
    if (!req.file) {
      return next(new AppError('An image file is required', 400));
    }

    try {
      const { secure_url } = await cloudinary.uploader.upload(req.file.path, {
        public_id: `photographers/${req.params.id}/profile`,
        overwrite: true,
        invalidate: true,
      });

      const photographer = await updatePhotographerByUserId(req.params.id, {
        profilePhotoUrl: secure_url,
      });

      if (!photographer) {
        return next(new AppError('Photographer not found', 404));
      }

      // The profile is cached for an hour (D-15). Without this the photographer
      // uploads a new photo and keeps seeing the old one for up to 60 minutes.
      await cache.del(`photographer:profile:${req.params.id}`);

      res.status(200).json(photographer);
    } finally {
      // multer has already written the file to disk by the time this handler
      // runs, so it has to be cleaned up on every path out — including the
      // failures above, which would otherwise leak a file per attempt.
      await fs.unlink(req.file.path).catch(() => undefined);
    }
  } catch (err) {
    next(err);
  }
};

router.get('/:id', getPhotographerFromId);
router.get('/:id/clients', getPhotographerClientsFromId);
router.get('/:id/albums', getPhotographerAlbumsFromId);
router.get('/:id/invites', getPhotographerInvitesFromId);
router.get('/:id/templates', getPhotographerTemplatesFromId);
router.patch('/:id', updatePhotographerFromId);
router.post('/:id/photo', profilePhotoUpload.single('photo'), uploadPhotographerPhoto);

export default router;

import { Router, RequestHandler } from 'express';
import { getPhotographerByUserId, updatePhotographerByUserId } from '../db/queries/photographers';
import { getPhotographerClientsByUserId } from '../db/queries/clients';
import { getPhotographerAlbumsByUserId } from '../db/queries/albums';
import { getPendingInvitesByPhotographerId } from '../db/queries/invites';
import { Album, Photographer, VisibilityType } from '../types';
import { AppError } from '../types/AppError';
import cache from '../cache';
import { getTemplatesByPhotographerId } from '../db/queries/templates';

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

router.get('/:id', getPhotographerFromId);
router.get('/:id/clients', getPhotographerClientsFromId);
router.get('/:id/albums', getPhotographerAlbumsFromId);
router.get('/:id/invites', getPhotographerInvitesFromId);
router.get('/:id/templates', getPhotographerTemplatesFromId);
router.patch('/:id', updatePhotographerFromId);

export default router;

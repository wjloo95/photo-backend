import { Router, RequestHandler } from 'express';
import { getPhotoById, getAlbumOwnersForPhoto, deletePhotoById } from '../db/queries/photos';
import { UserRole } from '../types';
import cache from '../cache';
import { albumPhotosCacheKey } from '../cache/keys';
import { requireRole } from '../middleware/requireRole';
import { AppError } from '../types/AppError';

const router = Router();

// GET /photos/:id — both roles. A photo has no direct owner field; access is
// derived transitively through every album it currently belongs to (a photo
// can be in more than one album) — same shape of check as GET /albums/:id,
// just resolved via getAlbumOwnersForPhoto instead of a single album row.
export const getPhotoFromId: RequestHandler = async (req, res, next) => {
  try {
    const photo = await getPhotoById(req.params.id);

    if (!photo) {
      return next(new AppError('Photo not found', 404));
    }

    const owners = await getAlbumOwnersForPhoto(photo.id);
    const isOwnerPhotographer =
      req.user?.role === UserRole.photographer &&
      owners.some((owner) => owner.photographerId === req.user!.id);
    const isOwnerClient =
      req.user?.role === UserRole.client &&
      owners.some((owner) => owner.clientId === req.user!.id);

    if (!isOwnerPhotographer && !isOwnerClient) {
      return next(new AppError('Forbidden', 403));
    }

    res.json(photo);
  } catch (err) {
    next(err);
  }
};

// DELETE /photos/:id — photographer only, and only if they own at least one
// album the photo currently belongs to. Permanently removes the photo from
// the system (not just from one album) — photo_albums rows and any
// thumbnail_photo_id reference are cleaned up by the DB via ON DELETE
// CASCADE/SET NULL (migration 006).
//
// The cache is not: every album that contained the photo keeps listing it in
// its cached photo list (with a destroyed image, a wrong total and a cursor
// position that no longer exists) until that list is cleared. The album ids
// come from the owners lookup the auth check already made, which ran before
// the delete cascaded the photo_albums rows away.
export const deletePhotoFromId: RequestHandler = async (req, res, next) => {
  try {
    const photo = await getPhotoById(req.params.id);

    if (!photo) {
      return next(new AppError('Photo not found', 404));
    }

    const owners = await getAlbumOwnersForPhoto(photo.id);
    const isOwner = owners.some((owner) => owner.photographerId === req.user!.id);

    if (!isOwner) {
      return next(new AppError('Forbidden', 403));
    }

    await deletePhotoById(photo.id);

    await Promise.all(owners.map((owner) => cache.del(albumPhotosCacheKey(owner.albumId))));

    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

router.get('/:id', getPhotoFromId);
router.delete('/:id', requireRole(UserRole.photographer), deletePhotoFromId);

export default router;

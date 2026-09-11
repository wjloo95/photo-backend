import { Router, RequestHandler } from 'express';
import { insertAlbum, getAlbumById, updateAlbumById, deleteAlbumById } from '../db/queries/albums';
import { getClientByUserId } from '../db/queries/clients';
import { AlbumType, UserRole } from '../types';
import { requireRole } from '../middleware/requireRole';
import { AppError } from '../types/AppError';

const router = Router();

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
    const album = await getAlbumById(req.params.id);

    if (!album) {
      return next(new AppError('Album not found', 404));
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
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

router.post('/', requireRole(UserRole.photographer), createAlbum);
router.get('/:id', getAlbumFromId);
router.patch('/:id', requireRole(UserRole.photographer), updateAlbumFromId);
router.delete('/:id', requireRole(UserRole.photographer), deleteAlbumFromId);

export default router;

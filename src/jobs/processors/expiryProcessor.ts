/**
 * src/jobs/processors/expiryProcessor.ts
 *
 * Handles the 4 job types registered by schedulers/expiryScheduler.ts:
 * warn-90-days, warn-30-days, warn-7-days, and delete-expired. Dispatched
 * from worker.ts the same way ProcessBatch jobs are dispatched to
 * processPhotoBatch — except these jobs carry no data (ExpiryJobData is
 * `Record<string, never>`), so the only thing that matters is job.name.
 */

import {
  deleteAlbumById,
  getAlbumsNeedingWarning,
  getExpiredAlbums,
  markAlbumWarned,
  WarningColumn,
} from '../../db/queries/albums';
import {
  deletePhotoById,
  getAlbumOwnersForPhoto,
  getAllPhotosForAlbum,
} from '../../db/queries/photos';
import { ExpiryJobName } from '../queues/expiryQueue';
import { processEachSafely } from './processEachSafely';
import { v2 as cloudinary } from 'cloudinary';
// Dispatch is on job.name alone. The warning cases are near-identical by
// design — getAlbumsNeedingWarning(N) already encodes the "catch up on a missed
// run" logic (see queries/albums.ts), so all that is left here is marking each
// album warned so the next run skips it.
//
// The delete case is the one with ordering constraints, documented inline
// below: photos are cleaned up before their album row, and a photo is only
// destroyed when this was its last remaining album.
//
// This queue needs its own BullMQ Worker in worker.ts, separate from the
// photoQueue one — a Worker listens to exactly one queue, and this is 'expiry',
// not 'photo-processing'.
export async function processExpiryJob(jobName: string): Promise<void> {
  switch (jobName) {
    case ExpiryJobName.DeleteExpired: {
      const expiredAlbums = await getExpiredAlbums();
      // Nested processEachSafely: the inner call must fully settle (every
      // photo attempted, one way or another) before deleteAlbumById runs —
      // otherwise the album (and the photo_albums rows it cascades away)
      // could disappear out from under getAlbumOwnersForPhoto's "is this
      // the photo's last album" check, which is still mid-flight. If any
      // photo in an album fails, the inner call throws and that album's
      // deleteAlbumById is skipped entirely, leaving the album expired-but-
      // undeleted for the next run to retry — rather than deleting an album
      // whose photos weren't fully cleaned up.
      await processEachSafely(
        expiredAlbums,
        async (album) => {
          const photos = await getAllPhotosForAlbum(album.id);
          await processEachSafely(
            photos,
            async (photo) => {
              // Check ownership BEFORE touching Cloudinary — destroying the
              // asset first (then only conditionally deleting the DB row)
              // would leave a still-active album (this photo's other one,
              // via addAlbumPhoto) pointing at bytes that no longer exist.
              const owners = await getAlbumOwnersForPhoto(photo.id);

              if (owners.length === 1) {
                await cloudinary.uploader.destroy(photo.basePath);
                await deletePhotoById(photo.id);
              }
            },
            'photos',
          );

          await deleteAlbumById(album.id);
        },
        'albums',
      );
      break;
    }
    case ExpiryJobName.Warn90Days: {
      const albumsToWarn = await getAlbumsNeedingWarning(90);
      await processEachSafely(
        albumsToWarn,
        async (album) => {
          // send warning by email?
          await markAlbumWarned(album.id, WarningColumn.Warned90);
        },
        'albums',
      );
      break;
    }
    case ExpiryJobName.Warn30Days: {
      const albumsToWarn = await getAlbumsNeedingWarning(30);
      await processEachSafely(
        albumsToWarn,
        async (album) => {
          // send warning by email?
          await markAlbumWarned(album.id, WarningColumn.Warned30);
        },
        'albums',
      );
      break;
    }
    case ExpiryJobName.Warn7Days: {
      const albumsToWarn = await getAlbumsNeedingWarning(7);
      await processEachSafely(
        albumsToWarn,
        async (album) => {
          // send warning by email?
          await markAlbumWarned(album.id, WarningColumn.Warned7);
        },
        'albums',
      );
      break;
    }
    default:
      throw new Error(`Unknown job name: ${jobName}`);
  }
}

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
import { emailSender } from '../../email';
import { albumExpiryWarning, WarningDays } from '../../email/templates/albumExpiryWarning';
import { processEachSafely } from './processEachSafely';
import { v2 as cloudinary } from 'cloudinary';
/* eslint-disable no-console */
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
/**
 * One warning milestone: find the albums due at `days`, mail each client, and
 * record that the step ran.
 *
 * The send happens *before* markAlbumWarned, and that order is the whole
 * reliability story. Marking first would be at-most-once — a provider timeout
 * would leave the album flagged as warned, nobody would ever hear anything,
 * and getExpiredAlbums would then happily delete it on schedule. Sending first
 * is at-least-once: a failure throws, processEachSafely skips the mark for
 * that album, and tomorrow's run picks it up again because warned_*_at is
 * still NULL. The worst case is a duplicate email, which is a far cheaper
 * mistake than a silent permanent deletion.
 *
 * An album with no clientEmail is marked warned without sending. Its client
 * was deleted (albums.client_id is ON DELETE SET NULL), so there is nobody to
 * warn and never will be — and leaving warned_7_at NULL would mean the
 * deletion gate in getExpiredAlbums kept the album, and its Cloudinary assets,
 * alive indefinitely. The column records that the step completed, not that a
 * human read anything.
 */
async function sendWarnings(days: WarningDays, column: WarningColumn): Promise<void> {
  const albums = await getAlbumsNeedingWarning(days);

  await processEachSafely(
    albums,
    async (album) => {
      if (album.clientEmail) {
        await emailSender.send(
          albumExpiryWarning({
            clientEmail: album.clientEmail,
            clientName: album.clientName,
            shootDate: album.shootDate,
            // Non-null by the query: getAlbumsNeedingWarning filters on this
            // column, and the CHECK from migration 020 keeps portfolio albums
            // (the only NULL case) out of it.
            accessExpiresAt: album.accessExpiresAt!,
            days,
          }),
        );
      } else {
        console.warn(
          `album ${album.id} expires ${album.accessExpiresAt?.toISOString()} but has no client to warn — marking warned so it is not held back from deletion`,
        );
      }

      await markAlbumWarned(album.id, column);
    },
    'albums',
  );
}

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
    case ExpiryJobName.Warn90Days:
      await sendWarnings(90, WarningColumn.Warned90);
      break;
    case ExpiryJobName.Warn30Days:
      await sendWarnings(30, WarningColumn.Warned30);
      break;
    case ExpiryJobName.Warn7Days:
      await sendWarnings(7, WarningColumn.Warned7);
      break;
    default:
      throw new Error(`Unknown job name: ${jobName}`);
  }
}

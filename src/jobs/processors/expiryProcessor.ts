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
// TODO (ASSIGNMENTS.md 5.3) — you'll need:
//
//
// Two things worth thinking through before you write this:
//
// 1. "Within the warning window" has a naive reading and a robust one.
//    Naive: access_expires_at falls on exactly N days from today — but if
//    this cron doesn't fire on the exact right day (worker was down, a
//    deploy delayed it past midnight UTC, whatever), that album's warning
//    is silently skipped forever, since tomorrow it's N-1 days out and no
//    longer matches. Robust: access_expires_at <= NOW() + INTERVAL
//    'N days' AND warned_N_at IS NULL — once true it stays true until you
//    mark it warned, so a missed run just catches up on the next one. The
//    second is also why "read which albums qualify" and "mark them warned"
//    need to happen close together — two runs racing before the first
//    run's write lands could both see the same album as unwarned and send
//    the warning twice.
//
// 2. delete-expired's spec says "delete files from Cloudinary, then delete
//    album rows from DB" — but photo_albums.album_id cascades on album
//    delete (migration 006), while `photos` itself does NOT cascade from
//    `albums` (the chain is photos -> photo_albums -> albums; deleting an
//    album only removes the join row). Deleting just the album row leaves
//    that album's `photos` rows behind, permanently orphaned — nothing
//    references them, but nothing cleans them up either. Decide whether to
//    also delete each photo's `photos` row once its album is gone — and if
//    a photo can belong to more than one album (see addAlbumPhoto in
//    routes/albums.ts), whether that deletion should only happen when this
//    was the photo's *last* remaining album (getAlbumOwnersForPhoto tells
//    you that), so expiring one shoot album doesn't delete a photo the
//    photographer also placed in a still-active portfolio album.
//
// Steps, dispatched on job.name:
//   Warn90Days / Warn30Days / Warn7Days:
//     1. getAlbumsNeedingWarning(90 | 30 | 7)
//     2. For each album: send the warning (not built anywhere else in this
//        codebase yet — decide what that means for now, e.g. just logging)
//        and markAlbumWarned(album.id, <the matching field>)
//   DeleteExpired:
//     1. getExpiredAlbums()
//     2. For each album: find its photos, cloudinary.uploader.destroy each
//        photo's basePath (the delete counterpart to .upload(), same v2
//        import as photoProcessor.ts)
//     3. deleteAlbumById(album.id) — then resolve the orphaned-photos
//        question from point 2 above
//
// Note for later: this needs its own BullMQ Worker in worker.ts, separate
// from the photoQueue one — a Worker listens to exactly one queue, and
// this queue is 'expiry', not 'photo-processing'.
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

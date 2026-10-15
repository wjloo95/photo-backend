/**
 * src/jobs/processors/photoProcessor.ts
 *
 * Handles PhotoJobName.ProcessBatch jobs off photoQueue — the actual work
 * that routes/albums.ts's createAlbumPhotosBatch deferred by responding 202
 * immediately. Called from worker.ts once a job arrives.
 */
import cache from '../../cache';
import { albumPhotosCacheKey } from '../../cache/keys';
import { env } from '../../config/env';
import { UPLOAD_TMP_DIR } from '../../config/uploads';
import { getPhotoById, markPhotoReady, markPhotosFailed } from '../../db/queries/photos';
import { PhotoStatus } from '../../types';
import { ProcessBatchJobData } from '../queues/photoQueue';
import { processEachSafely } from './processEachSafely';

import { v2 as cloudinary } from 'cloudinary';
import fs from 'node:fs/promises';
import path from 'node:path';

// photoQueue's retry config (3 attempts, exponential backoff) retries the
// WHOLE job, not individual photos — if a batch has 5 photo ids and the
// Cloudinary upload for photo #4 throws, BullMQ reruns this function again
// from photo #1. The status check below (skip if already 'ready') is what
// makes that safe: an already-succeeded photo in the batch is skipped on
// retry rather than redundantly re-uploaded — same idempotency spirit as
// addPhotoToAlbum's ON CONFLICT DO NOTHING. Each photo's temp file is only
// deleted *after* its DB row is confirmed updated, for the same reason —
// deleting it first and then having the DB write fail would leave that
// photo stuck at 'processing' with no file left for a retry to find.
//
// Per-photo isolation (one bad photo doesn't stop the rest of the batch,
// but the whole job still fails and retries if anything did) is handled by
// processEachSafely, shared with expiryProcessor.ts.
//
// job.data.albumId is used for one thing: clearing that album's cached photo
// list once a photo is ready, so the next GET /albums/:id/photos shows it as
// ready instead of serving the stale 'processing' copy for up to the 300s
// TTL. It's cleared per photo, not once per batch, so a client's "N more on
// the way" count ticks down as photos finish rather than jumping at the end
// of a large upload. The clear comes after the temp file is unlinked: if
// Redis fails there, the worst case is a list that's up to 5 minutes stale.
// Clearing before the unlink would turn the same failure into a leaked temp
// file, since the retry skips the now-ready photo and never reaches it.
//
// Known gap: only the upload album is cleared. If the photographer added a
// still-processing photo to a second album (addAlbumPhoto doesn't check
// status), that album's cached list stays stale until its TTL expires.
// Accepted as rare; closing it would cost a photo_albums lookup per photo.
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

export async function processPhotoBatch(data: ProcessBatchJobData): Promise<void> {
  await processEachSafely(
    data.photoIds,
    async (photoId) => {
      const photoData = await getPhotoById(photoId);

      if (photoData?.status === PhotoStatus.ready) {
        return;
      }

      const { width, height, public_id } = await cloudinary.uploader.upload(
        path.join(UPLOAD_TMP_DIR, photoId),
        {
          public_id: photoId,
        },
      );
      await markPhotoReady(photoId, { basePath: public_id, width, height });

      await fs.unlink(path.join(UPLOAD_TMP_DIR, photoId));
      await cache.del(albumPhotosCacheKey(data.albumId));
    },
    'photos',
  );
}

/**
 * Called by worker.ts once a ProcessBatch job has failed its final attempt:
 * every photo in the batch still processing becomes 'failed', and the album's
 * photo list is cleared so processingCount drops right away instead of
 * promising "more on the way" indefinitely.
 *
 * Failed photos' staged files stay in UPLOAD_TMP_DIR on purpose: Phase 7's
 * manual retry will need them. Until that exists nothing removes them, so
 * they accumulate there, one per failed photo.
 */
export async function failRemainingPhotos(data: ProcessBatchJobData): Promise<void> {
  await markPhotosFailed(data.photoIds);
  await cache.del(albumPhotosCacheKey(data.albumId));
}

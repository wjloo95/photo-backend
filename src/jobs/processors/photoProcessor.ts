/**
 * src/jobs/processors/photoProcessor.ts
 *
 * Handles PhotoJobName.ProcessBatch jobs off photoQueue — the actual work
 * that routes/albums.ts's createAlbumPhotosBatch deferred by responding 202
 * immediately. Called from worker.ts once a job arrives.
 */
import { env } from '../../config/env';
import { UPLOAD_TMP_DIR } from '../../config/uploads';
import { getPhotoById, markPhotoReady } from '../../db/queries/photos';
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
// job.data.albumId isn't needed for any of this — the photo was already
// linked to its album via photo_albums back in insertPhotosForAlbum. It's
// on the job data in case a future processor step needs it (e.g.
// invalidating a cache entry keyed by album id — see Phase 6).
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
    },
    'photos',
  );
}

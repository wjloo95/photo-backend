/**
 * src/jobs/queues/photoQueue.ts
 *
 * BullMQ queue for photo processing jobs.
 * Triggered from route handlers when a photographer uploads photos.
 *
 * Usage in a route handler:
 *   import { photoQueue, PhotoJobName } from '../jobs/queues/photoQueue';
 *   await photoQueue.add(PhotoJobName.ProcessBatch, { photoIds: [...] });
 *
 * The processor that runs these jobs lives in src/jobs/processors/ — you write that.
 */

import { Queue } from 'bullmq';

export const PHOTO_QUEUE_NAME = 'photo-processing';

// BullMQ bundles its own internal ioredis copy.
// Passing a Redis instance from the system ioredis causes a type mismatch
// between the two ioredis builds. Passing the URL string instead lets BullMQ
// create its own connection — no conflict.
const connectionUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: connectionUrl.hostname,
  port: Number(connectionUrl.port) || 6379,
};

// Job name constants — use these instead of raw strings to prevent typos.
export enum PhotoJobName {
  ProcessBatch = 'process-batch',
}

// TypeScript interface for the data each job carries.
// The processor receives this as job.data — keep it serialisable (no class instances).
export interface ProcessBatchJobData {
  photoIds: string[]; // UUIDs of photos to process
  albumId: string; // the album they were uploaded to
}

export const photoQueue = new Queue<ProcessBatchJobData>(PHOTO_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // Retry up to 3 times with exponential backoff if the processor throws.
    // After 3 failures, the job moves to the 'failed' state in BullMQ.
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2_000, // 2s, 4s, 8s
    },
    // Remove completed jobs after 24 hours (they accumulate in Redis otherwise).
    removeOnComplete: { age: 86_400 },
    // Keep the last 100 failed jobs for inspection.
    removeOnFail: { count: 100 },
  },
});

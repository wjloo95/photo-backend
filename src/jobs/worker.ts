/**
 * src/jobs/worker.ts
 *
 * Entry point for the background worker process. This runs separately from
 * the Express API (started via `npm run worker`, not `npm run dev`) — it's
 * the process that actually drains BullMQ queues and does the work the API
 * only *enqueues*.
 */
import { Worker, Job } from 'bullmq';
import { PHOTO_QUEUE_NAME, ProcessBatchJobData, PhotoJobName } from './queues/photoQueue';
import { processPhotoBatch } from './processors/photoProcessor';
import { EXPIRY_QUEUE_NAME, ExpiryJobData } from './queues/expiryQueue';
import { processExpiryJob } from './processors/expiryProcessor';
import { registerExpirySchedules } from './schedulers/expiryScheduler';

// BullMQ bundles its own internal ioredis copy.
// Passing a Redis instance from the system ioredis causes a type mismatch
// between the two ioredis builds. Passing the URL string instead lets BullMQ
// create its own connection — no conflict.
const connectionUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: connectionUrl.hostname,
  port: Number(connectionUrl.port) || 6379,
};

registerExpirySchedules().catch((err) => {
  console.error('Failed to register expiry schedules:', err);
});

// Dispatches on job.name rather than assuming every job on this queue is a
// ProcessBatch job — PhotoJobName is an enum specifically so this queue can
// carry more than one kind of job later without this dispatch silently
// mishandling the new kind.
const photoWorkerProcessor = async (job: Job<ProcessBatchJobData>) => {
  if (job.name === PhotoJobName.ProcessBatch) {
    await processPhotoBatch(job.data);
  } else {
    console.error(`Unknown job name: ${job.name}`);
  }
};

const photoWorker = new Worker(PHOTO_QUEUE_NAME, photoWorkerProcessor, { connection });

// 'error' is worker-level (e.g. a Redis connection drop), not a job
// failure — EventEmitter throws an uncaught exception (crashing this
// process) if 'error' fires with no listener attached, so this isn't
// optional the way logging a 'failed' job is.
photoWorker.on('error', (err) => {
  console.error(err);
});

// 'failed' fires on every thrown exception, including attempts that still
// have retries left under photoQueue's config (3 attempts, exponential
// backoff) — not just the final one. This process has no HTTP response to
// report failures through, so logging here is the only trace any given
// attempt leaves behind.
photoWorker.on('failed', (job, err) => {
  console.error(job?.id, err);
});

// Unlike the photo worker, every job.name on this queue is already a valid
// ExpiryJobName (expiryScheduler.ts only ever registers the 4 it knows
// about) — processExpiryJob does its own dispatch across all 4 internally,
// so there's nothing to branch on here.
const expiryWorkerProcessor = async (job: Job<ExpiryJobData>) => {
  await processExpiryJob(job.name);
};

const expiryWorker = new Worker(EXPIRY_QUEUE_NAME, expiryWorkerProcessor, { connection });

// 'error' is worker-level (e.g. a Redis connection drop), not a job
// failure — EventEmitter throws an uncaught exception (crashing this
// process) if 'error' fires with no listener attached, so this isn't
// optional the way logging a 'failed' job is.
expiryWorker.on('error', (err) => {
  console.error(err);
});

// 'failed' fires on every thrown exception, including attempts that still
// have retries left under expiryQueue's config (3 attempts, exponential
// backoff) — not just the final one. This process has no HTTP response to
// report failures through, so logging here is the only trace any given
// attempt leaves behind.
expiryWorker.on('failed', (job, err) => {
  console.error(job?.id, err);
});

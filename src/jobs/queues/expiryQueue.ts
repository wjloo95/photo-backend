/**
 * src/jobs/queues/expiryQueue.ts
 *
 * BullMQ queue for album expiry jobs — warning emails and deletion pipeline.
 * Jobs are scheduled via cron patterns (run daily), not triggered by route handlers.
 *
 * The cron schedules are added by the scheduler in src/jobs/schedulers/ — you write that.
 * The processors that run the jobs live in src/jobs/processors/ — you write those too.
 */

import { Queue } from 'bullmq';

// Same pattern as photoQueue — pass host/port rather than an ioredis instance
// to avoid the BullMQ/ioredis dual-package type clash.
const connectionUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: connectionUrl.hostname,
  port: Number(connectionUrl.port) || 6379,
};

// Job name constants for each step of the expiry pipeline.
export enum ExpiryJobName {
  Warn90Days  = 'warn-90-days',
  Warn30Days  = 'warn-30-days',
  Warn7Days   = 'warn-7-days',
  DeleteExpired = 'delete-expired',
}

// Expiry jobs carry no input data — the processor queries the DB directly
// for albums matching each warning window.
export type ExpiryJobData = Record<string, never>;

export const expiryQueue = new Queue<ExpiryJobData>(
  'expiry',
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5_000,
      },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { count: 100 },
    },
  }
);

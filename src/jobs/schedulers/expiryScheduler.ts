/**
 * src/jobs/schedulers/expiryScheduler.ts
 *
 * Registers the 4 repeating expiry-pipeline jobs on expiryQueue — warning
 * jobs at 90/30/7 days before an album's access_expires_at, plus the daily
 * sweep that deletes fully-expired albums. This file has no side effects on
 * its own; it only registers schedules once its exported function is
 * called — from worker.ts, once at process startup (same spot that
 * constructs the photoQueue Worker).
 */

import { expiryQueue, ExpiryJobName } from '../queues/expiryQueue';
// upsertJobScheduler rather than the older `queue.add(name, data, { repeat })`.
// "Upsert" is the operative word: worker.ts calls this on every process start —
// deploys, restarts, a crash coming back — and calling it again with the same
// schedulerId updates the existing schedule instead of adding a second one. The
// `.add()` + repeat form has no such identity, so re-registering on each restart
// accumulates duplicate schedules and the job starts firing several times a day.
//
// The job name doubles as the schedulerId for exactly that reason: it is stable
// across restarts, which is what makes the upsert idempotent.
export async function registerExpirySchedules(): Promise<void> {
  await expiryQueue.upsertJobScheduler(
    ExpiryJobName.DeleteExpired,
    { pattern: '0 8 * * *' },
    { name: ExpiryJobName.DeleteExpired, data: {} },
  );

  await expiryQueue.upsertJobScheduler(
    ExpiryJobName.Warn7Days,
    { pattern: '0 8 * * *' },
    { name: ExpiryJobName.Warn7Days, data: {} },
  );

  await expiryQueue.upsertJobScheduler(
    ExpiryJobName.Warn30Days,
    { pattern: '0 8 * * *' },
    { name: ExpiryJobName.Warn30Days, data: {} },
  );

  await expiryQueue.upsertJobScheduler(
    ExpiryJobName.Warn90Days,
    { pattern: '0 8 * * *' },
    { name: ExpiryJobName.Warn90Days, data: {} },
  );
}

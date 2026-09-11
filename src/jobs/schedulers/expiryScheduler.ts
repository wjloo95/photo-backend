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
// TODO (ASSIGNMENTS.md 5.3) — you'll need:
//
// The part worth thinking through before you write this:
//
// BullMQ has two ways to create a repeating job: the older
// `queue.add(name, data, { repeat: { pattern } })`, and the newer
// `queue.upsertJobScheduler(schedulerId, repeatOpts, jobTemplate)`. Use the
// second — "upsert" is the operative word, since calling it again with the
// same schedulerId updates the existing schedule instead of creating a
// duplicate one. That matters because this function runs on every worker
// startup (deploys, restarts, crashes and comes back) — with the older
// `.add()` + `repeat` approach, re-registering the same cron job on every
// restart risks accumulating duplicate schedules; upsertJobScheduler is
// built specifically to make "call this every time the process starts"
// safe.
//
//
// Steps:
//   1. Once per ExpiryJobName (Warn90Days, Warn30Days, Warn7Days,
//      DeleteExpired):
//        expiryQueue.upsertJobScheduler(
//          <the job name, used as the schedulerId>,
//          { pattern: '0 8 * * *' },
//          { name: <the job name>, data: {} },
//        )
//   2. Export this as a named function — worker.ts needs to import and
//      call it once at startup.
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

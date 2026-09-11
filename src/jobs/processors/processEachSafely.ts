/**
 * src/jobs/processors/processEachSafely.ts
 *
 * Processes every item in a batch independently — one item's failure
 * doesn't stop the rest from being attempted — while still surfacing that
 * something went wrong: if any item failed, the whole call rejects once,
 * after every item has been attempted, so the caller's BullMQ job still
 * fails and retries via its queue's attempts/backoff config.
 *
 * Shared by every job processor in this directory since each one needs the
 * same shape: loop a batch, isolate per-item failures, still fail the job
 * overall if anything didn't succeed.
 */
export async function processEachSafely<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  itemLabel = 'items',
): Promise<void> {
  const errors: unknown[] = [];

  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      console.error(item, err);
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    throw new Error(`${errors.length}/${items.length} ${itemLabel} failed to process`);
  }
}

-- Migration 021: photos can fail
--
-- A photo whose processing job used up all its retries used to stay
-- 'processing' forever, so the client portal's "N more on the way" count
-- (GET /albums/:id/photos processingCount) promised photos that would never
-- arrive. The worker now marks such photos 'failed' after the job's final
-- attempt; see jobs/worker.ts.
--
-- migrate.ts runs every migration inside a transaction. Postgres (12+) allows
-- ALTER TYPE ... ADD VALUE there, but the new value can't be *used* until that
-- transaction commits, so this file only adds it. Nothing here may write or
-- compare against 'failed'; a later migration can.

ALTER TYPE photo_status ADD VALUE 'failed';

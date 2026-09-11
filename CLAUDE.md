# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start server with hot reload (ts-node + nodemon)
npm run migrate      # apply pending SQL migrations
npm run typecheck    # tsc --noEmit, zero output means clean
npm run build        # compile to dist/
```

Local environment setup before first run:
```bash
docker run --name sys-photo-db -e POSTGRES_PASSWORD=password -p 5432:5432 -d postgres
docker exec -it sys-photo-db psql -U postgres -c "CREATE DATABASE sys_photo;"
cp .env.example .env   # then fill in DATABASE_URL and REDIS_URL at minimum
npm run migrate
npm run dev
```

## Architecture

Node.js / TypeScript / Express backend for a photography platform (photographers + clients, albums, messaging, forms, invite-only onboarding). Target: millions of users, read-heavy, CP over AP.

**Request path:** AWS ALB → nginx → Express (`src/server.ts` → `src/app.ts`) → route handlers → `src/db/queries/` → PostgreSQL (RDS). Background jobs handled by BullMQ worker reading from Redis (ElastiCache).

### What is and isn't built

This is a learning project. The scaffold is complete; the application logic is not. Here is the split:

| Already built (infrastructure) | User implements |
|---|---|
| `src/config/` — env validation, DB pool, Redis client | `src/routes/` — all 43 route handlers |
| `src/types/index.ts` — all 12 entity interfaces + enums | `src/middleware/` — auth, requireRole, errorHandler |
| `src/db/migrations/` — all 14 SQL migrations + runner | `src/db/queries/` — all SQL query functions |
| `src/jobs/queues/` — BullMQ queue shells | `src/jobs/processors/` — photo processing, expiry pipeline |
| `src/cache/index.ts` — get/set/del cache utilities | `src/jobs/schedulers/` — cron schedule registration |
| `src/app.ts`, `src/server.ts` — Express shell | `src/jobs/worker.ts` — BullMQ worker process |

### Key patterns

**Adding a route:** write `src/routes/resource.ts` → import and mount in `src/app.ts` with `app.use('/resource', router)`.

**Database access:** always import `pool` from `src/config/database.ts`. Write parameterised queries only — `$1, $2, ...` placeholders, never string interpolation. Query functions live in `src/db/queries/`, one file per resource.

**Cache-aside pattern** (you implement in route handlers):
- Read: check `cache.get(key)` → on miss query DB → `cache.set(key, result, ttlSeconds)`
- Write: update DB → `cache.del(key)` to invalidate

TTL targets from architecture decisions: album photo list 300s, album metadata 900s, photographer profile 3600s, conversation list 120s. Messages/unread counts/form responses are never cached.

**Adding a migration:** create `src/db/migrations/NNN_description.sql` (next number in sequence) and run `npm run migrate`. Never edit an already-applied migration — add a new one.

**BullMQ queues:** `photoQueue` (triggered on upload) and `expiryQueue` (daily cron). Both queues pass `host`/`port` connection options rather than an ioredis instance — this avoids the dual-package type clash between ioredis and BullMQ's internal ioredis copy.

**Env vars:** add to `.env.example` + add to the Zod schema in `src/config/env.ts`. The server exits on startup with a clear message if any required var is missing.

### Schema summary

12 entities in dependency order: `users` → `photographers` / `clients` → `albums` + `photos` → `photo_albums` (join) → `conversations` → `messages` → `form_templates` → `form_questions` → `form_responses` → `form_answers` → `invites`.

All PKs are UUIDs (`gen_random_uuid()`). All timestamps use `TIMESTAMPTZ`. `photographer.user_id` and `client.user_id` are both PK and FK to `users` — enforcing the 1:1 relationship at the schema level.

Denormalised fields on `conversations` (`most_recent_message_id`, `unread_for_photographer`, `unread_for_client`) must be kept in sync by message send/read handlers — they exist to avoid subqueries on every inbox load. The unread counters are per participant: a send increments only the recipient's side, marking read zeroes only the caller's.

TypeScript interfaces in `src/types/index.ts` mirror columns 1:1 (snake_case in DB → camelCase in TS). Nullable DB columns are typed `T | null`.

# `src/db/migrations/`

This folder contains every database migration for the app — one SQL file per schema change, applied in order.

---

## What is a migration?

A migration is a **versioned, append-only SQL script** that describes one change to the database schema.

The alternative is editing the database directly (running `ALTER TABLE` manually in a SQL client). That works once, on one machine. But:

- Your teammates' databases are now out of sync
- Your production database is out of sync
- There's no record of what changed or when
- You can't replay the full schema from scratch on a new machine

Migrations solve all of this. Every change is a file in version control. Anyone can run `migrate.ts` and get an identical database.

---

## Why numbered files?

The migration runner applies files in **alphabetical order**. Numbering (`001_`, `002_`, …) guarantees:

1. **Deterministic order** — tables are always created before the tables that reference them via foreign keys
2. **Readable history** — you can see the full evolution of the schema at a glance
3. **No conflicts** — when two developers add migrations simultaneously, the numbers make ordering explicit

The dependency order in this project:
```
001 users                 (no dependencies)
002 photographers         (→ users)
003 clients               (→ users, photographers)
004 albums                (→ photographers, clients)
005 photos                (no dependencies)
006 photo_albums          (→ photos, albums)
007 conversations         (→ photographers, clients)
008 messages              (→ conversations, users)
009 form_templates        (→ photographers)
010 form_questions        (→ form_templates)
011 form_responses        (→ form_templates, clients)
012 form_answers          (→ form_responses, form_questions)  [dropped in 019]
013 invites               (→ photographers)
014 indexes               (no new tables — adds indexes to existing tables)
```

Migrations 015 onward alter what is already there rather than adding tables:

```
015 users.name added, photographers.business_name dropped
016 photos gains width/height
017 conversations.number_of_unread split per participant
018 form_questions written as a set: UNIQUE (template_id, "order"),
    multiple_choice dropped from answer_type
019 form_responses snapshot their questions and inline their answers as
    JSONB; form_answers dropped; started_at renamed assigned_at;
    template_id FK becomes ON DELETE RESTRICT
```

---

## The `schema_migrations` table

The runner creates this table automatically on first run:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

Before applying each migration file, the runner checks whether its filename already exists in this table. If it does, it skips the file. If not, it runs the SQL and records the filename.

This means **running `migrate.ts` multiple times is always safe** — it only applies migrations that haven't run yet.

---

## How to write a new migration

1. Create the next numbered file: `015_add_column_x.sql`
2. Write the SQL inside it — usually `ALTER TABLE`, `CREATE TABLE`, or `CREATE INDEX`
3. Run `npm run migrate` — only your new file will be applied

**Never edit a migration that has already been applied.** If you need to change something, write a new migration that makes the correction. The history is permanent.

---

## How to reset your local database

Sometimes during development you want to start fresh:

```bash
# Connect to PostgreSQL and drop/recreate the database
psql postgres -c "DROP DATABASE sys_photo;"
psql postgres -c "CREATE DATABASE sys_photo;"

# Re-run all migrations from scratch
npm run migrate
```

This is safe locally. **Never do this in production.**

---

## Anatomy of `001_create_users.sql`

Here is the first migration with every clause explained:

```sql
-- Create the enum type first — PostgreSQL requires enum types to exist
-- before any table uses them as a column type.
CREATE TYPE user_role AS ENUM ('photographer', 'client');

CREATE TABLE users (
  -- UUID primary key.
  -- gen_random_uuid() is a built-in PostgreSQL function (available since PG 13).
  -- UUIDs are used instead of serial integers because:
  --   1. They are globally unique — safe to generate on the client or in code
  --   2. They don't expose record counts (security)
  --   3. They are safe to use across distributed systems
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT NULL means the database will reject any INSERT that omits this field.
  -- This enforces the constraint at the database level, independent of your application code.
  email TEXT NOT NULL UNIQUE,

  -- The enum type restricts values to exactly 'photographer' or 'client'.
  -- Any other value will be rejected by the database.
  role user_role NOT NULL,

  -- External reference to Auth0/Clerk. Stored here so we can look up
  -- our User record given the provider's user ID from a JWT.
  provider_id TEXT NOT NULL UNIQUE,

  -- TIMESTAMPTZ = timestamp with time zone.
  -- Always use TIMESTAMPTZ instead of TIMESTAMP — it stores UTC and handles
  -- daylight saving and timezone conversions correctly.
  -- NOW() sets the default to the current time at INSERT.
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Every other migration follows this same pattern — read `001` first, then the rest will be familiar.

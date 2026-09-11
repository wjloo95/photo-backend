# `src/config/`

Three files live here. Each one creates a single shared instance of an infrastructure dependency and exports it. The rest of the app imports from here — never creates its own connections.

---

## Why centralise connections here?

If every file that needs the database created its own `pg.Pool`, you would open dozens of connection pools simultaneously. Each pool holds multiple TCP connections to PostgreSQL. PostgreSQL has a hard connection limit (default 100). You would hit it fast.

Same problem with Redis — `ioredis` opens socket connections. Two clients means two sockets, doubled memory, doubled overhead.

**Rule:** one pool/client per process, created once, imported everywhere.

---

## `env.ts` — environment variable validation

### Why validate env vars at all?

TypeScript types are **erased at runtime**. If you type `process.env.DATABASE_URL as string`, TypeScript is satisfied, but at runtime that value is just whatever shell variable happens to be set — or `undefined` if it isn't.

Without validation, a missing env var becomes `undefined`, which travels silently until it crashes somewhere unexpected — often deep in a library with a confusing error message.

With Zod validation at startup, you get a clear error immediately:

```
❌  Missing environment variables:
    DATABASE_URL: Required
    AUTH0_DOMAIN: Required
```

### How it works

Zod is a **runtime validation library**. You define a schema describing what the env vars should look like, then call `schema.parse(process.env)`. If anything is wrong, it throws before the server starts.

```ts
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.string().transform(Number),  // coerce string → number
});

export const env = envSchema.parse(process.env);
```

After this, `env.DATABASE_URL` is guaranteed to be a valid URL string — no type assertions needed.

### How to add a new env var

1. Add it to `.env.example` with a comment explaining what it is
2. Add it to the Zod schema in `env.ts`
3. Use `env.YOUR_VAR` anywhere in the app — it is fully typed

---

## `database.ts` — PostgreSQL connection pool

### `pg.Pool` vs `pg.Client`

| | `pg.Client` | `pg.Pool` |
|---|---|---|
| Connections | 1 | Many (configurable, default 10) |
| Lifecycle | Manual connect/disconnect | Automatic checkout/return |
| Concurrent requests | Blocked — one query at a time | ✅ Handles many simultaneous queries |
| Use case | Scripts, one-off tasks | **Servers — always use this** |

A Pool maintains a set of reusable connections. When your route handler calls `pool.query(...)`, the pool lends it a free connection, runs the query, and returns the connection to the pool when done. If all connections are busy, new queries wait in a queue.

### What this file does NOT do

It only creates and exports the pool. **It contains no SQL queries.** You write all queries in `src/db/queries/`.

---

## `redis.ts` — Redis client

`ioredis` is used instead of the official `redis` npm package for two reasons:

1. **BullMQ requires it** — BullMQ uses ioredis internally. Using the same client avoids running two separate Redis connections in the same process.
2. **Better TypeScript support** — ioredis has comprehensive typings out of the box.

Like the database pool, this file only creates and exports the client. Cache logic belongs in `src/cache/`. Queue logic belongs in `src/jobs/queues/`.

# `src/cache/`

This folder contains a thin cache utility that wraps ioredis. **It does not implement the cache-aside pattern for you** — you apply the pattern in your route handlers. This file gives you the building blocks.

---

## What is cache-aside?

Cache-aside (also called "lazy loading") is the most common caching strategy for read-heavy applications. The application manages the cache explicitly — the database and cache never communicate directly.

### On a read:
```
1. Check the cache for the key
2. If found (cache hit) → return cached value immediately
3. If not found (cache miss) → query the database
4. Write the result to the cache with a TTL
5. Return the result
```

### On a write (mutation):
```
1. Write to the database
2. Delete (invalidate) the cache key
```

You delete on write rather than updating the cache, because updating would require reading the old cached value, merging it with the change, and writing it back — complex and error-prone. Deleting is simpler and correct: the next read will repopulate the cache from the database.

---

## Why cache-aside and not write-through?

Write-through updates the cache on every write, keeping it always warm. The downside: every write incurs extra latency, and the cache gets populated for keys that may never be read again.

Cache-aside only caches what is actually requested. For a read-heavy system with infrequent writes (photographers upload infrequently, clients read frequently), this is a better fit.

---

## TTL selection

TTL = Time To Live — how long a cached value stays fresh before expiry.

From the architecture decisions:

| Resource | TTL | Why |
|---|---|---|
| Album photo list | 5 min (300s) | Changes when photos are added/deleted |
| Album metadata | 15 min (900s) | Changes when thumbnail is set |
| Photographer profile | 1 hour (3600s) | Rarely changes |
| Conversation list | 2 min (120s) | New messages arrive frequently |

**Not cached at all:** Messages, unread counts, form responses. Staleness tolerance is zero — a client must always see the latest unread count and messages.

The `set` function in `index.ts` accepts a TTL in seconds. Always pass the TTL explicitly — do not rely on defaults.

---

## Event invalidation

Some resources must be invalidated immediately when they change, regardless of TTL. Examples:

- A photo is deleted → invalidate the album photo list immediately (a deleted photo must not appear for 5 more minutes)
- An album thumbnail is updated → invalidate album metadata immediately

The pattern is: after a destructive write in your route handler, call `cache.del(cacheKey)`. You decide which writes need immediate invalidation based on the staleness tolerance. You implement these calls in your route handlers.

---

## Cache key conventions

Use consistent, namespaced keys to avoid collisions between different resource types:

```
album:photos:{albumId}        → photo list for an album
album:meta:{albumId}          → album metadata
photographer:profile:{id}     → photographer profile
conversations:{userId}        → conversation list for a user
```

Define these as constants in your route files so they are easy to find and change.

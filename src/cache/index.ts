/**
 * src/cache/index.ts
 *
 * Thin cache utilities wrapping ioredis.
 * Provides get, set, and del with JSON serialisation.
 *
 * These are the building blocks. The cache-aside pattern — when to check,
 * when to populate, when to invalidate — is YOUR responsibility to implement
 * inside your route handlers.
 *
 * See README.md in this folder for the full cache-aside pattern and
 * TTL selection guidance from the architecture decisions.
 *
 * Usage example in a route handler:
 *
 *   const CACHE_KEY = `album:photos:${albumId}`;
 *   const TTL = 300; // 5 minutes
 *
 *   // On read:
 *   const cached = await cache.get<Photo[]>(CACHE_KEY);
 *   if (cached) return res.json(cached);
 *   const photos = await db.getAlbumPhotos(albumId); // your query function
 *   await cache.set(CACHE_KEY, photos, TTL);
 *   return res.json(photos);
 *
 *   // On delete:
 *   await db.deletePhoto(photoId); // your query function
 *   await cache.del(CACHE_KEY);
 */

import { redis } from '../config/redis';

const cache = {
  /**
   * Get a cached value by key.
   * Returns the parsed value if found, or null on a cache miss.
   *
   * Generic parameter T lets TypeScript know what type to expect back:
   *   cache.get<Photo[]>('album:photos:123')  → Photo[] | null
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  },

  /**
   * Set a cache entry with a TTL in seconds.
   * Always provide a TTL — unbounded cache entries accumulate indefinitely.
   *
   * 'EX' is the ioredis option for TTL in seconds.
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  },

  /**
   * Delete a cache entry immediately.
   * Call this after any write that must not leave stale data.
   */
  async del(key: string): Promise<void> {
    await redis.del(key);
  },
};

export default cache;

/**
 * src/cache/keys.ts
 *
 * Builders for cache keys written or cleared from more than one place. A key
 * typed out by hand at each call site drifts: one writer changes it and a
 * reader, or worse an invalidation, keeps using the old spelling and silently
 * stops matching.
 */

/**
 * The full photo list for an album, as GET /albums/:id/photos caches it.
 *
 * The version segment changes whenever the cached value's shape does. v2
 * entries are ordered and carry addedAt; a v1 entry still in Redis has
 * neither, and cursor code reading it would page wrongly until its TTL ran
 * out. A new key just never sees the old entries, which then expire on their
 * own.
 */
export function albumPhotosCacheKey(albumId: string): string {
  return `album:photos:v2:${albumId}`;
}

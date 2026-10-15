/**
 * src/cache/keys.ts
 *
 * Builders for cache keys written or cleared from more than one place. A key
 * typed out by hand at each call site drifts: one writer changes it and a
 * reader, or worse an invalidation, keeps using the old spelling and silently
 * stops matching.
 */

/** The full photo list for an album, as GET /albums/:id/photos caches it. */
export function albumPhotosCacheKey(albumId: string): string {
  return `album:photos:${albumId}`;
}

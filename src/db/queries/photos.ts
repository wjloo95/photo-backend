import { Photo } from '../../types';
import { pool } from '../../config/database';

export interface PhotoRow {
  id: string;
  base_path: string;
  status: Photo['status'];
  width: number | null;
  height: number | null;
  uploaded_at: Date;
}

export function toPhoto(row: PhotoRow): Photo {
  return {
    id: row.id,
    basePath: row.base_path,
    status: row.status,
    width: row.width,
    height: row.height,
    uploadedAt: row.uploaded_at,
  };
}

// cache.get<Photo[]>() (src/cache/index.ts) does JSON.parse(raw) as T — on a
// cache hit, uploadedAt comes back as the ISO string JSON.stringify turned
// it into, not a real Date. Same rehydration story as rehydrateAlbumDates
// in db/queries/albums.ts — call this on any Photo[] that came from
// cache.get before doing anything with uploadedAt beyond res.json().
export function rehydratePhotoDates(photo: Photo): Photo {
  return {
    ...photo,
    uploadedAt: new Date(photo.uploadedAt),
  };
}

/**
 * Inserts `count` new `photos` rows for an album (one per uploaded file)
 * plus a matching `photo_albums` row for each, atomically.
 *
 * `base_path` is inserted as '' since the real Cloudinary path isn't known
 * until the background processor uploads the bytes and flips `status` to
 * 'ready' — same placeholder convention as bio/profilePhotoUrl/instagramHandle
 * defaulting to '' in migration 002. `width`/`height` are left unset (NULL)
 * for the same reason — the processor fills them in once Cloudinary reports
 * the real dimensions.
 *
 * Returned photos preserve insertion order so the caller can zip each
 * Photo.id against the uploaded file it came from by index.
 */
export async function insertPhotosForAlbum(albumId: string, count: number): Promise<Photo[]> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const photos = await client.query(
      `INSERT INTO photos (base_path, status)
      SELECT '', 'processing' FROM generate_series(1, $1)
      RETURNING *`,
      [count],
    );

    await client.query(
      `INSERT INTO photo_albums (photo_id, album_id)
      SELECT id, $2 FROM UNNEST($1::uuid[]) AS id`,
      [photos.rows.map((row) => row.id), albumId],
    );

    await client.query('COMMIT');

    return photos.rows.map(toPhoto);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getPhotoById(id: string): Promise<Photo | null> {
  const result = await pool.query<PhotoRow>('SELECT * FROM photos WHERE id = $1', [id]);
  return result.rows[0] ? toPhoto(result.rows[0]) : null;
}

// Paginated photos in an album, oldest-added first — ORDER BY pa.added_at
// rather than p.uploaded_at so re-adding an existing photo to an album (see
// addPhotoToAlbum) moves it to the end of that album's listing, not back to
// wherever it originally sorted by upload time.
export async function getPhotosForAlbum(
  albumId: string,
  limit: number,
  offset: number,
): Promise<Photo[]> {
  const result = await pool.query<PhotoRow>(
    `SELECT p.*
     FROM photos p
     JOIN photo_albums pa ON pa.photo_id = p.id
     WHERE pa.album_id = $1
     ORDER BY pa.added_at ASC
     LIMIT $2 OFFSET $3`,
    [albumId, limit, offset],
  );
  return result.rows.map(toPhoto);
}

export async function getAllPhotosForAlbum(albumId: string): Promise<Photo[]> {
  const result = await pool.query<PhotoRow>(
    `SELECT p.*
     FROM photos p
     JOIN photo_albums pa ON pa.photo_id = p.id
     WHERE pa.album_id = $1`,
    [albumId],
  );
  return result.rows.map(toPhoto);
}

export interface PhotoAlbumOwnership {
  photographerId: string;
  clientId: string | null;
}

// Every album a photo currently belongs to, with that album's owning
// photographer/client — used to authorize both direct photo access
// (GET/DELETE /photos/:id) and "add existing photo to another album"
// (a photographer may only link in photos they already have album access
// to, not an arbitrary photo id).
export async function getAlbumOwnersForPhoto(photoId: string): Promise<PhotoAlbumOwnership[]> {
  const result = await pool.query<{ photographer_id: string; client_id: string | null }>(
    `SELECT a.photographer_id, a.client_id
     FROM photo_albums pa
     JOIN albums a ON a.id = pa.album_id
     WHERE pa.photo_id = $1`,
    [photoId],
  );
  return result.rows.map((row) => ({
    photographerId: row.photographer_id,
    clientId: row.client_id,
  }));
}

// Idempotent — ON CONFLICT DO NOTHING because (photo_id, album_id) is the
// primary key (migration 006); adding a photo that's already in the album
// should succeed silently rather than error.
export async function addPhotoToAlbum(albumId: string, photoId: string): Promise<void> {
  await pool.query(
    `INSERT INTO photo_albums (photo_id, album_id)
     VALUES ($1, $2)
     ON CONFLICT (photo_id, album_id) DO NOTHING`,
    [photoId, albumId],
  );
}

// Removes the photo from this one album only — the `photos` row (and any
// other album it belongs to) is untouched. Idempotent: deleting a link that
// doesn't exist is a no-op, not an error.
export async function removePhotoFromAlbum(albumId: string, photoId: string): Promise<void> {
  await pool.query('DELETE FROM photo_albums WHERE album_id = $1 AND photo_id = $2', [
    albumId,
    photoId,
  ]);
}

export async function deletePhotosFromAlbum(albumId: string, photoIds: string[]): Promise<void> {
  await pool.query('DELETE FROM photo_albums WHERE album_id = $1 AND photo_id = ANY($2::uuid[])', [
    albumId,
    photoIds,
  ]);
}

// Permanently removes the photo from the system. photo_albums.photo_id and
// albums.thumbnail_photo_id both reference photos with ON DELETE
// CASCADE/SET NULL respectively (migration 006), so every album membership
// and any thumbnail reference is cleaned up automatically.
export async function deletePhotoById(id: string): Promise<void> {
  await pool.query('DELETE FROM photos WHERE id = $1', [id]);
}

export async function markPhotoReady(
  photoId: string,
  { basePath, width, height }: Pick<Photo, 'basePath' | 'width' | 'height'>,
): Promise<void> {
  await pool.query(
    `UPDATE photos SET base_path = $2, width = $3, height = $4,
    status = 'ready' WHERE id = $1`,
    [photoId, basePath, width, height],
  );
}

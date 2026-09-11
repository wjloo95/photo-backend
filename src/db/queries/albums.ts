import { pool } from '../../config/database';
import { Album, AlbumType } from '../../types';

// Mirrors the albums table 1:1 (snake_case, as Postgres returns it).
interface AlbumRow {
  id: string;
  photographer_id: string;
  client_id: string | null;
  thumbnail_photo_id: string | null;
  type: Album['type'];
  shoot_date: Date;
  access_expires_at: Date;
  warned_90_at: Date | null;
  warned_30_at: Date | null;
  warned_7_at: Date | null;
  created_at: Date;
}

function toAlbum(row: AlbumRow): Album {
  return {
    id: row.id,
    photographerId: row.photographer_id,
    clientId: row.client_id,
    thumbnailPhotoId: row.thumbnail_photo_id,
    type: row.type,
    shootDate: row.shoot_date,
    accessExpiresAt: row.access_expires_at,
    warned90At: row.warned_90_at,
    warned30At: row.warned_30_at,
    warned7At: row.warned_7_at,
    createdAt: row.created_at,
  };
}

// cache.get<Album>() (src/cache/index.ts) does JSON.parse(raw) as T — on a
// cache hit, every Date field actually comes back as the ISO string
// JSON.stringify turned it into on the way in, not a real Date. TypeScript
// has no way to know that, so the type is lying: comparisons like `a.date <
// b.date` still happen to work on those strings (ISO-8601 sorts
// lexicographically the same as chronologically), but anything calling an
// actual Date method (.getTime(), addThreeYears's .setFullYear(), etc.) or
// doing `a.date - b.date` (NaN - NaN, since strings aren't numeric) will
// misbehave. Call this on any Album that came from cache.get before doing
// anything with its date fields beyond passing it straight to res.json()
// (which would re-stringify a real Date to the same ISO string anyway).
export function rehydrateAlbumDates(album: Album): Album {
  return {
    ...album,
    shootDate: new Date(album.shootDate),
    accessExpiresAt: new Date(album.accessExpiresAt),
    warned90At: album.warned90At ? new Date(album.warned90At) : null,
    warned30At: album.warned30At ? new Date(album.warned30At) : null,
    warned7At: album.warned7At ? new Date(album.warned7At) : null,
    createdAt: new Date(album.createdAt),
  };
}

export async function getPhotographerAlbumsByUserId(photographerId: string): Promise<Album[]> {
  const result = await pool.query<AlbumRow>('SELECT * FROM albums WHERE photographer_id = $1', [
    photographerId,
  ]);
  return result.rows.map(toAlbum);
}

export interface CreateAlbumFields {
  photographerId: string;
  clientId: string | null;
  type: AlbumType;
  shootDate: Date;
  accessExpiresAt: Date;
}

export async function insertAlbum(fields: CreateAlbumFields): Promise<Album> {
  const { photographerId, clientId, type, shootDate, accessExpiresAt } = fields;

  const result = await pool.query<AlbumRow>(
    `INSERT INTO albums (photographer_id, client_id, type, shoot_date, access_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [photographerId, clientId, type, shootDate, accessExpiresAt],
  );
  return toAlbum(result.rows[0]);
}

export async function getAlbumById(id: string): Promise<Album | null> {
  const result = await pool.query<AlbumRow>('SELECT * FROM albums WHERE id = $1', [id]);
  return result.rows[0] ? toAlbum(result.rows[0]) : null;
}

export interface UpdateAlbumFields {
  thumbnailPhotoId: string;
}

export async function updateAlbumById(
  id: string,
  fields: Partial<UpdateAlbumFields>,
): Promise<Album | null> {
  const { thumbnailPhotoId } = fields;

  const result = await pool.query<AlbumRow>(
    `UPDATE albums
     SET thumbnail_photo_id = COALESCE($2, thumbnail_photo_id)
     WHERE id = $1
     RETURNING *`,
    [id, thumbnailPhotoId],
  );
  return result.rows[0] ? toAlbum(result.rows[0]) : null;
}

// DELETE /albums/:id removes the row outright — photo_albums.album_id has
// ON DELETE CASCADE (migration 006), so join rows are cleaned up
// automatically. Same convention as DELETE /users/:id and DELETE /invites/:id.
export async function deleteAlbumById(id: string): Promise<void> {
  await pool.query('DELETE FROM albums WHERE id = $1', [id]);
}
/**
 * Albums due an expiry warning at the 90/30/7-day mark.
 *
 * The predicate is `<=` rather than `=` deliberately. Matching the exact day
 * would mean an album whose warning day passed while the worker was down — a
 * deploy, a crash, a run delayed past midnight UTC — is skipped forever, since
 * tomorrow it is N-1 days out and no longer matches. With `<=` the condition
 * stays true until something clears it, so a missed run simply catches up on
 * the next one. `warned_*_at IS NULL` is what clears it, which is why reading
 * the qualifying albums and calling markAlbumWarned need to stay close
 * together: two runs overlapping before the first one's write lands would both
 * see the album as unwarned and warn twice.
 *
 * warnedColumn is interpolated rather than bound. A $1 placeholder binds a
 * *value*, never an identifier, so a column name cannot travel that way. This
 * is safe because `days` is typed to the three literals and the column name is
 * chosen from them here — no caller-supplied string ever reaches the SQL.
 */
export async function getAlbumsNeedingWarning(days: 90 | 30 | 7): Promise<Album[]> {
  const warnedColumn = days === 90 ? 'warned_90_at' : days === 30 ? 'warned_30_at' : 'warned_7_at';

  const result = await pool.query<AlbumRow>(
    `SELECT * FROM albums
     WHERE access_expires_at <= NOW() + make_interval(days => $1)
     AND ${warnedColumn} IS NULL`,
    [days],
  );
  return result.rows.map(toAlbum);
}

export enum WarningColumn {
  Warned90 = 'warned_90_at',
  Warned30 = 'warned_30_at',
  Warned7 = 'warned_7_at',
}

export async function markAlbumWarned(albumId: string, field: WarningColumn): Promise<void> {
  await pool.query(`UPDATE albums SET ${field} = NOW() WHERE id = $1`, [albumId]);
}

export async function getExpiredAlbums(): Promise<Album[]> {
  const result = await pool.query<AlbumRow>('SELECT * FROM albums WHERE access_expires_at < NOW()');
  return result.rows.map(toAlbum);
}

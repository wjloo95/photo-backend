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
  access_expires_at: Date | null; // null = never expires (portfolio)
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
    accessExpiresAt: album.accessExpiresAt ? new Date(album.accessExpiresAt) : null,
    warned90At: album.warned90At ? new Date(album.warned90At) : null,
    warned30At: album.warned30At ? new Date(album.warned30At) : null,
    warned7At: album.warned7At ? new Date(album.warned7At) : null,
    createdAt: new Date(album.createdAt),
  };
}

/**
 * GET /clients/:id/albums — every album belonging to one client.
 *
 * The counterpart to getPhotographerAlbumsByUserId, and the only way a client
 * discovers their own galleries: GET /albums/:id needs an id they already
 * have, and the photographer-scoped list is closed to them.
 *
 * Newest shoot first. Ordering by shoot_date rather than created_at matches
 * how a client thinks about their galleries — by when the shoot happened, not
 * when the photographer got round to uploading it.
 *
 * Portfolio albums never appear: they have no client_id by design (migration
 * 004), so the predicate excludes them without a type check.
 *
 * No expiry filter, deliberately. GET /albums/:id doesn't apply one either, so
 * filtering here would make an album visible directly but invisible in the
 * list it belongs to. Whether access should actually end at access_expires_at
 * rather than at deletion is a real open question (see D-04) — but it belongs
 * in one place covering both endpoints, not smuggled into this query.
 */
export async function getAlbumsByClientId(clientId: string): Promise<Album[]> {
  const result = await pool.query<AlbumRow>(
    'SELECT * FROM albums WHERE client_id = $1 ORDER BY shoot_date DESC',
    [clientId],
  );
  return result.rows.map(toAlbum);
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
  /**
   * Null for portfolio albums, which never expire. The CHECK constraint from
   * migration 020 rejects the two mismatched combinations, so a caller that
   * gets this wrong fails loudly at the insert rather than creating an album
   * that quietly does or doesn't expire.
   */
  accessExpiresAt: Date | null;
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
 * An album due a warning, plus the address the warning goes to.
 *
 * The recipient is the client, so this spans albums -> clients -> users. It is
 * a LEFT JOIN and clientEmail is nullable because albums.client_id is
 * ON DELETE SET NULL (migration 004): deleting a client detaches their shoot
 * albums rather than removing them, so an album can outlive the only person it
 * would ever have been sent to. The processor treats that as "nobody to warn"
 * rather than as an error — see expiryProcessor.ts.
 */
export interface AlbumNeedingWarning extends Album {
  clientEmail: string | null;
  clientName: string | null;
}

interface AlbumNeedingWarningRow extends AlbumRow {
  client_email: string | null;
  client_name: string | null;
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
export async function getAlbumsNeedingWarning(days: 90 | 30 | 7): Promise<AlbumNeedingWarning[]> {
  const warnedColumn = days === 90 ? 'warned_90_at' : days === 30 ? 'warned_30_at' : 'warned_7_at';

  // Portfolio albums need no `type` predicate here: their access_expires_at is
  // NULL (migration 020), and `NULL <= anything` is NULL rather than TRUE, so
  // they are excluded by the comparison itself.
  //
  // `a.*` plus two aliased columns, never `u.*` — node-postgres keys each row
  // by column name and keeps only the last of a duplicated one, so selecting
  // the users row whole would overwrite the album's id with the user's.
  const result = await pool.query<AlbumNeedingWarningRow>(
    `SELECT a.*, u.email AS client_email, u.name AS client_name
     FROM albums a
     LEFT JOIN clients c ON c.user_id = a.client_id
     LEFT JOIN users u   ON u.id = c.user_id
     WHERE a.access_expires_at <= NOW() + make_interval(days => $1)
     AND a.${warnedColumn} IS NULL`,
    [days],
  );

  return result.rows.map((row) => ({
    ...toAlbum(row),
    clientEmail: row.client_email,
    clientName: row.client_name,
  }));
}

export enum WarningColumn {
  Warned90 = 'warned_90_at',
  Warned30 = 'warned_30_at',
  Warned7 = 'warned_7_at',
}

export async function markAlbumWarned(albumId: string, field: WarningColumn): Promise<void> {
  await pool.query(`UPDATE albums SET ${field} = NOW() WHERE id = $1`, [albumId]);
}

/**
 * Albums past their access_expires_at, for the deletion sweep.
 *
 * Portfolio albums never appear: they carry NULL (migration 020), and
 * `NULL < NOW()` is NULL, not TRUE. That exclusion is guaranteed by the
 * albums_expiry_matches_type CHECK rather than by convention — nothing can
 * put a date on a portfolio album for this query to find.
 *
 * `warned_7_at IS NOT NULL` is the safety gate on an irreversible operation:
 * an album is only deleted once its final warning step has completed. If the
 * mail provider was down for the whole run-up, warned_7_at is still NULL and
 * the album is skipped rather than destroyed silently — it gets warned and
 * deleted once email recovers, days late but not lost.
 *
 * Note what the column asserts: the warning *step* completed, not that a human
 * received anything. An album whose client was deleted has nobody to warn, and
 * the processor marks it warned anyway — otherwise this predicate would keep
 * it, and its Cloudinary assets, alive forever.
 */
export async function getExpiredAlbums(): Promise<Album[]> {
  const result = await pool.query<AlbumRow>(
    `SELECT * FROM albums
     WHERE access_expires_at < NOW()
     AND warned_7_at IS NOT NULL`,
  );
  return result.rows.map(toAlbum);
}

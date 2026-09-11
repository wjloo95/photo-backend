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
//     getAlbumsNeedingWarning(days: number): Promise<Album[]> — albums
//       where access_expires_at <= NOW() + INTERVAL 'N days' AND the
//       relevant warned_*_at IS NULL. Three call sites (90/30/7), so decide
//       whether that's one parameterised function or three thin ones —
//       either way, the warned_*_at column being updated can't be a normal
//       $1-style query parameter (those bind values, not column names), so
//       whichever shape you pick still needs to pick the right column name
//       in application code, not via a placeholder.
//     markAlbumWarned(albumId, field): sets one warned_*_at = NOW()
//     getExpiredAlbums(): Promise<Album[]> — access_expires_at < NOW()
//   already available: getPhotosForAlbum (db/queries/photos.ts — paginated,
//   built for the API route; you likely want every photo in the album here,
//   not one page of it), deletePhotoById, deleteAlbumById,
//   getAlbumOwnersForPhoto

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

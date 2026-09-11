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

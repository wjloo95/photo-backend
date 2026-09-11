import { pool } from '../../config/database';
import { Album } from '../../types';

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

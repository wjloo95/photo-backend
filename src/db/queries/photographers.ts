import { pool } from '../../config/database';
import { Album, Photographer } from '../../types';

interface UpdatePhotographerFields {
  bio: string;
  profilePhotoUrl: string;
  instagramHandle: string;
}

// Mirrors the photographers table 1:1 (snake_case, as Postgres returns it).
interface PhotographerRow {
  user_id: string;
  bio: string;
  profile_photo_url: string;
  instagram_handle: string;
  visibility: Photographer['visibility'];
}

// Built as an object literal typed against Photographer, so adding a field to
// the interface without mapping it here is a compile error, not a silent
// runtime undefined.
function toPhotographer(row: PhotographerRow): Photographer {
  return {
    userId: row.user_id,
    bio: row.bio,
    profilePhotoUrl: row.profile_photo_url,
    instagramHandle: row.instagram_handle,
    visibility: row.visibility,
  };
}

export async function getPhotographerByUserId(userId: string): Promise<Photographer | null> {
  const result = await pool.query<PhotographerRow>(
    'SELECT * FROM photographers WHERE user_id = $1',
    [userId],
  );
  return result.rows[0] ? toPhotographer(result.rows[0]) : null;
}

export async function updatePhotographerByUserId(
  userId: string,
  fields: Partial<UpdatePhotographerFields>,
): Promise<Photographer | null> {
  const { bio, instagramHandle, profilePhotoUrl } = fields;

  const result = await pool.query<PhotographerRow>(
    `UPDATE photographers
     SET bio = COALESCE($2, bio),
         profile_photo_url = COALESCE($3, profile_photo_url),
         instagram_handle = COALESCE($4, instagram_handle)
     WHERE user_id = $1
     RETURNING *`,
    [userId, bio, instagramHandle, profilePhotoUrl],
  );
  return result.rows[0] ? toPhotographer(result.rows[0]) : null;
}
// Not a raw table mirror (clients has no display data of its own), so this
// type lives here rather than in types/index.ts alongside Client.
export interface ClientWithUser {
  userId: string;
  name: string;
  email: string;
}

interface ClientWithUserRow {
  user_id: string;
  name: string;
  email: string;
}

function toClientWithUser(row: ClientWithUserRow): ClientWithUser {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
  };
}

export async function getPhotographerClientsByUserId(
  photographerId: string,
): Promise<ClientWithUser[]> {
  const result = await pool.query<ClientWithUserRow>(
    `SELECT u.id AS user_id, u.name, u.email
     FROM clients c
     JOIN users u ON u.id = c.user_id
     WHERE c.photographer_id = $1
     ORDER BY u.name`,
    [photographerId],
  );
  return result.rows.map(toClientWithUser);
}

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

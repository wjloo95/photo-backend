import { pool } from '../../config/database';
import { Photographer } from '../../types';

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

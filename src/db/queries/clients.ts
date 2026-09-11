import { pool } from '../../config/database';

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

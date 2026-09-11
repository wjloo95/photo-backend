import { pool } from '../../config/database';
import { Client } from '../../types';

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

interface ClientRow {
  user_id: string;
  photographer_id: string;
}

function toClient(row: ClientRow): Client {
  return {
    userId: row.user_id,
    photographerId: row.photographer_id,
  };
}

// Used to verify a client actually belongs to the photographer creating an
// album for them — clientId in a request body is caller-controlled and must
// never be trusted without this check (same reasoning as photographerId
// elsewhere in this app).
export async function getClientByUserId(userId: string): Promise<Client | null> {
  const result = await pool.query<ClientRow>('SELECT * FROM clients WHERE user_id = $1', [userId]);
  return result.rows[0] ? toClient(result.rows[0]) : null;
}

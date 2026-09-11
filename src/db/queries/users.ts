import { pool } from '../../config/database';
import { User } from '../../types';

export async function getUserByProviderId(providerId: string): Promise<User | null> {
  const result = await pool.query<User>(
    'SELECT id, email, role, provider_id AS "providerId", joined_at AS "joinedAt" FROM users WHERE provider_id = $1',
    [providerId],
  );
  return result.rows[0] ?? null;
}

import { pool } from '../../config/database';
import { User, UserRole } from '../../types';

export async function getUserByProviderId(providerId: string): Promise<User | null> {
  const result = await pool.query<User>(
    'SELECT id, email, name, role, provider_id AS "providerId", joined_at AS "joinedAt" FROM users WHERE provider_id = $1',
    [providerId],
  );
  return result.rows[0] ?? null;
}

export interface UpdateUserFields {
  email: string;
  name: string;
}

export async function updateUserById(
  userId: string,
  fields: Partial<UpdateUserFields>,
): Promise<User | null> {
  const { email, name } = fields;

  const result = await pool.query<User>(
    `UPDATE users
     SET email = COALESCE($2, email),
         name = COALESCE($3, name)
     WHERE id = $1
     RETURNING id, email, name, role, provider_id AS "providerId", joined_at AS "joinedAt"`,
    [userId, email, name],
  );
  return result.rows[0] ?? null;
}

export interface InsertUserFromWebhookInput {
  email: string;
  name: string;
  role: UserRole;
  providerId: string;
}

/**
 * Inserts a `users` row and, if role is 'photographer', a matching
 * `photographers` row — atomically, as one transaction.
 *
 * TODO: implement using a single checked-out client (`pool.connect()`), not
 * `pool.query`, so both statements run on the same connection:
 *   1. `client.query('BEGIN')`
 *   2. INSERT INTO users (...) VALUES ($1, $2, $3) RETURNING ... — parameterised
 *   3. if role === UserRole.photographer, INSERT INTO photographers (...)
 *   4. `client.query('COMMIT')`
 * On any error, `client.query('ROLLBACK')` then rethrow. Always `client.release()`
 * in a `finally` block so the connection goes back to the pool either way.
 */
export async function insertUserFromWebhook(input: InsertUserFromWebhookInput): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query<User>(
      `INSERT INTO users (email, name, role, provider_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, provider_id AS "providerId", joined_at AS "joinedAt"`,
      [input.email, input.name, input.role, input.providerId],
    );
    const createdUser = userResult.rows[0];

    if (input.role === UserRole.photographer) {
      await client.query('INSERT INTO photographers (user_id) VALUES ($1)', [createdUser.id]);
    }

    await client.query('COMMIT');

    return createdUser;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

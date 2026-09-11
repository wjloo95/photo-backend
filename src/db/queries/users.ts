import { pool } from '../../config/database';
import { User, UserRole } from '../../types';
import { AppError } from '../../types/AppError';

export async function getUserByProviderId(providerId: string): Promise<User | null> {
  const result = await pool.query<User>(
    'SELECT id, email, role, provider_id AS "providerId", joined_at AS "joinedAt" FROM users WHERE provider_id = $1',
    [providerId],
  );
  return result.rows[0] ?? null;
}

export interface InsertUserFromWebhookInput {
  email: string;
  role: UserRole;
  providerId: string;
  // Required when role === UserRole.photographer; ignored for clients.
  businessName?: string;
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
  if (input.role === UserRole.photographer && !input.businessName) {
    throw new AppError('businessName is required for photographer signups', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query<User>(
      `INSERT INTO users (email, role, provider_id)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, provider_id AS "providerId", joined_at AS "joinedAt"`,
      [input.email, input.role, input.providerId],
    );
    const createdUser = userResult.rows[0];

    if (input.role === UserRole.photographer) {
      await client.query('INSERT INTO photographers (user_id, business_name) VALUES ($1, $2)', [
        createdUser.id,
        input.businessName,
      ]);
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

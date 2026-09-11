import { pool } from '../../config/database';
import { InviteStatus, User, UserRole } from '../../types';
import { InviteRow, toInvite } from './invites';
import { AppError } from '../../types/AppError';

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
 * Runs on a single checked-out client rather than `pool.query`, because the
 * statements have to share one connection to share one transaction — two
 * `pool.query` calls can land on two different connections, and BEGIN on one
 * of them means nothing to the other.
 *
 * `client.release()` sits in a `finally` so the connection returns to the pool
 * whichever way this exits. Note that releasing does not roll back: the
 * explicit ROLLBACK in the catch is what stops the next borrower inheriting an
 * open transaction.
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

export interface AcceptInviteInput {
  email: string;
  name: string;
  providerId: string;
  inviteToken: string;
}

// A client accepting an invite link. One transaction creates all four of the
// users row, the clients row (photographer_id from the invite, never from the
// request), the conversation D-20 auto-creates alongside a client, and the
// invite's own status update — or none of them.
//
// The invite is loaded with SELECT ... FOR UPDATE rather than by reusing
// getInviteByToken from queries/invites.ts, and that is the load-bearing
// decision here. Two people redeeming the same token at the same instant — a
// double-click, a retry — would both read status 'pending' before either
// wrote 'accepted', and both would get an account. FOR UPDATE holds a row lock
// for the rest of the transaction, so the second reader blocks until the first
// commits and then sees 'accepted'. getInviteByToken runs on the pool, outside
// this transaction, and could not take that lock.
//
// The status and expiry conditions are re-checked here even though
// GET /invites/validate checks the same things: nothing guarantees the client
// called it, or that the invite was still valid when they did.
export async function insertClientFromInvite(input: AcceptInviteInput): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const clientInvite = await client.query<InviteRow>(
      `SELECT *
       FROM invites
       WHERE token = $1
       FOR UPDATE`,
      [input.inviteToken],
    );

    const inviteRow = clientInvite.rows[0];
    const inviteObj = inviteRow ? toInvite(inviteRow) : null;

    if (
      !inviteObj ||
      inviteObj.status !== InviteStatus.pending ||
      inviteObj.expiresAt < new Date()
    ) {
      throw new AppError('Invite is invalid or expired', 410);
    }
    const { id, photographerId } = inviteObj;

    // Create user
    const userResult = await client.query<User>(
      `INSERT INTO users (email, name, role, provider_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, provider_id AS "providerId", joined_at AS "joinedAt"`,
      [input.email, input.name, UserRole.client, input.providerId],
    );
    const createdUser = userResult.rows[0];

    // Create Client
    await client.query(
      `INSERT INTO clients (user_id, photographer_id)
      VALUES ($1, $2)`,
      [createdUser.id, photographerId],
    );

    // Create Conversation
    await client.query(
      `INSERT INTO conversations (photographer_id, client_id)
      VALUES ($1, $2)`,
      [photographerId, createdUser.id],
    );

    // Update invite
    await client.query(
      `UPDATE invites
       SET status = 'accepted', accepted_at = NOW()
       WHERE id = $1`,
      [id],
    );

    await client.query('COMMIT');

    return createdUser;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

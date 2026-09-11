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

export interface AcceptInviteInput {
  email: string;
  name: string;
  providerId: string;
  inviteToken: string;
}

// TODO (ASSIGNMENTS.md 3.3 — "the hardest transaction in the app"): a client
// accepting an invite link. One transaction (same pool.connect() pattern as
// insertUserFromWebhook above) must create all FOUR of:
//   1. users row (role = 'client')
//   2. clients row — photographer_id comes from the invite, never the request
//   3. conversations row, per D-20 (auto-created alongside the client)
//   4. invites row updated: status = 'accepted', accepted_at = NOW()
// If any insert fails, all four roll back — no partial state.
//
// Design decision to make first: how do you look up + validate the invite
// inside this transaction? Two people could redeem the same token at the
// same instant (double-click, retry). A plain SELECT (e.g. reusing
// getInviteByToken from db/queries/invites.ts, which runs on the pool
// outside this transaction) doesn't stop both from reading "pending" before
// either writes "accepted." Locking the row within this transaction (e.g.
// `SELECT * FROM invites WHERE token = $1 FOR UPDATE`) does. Decide which
// approach you want and be consistent — same spirit as the auth.ts /
// requireRole design decision in Phase 1.3.
//
// Once you have the invite, re-check the same conditions validateInvite
// checks (exists, not already accepted/expired, not past expiresAt) — don't
// assume the client called GET /invites/validate right before this ran.
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

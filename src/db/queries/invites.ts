import { pool } from '../../config/database';
import { Invite } from '../../types';

// Mirrors the invites table 1:1 (snake_case, as Postgres returns it).
// Exported so other query files whose transactions touch invites (e.g.
// insertClientFromInvite in queries/users.ts, which locks and reads an
// invite row as part of accepting one) can map raw rows the same way,
// instead of duplicating this column list.
export interface InviteRow {
  id: string;
  photographer_id: string;
  email: string;
  client_name: string;
  token: string;
  status: Invite['status'];
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

export function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    photographerId: row.photographer_id,
    email: row.email,
    clientName: row.client_name,
    token: row.token,
    status: row.status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  };
}

export interface CreateInviteFields {
  photographerId: string;
  email: string;
  clientName: string;
  token: string;
  expiresAt: Date;
}

export async function insertInvite(fields: CreateInviteFields): Promise<Invite> {
  const { photographerId, email, clientName, token, expiresAt } = fields;

  const result = await pool.query<InviteRow>(
    `INSERT INTO invites (photographer_id, email, client_name, token, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [photographerId, email, clientName, token, expiresAt],
  );
  return toInvite(result.rows[0]);
}

// Looks up an invite by its raw token — the credential a prospective client
// presents at validate/accept time, before they have an account or a JWT.
// Returns null (not a throw) on no match; the route handler decides what
// that means (404).
export async function getInviteByToken(token: string): Promise<Invite | null> {
  const result = await pool.query<InviteRow>(
    `SELECT *
     FROM invites
     WHERE token = $1`,
    [token],
  );
  return result.rows[0] ? toInvite(result.rows[0]) : null;
}

// Flips a still-pending invite to expired once its expires_at has passed.
// No RETURNING — the caller (validateInvite) already has the invite row
// it's about to respond about.
export async function expireInvite(id: string): Promise<void> {
  await pool.query<InviteRow>(
    `UPDATE invites
    SET status = 'expired'
    WHERE id = $1`,
    [id],
  );
}

// Looks up an invite by its DB id (not token) — used by resend/cancel, which
// operate on /invites/:id and need to load the invite first to check the
// caller owns it before mutating anything.
export async function getInviteById(id: string): Promise<Invite | null> {
  const result = await pool.query<InviteRow>('SELECT * FROM invites WHERE id = $1', [id]);
  return result.rows[0] ? toInvite(result.rows[0]) : null;
}

export interface RefreshInviteTokenFields {
  token: string;
  expiresAt: Date;
}

// Regenerates an invite's token and expiry and forces status back to
// 'pending' — this is what lets a photographer revive an already-expired
// invite, not just refresh one that's still active.
export async function refreshInviteToken(
  id: string,
  fields: RefreshInviteTokenFields,
): Promise<Invite | null> {
  const { token, expiresAt } = fields;

  const result = await pool.query<InviteRow>(
    `UPDATE invites
     SET token = $2, expires_at = $3, status = 'pending'
     WHERE id = $1
     RETURNING *`,
    [id, token, expiresAt],
  );
  return result.rows[0] ? toInvite(result.rows[0]) : null;
}

// Permanently removes an invite row. DELETE /invites/:id cancels an invite
// by deleting it outright — same convention as DELETE /users/:id (2.3).
export async function deleteInviteById(id: string): Promise<void> {
  await pool.query('DELETE FROM invites WHERE id = $1', [id]);
}

// Pending invites for a photographer's dashboard — GET /photographers/:id/invites.
export async function getPendingInvitesByPhotographerId(photographerId: string): Promise<Invite[]> {
  const result = await pool.query<InviteRow>(
    `SELECT *
     FROM invites
     WHERE photographer_id = $1 AND status = 'pending'
     ORDER BY created_at DESC`,
    [photographerId],
  );
  return result.rows.map(toInvite);
}

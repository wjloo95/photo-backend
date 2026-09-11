jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import {
  insertInvite,
  getInviteByToken,
  expireInvite,
  getInviteById,
  refreshInviteToken,
  deleteInviteById,
  getPendingInvitesByPhotographerId,
} from '../invites';
import { pool } from '../../../config/database';
import { InviteStatus } from '../../../types';

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
});

describe('insertInvite', () => {
  it('inserts with the given fields and maps the returned row from snake_case to the Invite shape', async () => {
    const expiresAt = new Date('2026-09-25T00:00:00Z');
    const createdAt = new Date('2026-08-26T00:00:00Z');
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'invite-1',
          photographer_id: 'photog-1',
          email: 'client@example.com',
          client_name: 'Jane Client',
          token: 'a'.repeat(64),
          status: InviteStatus.pending,
          expires_at: expiresAt,
          accepted_at: null,
          created_at: createdAt,
        },
      ],
    });

    const result = await insertInvite({
      photographerId: 'photog-1',
      email: 'client@example.com',
      clientName: 'Jane Client',
      token: 'a'.repeat(64),
      expiresAt,
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO invites'), [
      'photog-1',
      'client@example.com',
      'Jane Client',
      'a'.repeat(64),
      expiresAt,
    ]);
    expect(result).toEqual({
      id: 'invite-1',
      photographerId: 'photog-1',
      email: 'client@example.com',
      clientName: 'Jane Client',
      token: 'a'.repeat(64),
      status: InviteStatus.pending,
      expiresAt,
      acceptedAt: null,
      createdAt,
    });
  });
});

describe('getInviteByToken', () => {
  it('looks up by token and maps the returned row from snake_case to the Invite shape', async () => {
    const expiresAt = new Date('2026-09-25T00:00:00Z');
    const createdAt = new Date('2026-08-26T00:00:00Z');
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'invite-1',
          photographer_id: 'photog-1',
          email: 'client@example.com',
          client_name: 'Jane Client',
          token: 'a'.repeat(64),
          status: InviteStatus.pending,
          expires_at: expiresAt,
          accepted_at: null,
          created_at: createdAt,
        },
      ],
    });

    const result = await getInviteByToken('a'.repeat(64));

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM invites'), ['a'.repeat(64)]);
    expect(result).toEqual({
      id: 'invite-1',
      photographerId: 'photog-1',
      email: 'client@example.com',
      clientName: 'Jane Client',
      token: 'a'.repeat(64),
      status: InviteStatus.pending,
      expiresAt,
      acceptedAt: null,
      createdAt,
    });
  });

  it('returns null when no invite matches the token', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getInviteByToken('does-not-exist');

    expect(result).toBeNull();
  });
});

describe('expireInvite', () => {
  it('sets status to expired for the given invite id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expireInvite('invite-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE invites'), ['invite-1']);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'expired'");
  });
});

describe('getInviteById', () => {
  it('looks up by id and maps the returned row from snake_case to the Invite shape', async () => {
    const expiresAt = new Date('2026-09-25T00:00:00Z');
    const createdAt = new Date('2026-08-26T00:00:00Z');
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'invite-1',
          photographer_id: 'photog-1',
          email: 'client@example.com',
          client_name: 'Jane Client',
          token: 'a'.repeat(64),
          status: InviteStatus.pending,
          expires_at: expiresAt,
          accepted_at: null,
          created_at: createdAt,
        },
      ],
    });

    const result = await getInviteById('invite-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['invite-1']);
    expect(result).toEqual({
      id: 'invite-1',
      photographerId: 'photog-1',
      email: 'client@example.com',
      clientName: 'Jane Client',
      token: 'a'.repeat(64),
      status: InviteStatus.pending,
      expiresAt,
      acceptedAt: null,
      createdAt,
    });
  });

  it('returns null when no invite matches the id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getInviteById('missing-id');

    expect(result).toBeNull();
  });
});

describe('refreshInviteToken', () => {
  it('updates token, expires_at, and forces status back to pending', async () => {
    const newExpiresAt = new Date('2026-10-25T00:00:00Z');
    const createdAt = new Date('2026-08-01T00:00:00Z');
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'invite-1',
          photographer_id: 'photog-1',
          email: 'client@example.com',
          client_name: 'Jane Client',
          token: 'b'.repeat(64),
          status: InviteStatus.pending,
          expires_at: newExpiresAt,
          accepted_at: null,
          created_at: createdAt,
        },
      ],
    });

    const result = await refreshInviteToken('invite-1', { token: 'b'.repeat(64), expiresAt: newExpiresAt });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE invites'), [
      'invite-1',
      'b'.repeat(64),
      newExpiresAt,
    ]);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'pending'");
    expect(result?.token).toBe('b'.repeat(64));
    expect(result?.expiresAt).toEqual(newExpiresAt);
    expect(result?.status).toBe(InviteStatus.pending);
  });

  it('returns null when no invite matches the id (RETURNING produces no rows)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await refreshInviteToken('missing-id', {
      token: 'b'.repeat(64),
      expiresAt: new Date('2026-10-25T00:00:00Z'),
    });

    expect(result).toBeNull();
  });
});

describe('deleteInviteById', () => {
  it('deletes the invite row with the given id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deleteInviteById('invite-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM invites'), ['invite-1']);
  });
});

describe('getPendingInvitesByPhotographerId', () => {
  it('filters by photographer_id and status = pending, and maps every row', async () => {
    const row = {
      id: 'invite-1',
      photographer_id: 'photog-1',
      email: 'client@example.com',
      client_name: 'Jane Client',
      token: 'a'.repeat(64),
      status: InviteStatus.pending,
      expires_at: new Date('2026-09-25T00:00:00Z'),
      accepted_at: null,
      created_at: new Date('2026-08-01T00:00:00Z'),
    };
    mockQuery.mockResolvedValue({ rows: [row] });

    const result = await getPendingInvitesByPhotographerId('photog-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), ['photog-1']);
    expect(result).toEqual([
      {
        id: 'invite-1',
        photographerId: 'photog-1',
        email: 'client@example.com',
        clientName: 'Jane Client',
        token: 'a'.repeat(64),
        status: InviteStatus.pending,
        expiresAt: row.expires_at,
        acceptedAt: null,
        createdAt: row.created_at,
      },
    ]);
  });

  it('returns an empty array when the photographer has no pending invites', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getPendingInvitesByPhotographerId('photog-1');

    expect(result).toEqual([]);
  });
});

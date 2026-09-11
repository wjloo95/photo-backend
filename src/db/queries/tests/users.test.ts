jest.mock('../../../config/database', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const mockConnect = jest.fn(() => Promise.resolve(mockClient));
  (mockConnect as unknown as { __mockClient: typeof mockClient }).__mockClient = mockClient;
  return {
    pool: { connect: mockConnect, query: jest.fn() },
  };
});

import {
  AcceptInviteInput,
  insertClientFromInvite,
  insertUserFromWebhook,
  InsertUserFromWebhookInput,
  updateUserById,
} from '../users';
import { InviteStatus, User, UserRole } from '../../../types';
import { pool } from '../../../config/database';

const mockConnect = pool.connect as jest.Mock;
const mockQuery = pool.query as jest.Mock;
const mockClient = (mockConnect as unknown as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
}).__mockClient;

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockImplementation(() => Promise.resolve(mockClient));
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-27T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

const clientInput: InsertUserFromWebhookInput = {
  email: 'client@example.com',
  name: 'Jane Client',
  role: UserRole.client,
  providerId: 'auth0|client-1',
};

const photographerInput: InsertUserFromWebhookInput = {
  email: 'photographer@example.com',
  name: 'Alex Photographer',
  role: UserRole.photographer,
  providerId: 'auth0|photographer-1',
};

const createdUser: User = {
  id: 'user-1',
  email: clientInput.email,
  name: clientInput.name,
  role: UserRole.client,
  providerId: clientInput.providerId,
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('insertUserFromWebhook — client signup', () => {
  it('inserts a users row inside BEGIN/COMMIT and returns it', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [createdUser] }) // INSERT INTO users
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertUserFromWebhook(clientInput);

    expect(result).toEqual(createdUser);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO users'),
      [clientInput.email, clientInput.name, clientInput.role, clientInput.providerId],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(3, 'COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('does not insert into photographers for a client signup', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [createdUser] })
      .mockResolvedValueOnce(undefined);

    await insertUserFromWebhook(clientInput);

    expect(mockClient.query).toHaveBeenCalledTimes(3);
    expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('photographers'))).toBe(false);
  });

  it('releases the client back to the pool on success', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [createdUser] })
      .mockResolvedValueOnce(undefined);

    await insertUserFromWebhook(clientInput);

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('insertUserFromWebhook — photographer signup', () => {
  const createdPhotographerUser: User = { ...createdUser, id: 'user-2', role: UserRole.photographer };

  it('inserts a users row and a photographers row atomically, in the same transaction', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [createdPhotographerUser] }) // INSERT INTO users
      .mockResolvedValueOnce(undefined) // INSERT INTO photographers
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertUserFromWebhook(photographerInput);

    expect(result).toEqual(createdPhotographerUser);
    expect(mockClient.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO photographers'),
      [createdPhotographerUser.id],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(4, 'COMMIT');
  });
});

describe('insertUserFromWebhook — failure handling', () => {
  it('rolls back, rethrows, and releases the client when the users insert fails', async () => {
    const dbError = new Error('duplicate key value violates unique constraint');
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(dbError) // INSERT INTO users
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertUserFromWebhook(clientInput)).rejects.toThrow(dbError);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, rethrows, and releases the client when the photographers insert fails', async () => {
    const dbError = new Error('insert or update on table "photographers" violates foreign key constraint');
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [createdUser] }) // INSERT INTO users
      .mockRejectedValueOnce(dbError) // INSERT INTO photographers
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertUserFromWebhook(photographerInput)).rejects.toThrow(dbError);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

const acceptInviteInput: AcceptInviteInput = {
  email: 'invited-client@example.com',
  name: 'Jane Client',
  providerId: 'auth0|client-5',
  inviteToken: 'a'.repeat(64),
};

// Raw row shape as Postgres actually returns it (snake_case) — this is what
// SELECT * FROM invites ... FOR UPDATE resolves to before toInvite() maps it.
const validInviteRow = {
  id: 'invite-1',
  photographer_id: 'photog-1',
  email: acceptInviteInput.email,
  client_name: acceptInviteInput.name,
  token: acceptInviteInput.inviteToken,
  status: InviteStatus.pending,
  expires_at: new Date('2026-09-25T00:00:00Z'), // after the frozen clock (2026-08-27)
  accepted_at: null,
  created_at: new Date('2026-08-01T00:00:00Z'),
};

const createdClientUser: User = {
  id: 'user-5',
  email: acceptInviteInput.email,
  name: acceptInviteInput.name,
  role: UserRole.client,
  providerId: acceptInviteInput.providerId,
  joinedAt: new Date('2026-08-27T00:00:00Z'),
};

describe('insertClientFromInvite — happy path', () => {
  it('locks the invite row, creates the user/client/conversation, marks the invite accepted, and commits', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [validInviteRow] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [createdClientUser] }) // INSERT INTO users
      .mockResolvedValueOnce(undefined) // INSERT INTO clients
      .mockResolvedValueOnce(undefined) // INSERT INTO conversations
      .mockResolvedValueOnce(undefined) // UPDATE invites
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertClientFromInvite(acceptInviteInput);

    expect(result).toEqual(createdClientUser);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FOR UPDATE'),
      [acceptInviteInput.inviteToken],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO users'),
      [acceptInviteInput.email, acceptInviteInput.name, UserRole.client, acceptInviteInput.providerId],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO clients'),
      [createdClientUser.id, validInviteRow.photographer_id],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('INSERT INTO conversations'),
      [validInviteRow.photographer_id, createdClientUser.id],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("status = 'accepted'"),
      [validInviteRow.id],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(7, 'COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('insertClientFromInvite — invalid invite rejection', () => {
  it.each([
    ['no invite matches the token', [] as (typeof validInviteRow)[]],
    ['the invite is already accepted', [{ ...validInviteRow, status: InviteStatus.accepted }]],
    ['the invite is already expired', [{ ...validInviteRow, status: InviteStatus.expired }]],
    [
      'the invite is still pending but past its expiry',
      [{ ...validInviteRow, expires_at: new Date('2026-08-01T00:00:00Z') }],
    ],
  ])('rejects with a 410 AppError, rolls back, and never inserts anything when %s', async (_label, rows) => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertClientFromInvite(acceptInviteInput)).rejects.toMatchObject({ status: 410 });

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('insertClientFromInvite — downstream failure handling', () => {
  it('rolls back, rethrows, and releases the client when the clients insert fails', async () => {
    const dbError = new Error('insert or update on table "clients" violates foreign key constraint');
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [validInviteRow] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [createdClientUser] }) // INSERT INTO users
      .mockRejectedValueOnce(dbError) // INSERT INTO clients
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertClientFromInvite(acceptInviteInput)).rejects.toThrow(dbError);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, rethrows, and releases the client when the invite update fails', async () => {
    const dbError = new Error('connection lost');
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [validInviteRow] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [createdClientUser] }) // INSERT INTO users
      .mockResolvedValueOnce(undefined) // INSERT INTO clients
      .mockResolvedValueOnce(undefined) // INSERT INTO conversations
      .mockRejectedValueOnce(dbError) // UPDATE invites
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertClientFromInvite(acceptInviteInput)).rejects.toThrow(dbError);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('updateUserById', () => {
  it('passes fields through as COALESCE params in userId, email, name order', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...createdUser, email: 'new@example.com', name: 'New Name' }],
    });

    const result = await updateUserById('user-1', { email: 'new@example.com', name: 'New Name' });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), [
      'user-1',
      'new@example.com',
      'New Name',
    ]);
    expect(result?.email).toBe('new@example.com');
    expect(result?.name).toBe('New Name');
  });

  it('passes undefined for omitted fields, relying on COALESCE to keep existing values', async () => {
    mockQuery.mockResolvedValue({ rows: [createdUser] });

    await updateUserById('user-1', { name: 'New Name' });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['user-1', undefined, 'New Name']);
  });

  it('returns null when the row does not exist (RETURNING produces no rows)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await updateUserById('missing-id', { name: 'New Name' });

    expect(result).toBeNull();
  });
});

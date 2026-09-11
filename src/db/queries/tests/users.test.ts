import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insertUserFromWebhook, InsertUserFromWebhookInput } from '../users';
import { User, UserRole } from '../../../types';
import { AppError } from '../../../types/AppError';

const { mockClient, mockConnect } = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return { mockClient, mockConnect: vi.fn(() => Promise.resolve(mockClient)) };
});

vi.mock('../../../config/database', () => ({
  pool: { connect: mockConnect },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockImplementation(() => Promise.resolve(mockClient));
});

const clientInput: InsertUserFromWebhookInput = {
  email: 'client@example.com',
  role: UserRole.client,
  providerId: 'auth0|client-1',
};

const photographerInput: InsertUserFromWebhookInput = {
  email: 'photographer@example.com',
  role: UserRole.photographer,
  providerId: 'auth0|photographer-1',
  businessName: 'Acme Photography',
};

const createdUser: User = {
  id: 'user-1',
  email: clientInput.email,
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
      [clientInput.email, clientInput.role, clientInput.providerId],
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
      [createdPhotographerUser.id, photographerInput.businessName],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(4, 'COMMIT');
  });

  it('rejects with a 400 AppError and never opens a connection when businessName is missing', async () => {
    const invalidInput = { ...photographerInput, businessName: undefined };

    await expect(insertUserFromWebhook(invalidInput)).rejects.toMatchObject({
      status: 400,
    });
    await expect(insertUserFromWebhook(invalidInput)).rejects.toBeInstanceOf(AppError);
    expect(mockConnect).not.toHaveBeenCalled();
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

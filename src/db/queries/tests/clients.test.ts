jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import { getPhotographerClientsByUserId, getClientByUserId } from '../clients';
import { pool } from '../../../config/database';

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getPhotographerClientsByUserId', () => {
  it('joins clients to users and maps rows to ClientWithUser', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { user_id: 'client-1', name: 'Jane Client', email: 'jane@example.com' },
        { user_id: 'client-2', name: 'John Client', email: 'john@example.com' },
      ],
    });

    const result = await getPhotographerClientsByUserId('photog-1');

    expect(result).toEqual([
      { userId: 'client-1', name: 'Jane Client', email: 'jane@example.com' },
      { userId: 'client-2', name: 'John Client', email: 'john@example.com' },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('JOIN users'), ['photog-1']);
  });

  it('returns an empty array, not null, when the photographer has no clients', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getPhotographerClientsByUserId('photog-1');

    expect(result).toEqual([]);
  });
});

describe('getClientByUserId', () => {
  it('maps a found row to the Client shape', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ user_id: 'client-1', photographer_id: 'photog-1' }],
    });

    const result = await getClientByUserId('client-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM clients'), ['client-1']);
    expect(result).toEqual({ userId: 'client-1', photographerId: 'photog-1' });
  });

  it('returns null when no client matches the id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getClientByUserId('missing-id');

    expect(result).toBeNull();
  });
});

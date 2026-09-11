import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPhotographerClientsByUserId } from '../clients';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../../../config/database', () => ({
  pool: { query: mockQuery },
}));

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

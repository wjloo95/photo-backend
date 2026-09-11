jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import { getPhotographerByUserId, updatePhotographerByUserId } from '../photographers';
import { pool } from '../../../config/database';
import { VisibilityType } from '../../../types';

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getPhotographerByUserId', () => {
  it('maps a found row from snake_case to the Photographer shape', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          user_id: 'photog-1',
          bio: 'Wedding and portrait photographer',
          profile_photo_url: 'https://cdn.example.com/photog-1.jpg',
          instagram_handle: '@photog1',
          visibility: VisibilityType.public,
        },
      ],
    });

    const result = await getPhotographerByUserId('photog-1');

    expect(result).toEqual({
      userId: 'photog-1',
      bio: 'Wedding and portrait photographer',
      profilePhotoUrl: 'https://cdn.example.com/photog-1.jpg',
      instagramHandle: '@photog1',
      visibility: VisibilityType.public,
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM photographers'), ['photog-1']);
  });

  it('returns null when no row is found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getPhotographerByUserId('missing-id');

    expect(result).toBeNull();
  });
});

describe('updatePhotographerByUserId', () => {
  it('passes fields through as COALESCE params in userId, bio, instagramHandle, profilePhotoUrl order', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          user_id: 'photog-1',
          bio: 'Updated bio',
          profile_photo_url: 'https://cdn.example.com/new.jpg',
          instagram_handle: '@newhandle',
          visibility: VisibilityType.private,
        },
      ],
    });

    const result = await updatePhotographerByUserId('photog-1', {
      bio: 'Updated bio',
      instagramHandle: '@newhandle',
      profilePhotoUrl: 'https://cdn.example.com/new.jpg',
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE photographers'), [
      'photog-1',
      'Updated bio',
      '@newhandle',
      'https://cdn.example.com/new.jpg',
    ]);
    expect(result?.bio).toBe('Updated bio');
  });

  it('passes undefined for omitted fields, relying on COALESCE to keep existing values', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          user_id: 'photog-1',
          bio: 'Unchanged bio',
          profile_photo_url: 'https://cdn.example.com/existing.jpg',
          instagram_handle: '@existing',
          visibility: VisibilityType.private,
        },
      ],
    });

    await updatePhotographerByUserId('photog-1', { bio: 'ignored-check-params-instead' });

    // last two SQL params (instagramHandle, profilePhotoUrl) should be undefined — omitted
    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBeUndefined();
    expect(params[3]).toBeUndefined();
  });

  it('returns null when the row does not exist (RETURNING produces no rows)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await updatePhotographerByUserId('missing-id', { bio: 'x' });

    expect(result).toBeNull();
  });
});

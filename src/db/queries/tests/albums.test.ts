import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPhotographerAlbumsByUserId } from '../albums';
import { AlbumType } from '../../../types';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../../../config/database', () => ({
  pool: { query: mockQuery },
}));

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getPhotographerAlbumsByUserId', () => {
  it('maps every row column, including the warned_*_at fields, to the Album shape', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'album-1',
          photographer_id: 'photog-1',
          client_id: 'client-1',
          thumbnail_photo_id: 'photo-1',
          type: AlbumType.shoot,
          shoot_date: new Date('2026-01-01'),
          access_expires_at: new Date('2029-01-01'),
          warned_90_at: null,
          warned_30_at: null,
          warned_7_at: null,
          created_at: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });

    const result = await getPhotographerAlbumsByUserId('photog-1');

    expect(result).toEqual([
      {
        id: 'album-1',
        photographerId: 'photog-1',
        clientId: 'client-1',
        thumbnailPhotoId: 'photo-1',
        type: AlbumType.shoot,
        shootDate: new Date('2026-01-01'),
        accessExpiresAt: new Date('2029-01-01'),
        warned90At: null,
        warned30At: null,
        warned7At: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
  });

  it('returns an empty array, not null, when the photographer has no albums', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getPhotographerAlbumsByUserId('photog-1');

    expect(result).toEqual([]);
  });
});

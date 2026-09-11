import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPhotographerByUserId,
  updatePhotographerByUserId,
  getPhotographerClientsByUserId,
  getPhotographerAlbumsByUserId,
} from '../photographers';
import { AlbumType, VisibilityType } from '../../../types';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../../../config/database', () => ({
  pool: { query: mockQuery },
}));

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

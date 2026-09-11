jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import {
  getPhotographerAlbumsByUserId,
  insertAlbum,
  getAlbumById,
  updateAlbumById,
  deleteAlbumById,
} from '../albums';
import { pool } from '../../../config/database';
import { AlbumType } from '../../../types';

const mockQuery = pool.query as jest.Mock;

const fullAlbumRow = {
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
};

const fullAlbum = {
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
};

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

describe('insertAlbum', () => {
  it('inserts with the given fields and maps the returned row to the Album shape', async () => {
    mockQuery.mockResolvedValue({ rows: [fullAlbumRow] });

    const result = await insertAlbum({
      photographerId: 'photog-1',
      clientId: 'client-1',
      type: AlbumType.shoot,
      shootDate: new Date('2026-01-01'),
      accessExpiresAt: new Date('2029-01-01'),
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO albums'), [
      'photog-1',
      'client-1',
      AlbumType.shoot,
      new Date('2026-01-01'),
      new Date('2029-01-01'),
    ]);
    expect(result).toEqual(fullAlbum);
  });

  it('passes a null clientId through for portfolio albums', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fullAlbumRow, client_id: null, type: AlbumType.portfolio }],
    });

    await insertAlbum({
      photographerId: 'photog-1',
      clientId: null,
      type: AlbumType.portfolio,
      shootDate: new Date('2026-01-01'),
      accessExpiresAt: new Date('2029-01-01'),
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBeNull();
  });
});

describe('getAlbumById', () => {
  it('maps a found row to the Album shape', async () => {
    mockQuery.mockResolvedValue({ rows: [fullAlbumRow] });

    const result = await getAlbumById('album-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM albums'), ['album-1']);
    expect(result).toEqual(fullAlbum);
  });

  it('returns null when no album matches the id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getAlbumById('missing-id');

    expect(result).toBeNull();
  });
});

describe('updateAlbumById', () => {
  it('sets thumbnail_photo_id via COALESCE and returns the updated album', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...fullAlbumRow, thumbnail_photo_id: 'photo-2' }] });

    const result = await updateAlbumById('album-1', { thumbnailPhotoId: 'photo-2' });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE albums'), [
      'album-1',
      'photo-2',
    ]);
    expect(result?.thumbnailPhotoId).toBe('photo-2');
  });

  it('returns null when the row does not exist (RETURNING produces no rows)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await updateAlbumById('missing-id', { thumbnailPhotoId: 'photo-2' });

    expect(result).toBeNull();
  });
});

describe('deleteAlbumById', () => {
  it('deletes the album row with the given id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deleteAlbumById('album-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM albums'), ['album-1']);
  });
});

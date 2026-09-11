import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  insertPhotosForAlbum,
  toPhoto,
  PhotoRow,
  getPhotoById,
  getPhotosForAlbum,
  getAlbumOwnersForPhoto,
  addPhotoToAlbum,
  removePhotoFromAlbum,
  deletePhotosFromAlbum,
  deletePhotoById,
} from '../photos';
import { PhotoStatus } from '../../../types';

const { mockClient, mockConnect, mockQuery } = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    mockClient,
    mockConnect: vi.fn(() => Promise.resolve(mockClient)),
    mockQuery: vi.fn(),
  };
});

vi.mock('../../../config/database', () => ({
  pool: { connect: mockConnect, query: mockQuery },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockImplementation(() => Promise.resolve(mockClient));
});

const albumId = 'album-1';

function photoRow(id: string): PhotoRow {
  return {
    id,
    base_path: '',
    status: PhotoStatus.processing,
    width: null,
    height: null,
    uploaded_at: new Date('2026-08-27T00:00:00Z'),
  };
}

describe('insertPhotosForAlbum — happy path', () => {
  it('inserts `count` photos rows, one photo_albums row per photo, and commits', async () => {
    const rows = [photoRow('photo-1'), photoRow('photo-2'), photoRow('photo-3')];
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows }) // INSERT INTO photos ... generate_series
      .mockResolvedValueOnce(undefined) // INSERT INTO photo_albums ... UNNEST
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertPhotosForAlbum(albumId, 3);

    expect(result).toEqual(rows.map(toPhoto));
  });

  it('drives the photos insert off `count`, not per-row params', async () => {
    const rows = [photoRow('photo-1')];
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await insertPhotosForAlbum(albumId, 1);

    expect(mockClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('generate_series'),
      [1],
    );
  });

  it('links every created photo to the album via a single UNNEST insert', async () => {
    const rows = [photoRow('photo-1'), photoRow('photo-2')];
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await insertPhotosForAlbum(albumId, 2);

    expect(mockClient.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO photo_albums'),
      [['photo-1', 'photo-2'], albumId],
    );
  });

  it('runs BEGIN, both inserts, and COMMIT on the same checked-out client, then releases it', async () => {
    const rows = [photoRow('photo-1')];
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await insertPhotosForAlbum(albumId, 1);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClient.query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    // Guards against regressing to pool.query, which would run outside the transaction.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns Photo objects (camelCase), not raw PhotoRow rows', async () => {
    const rows = [photoRow('photo-1')];
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const [result] = await insertPhotosForAlbum(albumId, 1);

    expect(result).toEqual({
      id: 'photo-1',
      basePath: '',
      status: PhotoStatus.processing,
      width: null,
      height: null,
      uploadedAt: rows[0].uploaded_at,
    });
    expect(result).not.toHaveProperty('base_path');
  });

  it('preserves row order in the returned array (route zips this against req.files by index)', async () => {
    const rows = [photoRow('photo-1'), photoRow('photo-2'), photoRow('photo-3')];
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const result = await insertPhotosForAlbum(albumId, 3);

    expect(result.map((p) => p.id)).toEqual(['photo-1', 'photo-2', 'photo-3']);
  });
});

describe('insertPhotosForAlbum — edge cases', () => {
  it('returns an empty array and skips the photo_albums insert of ids when count is 0', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT INTO photos — 0 rows
      .mockResolvedValueOnce(undefined) // INSERT INTO photo_albums — empty UNNEST
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertPhotosForAlbum(albumId, 0);

    expect(result).toEqual([]);
    expect(mockClient.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO photo_albums'),
      [[], albumId],
    );
  });
});

describe('insertPhotosForAlbum — failure handling', () => {
  it('rolls back, rethrows, and releases the client when the photos insert fails', async () => {
    const dbError = new Error('connection lost');
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(dbError) // INSERT INTO photos
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertPhotosForAlbum(albumId, 3)).rejects.toThrow(dbError);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('photo_albums'))).toBe(
      false,
    );
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, rethrows, and releases the client when the photo_albums insert fails', async () => {
    const dbError = new Error('insert or update on table "photo_albums" violates foreign key constraint');
    const rows = [photoRow('photo-1')];
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows }) // INSERT INTO photos
      .mockRejectedValueOnce(dbError) // INSERT INTO photo_albums
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(insertPhotosForAlbum(albumId, 1)).rejects.toThrow(dbError);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client even when ROLLBACK itself is never reached due to a connect failure', async () => {
    mockConnect.mockImplementationOnce(() => Promise.reject(new Error('pool exhausted')));

    await expect(insertPhotosForAlbum(albumId, 1)).rejects.toThrow('pool exhausted');

    expect(mockClient.release).not.toHaveBeenCalled();
  });
});

describe('toPhoto', () => {
  it('maps snake_case DB columns to camelCase Photo fields', () => {
    const row = photoRow('photo-9');

    expect(toPhoto(row)).toEqual({
      id: 'photo-9',
      basePath: row.base_path,
      status: row.status,
      width: row.width,
      height: row.height,
      uploadedAt: row.uploaded_at,
    });
  });
});

describe('getPhotoById', () => {
  it('maps a found row to the Photo shape', async () => {
    const row = photoRow('photo-1');
    mockQuery.mockResolvedValue({ rows: [row] });

    const result = await getPhotoById('photo-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM photos'), ['photo-1']);
    expect(result).toEqual(toPhoto(row));
  });

  it('returns null when no photo matches the id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getPhotoById('missing-id');

    expect(result).toBeNull();
  });
});

describe('getPhotosForAlbum', () => {
  it('queries by album id with LIMIT/OFFSET and maps every row to Photo', async () => {
    const rows = [photoRow('photo-1'), photoRow('photo-2')];
    mockQuery.mockResolvedValue({ rows });

    const result = await getPhotosForAlbum(albumId, 20, 40);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('photo_albums'), [
      albumId,
      20,
      40,
    ]);
    expect(result).toEqual(rows.map(toPhoto));
  });

  it('returns an empty array, not null, when the album has no photos on this page', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getPhotosForAlbum(albumId, 20, 0);

    expect(result).toEqual([]);
  });
});

describe('getAlbumOwnersForPhoto', () => {
  it('maps photographer_id/client_id rows to camelCase for every album the photo belongs to', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { photographer_id: 'photog-1', client_id: 'client-1' },
        { photographer_id: 'photog-1', client_id: null },
      ],
    });

    const result = await getAlbumOwnersForPhoto('photo-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('photo_albums'), ['photo-1']);
    expect(result).toEqual([
      { photographerId: 'photog-1', clientId: 'client-1' },
      { photographerId: 'photog-1', clientId: null },
    ]);
  });

  it('returns an empty array for a photo that belongs to no album', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getAlbumOwnersForPhoto('orphan-photo');

    expect(result).toEqual([]);
  });
});

describe('addPhotoToAlbum', () => {
  it('inserts a photo_albums row with photo_id and album_id in that order', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await addPhotoToAlbum(albumId, 'photo-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO photo_albums'), [
      'photo-1',
      albumId,
    ]);
  });

  it('is idempotent via ON CONFLICT DO NOTHING', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await addPhotoToAlbum(albumId, 'photo-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
      'photo-1',
      albumId,
    ]);
  });
});

describe('removePhotoFromAlbum', () => {
  it('deletes the photo_albums row for this album and photo only', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await removePhotoFromAlbum(albumId, 'photo-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM photo_albums'), [
      albumId,
      'photo-1',
    ]);
  });
});

describe('deletePhotosFromAlbum', () => {
  it('deletes every listed photo_albums row for this album via = ANY', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deletePhotosFromAlbum(albumId, ['photo-1', 'photo-2']);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ANY'), [
      albumId,
      ['photo-1', 'photo-2'],
    ]);
  });
});

describe('deletePhotoById', () => {
  it('deletes the photos row with the given id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deletePhotoById('photo-1');

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM photos'), [
      'photo-1',
    ]);
  });
});

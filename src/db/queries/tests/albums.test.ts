jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import {
  getPhotographerAlbumsByUserId,
  insertAlbum,
  getAlbumById,
  updateAlbumById,
  deleteAlbumById,
  getAlbumsNeedingWarning,
  getExpiredAlbums,
  rehydrateAlbumDates,
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

// Portfolio albums never expire: access_expires_at is NULL and the
// albums_expiry_matches_type CHECK (migration 020) keeps it that way.
describe('portfolio albums are excluded from expiry', () => {
  const portfolioRow = {
    ...fullAlbumRow,
    id: 'album-2',
    client_id: null,
    type: AlbumType.portfolio,
    access_expires_at: null,
  };

  it('maps a null access_expires_at straight through rather than coercing it', async () => {
    mockQuery.mockResolvedValue({ rows: [portfolioRow] });

    const [album] = await getPhotographerAlbumsByUserId('photog-1');

    expect(album.accessExpiresAt).toBeNull();
  });

  // Regression: `new Date(null)` is the epoch, not null — a portfolio album
  // round-tripped through the cache would come back expiring on 1970-01-01 and
  // land in the very next deletion sweep.
  it('rehydrates a cached null expiry as null, not as the epoch', () => {
    const cached = { ...fullAlbum, accessExpiresAt: null, type: AlbumType.portfolio };

    expect(rehydrateAlbumDates(cached).accessExpiresAt).toBeNull();
  });

  it('still rehydrates a real expiry date', () => {
    const cached = { ...fullAlbum, accessExpiresAt: '2029-01-01T00:00:00.000Z' as unknown as Date };

    expect(rehydrateAlbumDates(cached).accessExpiresAt).toEqual(new Date('2029-01-01'));
  });

  // No `type` predicate in either query: NULL <= x and NULL < x are both NULL
  // rather than TRUE, so the comparison itself does the excluding.
  it('filters the warning sweep on the date alone', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAlbumsNeedingWarning(90);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('access_expires_at <=');
    expect(sql).toContain('warned_90_at IS NULL');
    expect(sql).not.toContain('type');
  });

  it('filters the deletion sweep on the date alone', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getExpiredAlbums();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('access_expires_at < NOW()');
    expect(sql).not.toContain('type');
  });
});

describe('getAlbumsNeedingWarning — recipient join', () => {
  const rowWithClient = {
    ...fullAlbumRow,
    client_email: 'client@example.com',
    client_name: 'Casey Client',
  };

  it("returns the client's address alongside the album", async () => {
    mockQuery.mockResolvedValue({ rows: [rowWithClient] });

    const [album] = await getAlbumsNeedingWarning(30);

    expect(album).toMatchObject({
      id: 'album-1',
      clientEmail: 'client@example.com',
      clientName: 'Casey Client',
    });
  });

  // albums.client_id is ON DELETE SET NULL, so a shoot album can outlive its
  // client. The join has to be LEFT or the album vanishes from the sweep
  // entirely — and then it is never marked warned, and the deletion gate keeps
  // it alive forever.
  it('still returns an album whose client was deleted, with a null address', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fullAlbumRow, client_id: null, client_email: null, client_name: null }],
    });

    const [album] = await getAlbumsNeedingWarning(7);

    expect(album.clientEmail).toBeNull();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('LEFT JOIN clients');
    expect(sql).toContain('LEFT JOIN users');
  });

  // node-postgres keeps only the last of a duplicated column name, so `u.*`
  // would overwrite the album's id with the user's.
  it('aliases the user columns rather than selecting the users row whole', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAlbumsNeedingWarning(90);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('u.email AS client_email');
    expect(sql).toContain('u.name AS client_name');
    expect(sql).not.toContain('u.*');
  });
});

describe('getExpiredAlbums — deletion gate', () => {
  // Deletion is irreversible with no recovery path, so an album is only
  // deleted once its final warning step has completed. A mail outage through
  // the whole run-up leaves warned_7_at NULL, and the album waits rather than
  // being destroyed silently.
  it('only returns albums whose final warning step completed', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getExpiredAlbums();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('access_expires_at < NOW()');
    expect(sql).toContain('warned_7_at IS NOT NULL');
  });
});

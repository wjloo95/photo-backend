import { Album, AlbumType, Photo, PhotoStatus } from '../../../types';

jest.mock('../../../db/queries/albums', () => ({
  deleteAlbumById: jest.fn(),
  getAlbumsNeedingWarning: jest.fn(),
  getExpiredAlbums: jest.fn(),
  markAlbumWarned: jest.fn(),
  // Real enum values, not mocks — tests assert against these directly, same
  // convention as PhotoJobName/ExpiryJobName elsewhere in this test suite.
  WarningColumn: {
    Warned90: 'warned_90_at',
    Warned30: 'warned_30_at',
    Warned7: 'warned_7_at',
  },
}));

jest.mock('../../../db/queries/photos', () => ({
  deletePhotoById: jest.fn(),
  getAlbumOwnersForPhoto: jest.fn(),
  getAllPhotosForAlbum: jest.fn(),
}));

// expiryQueue.ts constructs a real BullMQ Queue at import time — replacing
// the whole module (we only need the ExpiryJobName enum's values) avoids
// that entirely, rather than mocking bullmq itself.
jest.mock('../../queues/expiryQueue', () => ({
  ExpiryJobName: {
    Warn90Days: 'warn-90-days',
    Warn30Days: 'warn-30-days',
    Warn7Days: 'warn-7-days',
    DeleteExpired: 'delete-expired',
  },
}));

jest.mock('cloudinary', () => ({
  v2: {
    uploader: { destroy: jest.fn() },
  },
}));

// processEachSafely itself is NOT mocked — it's already covered by its own
// test file, and using the real implementation here confirms expiryProcessor
// actually composes correctly with it (isolation, aggregate throw, and the
// nested-call ordering the DeleteExpired branch depends on).
import { ExpiryJobName } from '../../queues/expiryQueue';
import {
  WarningColumn,
  deleteAlbumById,
  getAlbumsNeedingWarning,
  getExpiredAlbums,
  markAlbumWarned,
} from '../../../db/queries/albums';
import {
  deletePhotoById,
  getAlbumOwnersForPhoto,
  getAllPhotosForAlbum,
} from '../../../db/queries/photos';
import { v2 as cloudinary } from 'cloudinary';
import { processExpiryJob } from '../expiryProcessor';

const deleteAlbumByIdMock = deleteAlbumById as jest.Mock;
const getAlbumsNeedingWarningMock = getAlbumsNeedingWarning as jest.Mock;
const getExpiredAlbumsMock = getExpiredAlbums as jest.Mock;
const markAlbumWarnedMock = markAlbumWarned as jest.Mock;
const deletePhotoByIdMock = deletePhotoById as jest.Mock;
const getAlbumOwnersForPhotoMock = getAlbumOwnersForPhoto as jest.Mock;
const getAllPhotosForAlbumMock = getAllPhotosForAlbum as jest.Mock;
const destroyMock = cloudinary.uploader.destroy as jest.Mock;

function album(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-1',
    photographerId: 'photog-1',
    clientId: 'client-1',
    thumbnailPhotoId: null,
    type: AlbumType.shoot,
    shootDate: new Date('2020-01-01'),
    accessExpiresAt: new Date('2023-01-01'),
    warned90At: null,
    warned30At: null,
    warned7At: null,
    createdAt: new Date('2020-01-01'),
    ...overrides,
  };
}

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    basePath: 'cloudinary/key-1',
    status: PhotoStatus.ready,
    width: 800,
    height: 600,
    uploadedAt: new Date('2020-01-01'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe.each([
  { jobName: ExpiryJobName.Warn90Days, days: 90, column: WarningColumn.Warned90 },
  { jobName: ExpiryJobName.Warn30Days, days: 30, column: WarningColumn.Warned30 },
  { jobName: ExpiryJobName.Warn7Days, days: 7, column: WarningColumn.Warned7 },
])('processExpiryJob — $jobName', ({ jobName, days, column }) => {
  it(`queries albums needing a ${days}-day warning and marks each one warned`, async () => {
    getAlbumsNeedingWarningMock.mockResolvedValue([album({ id: 'album-1' }), album({ id: 'album-2' })]);
    markAlbumWarnedMock.mockResolvedValue(undefined);

    await processExpiryJob(jobName);

    expect(getAlbumsNeedingWarningMock).toHaveBeenCalledWith(days);
    expect(markAlbumWarnedMock).toHaveBeenCalledWith('album-1', column);
    expect(markAlbumWarnedMock).toHaveBeenCalledWith('album-2', column);
  });

  it('resolves without touching markAlbumWarned when no albums need a warning', async () => {
    getAlbumsNeedingWarningMock.mockResolvedValue([]);

    await expect(processExpiryJob(jobName)).resolves.toBeUndefined();
    expect(markAlbumWarnedMock).not.toHaveBeenCalled();
  });

  it('propagates a failure from markAlbumWarned so the job fails and retries', async () => {
    getAlbumsNeedingWarningMock.mockResolvedValue([album()]);
    markAlbumWarnedMock.mockRejectedValue(new Error('connection lost'));

    await expect(processExpiryJob(jobName)).rejects.toThrow();
  });
});

describe('processExpiryJob — delete-expired', () => {
  it('resolves without deleting anything when there are no expired albums', async () => {
    getExpiredAlbumsMock.mockResolvedValue([]);

    await expect(processExpiryJob(ExpiryJobName.DeleteExpired)).resolves.toBeUndefined();
    expect(deleteAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('destroys the Cloudinary asset, deletes the photo row, and deletes the album when the photo has no other album', async () => {
    getExpiredAlbumsMock.mockResolvedValue([album({ id: 'album-1' })]);
    getAllPhotosForAlbumMock.mockResolvedValue([photo({ id: 'photo-1', basePath: 'key-1' })]);
    getAlbumOwnersForPhotoMock.mockResolvedValue([{ photographerId: 'photog-1', clientId: 'client-1' }]);
    deletePhotoByIdMock.mockResolvedValue(undefined);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    await processExpiryJob(ExpiryJobName.DeleteExpired);

    expect(destroyMock).toHaveBeenCalledWith('key-1');
    expect(deletePhotoByIdMock).toHaveBeenCalledWith('photo-1');
    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-1');
  });

  it('does NOT destroy the Cloudinary asset or delete the photo row when the photo still belongs to another album', async () => {
    getExpiredAlbumsMock.mockResolvedValue([album({ id: 'album-1' })]);
    getAllPhotosForAlbumMock.mockResolvedValue([photo({ id: 'photo-1', basePath: 'key-1' })]);
    // Two owners: the expiring album plus a still-active portfolio album
    // this photo was also placed in via addAlbumPhoto.
    getAlbumOwnersForPhotoMock.mockResolvedValue([
      { photographerId: 'photog-1', clientId: 'client-1' },
      { photographerId: 'photog-1', clientId: null },
    ]);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    await processExpiryJob(ExpiryJobName.DeleteExpired);

    expect(destroyMock).not.toHaveBeenCalled();
    expect(deletePhotoByIdMock).not.toHaveBeenCalled();
    // The album itself is still deleted regardless — only the shared
    // photo's cleanup is what's protected.
    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-1');
  });

  it('deletes an album with no photos', async () => {
    getExpiredAlbumsMock.mockResolvedValue([album({ id: 'album-1' })]);
    getAllPhotosForAlbumMock.mockResolvedValue([]);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    await processExpiryJob(ExpiryJobName.DeleteExpired);

    expect(destroyMock).not.toHaveBeenCalled();
    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-1');
  });

  it('processes every expired album independently', async () => {
    getExpiredAlbumsMock.mockResolvedValue([album({ id: 'album-1' }), album({ id: 'album-2' })]);
    getAllPhotosForAlbumMock.mockImplementation((albumId: string) =>
      Promise.resolve([photo({ id: `photo-of-${albumId}`, basePath: `key-${albumId}` })]),
    );
    getAlbumOwnersForPhotoMock.mockResolvedValue([{ photographerId: 'photog-1', clientId: 'client-1' }]);
    deletePhotoByIdMock.mockResolvedValue(undefined);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    await processExpiryJob(ExpiryJobName.DeleteExpired);

    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-1');
    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-2');
    expect(destroyMock).toHaveBeenCalledWith('key-album-1');
    expect(destroyMock).toHaveBeenCalledWith('key-album-2');
  });

  it('does not delete the album when one of its photos fails to process', async () => {
    getExpiredAlbumsMock.mockResolvedValue([album({ id: 'album-1' })]);
    getAllPhotosForAlbumMock.mockResolvedValue([photo({ id: 'photo-1', basePath: 'key-1' })]);
    getAlbumOwnersForPhotoMock.mockResolvedValue([{ photographerId: 'photog-1', clientId: 'client-1' }]);
    destroyMock.mockRejectedValue(new Error('Cloudinary unavailable'));

    await expect(processExpiryJob(ExpiryJobName.DeleteExpired)).rejects.toThrow();

    expect(deleteAlbumByIdMock).not.toHaveBeenCalled();
  });

  it('still processes the other expired albums when one album fails entirely', async () => {
    getExpiredAlbumsMock.mockResolvedValue([album({ id: 'album-1' }), album({ id: 'album-2' })]);
    getAllPhotosForAlbumMock.mockImplementation((albumId: string) => {
      if (albumId === 'album-1') {
        return Promise.reject(new Error('DB connection lost'));
      }
      return Promise.resolve([photo({ id: 'photo-2', basePath: 'key-2' })]);
    });
    getAlbumOwnersForPhotoMock.mockResolvedValue([{ photographerId: 'photog-1', clientId: 'client-1' }]);
    deletePhotoByIdMock.mockResolvedValue(undefined);
    deleteAlbumByIdMock.mockResolvedValue(undefined);

    await expect(processExpiryJob(ExpiryJobName.DeleteExpired)).rejects.toThrow();

    expect(deleteAlbumByIdMock).not.toHaveBeenCalledWith('album-1');
    expect(deleteAlbumByIdMock).toHaveBeenCalledWith('album-2');
  });
});

describe('processExpiryJob — unrecognized job name', () => {
  it('throws, naming the unrecognized job', async () => {
    await expect(processExpiryJob('some-bogus-job')).rejects.toThrow(
      'Unknown job name: some-bogus-job',
    );
  });
});

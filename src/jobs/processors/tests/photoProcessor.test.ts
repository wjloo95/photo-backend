import path from 'node:path';
import { Photo, PhotoStatus } from '../../../types';

jest.mock('../../../db/queries/photos', () => ({
  getPhotoById: jest.fn(),
  markPhotoReady: jest.fn(),
}));

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { upload: jest.fn() },
  },
}));

jest.mock('node:fs/promises', () => {
  const unlinkMock = jest.fn();
  return { default: { unlink: unlinkMock }, unlink: unlinkMock };
});

jest.mock('../../../config/env', () => ({
  env: {
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
  },
}));

const UPLOAD_TMP_DIR = '/tmp/sys-photo-uploads-test';
jest.mock('../../../config/uploads', () => ({ UPLOAD_TMP_DIR: '/tmp/sys-photo-uploads-test' }));

// Importing this module runs cloudinary.config(...) as a side effect, once,
// here — before any beforeEach has a chance to clear cloudinaryConfigMock.
import { processPhotoBatch } from '../photoProcessor';
import { getPhotoById, markPhotoReady } from '../../../db/queries/photos';
import { v2 as cloudinary } from 'cloudinary';
import { unlink } from 'node:fs/promises';

const getPhotoByIdMock = getPhotoById as jest.Mock;
const markPhotoReadyMock = markPhotoReady as jest.Mock;
const cloudinaryConfigMock = cloudinary.config as jest.Mock;
const uploadMock = cloudinary.uploader.upload as jest.Mock;
const unlinkMock = unlink as jest.Mock;

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    basePath: '',
    status: PhotoStatus.processing,
    width: null,
    height: null,
    uploadedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  getPhotoByIdMock.mockReset();
  uploadMock.mockReset();
  markPhotoReadyMock.mockReset();
  unlinkMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // Deliberately not touching cloudinaryConfigMock — it's only ever called
  // once, at module import above, and clearing it here would make the
  // "configures cloudinary" test below unable to see that call.
});

describe('processPhotoBatch — module setup', () => {
  it('configures cloudinary exactly once, from env, at import time', () => {
    expect(cloudinaryConfigMock).toHaveBeenCalledTimes(1);
    expect(cloudinaryConfigMock).toHaveBeenCalledWith({
      cloud_name: 'test-cloud',
      api_key: 'test-key',
      api_secret: 'test-secret',
    });
  });
});

describe('processPhotoBatch — happy path', () => {
  it('uploads each photo to Cloudinary under its own id, marks it ready, and deletes the temp file', async () => {
    getPhotoByIdMock.mockResolvedValue(photo({ status: PhotoStatus.processing }));
    uploadMock.mockResolvedValue({ public_id: 'photo-1', width: 800, height: 600 });
    markPhotoReadyMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await processPhotoBatch({ photoIds: ['photo-1'], albumId: 'album-1' });

    expect(uploadMock).toHaveBeenCalledWith(path.join(UPLOAD_TMP_DIR, 'photo-1'), {
      public_id: 'photo-1',
    });
    expect(markPhotoReadyMock).toHaveBeenCalledWith('photo-1', {
      basePath: 'photo-1',
      width: 800,
      height: 600,
    });
    expect(unlinkMock).toHaveBeenCalledWith(path.join(UPLOAD_TMP_DIR, 'photo-1'));
  });

  it('processes every photo id in the batch independently', async () => {
    getPhotoByIdMock.mockImplementation((id: string) =>
      Promise.resolve(photo({ id, status: PhotoStatus.processing })),
    );
    uploadMock.mockImplementation((_filePath: string, opts: { public_id: string }) =>
      Promise.resolve({ public_id: opts.public_id, width: 100, height: 100 }),
    );
    markPhotoReadyMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await processPhotoBatch({ photoIds: ['photo-1', 'photo-2', 'photo-3'], albumId: 'album-1' });

    expect(uploadMock).toHaveBeenCalledTimes(3);
    expect(markPhotoReadyMock).toHaveBeenCalledTimes(3);
    expect(unlinkMock).toHaveBeenCalledTimes(3);
  });

  it('does not throw when every photo in the batch succeeds', async () => {
    getPhotoByIdMock.mockResolvedValue(photo());
    uploadMock.mockResolvedValue({ public_id: 'photo-1', width: 1, height: 1 });
    markPhotoReadyMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await expect(
      processPhotoBatch({ photoIds: ['photo-1'], albumId: 'album-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('processPhotoBatch — retry-safety (idempotency)', () => {
  it('skips a photo that is already ready, without calling Cloudinary or touching the DB again', async () => {
    getPhotoByIdMock.mockResolvedValue(photo({ status: PhotoStatus.ready }));

    await processPhotoBatch({ photoIds: ['photo-1'], albumId: 'album-1' });

    expect(uploadMock).not.toHaveBeenCalled();
    expect(markPhotoReadyMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('skips only the already-ready photos in a mixed batch, still processing the rest', async () => {
    getPhotoByIdMock.mockImplementation((id: string) =>
      Promise.resolve(
        photo({ id, status: id === 'photo-1' ? PhotoStatus.ready : PhotoStatus.processing }),
      ),
    );
    uploadMock.mockResolvedValue({ public_id: 'photo-2', width: 1, height: 1 });
    markPhotoReadyMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await processPhotoBatch({ photoIds: ['photo-1', 'photo-2'], albumId: 'album-1' });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledWith(path.join(UPLOAD_TMP_DIR, 'photo-2'), {
      public_id: 'photo-2',
    });
  });
});

describe('processPhotoBatch — per-photo failure isolation', () => {
  it('still processes the remaining photos when one photo fails partway through the batch', async () => {
    getPhotoByIdMock.mockImplementation((id: string) =>
      Promise.resolve(photo({ id, status: PhotoStatus.processing })),
    );
    uploadMock.mockImplementation((_filePath: string, opts: { public_id: string }) => {
      if (opts.public_id === 'photo-2') {
        return Promise.reject(new Error('Cloudinary upload failed'));
      }
      return Promise.resolve({ public_id: opts.public_id, width: 1, height: 1 });
    });
    markPhotoReadyMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await expect(
      processPhotoBatch({ photoIds: ['photo-1', 'photo-2', 'photo-3'], albumId: 'album-1' }),
    ).rejects.toThrow();

    expect(markPhotoReadyMock).toHaveBeenCalledWith('photo-1', expect.anything());
    expect(markPhotoReadyMock).toHaveBeenCalledWith('photo-3', expect.anything());
    expect(markPhotoReadyMock).not.toHaveBeenCalledWith('photo-2', expect.anything());
  });

  it('logs the failing photo id and error', async () => {
    const err = new Error('Cloudinary upload failed');
    getPhotoByIdMock.mockResolvedValue(photo({ status: PhotoStatus.processing }));
    uploadMock.mockRejectedValue(err);

    await expect(
      processPhotoBatch({ photoIds: ['photo-1'], albumId: 'album-1' }),
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith('photo-1', err);
  });

  it('throws an error reporting the failure count out of the batch size', async () => {
    getPhotoByIdMock.mockResolvedValue(photo({ status: PhotoStatus.processing }));
    uploadMock.mockRejectedValue(new Error('Cloudinary upload failed'));

    await expect(
      processPhotoBatch({ photoIds: ['photo-1', 'photo-2'], albumId: 'album-1' }),
    ).rejects.toThrow('2/2 photos failed to process');
  });

  it('also counts a markPhotoReady failure as a batch failure, not just Cloudinary failures', async () => {
    getPhotoByIdMock.mockResolvedValue(photo({ status: PhotoStatus.processing }));
    uploadMock.mockResolvedValue({ public_id: 'photo-1', width: 1, height: 1 });
    markPhotoReadyMock.mockRejectedValue(new Error('connection lost'));

    await expect(
      processPhotoBatch({ photoIds: ['photo-1'], albumId: 'album-1' }),
    ).rejects.toThrow('1/1 photos failed to process');
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('does not throw when every photo in the batch fails to resolve a not-found row into an infinite retry loop', async () => {
    // getPhotoById returning null shouldn't crash the batch — it just isn't
    // treated as already-ready, so processing proceeds (and may fail later
    // for its own reasons, caught like any other per-photo error).
    getPhotoByIdMock.mockResolvedValue(null);
    uploadMock.mockResolvedValue({ public_id: 'photo-1', width: 1, height: 1 });
    markPhotoReadyMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);

    await expect(
      processPhotoBatch({ photoIds: ['photo-1'], albumId: 'album-1' }),
    ).resolves.toBeUndefined();
    expect(uploadMock).toHaveBeenCalled();
  });
});

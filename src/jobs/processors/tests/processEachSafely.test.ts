import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processEachSafely } from '../processEachSafely';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('processEachSafely — happy path', () => {
  it('calls fn once per item, in order', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);

    await processEachSafely([1, 2, 3], fn);

    expect(fn).toHaveBeenNthCalledWith(1, 1);
    expect(fn).toHaveBeenNthCalledWith(2, 2);
    expect(fn).toHaveBeenNthCalledWith(3, 3);
  });

  it('resolves without throwing when every item succeeds', async () => {
    await expect(processEachSafely([1, 2, 3], vi.fn().mockResolvedValue(undefined))).resolves.toBeUndefined();
  });

  it('does nothing and does not throw for an empty batch', async () => {
    const fn = vi.fn();

    await expect(processEachSafely([], fn)).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('processEachSafely — per-item failure isolation', () => {
  it('still attempts every item even when an earlier one fails', async () => {
    const fn = vi.fn().mockImplementation((item: number) => {
      if (item === 2) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(undefined);
    });

    await expect(processEachSafely([1, 2, 3], fn)).rejects.toThrow();

    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledWith(1);
    expect(fn).toHaveBeenCalledWith(2);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('logs the failing item alongside its error', async () => {
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(processEachSafely(['item-1'], fn)).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith('item-1', err);
  });

  it('throws once, reporting the failure count out of the batch size, using the given label', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(processEachSafely([1, 2], fn, 'albums')).rejects.toThrow(
      '2/2 albums failed to process',
    );
  });

  it('defaults the label to "items" when none is given', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(processEachSafely([1], fn)).rejects.toThrow('1/1 items failed to process');
  });

  it('only counts actual failures in the reported ratio, not the full batch', async () => {
    const fn = vi.fn().mockImplementation((item: number) => {
      if (item === 2) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(undefined);
    });

    await expect(processEachSafely([1, 2, 3], fn, 'photos')).rejects.toThrow(
      '1/3 photos failed to process',
    );
  });
});

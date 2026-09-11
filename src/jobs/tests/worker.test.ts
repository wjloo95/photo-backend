import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
interface MockWorkerInstance {
  on: ReturnType<typeof vi.fn>;
  handlers: Record<string, Handler>;
}

const { WorkerConstructorMock, QueueConstructorMock, workerInstances } = vi.hoisted(() => {
  const workerInstances: MockWorkerInstance[] = [];

  const WorkerConstructorMock = vi.fn(function Worker(
    _queueName?: string,
    _processor?: Handler,
    _opts?: unknown,
  ) {
    const handlers: Record<string, Handler> = {};
    const instance: MockWorkerInstance = {
      handlers,
      on: vi.fn((event: string, handler: Handler) => {
        handlers[event] = handler;
      }),
    };
    workerInstances.push(instance);
    return instance;
  });

  const QueueConstructorMock = vi.fn(function Queue() {
    return { add: vi.fn(), upsertJobScheduler: vi.fn() };
  });

  return { WorkerConstructorMock, QueueConstructorMock, workerInstances };
});

// Both photoQueue.ts and expiryQueue.ts construct a real Queue at import
// time (worker.ts imports queue-name constants from both) — mocking
// bullmq's Queue too keeps that harmless instead of attempting a real
// Redis connection.
vi.mock('bullmq', () => ({
  Worker: WorkerConstructorMock,
  Queue: QueueConstructorMock,
}));

const { processPhotoBatchMock } = vi.hoisted(() => ({ processPhotoBatchMock: vi.fn() }));
vi.mock('../processors/photoProcessor', () => ({
  processPhotoBatch: processPhotoBatchMock,
}));

const { processExpiryJobMock } = vi.hoisted(() => ({ processExpiryJobMock: vi.fn() }));
vi.mock('../processors/expiryProcessor', () => ({
  processExpiryJob: processExpiryJobMock,
}));

const { registerExpirySchedulesMock } = vi.hoisted(() => ({
  registerExpirySchedulesMock: vi.fn(() => Promise.resolve()),
}));
vi.mock('../schedulers/expiryScheduler', () => ({
  registerExpirySchedules: registerExpirySchedulesMock,
}));

import { PHOTO_QUEUE_NAME, PhotoJobName } from '../queues/photoQueue';
import { EXPIRY_QUEUE_NAME } from '../queues/expiryQueue';
// Importing this module runs its top-level side effects (constructing both
// Workers, registering their listeners, calling registerExpirySchedules)
// exactly once, here.
import '../worker';

// worker.ts constructs the photo Worker before the expiry Worker, so those
// are the 1st/2nd calls to the (shared) Worker constructor mock, in order.
function getPhotoWorkerProcessor() {
  return WorkerConstructorMock.mock.calls[0][1] as (job: {
    name: string;
    data: unknown;
    id?: string;
  }) => Promise<void>;
}

function getExpiryWorkerProcessor() {
  return WorkerConstructorMock.mock.calls[1][1] as (job: {
    name: string;
    data: unknown;
    id?: string;
  }) => Promise<void>;
}

beforeEach(() => {
  processPhotoBatchMock.mockReset();
  processExpiryJobMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('worker.ts — module setup', () => {
  it('constructs exactly two Workers: one per queue', () => {
    expect(WorkerConstructorMock).toHaveBeenCalledTimes(2);
  });

  it('constructs the photo Worker against PHOTO_QUEUE_NAME', () => {
    expect(WorkerConstructorMock).toHaveBeenNthCalledWith(
      1,
      PHOTO_QUEUE_NAME,
      expect.any(Function),
      expect.objectContaining({
        connection: expect.objectContaining({
          host: expect.any(String),
          port: expect.any(Number),
        }),
      }),
    );
  });

  it('constructs the expiry Worker against EXPIRY_QUEUE_NAME', () => {
    expect(WorkerConstructorMock).toHaveBeenNthCalledWith(
      2,
      EXPIRY_QUEUE_NAME,
      expect.any(Function),
      expect.objectContaining({
        connection: expect.objectContaining({
          host: expect.any(String),
          port: expect.any(Number),
        }),
      }),
    );
  });

  it('registers both an error and a failed listener on each worker', () => {
    for (const instance of workerInstances) {
      expect(instance.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(instance.on).toHaveBeenCalledWith('failed', expect.any(Function));
    }
  });

  it('calls registerExpirySchedules once at startup', () => {
    expect(registerExpirySchedulesMock).toHaveBeenCalledTimes(1);
  });
});

describe('worker.ts — photo job dispatch', () => {
  it('calls processPhotoBatch with job.data for a ProcessBatch job', async () => {
    processPhotoBatchMock.mockResolvedValue(undefined);
    const workerProcessor = getPhotoWorkerProcessor();
    const jobData = { photoIds: ['photo-1', 'photo-2'], albumId: 'album-1' };

    await workerProcessor({ name: PhotoJobName.ProcessBatch, data: jobData });

    expect(processPhotoBatchMock).toHaveBeenCalledWith(jobData);
  });

  it('propagates a rejection from processPhotoBatch instead of swallowing it', async () => {
    const err = new Error('2/3 photos failed to process');
    processPhotoBatchMock.mockRejectedValue(err);
    const workerProcessor = getPhotoWorkerProcessor();

    await expect(
      workerProcessor({ name: PhotoJobName.ProcessBatch, data: { photoIds: [], albumId: 'a' } }),
    ).rejects.toThrow(err);
  });

  it('logs and does not call processPhotoBatch for an unrecognized job name', async () => {
    const workerProcessor = getPhotoWorkerProcessor();

    await workerProcessor({ name: 'some-future-job', data: {} });

    expect(processPhotoBatchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('some-future-job'));
  });
});

describe('worker.ts — expiry job dispatch', () => {
  it('calls processExpiryJob with job.name for any job on the expiry queue', async () => {
    processExpiryJobMock.mockResolvedValue(undefined);
    const workerProcessor = getExpiryWorkerProcessor();

    await workerProcessor({ name: 'warn-90-days', data: {} });

    expect(processExpiryJobMock).toHaveBeenCalledWith('warn-90-days');
  });

  it('propagates a rejection from processExpiryJob instead of swallowing it', async () => {
    const err = new Error('Unknown job name: bogus');
    processExpiryJobMock.mockRejectedValue(err);
    const workerProcessor = getExpiryWorkerProcessor();

    await expect(workerProcessor({ name: 'bogus', data: {} })).rejects.toThrow(err);
  });
});

describe('worker.ts — worker-level event listeners', () => {
  it('logs the error on a worker "error" event, for both workers', () => {
    for (const instance of workerInstances) {
      const err = new Error('Redis connection refused');

      instance.handlers.error(err);

      expect(console.error).toHaveBeenCalledWith(err);
    }
  });

  it('logs the job id and error on a worker "failed" event, for both workers', () => {
    for (const instance of workerInstances) {
      const err = new Error('processing exploded');

      instance.handlers.failed({ id: 'job-42' }, err);

      expect(console.error).toHaveBeenCalledWith('job-42', err);
    }
  });

  it('handles a "failed" event with an undefined job (stalled + removeOnFail case)', () => {
    const err = new Error('stalled job removed');

    workerInstances[0].handlers.failed(undefined, err);

    expect(console.error).toHaveBeenCalledWith(undefined, err);
  });
});

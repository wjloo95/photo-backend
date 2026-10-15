type Handler = (...args: unknown[]) => unknown;
interface MockWorkerInstance {
  on: jest.Mock;
  handlers: Record<string, Handler>;
}

// Both photoQueue.ts and expiryQueue.ts construct a real Queue at import
// time (worker.ts imports queue-name constants from both) — mocking
// bullmq's Queue too keeps that harmless instead of attempting a real
// Redis connection.
jest.mock('bullmq', () => {
  const WorkerConstructorMock = jest.fn(function Worker(
    _queueName?: string,
    _processor?: Handler,
    _opts?: unknown,
  ) {
    const handlers: Record<string, Handler> = {};
    return {
      handlers,
      on: jest.fn((event: string, handler: Handler) => {
        handlers[event] = handler;
      }),
    };
  });

  const QueueConstructorMock = jest.fn(function Queue() {
    return { add: jest.fn(), upsertJobScheduler: jest.fn() };
  });

  return { Worker: WorkerConstructorMock, Queue: QueueConstructorMock };
});

jest.mock('../processors/photoProcessor', () => ({
  processPhotoBatch: jest.fn(),
  failRemainingPhotos: jest.fn(),
}));

jest.mock('../processors/expiryProcessor', () => ({
  processExpiryJob: jest.fn(),
}));

jest.mock('../schedulers/expiryScheduler', () => ({
  registerExpirySchedules: jest.fn(() => Promise.resolve()),
}));

import { Worker } from 'bullmq';
import { PHOTO_QUEUE_NAME, PhotoJobName } from '../queues/photoQueue';
import { EXPIRY_QUEUE_NAME } from '../queues/expiryQueue';
import { failRemainingPhotos, processPhotoBatch } from '../processors/photoProcessor';
import { processExpiryJob } from '../processors/expiryProcessor';
import { registerExpirySchedules } from '../schedulers/expiryScheduler';
// Importing this module runs its top-level side effects (constructing both
// Workers, registering their listeners, calling registerExpirySchedules)
// exactly once, here.
import '../worker';

const WorkerConstructorMock = Worker as unknown as jest.Mock;
const processPhotoBatchMock = processPhotoBatch as jest.Mock;
const failRemainingPhotosMock = failRemainingPhotos as jest.Mock;
const processExpiryJobMock = processExpiryJob as jest.Mock;
const registerExpirySchedulesMock = registerExpirySchedules as jest.Mock;

// worker.ts constructs the photo Worker before the expiry Worker, so those
// are the 1st/2nd calls to the (shared) Worker constructor mock, in order —
// and jest's mock.results captures each call's return value in the same
// order, standing in for the vi.hoisted `workerInstances` array.
const workerInstances = WorkerConstructorMock.mock.results.map(
  (result) => result.value as MockWorkerInstance,
);

// worker.ts constructs the photo Worker before the expiry Worker, so those
// are the 1st/2nd calls to the (shared) Worker constructor mock, in order.
function getPhotoWorkerProcessor() {
  return WorkerConstructorMock.mock.calls[0][1] as (job: {
    name: string;
    data: unknown;
    id?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
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
  failRemainingPhotosMock.mockReset();
  processExpiryJobMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
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
      workerProcessor({
        name: PhotoJobName.ProcessBatch,
        data: { photoIds: [], albumId: 'a' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      }),
    ).rejects.toThrow(err);
  });

  it('logs and does not call processPhotoBatch for an unrecognized job name', async () => {
    const workerProcessor = getPhotoWorkerProcessor();

    await workerProcessor({ name: 'some-future-job', data: {} });

    expect(processPhotoBatchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('some-future-job'));
  });
});

describe('worker.ts — marking photos failed after the final attempt', () => {
  const jobData = { photoIds: ['photo-1', 'photo-2'], albumId: 'album-1' };
  const job = (
    attemptsMade: number,
  ): {
    id: string;
    name: string;
    data: typeof jobData;
    attemptsMade: number;
    opts: { attempts?: number };
  } => ({
    id: 'job-1',
    name: PhotoJobName.ProcessBatch,
    data: jobData,
    attemptsMade,
    opts: { attempts: 3 },
  });

  it.each([[0], [1]])(
    'leaves the photos processing when attempt %i of 0–2 fails, since BullMQ will retry',
    async (attemptsMade) => {
      processPhotoBatchMock.mockRejectedValue(new Error('1/2 photos failed to process'));

      await expect(getPhotoWorkerProcessor()(job(attemptsMade))).rejects.toThrow();

      expect(failRemainingPhotosMock).not.toHaveBeenCalled();
    },
  );

  it('marks the remaining photos failed when the final attempt fails, then still fails the job', async () => {
    const err = new Error('1/2 photos failed to process');
    processPhotoBatchMock.mockRejectedValue(err);
    failRemainingPhotosMock.mockResolvedValue(undefined);

    await expect(getPhotoWorkerProcessor()(job(2))).rejects.toThrow(err);

    expect(failRemainingPhotosMock).toHaveBeenCalledWith(jobData);
  });

  it('does not mark anything failed when the final attempt succeeds', async () => {
    processPhotoBatchMock.mockResolvedValue(undefined);

    await getPhotoWorkerProcessor()(job(2));

    expect(failRemainingPhotosMock).not.toHaveBeenCalled();
  });

  it('treats a job with no retries configured as on its final attempt', async () => {
    processPhotoBatchMock.mockRejectedValue(new Error('boom'));
    failRemainingPhotosMock.mockResolvedValue(undefined);

    await expect(getPhotoWorkerProcessor()({ ...job(0), opts: {} })).rejects.toThrow('boom');

    expect(failRemainingPhotosMock).toHaveBeenCalledWith(jobData);
  });

  it('still fails the job with the processing error when marking the photos failed also fails', async () => {
    const err = new Error('1/2 photos failed to process');
    const markErr = new Error('connection lost');
    processPhotoBatchMock.mockRejectedValue(err);
    failRemainingPhotosMock.mockRejectedValue(markErr);

    await expect(getPhotoWorkerProcessor()(job(2))).rejects.toThrow(err);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('job-1'), markErr);
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

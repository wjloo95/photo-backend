import { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../errorHandler';
import { AppError } from '../../types/AppError';

const makeRes = (headersSent = false) =>
  ({
    headersSent,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }) as unknown as Response;

const req = {} as Request;
const next = jest.fn() as NextFunction;

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('errorHandler — headers already sent', () => {
  it('logs and returns early without calling res.status', () => {
    const res = makeRes(true);
    errorHandler(new AppError('whatever', 400), req, res, next);
    expect(console.error).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('errorHandler — 4xx errors', () => {
  it('forwards AppError message to client and uses correct status', () => {
    const res = makeRes();
    errorHandler(new AppError('Not found', 404), req, res, next);
    expect(console.warn).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('suppresses plain Error message and returns generic text', () => {
    const err = Object.assign(new Error('Sensitive detail'), { status: 400 });
    const res = makeRes();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something went wrong' });
  });
});

describe('errorHandler — 5xx errors', () => {
  it('forwards AppError message and correct status for 5xx', () => {
    const res = makeRes();
    errorHandler(new AppError('DB unavailable', 503), req, res, next);
    expect(console.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'DB unavailable' });
  });

  it('suppresses plain Error message for 5xx and returns generic text', () => {
    const err = Object.assign(new Error('pg connection refused'), { status: 500 });
    const res = makeRes();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something went wrong' });
  });
});

describe('errorHandler — missing or non-integer status (coerced to 500)', () => {
  it('defaults to 500 via the 5xx branch when error has no status', () => {
    const res = makeRes();
    errorHandler(new Error('oops'), req, res, next);
    expect(console.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something went wrong' });
  });

  it('defaults to 500 via the 5xx branch when status is a non-integer string', () => {
    const err = Object.assign(new Error('oops'), { status: 'bad' });
    const res = makeRes();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something went wrong' });
  });
});

describe('errorHandler — integer status outside 4xx/5xx (catch-all)', () => {
  it('returns 500 Internal Server Error for a 2xx status on an error', () => {
    const err = Object.assign(new Error('weird'), { status: 200 });
    const res = makeRes();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
  });

  it('returns 500 Internal Server Error for a 3xx status on an error', () => {
    const err = Object.assign(new Error('weird'), { status: 301 });
    const res = makeRes();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
  });

  it('returns 500 Internal Server Error for a status above 599', () => {
    const err = Object.assign(new Error('weird'), { status: 999 });
    const res = makeRes();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
  });
});

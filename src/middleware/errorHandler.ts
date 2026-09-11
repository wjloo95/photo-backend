import { ErrorRequestHandler } from 'express';
import { AppError } from '../types/AppError';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) {
    console.error('Error after headers sent:', err);
    return;
  }

  // Catch invalid status codes, coerce to 500
  const status = Number.isInteger(err.status) ? err.status : 500;

  // AppError is user created; okay to send
  // Non AppError can possibly send sensitive data, create generic message
  const message = err instanceof AppError ? err.message : 'Something went wrong';

  // 400 User Errors: log and return
  if (status >= 400 && status < 500) {
    console.warn(err.stack);

    return res.status(status).json({ error: message });
  }

  // 500 Server Errors:
  // In Development: log the errors
  // In Production: Provide generic response
  if (status >= 500 && status < 600) {
    console.error(err.stack);

    return res.status(status).json({
      error: message,
    });
  }

  // Other status code - send generic 500
  return res.status(500).json({ error: 'Internal Server Error' });
};

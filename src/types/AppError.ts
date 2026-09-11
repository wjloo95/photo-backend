/**
 * src/types/AppError.ts
 *
 * Custom error class for operational errors — errors you intentionally throw
 * that are safe to forward to the client (e.g. "Email already taken", "Token expired").
 *
 * The isOperational flag is what your error handler checks. If it's true,
 * the message is forwarded. If it's false (or missing — any plain Error),
 * the client gets a generic message instead.
 *
 * Usage in route handlers:
 *   import { AppError } from '../types/AppError';
 *   throw new AppError('Invite token has expired', 410);
 *   throw new AppError('You do not have access to this album', 403);
 */

export class AppError extends Error {
  status: number;
  isOperational: true;

  constructor(message: string, status: number) {
    // Call the parent Error constructor so .message and .stack are set correctly
    super(message);

    this.status = status;

    // Marks this error as one you created intentionally.
    // Plain errors from libraries (pg, ioredis, etc.) will never have this flag.
    this.isOperational = true;

    // Maintains proper prototype chain in TypeScript when extending built-ins
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

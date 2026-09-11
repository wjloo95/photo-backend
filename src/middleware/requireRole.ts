import { RequestHandler } from 'express';
import { UserRole } from '../types';
import { AppError } from '../types/AppError';

// Must run after loadUser so req.user is populated.
export const requireRole =
  (role: UserRole): RequestHandler =>
  (req, _res, next) => {
    if (req.user?.role !== role) {
      return next(new AppError('Forbidden', 403));
    }
    next();
  };

// src/types/express.d.ts
import { User } from './index';

declare global {
  namespace Express {
    interface Request {
      auth?: { sub: string };
      user?: User;
    }
  }
}

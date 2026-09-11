// src/types/express.d.ts
import { User } from './index';

declare global {
  namespace Express {
    interface Request {
      auth?: { sub: string };
      user?: User;
      // Raw request body bytes, captured by the express.json() verify hook in
      // app.ts. Needed for HMAC signature checks (e.g. the /users webhook) —
      // the parsed/re-serialized req.body won't byte-for-byte match what the
      // sender originally signed.
      rawBody?: Buffer;
    }
  }
}

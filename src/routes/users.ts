import { Router, Request, RequestHandler } from 'express';
import { insertUserFromWebhook } from '../db/queries/users';
import { env } from '../config/env';
import crypto from 'node:crypto';

const router = Router();

// Header name your Auth0 Action/Hook sends the signature in — rename this
// to match whatever you actually configured on the Auth0 side.
const SIGNATURE_HEADER = 'x-webhook-signature';

/**
 * Verifies that an incoming /users webhook request actually came from Auth0.
 *
 * Recomputes the HMAC-SHA256 of the raw request body using
 * AUTH0_WEBHOOK_SECRET, then compares it to the signature the sender
 * included in SIGNATURE_HEADER. Uses req.rawBody (captured in app.ts) rather
 * than req.body, since the parsed-and-re-serialized body won't byte-for-byte
 * match what the sender originally signed.
 */
export function verifyWebhookSignature(req: Request): boolean {
  const signature = req.headers[SIGNATURE_HEADER];
  if (typeof signature !== 'string' || !req.rawBody) return false;

  const expected = crypto.createHmac('sha256', env.AUTH0_WEBHOOK_SECRET).update(req.rawBody).digest('hex');

  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  // timingSafeEqual throws on mismatched lengths rather than returning false,
  // so guard that case explicitly — a length mismatch just means "not equal".
  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

// POST /users — Auth0 webhook handler, fired on signup.
// Internal-only: this is called by Auth0, not by end users, so it sits behind
// signature verification rather than the JWT `auth` middleware.
// Exported separately (rather than inlined in the router.post call) so tests
// can call it directly with mocked req/res/next, no HTTP layer needed.
export const createUserFromWebhook: RequestHandler = async (req, res, next) => {
  try {
    if (!verifyWebhookSignature(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { email, role, providerId, businessName } = req.body;
    const createdUser = await insertUserFromWebhook({ email, role, providerId, businessName });
    res.status(201).json(createdUser);
  } catch (err) {
    next(err);
  }
};

router.post('/', createUserFromWebhook);

export default router;

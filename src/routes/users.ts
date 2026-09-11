import { Router, Request, RequestHandler } from 'express';
import { insertClientFromInvite, insertUserFromWebhook, updateUserById } from '../db/queries/users';
import { env } from '../config/env';
import { auth, loadUser } from '../middleware/auth';
import { AppError } from '../types/AppError';
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

  const expected = crypto
    .createHmac('sha256', env.AUTH0_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

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
//
// Two signups funnel through this one webhook (D-08): a photographer signing
// up directly, or a client accepting an invite. `inviteToken` is only present
// in the payload for the latter — the frontend attaches it to the Auth0
// signup call when the user arrived via an invite link (see 3.3 in
// ASSIGNMENTS.md). Per D-19, clients only ever come through this path, so
// there's no "client, no inviteToken" case to design for.
export const createUserFromWebhook: RequestHandler = async (req, res, next) => {
  try {
    if (!verifyWebhookSignature(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { email, name, role, providerId, inviteToken } = req.body;

    const createdUser = inviteToken
      ? await insertClientFromInvite({ email, name, providerId, inviteToken })
      : await insertUserFromWebhook({ email, name, role, providerId });

    res.status(201).json(createdUser);
  } catch (err) {
    next(err);
  }
};

// PATCH /users/:id — end-user profile update (email, name), not the Auth0
// webhook, so it needs the real JWT auth chain. This router is mounted
// before the global auth/loadUser in app.ts (so the webhook above can run
// without a JWT), so auth + loadUser are applied directly on this route.
export const updateUserFromId: RequestHandler = async (req, res, next) => {
  try {
    if (req.params.id !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    const { email, name } = req.body;
    const updatedUser = await updateUserById(req.params.id, { email, name });

    if (!updatedUser) {
      return next(new AppError('User not found', 404));
    }

    res.json(updatedUser);
  } catch (err) {
    next(err);
  }
};

// GET /users/me — the authenticated caller's own user record.
//
// This exists because the frontend cannot work out who it is on its own. After
// Auth0 login the browser holds a JWT whose `sub` is an Auth0 identifier
// ('auth0|abc123'), but every URL in this API is keyed by the app's own
// users.id UUID, and the shell has to know the caller's role to decide whether
// to render the photographer dashboard or the client gallery. loadUser already
// performs exactly that lookup on every authenticated request; this endpoint
// is the one place it is handed back.
//
// Reading from the database rather than from custom JWT claims is deliberate,
// and follows D-08: the users table is the source of truth for user records.
// Claims injected at login would remove this round trip, but a role change
// would not take effect until the token refreshed, and the identity data would
// live in two places that can disagree — the webhook already syncs Auth0 into
// the DB, and claims would add a second sync running the other way.
//
// The body is the bare User. Bundling the photographer or client profile in
// here would make /me the endpoint every screen calls to get one field.
export const getCurrentUser: RequestHandler = (req, res) => {
  // No DB call and no null check: loadUser has already resolved req.user, and
  // rejects the request with a 401 when it cannot.
  res.status(200).json(req.user);
};

router.post('/', createUserFromWebhook);
// '/me' must be registered before any '/:id' GET, or Express matches 'me' as
// an id. There is no GET '/:id' today, but the ordering is the convention that
// keeps adding one from silently breaking this route.
router.get('/me', auth, loadUser, getCurrentUser);
router.patch('/:id', auth, loadUser, updateUserFromId);

export default router;

import { Router, RequestHandler } from 'express';
import crypto from 'node:crypto';
import {
  deleteInviteById,
  expireInvite,
  getInviteById,
  getInviteByToken,
  insertInvite,
  refreshInviteToken,
} from '../db/queries/invites';
import { InviteStatus, UserRole } from '../types';
import { auth, loadUser } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { AppError } from '../types/AppError';

const router = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// POST /invites — a photographer generates a one-time onboarding link for a
// prospective client. The link embeds `token`, a random value with no
// meaning of its own — whoever presents it back at accept-time is treated as
// the invited client. crypto.randomBytes (not Math.random) is what makes it
// safe to hand out: it's non-deterministic and can't be predicted or brute-forced.
//
// This router is mounted in app.ts *before* the global auth/loadUser (so the
// public GET /validate below can run without a JWT), so auth + loadUser are
// applied directly on this route instead — same pattern as PATCH /users/:id.
export const createInvite: RequestHandler = async (req, res, next) => {
  try {
    const { email, clientName } = req.body;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

    const invite = await insertInvite({
      photographerId: req.user!.id,
      email,
      clientName,
      token,
      expiresAt,
    });

    res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
};

// GET /invites/validate?token=... — public endpoint, no auth required.
// A prospective client hits this before they have an account, so there's no
// JWT to check — the token in the query string IS the credential here.
//
// 400 if the token query param is missing or not a single string value.
// 404 if no invite matches the token at all.
// 410 if the invite is already accepted or already marked expired.
// 410 if the invite is still 'pending' but expiresAt has passed — this also
// lazily flips its status to 'expired' in the DB via expireInvite() so the
// next lookup short-circuits on the status check above instead of
// re-evaluating the date.
// 200 with only { email, clientName, photographerId } on success — deliberately
// not the full invite row, since the token/status/dates aren't the caller's
// business at this point.
export const validateInvite: RequestHandler = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (typeof token !== 'string') {
      return next(new AppError('Invalid token', 400));
    }

    const invite = await getInviteByToken(token);

    if (!invite) {
      return next(new AppError('Invite does not exist', 404));
    }

    if (invite.status === InviteStatus.accepted || invite.status === InviteStatus.expired) {
      return next(new AppError('Invite no longer valid', 410));
    }

    if (invite.status === InviteStatus.pending && invite.expiresAt < new Date()) {
      await expireInvite(invite.id);
      return next(new AppError('Invite expired', 410));
    }

    const { email, clientName, photographerId } = invite;

    res.status(200).json({ email, clientName, photographerId });
  } catch (err) {
    next(err);
  }
};

// POST /invites/:id/resend — photographer regenerates an invite's token and
// pushes expiresAt back out 30 days, reviving it even if it had expired.
//
// Blocks resending an already-accepted invite: once a client has completed
// signup through it, resending would let that same link mint a *second*
// client account against the same invite row. The row lock in
// insertClientFromInvite only guards against redeeming one invite twice
// concurrently — it does nothing to stop a photographer from manually
// reopening one that's already been used.
export const resendInvite: RequestHandler = async (req, res, next) => {
  try {
    const invite = await getInviteById(req.params.id);

    if (!invite) {
      return next(new AppError('Invite not found', 404));
    }

    if (invite.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    if (invite.status === InviteStatus.accepted) {
      return next(new AppError('Cannot resend an already-accepted invite', 409));
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

    const updatedInvite = await refreshInviteToken(invite.id, { token, expiresAt });
    res.status(200).json(updatedInvite);
  } catch (err) {
    next(err);
  }
};

// DELETE /invites/:id — photographer cancels an invite by deleting it
// outright, same convention as DELETE /users/:id (2.3). Invites have no FK
// referencing them from clients/conversations, so this is safe even for an
// already-accepted invite — it just discards the historical record.
export const cancelInvite: RequestHandler = async (req, res, next) => {
  try {
    const invite = await getInviteById(req.params.id);

    if (!invite) {
      return next(new AppError('Invite not found', 404));
    }

    if (invite.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    await deleteInviteById(invite.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

router.post('/', auth, loadUser, requireRole(UserRole.photographer), createInvite);
router.post('/:id/resend', auth, loadUser, requireRole(UserRole.photographer), resendInvite);
router.delete('/:id', auth, loadUser, requireRole(UserRole.photographer), cancelInvite);
router.get('/validate', validateInvite);

export default router;

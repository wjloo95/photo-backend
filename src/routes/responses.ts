import { Router, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../types/AppError';
import { firstIssueMessage } from '../utils/validation';
import {
  getResponseWithOwners,
  submitResponse,
  upsertAnswer,
  ResponseWithOwners,
} from '../db/queries/responses';

const router = Router();

/**
 * An answer is stored as TEXT whatever its declared answerType — booleans as
 * 'true'/'false', dates as ISO strings, parsing left to application code
 * (migration 012, carried into the JSONB column by migration 019). Postgres
 * imposes no useful ceiling, so the cap is ours, on the same reasoning as
 * MAX_MESSAGE_LENGTH in routes/conversations.ts.
 */
export const MAX_ANSWER_LENGTH = 5000;

/**
 * The body for POST /responses/:id/answers. One question, one answer — the
 * response comes from the URL.
 *
 * questionId is validated as a uuid rather than any string: it is compared
 * against the snapshot below, but it is also written into a JSONB key, and a
 * caller who can put arbitrary text there is a caller who can grow the object
 * with keys that match no question. A malformed id is a 400 from here, not a
 * silently accepted junk key.
 *
 * `.trim()` before `.min(1)` matters — the checks run in chain order, so the
 * other way round an answer of "   " would pass the length test and be stored
 * as whitespace. There is deliberately no empty-string case: absence of a key
 * is what "unanswered" means, so a blank answer would be a third state. If
 * clearing an answer ever matters, the honest verb is
 * DELETE /responses/:id/answers/:questionId, not an empty upsert.
 */
const answerBodySchema = z.object({
  questionId: z.string().uuid(),
  content: z.string().trim().min(1, 'an answer cannot be empty').max(MAX_ANSWER_LENGTH),
});

/**
 * The read rule: the client the response belongs to, or the photographer who
 * owns the template it came from. Anyone else has no claim on it.
 *
 * This is the first place in the app where two different roles pass the same
 * check by different columns — GET /albums/:id is the closest precedent.
 */
function canRead(response: ResponseWithOwners, userId: string): boolean {
  return response.clientId === userId || response.photographerId === userId;
}

// GET /responses/:id — the response with its questions and answers.
//
// One query does all of it since migration 019: the row carries the question
// snapshot and the answers object, so there is nothing to join and nothing to
// assemble. This is the only way a client ever sees a template's questions —
// there is no client-facing template endpoint — which is exactly why the
// snapshot lives on the response rather than being read from the template.
export const getResponseFromId: RequestHandler = async (req, res, next) => {
  try {
    const response = await getResponseWithOwners(req.params.id);

    if (!response) {
      return next(new AppError('No Response Found', 404));
    }

    if (!canRead(response, req.user!.id)) {
      return next(new AppError('Forbidden', 403));
    }

    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
};

// POST /responses/:id/answers — the owning client saves one answer. An upsert,
// so a save-as-you-go client can re-send the same question freely.
//
// The ladder is parse → 404 → 403 → 409 → 400, and the order is load-bearing:
// a malformed body never reaches the database, and a caller with no claim on
// the response learns nothing about its state.
//
// The 403 here is narrower than the one in GET above, and deliberately not the
// same helper: the photographer may READ a response but must never answer it.
// This is the one place where the two owners diverge.
//
// The question check runs against the response's own snapshot rather than the
// database. Before migration 019 this was a cross-table query, because
// question_id and response_id were independent caller-supplied ids that the
// foreign keys could relate only through form_questions. The snapshot makes it
// an array lookup on data already in hand.
export const saveAnswer: RequestHandler = async (req, res, next) => {
  try {
    const parsed = answerBodySchema.safeParse(req.body);

    if (!parsed.success) {
      return next(new AppError(firstIssueMessage(parsed.error), 400));
    }

    const { questionId, content } = parsed.data;

    const response = await getResponseWithOwners(req.params.id);

    if (!response) {
      return next(new AppError('No Response Found', 404));
    }

    if (response.clientId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    // A state conflict, not an authorization failure: the caller does own this
    // response, it just can't be written to any more.
    if (response.submittedAt !== null) {
      return next(new AppError('This form has been submitted and can no longer be edited', 409));
    }

    if (!response.questions.some((question) => question.id === questionId)) {
      return next(new AppError('questionId: no such question on this form', 400));
    }

    const updated = await upsertAnswer(req.params.id, questionId, content);

    // The 409 above and this write are two statements, so a submit can land in
    // between. upsertAnswer carries `AND submitted_at IS NULL`, so the loser of
    // that race matches no row rather than writing to a submitted form. The
    // response existed a moment ago, so null here means it was just submitted.
    if (!updated) {
      return next(new AppError('This form has been submitted and can no longer be edited', 409));
    }

    // 200, not 201: the caller can't tell whether their save inserted or
    // overwrote, and shouldn't have to. Returning the whole response hands back
    // the canonical answers object rather than making the client guess how its
    // write merged.
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
};

// PATCH /responses/:id/submit — the owning client submits. After this, no
// further answer writes.
//
// Same load → 404 → 403 → 409 ladder as saveAnswer. Submit does not require a
// complete form: an unanswered question simply has no key in `answers`, and
// nothing in the schema marks a question required. If that ever changes, this
// handler is where the check belongs, not the query function.
//
// There is deliberately no unsubmit direction. submitted_at is the only record
// of when the client finished, so reversing it either destroys that timestamp
// or needs a second column to remember it.
export const submitResponseFromId: RequestHandler = async (req, res, next) => {
  try {
    const response = await getResponseWithOwners(req.params.id);

    if (!response) {
      return next(new AppError('No Response Found', 404));
    }

    if (response.clientId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    if (response.submittedAt !== null) {
      return next(new AppError('This form has already been submitted', 409));
    }

    const submitted = await submitResponse(req.params.id);

    // Same check-then-write gap as saveAnswer, and the same guard in the SQL:
    // two concurrent submits both pass the 409 above, and the loser matches no
    // row — which is what preserves the original submitted_at rather than
    // letting it creep forward.
    if (!submitted) {
      return next(new AppError('This form has already been submitted', 409));
    }

    res.status(200).json(submitted);
  } catch (err) {
    next(err);
  }
};

// Both roles reach these routes: a client for their own response, a
// photographer for responses to their templates — so no requireRole at the
// router level. The per-handler checks above are what separate them, and they
// are not the same check on every endpoint: read is either owner, write is the
// client alone. A requireRole(UserRole.client) on the two write routes would
// be belt-and-braces rather than load-bearing, since only a client can ever be
// a response's clientId.
router.get('/:id', getResponseFromId);
router.post('/:id/answers', saveAnswer);
router.patch('/:id/submit', submitResponseFromId);

export default router;

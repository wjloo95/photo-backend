import { Router, RequestHandler } from 'express';
import { AnswerType, UserRole } from '../types';
import { requireRole } from '../middleware/requireRole';
import { AppError } from '../types/AppError';
import {
  deleteTemplateById,
  getTemplateById,
  getTemplateWithQuestionsById,
  insertTemplateWithQuestions,
  replaceTemplateQuestions,
  templateHasResponses,
} from '../db/queries/templates';
import { z } from 'zod';
import { firstIssueMessage } from '../utils/validation';
import { getClientByUserId } from '../db/queries/clients';
import { insertResponse } from '../db/queries/responses';

const router = Router();

/**
 * Max questions per template. Enforced in the zod schema below, so the
 * request is rejected with a 400 before any transaction opens — one request
 * can never insert an unbounded number of rows.
 */
export const MAX_QUESTIONS = 25;

/**
 * The request body for both POST and PUT — PUT sends the complete new state of
 * the template rather than a diff, so the two are the same shape and share one
 * schema. Defined at module scope: rebuilding it per request would be wasted
 * work, and one definition means the two endpoints can't drift apart.
 *
 * `.trim()` before `.min(1)` matters — the checks run in chain order, so the
 * other way round a name of "   " would pass a length test and then be stored
 * as an empty string.
 *
 * There is no `order` field, and z.object strips unknown keys, so a caller who
 * sends one is silently ignored rather than obeyed. That is deliberate: order
 * is the index of the questions array, assigned by insertQuestions. Honouring
 * a caller-supplied order is what would reintroduce the gaps and duplicates
 * that migration 018's UNIQUE (template_id, "order") now rejects.
 */
const templateBodySchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  questions: z
    .array(
      z.object({
        content: z.string().trim().min(1, 'question content is required'),
        // Mirrors the DB enum. Since migration 018 dropped multiple_choice the
        // two are back in sync, so anything this accepts, Postgres accepts.
        answerType: z.nativeEnum(AnswerType),
      }),
    )
    .min(1, 'a template needs at least one question')
    .max(MAX_QUESTIONS, `a template can have at most ${MAX_QUESTIONS} questions`),
});

/**
 * POST /templates/:id/responses. The template comes from the URL, so the body
 * carries only the assignee — one field, and it is caller-controlled, which is
 * why step 3 of the handler still verifies the client is one of the caller's.
 */
const assignResponseBodySchema = z.object({
  clientId: z.string().uuid(),
});

// POST /templates — photographer only. Creates the template and its whole
// question set in one transaction, and returns the created template with its
// questions embedded (201).
//
// One parse at the top, before anything else runs: the 400 for a malformed
// body happens before a connection is checked out, so a bad request can never
// open a transaction. It is also what gives the rest of the handler a typed
// body — after this line nothing touches req.body, which is `any`, and an
// annotation on `any` asserts rather than checks.
export const createTemplate: RequestHandler = async (req, res, next) => {
  try {
    const parsed = templateBodySchema.safeParse(req.body);

    if (!parsed.success) {
      return next(new AppError(firstIssueMessage(parsed.error), 400));
    }

    const template = await insertTemplateWithQuestions(req.user!.id, parsed.data);

    res.status(201).json(template);
  } catch (err) {
    next(err);
  }
};

// GET /templates/:id — photographer only, own templates only. Returns the
// template with its questions embedded in "order" sequence; a template
// without them can't render a form, and there is no separate questions
// endpoint.
//
// 404 before 403, the same ordering as GET /albums/:id: a caller who doesn't
// own the template learns it exists. That's the codebase convention for owned
// resources — GET /photographers/:id is the deliberate exception, where a
// private profile 404s so existence itself stays hidden.
//
// Not cached, deliberately: templates are read-heavy and near-immutable once
// locked, so they would cache well — but that's a reason to add it if the
// read path actually shows up hot, not on spec.
export const getTemplateFromId: RequestHandler = async (req, res, next) => {
  try {
    const template = await getTemplateWithQuestionsById(req.params.id);

    if (!template) {
      return next(new AppError('No Template Found', 404));
    }

    if (template.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    res.status(200).json(template);
  } catch (err) {
    next(err);
  }
};

// PUT /templates/:id — photographer only, own templates only. Replaces the
// name and the full question set. PUT rather than PATCH because the body is
// the complete new state of the template, not a diff of changed fields; 200
// rather than 201 because the resource already exists at this URI.
//
// Order matters here: parse first (a malformed body 400s before any DB work),
// then load and authorise, and only then mutate — the same
// authorise-before-writing order as PATCH /conversations/:id/read.
//
// No lock check. Until migration 019 this endpoint returned 409 once any
// client had been assigned the template, because replacing the question set
// recreates question rows with new ids and form_answers pointed at the old
// ones. Responses now snapshot the questions they were assigned, so an edit
// cannot affect a form already in a client's hands and a photographer can
// revise a template as often as they like. Assigned responses keep the
// wording their client actually saw.
//
// replaceTemplateQuestions returns TemplateWithQuestions, never null. If the
// template vanished between the load above and the write, it throws AppError
// 404 from inside its own transaction, which routes that exit through its
// catch and rolls back before the client returns to the pool. So there is no
// null to check here; that error reaches errorHandler on its own.
export const replaceTemplateFromId: RequestHandler = async (req, res, next) => {
  try {
    const parsed = templateBodySchema.safeParse(req.body);

    if (!parsed.success) {
      return next(new AppError(firstIssueMessage(parsed.error), 400));
    }

    const template = await getTemplateById(req.params.id);

    if (!template) {
      return next(new AppError('No Template Found', 404));
    }

    if (template.photographerId !== req.user?.id) {
      return next(new AppError('Forbidden', 403));
    }

    const updatedTemplate = await replaceTemplateQuestions(req.params.id, parsed.data);

    res.status(200).json(updatedTemplate);
  } catch (err) {
    next(err);
  }
};

// DELETE /templates/:id — photographer only, own templates only. The only
// endpoint left that a template's responses can block, and the reason is
// different from the old edit lock: a response is a standalone record of what
// a client was asked and answered, so it must outlive the template it came
// from.
//
// form_responses.template_id is ON DELETE RESTRICT since migration 019, so
// Postgres refuses this delete regardless. The check below exists to turn that
// into a 409 with an explanation rather than a foreign-key violation arriving
// at errorHandler as an unlabelled 500 — the constraint is the enforcement,
// this is the error message.
//
// ON DELETE CASCADE on form_questions.template_id (migration 010) removes the
// questions.
//
// 204 with .send() — status() alone only sets the code and never flushes the
// response, leaving the caller waiting on a delete that already happened.
export const deleteTemplateFromId: RequestHandler = async (req, res, next) => {
  try {
    const template = await getTemplateById(req.params.id);

    if (!template) {
      return next(new AppError('No Template Found', 404));
    }

    if (template.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    const hasResponses = await templateHasResponses(template.id);

    if (hasResponses) {
      return next(new AppError('Template cannot be deleted as it has outstanding responses', 409));
    }

    await deleteTemplateById(req.params.id);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

// POST /templates/:id/responses — photographer only. Assigns this template to
// one of their clients, creating the form_responses row the client then fills
// in. Belongs to 8.2 but sits on this router because the URL is nested under
// the template.
//
// The body carries only clientId, and it is caller-controlled: the FK on
// form_responses proves the id belongs to *a* client, never that it belongs to
// this photographer. So the ownership ladder runs twice — once on the template
// from the URL, once on the client from the body — the same check POST /albums
// makes before trusting a body's clientId.
//
// The two client failures are told apart deliberately: an id matching no
// client at all is a 404, an id belonging to another photographer's client is
// a 403. POST /albums collapses both into a 404 so a photographer can't probe
// for the existence of other photographers' clients; splitting them is the
// friendlier answer to a legitimate caller, at the cost of confirming that a
// given uuid is somebody's client.
//
// Note what is deliberately absent: no lock check. Assigning is exactly what
// locks a template, and a locked template can still be assigned again — that
// is the escape hatch when its questions can no longer be edited.
export const createResponseForTemplate: RequestHandler = async (req, res, next) => {
  try {
    const parsed = assignResponseBodySchema.safeParse(req.body);

    if (!parsed.success) {
      return next(new AppError(firstIssueMessage(parsed.error), 400));
    }

    const { clientId } = parsed.data;

    const template = await getTemplateById(req.params.id);

    if (!template) {
      return next(new AppError('No Template Found', 404));
    }

    if (template.photographerId !== req.user!.id) {
      return next(new AppError('Forbidden', 403));
    }

    const client = await getClientByUserId(clientId);

    if (!client) {
      return next(new AppError('No Client Found', 404));
    }
    if (client.photographerId !== req.user!.id) {
      return next(new AppError('You do not have access to this client', 403));
    }

    const response = await insertResponse(template.id, clientId);

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
};

// Every route here is photographer-only. auth + loadUser already ran globally
// in app.ts for everything mounted after /users, so req.user is populated by
// the time these handlers run.
//
// Clients never read a template directly: they see its questions through
// GET /responses/:id, which is 8.2's job.
router.post('/', requireRole(UserRole.photographer), createTemplate);
router.post('/:id/responses', requireRole(UserRole.photographer), createResponseForTemplate);
router.get('/:id', requireRole(UserRole.photographer), getTemplateFromId);
router.put('/:id', requireRole(UserRole.photographer), replaceTemplateFromId);
router.delete('/:id', requireRole(UserRole.photographer), deleteTemplateFromId);

export default router;

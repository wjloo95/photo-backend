import { Router, RequestHandler } from 'express';
import { AppError } from '../types/AppError';
import { getClientByUserId } from '../db/queries/clients';
import { getResponsesByClientId } from '../db/queries/responses';

const router = Router();

// GET /clients/:id/responses — every form response belonging to one client.
//
// Readable by the client themselves, or by their photographer — the same rule
// as GET /responses/:id, and for the same reason: form_responses has no
// photographer_id, so the photographer's claim runs through the client record.
//
// The caller's right to :id is established before anything is queried. A
// client passes on identity alone; a photographer has to be the one the client
// belongs to, which is the same check POST /albums makes before trusting a
// body's clientId. The client_id in the URL is never trusted on its own — the
// JWT identity decides (D-17).
//
// 403 rather than an empty list for a client that isn't the caller's: this is
// why getResponsesByClientId filters on client_id alone instead of joining an
// extra photographer arm. An empty list means "nothing here" and invites the
// caller to retry; a 403 says "not yours". A client id matching no client at
// all gets the same 403 — a photographer probing ids learns nothing about
// which of them exist.
//
// The rows come back as summaries, without question snapshots or answers.
// Since migration 019 every response carries its own copy of the questions it
// was assigned, and an inbox listing twenty of them has no use for twenty
// question sets; the caller picks one and calls GET /responses/:id.
export const getClientResponsesFromId: RequestHandler = async (req, res, next) => {
  try {
    const clientId = req.params.id;

    if (clientId !== req.user!.id) {
      const client = await getClientByUserId(clientId);

      if (!client || client.photographerId !== req.user!.id) {
        return next(new AppError('Forbidden', 403));
      }
    }

    const responses = await getResponsesByClientId(clientId);

    res.status(200).json(responses);
  } catch (err) {
    next(err);
  }
};

// Both roles reach this route — the client for themselves, the photographer
// for one of their clients — so the separation is in the handler, not a
// requireRole guard. Phase 8.2 adds only this endpoint; the architecture doc's
// other /clients routes belong to earlier phases.
router.get('/:id/responses', getClientResponsesFromId);

export default router;

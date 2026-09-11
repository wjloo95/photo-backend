import { Router, RequestHandler } from 'express';
import { AppError } from '../types/AppError';
import { getClientByUserId } from '../db/queries/clients';
import { getResponsesByClientId } from '../db/queries/responses';
import { getAlbumsByClientId } from '../db/queries/albums';

const router = Router();

/**
 * Every route here is addressed by a client id in the URL, and readable by two
 * different people: the client themselves, or the photographer that client
 * belongs to.
 *
 * The client_id in the URL is never trusted on its own — the JWT identity
 * decides (D-17). A client passes on identity alone; a photographer has to be
 * the one the client belongs to, which is the same check POST /albums makes
 * before trusting a body's clientId.
 *
 * Throws rather than returning a boolean so callers read as a straight ladder,
 * and so the "which failure was it" wording lives in one place. A client id
 * matching no client at all gets the same 403 as one belonging to somebody
 * else: a photographer probing ids learns nothing about which exist.
 */
async function assertCanReadClient(clientId: string, callerId: string): Promise<void> {
  if (clientId === callerId) {
    return;
  }

  const client = await getClientByUserId(clientId);

  if (!client || client.photographerId !== callerId) {
    throw new AppError('Forbidden', 403);
  }
}

// GET /clients/:id/albums — every album belonging to one client.
//
// This is how a client finds their galleries at all. GET /albums/:id requires
// an id they already have, and GET /photographers/:id/albums is closed to
// them, so without this endpoint a logged-in client has no route into their
// own photos.
//
// Readable by their photographer too. The architecture doc originally scoped
// this to the client alone, but the photographer already sees these albums via
// GET /photographers/:id/albums — scoping by one client is a narrower view of
// data they can read anyway, not a new grant.
export const getClientAlbumsFromId: RequestHandler = async (req, res, next) => {
  try {
    await assertCanReadClient(req.params.id, req.user!.id);

    const albums = await getAlbumsByClientId(req.params.id);

    res.status(200).json(albums);
  } catch (err) {
    next(err);
  }
};

// GET /clients/:id/responses — every form response belonging to one client.
//
// Same rule as GET /responses/:id, and for the same reason: form_responses has
// no photographer_id, so the photographer's claim runs through the client
// record rather than through a column on the response.
//
// 403 rather than an empty list for a client that isn't the caller's: this is
// why getResponsesByClientId filters on client_id alone instead of joining an
// extra photographer arm. An empty list means "nothing here" and invites the
// caller to retry; a 403 says "not yours".
//
// The rows come back as summaries, without question snapshots or answers.
// Since migration 019 every response carries its own copy of the questions it
// was assigned, and an inbox listing twenty of them has no use for twenty
// question sets; the caller picks one and calls GET /responses/:id.
export const getClientResponsesFromId: RequestHandler = async (req, res, next) => {
  try {
    await assertCanReadClient(req.params.id, req.user!.id);

    const responses = await getResponsesByClientId(req.params.id);

    res.status(200).json(responses);
  } catch (err) {
    next(err);
  }
};

// Both roles reach these routes — the client for themselves, the photographer
// for one of their clients — so the separation is in assertCanReadClient
// above, not a requireRole guard.
router.get('/:id/albums', getClientAlbumsFromId);
router.get('/:id/responses', getClientResponsesFromId);

export default router;

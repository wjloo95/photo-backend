/**
 * src/app.ts
 *
 * Creates and configures the Express application.
 * Separate from server.ts so the app can be imported in tests
 * without starting an HTTP server.
 *
 * ─── YOUR WORK ───────────────────────────────────────────────
 * As you build each feature, import your router and mount it here.
 * Example (after you have written src/routes/users.ts):
 *
 *   import usersRouter from './routes/users';
 *   app.use('/users', usersRouter);
 *
 * Follow the implementation order from the architecture doc:
 *   1. Users
 *   2. Photographers / Clients
 *   3. Invites
 *   4. Albums & Photos
 *   5. Conversations & Messages
 *   6. Forms
 * ─────────────────────────────────────────────────────────────
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler';
import { auth, loadUser } from './middleware/auth';
import usersRouter from './routes/users';
import photographersRouter from './routes/photographers';
import invitesRouter from './routes/invites';
import albumsRouter from './routes/albums';
import photosRouter from './routes/photos';
import conversationsRouter from './routes/conversations';
import templatesRouter from './routes/templates';
import responsesRouter from './routes/responses';
import clientsRouter from './routes/clients';

const app = express();

// ── Global middleware ─────────────────────────────────────────
// helmet sets security-related HTTP response headers
app.use(helmet());

// cors allows browsers to make requests from other origins.
// In production, restrict this to your frontend domain.
app.use(cors());

// Parse incoming JSON request bodies.
// Without this, req.body is always undefined.
// The `verify` hook stashes the raw bytes on req.rawBody before they're
// parsed — some handlers (the /users webhook) need to hash the exact bytes
// the sender signed, not a re-serialized copy of the parsed object.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }),
);

// ── Health check ──────────────────────────────────────────────
// Simple endpoint used by the AWS ALB to confirm the server is alive.
// Mounted before auth — the ALB has no JWT to send.
// Returns 200 with no body — that's all the load balancer needs.
app.get('/health', (_req, res) => {
  res.sendStatus(200);
});

// /users is the Auth0 signup webhook — it authenticates via HMAC signature
// (see verifyWebhookSignature in routes/users.ts), not a user JWT, so it's
// mounted before the auth/loadUser middleware below.
app.use('/users', usersRouter);

// /invites/validate is a public endpoint (a prospective client hits it before
// they have an account, so there's no JWT to send) — mounted before the
// global auth/loadUser for the same reason as /users above. The routes on
// this router that DO need auth (POST /) apply `auth, loadUser` directly
// themselves rather than relying on mount order.
app.use('/invites', invitesRouter);

// auth verifies the JWT and attaches the decoded payload to req.auth.
// loadUser resolves it to the full DB user and attaches it to req.user.
// Both call next(err) on failure, handled by errorHandler below.
app.use(auth);
app.use(loadUser);

// ── Routes ────────────────────────────────────────────────────
// Mount your routers here as you build them.
app.use('/photographers', photographersRouter);
app.use('/albums', albumsRouter);
app.use('/photos', photosRouter);
app.use('/conversations', conversationsRouter);
app.use('/templates', templatesRouter);
app.use('/responses', responsesRouter);
app.use('/clients', clientsRouter);

app.use(errorHandler);

export default app;

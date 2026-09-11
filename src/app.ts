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

const app = express();

// ── Global middleware ─────────────────────────────────────────
// helmet sets security-related HTTP response headers
app.use(helmet());

// cors allows browsers to make requests from other origins.
// In production, restrict this to your frontend domain.
app.use(cors());

// Parse incoming JSON request bodies.
// Without this, req.body is always undefined.
app.use(express.json());

// ── Health check ──────────────────────────────────────────────
// Simple endpoint used by the AWS ALB to confirm the server is alive.
// Mounted before auth — the ALB has no JWT to send.
// Returns 200 with no body — that's all the load balancer needs.
app.get('/health', (_req, res) => {
  res.sendStatus(200);
});

// auth verifies the JWT and attaches the decoded payload to req.auth.
// loadUser resolves it to the full DB user and attaches it to req.user.
// Both call next(err) on failure, handled by errorHandler below.
app.use(auth);
app.use(loadUser);

// ── Routes ────────────────────────────────────────────────────
// Mount your routers here as you build them.
// (nothing mounted yet — start with users)

// TODO: remove before shipping — triggers errorHandler with different error shapes
app.get('/test-error', (_req, _res, next) => {
  const err = Object.assign(new Error('something went wrong'), { status: 422 });
  next(err);
});

app.use(errorHandler);

export default app;

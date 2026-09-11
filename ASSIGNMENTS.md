# Photography App — Implementation Assignments

8 phases. Each one depends on the previous being solid before you move on.

**Ground rules (from your own architecture doc):**

- Write it yourself first. Route signature → logic → run it → hit the error → fix it.
- Ask Claude to _review_ after the fact, not to write it for you.
- Ask _why_ for every suggestion. Never accept a change you can't explain.

---

## Phase 1 — Middleware

> The skeleton everything hangs on. Build this before writing a single route.

### 1.1 — Error Handler `src/middleware/errorHandler.ts`

- [ ] Accepts 4 arguments `(err, req, res, next)` — this signature is what makes Express recognise it as an error handler
- [ ] Returns a consistent JSON shape: `{ error: string }`
- [ ] Defaults to `500`; reads `err.status` or `err.statusCode` if present
- [ ] In `development`: includes `err.message`. In `production`: returns a generic message for 500s
- [ ] Mounted in `src/app.ts` **after** all routes
- [ ] **Test:** add a temporary route that throws, confirm JSON comes back instead of a crash

### 1.2 — Auth Middleware `src/middleware/auth.ts`

- [ ] Extracts `Authorization: Bearer <token>` header
- [ ] Verifies the JWT against Auth0 (use `express-oauth2-jwt-bearer` or `jwks-rsa` + `express-jwt`)
- [ ] On success: attaches decoded payload to `req.user`
- [ ] On failure: calls `next(err)` with a 401 — lets the error handler deal with it
- [ ] Extend Express's `Request` type in `src/types/express.d.ts` using declaration merging so `req.user` is typed

### 1.3 — Role Guard `src/middleware/requireRole.ts`

- [ ] Factory function: `requireRole(UserRole.photographer)` returns middleware
- [ ] Returns 403 if the caller's role doesn't match
- [ ] **Design decision to make first:** the JWT gives you an Auth0 `sub`, but the role lives in the DB. Decide whether `auth.ts` fetches the full DB user and attaches it, or whether `requireRole` does the lookup. Pick one and be consistent.

---

## Phase 2 — Users & Profiles

> Every FK in the system traces back here. Nothing else can exist without these records.

### 2.1 — Webhook Handler `POST /users`

- [ ] Creates `src/routes/users.ts` and `src/db/queries/users.ts`
- [ ] Verifies the Auth0 webhook signature using `AUTH0_WEBHOOK_SECRET` before trusting the payload
- [ ] Opens a DB transaction and atomically inserts:
  - A row in `users`
  - A row in `photographers` (if role = photographer)
- [ ] Commits or rolls back as a unit — use `BEGIN` / `COMMIT` / `ROLLBACK` with a checked-out pool client
- [ ] Returns `201` on success
- [ ] **Test:** POST a fake payload, confirm rows in both tables via `psql`

### 2.2 — Photographer Profile `GET /photographers/:id` · `PATCH /photographers/:id`

- [ ] `GET`: protected by auth middleware. Returns the same response shape to every caller — no fields are private (D-18)
- [ ] `PATCH`: requires auth + `requireRole(photographer)`. Verifies the `:id` in the URL matches the caller's own ID — don't trust the URL alone
- [ ] Add `GET /photographers/:id/clients` and `GET /photographers/:id/albums` while you're here

### 2.3 — User Management `PATCH /users/:id` · `DELETE /users/:id`

- [ ] Both require auth
- [ ] `DELETE`: remove the `users` row — `ON DELETE CASCADE` in the schema handles the rest. Verify in psql that the photographer row disappears too.

---

## Phase 3 — Invites & Client Onboarding

> Clients are invite-only. There is no other path to create a client. This phase unlocks all client-facing features.

### 3.1 — Create Invite `POST /invites`

- [ ] Requires auth + `requireRole(photographer)`
- [ ] Generates a cryptographically random token: `crypto.randomBytes(32).toString('hex')`
- [ ] Sets `expires_at = NOW() + 30 days`
- [ ] Inserts into `invites` with `status = pending`
- [ ] Returns the token in the response (stands in for email sending for now)

### 3.2 — Validate Invite `GET /invites/validate?token=...`

- [ ] **Public endpoint** — no auth required
- [ ] Returns `404` if token not found
- [ ] Returns `410 Gone` if status is `accepted` or `expired`
- [ ] Returns `410` if `expires_at` is in the past — also update status to `expired` at this point
- [ ] Returns invite data (`email`, `client_name`, `photographer_id`) on success

### 3.3 — Invite Acceptance _(the hardest transaction in the app)_

- [ ] Triggered when a client completes signup via an invite link
- [ ] Single DB transaction atomically creates **all four**:
  1. Row in `users` (role = client)
  2. Row in `clients` (linked to `photographer_id` from the invite)
  3. Row in `conversations` (auto-created per D-20)
  4. Update invite: `status = accepted`, `accepted_at = NOW()`
- [ ] If any insert fails, all four roll back — no partial state
- [ ] **Test thoroughly:**
  - `users` has the new client ✓
  - `clients` links to the correct photographer ✓
  - `conversations` row exists linking the pair ✓
  - Invite status is `accepted` ✓
  - Calling validate again on the same token returns 410 ✓

### 3.4 — Remaining Invite Endpoints

- [ ] `POST /invites/:id/resend` — generate new token, reset `expires_at`, keep status `pending`
- [ ] `DELETE /invites/:id` — cancel the invite
- [ ] `GET /photographers/:id/invites` — list pending invites for a photographer

---

## Phase 4 — Albums & Photos

> Core product feature. Photographers need to exist (Phase 2) before this works.

### 4.1 — Album CRUD

- [ ] `POST /albums` — photographer only. Compute `access_expires_at = shoot_date + 3 years` **server-side** — do not accept it from the request body. Shoot albums only: portfolio albums are created with `null` and never expire (migration 020)
- [ ] `GET /albums/:id` — both roles. A client may only view albums where `client_id` matches their own ID
- [ ] `PATCH /albums/:id` — photographer only, own albums only
- [ ] `DELETE /albums/:id` — photographer only

### 4.2 — Batch Photo Upload `POST /albums/:id/photos/batch`

- [ ] Accepts multipart file uploads — add `multer` for this
- [ ] For each file: inserts a `photos` row with `status = processing`
- [ ] Enqueues a `ProcessBatch` job on `photoQueue` with the photo IDs
- [ ] Returns `202 Accepted` immediately — **does not wait for Cloudinary**

### 4.3 — Remaining Photo Endpoints

- [x] `GET /albums/:id/photos` — **paginated**: accept `?page=&limit=` query params. `OFFSET = (page - 1) * limit`
- [x] `DELETE /albums/:id/photos/batch` — bulk remove from album
- [x] `POST /albums/:id/photos/:id` — add an existing photo to an album
- [x] `DELETE /albums/:id/photos/:id` — remove photo from album only (not from system)
- [x] `GET /photos/:id` — single photo
- [x] `DELETE /photos/:id` — permanently delete from system

---

## Phase 5 — Background Jobs

> Photos are sitting in the DB with `status = processing`. Time to actually process them.

### 5.1 — BullMQ Worker `src/jobs/worker.ts`

- [ ] Creates a BullMQ `Worker` instance subscribed to `photoQueue`
- [ ] Dispatches each job to the processor (5.2)
- [ ] Add `"worker": "ts-node src/jobs/worker.ts"` to `package.json` scripts — runs separately from the API

### 5.2 — Photo Processor `src/jobs/processors/photoProcessor.ts`

- [ ] Handles `PhotoJobName.ProcessBatch` jobs
- [ ] For each photo ID in `job.data.photoIds`:
  - Uploads the file to Cloudinary
  - Uses the returned `public_id` as `base_path`, and the returned `width`/`height` as-is
  - Updates the `photos` row: sets `base_path`, `width`, `height`, sets `status = ready`

### 5.3 — Expiry Scheduler + Processor

- [ ] `src/jobs/schedulers/expiryScheduler.ts` — registers 4 repeating cron jobs on `expiryQueue`:
  - `warn-90-days`, `warn-30-days`, `warn-7-days`, `delete-expired`
  - Daily schedule: `0 8 * * *` (08:00 UTC)
  - Called once at worker startup
- [ ] `src/jobs/processors/expiryProcessor.ts` — for each job:
  - Queries albums where `access_expires_at` is within the warning window **and** the relevant `warned_*_at` is NULL. Portfolio albums carry a NULL expiry, so the comparison excludes them on its own — no `type` predicate needed
  - Emails the album's client, **then** sets `warned_*_at = NOW()` — a failed send leaves the column NULL so the next daily run retries, rather than recording a warning nobody received
  - An album whose client was deleted has nobody to warn: mark it warned anyway, or the deletion gate below holds it forever
  - For `delete-expired`: only touches albums with `warned_7_at IS NOT NULL` — deletion is irreversible, so an album that never got its final warning waits. Deletes files from Cloudinary, then deletes album rows from DB

---

## Phase 6 — Caching

> Endpoints work and are tested. Now layer caching on top — behaviour stays identical, it just gets faster.

### 6.1 — Cache Album Read Endpoints

- [ ] `GET /albums/:id` — key `album:meta:{id}`, TTL 900s
- [ ] `GET /albums/:id/photos` — key `album:photos:{id}`, TTL 300s
- [ ] Pattern: check cache → on miss query DB → write to cache → return result

### 6.2 — Cache Invalidation on Mutations

- [ ] `PATCH /albums/:id` → `cache.del('album:meta:{id}')`
- [ ] Photo added or removed → `cache.del('album:photos:{albumId}')`

### 6.3 — Photographer Profile Cache

- [ ] `GET /photographers/:id` — key `photographer:profile:{id}`, TTL 3600s
- [ ] `PATCH /photographers/:id` → invalidate, or rely on TTL expiry (your call — both are defensible)

---

## Phase 7 — Messaging

> Conversations were auto-created in Phase 3. Now you build the read and write paths on top of them.

### 7.1 — Conversation List `GET /conversations`

- [x] **Identity-scoped** — filter by JWT identity, not a URL param (D-17)
- [x] Photographer sees all conversations. Client sees their single conversation.
- [x] Sort by `last_message_at DESC NULLS LAST` — this denormalised field exists specifically so you don't need a subquery here. `NULLS LAST` matters: Postgres sorts nulls first under `DESC`, and a conversation with no messages yet has a null `last_message_at`
- [x] Cache: key `conversations:{userId}`, TTL 120s. Invalidate when a new message is sent, and when a conversation is marked read.
- [x] `GET /conversations/:id` — single conversation

### 7.2 — Message Endpoints

- [x] `GET /conversations/:id/messages` — paginated (same pattern as photos)
- [x] `POST /conversations/:id/messages` — send a message:
  - Insert into `messages`
  - Update `conversations`: set `most_recent_message_id`, update `last_message_at`, and increment **only the recipient's** counter — `unread_for_photographer` when the client sent it, `unread_for_client` when the photographer did (migration 017 split the old shared `number_of_unread` in two, so a sender's own messages no longer inflate the badge they see)
  - Invalidate conversation list cache for **both** participants
- [x] `PATCH /conversations/:id/read` — mark the whole conversation as read:
  - Zero **only the caller's** counter — read state is tracked per conversation, not per message
  - Authorise before mutating: load the conversation, 404/403 first, then write
  - Invalidate the conversation list cache for the caller (`conversations:{userId}`) — the cached list carries the unread counters
  - **Think about this:** setting `= 0` in one SQL statement is both atomic and idempotent, so two concurrent "mark read" requests can't corrupt the count. Compare that to a per-message `- 1`, which has to be exactly right every time or the badge drifts — why is the whole-conversation version so much harder to get wrong?
  - Optional: a mark-as-_unread_ direction (`{ read: false }`). Note the tradeoff — there's no count to restore, so the counter becomes a has-unread flag rather than an exact count.

---

## Phase 8 — Forms

> Self-contained. No dependencies on Phases 5–7. Left last because it doesn't block testing any core flows.

### 8.1 — Template CRUD

**Decided up front:**

- **A template and its questions are created in one request, and edited by replacing the whole set.** There is no such thing as adding, editing, or deleting a single question — the photographer builds the form in the UI and submits it whole. This is what makes `"order"` trivial: it is the index of the submitted array. Nothing computes `MAX("order") + 1`, so the read-then-write race that plagues incremental ordering never arises, and reordering is just resubmitting the array in a different sequence.
- **Templates are always editable; only deletion is blocked.** Migration 019 made responses snapshot the questions they were assigned, so a replace-all `PUT` can recreate question rows without affecting any form already in a client's hands. `DELETE` still returns `409` while responses exist — not to protect question ids, but because a response is a standalone record that must outlive its template. `form_responses.template_id` is `ON DELETE RESTRICT`, so the database enforces it; the `409` is the error message on top of the constraint, which is why it is a state conflict rather than a `403`.
- **The delete check is one existence query** — `SELECT 1 FROM form_responses WHERE template_id = $1`, `templateHasResponses` in `db/queries/templates.ts`. It used to guard `PUT` as well; that caller is gone.
- **Max 25 questions per template.** Rejected with `400` before any transaction opens, so one request can't insert unbounded rows.
- **`multiple_choice` is gone from `answer_type`** (migration 018) — the enum offered it but `form_questions` has nowhere to store the choices, so such an answer could never be validated against anything.
- **Templates are not cached in this phase.** They're read-heavy and now near-immutable, so they'd cache well — but add it only if the read path actually shows up hot, not on spec.

- [x] `POST /templates` — creates the template *and all of its questions* in one transaction (same shape as the invite-acceptance transaction in Phase 3: insert parent, insert children, commit or roll back as a unit):
  ```
  { "name": "Wedding intake", "questions": [
      { "content": "What time is the ceremony?", "answerType": "text" },
      { "content": "Date of the shoot?",         "answerType": "date" }
  ]}
  ```
  - `"order"` is written as the array index — 0-based and dense by construction. Migration 018 adds `UNIQUE (template_id, "order")` to enforce it
  - Validate the body with `zod` (already a dependency, see `src/config/env.ts`): non-empty `name`, 1–25 questions, non-empty `content` on each, `answerType` within the enum. One parse, `400` before the transaction opens
- [x] `GET /templates/:id` — embeds its questions in `"order"` sequence (`{ ...template, questions: [...] }`). A template without them can't render a form, and there is no separate questions endpoint
- [x] `GET /photographers/:id/templates` — list a photographer's own templates. In the architecture doc's endpoint table but was missing from this phase; without it a photographer can't find their templates at all
- [x] `PUT /templates/:id` — replace name + full question set, in one transaction: delete the existing questions, insert the new array. No lock check
  - **Why `PUT` and not `PATCH`:** the body is the complete new state of the template, not a diff of changed fields
- [x] `DELETE /templates/:id` — `409` while any response references it. `ON DELETE CASCADE` on `form_questions.template_id` (migration 010) removes the questions

### 8.2 — Response Lifecycle

**Decided up front:**

- **A response is self-contained (migration 019).** It carries a frozen copy of its template's questions in a `questions` JSONB column, taken at assign time, and its answers in an `answers` JSONB object keyed by question id. It renders without ever reading `form_questions`, which is what frees templates to be edited afterwards.
- **Saving an answer is a JSONB merge.** `POST /responses/:id/answers` does `SET answers = answers || jsonb_build_object($2, $3)`, so one key is inserted-or-overwritten in a single expression and a save-as-you-go client can re-send the same question without tracking what it has already saved. `PATCH /responses/:id/answers/:id` is therefore dropped — it has been removed from the architecture doc's endpoint table too.
- **The submitted-form lock lives in the SQL, not the handler.** Both write statements carry `AND submitted_at IS NULL`, so a submit landing between the handler's `409` check and the write cannot be written past — the check-then-write gap is closed rather than narrowed. A `null` return means "not writable"; the handler, which loaded the row moments earlier, turns it into a `409`.
- **Submit does not require a complete form.** An unanswered question simply has no key in `answers`; there is no `required` concept. Submit only flips `submitted_at`.
- **The same template may be assigned to the same client more than once.** No `UNIQUE (template_id, client_id)` on `form_responses` — each assignment is its own instance (one questionnaire per shoot), distinguished by `assigned_at`. (Renamed from `started_at` in migration 019: it is set when the photographer assigns, not when the client starts.)
- **Who can read a response:** the client it belongs to, plus the photographer who owns the underlying template — `form_responses` has no `photographer_id`, so that check is a join through `form_templates`. Anyone else gets `403`. Same rule for `GET /clients/:id/responses`. Write access is narrower: the client alone, since a photographer may read a response but never answer it.

- [x] `POST /templates/:id/responses` — photographer assigns template to a client. One `INSERT ... SELECT` that creates the row and snapshots the questions in the same statement, with `submitted_at = NULL`
- [x] `GET /responses/:id` — view a response (owning client or the template's photographer, see above). One query: the row carries the questions and the answers
- [x] `POST /responses/:id/answers` — client saves an answer (merge, see above). Validate that the `questionId` is in this response's own snapshot — an array lookup, not a query — and reject if `submitted_at` is already set
- [x] `PATCH /responses/:id/submit` — client submits. Set `submitted_at = NOW()`. After this, the response is locked: no further answer writes
- [x] `GET /clients/:id/responses` — list all responses for a client, as summaries without the question snapshots

### 8.3 — Client album access (not in the original phases)

`GET /clients/:id/albums` was in the architecture doc's endpoint table but was
never assigned to a phase. Without it a logged-in client has no way to find
their own galleries: `GET /albums/:id` needs an id they already have, and
`GET /photographers/:id/albums` is photographer-only.

- [x] `GET /clients/:id/albums` — the client themselves or their photographer, via the same `assertCanReadClient` check as `GET /clients/:id/responses`. Newest shoot first, no expiry filter (`GET /albums/:id` applies none either)

### 8.4 — Frontend prerequisites (not in the original phases)

Two more endpoints the architecture doc listed but no phase assigned, both
needed before a frontend can be built.

- [x] `GET /users/me` — the caller's own `User` row, so the frontend can learn its app user id and role after Auth0 login. Reads what `loadUser` already resolved; no DB call of its own. Registered before any `GET /:id` on the users router, or Express matches `me` as an id (D-26)
- [x] `POST /photographers/:id/photo` — synchronous, unlike the album photo batch: one small file, no derivative work, and the caller expects to see it immediately. Deterministic Cloudinary `public_id` with `overwrite`, so replacing an avatar replaces the same asset instead of orphaning the old one. Invalidates `photographer:profile:{id}` — the profile is cached for an hour

Still unbuilt: `DELETE /users/:id` (assigned in 2.3). It cascades across nine
tables, and `albums.client_id` is `ON DELETE SET NULL`, so deleting a client
leaves their shoot albums alive but unwarnable — the case the expiry pipeline
handles by marking them warned with no recipient.

---

## Quick Reference

| Phase | What you're building | Key concept to understand                                                     |
| ----- | -------------------- | ----------------------------------------------------------------------------- |
| 1     | Middleware           | Express error handler signature; JWT verification; factory middleware pattern |
| 2     | Users & profiles     | Auth0 webhook pattern; atomic DB transactions; role-scoped responses          |
| 3     | Invites & onboarding | Multi-table transaction; one-time tokens; invite state machine                |
| 4     | Albums & photos      | 202 Accepted pattern; file uploads with multer; pagination                    |
| 5     | Background jobs      | Queue vs Worker vs Processor; cron scheduling; async photo pipeline           |
| 6     | Caching              | Cache-aside pattern; TTL selection; event invalidation                        |
| 7     | Messaging            | Identity-scoped queries; denormalised counters; atomic SQL updates            |
| 8     | Forms                | State machine (in-progress → submitted); cross-entity validation              |

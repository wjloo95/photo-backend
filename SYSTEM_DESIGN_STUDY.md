# The Photography Platform, as a System Design Interview

> A study document. It treats this repository as the *answer* to an interview
> prompt, and works backwards through every decision that produced it — what
> the constraint was, what we chose, what it cost, and what would make us
> choose differently.
>
> Companion document: [PROJECT_DEEP_DIVE.md](PROJECT_DEEP_DIVE.md) — how to
> talk about this project when the interviewer asks you to walk through
> something you built.

---

## How to use this document

Read it once end to end. After that, use it in three modes:

1. **Recall.** Cover the "Decision" column of any table and reconstruct it from
   the constraint alone.
2. **Attack.** Read [§8 Where this design breaks](#8-where-this-design-breaks)
   and try to find one thing it missed. Every weakness listed there is real and
   findable in the code.
3. **Drill.** Work [§10 Opinion-forming drills](#10-opinion-forming-drills)
   cold, on paper, before reading the notes. That section is the actual point of
   the document.

The skill being trained is not recall of this design. It is the ability to take
a requirement you have never seen and derive a defensible position in ninety
seconds. Everything before §10 exists to give you worked examples of that move.

---

## Table of contents

1. [The prompt, and how to open it](#1-the-prompt-and-how-to-open-it)
2. [Requirements, and what they actually constrain](#2-requirements-and-what-they-actually-constrain)
3. [The back-of-envelope that decides the architecture](#3-the-back-of-envelope-that-decides-the-architecture)
4. [The five opinions this design is built on](#4-the-five-opinions-this-design-is-built-on)
5. [The data model](#5-the-data-model)
6. [The subsystems](#6-the-subsystems)
7. [The hard tradeoffs, argued both ways](#7-the-hard-tradeoffs-argued-both-ways)
8. [Where this design breaks](#8-where-this-design-breaks)
9. [Scaling: what fails, in what order](#9-scaling-what-fails-in-what-order)
10. [Opinion-forming drills](#10-opinion-forming-drills)
11. [Decision index](#11-decision-index)

---

## 1. The prompt, and how to open it

**The prompt:** *Design the backend for a photography platform. Photographers
upload client galleries and portfolios, message their clients, and send them
intake questionnaires. Clients view and download their photos. Client access to
a shoot is time-limited.*

### Classify the problem before you design it

The first ninety seconds of a system design interview are spent deciding what
kind of problem you have. Most candidates pattern-match to the nearest famous
system and inherit its problems. This one looks like a photo product, so the
reflex is "Instagram" — feeds, fanout, follower graphs, hot keys.

That reflex is wrong here, and saying so is the first point you score.

| Instagram-shaped problem | This problem |
|---|---|
| Social graph, unbounded fanout | Ownership **tree**: one photographer → N clients → 1 album each. Fanout is 1. |
| Hot content read by millions | Every album is read by exactly two people, ever. No hot keys. |
| Feed ranking, timeline assembly | No feed. Every read is "give me the thing I already own." |
| Write throughput at ingest | Writes are bursty but rare: one photographer, one shoot, once. |
| Data lives forever | **Data must be destroyed on a schedule, irreversibly.** |
| Authorization is coarse (public/private/friends) | Authorization is a chain: photo → albums → album owner → caller. |

So the honest classification is: **a low-fanout, read-heavy CRUD system whose
difficulty is concentrated in data lifecycle, authorization chains, and
asynchronous media processing — not in throughput.**

Once you say that out loud, the whole design follows, and you have earned the
right to *not* talk about sharding for forty minutes.

### The four things that are actually hard

1. **Irreversible deletion on a schedule.** Photos are deleted permanently three
   years after the shoot. There is no undo. Every design decision downstream of
   this is about making sure the deletion only happens when it is supposed to.
2. **Authorization has no single owner column.** A photo has no `owner_id`. Its
   access is derived through every album it currently belongs to. A form response
   has no `photographer_id`; the photographer's claim runs through the template.
3. **Uploads are bursty and unbounded.** A wedding is 500 files and 2 GB in one
   request. Nothing about that request may be synchronous.
4. **Two roles, one API.** Almost every endpoint serves both a photographer and a
   client, and they pass the same check by different columns.

---

## 2. Requirements, and what they actually constrain

Interview technique: don't just list requirements — write down what each one
*forbids*. A requirement that forbids nothing is not a requirement, it's
decoration.

### Functional

| Requirement | What it forbids |
|---|---|
| Photographers upload photos into albums | Forbids a synchronous upload path. 500 files cannot block a request. |
| Clients view and download their album | Forbids serving bytes from the app tier. Bytes go to a CDN. |
| Photographer ↔ client messaging | Forbids `COUNT(*)` on messages per inbox load. Needs denormalised counters. |
| Questionnaires assigned to clients | Forbids a form changing under a client who is mid-answer. |
| Invite-only client onboarding | Forbids any other path to a `clients` row. There is no self-signup. |
| Client access expires and data is deleted | Forbids "just soft-delete it" — storage cost is the reason the policy exists. |

### Non-functional

| Requirement | What it forbids | Decision it forces |
|---|---|---|
| Read-heavy | Forbids optimising the write path first | Cache-aside, denormalisation, pagination (D-01, D-14) |
| Durability over availability (CP) | Forbids eventual-consistency stores for photo metadata | Postgres, ACID, no "eventually the album exists" (D-02) |
| Millions of users, horizontal scale | Forbids server-local session state | Stateless Express behind an ALB; JWT auth (D-22) |
| 3-year photo TTL, hard delete | Forbids unbounded storage growth *and* forbids a silent deletion | Expiry pipeline with a warning gate (D-03, D-04, D-25) |

The last row is the one worth memorising. The TTL and the warning gate are the
same decision seen from two sides: the TTL exists to bound cost, and the gate
exists because the mechanism that bounds cost is also the mechanism that can
destroy a customer's wedding photos.

---

## 3. The back-of-envelope that decides the architecture

Most estimation in interviews is theatre — a QPS number nobody uses again. Here
the numbers change the design, so do them.

### Assumptions (state them, then compute)

- 100,000 photographers on the platform.
- Each does ~30 shoots/year, ~400 photos/shoot.
- Three variants per photo (original ~5 MB, standard ~1 MB, thumbnail ~50 KB) ≈
  **6 MB stored per photo**.
- Each photographer has ~50 clients.

### Storage — the number that justifies the whole product policy

```
photos/year   = 100,000 × 30 × 400        ≈ 1.2 billion
new bytes/yr  = 1.2e9 × 6 MB              ≈ 7.2 PB / year
steady state  = 7.2 PB × 3 (the TTL)      ≈ 21 PB
```

At roughly $0.023/GB/month for commodity object storage, 21 PB is on the order of
**$480,000 per month** — and that is the *bounded* number. Without the TTL it
grows by ~$165k/month every year, forever.

Three conclusions fall straight out, and each is a decision you can now defend
with arithmetic rather than taste:

1. **The 3-year TTL is the highest-leverage decision in the system** (D-03). It
   is not a product nicety; it is the only thing standing between this business
   and an unbounded liability.
2. **Storage tiering is the obvious first cost lever** — and it is exactly the
   post-MVP item F-02 (paid extension), which is now a *revenue* answer to a
   *cost* problem.
3. **The database is nowhere near the expensive part.** 1.2B rows/year in
   `photos` is large but ordinary; 7 PB/year of bytes is not. This is why the
   bytes live in Cloudinary and only a key lives in Postgres (D-05).

### Traffic — the number that justifies a small app tier

```
clients          = 100,000 × 50           = 5,000,000
sessions/client  ≈ 7 / year (they look at their gallery a handful of times)
sessions/year    = 35,000,000             ≈ 1.1 / second
API calls/session≈ 10
→ steady-state API load                   ≈ 11 QPS
```

Even with a 100× peaking factor and a 10× growth assumption, the JSON API is in
the low thousands of QPS. **The API tier is not, and will never be, the
bottleneck** — because the thing that is genuinely high-volume (image bytes)
never touches it. A gallery page is one metadata call, one photo-list call, and
then 400 image requests that go straight to a CDN.

This is the payoff of D-05/D-06: by pushing bytes to Cloudinary you have moved
the scaling problem to somebody whose business is that problem, and what's left
is a modest JSON service. It is why "one EC2 instance behind an ALB" is a
defensible MVP posture and not a cop-out (D-22, D-23).

> **Interview line:** "The read volume that would scare you never reaches my
> servers. What reaches my servers is the *write burst* — 500 files, 2 GB, one
> request — and that's what the 202 and the queue are for."

### The real load spike

A wedding upload is ~2 GB in a single multipart request. That is the largest
single thing this system does, it is memory-shaped rather than CPU-shaped, and it
is the reason the upload path is async and the reason there is a per-file size cap
(25 MB, `src/routes/albums.ts`). It is also, as [§8](#8-where-this-design-breaks)
shows, where the current implementation has its sharpest architectural flaw.

---

## 4. The five opinions this design is built on

Everything else is downstream of these. If you can only remember five things,
remember these — and remember that each is an *opinion*, meaning a reasonable
engineer could hold the opposite and you should be able to say why they'd be
wrong *here*.

### Opinion 1 — Consistency over availability, because the failure modes aren't symmetric

**Stance (D-02):** CP. Photo loss is unacceptable; downtime is tolerable.

**Why:** A photographer whose gallery is briefly unavailable sends an apologetic
email. A photographer whose client's wedding photos silently vanished loses the
business and possibly gets sued. The costs of the two failures differ by orders of
magnitude, so you buy down the expensive one with the cheap one.

**What it buys:** ACID transactions, foreign keys, and the freedom to write
"insert four rows or none" and mean it.

**When it flips:** If the product added a public portfolio browsing surface with
millions of anonymous readers, *that* read path is AP-shaped — a stale portfolio
is harmless — and you'd split it out rather than inheriting the CP posture
everywhere.

### Opinion 2 — Buy the parts where you have no edge

**Stance (D-05, D-06, D-07, D-09, D-10):** Cloudinary for image storage,
processing and delivery. Auth0 for identity. RDS for Postgres. ElastiCache for
Redis.

**Why:** Image resizing is spiky, CPU-bound work that would crater a Node process
during a 500-photo burst. Authentication is security-critical infrastructure with
a long tail of things to get wrong (hashing, rotation, brute-force, token
refresh). Neither is where this product differentiates.

**What it costs:** Vendor lock-in, per-usage pricing, and **two-system
consistency problems you now own forever** — a `photos` row can point at a
Cloudinary asset that no longer exists, and an Auth0 account can exist with no
`users` row. Both are real in this codebase.

**When it flips:** Cloudinary at 21 PB is a line item worth a migration to an
S3 + Lambda pipeline. The trigger is a spreadsheet, not an opinion.

### Opinion 3 — Invariants belong in the database

**Stance:** If a rule must always hold, express it as a constraint, not as a
check in a handler. The handler's job is to turn the constraint's violation into
a good error message.

**Where this shows up:**

| Rule | Enforcement | Migration |
|---|---|---|
| A shoot album always expires; a portfolio album never does | `CHECK (type='shoot' AND access_expires_at IS NOT NULL) OR (type='portfolio' AND access_expires_at IS NULL)` | 020 |
| A response outlives its template | `FOREIGN KEY … ON DELETE RESTRICT` | 019 |
| Question order is dense and unique per template | `UNIQUE (template_id, "order")` | 018 |
| One photographer profile per user | `user_id` is both PK and FK | 002 |
| One conversation per photographer/client pair | `UNIQUE (photographer_id, client_id)` | 007 |
| A photo is in an album at most once | composite PK `(photo_id, album_id)` | 006 |

**Why:** A handler check protects the one code path that runs it. A constraint
protects every path, including the migration you write at 2 a.m. and the
backfill script that isn't in the repo. `DELETE /templates/:id` still does an
existence check — but only to produce a `409` with an explanation *on top of* a
constraint that would refuse the delete regardless.

**What it costs:** Every rule change is a migration. Constraint violations arrive
as driver errors that must be translated, or they surface as unlabelled 500s.

### Opinion 4 — Irreversible actions need a gate, not a warning

**Stance (D-24, D-25):** The three warning emails are not courtesy. `warned_7_at`
is a **precondition for deletion**.

**Why:** D-04 justifies permanent deletion by citing the warning pipeline as the
mitigation. That mitigation is only real if a broken pipeline *stops* the
deletion. Otherwise a mail outage through the run-up means silent, permanent,
uncompensated data loss — the exact failure the pipeline was cited to prevent.

Two sub-decisions carry it:

- **Send, then mark.** `emailSender.send(...)` completes before `warned_*_at` is
  written. Marking first would be *at-most-once* delivery: a provider timeout
  flags the album as warned, nobody hears anything, and the album is deleted on
  schedule. Sending first is *at-least-once*: a failure throws, the mark is
  skipped, tomorrow's run retries. The worst case becomes a duplicate email.
- **`warned_7_at IS NOT NULL` in the deletion query.** Not in the processor — in
  the SQL that selects candidates.

**What it costs:** A prolonged mail outage defers deletions, and storage cost with
them. That needs monitoring: *albums past expiry still awaiting a warning* is the
alert.

**The subtle part:** the column asserts that the *step completed*, not that a
human read anything. A shoot album whose client was deleted (`client_id` is
`ON DELETE SET NULL`) has nobody to warn and never will. It is marked warned with
no send — otherwise the gate would preserve that album, and its 2 GB of
Cloudinary assets, forever. **A safety gate with no escape hatch becomes a leak.**

### Opinion 5 — A record must outlive the thing it came from

**Stance (migration 019):** A form response snapshots its template's questions at
assign time and stores answers keyed by question id, in JSONB on the response
row.

**Why:** A template is a *drafting surface*. A response is a *record of what a
specific person was asked and what they said*. Coupling them means editing the
draft rewrites history.

This is the single best architectural story in the project, and
[§7.2](#72-snapshot-vs-normalise-the-form-model) tells it properly.

---

## 5. The data model

11 entities, in dependency order:

```
users
 ├── photographers ──┬── albums ──┬── photo_albums ── photos
 │                   │            └── (thumbnail_photo_id)
 │                   ├── conversations ── messages
 │                   ├── form_templates ── form_questions
 │                   └── invites
 └── clients ────────┴── form_responses
```

### Conventions, and the reason for each

| Convention | Reason |
|---|---|
| UUID PKs (`gen_random_uuid()`) | IDs are generated client-of-the-DB-side and are not guessable or enumerable. Sequential integers would let a caller walk `/albums/1..n`. |
| `TIMESTAMPTZ` everywhere | The expiry pipeline compares against `NOW()` across deploy regions. A naive `TIMESTAMP` makes that comparison silently wrong. |
| snake_case in DB, camelCase in TS, one mapper per table | The boundary is explicit and testable. Every query file has `interface XRow` + `function toX(row)`. |
| Nullable DB column ⇒ `T \| null` in TS | Nullability is part of the type, so a missed null check is a compile error, not a 500. |
| FK columns are indexed manually (migration 014) | **Postgres does not index foreign keys automatically.** This is the single most common performance bug in a Postgres schema. |

### The 1:1 trick worth stealing

`photographers.user_id` and `clients.user_id` are **both the primary key and the
foreign key** to `users`. This enforces the 1:1 relationship in the schema: you
physically cannot create two photographer profiles for one user. The alternative
— a separate `id` plus a `UNIQUE (user_id)` — expresses the same rule with one
more column and one more thing to get wrong.

Consequence worth knowing: *a photographer's id is their user id*. That is why
`req.user.id` is compared directly against `album.photographerId` throughout the
codebase, with no lookup in between.

### Denormalised fields, and the rule for when to add one

`conversations` carries three fields that are derivable from `messages`:

- `most_recent_message_id` — avoids a correlated subquery for the inbox preview
- `last_message_at` — avoids the same for inbox sort order
- `unread_for_photographer` / `unread_for_client` — avoid `COUNT(*)` per row

**The rule:** denormalise when the derived value is read on a hot path far more
often than the source is written, *and* every writer of the source is in your
control. The inbox is loaded on every app open; a message is sent occasionally.
Both writers (`sendMessageByConversation`, `markConversationAsRead`) live in one
file.

**The cost, stated honestly:** these counters can drift, and there is no
reconciliation job. Migration 017 is literally a recovery from that class of bug
— see [§7.3](#73-denormalised-counters-and-the-bug-that-produced-migration-017).

### The evolution log — 20 migrations as a design record

The migrations are not incidental. Six of them are the design *changing its
mind*, and each is a story worth being able to tell:

| Migration | Change | The lesson |
|---|---|---|
| 015 | `photographers.business_name` → `users.name` | A field shared by both roles belongs on the shared table, not the role table. |
| 016 | Add `photos.width/height`, nullable | Fields the *processor* discovers are nullable for the same reason `base_path` starts as `''`. |
| 017 | Split `number_of_unread` into two per-participant counters | A counter that can't say "unread *for whom*" is not a counter. |
| 018 | `UNIQUE (template_id, "order")`; drop `multiple_choice` | An enum value with nowhere to store its data is a lie in the schema. |
| 019 | Snapshot questions + answers onto the response; drop `form_answers`; FK → `RESTRICT` | A record must outlive its source. |
| 020 | `access_expires_at` nullable + `CHECK` pairing it with `type` | A modelling error that produced a real product bug: portfolio albums were being deleted. |

> **Interview line:** "I'd rather show you the migrations than the schema. The
> schema tells you what I ended up with; the migrations tell you what I got wrong
> and how I found out."


---

## 6. The subsystems

Six subsystems, each presented as: the constraint, the design, the interesting
decision, and the thing an interviewer will push on.

### 6.1 Authentication and identity

**Constraint:** Identity is managed by Auth0, but every URL in the API is keyed
by our own `users.id` UUID, and authorisation depends on a `role` that Auth0
doesn't know about.

**Design — a two-stage middleware chain:**

```
auth       → express-jwt verifies the RS256 signature against Auth0's JWKS,
             attaches the decoded payload to req.auth  (req.auth.sub = "auth0|abc")
loadUser   → SELECT … FROM users WHERE provider_id = $1
             attaches the full User row to req.user; 401 if absent
requireRole(role) → factory middleware; 403 unless req.user.role matches
```

Both are mounted globally in `app.ts`, *after* the two routers that must run
without a JWT (`/users`, which the Auth0 webhook calls, and `/invites`, whose
`/validate` is public). Those routers re-apply `auth, loadUser` per-route where
they need it, rather than relying on mount order — mount order is a fact about a
file the route handler can't see.

**The interesting decision (D-26): the role lives in the database, not in a JWT
claim.**

Auth0 supports custom claims; putting `role` and `app_user_id` in the token would
remove a database round trip from *every authenticated request*. That is a real
performance argument, and it was rejected.

- The `users` table is the source of truth (D-08, the webhook syncs Auth0 → DB).
  Claims would add a **second sync running the other way**, and two syncs in
  opposite directions is how identity data comes to disagree with itself.
- A role change wouldn't take effect until the token refreshed. There is no way
  to revoke a claim you've already signed.
- Auth-critical logic would move out of the repo and into an Auth0 dashboard,
  where it isn't code-reviewed, isn't tested, and isn't in version control.

The same reasoning produces `GET /users/me`: the frontend calls it once at boot
to learn its own app id and role, rather than reading them from the token.

**What they'll push on:** *"You do a database read on every request. That's a
scaling problem."* — Correct, and the answer is a cache, not a claim:
`user:by-provider:{sub}` with a short TTL, invalidated on role change. That keeps
the DB as the source of truth while removing the round trip. It isn't built, and
at 11 QPS it doesn't need to be. Say that.

**Webhook authenticity:** `POST /users` is HMAC-SHA256 over the **raw request
bytes** — `app.ts` stashes `req.rawBody` via `express.json({ verify })`, because
a parsed-and-re-serialised body will not byte-for-byte match what the sender
signed. Comparison uses `crypto.timingSafeEqual`, with an explicit length guard
because `timingSafeEqual` throws rather than returning false on a length
mismatch.

### 6.2 Invites — a four-row transaction and a row lock

**Constraint (D-19):** Clients are invite-only. There is no other path to a
`clients` row, so the invite acceptance *is* the client creation flow.

**The state machine:**

```
                 POST /invites
                      ↓
                  [pending] ──── expires_at passes ───→ [expired]
                    │  ↑                                    │
     accept         │  └────── POST /:id/resend ────────────┘
                    ↓          (new token, +30d, back to pending)
                [accepted]  ──── resend blocked (409)
```

`GET /invites/validate?token=` is public — the token *is* the credential. It
returns `404` for an unknown token, `410 Gone` for accepted/expired, and lazily
flips a past-due `pending` invite to `expired` so the next lookup short-circuits
on the status check. It deliberately returns only `{ email, clientName,
photographerId }`, not the invite row.

**The interesting decision: `SELECT … FOR UPDATE` inside the acceptance
transaction.**

Accepting an invite creates four things atomically:

1. a `users` row (role = client)
2. a `clients` row, with `photographer_id` **from the invite, never from the
   request**
3. a `conversations` row (D-20 — every client always has a channel)
4. the invite's own `status = 'accepted', accepted_at = NOW()`

The invite is re-loaded inside the transaction with `FOR UPDATE`, rather than
reusing `getInviteByToken`. This is the load-bearing line:

```sql
SELECT * FROM invites WHERE token = $1 FOR UPDATE
```

Without it, two concurrent redemptions of the same token — a double-click, a
retry, a race — both read `status = 'pending'` before either writes `'accepted'`,
and **both get an account**. `FOR UPDATE` holds a row lock for the rest of the
transaction, so the second reader blocks until the first commits and then sees
`'accepted'`. `getInviteByToken` runs on the pool, outside the transaction, and
could not take that lock.

The status and expiry conditions are re-checked here even though `/validate`
checks the same things — nothing guarantees the client called `/validate`, or
that the invite was still valid when they did.

**What they'll push on:** *"Why a lock and not a `UNIQUE` constraint?"* — There
is no single column whose uniqueness expresses "this invite has been redeemed at
most once" across four tables. You could add `UNIQUE (invites.id)` on a
redemption table and let the insert fail, which is the optimistic version. The
pessimistic lock was chosen because the contention is effectively zero (two
people redeem the same invite approximately never), so the lock costs nothing and
reads more obviously.

### 6.3 Photos — the async upload pipeline

**Constraint:** 500 files, 2 GB, one request. Nothing about that can be
synchronous, and nothing about it can be lost.

**The pipeline:**

```
POST /albums/:id/photos/batch
  multer → stages each file on local disk (25 MB/file cap)
  insertPhotosForAlbum(albumId, n)        ← one transaction:
        INSERT n photos (base_path='', status='processing')
        INSERT n photo_albums join rows
  fs.rename(tmp, UPLOAD_TMP_DIR/<photoId>)  ← filename on disk IS the photo id
  photoQueue.add(ProcessBatch, { photoIds, albumId })
  cache.del(`album:photos:{id}`)
  → 202 Accepted, body = the photo rows

  ── worker process, later ──
  for each photoId (isolated by processEachSafely):
     if photo.status === 'ready' → skip          ← idempotent on retry
     cloudinary.upload(UPLOAD_TMP_DIR/<photoId>)
     markPhotoReady(id, { basePath, width, height })   ← flips to 'ready'
     fs.unlink(...)                              ← only AFTER the DB write
```

**Three decisions worth naming:**

1. **The filename on disk is the photo id.** The job payload carries only
   `{ photoIds, albumId }` — no file paths travel through Redis. The worker
   re-derives the path as `path.join(UPLOAD_TMP_DIR, photoId)`. This keeps the
   queue message small and stable, and means a job is fully described by ids.
2. **Ordering is the idempotency strategy.** BullMQ retries the *whole job*, not
   individual photos: a batch of 5 where photo #4 fails re-runs from photo #1.
   The `status === 'ready'` skip makes that safe. And the temp file is unlinked
   only *after* the DB row is confirmed updated — deleting first and then failing
   the write would strand the photo at `'processing'` with no bytes left for a
   retry to find.
3. **`processEachSafely` isolates per item but still fails the job.** Every item
   is attempted; failures are collected; if any failed, the function throws once
   at the end so BullMQ's retry/backoff still applies. This is a small utility
   with an important shape: *partial success must not look like success.*

**Placeholder columns:** `base_path` starts as `''` and `width`/`height` start as
`NULL`, because the real values aren't known until Cloudinary reports them. The
`status` enum is what makes that honest — a `'processing'` row is not a broken
`'ready'` row.

**Authorisation without an owner column.** A photo has no owner. `GET /photos/:id`
resolves access through `getAlbumOwnersForPhoto`, which joins `photo_albums →
albums` and returns every `(photographerId, clientId)` pair the photo currently
belongs to. The same query guards `POST /albums/:id/photos/:photoId` — a
photographer may only link in a photo they already have album access to.
Without that second check, any photographer could pull another photographer's
client photos into their own album by guessing a UUID.

**What they'll push on:** *"Where does the file actually live between the API and
the worker?"* — This is the question that finds the real flaw. See
[§8.1](#81-the-sharpest-flaw-upload-staging-on-local-disk).

### 6.4 Background jobs — queues, workers, and idempotent cron

**The vocabulary** (interviewers check this):

| Term | What it is | Where |
|---|---|---|
| **Queue** | The producer handle. Adds jobs. Lives in the API process. | `src/jobs/queues/` |
| **Worker** | A consumer process subscribed to exactly one queue. | `src/jobs/worker.ts` |
| **Processor** | The function that does the work for one job. | `src/jobs/processors/` |
| **Scheduler** | Registers repeating jobs. Runs once at worker startup. | `src/jobs/schedulers/` |

Two queues: `photoQueue` (triggered by uploads) and `expiryQueue` (four daily
cron jobs). Both configured with `attempts: 3`, exponential backoff,
`removeOnComplete: { age: 86400 }`, `removeOnFail: { count: 100 }`.

**The interesting decision: `upsertJobScheduler`, not `queue.add(..., { repeat })`.**

`worker.ts` calls `registerExpirySchedules()` on every process start — every
deploy, restart, and crash recovery. The `.add()` + `repeat` form has no identity,
so re-registering accumulates duplicate schedules and the job starts firing
several times a day. `upsertJobScheduler` takes a stable `schedulerId` (the job
name), so calling it again *updates* the existing schedule. **Cron registration
must be idempotent because process startup is not a one-time event.**

**Worker-level `'error'` handlers are not optional.** Node's `EventEmitter`
throws an uncaught exception — crashing the process — if `'error'` fires with no
listener. That is different from `'failed'`, which is per-job and merely
unlogged if ignored.

**Why the worker shares the EC2 instance (D-22):** both workloads are I/O bound
and the worker is mostly idle waiting on Cloudinary. The blast radius is small at
MVP scale. This is a cost decision with a stated trigger for reversal — see
[§9](#9-scaling-what-fails-in-what-order), where it is not first on the list.

### 6.5 The expiry pipeline — the most opinionated subsystem

Four cron jobs, all at `0 8 * * *` (08:00 UTC daily): `warn-90-days`,
`warn-30-days`, `warn-7-days`, `delete-expired`.

**The warning query, and why `<=` rather than `=`:**

```sql
SELECT a.*, u.email AS client_email, u.name AS client_name
FROM albums a
LEFT JOIN clients c ON c.user_id = a.client_id
LEFT JOIN users   u ON u.id = c.user_id
WHERE a.access_expires_at <= NOW() + make_interval(days => $1)
  AND a.warned_90_at IS NULL          -- column chosen by the `days` literal
```

Matching the exact day (`= NOW() + 90 days`) would mean an album whose warning
day passed while the worker was down is **skipped forever** — tomorrow it is 89
days out and no longer matches. With `<=`, the condition stays true until
something clears it, and `warned_*_at IS NULL` is the thing that clears it. A
missed run catches up on the next one.

> **Generalisable rule:** a scheduled job's predicate should describe *a state
> that needs fixing*, not *a moment that has arrived*. States are re-observable;
> moments are not.

**Why `LEFT JOIN` and a nullable `clientEmail`:** `albums.client_id` is
`ON DELETE SET NULL`, so deleting a client detaches their shoot albums rather
than removing them. An album can outlive the only person it would ever have been
sent to.

**Why the column name is interpolated and that's fine:** a `$1` placeholder binds
a *value*, never an identifier — a column name cannot travel that way. Safety
comes from the parameter being typed `90 | 30 | 7` and the column name being
chosen from those three literals inside the function. No caller-supplied string
reaches the SQL. Being able to explain *why* an interpolation is safe is worth
more in an interview than reflexively saying "never interpolate."

**The deletion sweep:**

```sql
SELECT * FROM albums
WHERE access_expires_at < NOW()
  AND warned_7_at IS NOT NULL          -- the gate (Opinion 4)
```

Portfolio albums are excluded from both queries **without a `type` predicate**:
their `access_expires_at` is `NULL` (migration 020), and `NULL <= anything`
evaluates to `NULL`, not `TRUE`. Three-valued logic does the filtering. And that
exclusion is *guaranteed* rather than conventional, because the `CHECK` constraint
makes it impossible to put a date on a portfolio album for the query to find.

> This is a small masterpiece of "make the invariant structural": the query
> didn't change, the *data* changed, and the constraint makes the data's shape
> permanent.

**Deletion ordering, inside a nested `processEachSafely`:**

```
for each expired album:
    for each photo in album:
        owners = getAlbumOwnersForPhoto(photo.id)   ← check FIRST
        if owners.length === 1:                     ← this was its last album
            cloudinary.destroy(photo.basePath)
            deletePhotoById(photo.id)
    deleteAlbumById(album.id)                       ← only after all photos settle
```

Two ordering constraints, both deliberate:

- **Ownership check before Cloudinary.** Destroying the asset first and only then
  conditionally deleting the row would leave a still-active album (a photo can be
  in more than one) pointing at bytes that no longer exist.
- **Inner loop must fully settle before `deleteAlbumById`.** Otherwise the album
  — and the `photo_albums` rows it cascades away — could disappear out from under
  a still-in-flight "is this the photo's last album?" check. If any photo fails,
  the inner call throws and the album's delete is skipped entirely, leaving it
  expired-but-undeleted for the next run.

**Email as a port, not an SDK.** `src/email/` exposes an `EmailSender` interface
(`{ to, subject, text }`) with one instance selected by `EMAIL_PROVIDER`. The
default `console` adapter prints, so the whole pipeline runs locally with no
credentials — the same reasoning as `POST /invites` returning its token in the
response body. **The contract that matters is that senders throw on failure**,
because the "send, then mark" ordering relies on a throw to skip the mark. An
adapter that swallows its own errors silently breaks the deletion gate. That is
documented on the interface itself.

`EMAIL_PROVIDER=ses` throws at startup rather than falling back to `console` —
because a fallback would look like a working deployment while every expiry
warning went to a log file instead of a client.

### 6.6 Caching — cache-aside, and the discipline around it

**Strategy (D-14):** cache-aside. The application checks, populates and
invalidates explicitly.

```
read:   cached = cache.get(key) → hit? return : query DB → cache.set(key, v, ttl)
write:  update DB → cache.del(key)
```

Rejected: write-through (adds latency to every write for data that is rarely
read again immediately), write-behind (data loss risk, which contradicts D-02).
Cache-aside also **degrades gracefully** — if Redis is down, every read is a miss
and the app still works, just slower.

**What is cached, and why each TTL:**

| Key | TTL | Invalidated by | Reasoning |
|---|---|---|---|
| `album:meta:{id}` | 900 s | `PATCH /albums/:id`, `DELETE /albums/:id` | Changes rarely (a thumbnail); 15 min of staleness is invisible |
| `album:photos:{id}` | 300 s | any photo add/remove/batch | Changes on upload; a deleted photo still showing is a real bug, so short TTL *and* event invalidation |
| `photographer:profile:{id}` | 3600 s | `PATCH`, profile photo upload | Near-static storefront content |
| `conversations:{userId}` | 120 s | message send (both sides), mark-read (caller) | Carries unread counters; a stale badge is tolerable for 2 min, not 15 |

**Never cached:** messages, unread counts read individually, form responses.
Staleness tolerance is zero.

> **TTL selection framework:** `TTL = f(change frequency, staleness tolerance)`.
> Rarely changes + staleness fine → long TTL, TTL-only invalidation. Frequently
> changes + staleness intolerable → don't cache. In between → short TTL *plus*
> event invalidation, which is the belt-and-braces case (`album:photos`).

**The opinionated call: cache the full photo list, paginate in application code.**

`GET /albums/:id/photos` caches `album:photos:{id}` as the **entire** photo list
under one key, then slices `[offset, offset+limit]` in Node.

- *Cost:* the whole list crosses the wire on a miss and sits in Redis; a
  1000-photo album is a large value to hold for one paginated read.
- *Benefit:* **one `cache.del` invalidates every page at once.** Per-`(page,
  limit)` keys would require deleting an unbounded set of keys on every photo
  add — you'd need key scanning or a version prefix.

This is the right trade at 400 photos/album and the wrong one at 50,000. The
trigger for reversing it is album size, and the replacement is a version-prefixed
key (`album:photos:v{n}:{id}:{page}`) where invalidation is a version bump.

**Two implementation hazards worth internalising:**

1. **Serialisation destroys types.** `cache.get<Album>()` does
   `JSON.parse(raw) as T`. Every `Date` comes back as an ISO *string*, and
   TypeScript cannot know. Comparisons happen to work (ISO-8601 sorts
   lexicographically the same as chronologically), but `.getTime()`,
   `.setFullYear()`, and `a.date - b.date` all misbehave. Hence
   `rehydrateAlbumDates` / `rehydratePhotoDates`, called on every cache hit.
   **The type system lies across a serialisation boundary; the cast is an
   assertion, not a check.**
2. **Invalidation is not transactional.** The DB write commits, then `cache.del`
   runs. If the process dies in between, the entry is stale until its TTL. That
   is survivable for a thumbnail (15 min) and is exactly why messages are not
   cached at all.

**Reuse worth noticing:** `getAlbumPhotos` reads the *same* `album:meta:{id}`
entry that `getAlbumFromId` populates, purely for its ownership check — no second
key, no extra DB hit.

### 6.7 Forms — a state machine and a snapshot

**The lifecycle:**

```
POST /templates            → template + all questions, one transaction
PUT  /templates/:id        → replace name + whole question set, one transaction
POST /templates/:id/responses  → assign to a client; SNAPSHOT questions
        ↓
   [in progress]  submitted_at IS NULL
        │  POST /responses/:id/answers   (JSONB merge, repeatable)
        ↓  PATCH /responses/:id/submit
   [submitted]    submitted_at = NOW()   — terminal, no unsubmit
```

**Questions have no endpoints of their own.** A template and its questions are
created together and edited by replacing the whole set. That single product
decision eliminates an entire class of bug: `"order"` is just the index of the
submitted array, so nothing computes `MAX("order") + 1`, so the read-then-write
race that plagues incremental ordering never exists. Migration 018's
`UNIQUE (template_id, "order")` then *enforces* density rather than fighting it.
Reordering is resubmitting the array in a different sequence.

**Assignment snapshots atomically in one statement** — `INSERT … SELECT` with
`jsonb_agg` over `form_questions`, so there is no window in which a concurrent
`PUT /templates/:id` could swap the questions out halfway through. That's why it
needs no transaction despite writing data derived from another table.

**Answers are a JSONB merge:**

```sql
UPDATE form_responses
SET answers = answers || jsonb_build_object($2::text, $3::text)
WHERE id = $1 AND submitted_at IS NULL
RETURNING *
```

`||` merges two JSONB objects with the right-hand side winning, so one key is
insert-or-overwrite in a single expression. A save-as-you-go client can re-send
the same question without tracking what it already saved — which is why there is
no `PATCH /responses/:id/answers/:questionId`. The read-modify-write happens
inside one statement, so Postgres holds a row lock for its duration: two clients
saving *different* questions concurrently both land.

**The lock lives in the SQL, not the handler.** Both write paths carry
`AND submitted_at IS NULL`. The handler still returns a `409` from its own check
— but a submit landing between that check and the write cannot be written past,
because the loser of the race matches no row and gets `null` back. **The
check-then-write gap is closed, not narrowed.** The same guard on submit means
the original `submitted_at` survives a double-tap rather than creeping forward.

**Access splits by column, not by role:**

- `GET /responses/:id` — the owning client **or** the template's photographer.
  `form_responses` has no `photographer_id`, so that second arm is a join through
  `form_templates`.
- `POST /answers`, `PATCH /submit` — **the client alone.** A photographer may read
  a response but never answer it.

This is the one place in the app where two roles pass the same read check by
different columns and then diverge on write. Worth being able to point at.


---

## 7. The hard tradeoffs, argued both ways

For each: the case for, the case against, what was chosen, and **the trigger that
would flip it**. That last field is what separates an opinion from a preference.

### 7.1 Permanent deletion vs. keeping everything

| For deletion | Against |
|---|---|
| Storage is the dominant cost and it compounds ([§3](#3-the-back-of-envelope-that-decides-the-architecture)) | Irreversible. One bug destroys a customer's wedding. |
| Deterministic and automatable — `shoot_date` is known at creation, no human judgment | A cold-archive tier is ~5× cheaper and *reversible* |
| Bounds the liability of a business that holds irreplaceable data | Support burden: "can you get them back?" — "no" |

**Chosen:** delete (D-04), mitigated by a three-warning pipeline that is a
**precondition**, not a courtesy (D-25), and by computing `access_expires_at`
server-side from `shoot_date` so a caller can never widen or narrow their own
retention window.

**Flip trigger:** the moment a paid extension exists (F-02), the cheap tier is
strictly better than deletion for anyone who might pay, and the design becomes
"archive at 3 years, delete at 5 unless extended."

### 7.2 Snapshot vs. normalise (the form model)

This is the best story in the project, because the design changed its mind for a
reason you can articulate.

**Version 1 (migrations 009–012):** `form_templates → form_questions`, and a
separate `form_answers` table with `(response_id, question_id, content)` and a
`UNIQUE (response_id, question_id)`. Textbook third normal form.

**What went wrong:** `PUT /templates/:id` replaces the question set by deleting
and re-inserting rows, which mints **new question ids**. Any `form_answers` row
pointing at an old id is orphaned. So an assigned template had to be *frozen* —
`PUT` returned `409` once any response existed, and a photographer who wanted to
fix a typo had to duplicate the template.

That is a bad product. It also had a check-then-write race between the handler's
lock check and the transaction.

**Version 2 (migration 019):** the response carries `questions JSONB` (a frozen
copy taken at assign time) and `answers JSONB` (keyed by question id).
`form_answers` is dropped. `form_responses.template_id` becomes
`ON DELETE RESTRICT`.

| Gained | Paid |
|---|---|
| Templates are **always** editable; the lock disappears rather than being tightened | Question text is duplicated per response (≤25 entries — cheap here, not cheap at 500) |
| Rendering a response is **one query** — no join, no assembly | You cannot fix a typo across already-assigned forms. That is now a feature, but it *is* a constraint. |
| Validating "is this question on this form?" becomes an array lookup, not a cross-entity query | The snapshot can drift from what the photographer believes the form says |
| A response survives its template's deletion — enforced in the DB, not the handler | JSONB is weakly typed; the shape is a convention the migration and the query must agree on |
| `PUT` needs no lock, so the race it had disappears with it | camelCase keys in the DB, breaking the snake_case convention everywhere else |

**The generalisable principle:** *normalise for things you will edit; snapshot
for things you must be able to reproduce.* An invoice line item snapshots the
price. A signed contract snapshots the terms. A form response snapshots the
questions. The same reasoning, every time.

**Flip trigger:** questions grow rich (images, branching, 200 per form) and the
duplication becomes the dominant storage cost — then you snapshot a *version id*
and store immutable, content-addressed question sets instead.

### 7.3 Denormalised counters, and the bug that produced migration 017

**Version 1:** `conversations.number_of_unread`, one shared integer.

**The bug:** a single counter cannot express *unread for whom*. Every send
incremented it, so a photographer's own outgoing messages inflated the badge the
photographer saw on their own inbox.

**Version 2 (migration 017):** two columns, `unread_for_photographer` and
`unread_for_client`. A send increments only the recipient's side; a mark-read
zeroes only the caller's.

```sql
-- send: the CASE arms compare the sender against each side
unread_for_photographer = unread_for_photographer
  + CASE WHEN photographer_id = $3 THEN 0 ELSE 1 END,
unread_for_client       = unread_for_client
  + CASE WHEN client_id       = $3 THEN 0 ELSE 1 END
```

**The migration's own backfill is the lesson.** The old counter could not be
split retroactively — it never recorded who a message was *for* — so both sides
were **recomputed from `messages`**:

```sql
unread_for_photographer = (SELECT COUNT(*) FROM messages m
  WHERE m.conversation_id = c.id AND m.sender_id = c.client_id
    AND m.read_at IS NULL)
```

> **The rule this teaches:** you may denormalise a value only if you can still
> derive it from the source of truth. The derivation is your repair tool. The old
> counter was underivable, which is what made the bug unfixable in place rather
> than merely wrong.

**`SET = 0` vs `-= 1`.** Marking read sets the counter to zero in one statement:
atomic *and* idempotent. Two concurrent mark-read requests cannot corrupt it, and
neither can a retry. A per-message `-= 1` has to be exactly right every single
time or the badge drifts permanently, and drift in a counter is invisible until a
user complains. **Prefer the operation that is idempotent over the operation that
is precise.**

**Cost, stated plainly:** the counters can still drift if a future writer forgets
them (they're maintained in exactly one file today), and there is no
reconciliation job. Adding one is cheap — the `COUNT(*)` above is the job.

### 7.4 Synchronous vs. asynchronous uploads

The codebase does **both**, deliberately, and the contrast is the point.

| | `POST /albums/:id/photos/batch` | `POST /photographers/:id/photo` |
|---|---|---|
| Files | up to hundreds, 25 MB each | one, 5 MB, image MIME enforced |
| Work | derivative variants, per-file | none |
| Response | **202 Accepted**, rows at `status: 'processing'` | **200 OK**, the updated profile |
| Cloudinary id | `photoId` (unique per upload) | `photographers/{id}/profile`, `overwrite: true`, `invalidate: true` |

**The rule:** go async when the work is unbounded or derivative; stay sync when
the user is staring at the result and the work is one small unit. A 202 on an
avatar upload means showing the old photo for an indeterminate time — a worse
experience for no benefit.

The deterministic `public_id` on the profile photo is a nice second-order
decision: replacing an avatar **overwrites the same asset** rather than orphaning
the old one, so there is no column tracking the previous public id and no cleanup
job. It also makes the write idempotent — a retry after a failed DB update
overwrites rather than accumulating copies. `invalidate: true` purges the CDN
copy, since the URL is unchanged but the bytes behind it are not.

### 7.5 `404` vs `403` — and an inconsistency worth owning

Three different rules live in this codebase, and they are not all the same by
accident — but they are also not all deliberate.

| Endpoint | Behaviour | Rationale |
|---|---|---|
| `GET /albums/:id`, `GET /templates/:id` | 404 if missing, **403 if not yours** | A caller learns the resource exists. Friendlier for legitimate callers. |
| `GET /photographers/:id` (private profile) | **404**, same as nonexistent | Existence itself is the secret. Prevents enumeration of private profiles. |
| `GET /clients/:id/*` | **403** for both missing and not-yours | A photographer probing UUIDs learns nothing about which clients exist. |
| `POST /albums` (body `clientId`) | **404** for both | Same reasoning as clients. |
| `POST /templates/:id/responses` (body `clientId`) | **404** missing, **403** not-yours | Friendlier — at the cost of confirming a UUID is somebody's client. |

**The honest read:** the codebase is internally consistent *per resource* and
inconsistent *across* resources. That's a real finding. The principled version is
one rule: **if knowing a resource exists is itself information the caller
shouldn't have, return 404; otherwise 404-then-403.** By that rule,
`POST /templates/:id/responses` is wrong and should collapse both cases to 404.

Volunteering this is worth more than hoping nobody notices.

### 7.6 Identity-scoped queries vs. URL parameters (D-17)

**Stance:** list endpoints filter by JWT identity. `GET /conversations` takes no
id at all; the handler branches on `req.user.role` and queries by
`req.user.id`.

Where a URL *does* carry an id (`/photographers/:id/clients`,
`/clients/:id/albums`), it is checked against the caller — either equality, or
`assertCanReadClient`, which allows the client themselves or their photographer.

**Cost:** admin tooling needs an explicit bypass. There is no "view as user"
without new code. That's the right cost to pay — the alternative is an
authorisation model where forgetting one check leaks another photographer's
client list.

**Subtle sibling decision:** `getResponsesByClientId` filters on `client_id`
alone rather than joining a photographer arm, *even though* the photographer's
claim runs through the template. Filtering by photographer in SQL would turn "not
your client" into an **empty list**, and empty means "nothing here", which invites
a retry. The route's 403 says "not yours." **Authorisation failures should be
loud; empty results should mean empty.**

### 7.7 One Redis for cache and queue (D-10, F-06)

**For:** one managed service, one failover story, one bill. At MVP volumes the
working set is tiny.

**Against:** the blast radius is both systems at once. Worse, they compete for
memory with *opposite* eviction needs — cache entries are meant to be evicted,
queue jobs absolutely are not. A cache-driven memory spike with an `allkeys-lru`
policy will evict jobs.

**Chosen:** shared, with separation as a named post-MVP item. **Flip trigger:** the
first time cache working set approaches the instance's memory, or the first
evicted job. And note the configuration detail that makes it work today —
BullMQ requires `maxRetriesPerRequest: null`, which is set on the shared ioredis
client in `config/redis.ts`.

### 7.8 Express now, Fastify later (D-11, F-07)

**For Express:** ecosystem maturity, hiring familiarity, maximum transparency for
learning. **For Fastify:** native TypeScript, built-in schema validation, ~2×
throughput.

**What makes the option real:** business logic is framework-agnostic. Route
handlers are exported functions taking `(req, res, next)`; query functions know
nothing about HTTP; validation is Zod, not a framework feature. The migration is
a thin layer swap, not a rewrite. **Keeping an option open costs something —
here it cost writing handlers as named exports rather than inline closures —
and that cost is only worth paying when the option is genuinely likely to be
exercised.**

### 7.9 Multer to local disk vs. streaming to storage

**Chosen:** `multer.diskStorage` to `os.tmpdir()`, then rename so the filename is
the photo id.

**For:** dead simple; the worker reconstructs the path from the id, so no paths
travel through Redis; a job is fully described by ids.

**Against:** it **couples the API instance to the worker instance**, and that
coupling is invisible until you scale out. See [§8.1](#81-the-sharpest-flaw-upload-staging-on-local-disk).

---

## 8. Where this design breaks

Everything in this section is real and locatable in the repository. Knowing your
own design's weaknesses is the most reliably underweighted interview skill.

### 8.1 The sharpest flaw: upload staging on local disk

`POST /albums/:id/photos/batch` writes files to
`os.tmpdir()/sys-photo-uploads/<photoId>` on the machine that handled the
request. The worker later reads `path.join(UPLOAD_TMP_DIR, photoId)` — from
**its own** filesystem.

This works because D-22 puts the worker on the same EC2 instance as the API. It
**silently breaks the moment there are two API instances**, which is precisely
what the ALB in D-23 exists to enable. The failure is quiet: photos stay at
`status: 'processing'` forever, the job fails three times and lands in the failed
set, and no user-facing error is ever produced.

There is a deeper version of the same problem: this design cannot survive the
instance being replaced between the 202 and the job running. Rolling deploys —
the stated motivation for the load balancer — will do exactly that.

**The fixes, in increasing order of correctness:**

1. Stage on shared storage (EFS, or an S3 `uploads/` prefix) instead of local
   disk. Smallest change; keeps the pipeline shape.
2. Skip the app tier entirely: issue a **signed direct-upload** to Cloudinary from
   the browser, and have the API only create rows and enqueue. This also removes
   the 2 GB request, the memory spike, and the per-file size ceiling from the API.
3. (2) plus a webhook from Cloudinary that flips `status` to `'ready'`, removing
   the worker from the upload path altogether.

**(2) is the right answer** and it is what a production system does. Say so.

### 8.2 No outbox: the enqueue can be lost

`insertPhotosForAlbum` commits, *then* `photoQueue.add(...)` runs. If Redis is
unavailable or the process dies in between, the photo rows exist at
`'processing'` with **no job and no retry**. Nothing ever reconciles them.

Two standard fixes, and you should be able to name both:

- **Transactional outbox:** write the job into a Postgres table in the same
  transaction as the rows; a relay process moves outbox rows to Redis. Gives
  exactly-once-ish semantics at the cost of a relay.
- **A reaper:** a fifth cron job that finds photos `status='processing' AND
  uploaded_at < NOW() - interval '1 hour'` and re-enqueues them. Cheap, and it
  catches every cause, not just this one.

The reaper is the right MVP answer — one query and one job, and it converts a
silent permanent failure into a delayed success.

### 8.3 The expiry sweep is an N+1 with no bound

```
getExpiredAlbums()                        -- no LIMIT
  → for each album: getAllPhotosForAlbum  -- 1 query
    → for each photo: getAlbumOwnersForPhoto  -- 1 query PER PHOTO
```

A 400-photo album costs ~401 queries. A day with 200 expiring albums costs
~80,000 sequential round trips, in one job, with three retries and no chunking or
checkpoint. If it times out, it starts over.

**Fixes:** batch the ownership check into one query
(`SELECT photo_id, COUNT(*) … WHERE photo_id = ANY($1) GROUP BY photo_id`);
add `LIMIT` and process albums in chunks across runs; make the job resumable so a
partial sweep isn't wasted.

### 8.4 Cross-system consistency: Cloudinary and Postgres

Deletion does `cloudinary.destroy()` then `deletePhotoById()`. If the destroy
succeeds and the row delete fails, the row points at bytes that no longer exist —
a broken image rather than a lost dollar. Reversed, you get an orphaned asset you
pay for forever.

There is no reconciliation in either direction. A production system needs a
periodic sweep comparing Cloudinary's asset list against `photos.base_path`.
Neither ordering is "correct"; you pick which failure you'd rather have and then
build the sweep that cleans it up.

### 8.5 The webhook is authenticated but not idempotent

D-08 cites "the auth provider handles retries automatically" as a *benefit*. But
`POST /users` has no idempotency key and no replay protection:

- A retried webhook attempts a duplicate insert, caught by
  `UNIQUE (provider_id)` / `UNIQUE (email)`, which surfaces as an unlabelled
  **500** — so Auth0 retries again. A retry loop born from a success.
- The HMAC has no timestamp or nonce, so a captured request replays forever.

**Fix:** `ON CONFLICT (provider_id) DO NOTHING … RETURNING`, returning `200` with
the existing user when the row already exists; plus a signed timestamp with a
short acceptance window.

### 8.6 Offset pagination

`GET /conversations/:id/messages` uses `ORDER BY sent_at ASC LIMIT $2 OFFSET $3`.
Two problems, both classic:

- Deep offsets make Postgres scan and discard everything before them.
- The page **shifts under the reader** — a message arriving between requests
  moves the boundary, duplicating or skipping a row.

**Fix:** keyset (seek) pagination on `(sent_at, id)`:
`WHERE (sent_at, id) > ($1, $2) ORDER BY sent_at, id LIMIT $3`. The composite
index from migration 014 already supports it.

Same issue in `GET /albums/:id/photos`, though the full-list cache masks it.

### 8.7 Unpaginated list endpoints

`GET /photographers/:id/clients`, `/albums`, `/invites`, `/templates`,
`GET /clients/:id/responses`, and `GET /conversations` all return **everything**.
A photographer with 5,000 clients gets one enormous JSON document, and
`conversations:{userId}` caches it. This is the most likely thing to fall over
first in real use, and it's a small fix.

### 8.8 Cache stampede

There is no single-flight protection. When `album:photos:{id}` expires, every
concurrent request for that album misses and queries the database together. At
this scale it doesn't matter (an album has two readers). At a scale where it
would, the fixes are a short lock key, or probabilistic early recomputation.

### 8.9 The doc promises HTTP caching the code doesn't do

D-16 justifies REST over GraphQL partly because "HTTP caching is native." No
handler sets `Cache-Control`, `ETag`, or `Last-Modified`. The rationale is sound;
the benefit is unclaimed. `ETag` on `GET /albums/:id/photos` derived from the
photo-list cache would be nearly free.

### 8.10 Access doesn't actually end at `access_expires_at`

The product says client access expires after three years. The system deletes the
album *after* the final warning, whenever the sweep next runs. In between,
`GET /albums/:id` and `GET /clients/:id/albums` apply **no expiry filter** at all
— an expired album is still fully readable.

The code acknowledges this deliberately: filtering in one query but not the other
would make an album visible directly and invisible in the list it belongs to. But
"access expires" and "data is deleted eventually" are different promises, and
right now only the second one is implemented.

### 8.11 Smaller findings

| Finding | Where | Note |
|---|---|---|
| `messages.read_at` is never written | migration 008, `queries/conversations.ts` | Per-message read state was replaced by per-conversation counters. The column is dead except in 017's backfill. |
| `getPhotosForAlbum` is unreachable | `queries/photos.ts` | Superseded by full-list caching + in-app slicing. |
| `auth.ts` reads `process.env` directly | `middleware/auth.ts` | Bypasses the validated `env` object used everywhere else. |
| `COALESCE` update pattern can't clear a field | `updateUserById`, `updateAlbumById` | You can set a bio, never blank one. |
| No `DELETE /users/:id` | assigned in Phase 2.3 | Cascades across nine tables; `albums.client_id` is `SET NULL`, so a deleted client leaves live, unwarnable shoot albums — which is exactly the orphan case the expiry pipeline handles. |
| No rate limiting in the app | — | Delegated to nginx per D-23. `POST /invites` and `GET /invites/validate` are the endpoints that want it most. |
| Cache keys aren't namespaced by environment | `src/cache/` | A shared Redis across environments would collide. |
| No structured logging, tracing, or metrics | `console.*` throughout | The worker in particular leaves only `console.error` behind. |


---

## 9. Scaling: what fails, in what order

The useful version of "how does this scale" is not a list of technologies. It is
an **ordered** list of what breaks, with the trigger for each. Order matters more
than completeness, because it demonstrates you know which constraint is binding.

| # | Breaks at | What fails | Fix |
|---|---|---|---|
| 1 | **2 API instances** | Upload staging on local disk ([§8.1](#81-the-sharpest-flaw-upload-staging-on-local-disk)). This is triggered by the *first horizontal scale-out*, i.e. immediately. | Signed direct-to-Cloudinary uploads |
| 2 | **A power user** (thousands of clients/albums) | Unpaginated list endpoints ([§8.7](#87-unpaginated-list-endpoints)) | Paginate; keyset where ordering is stable |
| 3 | **~100 albums expiring/day** | The expiry sweep's N+1 and unbounded batch ([§8.3](#83-the-expiry-sweep-is-an-n1-with-no-bound)) | Batch the ownership query; chunk with `LIMIT`; make it resumable |
| 4 | **Worker memory pressure** | Worker and API share an EC2 instance (D-22); a large batch competes with request handling | Separate worker ASG; scale on queue depth, not CPU |
| 5 | **Read volume growth** | Single Postgres primary. Later than intuition suggests — reads are cache-fronted and the API is ~11 QPS steady state | RDS read replicas; route `GET`s to replicas; accept replica lag for reads that tolerate it |
| 6 | **Redis memory** | Cache and queue compete; eviction policy can drop jobs (F-06) | Separate ElastiCache instances |
| 7 | **Long conversations** | Offset pagination on messages ([§8.6](#86-offset-pagination)) | Keyset pagination on `(sent_at, id)` |
| 8 | **Genuine multi-tenancy scale** | Single Postgres write capacity | Shard by `photographer_id` |

**The point about #8 that's worth making out loud:** this schema shards
unusually well. The ownership tree means nearly every query is already scoped to
one photographer — albums, clients, conversations, templates, invites all hang
off `photographer_id`. There is no cross-tenant read anywhere in the API. So
`photographer_id` is a natural shard key, and the only awkward entity is `photos`,
which is reachable through `photo_albums` from an album that has one.

Contrast that with a social product, where the natural shard key (user) is
exactly the thing every query joins across. **A design that shards cleanly is
usually one whose authorisation model was strict in the first place.** That is
not a coincidence, and it's a good closing observation for a design round.

### What you would add before any of that

Before scaling anything, a production deployment needs the things this MVP does
not have, roughly in this order:

1. **Observability.** Structured logs with a request id, metrics on queue depth
   and job failure rate, and one alert that matters: *albums past
   `access_expires_at` still awaiting a warning* — the monitor D-25 explicitly
   calls for.
2. **The reaper job** ([§8.2](#82-no-outbox-the-enqueue-can-be-lost)) — converts a
   class of silent permanent failure into a delayed success.
3. **Rate limiting** on `POST /invites` and `GET /invites/validate`.
4. **Backups you have restored from**, not backups you have configured.

---

## 10. Opinion-forming drills

> This is the section to actually work. Everything above is worked examples; this
> is the exercise.

### The rubric

An opinion is well-formed when it does four things. Grade yourself on each:

1. **Names the constraint it derives from.** Not "I'd use Redis" — "reads
   outnumber writes ~100:1 and staleness of 5 minutes is invisible to the user,
   so I'd cache."
2. **Names what it costs.** Every choice buys something with something. If you
   can't name the price, you haven't decided, you've preferred.
3. **Names the trigger that flips it.** "I'd revisit this when X exceeds Y." An
   opinion with no flip condition is dogma.
4. **Is falsifiable with a number.** Someone should be able to measure the thing
   you claimed and prove you wrong.

A useful self-check: *if the interviewer says "I disagree", do you have a
question you could ask that would settle it?* If not, you asserted rather than
reasoned.

### The drills

Work each cold. Write your answer before reading the notes. Aim for 3–5 minutes
each: the first thing that breaks, the decision it forces, the second-order
effect, and the cost.

---

**Drill 1 — "Deleted photos must be recoverable for 30 days."**

<details><summary>Notes</summary>

*First break:* the deletion gate's whole justification. `warned_7_at IS NOT NULL`
exists because deletion is irreversible; make it reversible and the gate is
merely a nicety.

*Forces:* a soft-delete state (`deleted_at` on `albums`/`photos`, and moving
Cloudinary assets to a separate folder or storage class rather than
`destroy()`ing them), plus a second sweep 30 days later that does the real
destroy.

*Second-order:* storage math changes — you now hold up to 30 extra days of
deletions, roughly +2.7% of steady state (30/1095), which is trivial. Every read
query needs `AND deleted_at IS NULL`, which is a change to *every* query, not
just the deletion path — that's the real cost, and it's the argument for doing it
at the album level only. And the `CHECK` from migration 020 needs revisiting: does
a soft-deleted album still need an expiry?

*Cost:* every read path grows a predicate; a missed one leaks deleted data.

*Falsifiable claim:* +2.7% storage, one new cron job, N query changes where N is
the number of album/photo read paths.
</details>

---

**Drill 2 — "A client can work with multiple photographers."**

<details><summary>Notes</summary>

*First break:* `clients.photographer_id NOT NULL` — a column that encodes a 1:N
relationship that is now N:M.

*Forces:* a `client_photographers` join table. `conversations` already has
`UNIQUE (photographer_id, client_id)`, so it needs no change — it was already
keyed by the pair. `assertCanReadClient` becomes a membership query rather than a
column comparison. The invite flow changes from "create a client" to "create a
client *or* add a relationship to an existing one" — which means the acceptance
transaction now needs an upsert, and the `FOR UPDATE` lock covers a different
invariant.

*Second-order:* `GET /photographers/:id/clients` is now a join. Sharding by
`photographer_id` ([§9](#9-scaling-what-fails-in-what-order)) gets harder, because
a client spans shards. Auth0 accounts are already per-person, so identity is
unaffected.

*Cost:* the cleanest sharding property in the design weakens.

*Note:* this is F-04 in the roadmap, which claims "no structural changes needed."
That claim is wrong, and noticing it is the point of the drill.
</details>

---

**Drill 3 — "Messaging must be real-time."**

<details><summary>Notes</summary>

*First break:* `conversations:{userId}` cached for 120 s. Real-time and a 2-minute
cache are incompatible; the cache stops being a latency optimisation and becomes
a source of wrong badges.

*Forces:* a persistent transport (WebSocket or SSE). Because Express is stateless
behind an ALB, a connection lands on one instance while the sender's write lands
on another — so you need **Redis pub/sub** to fan a message out to whichever
instance holds the recipient's socket.

*Second-order:* the denormalised counters become *push payloads* rather than
things fetched on inbox load — which makes them more valuable, not less. Connection
state is now server-affine, which contradicts the "stateless Express" posture
(D-22) unless you keep the socket layer separate from the REST tier. Redis is now
on the critical path for a user-visible feature, not just cache and jobs — which
strengthens the case for F-06's separation.

*Cost:* the CP posture (D-02) meets a channel that is naturally AP. Resolve it by
saying: *message persistence stays CP (it's a Postgres write), delivery is
best-effort AP, and the client reconciles on reconnect by re-fetching.*
</details>

---

**Drill 4 — "Photographer portfolios must be publicly browsable and
search-indexable."**

<details><summary>Notes</summary>

*First break:* D-17. Every list endpoint is identity-scoped and every read
requires a JWT. A public read path has no identity to scope by.

*Forces:* a separate unauthenticated read surface. The `visibility` enum already
exists on `photographers`, so the data model is ready. Portfolio albums already
have no `client_id` and never expire (migration 020) — they were designed for
this.

*Second-order:* this read path is AP-shaped and CDN-cacheable, which is the first
place in the system where HTTP caching ([§8.9](#89-the-doc-promises-http-caching-the-code-doesnt-do))
would actually earn its keep. It also introduces enumeration and scraping
concerns that identity-scoping used to make moot. And it changes the caching
profile completely: `photographer:profile` goes from "two readers" to "possibly
hot", so a stampede matters now ([§8.8](#88-cache-stampede)).

*Cost:* two authorisation models in one codebase — the most reliable way to leak
data is to have two rules and apply the wrong one. Mitigate by putting the public
surface on its own router with no access to the authenticated query functions.
</details>

---

**Drill 5 — "Uploads must survive a flaky connection on a 2,000-photo shoot."**

<details><summary>Notes</summary>

*First break:* a single multipart request carrying everything. One dropped
connection loses all of it, and there is no partial-progress concept.

*Forces:* per-file rather than per-batch granularity — signed direct uploads,
resumable protocol (tus / multipart with parts), and one job per photo rather
than one `ProcessBatch`. Note that the *existing* retry model already fights you
here: BullMQ retries the whole batch, which is only safe because of the
`status === 'ready'` skip.

*Second-order:* the 202 shape survives unchanged — the API still creates rows and
returns immediately. This is the payoff of having made the response shape
independent of the work. Progress reporting becomes possible for the first time
(`n of 2000 ready`), which is a genuine product improvement that falls out of the
architecture change.

*Cost:* 2,000 queue jobs instead of 1 — fine for Redis, but the per-job overhead
and the failed-job retention policy (`removeOnFail: { count: 100 }`) need
revisiting.
</details>

---

**Drill 6 — "GDPR: a client's personal data must be fully erasable within 30
days of request."**

<details><summary>Notes</summary>

*First break:* `DELETE /users/:id` doesn't exist ([§8.11](#811-smaller-findings)).

*Forces:* it to exist — and then the cascade design becomes a compliance
question rather than a convenience. `albums.client_id` is `ON DELETE SET NULL`,
so deleting a client leaves their shoot albums alive but detached. Are the photos
of a person their personal data? Almost certainly yes. So `SET NULL` is now the
wrong cascade, or you need an explicit "delete this client's albums" step.

*Second-order:* the expiry pipeline's orphan handling — marking an album warned
with no recipient so the gate doesn't hold it forever — becomes the mechanism
that eventually deletes the photos, but on the album's own 3-year schedule, not
within 30 days. Messages carry `sender_id` with `ON DELETE CASCADE`, so a deleted
user's messages vanish from a conversation the *other* party still sees, leaving
a one-sided thread. Form responses cascade from `clients`, destroying the record
migration 019 was specifically designed to preserve.

*Cost:* the "records outlive their source" principle ([§7.2](#72-snapshot-vs-normalise-the-form-model))
and the right to erasure are in direct tension. You need an explicit anonymisation
path (blank the PII, keep the record) rather than a delete for anything that must
be retained.

*This is the best drill in the set,* because it shows a legal requirement
reaching into six unrelated design decisions at once.
</details>

---

**Drill 7 — "Product wants to know which photos clients view most."**

<details><summary>Notes</summary>

*First break:* **you can't see the views.** Bytes are served by Cloudinary's CDN
directly to the browser. The API never observes a photo being looked at. This is
the cost of the offload in D-05/D-06, and it only becomes visible when a
requirement needs the data you gave away.

*Forces:* one of — (a) Cloudinary's own analytics, if it's sufficient;
(b) client-side beacons to an ingest endpoint, which is cheap but trivially
blocked and unreliable; (c) signed short-lived URLs minted by the API, which puts
your service back on the byte path's *control* plane while keeping it off the
data plane. (c) is usually right, and it has a security benefit too: gallery
access currently relies on unguessable Cloudinary paths.

*Second-order:* view events are high-volume, append-only, and read by multiple
independent consumers — which is the textbook Kafka case, and exactly what F-01
reserves Kafka for. Do not put them in Postgres.

*Cost:* URL minting adds a request per photo (or per page, with a batch endpoint)
and a key-rotation story.
</details>

---

**Drill 8 — "Cut infrastructure cost by half."**

<details><summary>Notes</summary>

*Where the money is:* [§3](#3-the-back-of-envelope-that-decides-the-architecture)
says storage, by an enormous margin. Compute is a rounding error at 11 QPS.

*Forces:* attack the 21 PB. In order of leverage — (1) don't store the original
at full size, or store it in a cold tier and serve only `standard`; (2) shorten
the TTL from 3 years to 2 (−33% of steady state directly); (3) tiered storage
after year 1; (4) more aggressive compression on `standard`.

*Second-order:* every one of those is a **product** decision, not an
infrastructure one. That's the answer the question is fishing for: in this system
the cost lever and the product policy are the same lever. F-02 (paid extension)
is the version that increases revenue instead of decreasing service.

*What not to do:* right-size the EC2 instance. It's not where the money is, and
proposing it signals you didn't do the arithmetic.
</details>

---

**Drill 9 — "We need 99.99% availability."**

<details><summary>Notes</summary>

*First break:* D-02 explicitly trades availability for durability. 99.99% is ~52
minutes of downtime per year — less than a single unattended RDS failover.

*Forces:* re-examining the CP stance *per surface* rather than globally. Ask what
actually needs to be CP: album and photo metadata (a photo must not appear to
exist when it doesn't), the invite acceptance transaction, the expiry gate. What
can be AP: the inbox badge, the conversation list, the photographer profile,
anything already cached.

*Second-order:* multi-AZ RDS with automated failover, read replicas for the AP
surfaces, a Redis replica, and — the expensive part — the app must **degrade
rather than fail** when a dependency is down. Cache-aside already gives you that
for Redis. Postgres has no equivalent; a read-only mode serving cached responses
during a failover is the design.

*Cost:* roughly 2× the infrastructure for the stateful tier, and a materially
more complex deployment. Worth naming that 99.9% (~9 hours/year) costs a
fraction of 99.99% and is often what the business actually meant.
</details>

---

**Drill 10 — invent your own.** Take any row from
[§8](#8-where-this-design-breaks) and write the requirement that would have
prevented it. That's the reverse exercise, and it's the one that builds intuition
fastest: most weaknesses are the shadow of a requirement nobody stated.

---

## 11. Decision index

### Original architecture decisions

| ID | Decision | One-line rationale |
|---|---|---|
| D-01 | Read-heavy system | Clients browse often; photographers upload rarely |
| D-02 | CP over AP | Photo loss is unacceptable; downtime is tolerable |
| D-03 | `access_expires_at = shoot_date + 3 years` (shoot albums only) | Deterministic, automatable, bounds storage cost |
| D-04 | Permanent deletion after expiry | Storage cost; mitigated by the warning pipeline |
| D-05 | Cloudinary for bytes, Postgres for the key | Databases aren't for blobs; one `base_path` covers 3 variants |
| D-06 | Cloudinary does processing + CDN | CPU-spiky work; a 500-photo burst would crater self-managed servers |
| D-07 | Auth0/Clerk for identity | Security-critical infrastructure with a long tail of failure modes |
| D-08 | Webhook syncs auth → DB | Atomic creation of user + role profile; provider handles retries |
| D-09 | Postgres on RDS | 11 entities, complex joins, ACID; managed backups/failover |
| D-10 | One ElastiCache Redis for cache + queue | One managed stateful service at MVP; separate later (F-06) |
| D-11 | Express, with a Fastify path | Ecosystem maturity now; framework-agnostic logic keeps the option |
| D-12 | Node.js / TypeScript | I/O-bound workload; CPU work is offloaded |
| D-13 | BullMQ + Redis, separate worker process | Scheduled *and* triggered work; jobs survive crashes |
| D-14 | Cache-aside | Read-heavy, infrequent writes; degrades gracefully |
| D-15 | Hybrid TTL + event invalidation | Match invalidation cost to staleness risk |
| D-16 | REST over GraphQL | Stable access patterns; native file upload |
| D-17 | Identity-scoped list queries | JWT is signed; URL params are not |
| D-18 | One response shape for `GET /photographers/:id` | Nothing on that entity is private; branching adds leak surface |
| D-19 | Invite-only client signup | Every client is always linked to a photographer |
| D-20 | Conversation auto-created with the client | Every client always has a channel |
| D-21 | AWS over a PaaS | Exposes the networking and scaling decisions |
| D-22 | EC2 (API + worker) / RDS / ElastiCache | Stateless scales horizontally; stateful scales by replication |
| D-23 | ALB + nginx | LB = which server; reverse proxy = how the request is prepared |
| D-24 | `EmailSender` port; send *then* mark warned | At-least-once beats at-most-once before an irreversible delete |
| D-25 | Deletion gated on `warned_7_at IS NOT NULL` | Makes the warning pipeline a precondition, not advice |
| D-26 | `GET /users/me` rather than JWT claims | The DB is the source of truth; claims add a reverse sync |

### Implementation-level decisions worth knowing by name

| Decision | Where |
|---|---|
| `SELECT … FOR UPDATE` on the invite inside the acceptance transaction | `queries/users.ts` |
| Filename on disk *is* the photo id; job payload carries only ids | `routes/albums.ts`, `config/uploads.ts` |
| `status === 'ready'` skip makes whole-batch retry idempotent | `processors/photoProcessor.ts` |
| Unlink temp file only after the DB write confirms | `processors/photoProcessor.ts` |
| `processEachSafely`: isolate per item, still fail the job | `processors/processEachSafely.ts` |
| `upsertJobScheduler` with a stable id, so restarts don't duplicate cron | `schedulers/expiryScheduler.ts` |
| `<=` not `=` in the warning window, so a missed run catches up | `queries/albums.ts` |
| Orphan albums marked warned with no send, so the gate can't leak | `processors/expiryProcessor.ts` |
| `NULL` expiry + `CHECK` excludes portfolio albums via three-valued logic | migration 020 |
| Full photo list cached per album; pagination applied in app code | `routes/albums.ts` |
| `rehydrateAlbumDates` / `rehydratePhotoDates` — JSON round-trip kills `Date` | `queries/albums.ts`, `queries/photos.ts` |
| Split unread counters; `SET = 0` because it's atomic *and* idempotent | migration 017, `queries/conversations.ts` |
| `AND submitted_at IS NULL` in the write, closing the check-then-write gap | `queries/responses.ts` |
| `answers || jsonb_build_object(...)` — upsert one key in one expression | `queries/responses.ts` |
| `INSERT … SELECT jsonb_agg(...)` — snapshot taken inside the write | `queries/responses.ts` |
| `"order"` = array index, so `MAX(order)+1` races never exist | `queries/templates.ts`, migration 018 |
| Raw-body HMAC + `timingSafeEqual` with a length guard | `routes/users.ts`, `app.ts` |
| `/me` registered before any `/:id` on the same router | `routes/users.ts` |
| `/photos/batch` registered before `/photos/:photoId` | `routes/albums.ts` |
| `NULLS LAST` on `last_message_at DESC` | `queries/conversations.ts` |
| `LEFT JOIN` + all-null discriminant for template/questions in one round trip | `queries/templates.ts` |
| Never `SELECT a.*, b.*` — node-postgres keeps only the last duplicate column | `queries/albums.ts`, `queries/responses.ts` |
| `SELECT 1 … LIMIT 1` for existence, not `COUNT(*)` | `queries/templates.ts` |
| Explicit column list for list views, so snapshots don't cross the wire | `queries/responses.ts` |

---

*Companion: [PROJECT_DEEP_DIVE.md](PROJECT_DEEP_DIVE.md). Source of record for the
original decisions: [photography_app_architecture.md](photography_app_architecture.md).
Build order and per-phase reasoning: [ASSIGNMENTS.md](ASSIGNMENTS.md).*

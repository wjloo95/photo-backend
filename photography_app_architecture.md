# Photography App Backend
## System Design Architecture Document

> Complete decisions log with rationale and tradeoffs

**Stack:** Node.js / TypeScript · Express · PostgreSQL (RDS) · Redis (ElastiCache) · BullMQ · Cloudinary · Auth0/Clerk · AWS

**Scale:** 11 database entities · 40 live REST endpoints · 26 architecture decisions · 7 post-MVP items · Millions of users target

---

## Table of Contents

1. [System Overview & Requirements](#1-system-overview--requirements)
2. [Database Schema](#2-database-schema-11-entities)
3. [REST API Surface](#3-rest-api-surface-40-live--1-planned)
4. [Architecture Decisions](#4-architecture-decisions)
5. [Deployment Architecture](#5-deployment-architecture)
6. [Post-MVP Roadmap](#6-post-mvp-roadmap)
7. [Claude Code Implementation Guide](#7-claude-code-implementation-guide)

---

## 1. System Overview & Requirements

### Functional Requirements

- **Photographers:** upload photos into albums, organize portfolio, communicate with clients via messaging and questionnaires
- **Clients:** view and download photos from their album, communicate with photographer, complete questionnaires
- **Invite flow:** photographer-initiated client onboarding via one-time tokenized link (30-day expiry)
- **Background jobs:** photo processing pipeline, expiry notifications, deletion pipeline

### Non-Functional Requirements

- Read-heavy — clients browse frequently, photographers upload infrequently
- Target scale: millions of users with horizontal scaling from the start
- Durability over availability (CP over AP) — photo loss is unacceptable, downtime is tolerable
- Photo TTL: 3 years from shoot date for **shoot albums**, then permanent deletion with warnings at 90/30/7 days. Portfolio albums never expire (migration 020)

### Expiry Pipeline

| Trigger | Action |
|---|---|
| expiry - 90 days | Send warning email → set `warned_90_at` |
| expiry - 30 days | Send warning email → set `warned_30_at` |
| expiry - 7 days | Send final warning → set `warned_7_at` |
| **expiry date** | **Revoke access → permanently delete from Cloudinary and DB**, but only once `warned_7_at` is set |

Warnings go to the **client**, whose access is ending. The send happens before
`warned_*_at` is written, so a failed send leaves the column NULL and the album
re-qualifies on the next daily run — at-least-once delivery, where the worst
case is a duplicate email rather than a silently missed warning before an
irreversible deletion.

The deletion sweep additionally requires `warned_7_at IS NOT NULL`. If the mail
provider is down through the entire run-up, albums wait rather than being
destroyed unannounced. Note what that column asserts: the warning *step*
completed, not that a human read anything — an album whose client was deleted
(`client_id` is `ON DELETE SET NULL`) has nobody to warn, and is marked warned
without a send so the gate cannot hold it, and its Cloudinary assets, forever.

Email goes through the `EmailSender` port in `src/email/`, selected by
`EMAIL_PROVIDER`. The default `console` adapter prints instead of sending, so
the pipeline runs locally with no credentials; `ses` is the intended production
adapter and is not built yet.

Shoot albums only. Expiry exists because a *client's* access to their shoot is
time-limited; a portfolio album belongs to the photographer, has no `client_id`
by design, and so has nobody to warn and no access to revoke. Portfolio albums
carry `access_expires_at = NULL`, and since `NULL < NOW()` evaluates to NULL
rather than TRUE, both sweeps exclude them without needing a `type` predicate.

> ⚠️ **Tradeoff:** Deletion is irreversible. No recovery path after deletion. Mitigated by three-warning notification pipeline. Post-expiry paid storage is a post-MVP consideration (F-02).

---

## 2. Database Schema (11 Entities)

PostgreSQL via AWS RDS. All entities use UUID primary keys. Foreign keys enforced at database level.

### Auth & Users

#### User
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| email | string | |
| name | string | shared by both photographers and clients |
| role | enum('photographer', 'client') | |
| provider_id | string | Auth0/Clerk ref |
| joined_at | timestamp | |

#### Photographer
| Field | Type | Notes |
|---|---|---|
| user_id | uuid | FK → User |
| bio | text | |
| profile_photo_url | string | Cloudinary path |
| instagram_handle | string | |
| visibility | enum('public', 'private') | |

#### Client
| Field | Type | Notes |
|---|---|---|
| user_id | uuid | FK → User |
| photographer_id | uuid | FK → Photographer |

### Photos & Albums

#### Album
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| photographer_id | uuid | FK → Photographer |
| client_id | uuid | FK → Client, nullable |
| thumbnail_photo_id | uuid | FK → Photo, nullable |
| type | enum('shoot', 'portfolio') | |
| shoot_date | date | |
| access_expires_at | timestamp | nullable — `shoot_date + 3 years` for shoot albums, NULL for portfolio albums, which never expire. A CHECK constraint enforces the pairing (migration 020) |
| warned_90_at | timestamp | nullable |
| warned_30_at | timestamp | nullable |
| warned_7_at | timestamp | nullable |
| created_at | timestamp | |

#### Photo
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| base_path | string | Cloudinary key |
| status | enum('processing', 'ready') | |
| width | integer | nullable — set by the processor once Cloudinary reports it |
| height | integer | nullable — set by the processor once Cloudinary reports it |
| uploaded_at | timestamp | |

> **Note on base_path:** Variants are derived by convention — `{base_path}/original.jpg`, `{base_path}/standard.jpg`, `{base_path}/thumbnail.jpg`. Only one field needed in DB.

> **Note on width/height:** nullable for the same reason base_path starts as a placeholder — the real pixel dimensions aren't known until Cloudinary processes the upload. The frontend uses them to render aspect-ratio-accurate placeholders while the full image is still loading.

#### PhotoAlbum *(join table)*
| Field | Type | Notes |
|---|---|---|
| photo_id | uuid | FK → Photo |
| album_id | uuid | FK → Album |
| added_at | timestamp | |
| is_cover | boolean | |

### Messaging

#### Conversation
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| photographer_id | uuid | FK → Photographer |
| client_id | uuid | FK → Client |
| most_recent_message_id | uuid | nullable |
| number_of_unread | integer | denormalized for inbox query performance |
| last_message_at | timestamp | denormalized for inbox sorting |
| created_at | timestamp | |

#### Message
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| conversation_id | uuid | FK → Conversation |
| sender_id | uuid | FK → User |
| content | text | |
| sent_at | timestamp | |
| read_at | timestamp | nullable — NULL means unread |

### Forms & Questionnaires

#### Form Template
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| photographer_id | uuid | FK → Photographer |
| name | string | |
| created_at | timestamp | |

#### Form Question
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| template_id | uuid | FK → Form Template |
| content | text | |
| answer_type | enum('text', 'date', 'boolean') | multiple_choice dropped in migration 018 — nowhere to store the choices |
| order | integer | index of the submitted array; unique per template, dense, 0-based |

#### Form Response
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| template_id | uuid | FK → Form Template, `ON DELETE RESTRICT` — provenance and the path to the owning photographer |
| client_id | uuid | FK → Client |
| questions | jsonb | frozen copy of the template's questions, taken at assign time (migration 019) |
| answers | jsonb | `{ "<question_id>": "<answer>" }` — a missing key means unanswered |
| assigned_at | timestamp | set when the photographer assigns, not when the client starts |
| submitted_at | timestamp | nullable — NULL means in progress |

A response is **self-contained**: it renders from its own snapshot and never
reads `form_questions`. A template is a drafting surface, a response is a
record, and the snapshot is the seam between them — once a response exists,
the template can no longer change what that client was asked.

That property is what removes the old edit lock. Answers used to reference
`form_questions` rows, which a replace-all `PUT` deletes and recreates, so an
assigned template had to be frozen and edited by duplication. Nothing
references question rows any more, so `PUT` is always allowed. `DELETE` is
still refused while responses exist — not to protect question ids, but because
a response is a standalone record that must outlive its template. That rule is
in the database (`ON DELETE RESTRICT`); the 409 is the error message on top of
it.

The `form_answers` table was dropped in migration 019. Answers are only ever
read one response at a time, so a table whose sole purpose was hanging ≤25
strings off a parent row was buying referential integrity that the snapshot
made redundant, and paying for it with a join, a UNIQUE constraint and a
cross-entity validation query.

### Invites

#### Invite
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| photographer_id | uuid | FK → Photographer |
| email | string | |
| client_name | string | pre-filled by photographer |
| token | string | crypto random, one-time use |
| status | enum('pending', 'accepted', 'expired') | |
| expires_at | timestamp | 30 days from creation |
| accepted_at | timestamp | nullable |
| created_at | timestamp | |

---

## 3. REST API Surface (40 Live + 1 Planned)

> This section is synced to the implementation. Rows marked ⚠️ **not built**
> are intended but unimplemented; everything else is live in `src/routes/`.

All list endpoints are identity-scoped — filtered server-side by JWT auth token, not URL parameters. `GET /photographers/:id` returns role-scoped response shapes.

### Users
| Method | Path | Description | Access | Status |
|---|---|---|---|---|
| POST | /users | Create user on signup (Auth0 webhook) | internal | |
| GET | /users/me | The caller's own user record | both | |
| PATCH | /users/:id | Update email and name | both | |
| DELETE | /users/:id | Delete account (cascades) | both | ⚠️ **not built** |

### Photographers
| Method | Path | Description | Access | Status |
|---|---|---|---|---|
| GET | /photographers/:id | Get profile (one shape for every caller, D-18) | both | |
| PATCH | /photographers/:id | Update profile fields | photographer | |
| POST | /photographers/:id/photo | Upload profile photo (synchronous) | photographer | |
| GET | /photographers/:id/clients | Get all clients | photographer | |
| GET | /photographers/:id/albums | Get all albums | photographer | |
| GET | /photographers/:id/invites | Get pending invites | photographer | |
| GET | /photographers/:id/templates | Get form templates | photographer | |

### Clients
| Method | Path | Description | Access |
|---|---|---|---|
| GET | /clients/:id/albums | Get all albums for one client | both |
| GET | /clients/:id/responses | Get all form responses (summaries) | both |

Both are readable by the client themselves or by their photographer, via the
shared `assertCanReadClient` check — a client id in a URL is never trusted on
its own (D-17). `GET /clients/:id/albums` is how a client discovers their
galleries at all: `GET /albums/:id` needs an id they already have, and the
photographer-scoped list is closed to them.

`GET /clients/:id/conversations` was dropped: `GET /conversations` is
identity-scoped, so a client already gets their own conversation from it.
`GET /clients/:id` was dropped too — `Client` is only `{userId,
photographerId}`, and nothing needs an endpoint to read it.

### Invites
| Method | Path | Description | Access |
|---|---|---|---|
| POST | /invites | Create invite (body: email, client_name) | photographer |
| POST | /invites/:id/resend | Resend, reset token and expiry | photographer |
| DELETE | /invites/:id | Cancel invite | photographer |
| GET | /invites/validate?token=... | Validate token on link click | public |

### Albums & Photos
| Method | Path | Description | Access |
|---|---|---|---|
| POST | /albums | Create album | photographer |
| GET | /albums/:id | Get album metadata | both |
| PATCH | /albums/:id | Update album (e.g. thumbnail) | photographer |
| DELETE | /albums/:id | Delete album | photographer |
| GET | /albums/:id/photos | Get photos in (added_at, id) order, cursor-paginated (?cursor=&limit=), optional ?status=ready; responds { data, nextCursor, total, processingCount } | both |
| POST | /albums/:id/photos/batch | Bulk upload photos | photographer |
| DELETE | /albums/:id/photos/batch | Bulk remove photos from album | photographer |
| POST | /albums/:id/photos/:photoId | Add existing photo to album | photographer |
| DELETE | /albums/:id/photos/:photoId | Remove photo from album only | photographer |
| GET | /photos/:id | Get single photo | both |
| DELETE | /photos/:id | Permanently delete photo from system | photographer |

### Conversations & Messages
| Method | Path | Description | Access |
|---|---|---|---|
| GET | /conversations | Get all conversations (identity-scoped) | both |
| GET | /conversations/:id | Get single conversation | both |
| GET | /conversations/:id/messages | Get messages, paginated | both |
| POST | /conversations/:id/messages | Send message | both |
| PATCH | /conversations/:id/read | Mark the whole conversation as read | both |

### Forms & Questionnaires
| Method | Path | Description | Access |
|---|---|---|---|
| POST | /templates | Create template *with all its questions* (max 25) | photographer |
| GET | /templates/:id | Get single template, questions embedded in `order` | photographer |
| PUT | /templates/:id | Replace name + full question set | photographer |
| DELETE | /templates/:id | Delete template | photographer |
| POST | /templates/:id/responses | Assign template to client | photographer |
| GET | /responses/:id | Get form response | both |
| POST | /responses/:id/answers | Save answer (upsert) | client |
| PATCH | /responses/:id/submit | Submit completed form | client |

Two more form endpoints are listed under the resource that owns their URL
namespace rather than repeated here: `GET /photographers/:id/templates`
(Photographers) and `GET /clients/:id/responses` (Clients).

Questions have no endpoints of their own: a template and its questions are
created together and edited by replacing the whole set, so `"order"` is just
the index of the submitted array.

Access splits by column, not by role. `GET /responses/:id` passes for the
owning client **or** the template's photographer; the two write endpoints pass
for the client alone — a photographer may read a response but never answer it.
`GET /clients/:id/responses` follows the same rule via the client record, and
returns summaries without question snapshots.

`PUT /templates/:id` has no lock: responses snapshot their questions, so an
edit cannot reach a form already in a client's hands. `DELETE /templates/:id`
returns 409 while any response exists, backed by `ON DELETE RESTRICT`.

Both write endpoints carry `AND submitted_at IS NULL` in the statement that
writes, so the submitted-form lock is enforced atomically rather than by a
check-then-write pair in the handler.

---

## 4. Architecture Decisions

### Scale & Requirements

#### D-01 — System type: Read-heavy
**Decision:** Read-heavy system

**Rationale:** Clients browse photos frequently. Photographers upload infrequently and update rarely.

| Why this works | Alternatives considered |
|---|---|
| Justifies CDN, caching, and pagination optimizations over write throughput | Write-heavy design would prioritize upload queuing. Not needed here |

---

#### D-02 — Durability over availability (CAP theorem)
**Decision:** CP over AP — consistency and partition tolerance prioritized

**Rationale:** Data loss of photos is unacceptable. Downtime is tolerable.

| Why this works | Tradeoff |
|---|---|
| Drives every storage decision: ACID PostgreSQL, object storage redundancy, no eventual consistency shortcuts | AP systems (e.g. DynamoDB eventual consistency) offer higher availability. We accept lower availability to guarantee durability |

---

### Data Lifecycle

#### D-03 — Photo TTL
**Decision:** `access_expires_at = shoot_date + 3 years` for shoot albums; NULL (never expires) for portfolio albums

**Rationale:** Balances storage cost with reasonable client access window.

| Why this works | Alternatives |
|---|---|
| Deterministic and automatable. shoot_date known at album creation. No human judgment required | Photographer-driven expiry adds operational burden. No expiry = unbounded storage costs |

---

#### D-04 — Post-expiry: permanent deletion
**Decision:** Photos in shoot albums permanently deleted. Warnings at 90, 30, 7 days before expiry. Portfolio albums are exempt — nothing to revoke and nobody to warn.

**Rationale:** Minimizes storage cost. Client warned proactively with ample download time.

| Tradeoff | Alternative (F-02) |
|---|---|
| Irreversible. No recovery after deletion. Mitigated by three-warning pipeline | Cold archive storage at reduced cost. Rejected for MVP |

---

#### D-24 — Expiry warnings: EmailSender port, sent before marking
**Decision:** Warnings go to the **client** through an `EmailSender` interface in `src/email/`, selected by `EMAIL_PROVIDER`. The send completes *before* `warned_*_at` is written.

**Rationale:** The recipient is whoever loses something — the client's access is what ends. The port keeps provider SDKs out of the job processors, so the pipeline is buildable and testable against a `console` adapter that needs no credentials, with SES as the intended production adapter.

Ordering is the reliability decision. Marking first is at-most-once: a provider timeout would flag the album as warned, nobody would hear anything, and the album would be deleted on schedule. Sending first is at-least-once — a failure throws, the mark is skipped, and the next daily run retries.

| Why this works | Tradeoff |
|---|---|
| Worst case is a duplicate email, against a warning silently missed before an irreversible deletion. Milestones are 60+ days apart, so a day's retry costs nothing | An adapter that swallows its own errors breaks the guarantee — senders must throw. The `console` adapter never fails, so the retry path is exercised by tests, not in local use |

---

#### D-25 — Deletion gated on the final warning
**Decision:** `delete-expired` only touches albums with `warned_7_at IS NOT NULL`. The column asserts that the warning **step completed**, not that a human received anything.

**Rationale:** D-04 makes deletion irreversible and cites the three-warning pipeline as the mitigation. That mitigation is only real if a failed pipeline stops the deletion — otherwise a mail outage through the run-up means silent permanent data loss.

The second half of the decision is what keeps the gate from becoming a leak. A shoot album whose client was deleted (`client_id` is `ON DELETE SET NULL`) has nobody to warn and never will, so it is marked warned without a send. Left NULL, the gate would preserve that album — and its Cloudinary assets — indefinitely, which is exactly the unbounded storage cost D-03 exists to avoid.

| Why this works | Tradeoff |
|---|---|
| Turns the warning pipeline from advisory into a precondition. Albums arrive late rather than disappearing unannounced | A prolonged outage defers deletions and storage cost with them. Needs monitoring on albums past expiry still awaiting a warning |

---

### Infrastructure

#### D-05 — Image storage: object storage + DB metadata
**Decision:** Cloudinary for bytes. PostgreSQL for `base_path` key only.

**Rationale:** Databases not optimized for binary blobs. `base_path` convention covers all 3 variants.

| Why this works | Tradeoff |
|---|---|
| Keeps DB lean. Re-processing variants is trivial. URL changes = one config update | Two systems to sync. DB row becomes dangling reference if Cloudinary loses a file |

---

#### D-06 — Image processing: Cloudinary (managed)
**Decision:** Cloudinary handles processing, 3 variants per photo, and CDN delivery.

**Rationale:** CPU-intensive and spiky. Burst of 500 wedding photos would crater self-managed servers.

| Why this works | Tradeoff |
|---|---|
| Built-in global CDN. No processing code to maintain. Resolves read-heavy optimization in one decision | Vendor lock-in. Cost scales with usage. Migratable to Lambda pipeline at scale |

---

#### D-07 — Authentication: Auth0/Clerk (managed)
**Decision:** Managed auth service. User table stores `provider_id` reference.

**Rationale:** Security-critical infrastructure. Rolling your own means building hashing, sessions, token refresh, brute force protection.

| Why this works | Tradeoff |
|---|---|
| Battle-tested at scale. Free tier for MVP. Security specialists maintain it | Vendor dependency. Two systems to sync — mitigated by webhook pattern |

---

#### D-08 — Auth-to-DB sync: webhook pattern
**Decision:** Webhook fires on signup. Server creates User + role profile + Conversation atomically.

**Rationale:** Prevents orphaned auth records. Auth provider handles retries automatically.

| Why this works | Tradeoff |
|---|---|
| Atomic creation of all records in one transaction. No extra client API calls post-signup | Webhook failure leaves auth record without DB row. Network partition is a real failure mode |

---

#### D-09 — Database: AWS RDS (PostgreSQL)
**Decision:** PostgreSQL via Docker locally. AWS RDS in production.

**Rationale:** 11 entities, complex joins, ACID requirements. RDS chosen to focus learning on application code.

| Why SQL over NoSQL | Why RDS over self-managed |
|---|---|
| ACID guarantees, foreign keys, complex expiry queries trivial vs NoSQL | Handles backups, failover, patching. Directly relevant to most company stacks |

---

#### D-10 — Cache & Queue: AWS ElastiCache (Redis)
**Decision:** ElastiCache serves both BullMQ queue and application cache.

**Rationale:** Memory-intensive and stateful. Large blast radius losing both cache and queue simultaneously.

| Why managed | Tradeoff |
|---|---|
| AWS handles clustering and failover. Consistent with managed services pattern | At scale, separate instances for cache and queue may be needed (F-06) |

---

#### D-11 — Server framework: Express (migration path to Fastify)
**Decision:** Express with TypeScript for MVP.

**Rationale:** Express chosen for ecosystem maturity. Architecture kept framework-agnostic for thin migration path.

| Why Express now | Why Fastify later |
|---|---|
| 13 years of ecosystem and hiring familiarity. Maximum transparency for learning | Native TypeScript, built-in validation, ~2x performance. Identical concepts |

---

#### D-12 — Language: Node.js / TypeScript
**Decision:** Node.js with TypeScript.

**Rationale:** System is I/O bound. Node event loop handles concurrent I/O efficiently. CPU work offloaded to Cloudinary.

| Why Node | When to reconsider |
|---|---|
| Event loop ideal for I/O bound. Thousands of concurrent connections with low memory overhead | Go at 10M+ users. Python if ML inference moves server-side (F-01) |

---

#### D-13 — Background jobs: BullMQ + Redis
**Decision:** BullMQ for queue. Separate worker process. API returns 202 immediately on upload.

**Rationale:** Handles scheduled work (expiry cron) and triggered work (photo processing). Jobs survive worker crashes in Redis.

| Why BullMQ over RabbitMQ | Learn Kafka later |
|---|---|
| Node-native, built-in scheduling and retries, Bull Board dashboard | For F-01 analytics pipeline. BullMQ messages consumed and deleted. Kafka retains immutable log — multiple consumers replay independently |

---

### Caching

#### D-14 — Caching strategy: cache-aside
**Decision:** Cache-aside for all resources. Application manages cache explicitly.

**Rationale:** Read-heavy with infrequent writes. Only caches what is requested. Cache failure degrades gracefully.

| Why cache-aside | Why not write-through |
|---|---|
| Flexible. Cache failure does not break the app. Works with hybrid TTL + event invalidation | Extra write latency. Write-behind rejected — data loss risk |

---

#### D-15 — Cache invalidation: hybrid TTL + event-driven
**Decision:** TTL for slow-changing data. Event-driven invalidation for sensitive mutations.

**Rationale:** Staleness tolerance varies by resource. Profile stale for an hour is fine. Deleted photo appearing in gallery is not.

| Why hybrid | Tradeoff |
|---|---|
| Matches invalidation cost to staleness risk. TTL handles easy cases. Events fire only where needed | Event invalidation adds logic to write handlers. Easy to miss edge cases |

#### What to cache

| Resource | TTL | Invalidation |
|---|---|---|
| Album photo list | 5 min | Event: photo added/deleted |
| Album metadata | 15 min | Event: thumbnail updated |
| Photographer profile | 1 hour | TTL only |
| Conversation list | 2 min | Event: new message sent |

**Not cached:** Messages, unread counts, form responses — staleness tolerance is zero.

> 💡 **Interview note:** Conversation list uses two-layer optimization — denormalization reduces query complexity, caching reduces query frequency. Applying both levers to the same bottleneck is a production-grade pattern.

> **TTL selection framework:** `TTL = f(change frequency, staleness tolerance)`. Changes rarely + staleness acceptable = long TTL. Changes frequently + staleness unacceptable = no cache.

---

### API Design

#### D-16 — API paradigm: REST
**Decision:** REST over GraphQL.

**Rationale:** Predictable access patterns, simpler HTTP caching, native file upload support.

| Why REST | When GraphQL wins |
|---|---|
| Stable access patterns. HTTP caching native. File uploads straightforward | Multiple clients needing different data shapes. Not applicable here yet |

---

#### D-17 — Identity-scoped queries
**Decision:** List endpoints filtered by JWT identity, not URL parameters.

**Rationale:** Prevents parameter manipulation attacks. Server reads identity from JWT automatically.

| Why this works | Tradeoff |
|---|---|
| JWT is cryptographically signed. URL parameters can be changed by anyone | Admin tooling needs special bypass logic to view arbitrary user data |

---

#### D-18 — Role-scoped field authorization
**Decision:** `GET /photographers/:id` returns one response shape to every caller — no role branching.

**Rationale:** None of the fields on `Photographer` (business name, bio, profile photo, Instagram handle, visibility) are actually sensitive — they're portfolio/storefront content by design, not private data. Revised from an earlier decision to split the response by caller role, which added authorization branching this resource doesn't need.

| Why one shape | Alternative |
|---|---|
| Simpler handler, no risk of a field leaking into the wrong response shape. Nothing here needs hiding | Role-scoped shapes (previous decision) — justified when some fields are genuinely private, not the case here |

---

#### D-19 — Client signup: invite only
**Decision:** Tokenized link, one-time use, 30-day expiry, `client_name` pre-filled.

**Rationale:** Clients exist only in context of photographer relationship. Invite enforces this cleanly.

| Why invite-only | Self-signup (F-05) |
|---|---|
| Every client always linked to a photographer. No orphaned accounts | Same creation flow, link established via code or search post-MVP |

---

#### D-26 — Client identity: `GET /users/me`, not JWT claims
**Decision:** The frontend resolves its own identity by calling `GET /users/me`, which returns the `User` row `loadUser` already resolved. Auth0 custom claims were rejected.

**Rationale:** After login the browser holds a JWT whose `sub` is an Auth0 identifier, but every URL in this API is keyed by the app's own `users.id` UUID, and the shell needs the caller's role to decide which product to render. Nothing in the token supplies either.

Custom claims would remove the round trip, but they contradict D-08: the `users` table is the source of truth for user records. A role change wouldn't take effect until the token refreshed, and the webhook already syncs Auth0 into the database — claims would add a second sync running the other way, with the identity data able to disagree between them.

| Why this works | Tradeoff |
|---|---|
| Always current, no Auth0-side configuration, and app logic stays in the repo under code review | One extra request during app boot. The route must be registered before any `GET /:id` on the same router, or Express matches `me` as an id |

---

#### D-20 — Conversation auto-creation
**Decision:** Created in same transaction as Client on invite acceptance.

**Rationale:** Every client always has a channel. Consistent with photographer profile creation pattern.

| Why atomic | Tradeoff |
|---|---|
| Either all records created or none. No partial state | If any insert fails, entire signup rolls back |

---

## 5. Deployment Architecture

### Full Request Path

```
Client browser
      ↓
AWS ALB
  (distributes traffic, health checks, zero-downtime rolling deploys)
      ↓
nginx reverse proxy
  (SSL/TLS termination, compression, security headers, rate limiting)
      ↓
Express API server
  (handles requests, business logic, adds jobs to BullMQ queue)
      ↓
BullMQ worker (same EC2 instance)
  (photo processing, expiry notifications, deletion pipeline)
      ↓
AWS RDS (PostgreSQL)          AWS ElastiCache (Redis)
  (disk I/O heavy, stateful,    (memory heavy, stateful,
   scales via read replicas)     serves cache + job queue,
                                 scales via clustering)
```

### Deployment Decisions

#### D-21 — Cloud provider: AWS (Tier 1)
**Decision:** AWS over managed platforms (Railway, Render, Heroku).

| Why AWS | When Tier 2 wins |
|---|---|
| Less abstracted. Exposes networking and scaling decisions. 32% global cloud market share | Early-stage startups prioritizing speed over control |

---

#### D-22 — Component separation
**Decision:** EC2 for Express + BullMQ. RDS for PostgreSQL. ElastiCache for Redis.

| Key insight | Why worker shares EC2 |
|---|---|
| Stateless (Express) scales horizontally — add identical copies. Stateful (DB, Redis) scales via replication/clustering — fundamentally different strategy | Both I/O bound. Worker mostly idle waiting on Cloudinary/DB. Small blast radius. Not worth dedicated server at MVP |

---

#### D-23 — Request path: ALB + nginx
**Decision:** AWS ALB in front of EC2. nginx as reverse proxy.

| Load balancer motivation | Reverse proxy motivation |
|---|---|
| Even with one server, enables rolling deploys: spin new instance, shift traffic, terminate old — zero user-facing downtime | nginx handles SSL termination, rate limiting, compression before requests reach Express |

> **Key distinction:** Load balancers operate at traffic distribution level (which server). Reverse proxies operate at request handling level (how the request is prepared). Complementary, not interchangeable. PostgreSQL and Redis are NOT load balanced — they use replication and clustering instead.

---

## 6. Post-MVP Roadmap

| Item | Description |
|---|---|
| **F-01** | **Photographer discovery & search.** Requires: Elasticsearch/Algolia, geospatial indexing, Review entity, ranking algorithm. LLM opportunity: natural language search, semantic portfolio matching. **Learn Kafka here** for analytics event streaming — multiple consumers replay the same events independently. |
| **F-02** | **Post-expiry paid storage.** Allow clients to pay to extend beyond 3-year TTL. Requires Stripe billing integration and storage tier management. |
| **F-03** | **Multi-photographer collaboration.** Albums owned by multiple photographers. Requires album ownership join table. |
| **F-04** | **Client access to multiple albums.** Schema already supports expansion — no structural changes needed, just remove 1:1 constraint. |
| **F-05** | **Client self-signup.** Same User + Client creation flow. Photographer link established via code or search instead of invite token. |
| **F-06** | **Separate Redis instances for cache and queue.** At scale, isolating ElastiCache instances prevents cache eviction from impacting job queue and vice versa. |
| **F-07** | **Migrate Express to Fastify.** Business logic is framework-agnostic — migration is a thin layer swap. Gains: native TypeScript, built-in validation, ~2x performance. |

---

## 7. Claude Code Implementation Guide

### Recommended Implementation Order

1. Project setup: TypeScript, Express, folder structure, environment config
2. Database: PostgreSQL connection, run migrations from schema above
3. Auth: Auth0/Clerk integration, webhook handler, JWT middleware
4. Core entities: User, Photographer, Client endpoints
5. Albums & Photos: upload pipeline, Cloudinary integration, batch endpoints
6. BullMQ: worker process, photo processing jobs, expiry cron scheduler
7. Redis: caching layer, cache-aside implementation, event invalidation handlers
8. Messaging: Conversation auto-creation, Message endpoints, read receipts
9. Forms: Template, Question, Response endpoints (answers live on the response)
10. Invites: full invite flow end to end, resend logic
11. Deployment: EC2, RDS, ElastiCache setup, ALB config, nginx reverse proxy

### How to Use Claude Code Without Losing the Learning

> **Core question:** Before every prompt: "Do I know what I want this code to do, and am I asking Claude to help me express it — or asking Claude to figure out what to do for me?"

#### Always implement yourself:
- Route handlers — the logic of what each endpoint actually does
- Middleware — auth checks, role validation, error handling
- Database queries — actual SQL or ORM queries
- Business logic — expiry pipeline, invite token generation, conversation auto-creation

#### Fine to delegate to Claude Code:
- Project setup — TypeScript config, folder structure
- Boilerplate — repetitive CRUD after you have written it once yourself
- Debugging — "here is my error, what is wrong?"
- Migrations — SQL to create tables from this schema
- Type definitions — TypeScript interfaces from schema

#### Workflow per feature:
1. Write the route signature yourself (path, verb, empty handler)
2. Write the logic yourself
3. Run it, break it, fix it yourself before asking Claude
4. Ask Claude Code to review: "Does this implementation have any issues?"
5. Ask **why** for every suggestion — never accept changes blindly

#### Crutch warning signs:
- Copying code you do not fully understand
- Not hitting errors (errors mean you are writing code)
- Unable to explain why code works
- Prompting Claude before attempting something yourself

---

*Generated from system design session. Bring this document into Claude Code as your implementation spec.*

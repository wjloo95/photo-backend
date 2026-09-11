# Photography App Backend
## System Design Architecture Document

> Complete decisions log with rationale and tradeoffs

**Stack:** Node.js / TypeScript · Express · PostgreSQL (RDS) · Redis (ElastiCache) · BullMQ · Cloudinary · Auth0/Clerk · AWS

**Scale:** 12 database entities · 43 REST endpoints · 23 architecture decisions · 7 post-MVP items · Millions of users target

---

## Table of Contents

1. [System Overview & Requirements](#1-system-overview--requirements)
2. [Database Schema](#2-database-schema-12-entities)
3. [REST API Surface](#3-rest-api-surface-43-endpoints)
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
- Photo TTL: 3 years from shoot date, then permanent deletion with warnings at 90/30/7 days

### Expiry Pipeline

| Trigger | Action |
|---|---|
| expiry - 90 days | Send warning email → set `warned_90_at` |
| expiry - 30 days | Send warning email → set `warned_30_at` |
| expiry - 7 days | Send final warning → set `warned_7_at` |
| **expiry date** | **Revoke access → permanently delete from Cloudinary and DB** |

> ⚠️ **Tradeoff:** Deletion is irreversible. No recovery path after deletion. Mitigated by three-warning notification pipeline. Post-expiry paid storage is a post-MVP consideration (F-02).

---

## 2. Database Schema (12 Entities)

PostgreSQL via AWS RDS. All entities use UUID primary keys. Foreign keys enforced at database level.

### Auth & Users

#### User
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| email | string | |
| role | enum('photographer', 'client') | |
| provider_id | string | Auth0/Clerk ref |
| joined_at | timestamp | |

#### Photographer
| Field | Type | Notes |
|---|---|---|
| user_id | uuid | FK → User |
| business_name | string | |
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
| access_expires_at | timestamp | shoot_date + 3 years |
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
| uploaded_at | timestamp | |

> **Note on base_path:** Variants are derived by convention — `{base_path}/original.jpg`, `{base_path}/standard.jpg`, `{base_path}/thumbnail.jpg`. Only one field needed in DB.

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
| answer_type | enum('text', 'multiple_choice', 'date', 'boolean') | |
| order | integer | |

#### Form Response
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| template_id | uuid | FK → Form Template |
| client_id | uuid | FK → Client |
| started_at | timestamp | |
| submitted_at | timestamp | nullable — NULL means in progress |

#### Form Answer
| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| response_id | uuid | FK → Form Response |
| question_id | uuid | FK → Form Question |
| content | text | |

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

## 3. REST API Surface (43 Endpoints)

All list endpoints are identity-scoped — filtered server-side by JWT auth token, not URL parameters. `GET /photographers/:id` returns role-scoped response shapes.

### Users
| Method | Path | Description | Access |
|---|---|---|---|
| POST | /users | Create user on signup (Auth0 webhook) | internal |
| PATCH | /users/:id | Update email | both |
| DELETE | /users/:id | Delete account (cascades) | both |

### Photographers
| Method | Path | Description | Access |
|---|---|---|---|
| GET | /photographers/:id | Get profile (role-scoped response shape) | both |
| PATCH | /photographers/:id | Update profile fields | photographer |
| POST | /photographers/:id/photo | Upload profile photo | photographer |
| GET | /photographers/:id/clients | Get all clients | photographer |
| GET | /photographers/:id/albums | Get all albums | photographer |
| GET | /photographers/:id/invites | Get pending invites | photographer |
| GET | /photographers/:id/templates | Get form templates | photographer |

### Clients
| Method | Path | Description | Access |
|---|---|---|---|
| GET | /clients/:id | Get client profile | both |
| GET | /clients/:id/albums | Get all albums | client |
| GET | /clients/:id/responses | Get all form responses | both |
| GET | /clients/:id/conversations | Get client conversation | client |

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
| GET | /albums/:id/photos | Get photos, paginated (?page=&limit=) | both |
| POST | /albums/:id/photos/batch | Bulk upload photos | photographer |
| DELETE | /albums/:id/photos/batch | Bulk remove photos from album | photographer |
| POST | /albums/:id/photos/:id | Add existing photo to album | photographer |
| DELETE | /albums/:id/photos/:id | Remove photo from album only | photographer |
| GET | /photos/:id | Get single photo | both |
| DELETE | /photos/:id | Permanently delete photo from system | photographer |

### Conversations & Messages
| Method | Path | Description | Access |
|---|---|---|---|
| GET | /conversations | Get all conversations (identity-scoped) | both |
| GET | /conversations/:id | Get single conversation | both |
| GET | /conversations/:id/messages | Get messages, paginated | both |
| POST | /conversations/:id/messages | Send message | both |
| PATCH | /conversations/:id/messages/:id | Mark message as read | both |

### Forms & Questionnaires
| Method | Path | Description | Access |
|---|---|---|---|
| POST | /templates | Create form template | photographer |
| GET | /templates/:id | Get single template | photographer |
| PATCH | /templates/:id | Update template | photographer |
| DELETE | /templates/:id | Delete template | photographer |
| POST | /templates/:id/questions | Add question | photographer |
| PATCH | /templates/:id/questions/:id | Edit question | photographer |
| DELETE | /templates/:id/questions/:id | Remove question | photographer |
| POST | /templates/:id/responses | Assign template to client | photographer |
| GET | /responses/:id | Get form response | both |
| POST | /responses/:id/answers | Save answer | client |
| PATCH | /responses/:id/answers/:id | Edit saved answer | client |
| PATCH | /responses/:id/submit | Submit completed form | client |

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
**Decision:** `access_expires_at = shoot_date + 3 years`

**Rationale:** Balances storage cost with reasonable client access window.

| Why this works | Alternatives |
|---|---|
| Deterministic and automatable. shoot_date known at album creation. No human judgment required | Photographer-driven expiry adds operational burden. No expiry = unbounded storage costs |

---

#### D-04 — Post-expiry: permanent deletion
**Decision:** Photos permanently deleted. Warnings at 90, 30, 7 days before expiry.

**Rationale:** Minimizes storage cost. Client warned proactively with ample download time.

| Tradeoff | Alternative (F-02) |
|---|---|
| Irreversible. No recovery after deletion. Mitigated by three-warning pipeline | Cold archive storage at reduced cost. Rejected for MVP |

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

**Rationale:** 12 entities, complex joins, ACID requirements. RDS chosen to focus learning on application code.

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
**Decision:** `GET /photographers/:id` returns different shapes by caller role.

**Rationale:** Clients see public fields only. Photographers see all fields including visibility settings.

| Why one endpoint | Alternative |
|---|---|
| Authorization concern, not routing concern. Cleaner API surface | Two separate endpoints. More explicit but doubles count for every role-sensitive resource |

---

#### D-19 — Client signup: invite only
**Decision:** Tokenized link, one-time use, 30-day expiry, `client_name` pre-filled.

**Rationale:** Clients exist only in context of photographer relationship. Invite enforces this cleanly.

| Why invite-only | Self-signup (F-05) |
|---|---|
| Every client always linked to a photographer. No orphaned accounts | Same creation flow, link established via code or search post-MVP |

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
9. Forms: Template, Question, Response, Answer endpoints
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

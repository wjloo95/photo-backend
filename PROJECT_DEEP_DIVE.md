# Project Deep Dive: Talking About This Backend

> A preparation guide for the interview where someone says *"tell me about
> something you built."* It covers what to say, in what order, what they're
> actually testing, and where the conversation will go next.
>
> Companion document: [SYSTEM_DESIGN_STUDY.md](SYSTEM_DESIGN_STUDY.md) — the same
> system treated as a design problem rather than as your project.

---

## How the interview actually runs

A project deep dive is not a demo. It is a 45-minute test of four things, and
interviewers score them separately:

| What they're testing | How they test it |
|---|---|
| **Depth** — did you build it or assemble it? | "Why that?" repeated three times on any one decision |
| **Judgment** — can you defend a choice *and* its cost? | "What would you do differently?" |
| **Honesty** — do you know your own weaknesses? | "What's broken?" / "What breaks first at 10×?" |
| **Communication** — can you scope an answer to the listener? | Whether they have to interrupt you to get to the point |

The single most common failure is **narrating the codebase instead of the
decisions**. Nobody wants a tour of your folders. They want to hear you make a
call and price it.

**Structural habit that fixes most of this:** answer in three beats.

> **Claim** (one sentence) → **Reason** (the constraint) → **Cost** (what you gave
> up). Then stop and let them ask.

If they want more, they will ask. If you volunteer everything, you sound
unfiltered rather than thorough.

---

## Contents

1. [The 90-second pitch](#1-the-90-second-pitch)
2. [The five-minute walkthrough](#2-the-five-minute-walkthrough)
3. [Diagrams to have in your hands](#3-diagrams-to-have-in-your-hands)
4. [The five stories](#4-the-five-stories)
5. [Question bank](#5-question-bank)
6. [Traps, and how to take them](#6-traps-and-how-to-take-them)
7. [Weaknesses to volunteer](#7-weaknesses-to-volunteer)
8. [Numbers to have memorised](#8-numbers-to-have-memorised)
9. [Dry-run protocol](#9-dry-run-protocol)

---

## 1. The 90-second pitch

Memorise the *shape*, not the words. It has four beats: what it is, what it's
built on, how big, and **one non-obvious thing** — that last beat is what earns
the follow-up question you want.

> "It's the backend for a photography platform. Photographers upload client
> galleries and portfolios, message their clients, and send them intake
> questionnaires; clients view and download their photos. Node and TypeScript on
> Express, Postgres on RDS, Redis for both the cache and the job queue,
> Cloudinary for image storage and delivery, Auth0 for identity. Forty REST
> endpoints, twenty migrations, and a separate BullMQ worker process.
>
> The part I'd point at is the data lifecycle. Client access to a shoot expires
> three years after the shoot date and the photos are then permanently deleted,
> with warning emails at ninety, thirty and seven days. Because that deletion is
> irreversible, the deletion sweep won't touch an album until the final warning
> has actually been recorded as sent — so if the mail provider is down through
> the whole run-up, albums arrive late instead of disappearing unannounced.
> That one predicate is the difference between a warning pipeline that's advice
> and one that's a precondition."

**Why that closing beat works:** it's specific, it's a decision rather than a
feature, and it invites exactly the follow-up you're prepared for ("what if the
client was deleted and there's nobody to warn?" — see
[Story 2](#story-2--the-deletion-gate-and-the-hole-in-it)).

**Have a 20-second version too**, for when the pitch is a preamble to something
else:

> "A photography platform backend — Node, Postgres, Redis, BullMQ. Photographers,
> client galleries, messaging, forms. The interesting part is a three-year data
> retention pipeline that deletes photos permanently, so most of the design is
> about making sure that only happens when it's supposed to."

---

## 2. The five-minute walkthrough

Only give this if asked. Follow a **request**, not a directory listing.

### Beat 1 — The path in (45 s)

> "ALB in front of EC2, nginx in front of Express for TLS termination, rate
> limiting and compression. Express is stateless so instances are interchangeable
> — even with one instance, the load balancer is what makes rolling deploys
> zero-downtime.
>
> Every authenticated request runs two middlewares. `auth` verifies the JWT
> against Auth0's JWKS. `loadUser` takes the Auth0 `sub` and resolves it to our
> own `users` row, because every URL in the API is keyed by our UUID and every
> authorisation check needs the role. Then `requireRole` is a factory that
> returns middleware for one role."

**Prepared follow-up:** *why not put the role in a JWT claim?* → the DB is the
source of truth; a claim adds a second sync running the other way; a role change
wouldn't take effect until the token refreshed; and auth logic would leave the
repo. Cost: a DB read per request, cacheable when it matters.

### Beat 2 — The data model (60 s)

> "Eleven entities. `users` at the root, then `photographers` and `clients`
> hanging off it — and for both of those, `user_id` is both the primary key and
> the foreign key, which enforces the one-to-one in the schema rather than in
> code. That means a photographer's id *is* their user id, so authorisation
> checks are direct comparisons with no lookup in between.
>
> Below that: albums and photos joined many-to-many, conversations and messages,
> form templates and responses, and invites. All UUID keys, all `TIMESTAMPTZ`,
> snake_case in the database with one mapper function per table to camelCase
> entities."

**Prepared follow-up:** *why many-to-many on photos?* → a photo can appear in a
shoot album and in the photographer's portfolio. That's also why a photo has no
owner column and access is resolved through every album it belongs to — and why
the deletion sweep only destroys a photo when it was in exactly one album.

### Beat 3 — The write path that matters (75 s)

> "Uploading is the one genuinely heavy operation — a wedding is 500 files and a
> couple of gigabytes. So `POST /albums/:id/photos/batch` stages the files,
> inserts a `photos` row per file at `status: 'processing'` in one transaction
> along with the album join rows, enqueues one job, and returns 202 immediately.
> It never waits for Cloudinary.
>
> The worker picks it up, uploads each file, and flips the row to `'ready'` with
> the real `base_path`, width and height. Two details make the retries safe:
> BullMQ retries the whole batch, so the processor skips any photo already
> `'ready'`; and the temp file is deleted only *after* the DB write confirms, so
> a failure never strands a photo at `'processing'` with no bytes left to retry
> from."

**Prepared follow-up:** *where does the file live between the two?* → this is the
question that finds the real flaw. Answer it honestly and immediately — see
[§7](#7-weaknesses-to-volunteer).

### Beat 4 — The background pipeline (75 s)

> "Two queues. `photoQueue` is triggered by uploads. `expiryQueue` runs four cron
> jobs daily at 08:00 UTC — three warnings and a deletion sweep.
>
> The warning query looks for albums where expiry is *within* the window and the
> matching `warned_*_at` column is still null. It's `<=` rather than `=`
> deliberately: matching an exact day means an album whose warning day passed
> while the worker was down gets skipped forever. With `<=`, the condition stays
> true until something clears it, and the timestamp column is what clears it.
>
> Email goes through a small `EmailSender` port rather than a provider SDK, and
> the send happens *before* the album is marked warned. Marking first would be
> at-most-once — a timeout would flag it as warned, nobody would hear anything,
> and it'd be deleted on schedule. Sending first is at-least-once; worst case is
> a duplicate email."

### Beat 5 — Caching, briefly (45 s)

> "Cache-aside on four things: album metadata at fifteen minutes, the album photo
> list at five, photographer profiles at an hour, conversation lists at two
> minutes. Messages and unread counts aren't cached at all — zero staleness
> tolerance. The TTLs come from one rule: TTL is a function of how often the
> thing changes and how much staleness the user can't detect."

Then **stop**. Five beats, five minutes. Let them steer.

---

## 3. Diagrams to have in your hands

Practise drawing these from memory. Whiteboard-able in under 30 seconds each.

### Request path

```
browser
  │
  ▼
AWS ALB ──────────► health checks, rolling deploys
  │
  ▼
nginx ────────────► TLS, rate limit, gzip, security headers
  │
  ▼
Express (stateless)
  │   helmet → cors → json(+rawBody) → /health
  │   /users, /invites   ── mounted BEFORE auth (webhook, public validate)
  │   auth → loadUser    ── everything below is authenticated
  │   /photographers /albums /photos /conversations /templates /responses /clients
  │   errorHandler
  ├──────────────► Postgres (RDS)      pool max 10
  ├──────────────► Redis (ElastiCache) cache + BullMQ
  └──────────────► Cloudinary          bytes + CDN

BullMQ worker (separate process)
      photoQueue  → photoProcessor
      expiryQueue → expiryProcessor  (4 daily cron jobs)
```

### Photo upload sequence

```
photographer        API                     DB              Redis        worker      Cloudinary
     │  multipart    │                       │                │            │             │
     ├──────────────►│                       │                │            │             │
     │               ├─ BEGIN ──────────────►│                │            │             │
     │               │  INSERT n photos ('processing')        │            │             │
     │               │  INSERT n photo_albums │               │            │             │
     │               ├─ COMMIT ─────────────►│                │            │             │
     │               ├─ rename tmp → /<photoId>                            │             │
     │               ├─ add(ProcessBatch, {photoIds}) ───────►│            │             │
     │               ├─ del album:photos:{id} ───────────────►│            │             │
     │◄─ 202 + rows ─┤                       │                ├───────────►│             │
     │               │                       │                │            ├─ upload ───►│
     │               │                       │◄─ markPhotoReady ───────────┤◄────────────┤
     │               │                       │                │            ├─ unlink     │
```

### Album expiry state machine

```
        created (shoot)                        created (portfolio)
   access_expires_at = shoot+3y              access_expires_at = NULL
              │                                        │
              ▼                                        ▼
   ┌──────────────────────┐                  never enters any sweep
   │ expiry − 90d  ──► warned_90_at          (NULL <= x is NULL, not TRUE;
   │ expiry − 30d  ──► warned_30_at           CHECK constraint guarantees it)
   │ expiry −  7d  ──► warned_7_at
   └──────────┬───────────┘
              │  send FIRST, then mark  (a throw skips the mark → retry tomorrow)
              ▼
   access_expires_at < NOW()  AND  warned_7_at IS NOT NULL
              │                            ▲
              ▼                            └── the gate: no final warning, no delete
   per photo: last album? → cloudinary.destroy + DELETE photo
   then DELETE album
```

### Invite state machine

```
POST /invites ──► [pending] ──── expires_at passes ────► [expired]
                    │  ▲                                     │
     accept         │  └───── POST /:id/resend ──────────────┘
   (FOR UPDATE)     │         new token, +30d, status → pending
                    ▼
               [accepted] ──── resend blocked (409)

accept = ONE transaction:
   users row + clients row + conversations row + invite status
   all four, or none.
```

### Form lifecycle

```
POST /templates ─────► template + questions   (one transaction, order = array index)
PUT  /templates/:id ─► replace whole set      (no lock — see Story 1)
       │
       ▼
POST /templates/:id/responses
       │  INSERT … SELECT jsonb_agg(questions)   ← SNAPSHOT, atomic in one statement
       ▼
  [in progress]  submitted_at IS NULL
       │  POST /responses/:id/answers    answers = answers || {qid: text}
       ▼                                 …WHERE id=$1 AND submitted_at IS NULL
  [submitted]    submitted_at = NOW()    terminal — no unsubmit
```

---

## 4. The five stories

Each has the same shape: **the situation, the wrong first answer, what broke, the
insight, the fix, and the cost.** That shape is what makes a story land — a story
with no wrong first answer sounds rehearsed, because real engineering has one.

Have all five loaded. You'll use two or three.

### Story 1 — The form snapshot

*Use this when asked: "what was the hardest design decision?" or "tell me about
a time you changed your mind."*

**Situation.** Photographers build questionnaire templates and assign them to
clients. I modelled it normalised: `form_templates → form_questions`, and a
`form_answers` table keyed by `(response_id, question_id)`. Textbook third normal
form.

**What broke.** Editing a template replaces its whole question set — delete the
rows, insert the new ones — which mints new question ids. Every answer pointing at
an old id is orphaned. So I locked it: once a template had been assigned to
anyone, `PUT` returned 409, and a photographer who wanted to fix a typo had to
duplicate the whole template.

I shipped that. Then I looked at what it meant for the product: *you can never
edit a form you've used.* That's not a constraint, that's a defect with a status
code.

**The insight.** I had the relationship backwards. A template isn't the source of
truth for a response — it's a **drafting surface**. A response is a **record of
what one specific person was asked and what they said.** Records don't get
retroactively edited by the thing that generated them. An invoice snapshots the
price. A contract snapshots the terms.

**The fix (migration 019).** The response now carries a frozen copy of the
questions in a JSONB column, taken at assign time, and answers in a JSONB object
keyed by question id. `form_answers` is dropped. The template FK becomes
`ON DELETE RESTRICT`, so the database itself guarantees a response outlives the
template it came from.

Four things fell out at once, which is how I knew it was the right model rather
than a workaround:

- The edit lock disappeared entirely — not tightened, *removed*, because the
  reason for it stopped existing.
- Rendering a response went from three queries to one.
- "Is this question on this form?" became an array lookup on data already in
  hand, instead of a cross-table validation query.
- The snapshot is taken inside the `INSERT … SELECT` that creates the row, so
  there's no window where a concurrent template edit could swap the questions out
  halfway through.

**The cost.** Question text is duplicated per response — fine at a 25-question
cap, not fine at 500. You genuinely cannot fix a typo on already-assigned forms;
that's now correct behaviour, but it *is* a behaviour I chose. And JSONB is weakly
typed, so the shape is a convention the migration and the query functions have to
agree on.

**Line to land it on:** *"Normalise things you'll edit. Snapshot things you have
to be able to reproduce."*

### Story 2 — The deletion gate, and the hole in it

*Use this when asked about failure modes, irreversibility, or "what's a decision
you're proud of?"*

**Situation.** Shoot albums expire three years after the shoot and the photos are
permanently deleted from Cloudinary and the database. Warnings at 90, 30 and 7
days.

**The first version.** Four daily cron jobs. Three warning jobs mark
`warned_*_at` and send an email; a deletion job takes everything past its expiry
date.

**What I noticed before it bit me.** The justification for permanent deletion was
"we warn them three times." But nothing connected the warnings to the deletion. If
the mail provider had been down through the entire run-up, all three warnings
would fail — and the album would still be deleted on schedule, silently and
permanently. The mitigation I'd cited as the reason the policy was acceptable
wasn't actually load-bearing.

**Two changes.**

First, ordering: send the email, *then* write `warned_*_at`. Marking first is
at-most-once — a provider timeout flags the album as warned, nobody hears
anything, and it's deleted on time. Sending first is at-least-once; a failure
throws, the mark is skipped, and tomorrow's run picks it up again because the
column is still null. Worst case became a duplicate email. That contract is
documented on the `EmailSender` interface itself, because an adapter that
swallows its own errors would silently break the whole guarantee.

Second, the gate: `delete-expired` only selects albums where
`warned_7_at IS NOT NULL`. If email is broken, albums arrive late instead of
disappearing unannounced.

**The hole I then had to close.** `albums.client_id` is `ON DELETE SET NULL`, so
deleting a client detaches their shoot albums rather than removing them. Such an
album has nobody to warn — and never will. With the gate in place,
`warned_7_at` would stay null forever and the album, plus its gigabytes of
Cloudinary assets, would be preserved indefinitely. **A safety gate with no
escape hatch is a storage leak.** So the processor marks those albums warned
without sending, and logs a warning. The column asserts *the step completed*, not
*a human read something* — and I had to write that distinction down, because it's
the kind of thing that looks like a bug six months later.

**The cost.** A prolonged mail outage defers deletions and the storage cost with
them. That needs a monitor: albums past expiry still awaiting a warning.

### Story 3 — The unread counter that counted the wrong thing

*Use this when asked about denormalisation, or a bug you found.*

**Situation.** The inbox needs an unread badge. Counting messages per conversation
on every inbox load is a `COUNT(*)` per row, so I denormalised: one
`number_of_unread` integer on the conversation.

**What broke.** A single counter can't express *unread for whom*. Every send
incremented it — so a photographer's own outgoing messages inflated the badge the
photographer saw on their own inbox.

**The fix (migration 017).** Two columns, one per participant. A send increments
only the recipient's side using a `CASE` that compares the sender against each
side of the conversation; mark-read zeroes only the caller's.

**The part I actually learned from.** The migration couldn't split the old counter
— it had never recorded who a message was *for*, so the information simply wasn't
there. I had to **recompute both sides from the `messages` table**. Which is the
rule: you can denormalise a value only if you can still derive it from the source
of truth, because that derivation is your repair tool. The old counter was
underivable, and that's what made the bug unfixable in place rather than merely
wrong.

**One more decision inside it.** Mark-as-read sets the counter to `0` in a single
statement rather than decrementing per message. That's atomic *and* idempotent, so
two concurrent mark-read requests can't corrupt it and neither can a retry. A
`-= 1` has to be exactly right every single time or the badge drifts — and drift
in a counter is invisible until a user complains. I'll take idempotent over
precise.

**Cost, honestly:** the counters can still drift if a future writer forgets to
maintain them, and there's no reconciliation job. The `COUNT(*)` from the
migration's backfill *is* that job; I just haven't scheduled it.

### Story 4 — Portfolio albums were being deleted

*Use this when asked about a modelling mistake, or how you find bugs.*

**Situation.** Albums come in two types: client shoots and the photographer's own
portfolio. `access_expires_at` was `NOT NULL` for both, so every album got
`shoot_date + 3 years`.

**What broke.** Portfolio albums have no client by design — the column is null.
So the expiry pipeline sent three warning emails to nobody, and then permanently
deleted the photographer's portfolio.

**The insight.** This wasn't a bug in the pipeline, it was a modelling error one
level up. Expiry exists because *a client's access to their shoot* is
time-limited. A portfolio belongs to the photographer, has no client, has nothing
to revoke and nobody to warn. It should never have had an expiry date at all.

**The fix (migration 020).** `access_expires_at` becomes nullable, and null means
"never expires." What I like about it is that **neither expiry query changed.**
Both filter on `access_expires_at <= …` / `< NOW()`, and in SQL a comparison
against null yields null, not true — so portfolio albums drop out of both sweeps
on their own.

Then I added a `CHECK` constraint pairing the two columns: a shoot album always
has an expiry, a portfolio album never does. Without it, "portfolio albums don't
expire" is a convention that holds only as long as every future insert remembers
it — and the three-valued-logic exclusion quietly stops protecting anything the
moment one row disagrees.

**Line to land it on:** *"I fixed it by changing the data so the queries didn't
have to change, and then put a constraint in so the data can't change back."*

### Story 5 — The race in the invite

*Use this when asked about concurrency, transactions, or "where did you have to
think hardest?"*

**Situation.** Clients are invite-only. Accepting an invite has to create four
things atomically — the user, the client profile linked to the right
photographer, the conversation, and the invite's own status update.

**The transaction was the easy part.** `BEGIN`, four statements, `COMMIT`, with
`ROLLBACK` in the catch and `release()` in a `finally`. One detail there worth
knowing: releasing a client does *not* roll back, so a bare `return` from inside
the try would hand the next borrower a connection with an open transaction. Every
exit path has to go through the catch — which is why the "template not found"
case inside the analogous forms transaction throws rather than returning null.

**The race.** I was re-reading the invite inside the transaction to re-check
status and expiry — you can't trust that the client ever called `/validate`, or
that the invite was still valid when they did. But with a plain `SELECT`, two
concurrent redemptions of the same token both read `pending` before either wrote
`accepted`, and **both would get an account.** A double-click is enough.

**The fix.** `SELECT … FOR UPDATE`. It holds a row lock for the rest of the
transaction, so the second reader blocks until the first commits and then sees
`accepted`. The detail that makes it work is that the read has to be *inside* the
transaction on the same checked-out client — the existing `getInviteByToken`
helper runs on the pool and could not take that lock, so I couldn't reuse it.

**Why pessimistic rather than optimistic:** two people redeeming the same invite
happens approximately never, so the lock costs nothing and reads more obviously
than a retry loop. If contention were real, I'd flip to a unique constraint on a
redemption record and let the insert fail.

**The related gap I closed separately:** the lock stops one invite being redeemed
twice concurrently. It does nothing to stop a photographer *resending* an
already-accepted invite, which would let the same row mint a second client. That's
a `409` in the resend handler, not a locking problem.


---

## 5. Question bank

Format for each: **the question** · *what they're testing* · your answer · the
follow-up they'll ask next.

Don't memorise the prose. Memorise the **claim → reason → cost** skeleton of each
answer, then say it in your own words.

### Product and scoping

**"Why did you build this?"**
*Testing: whether you can motivate technical work with a purpose.*
> A learning project with a real problem shape — I wanted something with genuine
> data-lifecycle constraints rather than another CRUD app. The whole design was
> written up as an architecture document with numbered decisions before any code
> existed, then built in eight phases, and the doc got revised whenever the
> implementation proved a decision wrong.

*Follow-up:* "Which decision did the implementation prove wrong?" → Story 1 or 4.

**"Who are the users and what do they do?"**
*Testing: whether you understand the product or just the code.*
> Two roles. A photographer creates client galleries and portfolio albums,
> uploads photos in bulk, messages each client, and sends intake questionnaires.
> A client has exactly one photographer, one conversation, and access to their
> shoot galleries for three years. Clients can't self-register — the only path to
> a client account is an invite link from a photographer, which is what
> guarantees every client is always linked to exactly one photographer.

**"What did you deliberately leave out?"**
*Testing: scoping judgment.*
> Photographer discovery and search — that needs a search index, geospatial
> queries and a review entity, and it's a different system. Payments. Client
> self-signup. Real-time messaging. And I left `DELETE /users/:id` unbuilt on
> purpose, because it cascades across nine tables and the right cascade
> behaviour is a data-retention policy question I hadn't answered.

### Architecture and trade-offs

**"Why Postgres and not a document store?"**
*Testing: whether "I used SQL" is a default or a decision.*
> Eleven entities with real referential integrity requirements, and the
> expensive correctness properties are all relational: a four-row atomic
> transaction on invite acceptance, cascade rules that clean up join rows, a
> `RESTRICT` that stops a template being deleted while responses reference it,
> and a `CHECK` constraint pairing two columns. In a document store every one of
> those becomes application code I have to get right on every path. Cost: I gave
> up horizontal write scaling — but the write volume here is a photographer
> uploading a few times a week.

*Follow-up:* "What would push you off Postgres?" → Nothing about this workload.
Write volume would have to grow by orders of magnitude, and even then I'd shard
by `photographer_id` first, which this schema supports cleanly because every
query is already scoped to one photographer.

**"Why not store images in the database?"**
> Databases aren't optimised for binary blobs, and it would put multi-megabyte
> reads through the connection pool and the backup pipeline. The row stores one
> `base_path` key; all three variants are derived from it by convention —
> `{base_path}/original.jpg`, `/standard.jpg`, `/thumbnail.jpg` — so three
> images cost one column. Cost: two systems that can disagree. A `photos` row can
> point at an asset Cloudinary no longer has, and there's no reconciliation sweep.
> That's a real gap.

**"Why a managed image service instead of processing it yourself?"**
> Image processing is CPU-bound and spiky — 500 wedding photos arriving at once
> would saturate a Node process, and Node is single-threaded for CPU work. It also
> comes with a CDN, which is the thing that actually makes this read-heavy system
> fast: the bytes never touch my servers at all. Cost: vendor lock-in and
> usage-based pricing, and at petabyte scale that's a line item worth migrating
> to S3 plus Lambda. The trigger is a spreadsheet, not an opinion.

**"Why did you separate the worker into its own process?"**
> Three reasons. It scales independently — queue depth is a different signal from
> request rate. A crash in photo processing doesn't take down the API. And the
> work is genuinely different: long, retryable, and not attached to a response.
> They still share an EC2 instance at MVP because both are I/O-bound and the
> worker is mostly idle waiting on Cloudinary — but that's a cost decision with a
> clear trigger for reversal, which is worker memory pressure during large batches.

### Data modelling

**"Walk me through your schema."**
> Don't recite tables. Draw the tree: `users` at the root, `photographers` and
> `clients` below it with `user_id` as both PK and FK, then albums/photos joined
> many-to-many, conversations/messages, form templates/responses, and invites.
> Then say the one interesting thing: "the many-to-many on photos is what forces
> the authorisation model — a photo has no owner column, so access is derived
> through every album it currently belongs to."

**"Why is `user_id` the primary key on `photographers`?"**
*Testing: schema-level thinking.*
> It enforces the one-to-one in the schema. You physically cannot create two
> photographer profiles for one user. The alternative — a separate `id` plus a
> `UNIQUE (user_id)` — expresses the same rule with an extra column and one more
> thing to get wrong. The nice consequence is that a photographer's id *is* their
> user id, so every ownership check is a direct comparison against `req.user.id`
> with no lookup in between.

**"You have denormalised fields on `conversations`. Why, and how do you keep them
correct?"**
> Three: the most recent message id, the last message timestamp, and two unread
> counters. They exist so the inbox doesn't need a correlated subquery and a
> `COUNT(*)` per row on every load. They're maintained in exactly one place — the
> send is a transaction that inserts the message and updates the conversation
> together, and mark-read is a single idempotent statement. Cost: they can drift
> if a future writer forgets, and I don't have a reconciliation job. The recompute
> query exists — it's in migration 017's backfill — I just haven't scheduled it.

*Follow-up:* "How would you detect drift?" → Schedule that backfill query as a
periodic audit comparing computed against stored, and alert on mismatch.

**"Why JSONB for form answers rather than a table?"** → Story 1.

**"How do you handle schema changes?"**
> Numbered SQL files, applied in order by a runner that records each filename in a
> `schema_migrations` table and wraps each file in its own transaction — so a
> failure rolls back and stops rather than leaving a half-applied schema. Never
> edit an applied migration; add a new one. Twenty so far, and six of them are the
> design changing its mind, which is the part I'd actually want to talk about.

### Correctness and concurrency

**"Where are the races in this system?"**
*Testing: whether you looked. Most candidates haven't.*

Have four ready, and know that they were closed **four different ways**:

| Race | Closed by |
|---|---|
| Two people redeem the same invite token | `SELECT … FOR UPDATE` — a pessimistic row lock |
| A submit lands between the handler's 409 check and the answer write | `AND submitted_at IS NULL` **in the writing statement** |
| Two concurrent mark-read requests | `SET = 0` — an operation that is idempotent by construction |
| Two clients save different answers at once | A single-statement JSONB merge, so Postgres holds the row lock for the read-modify-write |

> "The one I'd point at is the second. The handler still returns a 409 from its own
> check, but the guard is repeated in the `WHERE` clause of the `UPDATE` — so the
> loser of the race matches no row and gets null back. That closes the
> check-then-write gap rather than narrowing it. The same guard on submit means a
> double-tap preserves the original `submitted_at` instead of letting it creep
> forward."

**"How does the batch upload survive a retry?"**
> BullMQ retries the whole job, not individual photos, so a batch of five where
> the fourth fails re-runs from the first. Two things make that safe: the
> processor skips any photo already at `'ready'`, and the temp file is unlinked
> only after the DB write confirms — deleting first and then failing the write
> would strand the photo at `'processing'` with no bytes for a retry to find.

*Follow-up:* "What if the enqueue itself fails?" → Take it honestly: the rows
commit and *then* the job is added, so if Redis is down in between the photos sit
at `'processing'` forever with no retry. The proper fix is a transactional outbox;
the cheap fix, and the one I'd actually ship first, is a reaper cron that
re-enqueues anything stuck at `'processing'` for over an hour.

**"What happens if the worker dies mid-job?"**
> BullMQ's lock expires and the job is redelivered to another worker, which is
> why the processor has to be idempotent. Partial progress is preserved by the
> `'ready'` skip. For the expiry sweep it's coarser — if any photo in an album
> fails, that album's delete is skipped entirely and it's retried on the next
> daily run, which is the safe direction for an irreversible operation.

### Caching

**"What do you cache and why those TTLs?"**
> Four things: album metadata at 15 minutes, the album photo list at 5,
> photographer profiles at an hour, conversation lists at 2 minutes. The rule is
> that TTL is a function of two things — how often the data changes, and how much
> staleness the user can't detect. A profile is near-static storefront content, so
> an hour. A photo list changes on upload *and* a deleted photo still showing is a
> real bug, so it gets a short TTL *and* event invalidation. Messages and unread
> counts aren't cached at all — zero staleness tolerance.

**"Why cache-aside rather than write-through?"**
> Write-through adds latency to every write for data that's often never read
> again, and write-behind risks losing data, which contradicts the durability
> stance. Cache-aside also degrades gracefully — if Redis is down, everything is
> a miss and the app still works, just slower. That's the property I actually
> wanted.

**"You cache the whole photo list under one key and paginate in application code.
Why not cache per page?"**
*Testing: whether you can defend a non-obvious choice.*
> Because one `del` invalidates every page at once. Per-page keys would mean
> deleting an unbounded set on every photo add — you'd need key scanning or a
> version prefix. At a few hundred photos per album, holding the full list is
> cheap and the invalidation is trivially correct. It's the wrong trade at fifty
> thousand photos, and the fix there is a version-prefixed key where invalidation
> is a version bump rather than a delete.

**"Any surprises in the caching layer?"**
*A great one to volunteer — it's specific and shows you actually ran the code.*
> One that cost me real time. `cache.get<Album>()` does `JSON.parse(raw) as T`,
> and a `Date` round-tripped through JSON comes back as an ISO string. TypeScript
> can't know — the cast is an assertion, not a check — so the type says `Date`
> and the value is a string. Comparisons still work, because ISO-8601 sorts
> lexicographically the same as chronologically, which is exactly why it hides.
> But `.getTime()` and date arithmetic silently misbehave. So there are explicit
> rehydrate functions called on every cache hit. The general lesson is that the
> type system stops being load-bearing at a serialisation boundary.

**"What about cache stampede?"**
> No protection today. When a key expires, concurrent requests all miss and query
> together. At this scale it genuinely doesn't matter — an album has two readers
> in its lifetime. If it did, the options are a short lock key for single-flight,
> or probabilistic early recomputation. I'd want the metric before adding either.

### Auth and security

**"Walk me through authentication."** → Beat 1 of the walkthrough.

**"Why not put the user's role in the JWT?"**
*Testing: whether you understand token trade-offs.*
> It would save a DB read per request, and I still rejected it. The `users` table
> is the source of truth, and the Auth0 webhook already syncs one direction —
> claims would add a second sync running the other way, and that's how identity
> data comes to disagree with itself. A role change also wouldn't take effect
> until the token refreshed, and you can't revoke a claim you've already signed.
> And it moves auth-critical logic into a vendor dashboard that isn't code
> reviewed or version controlled. Cost is the round trip, which is cacheable when
> it matters.

**"How do you stop a caller reading someone else's data?"**
> Two rules. List endpoints are identity-scoped — `GET /conversations` takes no id
> at all, it branches on the caller's role and queries by their own id. Where a URL
> does carry an id, it's checked against the caller: either equality, or a shared
> helper for the two-party case where a client's data is readable by that client
> or by their photographer. A client id in a URL is never trusted on its own.

*Follow-up:* "Give me a case that isn't a simple equality check." → Photos.
`getAlbumOwnersForPhoto` joins through the album join table and returns every
owner pair, because a photo can be in multiple albums. That same query also guards
adding an existing photo to another album — without it, any photographer could
pull another photographer's client photos into their own album by guessing a
UUID.

**"How is the webhook secured?"**
> HMAC-SHA256 over the raw request bytes, compared with `timingSafeEqual`. The raw
> bytes matter — a parsed and re-serialised body won't byte-for-byte match what
> the sender signed, so the JSON parser has a `verify` hook that stashes the
> original buffer. And `timingSafeEqual` throws on a length mismatch rather than
> returning false, so there's an explicit length guard first.

*Follow-up:* "What about replay?" → Take it. No timestamp, no nonce, no
idempotency key. A captured request replays forever, and a legitimate Auth0 retry
hits a unique constraint and surfaces as a 500 — which makes Auth0 retry again.
The fix is `ON CONFLICT DO NOTHING … RETURNING` so a retry returns 200 with the
existing user, plus a signed timestamp with a short window.

**"404 or 403 for a resource you don't own?"**
*Testing: whether you have a rule or a habit.*
> The rule I'd defend is: if knowing the resource exists is itself information the
> caller shouldn't have, return 404; otherwise 404 then 403. A private
> photographer profile returns 404 so existence stays hidden. Client-scoped
> endpoints return 403 for both missing and not-yours, so a photographer probing
> UUIDs learns nothing. Albums and templates return 404-then-403, which is
> friendlier for legitimate callers.
>
> Honestly, the codebase is consistent per resource and not fully consistent
> across resources — assigning a form to a client splits 404 and 403 in a way that
> confirms a UUID belongs to somebody's client. By my own rule that one's wrong.

### API design

**"Why 202 on the batch upload but 200 on the profile photo?"**
> Different shapes of work. The batch is hundreds of files and real derivative
> processing, so holding the request open isn't viable and the response is a
> receipt: rows at `status: 'processing'`. A profile photo is one small image with
> no derivative work, and the photographer is looking at it — a 202 there means
> showing the old avatar for an indeterminate time, which is worse for no benefit.
> The rule I'd state is: async when the work is unbounded or derivative, sync when
> the user is staring at the result.

*Follow-up:* "Anything clever in the profile upload?" → The Cloudinary public id
is deterministic (`photographers/{id}/profile`) with `overwrite`, so replacing an
avatar overwrites the same asset instead of orphaning the old one — no column
tracking the previous id, no cleanup job, and the write is idempotent on retry.
Plus `invalidate` to purge the CDN copy, since the URL is unchanged but the bytes
aren't.

**"Why PUT for editing a template, not PATCH?"**
> The body is the complete new state, not a diff. A template and its questions are
> created together and edited by replacing the whole set — there's no endpoint for
> a single question. That one product decision removes a whole class of bug:
> question order is just the array index, so nothing computes `MAX(order) + 1`,
> so the read-then-write race that plagues incremental ordering never exists. And
> then a `UNIQUE (template_id, order)` constraint *enforces* density instead of
> fighting it.

**"How does pagination work?"**
> Offset-based: `?page=&limit=`, with the limit capped so a caller can't request
> an unbounded page, and invalid params falling back to defaults rather than
> erroring. It's the wrong choice for messages and I know why — deep offsets make
> Postgres scan and discard, and the page shifts under the reader when a message
> arrives mid-scroll. Keyset pagination on `(sent_at, id)` is the fix, and the
> composite index that supports it already exists.

**"How do errors work?"**
> One `AppError` class carrying a status, and a single error-handling middleware
> mounted after all routes. Handlers call `next(new AppError(msg, status))`. The
> handler only forwards the message for errors I created — anything else gets a
> generic message, so a `pg` error can't leak column names or a connection string
> to a client. It also checks `headersSent` first, because Express can't send a
> second response.

### Testing and quality

**"How did you test this?"**
> 457 test cases across 28 files, unit-level with mocked query modules — every
> route handler is an exported function, so tests call it directly with fake
> `req`/`res`/`next` and no HTTP layer. The parts I cared most about testing were
> the ordering guarantees: that a failed email send skips the warned mark, that an
> album with no client is marked anyway, that an already-ready photo is skipped on
> retry, and that a submitted form rejects an answer write.

*Follow-up:* "What's missing?" → Integration tests against a real Postgres. Every
SQL string is currently only exercised through a mock, so a typo in a column name
or a broken `CHECK` interaction wouldn't be caught. That's the first thing I'd add,
with Testcontainers or a disposable database per run.

**"How did you test the email path if there's no provider?"**
> The sender is a port — an interface with one `send` method — and the default
> adapter prints to the console, which is why the pipeline runs locally with no
> credentials at all. The console adapter never throws, so the "send failed,
> don't mark warned" branch is unreachable in local use; that path is covered by
> tests against a stub sender that throws on demand.

### Retrospective and judgment

**"What would you do differently?"**
*Have three ranked, most important first.*
> One: signed direct-to-Cloudinary uploads from the browser instead of staging
> files on the API server's disk. That's not a nice-to-have — it's the thing that
> breaks the moment there's a second instance.
>
> Two: keyset pagination from the start on anything ordered by time.
>
> Three: I'd have reached for the snapshot model on forms immediately instead of
> normalising first — though I'm not sure I'd have understood *why* it was right
> without hitting the edit lock myself.

**"What are you most proud of?"**
> The expiry pipeline, because the interesting part isn't the cron. It's noticing
> that "we warn them three times" was doing no actual work — nothing connected the
> warnings to the deletion — and then making the final warning a precondition. And
> then noticing that the gate I'd just added would preserve orphaned albums
> forever, so it needed an escape hatch.

**"What was hardest?"** → Story 1, or the concurrency table.

**"If you had two more weeks?"**
> Direct uploads, a reaper for stuck photos, pagination on the remaining list
> endpoints, integration tests against a real database, and structured logging with
> one alert that matters: albums past expiry still waiting on a warning. In that
> order.


---

## 6. Traps, and how to take them

These are the questions designed to see how you behave under pressure rather than
what you know. In every case the winning move is the same: **accept the premise if
it's true, and answer with a decision rather than a defence.**

### "Isn't this over-engineered for the scale you have?"

Don't get defensive, and don't over-agree either.

> Some of it is, and deliberately — it's a learning project, so I built the queue
> and the cache to understand them, not because 11 QPS demands them. But the two
> things people usually call over-engineering here aren't: the transactions and
> the constraints. Those aren't about scale, they're about correctness at any
> scale. The four-row invite transaction is just as necessary with ten users.
>
> The thing that *is* genuinely over-built for today is running a separate worker
> process for a workload that's mostly idle — and that one I'd defend on a
> different axis, which is that a photo upload failing shouldn't be able to take
> down the API.

### "Couldn't you have done this with a framework that generates all of it?"

> Probably most of it. What a generator wouldn't have given me is the part that
> matters here: the deletion gate, the snapshot model, the ordering guarantees in
> the expiry processor. Those come from the domain, not from CRUD. The generated
> parts are the parts I'd have been happy to skip.

### "How much of this did AI write?"

A real question for any recent project, and the wrong answers are "none" and
"all." Answer with **your process**, and then prove it by going deep on demand.

> I used Claude Code throughout, with a rule I set at the start and wrote into the
> project doc: I write the route signature and the logic myself, run it, break it,
> fix it — and only then ask for a review. It's good at boilerplate, migrations
> and debugging; I don't hand it the decisions. The test is whether I can explain
> why every line is there, and the honest answer is that the reviews taught me
> things — `SELECT … FOR UPDATE` came out of a review conversation about the
> invite flow, and I understood it before I used it.
>
> Pick any file and I'll walk you through why it's written that way.

That last sentence is the whole answer. Make sure it's true — the fastest way to
make it true is [§9](#9-dry-run-protocol).

### "This is just CRUD, isn't it?"

> Most of it is, and that's fine — most backends are. The parts that aren't are
> where the time went: an irreversible deletion pipeline that has to be safe
> against a mail outage, an authorisation model where the resource has no owner
> column, and a form model that has to let a template change without changing what
> a client was already asked. Those aren't CRUD problems, and they're the reason I
> picked this domain.

### "What's the biggest weakness?"

Never say "nothing" and never say "the tests." Have the real one ready, and lead
with it before they find it. See [§7](#7-weaknesses-to-volunteer).

### "Walk me through the code."

They're testing whether you know it or wrote it once. Don't tour files. Pick **one
path** and follow it all the way down — the batch upload and the expiry sweep are
the two best, because both cross the API/worker boundary and both have ordering
decisions to point at.

### Silence after your answer

Common technique. It is not an invitation to keep talking. It usually means
they're writing. **Stop, and ask a question of your own:** "Do you want me to go
deeper on the retry semantics, or move on?" That reads as senior; filling the
silence reads as nervous.

### "Why didn't you use [technology]?"

The format that always works: *what it's good at* → *what this system needed* →
*what would change my mind.*

| If they name | Say |
|---|---|
| GraphQL | Access patterns are stable and there's one client; REST gives native file upload and HTTP caching. GraphQL wins with multiple clients needing different shapes — not the case yet. |
| Kafka | BullMQ messages are consumed and deleted; that's what I need. Kafka retains an immutable log that multiple consumers replay independently — the right tool the moment I add analytics, which is exactly where I've reserved it. |
| An ORM | I wanted the SQL visible, because the interesting parts of this system *are* SQL: a `FOR UPDATE` lock, a JSONB merge, an `INSERT … SELECT` snapshot, three-valued logic doing my filtering. An ORM would hide all four. Cost: I hand-maintain row mappers. |
| DynamoDB | Contradicts the durability-first stance and the relational integrity requirements. Every foreign key and cascade becomes application code. |
| Serverless | The worker is long-running and the connection pool matters. Lambda plus RDS Proxy is viable but it's a bigger change than it looks. |
| WebSockets | Genuinely the right call if messaging is meant to feel real-time — and it changes the caching design, because a 2-minute conversation-list cache is incompatible with it. |
| Redis Streams / pg-boss | Both reasonable. BullMQ won on Node-native scheduling, retries and a dashboard. |

---

## 7. Weaknesses to volunteer

**Lead with these.** An interviewer who finds a flaw you didn't mention learns
something about your self-awareness. An interviewer you hand it to learns
something about your judgment. Same flaw, opposite outcome.

Rank them and offer the top one unprompted, usually right after the walkthrough.

### 1. Upload staging is on local disk — this breaks horizontal scaling

> The one I'd fix first. The batch upload writes files to the API server's temp
> directory and the worker reads them back by path. That works because the worker
> shares the instance — and it silently breaks the moment there are two API
> instances, which is exactly what the load balancer exists to enable. The failure
> is quiet: photos sit at `'processing'` forever and the job just fails three
> times. It also can't survive an instance being replaced during a rolling deploy,
> which is the very thing the load balancer was justified by.
>
> The right fix isn't shared storage, it's removing the app tier from the byte
> path entirely: issue a signed direct upload to Cloudinary from the browser, so
> the API only creates rows and enqueues. That also removes the 2 GB request and
> the memory spike.

### 2. The enqueue isn't transactional with the insert

> The rows commit and then the job is added. If Redis is unavailable in between,
> the photos are stuck at `'processing'` with no job and nothing to reconcile
> them. The textbook fix is a transactional outbox; the cheap fix I'd actually
> ship first is a reaper cron that re-enqueues anything stuck for over an hour,
> because it catches every cause rather than just this one.

### 3. The expiry sweep is an N+1 with no bound

> For each expired album it fetches the photos, and then for each photo it runs a
> query to check whether this was the photo's last album. A 400-photo album is
> ~401 queries, there's no `LIMIT` on the album selection, and there's no
> checkpoint — if it times out it starts over. Batching the ownership check into
> one `= ANY($1)` query and chunking the albums fixes it.

### 4. Several list endpoints aren't paginated

> A photographer's clients, albums, invites and templates all return everything,
> and the conversation list is both unpaginated and cached. That's the most likely
> thing to fall over in real use, and it's the smallest fix on this list.

### 5. Offset pagination where keyset belongs

> Messages are ordered by time and paginated by offset, so the page shifts under
> the reader when a message arrives mid-scroll. The composite index for keyset
> already exists; I just didn't use it that way.

### 6. Access doesn't actually end when it's supposed to

> The product says client access expires after three years. What the system does
> is delete the album after the final warning, whenever the sweep next runs — and
> in between, an expired album is still fully readable, because no read path
> filters on the expiry date. "Access expires" and "data is eventually deleted"
> are different promises and I've only implemented the second. The fix has to
> cover both the single-album read and the client's album list together, or
> you get an album that's visible directly and invisible in its own list.

### 7. No observability

> The worker leaves `console.error` behind and nothing else. Given that the
> deletion gate can defer deletions indefinitely, the one alert this system
> actually needs is "albums past expiry still waiting on a warning" — and there's
> nowhere for it to fire.

**Two more to have in your pocket** if they want to keep digging: no
reconciliation between Cloudinary and Postgres in either direction, and
`messages.read_at` is a dead column — per-message read state was replaced by
per-conversation counters and nothing writes it any more.

---

## 8. Numbers to have memorised

Specificity is the cheapest credibility there is. Being able to say "25 MB per
file, capped at 25 questions, three retries with exponential backoff from two
seconds" makes everything else you say more believable.

### Shape of the project

| | |
|---|---|
| REST endpoints | 40 live (+1 planned: `DELETE /users/:id`) |
| Database entities | 11 |
| Migrations | 20 |
| Numbered architecture decisions | 26 |
| Test cases / files | 457 / 28 |
| Lines of TypeScript | ~13,900 |

### Policy and limits

| | |
|---|---|
| Photo retention | `shoot_date + 3 years`, shoot albums only; portfolio never expires |
| Warning schedule | 90 / 30 / 7 days before expiry |
| Cron time | `0 8 * * *` — 08:00 UTC, all four expiry jobs |
| Invite validity | 30 days, resettable by resend |
| Invite token | `crypto.randomBytes(32).toString('hex')` — 64 hex chars |
| Max upload | 25 MB per file (album batch), 5 MB (profile photo, image MIME only) |
| Max questions per template | 25, rejected at validation before any transaction opens |
| Max message / answer length | 5,000 characters each |
| Page sizes | photos 20 default / 100 max; messages 50 default / 100 max |

### Infrastructure settings

| | |
|---|---|
| Postgres pool | `max: 10`, 30 s idle timeout, 2 s connection timeout |
| Job retries | 3 attempts, exponential backoff — photos from 2 s, expiry from 5 s |
| Job retention | completed removed after 24 h; last 100 failures kept |
| Cache TTLs | album meta 900 s · photo list 300 s · profile 3600 s · conversations 120 s |
| Never cached | messages, unread counts, form responses |
| JWT | RS256, verified against Auth0 JWKS with caching and rate limiting |

### The estimation, if design comes up

> 100k photographers × 30 shoots/yr × 400 photos ≈ **1.2 B photos/year**.
> At ~6 MB across three variants that's **~7 PB/year**, so a 3-year TTL means
> **~21 PB steady state** — on the order of **$480k/month** in storage, and the
> *bounded* version of the number. Meanwhile the JSON API is around **11 QPS**
> steady state, because the bytes go to a CDN and never touch it.
>
> That contrast is the whole architecture in two numbers: **it's a storage
> problem wearing a web app's clothes.**

---

## 9. Dry-run protocol

Preparation that actually works, in order.

### Once, before anything else

1. **Read your own migrations end to end.** All twenty, in order. This is the
   fastest way to reload the whole design, because each one is a decision with a
   comment explaining itself.
2. **Re-read the five stories in [§4](#4-the-five-stories)** and then close the
   document and tell each one out loud. If a story takes more than 90 seconds
   you're including detail that isn't load-bearing.
3. **Pick three random files and explain every non-obvious line.** If you can't,
   that's the study list. Good candidates: `queries/responses.ts`,
   `processors/expiryProcessor.ts`, `queries/albums.ts`.

### The drill, repeatable

Set a timer and do this cold:

| Minutes | Do |
|---|---|
| 0:00–1:30 | The pitch, out loud, no notes |
| 1:30–6:30 | The five-beat walkthrough |
| 6:30–7:30 | Draw the request path and the expiry state machine from memory |
| 7:30–12:00 | Answer three random questions from [§5](#5-question-bank) — pick them blind |
| 12:00–14:00 | Volunteer your top weakness and say how you'd fix it |
| 14:00–15:00 | Answer "what would you do differently", ranked, three items |

### Self-grading

After each run, score honestly:

- [ ] Did every answer name a **cost**, not just a benefit?
- [ ] Did I say "I don't know" at least once instead of improvising? (You should
      — improvising is the failure mode interviewers detect most reliably.)
- [ ] Did I stop talking and let them ask, or did I fill the silence?
- [ ] Did I volunteer a weakness before being asked?
- [ ] Could I point at a **line of code** for every claim I made?
- [ ] Did I use a real number at least three times?

### The three sentences to have absolutely fluent

If you remember nothing else under pressure, these three carry a surprising
amount of the interview:

1. *"The send happens before the mark, because marking first would be at-most-once
   delivery, and the thing on the other side of it is an irreversible deletion."*
2. *"Normalise the things you'll edit; snapshot the things you have to be able to
   reproduce."*
3. *"The guard is in the `WHERE` clause of the write, not just in the handler —
   so the race is closed rather than narrowed."*

Each of those is a general principle attached to a specific line of your code,
which is exactly the pairing a deep dive is testing for.

---

*Companion: [SYSTEM_DESIGN_STUDY.md](SYSTEM_DESIGN_STUDY.md) — the same system as
a design problem. Decision log: [photography_app_architecture.md](photography_app_architecture.md).
Build order: [ASSIGNMENTS.md](ASSIGNMENTS.md).*

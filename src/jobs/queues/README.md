# `src/jobs/queues/`

This folder defines the two BullMQ queues. Queue definitions live here. The logic that runs when a job is processed lives in `src/jobs/processors/` — which you write.

---

## What is BullMQ?

BullMQ is a **job queue backed by Redis**. When your API needs to do work that shouldn't block the HTTP response — like processing 500 uploaded photos — it adds a job to a queue and immediately returns `202 Accepted` to the client. A separate worker process picks jobs off the queue and runs them.

The key property: **jobs survive crashes**. They are serialised and stored in Redis. If the worker process dies mid-job, the job is retried when it restarts.

---

## Three concepts to keep separate

```
Route handler          Worker process
─────────────          ──────────────
Queue.add(job)  →  →  Worker listens on queue
                            ↓
                       Processor function runs
```

| Concept | What it is | Where it lives |
|---|---|---|
| **Queue** | A named channel jobs are added to | `src/jobs/queues/` (here) |
| **Worker** | A process that subscribes to a queue and picks up jobs | `src/jobs/worker.ts` (you write this) |
| **Processor** | The function the Worker calls for each job | `src/jobs/processors/` (you write these) |

These are intentionally separate. A Queue object is used in route handlers to enqueue jobs. The Worker and Processor are in a separate process that actually runs them.

---

## Why a separate process?

Photo processing involves downloading originals, generating variants, and uploading to Cloudinary. That is CPU and network-intensive work that takes seconds per photo.

If you ran this in the same Node.js event loop as your Express server, it would **block request handling** while photos process. Other users' requests would pile up waiting.

A separate process isolates the blast radius. The API stays responsive; the worker churns through the queue independently.

---

## The two queues in this project

### `photoQueue`
- **Type:** Triggered (fired by a route handler)
- **When:** A photographer uploads a batch of photos via `POST /albums/:id/photos/batch`
- **Job data:** The list of photo IDs and Cloudinary paths to process
- **What the processor does:** You implement this in `src/jobs/processors/` — it should update each photo's status from `processing` to `ready` once Cloudinary confirms

### `expiryQueue`
- **Type:** Scheduled (cron jobs)
- **When:** Three scheduled jobs run daily — checking for albums at 90/30/7 days before expiry
- **Job data:** A date range — which albums' `access_expires_at` falls within the warning window
- **What the processor does:** You implement this in `src/jobs/processors/` — send warning emails, update `warned_*_at` columns, and delete expired albums

---

## How to add a new job type

1. Define a job name constant in the relevant queue file
2. Enqueue it from your route handler: `photoQueue.add('job-name', { ...data })`
3. Write a case for it in the processor in `src/jobs/processors/`
4. Register the processor in `src/jobs/worker.ts`

---

## `maxRetriesPerRequest: null`

You will see this in `src/config/redis.ts`. BullMQ requires this ioredis option — it prevents ioredis from throwing on blocked Redis commands that BullMQ uses internally. Do not remove it.

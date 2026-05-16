# Move schema profiling into the BullMQ queue (deploy-safe)

**Status:** Open, not yet scheduled.
**Severity:** High operationally — every backend deploy kills any in-flight
profile. Low blast radius (data isn't lost; user just has to re-trigger),
but it's a real footgun during active development.
**First reported:** 2026-05-16, when commit `00b323e` triggered a Container
Apps revision swap and SIGTERM'd a 10-minute profile that was running for
connection 15 (EpicData BV — 35 tables / 1,467 columns). Profile died at
"Step 6/7 — batch 9 of 25". `profiling_status` got stuck at `'running'`
forever because no process was alive to flip it to `'done'` or `'error'`;
the UI showed "Profiling failed — Connection to server lost" and the
catalog stayed empty.

## Problem

`POST /api/connections/:id/profile` runs the entire schema profiler inline
in the Express request handler. It's an async function that streams SSE
events as it goes:

1. Read parquet headers
2. Quality profile every entity (null %, distinct counts, top values)
3. **AI Pass A** — Haiku call to detect naming conventions
4. **AI Pass B** — Sonnet call across all tables for descriptions + relationships
5. Verify AI-suggested relationships via value-overlap JOINs
6. **AI Pass C** — per-batch column descriptions (Sonnet) — this is the
   long phase. On a 1,400-column EO sync it's ~10 minutes of 25 batches.
7. Persist to Postgres + Neo4j

A single profile holds the HTTP connection open the entire time. Any event
that terminates the Node.js process — Container Apps revision swap, scale-to-
zero, OOM, manual restart — kills the profile mid-flight:

* The connection row's `profiling_status` is stuck at `'running'`.
* `last_profiled_at` is never set.
* The user sees the failure-style "Connection to server lost" banner.
* The catalog never populates.
* They have to click Re-analyse to retry from scratch (no resume).

This is identical to the pre-Day-5 weakness in source sync, which we
already fixed by moving sync into an isolated worker process / Container
Apps Job. Profiling is the last long-running operation still pinned to
the API container's lifecycle.

## Why it bites in development

Active development = frequent backend deploys = frequent revision swaps.
Any deploy during a profile = dead profile. The user's flow looks like:

1. Trigger sync → succeeds (sync runs in the worker, deploy-safe ✅).
2. Sync auto-triggers profile → starts running in backend API ❌.
3. Push a fix → CI deploys → new revision → old container terminates →
   profile dies at batch N/25.
4. Profile status stuck at `'running'`. User stuck.

The trap is that the failure mode looks identical to a network glitch
("Connection to server lost"), so it's not obvious the cause is the deploy.

## Why it'll bite in production

Less often, but still real. Container Apps:

* Restarts containers on rare platform issues (~once a month).
* Restarts on resource pressure / OOM.
* Restarts on health probe failure.
* Scale-to-zero. The backend probably stays warm under load but if a
  customer triggers a re-profile during an idle window, the platform's
  scale-down can kick in mid-profile.

Production isn't as deploy-heavy as dev but it's not zero. Every restart
during the ~10 minute window of an active profile = a stuck connection.

## Fix design

Move profiling into the existing BullMQ-based queue infrastructure. The
sync platform already has all the pieces:

* `backend/src/jobs/queues.ts` — BullMQ queue definitions
* `backend/src/jobs/workers.ts` — long-running worker process
* `backend/src/orchestrator/SyncOrchestrator.ts` — orchestration + status
  tracking via DB rows
* Heartbeat blob pattern for live progress in Azure mode

The profiling refactor mirrors what sync did:

1. **New queue:** `schema-profiling` (or reuse a generic `long-jobs` queue).
2. **New job type:** `{ connectionId, tenantId, triggeredBy }`.
3. **`POST /api/connections/:id/profile` becomes a thin endpoint:** insert
   a job, return immediately with the job id. SSE moves to a separate
   `GET /api/connections/:id/profile/stream` that subscribes to the
   heartbeat channel for that job (mirrors what sync did).
4. **Worker runs the actual profiler.** Status updates go to the
   connection row's `profiling_*` columns AND a per-job progress row.
5. **Cancellation:** worker checks a cancellation token between phases.
6. **Resumption (later, optional):** checkpoint after each phase so a
   killed worker can pick up where it left off. Not required for v1.
7. **Stuck-job janitor:** scheduled task that flips
   `profiling_status='running' AND profiling_started_at < now() - 30min`
   to `'error'` with a clear message. Belt + braces in case a worker
   dies without releasing the lock.

## Scope estimate

About a day of focused work. The patterns are all in place from the sync
refactor — most of the labor is in:

* Adding the queue + worker dispatch.
* Moving SSE into a polling / heartbeat-based stream that doesn't
  require an HTTP connection to stay open for 10 minutes.
* Frontend changes to attach to the heartbeat instead of a single SSE
  fetch.
* Janitor cron task.

## Until then — operational workarounds

* **Don't push backend code while a profile is running.** Watch
  `connections.profiling_status` and queue deploys for between profiles.
* **The frontend should auto-poll on SSE drops instead of giving up.**
  Half-applied in the working tree as of the same incident — a
  `pollingFallback` state on `ProfilingBanner` that switches the
  banner to polling mode if the SSE stream ends without a terminal
  event. Worth finishing as a separate small change since it improves
  the UX even after the queue refactor lands.
* **When a profile gets stuck**, the recovery is either: re-trigger
  `POST /:id/profile` (which overwrites the row and starts fresh), or
  manually `UPDATE connections SET profiling_status='error' WHERE id=…`
  so the UI unsticks.

## Related work

* The sync refactor (Day 5 / Day 6, commits `e0a2d34`, …) established
  the worker pattern.
* The credential-staging blob refactor (commit `eaad8bb`) shows the
  pattern for moving long-lived state out of the API container.
* The schema-changes notification system already exists for `last_profiled_at`
  transitions — that hook keeps working unchanged once profiling moves to
  the worker.

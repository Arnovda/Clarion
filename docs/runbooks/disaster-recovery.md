# Runbook: disaster recovery — the RTO/RPO Clarion actually offers (P1-4)

> **This document is the written recovery promise.** Every number in it is
> derived from configuration that exists in `infra/` — when you change a
> retention, a policy or a flag there, change the number here in the same PR.
> The reverse also holds: a number here that the config does not deliver is a
> lie to a customer.
>
> **Status of the controls (2026-09-02):** the HCL for all of this is written
> (`infra/main.tf`, `infra/variables.tf`), but **no workflow runs terraform**
> — state lives on the machine that last applied (see
> `docs/runbooks/jobs-worker-apply.md`, which leads with the state-file
> check). The Neo4j backup, the share soft-delete and the vault therefore do
> not exist in Azure until the owner runs `terraform plan`/`apply` from
> `infra/`. **No restore has been rehearsed yet** — the checklist at the
> bottom is owed before any of these numbers is quoted to a customer.

---

## 1. The offer, per store

| Store | What it holds | RPO (max data loss) | RTO (time to serving again) | Mechanism |
|---|---|---|---|---|
| **PostgreSQL** (flexible server) | The product's truth: tenants, users, connections (encrypted credentials), catalog mirror, dashboards, audit, schedules | **≤ ~15 min** (PITR within region, 14-day window); **≤ ~1 h** for a whole-region loss (geo-restore to the paired region) | **~1–4 h** — restore creates a NEW server; then repoint + re-migrate role grants (§2) | 14-day PITR + `geo_redundant_backup_enabled = true` (`infra/main.tf`, the server resource) |
| **PostgreSQL with HA flag on** (`pg_high_availability = true`, requires GP SKU) | same | **0** (synchronous standby) for zone failure; PITR still covers corruption/deletion | **60–120 s** automatic failover for zone failure | Zone-redundant HA block — see §5 before flipping |
| **Neo4j** (semantic graph, 5 GiB Azure Files share) | Semantic definitions, relationships, product graph — largely a mirror of Postgres, plus human edits on un-mirrored paths | **≤ 24 h** (daily 02:30 UTC snapshot). Residual: most of the graph is rebuildable from Postgres (§3), so the true 24 h exposure is un-mirrored human edits (revert/approve/import) | **~1–2 h** manual: restore share → wake container → verify (§3) | Azure Backup daily share snapshots, retention `neo4j_backup_retention_days` (default 30) + 30-day share soft-delete + vault soft-delete |
| **Redis** (queues, rate-limit windows, caches) | Nothing that is a source of truth | **Everything in flight** — deliberately (§4). Delayed one-shot jobs and in-flight queue entries are lost; repeatables re-register themselves; schedules live in Postgres | **~1 min** — a fresh empty Redis is a correct Redis here | Ephemeral by decision; optional AOF behind `redis_persistence_enabled` (default off) |
| **Blob warehouse** (parquet/Delta product + source data) | Materialised copies of customer source data | Deleted blob: **0** within 30 days (soft delete + versioning). Region loss: GRS (async, minutes-behind). Anything beyond that: re-sync from the customer's source rebuilds it | **Hours** for a full re-sync of a large tenant; minutes for an undelete | GRS + 30-day blob & container soft-delete + versioning; ultimate fallback = the connector re-sync |
| **Container Apps / images / config** | No state | n/a | **~30–60 min** — `terraform apply` + the deploy workflow re-creates everything from the repo | Everything is in git (`infra/`, `.github/workflows`, `.ops/`) |

**The one-sentence version for a customer:** your data's system of record
(Postgres) is recoverable to within ~15 minutes at any point in the last 14
days, survives the loss of an entire Azure region, and the semantic layer on
top of it is recoverable to within 24 hours — with automatic zero-loss
failover for Postgres available as a paid tier.

---

## 2. Restore: PostgreSQL

Point-in-time restore creates a **new** server — it never touches the
existing one, which is what makes rehearsing it safe.

1. Portal → the flexible server → **Restore** (or `az postgres flexible-server
   restore --source-server … --restore-time …`). Pick the point in time; for
   a region loss use **geo-restore** to the paired region instead.
2. The new server has the same admin login/password but **none of the
   firewall rules** — re-add `AllowAzureServices` (0.0.0.0) and any
   `local_ips`.
3. **Role check — this is the step a naive restore misses:** the app connects
   as `databridge_app` (NOBYPASSRLS). Roles are cluster-level and ARE included
   in a flexible-server restore, but verify before repointing:
   `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'databridge%';`
   and run `backend/scripts/preflight-role-flip.ts` against the new server —
   it asserts policy identity, not just presence (the P0-1 lesson: a
   preflight that counts policies cannot notice the wrong one).
4. Repoint: update the single `database-url` secret on the backend +
   jobs-worker Container Apps (`az containerapp secret set`), then restart
   revisions. **Its live production value is not what Terraform wrote** — the
   `.ops/db-role` control spliced in the `databridge_app` credentials, so the
   restored value must carry `databridge_app@<new-fqdn>`, not the admin login.
   Update the GitHub secrets the workflows read AND `prod.tfvars` too, or the
   next workflow run / apply repoints back at the dead server.
5. Verify: `/api/health` deep check green, a real login, one tenant's
   dashboard renders.

---

## 3. Restore: Neo4j

Two independent paths — use whichever is faster for the failure at hand.

**Path A — snapshot restore (covers corruption, bad writes, deletion):**

1. Stop writes: scale the neo4j app to 0
   (`az containerapp update -n databridge-prod-neo4j -g databridge-rg --min-replicas 0 --max-replicas 0`)
   — restoring under a running JVM corrupts the store you just restored.
2. Portal → Recovery Services vault → Backup items → Azure Storage (Azure
   Files) → `neo4j-data` → **Restore Share** (full-share, "overwrite in
   place" is fine — the snapshot lives in the same account, so this is a
   server-side copy).
3. Scale the app back to 0/1 (its normal scale-to-zero shape). First bolt
   connection wakes it; Neo4j replays its transaction log on boot exactly as
   after a power cut — **a slow first start with recovery log lines is
   expected, not a failure.**
4. Verify: the catalog renders for a real tenant, and `.ops/graph-backfill`
   (report mode) comes back clean — an EMPTY catalog for a real tenant means
   a stamp/restore mismatch.

**Path B — rebuild from Postgres (covers a lost/unrestorable share):**

The graph is deliberately a mirror plus enrichment, so most of it can be
reconstructed: `backend/src/db/migrateSemanticToNeo4j.ts` (source layer),
`dist/syncAllProducts.js` (product layer — runs inside the environment, the
`.ops/graph-backfill` job pattern), then a re-Analyse per connection fills
AI-derived context. **What this path loses:** edits made through the
un-mirrored write paths (`/semantic/revert`, `/semantic/approve`,
`/semantic/import` — the list CLAUDE.md's dual-write contract keeps) since
they exist only in the graph. Prefer Path A whenever a snapshot exists.

---

## 4. Redis: why the RPO is "everything in flight", on purpose

A Redis restart today loses: queued/delayed BullMQ jobs, rate-limit windows,
cancellation keys, pub/sub in flight. Every one of these is either
reconstructible or visibly re-triggerable:

- **Repeatable jobs** (schedules, reapers' cadence) — `jobs/scheduleReconciler.ts`
  re-registers them on every Redis reconnect; the source of truth is Postgres.
- **Interrupted runs** — startup crash-recovery closes them, and the
  liveness reapers (P1-1) fail anything whose heartbeat goes quiet within
  ~10 minutes, so nothing hangs forever.
- **Delayed one-shots** (a fairness-deferred build, an already-enqueued
  email) — genuinely lost, but the failure is visible (the run row goes
  stale → reaped → surfaced) and the action is re-triggerable by its owner.
- **Rate-limit windows** — reset; a brute-force window restarting is the only
  security-relevant loss and it is bounded to one 15-minute window.

Flipping `redis_persistence_enabled = true` narrows the delayed-job window at
the cost of AOF fsync over SMB on every queue op and a new failure mode (a
corrupt AOF refusing to load). **If you flip it, rehearse immediately:**
enqueue a delayed job, restart the redis revision, watch the job survive and
fire. Until that has been seen once, the flag has made nothing safer.

---

## 5. Postgres HA: what the flag costs and buys

`pg_high_availability = true` requires **both** edits in `prod.tfvars`:
`pg_sku` to a General Purpose SKU (`GP_Standard_D2ds_v4` at minimum — Azure
does not support HA on the Burstable tier the platform runs today) and the
flag. Cost moves from ~25 to ~260 EUR/month (GP compute, twice). It buys
RPO 0 / RTO 60–120 s **for infrastructure failure only** — a bad `DELETE`
replicates synchronously to the standby, so PITR (§2) remains the answer to
corruption either way. Recommendation on record: not before a paying
customer's contract asks for it; the PITR story above is honest and strong.

---

## 6. Rehearsal checklist (owner act — none of this has been done yet)

A backup that has never been restored is a hope, not a control. In order:

- [ ] `terraform plan` from `infra/` (state is on the machine that last
      applied — check first, per `docs/runbooks/jobs-worker-apply.md`), then
      apply. Confirm in the portal: vault exists, `neo4j-data` shows as a
      protected item, first backup job succeeded.
- [ ] Trigger an on-demand backup of `neo4j-data` (portal → Backup item →
      Backup now) so there is a restore point to rehearse with.
- [ ] **Rehearse Neo4j restore** (§3 Path A) — off-hours; total downtime is
      the restore copy + one cold start. Record the wall-clock time next to
      the RTO above.
- [ ] **Rehearse Postgres PITR** — restore to a NEW server (never touch
      prod), run the §2 role check against it, connect a scratch backend,
      log in. Delete the rehearsal server after. Record the wall-clock time.
- [ ] Delete a scratch blob and undelete it via soft delete (2 minutes —
      proves the retention policy is live, not just written).
- [ ] Put the measured times into §1 and quote nothing to a customer before
      the boxes above are ticked.

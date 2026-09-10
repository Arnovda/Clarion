# Incremental sync — design and contract

Spec for how Clarion's source-ingestion layer keeps source data in sync
with the upstream system **without re-pulling everything every time**.
Built first for ExactOnline; the framework is source-agnostic so the
same contract applies to every future connector.

## Why it matters

A full re-sync of a 10-year-old active ExactOnline division can run
tens of millions of rows on `TransactionLines` alone. That's hours of
sync time and hundreds of MB of network for data that mostly hasn't
changed since yesterday. Incremental sync turns that into "pull the
~10k rows modified since last night" — minutes, not hours.

It also unblocks frequent refresh — once a sync is bounded by *deltas*
rather than total history, you can run it hourly without burning
through API quotas.

## The three layers

```
┌────────────────────────────────────────────────────────────┐
│  Orchestrator (platform-owned, source-agnostic)            │
│  • Loads cursors from entity_sync_cursors                   │
│  • Hands them to connector via SyncOptions.cursors          │
│  • Persists new cursors AFTER per-entity success            │
└────────────────────────────────────────────────────────────┘
                              ▲
                              │  cursors in / cursors out
                              ▼
┌────────────────────────────────────────────────────────────┐
│  Connector (source-specific)                               │
│  • Declares per-entity: supports incremental? cursor field? │
│  • Builds the source-specific filter using the cursor       │
│  • Streams rows ordered by cursor field ascending           │
│  • Tracks max cursor value seen per entity                  │
│  • Returns new cursor in SyncResult.cursors                 │
└────────────────────────────────────────────────────────────┘
                              ▲
                              │  rows + mergeKey
                              ▼
┌────────────────────────────────────────────────────────────┐
│  WarehouseWriter (platform-owned)                          │
│  • If mergeKey provided + existing Parquet exists:         │
│      read existing → upsert by mergeKey → write back        │
│  • Otherwise: overwrite (current behaviour, full sync)      │
└────────────────────────────────────────────────────────────┘
```

The boundaries:
- **Platform owns:** cursor *persistence*, *passing*, *merging*. It never
  knows what a "cursor" means semantically.
- **Connector owns:** cursor *interpretation* — building the source-
  specific query, ordering, tracking the new value.

That separation is what makes the framework reusable.

## Data model

New table `entity_sync_cursors`:

```sql
CREATE TABLE entity_sync_cursors (
  tenant_id        integer NOT NULL,
  connection_id    integer NOT NULL,
  entity_name      varchar(128) NOT NULL,
  cursor_type      varchar(32)  NOT NULL,  -- 'timestamp' | 'integer' | 'string'
  cursor_value     text         NOT NULL,
  rows_synced_last bigint       NOT NULL DEFAULT 0,
  last_sync_at     timestamptz  NOT NULL,
  last_status      varchar(16)  NOT NULL,  -- 'success' | 'failed'
  last_error       text,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, entity_name)
);
```

RLS + FORCE RLS, granted to `databridge_app`. Same security model as
every other tenant table.

No row in this table for `(tenant, connection, entity)` = "never synced
incrementally" → connector does a full pull. After the first successful
incremental sync the row is inserted/updated with the new cursor.

## Connector contract

A connector adds incremental support in two declarations:

```typescript
// 1. EntityDescriptor — per-entity
{
  name: 'Accounts',
  // ... other fields ...
  supportsIncremental: true,
  incrementalCursor: { field: 'Modified', type: 'timestamp' },
  businessKey: 'ID',
}

// 2. sync() — accept + return cursors
async sync(config, opts: SyncOptions, ctx): Promise<SyncResult> {
  // opts.cursors[entityName] = the prior cursor value, or undefined
  // result.cursors[entityName] = the new cursor value, or absent
}
```

Three behaviours flow from that declaration:

1. **Initial sync** (no row in `entity_sync_cursors` for this entity):
   `opts.cursors[name]` is `undefined`. Connector does a full pull,
   tracks the max cursor value seen across all rows, and returns it.
2. **Subsequent incremental sync:** `opts.cursors[name]` has the prior
   value. Connector adds a source-specific filter (`Modified gt …`)
   and an order-by clause so the highest-cursor row comes last.
   Connector returns the new max in `result.cursors[name]`.
3. **Non-incremental entity:** `incrementalCursor` is `undefined` on
   the descriptor. Connector does a full pull every time and never
   emits a cursor.

## Warehouse merge semantics

When the connector emits rows for an incrementally-synced entity, it
also passes a `mergeKey` to the writer:

```typescript
await ctx.warehouseWriter.writeTable(name, rows, { mergeKey: 'ID' });
```

The writer's behaviour with `mergeKey`:

| Existing file | Delta contains key | Result |
|---|---|---|
| Has row with key K | Yes — same K | Delta row replaces existing |
| Has row with key K | No | Existing row kept (no delete detection) |
| No row with key K | Yes | Delta row appended |

Schema evolution is handled by DuckDB's `UNION ALL BY NAME` — columns
present in one side and not the other become NULL on the missing side.
Old rows keep their original columns; new columns appear on new rows.

Implementation: the writer reads existing Parquet, UNIONs with the
NDJSON delta, applies `ROW_NUMBER() OVER (PARTITION BY mergeKey
ORDER BY _origin DESC)` so delta wins on conflict, and writes the
result back via a tmpdir-staged file (no in-place modification —
sync-crash-safe).

## Per-entity granularity

A multi-entity sync where entity A succeeds and entity B fails advances
only A's cursor. B's row in `entity_sync_cursors` stays untouched —
next run resumes B from the same point.

This is the *whole point* of per-entity rows: a 5xx error pulling
TransactionLines doesn't reset the cursor on Accounts.

## Failure modes and how they're handled

| Failure | Behaviour |
|---|---|
| Sync crashes mid-stream | Cursor not advanced. Next run re-pulls rows since last cursor (idempotent via merge-by-key). |
| Entity A succeeds, entity B fails | A's cursor advances, B's stays. Per-entity granularity. |
| Source row's `Modified` updated to an earlier value (clock skew) | Defensive check rejects non-advancing cursor writes. |
| Existing file has columns the delta doesn't, or vice versa | DuckDB `UNION ALL BY NAME` widens schema, NULLs the missing columns on each side. No data loss. |
| User runs concurrent syncs | Existing in-flight check in `triggerSync` prevents it. |
| `entity_sync_cursors` table is missing or unreadable | Orchestrator logs the error, runs full sync as fallback. Sync is not blocked. |
| Connector returns a cursor lower than the stored value | Orchestrator logs `non-advancing cursor; skipping update`. Stored value stays. |
| Cursor persistence fails after sync succeeded | Sync still counted as successful. Worst case the next sync re-pulls some rows (idempotent). |

## Deletes — soft, never silent (phase 2, September 2026)

ExactOnline does not expose a "deleted records" feed; a row that has been
deleted simply stops appearing. Until phase 2 the merge writer kept such a
row forever and the only remedy was a full re-sync that OVERWROTE the table.

Every source table the writers produce now carries two technical columns,
behind the platform's underscore firewall (no prompt, profile, notebook or
transformation ever sees them):

| Column | Meaning |
|---|---|
| `_clarion_synced_at` | when a sync last wrote this row |
| `_clarion_deleted` | true when the source no longer has it |

Three operations set them; none removes a row from disk:

1. **A merge** stamps every delta row `synced_at = now(), deleted = false`.
   A key that reappears after being marked deleted comes back alive — the
   delta is the source's word.
2. **A full re-sync** MERGES everything it pulls (the same stamp) and then
   calls `finalizeFullSync(entity, { syncStartedAt })`: every row whose
   stamp is older than the run's start, or absent, was not seen by a pull
   that saw everything, so it is marked deleted. Only entities WITHOUT a
   business key are still replaced outright — there is nothing to merge on.
3. **A reconcile** (`POST /connections/:id/sync { reconcile: true }`,
   "Check for deleted rows" on the source card) pulls the source's KEYS only
   — `$select=ID` on Exact Online, `fields: ['id']` on Odoo, a fraction of a
   full pull — and `reconcileKeys` marks absent keys deleted and revives
   present ones. Content and cursors are untouched. An empty key list over a
   non-empty table is REFUSED (a throttled endpoint looks exactly like an
   empty table), the same rule the empty-batch write follows.

The read side (`backend/src/services/warehouse/views.ts: createScanView`)
registers a parquet-backed view as
`SELECT * EXCLUDE (_clarion_synced_at, _clarion_deleted) … WHERE NOT
COALESCE(_clarion_deleted, false)` whenever the file carries the columns —
one `DESCRIBE` per registration. A legacy file without them reads as before
and gains the columns on its next write. A topic that WANTS deleted rows
(cancellations) has no door yet; that is a later slice.

The merge itself is an anti-join now, not a window function: `existing WHERE
NOT EXISTS (delta) UNION ALL delta`, with the delta deduplicated by key
first. Measured on a 3M-row / 208 MB table with a 10k delta at one thread:
the old `ROW_NUMBER() OVER (PARTITION BY key)` formulation went out of
memory at a 1.1 GiB ceiling (1.3 GB peak with the ceiling lifted); the
anti-join finished in 4.5 s at +150 MB. It is still O(table) in I/O — the
file is rewritten — which is what phase 2's table-format decision (B1) is
about; but it is the difference between a merge that fits a 1-vCPU / 1-GiB
job and one that does not.

## Resumable loads (phase 2, B3)

A sync has a hard ceiling (`SYNC_MAX_DURATION_MS`, 30 min). Before phase 2
a worker that hit it was killed mid-entity and the next run started that
entity from scratch — an initial load of a large `TransactionLines` could
never finish. Now:

- **The worker knows the deadline** (`WORKER_DEADLINE_AT`) and stops pulling
  cleanly `SYNC_DEADLINE_MARGIN_MS` before it (`SyncContext.timeBudget`).
- **Entities are written in chunks** (`BaseSourceConnector.writeEntityInChunks`,
  `SYNC_CHECKPOINT_ROWS` per flush). After every flush the connector reports
  the highest cursor written so far through `ctx.onEntityCheckpoint`, and
  the orchestrator persists it AT ONCE (`last_status = 'incomplete'`). This
  is only correct when rows arrive in cursor order from a source that pages
  by KEY (Exact Online: `$orderby=Modified asc` + `$skiptoken`). Odoo pages
  by OFFSET in id order, so it gets the clean stop but no mid-entity
  checkpoint — a stopped Odoo entity re-pulls from its prior cursor.
- **A completed entity is persisted when it completes**
  (`ctx.onEntityComplete` → cursor, status, `rows_total`), not when the run
  ends. A worker that dies after entity three of twenty keeps three.
- **A stopped run reports `incompleteEntities`** (stopped after a checkpoint,
  or never started). The orchestrator records them on the run
  (`source_sync_runs.incomplete_entities`), persists the run as `succeeded`
  with a warning, and queues a CONTINUATION run for exactly those entities
  (`resumed_from_run_id` names the part it continues). The pipeline gate
  reads a run with incomplete entities as `partial` — a fact must not be
  built on a half-loaded table — and profiling and on-source-sync triggers
  wait for the last part. `planContinuation` refuses to chain after
  `SYNC_MAX_CONTINUATIONS` parts, and after a part that made no progress
  (a source that yields nothing within a whole budget is a fault); then the
  run is `partial` and says why.
- A full re-sync that stops at its budget continues INCREMENTALLY; its
  deleted-row check does not carry over — the warning says to run a
  reconcile once the load finishes.

## Per-entity state (phase 2, B6)

`entity_sync_cursors` is the per-(connection, entity) STATE row now:
`cursor_type` / `cursor_value` are nullable (an always-full entity, or one
whose first pull failed, carries a status without a watermark),
`rows_total` is what the table holds after its last write (soft-deleted
rows excluded) — the number the catalog shows — and `last_status` is
`success` | `failed` | `incomplete`. A failed entity keeps the cursor it
had and gets `last_error`; a state-only row is never handed to the worker
as a watermark.

## Adding incremental support to a new connector

Six things needed:

1. **Pick a cursor field.** For most modern SaaS APIs this is a
   `Modified` / `LastModified` / `UpdatedAt` field. For database
   sources, an `updated_at` column or a sequence. For CDC-capable
   sources, an LSN.
2. **Declare it on each `EntityDescriptor`:** set
   `incrementalCursor: { field: 'Modified', type: 'timestamp' }` and
   `businessKey: 'ID'`. Flip `supportsIncremental` to `true`.
3. **In `sync()`:** read `opts.cursors[entityName]` and translate it
   into the source's filter syntax. Order results by the cursor field
   ascending so a mid-sync crash leaves a valid resume point.
4. **Track the max cursor seen** as rows stream. Return it in
   `result.cursors[entityName]`.
5. **Pass `{ mergeKey: businessKey }` to `warehouseWriter.writeTable`**
   when the entity is incremental and has a known business key.
   Without it the writer overwrites — wrong for incremental.
6. **Test:** add a test that runs sync twice with a prior cursor,
   verifies the URL contains the filter, and verifies the new cursor
   value is returned.

That's the entire reusable surface.

## What ships in the May 2026 release

- DB migration `20260515000062_create_entity_sync_cursors.ts`
- `SyncOptions.cursors`, `SyncResult.cursors`, `EntityDescriptor.incrementalCursor`, `EntityDescriptor.businessKey`, `WriteTableOptions.mergeKey` in the connector framework types
- `LocalFileWarehouseWriter` and `BlobSasWarehouseWriter` merge logic
  (DuckDB `UNION ALL BY NAME` + `ROW_NUMBER` partition)
- ExactOnline declares incremental on ~38 of its 55 entities
  (everything except master/dictionary tables, read-only aggregates,
  and stock-snapshot tables)
- Worker / orchestrator wiring: `WORKER_CURSORS` env var, `result.cursors`
  event field, per-entity cursor persistence after success
- Tests covering: filter construction, cursor tracking across pages,
  cursor not emitted on failed entities, merge upsert semantics,
  unsafe-mergeKey rejection

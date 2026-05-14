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

## Deletes — explicit non-goal for v1

ExactOnline does not expose a "deleted records" feed. A row that's been
deleted in EO simply stops appearing in the API response. Incremental
sync does **not** detect this — the merge writer keeps the row in the
warehouse forever.

Workaround: schedule a periodic *full* re-sync (e.g. weekly), which the
operator triggers by deleting all `entity_sync_cursors` rows for that
connection. Future enhancement: a dedicated "force full re-sync" action
on the connection settings page that clears the cursor table for that
connection.

This is not unique to Clarion — every Singer tap, Fivetran connector,
and bespoke EO integration handles deletes the same way.

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

# SCD Type 2 — slowly changing dimensions

> Status: **backlog**. Foundation shipped (Delta + Python sidecar + row-hash
> change tracking) under the SCD1 path. SCD2 is the next layer on top of
> that infrastructure — adding `_valid_from` / `_valid_to` / `_is_current`
> columns and the AI prompt rules to use them correctly.

## Why this matters

Today every dimension is overwrite-only: refreshing `dim_supplier` replaces
the row entirely. There's no way to answer "what was supplier X's price on
6 March?" because that row no longer exists in the dim — only today's
price does.

The marketing journey doc shows Sara investigating "Why did Beverages
margin drop?" and Clarion finding "One supplier raised prices +12% on 6
March." That investigation **literally cannot work** without history. The
agent can only see today's prices. SCD2 is what makes the journey real.

## Decisions confirmed (from the design conversation)

| Question | Decision |
|---|---|
| Default-on for new products only? | **Yes** — existing products keep current behavior |
| Apply to all dim columns or per-column? | **All** dimension business columns by default; calendar/lookup dims excluded |
| Delta vs Parquet? | **Delta** — leverages MERGE INTO + ACID + schema evolution + time travel |
| Compute engine for the merge? | **Python sidecar** with `deltalake` + `polars`. Node DuckDB stays for all read paths |
| Schema-version bump trigger | **Automatic** — bumped whenever `product_columns` set changes |
| History view exposure to viewers | **Restricted to admin/analyst** — viewers see current view only |
| Naming of temporal columns | **`effective_from`, `effective_to`, `is_current`** in the user-facing history view; raw storage uses `_valid_from`, `_valid_to`, `_is_current` |

## Storage model

Every SCD2-enabled dim has these columns (`_` prefix sorts to end + reads
as obviously technical):

| Column | Source | Purpose |
|---|---|---|
| (business cols) | source | The actual data |
| `_row_hash` | computed | u64 hash of business cols. **Already shipped in SCD1 layer** |
| `_valid_from` | refresh time | When this version became effective |
| `_valid_to` | refresh time | When superseded; `NULL` for current |
| `_is_current` | derived | `TRUE` only on the latest version per business key |
| `_hash_schema_version` | metadata | Bumped when business-column set changes |

**No surrogate keys.** Standard SCD2 uses one for fast equi-joins, but
forces fact tables to look up the right version at materialization time.
For SMB scale, point-in-time joins (`fact_date BETWEEN _valid_from AND
_valid_to`) are fast enough and dramatically simpler.

## Two views per dim

The raw Delta table at `delta_path` contains ALL rows including history.
Two views built on top, both registered into every DuckDB session:

1. **`dim_supplier`** (default current view):
   ```sql
   SELECT (business_cols)
   FROM delta_scan('<path>')
   WHERE _is_current = TRUE
   ```
   Available to all roles. AI's NL→SQL prompt uses this for current-state
   questions. Notebook users see this when they `SELECT * FROM dim_supplier`.

2. **`dim_supplier_history`** (admin/analyst only):
   ```sql
   SELECT (business_cols),
          _valid_from AS effective_from,
          _valid_to   AS effective_to,
          _is_current AS is_current
   FROM delta_scan('<path>')
   ```
   Renamed temporal cols (no underscore prefix) so they read like real
   business semantics. Viewers don't see this view at all.

## Hard questions, answered

### Schema evolution — column added

- New column → add to dim with `NULL` for all historical rows
- `_hash_schema_version` bumps → next refresh recomputes hashes for **all
  existing-current rows** (because the old hash didn't include the new column)
- Without the version bump: every row would look "changed" on the next
  refresh and a phantom new version would be cut for every BK. Not acceptable.

### Schema evolution — column removed

- Keep the column in the history table (historical truth — past invoices
  may have used it)
- New rows get `NULL` for the removed column
- Same hash-version bump

### Schema evolution — column renamed

- Indistinguishable from drop+add via introspection. Treat as drop+add.
- History for old name preserved as `NULL` going forward
- Power users who care about continuity can manually rebuild via product
  redesign

### Type changes

- **Widening** (INT → BIGINT, NUMERIC(10,2) → NUMERIC(12,4)): rewrite the
  history table with the widened type on first refresh. One-time cost.
  Delta supports this natively.
- **Narrowing**: surface as a schema-change alert; user must confirm.
  Default: keep widened type in dim even if source narrowed.
- **Incompatible** (TEXT → INT): hard refuse. Schema-changes table records
  it. Dim refresh fails with explicit reason.

### Hiding technical columns from end users

Three layers of defence:
1. **Storage layer**: technical cols use `_` prefix (already in SCD1
   foundation — `_row_hash`)
2. **Semantic layer**: `is_technical` flag on `product_columns` (already
   shipped). Catalog UI, schema explorer, and NL→SQL prompt strip them.
3. **View layer**: the views above never `SELECT *` from the raw — they
   list business cols explicitly + the renamed temporal cols. The raw
   path is invisible to all read surfaces.

### Fact ↔ dim joins

**The risk:** AI generates `fact_orders.supplier_id = dim_supplier.supplier_id`
which works for "today's price on a March order" — wrong for historical
analysis.

**Mitigations:**
1. Default `dim_supplier` is current-only. AI sees both views in schema
   context with explicit guidance: "Use `dim_supplier` for current. Use
   `dim_supplier_history` for time-aware. When joining `_history` to a
   fact, the temporal join is mandatory."
2. New `temporal_join_template` field on `table_relationships` carrying
   the canonical join SQL — given to the AI as a template, no invention
   from first principles needed.
3. Post-generation validator: SQL that joins `_history` without
   `effective_from`/`effective_to` predicates is rejected and regenerated.

### Idempotency

The brute-force SCD2 algorithm:
1. Read existing dim (raw, all versions) into polars
2. Compute new state from source via DuckDB
3. Hash-version check: if stale, recompute current-version hashes
4. Diff: outer-join existing-current with new on business key
5. Cases:
   - **Unchanged** (BK matches, hash matches): keep row as-is
   - **Changed** (BK matches, hash differs): close existing
     (`_valid_to = now`, `_is_current = FALSE`), insert new
     (`_valid_from = now`, `_is_current = TRUE`)
   - **New** (BK in source, not in existing-current): insert
   - **Deleted** (BK in existing-current, not in source): close existing,
     no insertion
   - **Resurrected** (BK was deleted, returns): closed row stays, insert
     new with current
6. Write entire merged result to Delta with `mode='overwrite'`,
   `schema_mode='merge'`. Delta keeps the prior version accessible via
   time travel.

### Concurrency

Per-product-table advisory lock in Postgres
(`pg_advisory_lock(hashtext('scd2_' || product_table_id))`) held for the
duration of the sidecar. Eliminates double-version bugs from concurrent
refreshes.

### First-run detection

Sidecar checks if `_delta_log/` exists at the path. If not, treat as
initial write (no diff, all rows get `_valid_from = now`, `_is_current = TRUE`).

### Out-of-order refreshes

`_valid_from` uses the orchestrator's clock at sidecar start, NOT source
event time. Avoids weirdness from clock skew across systems.

## Implementation phases

### Phase 1 — Storage scaffolding (SHIPPED in SCD1 foundation)

- Delta storage at v2 layout (`tenant_X/product_Y/<table>`)
- Python sidecar (`etl/scd2/commit_table.py`) with `mode='scd1'`
- Row-hash computed + persisted (`_row_hash` column already in Delta)
- View layer that strips `_row_hash` from all surfaces
- Feature flag `STORAGE_FORMAT=delta_v1` → `parquet` rollback path
- Refresh history table + per-table change-evolution chart

### Phase 2 — SCD2 default-on for new products

1. Migration: extend `product_tables` with `scd2_enabled BOOLEAN DEFAULT FALSE`
   and `hash_schema_version INTEGER DEFAULT 1`
2. AI star-schema designer prompt updated to set `scd2_enabled: true` for
   new dims (calendar/lookup dims excluded)
3. Sidecar mode `scd2` activated:
   - Adds `_valid_from`, `_valid_to`, `_is_current`, `_hash_schema_version`
     columns to the storage
   - Implements the full diff algorithm above
   - Returns SCD2-aware counts: rows_versioned (closed + new for changed),
     rows_inserted (truly new), rows_deleted (closed without successor)
4. View layer extended:
   - `buildCurrentView(table)`: `SELECT business_cols FROM raw WHERE _is_current = TRUE`
   - `buildHistoryView(table)`: `SELECT business_cols, _valid_from AS effective_from, ... FROM raw`
   - Both registered as DuckDB views in every session
5. `is_temporal_metadata` flag on `product_columns` for the temporal cols

### Phase 3 — Query intelligence

This is where the journey use case becomes real.

1. **NL→SQL prompt updates** with usage rules + temporal join template
2. **Investigation prompts** auto-reach for `_history` for "why/when did X change"
3. **Post-generation validator**: parse generated SQL; if it joins `_history`
   without temporal predicates, regenerate with a forcing message
4. **Role gating**: viewers' schema context excludes `_history` views

### Phase 4 — UI polish

1. Catalog table panel chip: "Tracks history · 47 versions across 12 suppliers"
2. Click → version timeline (rows × time) modal
3. Time-aware investigation chips after fact-based queries:
   "How has this changed over time?"

## What's NOT in scope (deferred or out)

- **Bitemporal modeling** (system time + business time). Overkill for SMB.
- **Surrogate keys** in dim tables. Point-in-time joins are simpler and
  performant enough at SMB scale.
- **Backfilling history from CSV / past sources**. Out of scope for v1.
  History accumulates from "now" forward.
- **Asking users to opt in/out per column** in the wizard. Smart defaults
  are correct ~95% of the time; per-column toggles are noise.

## Foundation already shipped (SCD1 → SCD2 transition is small)

The SCD1 + Delta + sidecar work that landed in commit `<TBD>` did the
hard infrastructure pieces. To enable SCD2 we add:

- 4 new columns to dim tables (`_valid_from`, `_valid_to`, `_is_current`,
  `_hash_schema_version`)
- One sidecar mode flip (`scd1` → `scd2`)
- Two new view-builders (`buildCurrentView`, `buildHistoryView`)
- AI prompt updates (NL→SQL + investigation)
- Post-gen SQL validator

The Delta storage, Python integration, row-hash computation, change
detection, refresh-history tracking, view layer plumbing — all already
in place.

## Open questions for when we activate Phase 2

- **Existing products migration**: when a user re-runs "Prepare my data"
  on an existing product, do we offer to enable SCD2? Default off (don't
  surprise them), opt-in via a checkbox in the redesign flow?
- **Storage cost guardrail**: if a dim's history grows past N versions
  per BK (say 500), surface a warning. Probably indicates the source is
  emitting spurious updates.
- **Visual history explorer** depth: just a row × version table, or a
  full timeline view with attribute deltas highlighted?

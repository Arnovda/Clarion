# RFC-001 — Phases 1 + 2.1–2.5 Activation Guide

Everything except the final cutover has landed. The dbt path is built, tested end-to-end, and the AI now emits dbt-native macros. Still **off by default** — set `USE_DBT_TRANSFORMATIONS=true` to route transformations through it.

Before flipping the flag on in any real tenant, walk through the steps below.

## Status

- **Phase 1 (foundation)** ✅ shipped, smoke-tested
- **Phase 2.1 (quality gates → dbt tests)** ✅ shipped, smoke-tested
- **Phase 2.2 (incremental materialisation)** ✅ shipped, smoke-tested
- **Phase 2.3 (cross-product sources)** ✅ shipped, smoke-tested
- **Phase 2.4 (AI prompt emits `{{ source() }}` / `{{ ref() }}` directly)** ✅ shipped (prompt-only change; existing products keep working via compatibility shim)
- **Phase 2.5 (richer test diagnostics via `store_failures`)** ✅ shipped, smoke-tested
- **Phase 3 (cutover + retire transformationRunner.ts)** staged — see [cutover playbook](./rfc-001-cutover-playbook.md) + parity harness at `backend/scripts/dbt-parity-check.ts`

---

## What's in the repo now

| Component | File |
|---|---|
| Python: dbt-duckdb installed | [etl/requirements.txt](../etl/requirements.txt) |
| Python: shell-out runner + results parser | [etl/dbt_runner.py](../etl/dbt_runner.py) |
| Python: `/dbt/run` + `/dbt/test` endpoints | [etl/main.py](../etl/main.py) |
| TS: project generator from Postgres metadata | [backend/src/services/dbtProjectBuilder.ts](../backend/src/services/dbtProjectBuilder.ts) |
| TS: orchestrator (build → ETL → results → pool invalidate) | [backend/src/services/dbtRunner.ts](../backend/src/services/dbtRunner.ts) |
| TS: feature-flag branch at the legacy entry point | [backend/src/services/transformationRunner.ts](../backend/src/services/transformationRunner.ts) |
| Env flag | [.env.example](../.env.example) — `USE_DBT_TRANSFORMATIONS` |

The **legacy `transformationRunner.ts` is untouched** — flip the flag to
`false` at any time to fall straight back to it.

## How to activate (dev)

```bash
# 1. Rebuild the ETL image so dbt-duckdb + dbt-core are installed
docker compose build etl
docker compose up -d etl

# 2. Set the flag in backend's .env
echo "USE_DBT_TRANSFORMATIONS=true" >> backend/.env

# 3. Restart the backend
# (in another terminal, kill and re-run `npm run dev` in backend/)

# 4. Verify dbt is reachable from the ETL container
curl -X POST http://localhost:8000/dbt/run \
  -H 'Content-Type: application/json' \
  -d '{"project_dir": "/tmp/nonexistent"}'
# Should return {"ok": false, "error": "Project directory not found: ..."}
# Any other error (e.g. "dbt binary not found") means the image wasn't rebuilt.
```

## Smoke test with a real product

Use a throwaway product first. Either create a new one through the UI or
pick one whose data you don't mind recomputing.

1. **Ingest source data** (unchanged — still goes through the existing ETL path).
2. **Click "Run transformation" on the product page.** With the flag on,
   the backend will:
   - Generate a dbt project at
     `warehouse/_dbt_projects/tenant_<id>/<product_slug>/`
   - Call ETL `POST /dbt/run` with the project path
   - Parse dbt's `run_results.json` and update `product_tables`
3. **Check the generated project on disk** — open the files, verify:
   - Each model has a `{{ config(materialized='external', location=...) }}` header
   - `on-run-start` hook in `dbt_project.yml` has a `delta_scan` for each
     ingested source table
   - Any bare sibling table references were rewritten to `{{ ref(...) }}`
4. **Compare the output Parquet** under `warehouse/product/<slug>/<table>/data.parquet`
   against a pre-dbt run. They should match within floating-point tolerance.
5. **Query the product through `/query`** to confirm the star schema is still
   readable by DuckDB.

## Known limits after Phase 2.2

1. **Incremental BK requirement.** Products with `load_mode='incremental'`
   tables need a `surrogate_key` or `natural_key` column — dbt needs a
   `unique_key` to merge on. The builder throws a clear error when this
   is missing. Mark a key column in the UI, or switch `load_mode` to
   `'full'`.
2. **Cross-product dimensions work, but AI-authored SQL still uses bare refs.**
   Phase 2.3 declared them as proper dbt sources + created views in a
   dedicated `shared_dims` schema. `{{ source('shared_dims', 'dim_customer') }}`
   resolves correctly (lineage graph is accurate), but existing transformation
   SQL keeps using bare `FROM dim_customer` via the compatibility hook.
   Phase 2.4 will migrate the AI prompts to emit `{{ source() }}` macros.
3. **Row counts** in `product_tables.row_count` after a dbt run come from
   DuckDB's `rows_affected` via `adapter_response`. This is correct for
   `COPY ... TO` but may be null in some edge cases. UI gracefully handles
   null here (shows `—`).
4. **`delta_path` is not updated** after dbt runs. The legacy runner set
   it; dbt writes to the same path but we don't re-confirm. If `delta_path`
   was already set by a previous legacy run, it stays correct. If this is
   the first run on a product, it will be null. Phase 3 will reconcile.
5. **Regex-based SQL rewriter is fragile.** It only covers
   `FROM <name>` and `JOIN <name>`. CTE refs and window-function
   references are not rewritten. If a transformation uses those to
   reference a sibling model, the dbt run will fail at compile. Phase 2.4
   will swap for a proper sqlglot-based parser or migrate the AI
   prompts to emit `ref()` directly.

## Quality gate coverage (Phase 2.1)

The dbt path runs these tests automatically via `dbt test` after each `dbt run`:

| Legacy check         | dbt test                               | Notes |
|----------------------|----------------------------------------|-------|
| `bk_uniqueness` single-col | built-in `unique` + `not_null`         | |
| `bk_uniqueness` multi-col  | custom `unique_combination_of_columns` | macro generated into `tests/generic/` |
| `fan_out`           | custom `fan_out_no_surplus`            | only emitted when SQL contains `JOIN` |
| `ref_integrity`      | built-in `relationships`               | only for FKs whose target is a sibling product_table (cross-product FKs tracked in Phase 2.3) |
| `value_range`        | custom `value_range_outlier`           | fires on `max > 100× avg` OR any negatives in measures |
| `null_check`         | built-in `not_null` (key cols only)    | non-key null completeness deferred to Phase 3 |

Results are persisted to `transformation_checks` — the existing UI continues to show them with no changes.

**Phase 2.5 adds rich diagnostics.** Every failed test's offending rows are stored in `<schema>_dbt_test__audit.<test_name>` tables inside the state DuckDB (`+store_failures: true` in `dbt_project.yml`). The ETL's `/dbt/test` endpoint now fetches up to 10 sample rows + the total count, which dbtRunner writes into `transformation_checks.sample_duplicates` + `duplicate_count`. The UI shows these unchanged.

## Source declarations (Phase 2.3)

The project now emits `models/sources.yml` with two source groups:

- **`source_layer`** — the Delta tables ingested from the upstream connection. On-run-start creates views under both `main` (bare refs) and `source_layer` schemas.
- **`shared_dims`** — conformed dimensions materialised by dependency products. Same dual-schema pattern. Each source table carries a `meta.source_product` tag pointing at the owning product.

This gives dbt a complete picture of the product's inputs → lineage graph (`dbt docs`) and dependency validation now work for cross-product references. Existing AI-generated SQL using bare table names continues to work unchanged.

## AI prompt migration (Phase 2.4)

`starSchemaPrompt.ts` now instructs Claude to emit macros in every `transformation_sql` it generates:

| Reference type | Macro |
|---|---|
| Raw source table | `{{ source('source_layer', 'customers') }}` |
| Sibling dimension in the same product | `{{ ref('dim_customer') }}` |
| Shared/conformed dim from a dependency product | `{{ source('shared_dims', 'dim_customer') }}` |

**Backwards compat is preserved.** Products whose SQL was generated *before* this prompt update still have bare names (`FROM customers`, `JOIN dim_customer`) stored in Postgres. Those keep working because:

1. The on-run-start hook still creates bare-name views in `main` (alongside the schema-qualified views Phase 2.3 added).
2. `dbtProjectBuilder.rewriteSqlWithRefs()` regex-patches bare sibling refs to `{{ ref() }}` for dbt DAG resolution. It's a no-op on macro-native SQL (detects `{{ ref(` and exits early).

**Future cleanup** (post Phase 3, when all products have been re-authored): drop the bare-name views from on-run-start and delete `rewriteSqlWithRefs`. Tracked for a later sprint.

## Kill switch

If anything breaks, set `USE_DBT_TRANSFORMATIONS=false` and restart the
backend. Legacy path resumes immediately; no data migration needed.

## Incremental behaviour (Phase 2.2)

For products with `load_mode='incremental'` tables:

- Each model gets `materialized='incremental'` + `unique_key` from the
  BK columns (surrogate_key → natural_key → composite FK grain for facts).
- Strategy is `delete+insert` — on each run, rows with matching unique_key
  are deleted then the incoming batch is inserted. Rows present in state
  but NOT in the incoming batch are **preserved**.
- A `post_hook` runs `COPY {{ this }} TO '<parquet_path>' (FORMAT PARQUET)`
  after each model, so the warehouse Parquet file always reflects the
  latest merged state.
- dbt state lives at
  `warehouse/_dbt_state/tenant_<id>/<product_slug>/state.duckdb` —
  outside the project's `target/` dir so it survives cleanup between runs.

This matches the legacy runner's BK-dedup semantics without needing the
file-level merge code that was local-only.

## What to build next

In priority order:

1. **Phase 3 — Cutover** (0.5 day).
   - Default flag to true.
   - After a release cycle of dbt-path running cleanly:
     - Delete `transformationRunner.ts` (legacy runner).
     - Delete `rewriteSqlWithRefs()` and bare-name views from
       on-run-start in `dbtProjectBuilder.ts` (assumes all active
       products have been re-run with the new prompt and their
       `transformation_sql` regenerated).

# RFC-001 — Replace `transformationRunner.ts` with dbt-duckdb

Status: **Proposed** (not implemented)
Author: architecture review, 2026-04-18

---

## Problem

`backend/src/services/transformationRunner.ts` (~620 lines) is a homegrown
transformation engine:

- Single integer `dag_order` column is assumed correct — no dependency
  resolution, no cycle detection, no cross-product lineage.
- Quality checks are narrow (BK uniqueness + fan-out); no column-level
  data tests, freshness tests, or uniqueness-across-multiple-columns.
- No run history beyond `last_run_at` / `last_run_error` on the latest
  attempt — when a nightly run fails we lose the prior success's metadata.
- No model versioning — edit a transformation and the old version is gone.
- SQL errors now fail loudly (RFC work already completed), but there's
  no staged "test then deploy" path.

Every new feature (incremental models, column-level lineage, testing
patterns, exposures) we'd build from scratch. Meanwhile a mature ecosystem
solves all of it: **dbt** (or SQLMesh).

## Proposal

Replace the transformation engine with **dbt-duckdb**. Keep the
AI *authoring* layer that generates `transformation_sql` — but emit dbt
models on disk instead of rows in the `product_tables` table, and run
them with `dbt run` / `dbt test`.

### Why dbt over SQLMesh

| Criterion | dbt-duckdb | SQLMesh |
|---|---|---|
| Maturity | 2017+, huge ecosystem | 2023+, fast-moving |
| DuckDB adapter | First-class, stable | First-class |
| Testing | `dbt test` with generic + singular tests | `AUDIT` blocks |
| Lineage | Built into docs server; columns in dbt 1.6+ | Built-in |
| AI-friendliness | Generating YAML + SQL files is well-understood | Python DSL less common in LLM training |
| Our users | "dbt" is recognizable to data teams | Harder to recruit for |

Recommendation: **dbt-duckdb**.

## Architecture sketch

```
Today:
  [AI designs star schema] → product_tables table (SQL column) → transformationRunner.ts → Parquet

Proposed:
  [AI designs star schema] → dbt project on disk (models/*.sql + schema.yml) → dbt run → Parquet
                                        ↑
                           materialised under warehouse/_dbt_projects/{tenant}/{product}/
```

### dbt project layout per product

```
warehouse/_dbt_projects/tenant_{id}/{product_slug}/
├── dbt_project.yml
├── profiles.yml              # DuckDB connection pointing at existing warehouse
├── models/
│   ├── schema.yml            # sources, models, tests
│   ├── dimensions/
│   │   ├── dim_customer.sql
│   │   ├── dim_product.sql
│   │   └── ...
│   └── facts/
│       ├── fact_orders.sql
│       └── ...
└── tests/                    # singular tests (custom SQL)
```

### What stays the same

- The `data_products` / `star_schemas` / `product_tables` Postgres rows —
  keep them as the **product metadata catalog** (business names,
  descriptions, approval workflow, the UI).
- `product_tables.transformation_sql` becomes the *source of truth for
  authoring* — dbt files are generated from it.
- Star schema diagram + lineage UI — both read from the same Postgres
  metadata.

### What changes

| Surface | Today | Proposed |
|---|---|---|
| Run a transformation | `runProductTransformation(product, tables)` | Write dbt files → `exec('dbt run')` |
| Dependency resolution | `dag_order` column | `{{ ref('dim_customer') }}` in SQL |
| Tests | `transformation_checks` table | `schema.yml` generic tests + `tests/*.sql` |
| Incremental | Manual BK-based merge in code | `{{ config(materialized='incremental') }}` |
| Run history | `transformation_status` on latest | dbt's `run_results.json` per invocation |
| Docs | None | `dbt docs generate` → static site |

### Migration path

**Phase 1 — Foundation (2-3 days)**
1. Add `dbt-duckdb` to the Python ETL image (it's a Python tool, fits
   naturally there). Or a separate Node→Python shell-out from
   transformationRunner. Preferable: new `dbt-runner` service alongside ETL.
2. Write a `productToDbt(product)` function that emits dbt files on disk
   from current Postgres metadata.
3. Keep `transformationRunner.ts` as-is. Run dbt *in parallel* on an opt-in
   flag (`USE_DBT=true` env var) to compare outputs table-by-table against
   the legacy runner.

**Phase 2 — Feature parity (3-5 days)**
1. Port the two quality checks (BK uniqueness, fan-out) to dbt generic tests.
2. Port incremental materialisation to `materialized='incremental'`
   + `unique_key`.
3. Port Azure Blob writes — dbt-duckdb supports this via `external_root`.

**Phase 3 — Cutover (1-2 days)**
1. Flip default to dbt.
2. Retire `transformationRunner.ts`. Keep `transformationChecks.ts` for a
   release cycle as a regression-safety net.

**Phase 4 — Unlock new capabilities (ongoing)**
- Generate dbt models from Claude directly (instead of SQL-only, generate
  `schema.yml` with tests and descriptions).
- Column-level lineage (dbt 1.6+) feeds into the UI lineage graph.
- `dbt docs serve` as the admin "what does this column mean" view.
- Cross-product refs: `{{ ref('catalogue.dim_customer') }}` — solves the
  conformed-dimension problem.

### Risks

- **Multi-tenant isolation in dbt.** Need one dbt project per tenant or
  per tenant×product to prevent cross-tenant refs. One project per product
  under `warehouse/_dbt_projects/tenant_{id}/...` is the safe starting point.
- **Performance of spawning dbt CLI.** Cold start ~2s. For scheduled batch
  this is a rounding error; for interactive preview ("run this one model
  now") we may need dbt's programmatic API.
- **AI output drift.** Claude's outputs will need to target the new file
  format. The prompts in `backend/src/ai/prompts/starSchemaPrompt.ts` will
  need a pass to emit dbt-style refs + tests.
- **Disk footprint.** One dbt project per product is cheap (<1 MB each),
  but we'll want cleanup when a product is deleted.

### Success criteria

- All existing products re-materialise identically under dbt within 5% of
  the pre-migration wall-clock.
- `dbt test` catches at least the two existing quality checks.
- Lineage UI shows the same graph as before, sourced from dbt's
  `manifest.json` instead of the current Postgres DAG.
- New capability: user can rerun a single model (`dbt run -s fact_orders`)
  instead of the whole product.

### Estimated effort

**~2 weeks of one engineer's focused time.** Most of the work is in
Phase 2 (quality-check parity + incremental parity). Phase 1 is
well-understood (file generation is mechanical). Phase 3 is small once
parity is proven.

### Decision

Proposed. Not taken — filed here for a dedicated sprint.

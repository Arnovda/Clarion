# RFC-001 — Phase 3 Cutover Playbook

The dbt path (`USE_DBT_TRANSFORMATIONS=true`) produces mechanically equivalent
output to the legacy runner for our baseline case (verified by the parity
harness). This doc is the checklist for actually pulling the trigger —
and the instructions for rolling back if something breaks.

The cutover is staged: **Prepare → Validate → Execute**. Do not skip Validate.

---

## Stage A — Prepare (done, one-time)

- [x] Phase 1 + 2.1 + 2.2 + 2.3 + 2.4 + 2.5 shipped, smoke-tested
- [x] Parity harness at `backend/scripts/dbt-parity-check.ts` (synthetic shapes)
- [x] Shadow-run driver at `backend/scripts/shadow-run.ts` (real-product engine comparison)
- [x] This playbook
- [x] **One real-data shadow run**: product 121 (Articles, tenant 63, 4 tables) —
  all 4 Parquet outputs match exactly between legacy and dbt engines
  (same schema, same row counts, zero rows in either-engine-only set).

### Bugs found and fixed during the first real-data shadow run

Synthetic parity tests don't exercise the host-vs-container path boundary
because the harness writes its own projects. Running against real data
caught four path-resolution bugs:

1. **`dbtStatePath` returned Windows host paths** (`C:\Users\...`) which
   dbt inside the Linux container treated as relative, producing
   mangled paths. Fixed with a new `dbtStatePathForEtl` that returns the
   container's view of the same file.
2. **`productOutputDir` did the same** for `external_root` in `profiles.yml`
   and `config(location=…)` in every model. Added `productOutputDirForEtl`.
3. **State-file parent dir mismatch**: host created `conn_22/_dbt_state/`,
   ETL looked at top-level `_dbt_state/`. Unified both on the
   top-level convention.
4. **dbt's external materializer doesn't `mkdir -p` the target** — added
   explicit pre-creation of per-table output subdirs.

All four are now fixed in `dbtProjectBuilder.ts`. Re-run the parity harness
to confirm synthetic coverage still passes after the refactor.

## Stage B — Validate (run before flipping defaults)

Gating criteria — **all three** must be green before moving to Stage C:

1. **Baseline parity** — `backend/scripts/dbt-parity-check.ts` passes for
   every shape in its `SHAPES` dict.

   ```bash
   cd backend && npx tsx scripts/dbt-parity-check.ts dim_simple
   ```

   Expected: `PASS — N rows match exactly`. Add more shapes (facts with
   JOINs, multi-table DAG, incremental) to the harness until they cover
   every pattern used by your real products.

2. **Real-product shadow run** — pick 2–3 representative products in a
   non-production tenant:

   - Set `USE_DBT_TRANSFORMATIONS=true` in that environment's backend
     `.env` and restart the backend.
   - Trigger a transformation run on each product from the UI.
   - Compare the resulting Parquet files against a previous legacy-runner
     output (you'll need one from before the flag flip — snapshot the
     `warehouse/product/<slug>/` directory first).
   - Manual DuckDB diff works:

     ```sql
     ATTACH ':memory:';
     SELECT COUNT(*) FROM read_parquet('warehouse_pre_dbt/product/sales/fact_orders/data.parquet');
     SELECT COUNT(*) FROM read_parquet('warehouse/product/sales/fact_orders/data.parquet');

     -- Schema diff
     DESCRIBE SELECT * FROM read_parquet('warehouse_pre_dbt/product/sales/fact_orders/data.parquet');
     DESCRIBE SELECT * FROM read_parquet('warehouse/product/sales/fact_orders/data.parquet');

     -- Row diff
     SELECT 'only_pre', * FROM (
       SELECT * FROM read_parquet('warehouse_pre_dbt/product/sales/fact_orders/data.parquet')
       EXCEPT ALL
       SELECT * FROM read_parquet('warehouse/product/sales/fact_orders/data.parquet')
     ) LIMIT 10;
     ```

3. **Quality-gate parity** — for the same 2–3 products, confirm
   `transformation_checks` entries (what the UI shows) are the same set of
   `check_type` / `status` pairs before and after. Sample the rich-diagnostic
   rows (`sample_duplicates`) — content may differ slightly (dbt stores
   offending rows; legacy stored `(col, count)` pairs) but the failure
   SIGNAL should match.

If any check fails, file a bug, keep the flag OFF, do NOT proceed to Stage C.

## Stage C — Execute (after Stage B is clean)

The "delete the legacy code" moment. Do this in ONE commit, separate from
any unrelated work, so revert is a clean `git revert`.

### C1. Flip default on

```diff
-USE_DBT_TRANSFORMATIONS=false
+USE_DBT_TRANSFORMATIONS=true
```

Files:
- `.env.example`
- Any production `.env` / Azure Container Apps env config

Deploy. Let it soak for at least one release cycle (≥1 week, ideally 2).
Watch the `transformation_*` metrics (wired in Phase 5 of the hardening
work): `dbt_transformation_ms`, `dbt_transformation_complete`. Watch
`transformation_checks` for unexpected `error` rows.

### C2. Delete the legacy engine

Only after C1 has been stable in production for a release cycle.

Files to delete:
- `backend/src/services/transformationRunner.ts`
- `backend/src/services/transformationChecks.ts`

Files to modify:
- In the 5 call-sites (grep for `runProductTransformation`), change imports to
  call `runProductTransformationDbt` directly — no more delegation through
  the legacy entry point.
- In `dbtProjectBuilder.ts`:
  - Delete `rewriteSqlWithRefs()` (regex fallback for pre-2.4 SQL)
  - Delete the `CREATE OR REPLACE VIEW "${name}" AS SELECT * FROM delta_scan(...)` bare-name hook lines in `buildDbtProjectYaml` — keep only the schema-qualified `source_layer.` / `shared_dims.` versions

### C3. Migrate any remaining pre-2.4 SQL

If any product's `product_tables.transformation_sql` still has bare table
names (i.e. was generated before Phase 2.4), the compatibility views that
C2 just deleted were keeping them alive. Options:

- **Re-generate** via the UI's "Redesign with AI" flow (fresh Claude output
  will use macros).
- **Manual fix-up**: one-time SQL pass to rewrite stored transformation_sql.
  Pattern is `FROM <name>` → `FROM {{ source('source_layer', '<name>') }}`
  or `{{ ref('<name>') }}` depending on which side of the model graph the
  name lives on.

Grep before deleting compatibility views to be sure the risk is understood:

```sql
SELECT id, table_name
FROM product_tables
WHERE transformation_sql NOT LIKE '%{{ source%'
  AND transformation_sql NOT LIKE '%{{ ref%'
  AND transformation_sql IS NOT NULL;
```

If rows come back, handle them BEFORE doing C2.

---

## Rollback procedure

**If Stage C1 causes breakage in production**:

```bash
USE_DBT_TRANSFORMATIONS=false
# redeploy backend
```

That's the entire rollback. Legacy runner is still in the codebase, flag
check routes every call through it. Zero data loss — Parquet files from
the dbt engine and legacy engine write to the same paths with compatible
schemas.

**If Stage C2 already happened** and you need to go back to legacy:

```bash
git revert <sha-of-C2-commit>
# redeploy backend
# set USE_DBT_TRANSFORMATIONS=false if keeping dbt off
```

The revert restores the legacy files and the feature flag's delegation.
Data from transformations run during the dbt window stays valid (same
Parquet schema on disk). Products that were re-authored in C3 to emit
macros will need the compatibility shim that C2 deleted — the revert
restores it.

---

## Timeline expectations

- **Stage B**: 1–2 weeks (shadow runs need at least one full incremental
  cycle on real products to prove the incremental delete+insert matches
  legacy BK merge).
- **Stage C1 soak**: 1–2 weeks after flipping the default.
- **Stage C2 + C3**: ~1 hour of focused work. Do it in one commit.

Total elapsed: **~1 month** from Stage B start to legacy deletion. This
is deliberately slow — the whole point of the staging is we don't want
to discover an engine mismatch *after* deleting the old engine.

---

## What "done" looks like

After C2 + C3:
- `transformationRunner.ts` and `transformationChecks.ts` don't exist
- `rewriteSqlWithRefs` doesn't exist
- All `product_tables.transformation_sql` uses `{{ source() }}` / `{{ ref() }}`
- The `USE_DBT_TRANSFORMATIONS` env var still exists (as `true` default) but
  the legacy branch inside `runProductTransformation` can be deleted — the
  5 callers go direct to `runProductTransformationDbt`
- Eventually `USE_DBT_TRANSFORMATIONS` itself can be removed from `.env.example`
  (optional cleanup — keep it documented as "historical toggle, always on now")

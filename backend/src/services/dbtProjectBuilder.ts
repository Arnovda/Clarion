/**
 * dbt project builder.
 *
 * Phase 1 of the dbt migration (see docs/rfc-001-dbt-transformations.md).
 *
 * Reads the Postgres metadata catalog (data_products / star_schemas /
 * product_tables / product_columns / ingested_tables) and emits a valid
 * dbt-duckdb project on disk, one directory per (tenant, product).
 *
 * Layout:
 *   warehouse/_dbt_projects/tenant_{id}/{product_slug}/
 *   ├── dbt_project.yml
 *   ├── profiles.yml
 *   └── models/
 *       ├── sources.yml   # declares each ingested Delta table as a source
 *       ├── schema.yml    # declares each product_table as a model with basic tests
 *       └── {table_name}.sql  # the transformation SQL, rewritten to use {{ ref() }}
 *
 * SQL rewriting (Phase 1 only — crude regex):
 * - Sibling product tables referenced bare (e.g. `FROM dim_customer dc`) are
 *   rewritten to `FROM {{ ref('dim_customer') }} dc` so dbt can build the DAG.
 * - Source tables stay bare — we pre-register them as DuckDB views via an
 *   `on-run-start` hook so existing SQL resolves them without `source()`.
 * - Cross-product conformed dimensions are also pre-registered by the hook.
 *
 * Phase 2 will replace the regex rewriter with a proper SQL parser and
 * generate dbt prompts that emit ref()/source() macros directly.
 */

import fs from 'fs';
import path from 'path';
import { tenantQuery } from './tenantQuery';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'dbt-builder' });

interface ProductRow {
  id: number;
  name: string;
  connection_id: number;
}

interface ProductTableRow {
  id: number;
  table_name: string;
  table_role: string;
  load_mode: string;
  dag_order: number;
  transformation_sql: string;
}

interface ProductColumnRow {
  id: number;
  product_table_id: number;
  column_name: string;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
}

interface IngestedTableRow {
  table_name: string;
  delta_path: string;
}

interface SharedDimRow {
  table_name: string;
  delta_path: string;
  source_product_name: string;
}

export interface BuildResult {
  projectDir: string;
  modelCount: number;
  sourceCount: number;
  outputDir: string;
}

const PROJECT_VERSION = '1.0.0';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isAzurePath(p: string): boolean {
  return p.startsWith('az://') || p.startsWith('abfss://');
}

/**
 * Resolve the on-disk location of the generated dbt project for a product.
 * Lives inside the warehouse so both backend + ETL (which share the warehouse
 * volume) can read the same files.
 */
export function dbtProjectDir(tenantId: number, productSlug: string, warehouseRoot: string): string {
  if (isAzurePath(warehouseRoot)) {
    // Azure: we must use a local disk path for dbt (it needs fs access to
    // project files). We write to /warehouse/_dbt_projects even in Azure mode
    // because the ETL container has that path mounted.
    return `/warehouse/_dbt_projects/tenant_${tenantId}/${productSlug}`;
  }
  return path.join(warehouseRoot, '_dbt_projects', `tenant_${tenantId}`, productSlug);
}

/**
 * Resolve the persistent DuckDB state file for a product, from the BACKEND's
 * perspective (host fs). Used when the backend needs to `mkdir -p` the
 * parent directory before dbt writes into it.
 *
 * Lives OUTSIDE `projectDir/target/` so that `target/` can be wiped between
 * runs (to clean stale artifacts) without destroying the incremental state
 * dbt relies on for diffing.
 *
 * NOTE: this is a HOST path on Windows dev. The ETL container sees the
 * same file at a different absolute path — see `dbtStatePathForEtl()`.
 */
export function dbtStatePath(tenantId: number, productSlug: string, warehouseRoot: string): string {
  if (isAzurePath(warehouseRoot)) {
    return `/warehouse/_dbt_state/tenant_${tenantId}/${productSlug}/state.duckdb`;
  }
  // The state file lives at the warehouse ROOT, not inside any single conn_N
  // subdir, so the host path ends at ./warehouse/_dbt_state/... — the same
  // place dbtStatePathForEtl resolves to inside the container.
  const warehouseRootParent = warehouseRoot.replace(/[/\\]conn_\d+$/, '');
  return path.join(warehouseRootParent, '_dbt_state', `tenant_${tenantId}`, productSlug, 'state.duckdb');
}

/**
 * Same file, but addressed from inside the ETL container. This is what goes
 * into `profiles.yml`'s `path:` field because dbt runs in the container.
 *
 * In Azure/production mode backend + ETL share the same absolute path
 * (the same mounted file share), so host and container paths are identical.
 *
 * In local dev the host warehouse is mounted at `/warehouse` in the ETL
 * container, so we rewrite any host-side path that contains `/warehouse/`
 * (or `\warehouse\` on Windows) to start at `/warehouse/`.
 */
export function dbtStatePathForEtl(tenantId: number, productSlug: string, warehouseRoot: string): string {
  if (isAzurePath(warehouseRoot) || process.env.NODE_ENV === 'production') {
    return `/warehouse/_dbt_state/tenant_${tenantId}/${productSlug}/state.duckdb`;
  }
  // Local dev: docker-compose binds ./warehouse → /warehouse in the ETL
  // container, so we always want container-absolute /warehouse/_dbt_state/...
  return `/warehouse/_dbt_state/tenant_${tenantId}/${productSlug}/state.duckdb`;
}

/**
 * Output directory (where dbt writes Parquet results) per product — HOST
 * perspective. Used by the backend for invalidation + bookkeeping.
 *
 * Anchored to the warehouse ROOT (parent of the conn_N subdir) rather than
 * `./warehouse` relative to CWD — that way backend and ETL agree on the
 * same physical location regardless of which directory the backend process
 * was launched from.
 */
function productOutputDir(warehouseRoot: string, productSlug: string): string {
  if (isAzurePath(warehouseRoot)) {
    const parts = warehouseRoot.replace(/\/conn_\d+$/, '');
    return `${parts}/products/${productSlug}`;
  }
  const warehouseRootParent = warehouseRoot.replace(/[/\\]conn_\d+$/, '');
  return path.join(warehouseRootParent, 'product', productSlug);
}

/**
 * Same location, but addressed from inside the ETL container. This is what
 * goes into `profiles.yml`'s `external_root` and each model's
 * `config(location=...)` because dbt writes these files.
 *
 * Azure/prod: backend and ETL see the same mount, paths are identical.
 * Local dev: the host ./warehouse dir is mounted at /warehouse in the ETL
 * container, so the backend's `./warehouse/product/articles` becomes
 * `/warehouse/product/articles` from dbt's perspective.
 */
function productOutputDirForEtl(warehouseRoot: string, productSlug: string): string {
  if (isAzurePath(warehouseRoot) || process.env.NODE_ENV === 'production') {
    const host = productOutputDir(warehouseRoot, productSlug);
    // In Azure the host-computed path already starts with az:// so just return it.
    return host;
  }
  // Local dev: always resolve inside the shared /warehouse mount.
  return `/warehouse/product/${productSlug}`;
}

/**
 * Backwards-compat rewriter for products whose transformation_sql predates
 * Phase 2.4 (bare sibling references rather than `{{ ref() }}` macros).
 *
 * Phase 2.4+: new AI output emits `{{ ref('dim_customer') }}` natively —
 * the regex doesn't match inside macro braces so this is a no-op on fresh
 * SQL. Retained until a migration pass re-authors all existing products.
 *
 * Matches FROM / JOIN followed by a table name. Ignores refs already inside
 * a `{{ ... }}` block (the preceding brace breaks the `FROM\s+name` match)
 * and refs with a schema dot (e.g. `main.foo`).
 */
function rewriteSqlWithRefs(sql: string, siblingModelNames: Set<string>): string {
  if (siblingModelNames.size === 0) return sql;
  // Fast path: already macro-native, nothing to rewrite.
  if (sql.includes('{{ ref(') || sql.includes('{{ref(')) return sql;
  let out = sql;
  for (const name of siblingModelNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match FROM / JOIN <name> when followed by whitespace, AS, or end-of-statement
    const pattern = new RegExp(
      `\\b(FROM|JOIN)\\s+${escaped}\\b(?!\\.)`,
      'gi',
    );
    out = out.replace(pattern, (_m, kw) => `${kw.toUpperCase()} {{ ref('${name}') }}`);
  }
  return out;
}

export async function buildDbtProject(
  product: ProductRow,
  tenantId: number,
  warehousePath: string,
): Promise<BuildResult> {
  const productSlug = slugify(product.name);
  const projectDir = dbtProjectDir(tenantId, productSlug, warehousePath);
  const modelsDir = path.join(projectDir, 'models');
  // HOST path — used only as the return value for the backend's bookkeeping.
  const outputDir = productOutputDir(warehousePath, productSlug);
  // ETL path — baked into every path dbt reads/writes (profiles.yml + model configs).
  const outputDirEtl = productOutputDirForEtl(warehousePath, productSlug);

  // ── Gather metadata ──────────────────────────────────────────────────────
  const tables: ProductTableRow[] = await tenantQuery(tenantId, (trx) =>
    trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .where('ss.data_product_id', product.id)
      .orderBy('pt.dag_order', 'asc')
      .select(
        'pt.id', 'pt.table_name', 'pt.table_role',
        'pt.load_mode', 'pt.dag_order', 'pt.transformation_sql',
      ),
  );

  const tableIds = tables.map((t) => t.id);
  const columns: ProductColumnRow[] = tableIds.length === 0
    ? []
    : await tenantQuery(tenantId, (trx) =>
        trx('product_columns')
          .whereIn('product_table_id', tableIds)
          .select('id', 'product_table_id', 'column_name', 'column_role', 'fk_target_table', 'fk_target_column'),
      );

  const ingested: IngestedTableRow[] = await tenantQuery(tenantId, (trx) =>
    trx('ingested_tables')
      .where({ connection_id: product.connection_id, status: 'done' })
      .select('table_name', 'delta_path'),
  );

  const sharedDims: SharedDimRow[] = await tenantQuery(tenantId, (trx) =>
    trx('data_product_dependencies as dpd')
      .join('data_products as dp', 'dpd.source_product_id', 'dp.id')
      .join('star_schemas as ss', 'ss.data_product_id', 'dp.id')
      .join('product_tables as pt', 'pt.star_schema_id', 'ss.id')
      .where('dpd.dependent_product_id', product.id)
      .where('pt.is_shared_dimension', true)
      .whereNotNull('pt.delta_path')
      .select(
        'pt.table_name',
        'pt.delta_path',
        'dp.name as source_product_name',
      ),
  );

  if (tables.length === 0) {
    throw new Error(`Product "${product.name}" has no tables defined — nothing to build.`);
  }

  // Incremental tables need a non-empty BK (surrogate_key or natural_key) so
  // dbt has a unique_key to merge on. Refuse loudly when this is missing —
  // a silent full-overwrite would contradict the user's explicit load_mode.
  const incrementalTables = tables.filter((t) => t.load_mode === 'incremental');
  for (const t of incrementalTables) {
    const bk = resolveBkColumnsForSchema(t.table_role, columns.filter((c) => c.product_table_id === t.id));
    if (bk.length === 0) {
      throw new Error(
        `Incremental table "${t.table_name}" has no surrogate_key or natural_key column — ` +
        `dbt needs a unique_key to merge on. Mark a key column in the UI, or switch load_mode to 'full'.`,
      );
    }
  }

  // ── Write project files ──────────────────────────────────────────────────
  const testsDir = path.join(projectDir, 'tests', 'generic');
  // Two paths for the same file:
  //   - statePathHost: what the backend uses to create the parent dir.
  //   - statePathEtl:  what goes into profiles.yml (dbt runs in the ETL container).
  // In Azure/prod they're identical; on local dev they diverge.
  const statePathHost = dbtStatePath(tenantId, productSlug, warehousePath);
  const statePathEtl  = dbtStatePathForEtl(tenantId, productSlug, warehousePath);
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });
  if (!isAzurePath(warehousePath)) {
    fs.mkdirSync(path.dirname(statePathHost), { recursive: true });
  }

  // 1. dbt_project.yml
  const dbtProjectYaml = buildDbtProjectYaml(productSlug, outputDir, ingested, sharedDims);
  fs.writeFileSync(path.join(projectDir, 'dbt_project.yml'), dbtProjectYaml);

  // 2. profiles.yml — DuckDB adapter, persistent file-backed state,
  //    external_root pointing at the product's output directory. BOTH paths
  //    must be ETL-side because dbt runs inside the ETL container.
  fs.writeFileSync(path.join(projectDir, 'profiles.yml'), buildProfilesYaml(productSlug, outputDirEtl, statePathEtl));

  // 3. Source declarations — gives dbt full lineage for source-layer + cross-product
  //    dims. The on-run-start hook mirrors the views into the matching schemas
  //    (source_layer, shared_dims) so {{ source() }} macros resolve correctly.
  fs.writeFileSync(path.join(modelsDir, 'sources.yml'), buildSourcesYaml(ingested, sharedDims));

  // 4. Generic test macros (ported from transformationChecks.ts)
  writeGenericTestMacros(testsDir);

  // 5. Schema declaration with basic tests
  const siblingNames = new Set(tables.map((t) => t.table_name));
  fs.writeFileSync(path.join(modelsDir, 'schema.yml'), buildSchemaYaml(tables, columns, siblingNames));

  // 6. One SQL file per model, with ref() rewriting and per-load-mode config.
  //    Use the ETL-side path for `location:` because dbt writes to it.
  const escapedOut = outputDirEtl.replace(/\\/g, '/');
  for (const t of tables) {
    const parquetPath = `${escapedOut}/${t.table_name}/data.parquet`;
    const body = rewriteSqlWithRefs(t.transformation_sql, siblingNames);
    const config = buildModelConfig(t, columns, parquetPath);
    fs.writeFileSync(path.join(modelsDir, `${t.table_name}.sql`), config + body + '\n');

    // dbt-duckdb's external materializer won't create the destination
    // directory — pre-create it from the host side so the first run doesn't
    // fail with "No such file or directory".
    if (!isAzurePath(warehousePath)) {
      fs.mkdirSync(path.join(outputDir, t.table_name), { recursive: true });
    }
  }

  log.info({
    projectDir, models: tables.length,
    sources: ingested.length, sharedDims: sharedDims.length,
  }, 'dbt project built');

  return {
    projectDir,
    modelCount: tables.length,
    sourceCount: ingested.length,
    outputDir,
  };
}

// ─── YAML builders ───────────────────────────────────────────────────────────

function buildDbtProjectYaml(
  productSlug: string,
  outputDir: string,
  ingested: IngestedTableRow[],
  sharedDims: SharedDimRow[],
): string {
  // on-run-start hook registers every external Delta/Parquet table as a view
  // so bare table references in AI-authored SQL resolve (compatibility shim
  // for pre-2.4 transformation_sql). Same tables ALSO get registered in
  // dedicated `source_layer` / `shared_dims` schemas so they can be accessed
  // via {{ source() }} macros — which gives dbt proper lineage + docs.
  const hookLines: string[] = [
    'INSTALL delta',
    'LOAD delta',
    'CREATE SCHEMA IF NOT EXISTS source_layer',
    'CREATE SCHEMA IF NOT EXISTS shared_dims',
  ];
  for (const it of ingested) {
    const escaped = it.delta_path.replace(/\\/g, '/').replace(/'/g, "''");
    // Main schema view (bare ref compatibility)
    hookLines.push(
      `CREATE OR REPLACE VIEW "${it.table_name}" AS SELECT * FROM delta_scan('${escaped}')`,
    );
    // source_layer schema view (for {{ source('source_layer', ...) }})
    hookLines.push(
      `CREATE OR REPLACE VIEW source_layer."${it.table_name}" AS SELECT * FROM delta_scan('${escaped}')`,
    );
  }
  for (const dim of sharedDims) {
    const escaped = dim.delta_path.replace(/\\/g, '/').replace(/'/g, "''");
    // Shared dims from dependency products are materialised as Parquet, not Delta
    hookLines.push(
      `CREATE OR REPLACE VIEW "${dim.table_name}" AS SELECT * FROM read_parquet('${escaped}/data.parquet')`,
    );
    hookLines.push(
      `CREATE OR REPLACE VIEW shared_dims."${dim.table_name}" AS SELECT * FROM read_parquet('${escaped}/data.parquet')`,
    );
  }

  // YAML-quote each SQL as a double-quoted scalar (internal " escaped). dbt
  // joins them into a single transaction.
  const hooksYaml = hookLines
    .map((s) => `    - "${s.replace(/"/g, '\\"')}"`)
    .join('\n');

  return [
    `name: '${productSlug}'`,
    `version: '${PROJECT_VERSION}'`,
    `config-version: 2`,
    `profile: '${productSlug}'`,
    ``,
    `model-paths: ["models"]`,
    `target-path: "target"`,
    `clean-targets: ["target", "dbt_packages"]`,
    ``,
    `on-run-start:`,
    hooksYaml,
    ``,
    `models:`,
    `  ${productSlug}:`,
    `    +materialized: external`,
    ``,
    // store_failures writes each failing test's rows to a table at
    // dbt_test__audit.<test_name> inside the state DB. dbtRunner queries
    // these tables after a failed test to populate sample_duplicates in
    // the transformation_checks UI.
    `tests:`,
    `  +store_failures: true`,
    `  +store_failures_as: table`,
    `  +limit: 100`,
    ``,
  ].join('\n');
}

function buildProfilesYaml(productSlug: string, outputDir: string, statePath: string): string {
  const escapedOutput = outputDir.replace(/\\/g, '/');
  const escapedState = statePath.replace(/\\/g, '/');
  // File-backed DuckDB state, persistent across runs.
  // Two invariants this path has to satisfy:
  //   1. Lives OUTSIDE `target/` — dbt_runner.clean_target wipes target/ before
  //      every run, and that would kill the incremental diff state.
  //   2. Reachable from the ETL container — backend writes this YAML, ETL
  //      reads the DB file. /warehouse is mounted on both so this works.
  return [
    `${productSlug}:`,
    `  target: dev`,
    `  outputs:`,
    `    dev:`,
    `      type: duckdb`,
    `      path: '${escapedState}'`,
    `      extensions:`,
    `        - delta`,
    `        - parquet`,
    `      external_root: '${escapedOutput}'`,
    ``,
  ].join('\n');
}

function buildSourcesYaml(
  ingested: IngestedTableRow[],
  sharedDims: SharedDimRow[],
): string {
  const blocks: string[] = [`version: 2`, ``, `sources:`];

  if (ingested.length > 0) {
    blocks.push(`  - name: source_layer`);
    blocks.push(`    schema: source_layer`);
    blocks.push(`    description: "Ingested Delta tables from the upstream connection."`);
    blocks.push(`    tables:`);
    for (const it of ingested) {
      blocks.push(`      - name: ${it.table_name}`);
    }
  }

  if (sharedDims.length > 0) {
    // Group shared dims by originating product so the lineage graph shows
    // which product owns each conformed dimension.
    const byProduct = new Map<string, SharedDimRow[]>();
    for (const d of sharedDims) {
      const arr = byProduct.get(d.source_product_name) ?? [];
      arr.push(d);
      byProduct.set(d.source_product_name, arr);
    }
    blocks.push(`  - name: shared_dims`);
    blocks.push(`    schema: shared_dims`);
    blocks.push(
      `    description: "Conformed dimensions materialised by dependency products (see meta.source_product for owner)."`,
    );
    blocks.push(`    tables:`);
    for (const [productName, dims] of byProduct) {
      for (const d of dims) {
        blocks.push(`      - name: ${d.table_name}`);
        blocks.push(`        meta:`);
        blocks.push(`          source_product: "${productName.replace(/"/g, '\\"')}"`);
      }
    }
  }

  if (ingested.length === 0 && sharedDims.length === 0) {
    // Must end up as valid YAML even with no sources declared.
    blocks.push(`  []`);
  }

  blocks.push(``);
  return blocks.join('\n');
}

function buildSchemaYaml(
  tables: ProductTableRow[],
  columns: ProductColumnRow[],
  siblingNames: Set<string>,
): string {
  const colsByTable = new Map<number, ProductColumnRow[]>();
  for (const c of columns) {
    const arr = colsByTable.get(c.product_table_id) ?? [];
    arr.push(c);
    colsByTable.set(c.product_table_id, arr);
  }

  const modelLines: string[] = [];
  for (const t of tables) {
    const tCols = colsByTable.get(t.id) ?? [];
    modelLines.push(`  - name: ${t.table_name}`);
    if (t.table_role) {
      modelLines.push(`    description: "${t.table_role.replace(/"/g, '\\"')} table"`);
    }

    // ── Model-level tests ─────────────────────────────────────────────────
    const bkCols = resolveBkColumnsForSchema(t.table_role, tCols);
    const hasJoin = /\bJOIN\b/i.test(t.transformation_sql);
    const tests = buildModelTests(bkCols, hasJoin);
    if (tests.length > 0) {
      modelLines.push(`    tests:`);
      for (const line of tests) modelLines.push(`      ${line}`);
    }

    // ── Column-level tests ────────────────────────────────────────────────
    const columnTestLines = buildColumnTests(tCols, siblingNames);
    if (columnTestLines.length > 0) {
      modelLines.push(`    columns:`);
      for (const line of columnTestLines) modelLines.push(`      ${line}`);
    }
  }

  return [
    `version: 2`,
    ``,
    `models:`,
    ...modelLines,
    ``,
  ].join('\n');
}

/**
 * Emit the `{{ config(...) }}` header for a model based on its load_mode.
 *
 * Full overwrite (default): `materialized='external'` writes directly to the
 * target Parquet file on every run.
 *
 * Incremental: `materialized='incremental'` uses dbt's native incremental
 * engine against the persistent DuckDB state file, keyed on the BK columns.
 * A post-hook then COPY-exports the merged state to Parquet so the
 * warehouse Parquet file stays the source of truth for queries.
 */
function buildModelConfig(
  table: ProductTableRow,
  allColumns: ProductColumnRow[],
  parquetPath: string,
): string {
  if (table.load_mode !== 'incremental') {
    return `{{ config(materialized='external', location='${parquetPath}') }}\n\n`;
  }

  const bkCols = resolveBkColumnsForSchema(
    table.table_role,
    allColumns.filter((c) => c.product_table_id === table.id),
  );
  // Guarded earlier in buildDbtProject — but defensive fallback: if somehow
  // no BKs, fall back to full overwrite with a comment.
  if (bkCols.length === 0) {
    return (
      `-- Incremental requested but no BK columns — falling back to full overwrite.\n` +
      `{{ config(materialized='external', location='${parquetPath}') }}\n\n`
    );
  }

  const uniqueKey =
    bkCols.length === 1
      ? `'${bkCols[0]}'`
      : `[${bkCols.map((c) => `'${c}'`).join(', ')}]`;

  // delete+insert = remove matching unique_key rows then insert the new batch.
  // Works for both single- and multi-column keys on DuckDB. Cleaner semantics
  // than 'merge' for our use case (BK-based dedup, no partial-row updates).
  return [
    `{{ config(`,
    `  materialized='incremental',`,
    `  unique_key=${uniqueKey},`,
    `  incremental_strategy='delete+insert',`,
    `  post_hook="COPY {{ this }} TO '${parquetPath}' (FORMAT PARQUET)"`,
    `) }}`,
    ``,
    ``,
  ].join('\n');
}

/** Mirror transformationChecks.resolveBkColumns for dbt test emission. */
function resolveBkColumnsForSchema(tableRole: string, cols: ProductColumnRow[]): string[] {
  if (tableRole === 'fact') {
    return cols
      .filter((c) => c.column_role === 'foreign_key' || c.column_role === 'degenerate_dimension')
      .map((c) => c.column_name);
  }
  const sk = cols.filter((c) => c.column_role === 'surrogate_key').map((c) => c.column_name);
  if (sk.length > 0) return sk;
  const nk = cols.filter((c) => c.column_role === 'natural_key').map((c) => c.column_name);
  return nk;
}

function buildModelTests(bkCols: string[], hasJoin: boolean): string[] {
  const lines: string[] = [];
  if (bkCols.length > 1) {
    // Multi-column BK uniqueness — use our custom generic test.
    lines.push(`- unique_combination_of_columns:`);
    lines.push(`    combination_of_columns:`);
    for (const c of bkCols) lines.push(`      - ${c}`);
  }
  // Fan-out check: only meaningful when the SQL has JOINs and we know the BK.
  if (hasJoin && bkCols.length > 0) {
    lines.push(`- fan_out_no_surplus:`);
    lines.push(`    bk_columns:`);
    for (const c of bkCols) lines.push(`      - ${c}`);
  }
  return lines;
}

function buildColumnTests(cols: ProductColumnRow[], siblingNames: Set<string>): string[] {
  const lines: string[] = [];
  // Single-column BK: use dbt's built-in `unique`. Keys must also be not_null.
  // For multi-column BKs we skip the per-column tests (handled at model level).
  const singleBk = cols.filter((c) => c.column_role === 'surrogate_key').length === 1
    ? cols.find((c) => c.column_role === 'surrogate_key')
    : null;

  for (const c of cols) {
    const colTests: string[] = [];

    // Key columns — tighten with not_null.
    const isKey =
      c.column_role === 'surrogate_key' ||
      c.column_role === 'natural_key' ||
      c.column_role === 'foreign_key';
    if (isKey) colTests.push(`- not_null`);

    // Single-column surrogate key gets `unique` automatically.
    if (singleBk && c.id === singleBk.id) {
      colTests.push(`- unique`);
    }

    // FK → relationships test, but only if the target is a sibling product_table.
    // Cross-connection refs and refs into source-layer Delta tables are skipped
    // because dbt's `relationships` test needs the target as a real model.
    if (
      c.column_role === 'foreign_key' &&
      c.fk_target_table &&
      c.fk_target_column &&
      siblingNames.has(c.fk_target_table)
    ) {
      colTests.push(`- relationships:`);
      colTests.push(`    to: ref('${c.fk_target_table}')`);
      colTests.push(`    field: ${c.fk_target_column}`);
    }

    // Measures get a range-outlier check.
    if (c.column_role === 'measure') {
      colTests.push(`- value_range_outlier`);
    }

    if (colTests.length === 0) continue;
    lines.push(`- name: ${c.column_name}`);
    lines.push(`  tests:`);
    for (const t of colTests) lines.push(`    ${t}`);
  }
  return lines;
}

/**
 * Write the custom generic test macros to `tests/generic/*.sql` inside the
 * project. These are ports of transformationChecks.ts so the dbt path runs
 * the same assertions the legacy runner ran.
 */
function writeGenericTestMacros(testsDir: string): void {
  fs.writeFileSync(
    path.join(testsDir, 'unique_combination_of_columns.sql'),
    UNIQUE_COMBINATION_MACRO,
  );
  fs.writeFileSync(
    path.join(testsDir, 'fan_out_no_surplus.sql'),
    FAN_OUT_MACRO,
  );
  fs.writeFileSync(
    path.join(testsDir, 'value_range_outlier.sql'),
    VALUE_RANGE_MACRO,
  );
}

// dbt generic tests: any row returned = failure. The test name matches the
// macro name minus the `test_` prefix. Comments use {# ... #} (Jinja).

const UNIQUE_COMBINATION_MACRO = `{# Ported from transformationChecks.checkBkUniqueness.
   Fails on any composite-key duplicate. #}
{% test unique_combination_of_columns(model, combination_of_columns) %}
  {% set cols = combination_of_columns | join(', ') %}
  select {{ cols }}, count(*) as n
  from {{ model }}
  group by {{ cols }}
  having count(*) > 1
{% endtest %}
`;

const FAN_OUT_MACRO = `{# Ported from transformationChecks.checkFanOut.
   Fails when total_rows > count(distinct bk), which signals JOIN-induced
   row multiplication. #}
{% test fan_out_no_surplus(model, bk_columns) %}
  {% set bk_concat %}
    {% if bk_columns | length == 1 %}
      "{{ bk_columns[0] }}"
    {% else %}
      concat_ws('|', {% for c in bk_columns %}coalesce(cast("{{ c }}" as varchar), ''){% if not loop.last %}, {% endif %}{% endfor %})
    {% endif %}
  {% endset %}
  select
    count(*) - count(distinct {{ bk_concat }}) as surplus
  from {{ model }}
  having (count(*) - count(distinct {{ bk_concat }})) > 0
{% endtest %}
`;

const VALUE_RANGE_MACRO = `{# Ported from transformationChecks.checkValueRange.
   Fails when max > 100x avg (extreme outlier) OR any negative values exist
   in a measure column. #}
{% test value_range_outlier(model, column_name) %}
  with stats as (
    select
      min("{{ column_name }}")  as min_val,
      max("{{ column_name }}")  as max_val,
      avg("{{ column_name }}")  as avg_val,
      count(case when "{{ column_name }}" < 0 then 1 end) as neg_count
    from {{ model }}
    where "{{ column_name }}" is not null
  )
  select *
  from stats
  where (avg_val <> 0 and max_val > abs(avg_val) * 100)
     or neg_count > 0
{% endtest %}
`;

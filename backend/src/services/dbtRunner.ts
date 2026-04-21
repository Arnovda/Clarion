/**
 * dbt transformation orchestrator.
 *
 * Phase 1 of the dbt migration (see docs/rfc-001-dbt-transformations.md).
 *
 * Equivalent to transformationRunner.runProductTransformation, but routes
 * execution through a generated dbt-duckdb project on the ETL service.
 *
 * Active only when USE_DBT_TRANSFORMATIONS=true; otherwise the legacy runner
 * is used. Both coexist so we can flip between them per-tenant, per-product,
 * or per-run while Phase 2 parity work proceeds.
 */

import axios from 'axios';
import path from 'path';
import { tenantQuery } from './tenantQuery';
import { buildDbtProject, dbtStatePath } from './dbtProjectBuilder';
import { DuckDBConnector } from '../connectors/DuckDBConnector';
import { trackMetric, trackEvent } from '../utils/monitoring';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'dbt-runner' });

const ETL_URL = process.env.ETL_URL || 'http://localhost:8000';

export interface DbtTransformResult {
  table_name: string;
  status: 'success' | 'error';
  row_count?: number;
  error?: string;
}

interface ProductRow {
  id: number;
  name: string;
  connection_id: number;
}

interface TableRow {
  id: number;
  table_name: string;
  dag_order: number;
}

/**
 * Map backend-resolved warehouse path (host-style) to the ETL container's
 * view. Same pattern as remapPathForDocker in routes/ingestion.ts.
 */
function remapProjectDirForEtl(projectDir: string): string {
  if (process.env.NODE_ENV === 'production') {
    // In Azure both ETL and backend mount the same Azure Files share at /warehouse
    return projectDir;
  }
  // Local dev: docker-compose maps ./warehouse → /warehouse
  const warehouseMarker = path.sep + 'warehouse' + path.sep;
  const idx = projectDir.indexOf(warehouseMarker);
  if (idx === -1) return projectDir;
  const rest = projectDir.substring(idx + warehouseMarker.length);
  return '/warehouse/' + rest.replace(/\\/g, '/');
}

export async function runProductTransformationDbt(
  product: ProductRow,
  tables: TableRow[],
  tenantId: number,
): Promise<DbtTransformResult[]> {
  const runStart = Date.now();

  const connection = await tenantQuery(tenantId, (trx) =>
    trx('connections').where({ id: product.connection_id }).first(),
  );
  const warehousePath: string | undefined = connection?.warehouse_path;
  if (!warehousePath) {
    throw new Error('Connection has no warehouse path — ingestion may not have run yet.');
  }

  // ── 1. Generate the dbt project on disk ──────────────────────────────────
  log.info({ productId: product.id, tables: tables.length }, 'building dbt project');
  const built = await buildDbtProject(product, tenantId, warehousePath);

  // Mark all target tables as 'running'
  const tableIds = tables.map((t) => t.id);
  if (tableIds.length > 0) {
    await tenantQuery(tenantId, (trx) =>
      trx('product_tables')
        .whereIn('id', tableIds)
        .update({ transformation_status: 'running', last_run_error: null }),
    );
  }

  // ── 2. Ask ETL to run `dbt run` against the project ──────────────────────
  const etlProjectDir = remapProjectDirForEtl(built.projectDir);
  log.info({ etlProjectDir }, 'calling ETL /dbt/run');

  interface DbtRunResponse {
    ok: boolean;
    returncode: number;
    stdout?: string;
    stderr?: string;
    error?: string;
    results?: Array<{
      model_name?: string;
      status?: string;
      message?: string;
      rows_affected?: number | null;
    }>;
    summary?: { total: number; success: number; failed: number };
  }

  let dbtResponse: DbtRunResponse;
  try {
    const res = await axios.post(
      `${ETL_URL}/dbt/run`,
      { project_dir: etlProjectDir, target: 'dev' },
      { timeout: 20 * 60 * 1000 },
    );
    dbtResponse = res.data as DbtRunResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'ETL /dbt/run call failed');

    // Mark every target table as errored — we never got past the launch step.
    await tenantQuery(tenantId, (trx) =>
      trx('product_tables')
        .whereIn('id', tableIds)
        .update({
          transformation_status: 'error',
          last_run_error: `dbt launch failed: ${msg}`,
          last_run_at: new Date().toISOString(),
        }),
    );
    throw new Error(`dbt launch failed: ${msg}`);
  }

  // ── 3. Map dbt's per-model results back to product_tables rows ──────────
  const modelResultByName = new Map<string, NonNullable<DbtRunResponse['results']>[number]>();
  for (const r of dbtResponse.results ?? []) {
    if (r.model_name) modelResultByName.set(r.model_name, r);
  }

  const results: DbtTransformResult[] = [];
  for (const table of tables) {
    const modelResult = modelResultByName.get(table.table_name);
    const ok = modelResult?.status === 'success';

    if (ok) {
      // Row count from adapter_response (DuckDB reports rows_affected for COPY)
      const rowCount = typeof modelResult?.rows_affected === 'number'
        ? modelResult.rows_affected
        : null;

      await tenantQuery(tenantId, (trx) =>
        trx('product_tables').where({ id: table.id }).update({
          transformation_status: 'success',
          row_count: rowCount,
          last_run_at: new Date().toISOString(),
          last_run_error: null,
          // delta_path stays whatever transformationRunner set previously; Phase 2
          // will reconcile this properly when we cut over fully.
        }),
      );
      results.push({
        table_name: table.table_name,
        status: 'success',
        row_count: rowCount ?? undefined,
      });
    } else {
      const errMsg = modelResult?.message
        ?? (dbtResponse.ok ? 'model not run' : (dbtResponse.stderr || dbtResponse.error || 'dbt run failed'));
      await tenantQuery(tenantId, (trx) =>
        trx('product_tables').where({ id: table.id }).update({
          transformation_status: 'error',
          last_run_at: new Date().toISOString(),
          last_run_error: errMsg,
        }),
      );
      results.push({ table_name: table.table_name, status: 'error', error: errMsg });
    }
  }

  // ── 4. Run dbt test — persist results to transformation_checks so the UI
  //    shows quality gate outcomes exactly as it did under the legacy runner.
  if (results.some((r) => r.status === 'success')) {
    try {
      // Pass the state file path so the ETL can enrich failing tests with
      // sample rows (store_failures config surfaces them in audit tables).
      const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const statePath = dbtStatePath(tenantId, slug, warehousePath);
      await runAndPersistDbtTests(etlProjectDir, tables, tenantId, statePath);
    } catch (testErr) {
      log.warn({ err: testErr }, 'dbt test step failed (non-fatal)');
    }
  }

  // ── 5. Invalidate DuckDB pool so subsequent product-layer queries see fresh data ──
  if (results.some((r) => r.status === 'success')) {
    try {
      await DuckDBConnector.invalidateWarehouse(warehousePath);
    } catch (invErr) {
      log.warn({ err: invErr }, 'DuckDB pool invalidation failed (non-fatal)');
    }
  }

  const durationMs = Date.now() - runStart;
  const succeeded = results.filter((r) => r.status === 'success').length;
  trackMetric('dbt_transformation_ms', durationMs, {
    productId: String(product.id),
    tables: String(tables.length),
  });
  trackEvent('dbt_transformation_complete', {
    productId: String(product.id),
    outcome: succeeded === tables.length ? 'success' : succeeded > 0 ? 'partial' : 'failure',
  }, { succeeded, total: tables.length, durationMs });

  log.info({
    productId: product.id,
    succeeded,
    total: tables.length,
    durationMs,
  }, 'dbt run complete');

  return results;
}

// ─── dbt test → transformation_checks bridge ─────────────────────────────────

interface DbtTestResult {
  unique_id?: string;
  model_name?: string;
  status?: string;   // 'pass' | 'fail' | 'error' | 'warn' | 'skipped'
  message?: string;
  execution_time?: number;
  // Populated by ETL when state_path is passed + store_failures is on.
  failure_count?: number;
  failure_samples?: Record<string, unknown>[];
}

/**
 * Map a dbt test's unique_id to (target_model, check_type) for persisting
 * into our legacy `transformation_checks` table.
 *
 * Patterns we emit from dbtProjectBuilder:
 *   - `test.<project>.unique_combination_of_columns_<model>_<cols>`      → bk_uniqueness
 *   - `test.<project>.fan_out_no_surplus_<model>_<cols>`                 → fan_out
 *   - `test.<project>.relationships_<model>_<col>__<target>`              → ref_integrity
 *   - `test.<project>.unique_<model>_<col>`                               → bk_uniqueness
 *   - `test.<project>.not_null_<model>_<col>`                             → null_check
 *   - `test.<project>.value_range_outlier_<model>_<col>`                  → value_range
 */
function parseTestUniqueId(
  uniqueId: string,
  modelNames: Set<string>,
): { model: string; checkType: string } | null {
  // unique_id format: test.<project>.<test_name>.<hash>
  // We need the <test_name> part, which includes our test type + model name.
  const parts = uniqueId.split('.');
  if (parts.length < 3 || parts[0] !== 'test') return null;
  const testName = parts[2];

  // Figure out which model is being tested by finding the longest matching
  // model name suffix. Guard against name collisions by taking longest match.
  let bestModel: string | null = null;
  for (const m of modelNames) {
    if (testName.includes(`_${m}_`) || testName.includes(`_${m}.`) || testName.endsWith(`_${m}`)) {
      if (!bestModel || m.length > bestModel.length) bestModel = m;
    }
  }
  if (!bestModel) return null;

  // Map test-name prefix to legacy check_type enum.
  let checkType = 'bk_uniqueness';
  if (testName.startsWith('fan_out_no_surplus')) checkType = 'fan_out';
  else if (testName.startsWith('relationships')) checkType = 'ref_integrity';
  else if (testName.startsWith('value_range_outlier')) checkType = 'value_range';
  else if (testName.startsWith('not_null')) checkType = 'null_check';
  // `unique` and `unique_combination_of_columns` both map to bk_uniqueness.

  return { model: bestModel, checkType };
}

async function runAndPersistDbtTests(
  etlProjectDir: string,
  tables: TableRow[],
  tenantId: number,
  statePath: string,
): Promise<void> {
  interface DbtTestResponse {
    ok: boolean;
    returncode: number;
    stdout?: string;
    stderr?: string;
    error?: string;
    results?: DbtTestResult[];
  }

  let testResponse: DbtTestResponse;
  try {
    const res = await axios.post(
      `${ETL_URL}/dbt/test`,
      { project_dir: etlProjectDir, target: 'dev', state_path: statePath },
      { timeout: 10 * 60 * 1000 },
    );
    testResponse = res.data as DbtTestResponse;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'dbt test call failed');
    return;
  }

  const modelNames = new Set(tables.map((t) => t.table_name));
  const modelByName = new Map(tables.map((t) => [t.table_name, t]));

  // Group tests by (model, check_type) so each table gets one row per check_type.
  // If ANY matching test failed the row is 'fail'; if all passed the row is 'pass'.
  interface Agg {
    tableId: number;
    checkType: string;
    status: 'pass' | 'fail' | 'error' | 'skip';
    messages: string[];
    failureCount: number;
    failureSamples: Record<string, unknown>[];
  }
  const agg = new Map<string, Agg>();

  for (const t of testResponse.results ?? []) {
    if (!t.unique_id) continue;
    const parsed = parseTestUniqueId(t.unique_id, modelNames);
    if (!parsed) continue;
    const tbl = modelByName.get(parsed.model);
    if (!tbl) continue;

    const key = `${tbl.id}:${parsed.checkType}`;
    const existing = agg.get(key);
    // dbt test statuses: 'pass', 'fail', 'error', 'warn', 'skipped'
    const rawStatus = (t.status ?? '').toLowerCase();
    const normStatus: Agg['status'] =
      rawStatus === 'pass'    ? 'pass'
      : rawStatus === 'fail'  ? 'fail'
      : rawStatus === 'error' ? 'error'
      : 'skip';

    if (!existing) {
      agg.set(key, {
        tableId: tbl.id,
        checkType: parsed.checkType,
        status: normStatus,
        messages: t.message ? [t.message] : [],
        failureCount: t.failure_count ?? 0,
        // Cap at 10 samples for UI readability — matches legacy runner.
        failureSamples: (t.failure_samples ?? []).slice(0, 10),
      });
    } else {
      // fail > error > skip > pass — keep the worst status.
      const rank: Record<Agg['status'], number> = { pass: 0, skip: 1, error: 2, fail: 3 };
      if (rank[normStatus] > rank[existing.status]) existing.status = normStatus;
      if (t.message) existing.messages.push(t.message);
      // Accumulate samples across multiple sub-tests (e.g. unique + not_null
      // both mapping to bk_uniqueness).
      if (t.failure_count) existing.failureCount += t.failure_count;
      if (t.failure_samples && existing.failureSamples.length < 10) {
        existing.failureSamples.push(
          ...t.failure_samples.slice(0, 10 - existing.failureSamples.length),
        );
      }
    }
  }

  // Persist. Replace the per-table rows instead of appending.
  const byTable = new Map<number, Agg[]>();
  for (const a of agg.values()) {
    const arr = byTable.get(a.tableId) ?? [];
    arr.push(a);
    byTable.set(a.tableId, arr);
  }

  await tenantQuery(tenantId, async (trx) => {
    for (const [tableId, rows] of byTable) {
      await trx('transformation_checks').where({ product_table_id: tableId }).del();
      for (const r of rows) {
        const passMsg = `dbt test: ${r.checkType} passed.`;
        const failMsg = r.failureCount > 0
          ? `dbt test: ${r.checkType} FAILED — ${r.failureCount} offending row(s).`
          : (r.messages.join(' | ') || `dbt test: ${r.checkType} ${r.status}.`);
        await trx('transformation_checks').insert({
          product_table_id: tableId,
          check_type: r.checkType,
          status: r.status,
          bk_columns: JSON.stringify([]),
          total_rows: 0,
          distinct_bk_rows: 0,
          duplicate_count: r.failureCount,
          sample_duplicates: JSON.stringify(r.failureSamples),
          message: r.status === 'pass' ? passMsg : failMsg,
        });
      }
    }
  });

  log.info({ tables: byTable.size, rows: agg.size }, 'dbt test results persisted');
}

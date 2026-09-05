/**
 * Transformation Runner — executes DuckDB SQL to materialize product tables
 * as Parquet files in the warehouse.
 *
 * Supports both local filesystem and Azure Blob Storage.
 * Execution order follows the DAG: dimensions (dag_order=0) first, then facts (dag_order=1).
 */

import path from 'path';
import fs from 'fs';
import { Database } from 'duckdb-async';
import { semanticDb } from '../db/knex';
import { runTransformationChecks } from './transformationChecks';
import { tenantQuery } from './tenantQuery';
import { syncProductToNeo4j } from './productGraphSync';
import { DuckDBConnector } from '../connectors/DuckDBConnector';
import { invalidateWidgetCache } from './widgetCache';
import { invalidateFilterOptionsCache } from './filterOptionsCache';
import { publishInvalidation } from '../jobs/cacheBus';
import { trackMetric, trackEvent } from '../utils/monitoring';
import { isSqlShaped } from '../utils/sqlGuard';
import {
  publishProductTable,
  publishRollup,
  publishStubFromUpstream,
  markProductTableRunning,
  markProductTableFailed,
  listProductTables,
} from './tableCatalog';
import {
  isAzurePath,
  productBasePath,
  productBasePathV2,
  productTablePath,
  productSlug,
  rollupViewName,
  sqlEscapePath,
  warehouseLayoutVersion,
  setupDuckDBForWarehouse,
  createScanView,
  writeParquet,
  ensureWarehouseContainer,
} from './warehouse';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'transformationRunner' });

interface ProductRow {
  id: number;
  name: string;
  connection_id: number;
}

interface TableRow {
  id: number;
  table_name: string;
  table_role: string;
  transformation_sql: string | null;
  dag_order: number;
  load_mode: string; // 'full' | 'incremental'
  is_shared_dimension?: boolean | null;
}

interface TransformResult {
  table_name: string;
  status: 'success' | 'error';
  row_count?: number;
  error?: string;
}

/**
 * After transformation, sync product_columns in Postgres (and Neo4j) to match
 * the actual columns materialized in the Parquet output.
 * Removes columns no longer present, adds new ones, updates data types.
 */
async function syncProductColumns(
  productTableId: number,
  actualCols: Array<{ column_name: string; column_type: string }>,
  tenantId?: number,
): Promise<void> {
  const existing = await (tenantId
    ? tenantQuery(tenantId, (trx) =>
        trx('product_columns').where({ product_table_id: productTableId })
          .select('id', 'column_name', 'data_type', 'sort_order'))
    : semanticDb('product_columns').where({ product_table_id: productTableId })
        .select('id', 'column_name', 'data_type', 'sort_order')
  ) as Array<{ id: number; column_name: string; data_type: string; sort_order: number | null }>;

  const existingMap = new Map(existing.map((c) => [c.column_name, c]));
  const actualNames = new Set(actualCols.map((c) => c.column_name));

  // Remove columns that no longer exist in output
  const toRemove = existing.filter((c) => !actualNames.has(c.column_name));
  for (const col of toRemove) {
    await (tenantId
      ? tenantQuery(tenantId, (trx) => trx('product_columns').where({ id: col.id }).del())
      : semanticDb('product_columns').where({ id: col.id }).del()
    );
  }

  // Add new columns / update data types
  for (let i = 0; i < actualCols.length; i++) {
    const ac = actualCols[i];
    const ex = existingMap.get(ac.column_name);
    if (ex) {
      // Update data type if changed
      if (ex.data_type !== ac.column_type) {
        await (tenantId
          ? tenantQuery(tenantId, (trx) =>
              trx('product_columns').where({ id: ex.id }).update({ data_type: ac.column_type }))
          : semanticDb('product_columns').where({ id: ex.id }).update({ data_type: ac.column_type })
        );
      }
    } else {
      // New column — insert with basic info
      await (tenantId
        ? tenantQuery(tenantId, (trx) =>
            trx('product_columns').insert({
              product_table_id: productTableId,
              column_name: ac.column_name,
              data_type: ac.column_type,
              display_name: ac.column_name.replace(/_/g, ' '),
              description: '',
              column_role: 'attribute',
              sort_order: i,
              ai_draft: true,
            }))
        : semanticDb('product_columns').insert({
            product_table_id: productTableId,
            column_name: ac.column_name,
            data_type: ac.column_type,
            display_name: ac.column_name.replace(/_/g, ' '),
            description: '',
            column_role: 'attribute',
            sort_order: i,
            ai_draft: true,
          })
      );
    }
  }

  if (toRemove.length > 0 || actualCols.some((ac) => !existingMap.has(ac.column_name))) {
    log.info(`Synced product_columns for table ${productTableId}: ` +
      `removed ${toRemove.length}, added ${actualCols.filter((ac) => !existingMap.has(ac.column_name)).length}`);
  }
}

// Path / Azure / view / writer primitives now live in services/warehouse/.
// Keep this file focused on transformation orchestration.

// `isSqlShaped` now lives in utils/sqlGuard.ts so the read paths (Ask AI's
// self-heal) can share one definition of "is this SQL or is it prose?".
// Re-exported here because this module's callers and tests import it.
export { isSqlShaped };

/**
 * Collect a compact text listing of every table/view currently registered in
 * the DuckDB session, with each one's columns. Used as context for the AI
 * repair pass when a transformation fails with a Binder/Catalog error.
 */
async function collectAvailableSchemas(db: Database): Promise<string> {
  // information_schema.tables covers both base tables and views.
  const rows = await db.all(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      AND NOT table_name LIKE '\\_\\_%' ESCAPE '\\'
    ORDER BY table_name
  `) as Array<{ table_name: string }>;

  const blocks: string[] = [];
  for (const r of rows) {
    try {
      const cols = await db.all(`DESCRIBE "${r.table_name}"`) as Array<{ column_name: string; column_type: string }>;
      const colList = cols.map((c) => `${c.column_name} ${c.column_type}`).join(', ');
      blocks.push(`${r.table_name}: ${colList}`);
    } catch { /* skip unreadable */ }
  }
  return blocks.join('\n');
}

// `createScanView` lives in services/warehouse/views.ts — imported above.

/**
 * Loads shared dimension Parquet files from dependency products as DuckDB views.
 * This allows fact tables to JOIN to conformed dims without rebuilding them.
 */
async function loadDependencyDimensions(
  db: Database,
  productId: number,
  productDir: string,
  useAzure: boolean,
  tenantId?: number,
): Promise<void> {
  // Find all products this product depends on
  const deps = await tenantQuery(tenantId, (trx) =>
    trx('data_product_dependencies as dpd')
      .join('data_products as dp', 'dpd.source_product_id', 'dp.id')
      .where('dpd.dependent_product_id', productId)
      .select('dpd.source_product_id', 'dp.name as source_product_name', 'dp.connection_id')
  );

  for (const dep of deps) {
    // Catalog returns OWNER rows only (is_shared_dimension=false) and
    // already includes resolved URIs — no inline path-construction needed.
    // Filter to dimensions; facts aren't conformed across products.
    const upstreamTables = await listProductTables(tenantId, dep.source_product_id as number);
    const dims = upstreamTables.filter((t) => t.tableRole === 'dimension' && !t.isStub);

    for (const dim of dims) {
      try {
        await createScanView(db, dim.tableName, dim.uri);
        log.info(`  [dep] loaded shared dim: ${dep.source_product_name}.${dim.tableName}`);
      } catch {
        log.warn(`  [dep] could not load ${dep.source_product_name}.${dim.tableName} — skipping`);
      }
    }
  }
}

/**
 * Generate a monthly pre-aggregated rollup Parquet for a fact table.
 *
 * Auto-detects: the first DATE/TIMESTAMP column becomes the time grain;
 * numeric non-PK/FK-key columns become SUMmed measures; FK _id columns
 * become GROUP BY dimensions; surrogate/natural keys are excluded entirely.
 * Writes to `<productDir>/rollup_monthly_<tableName>/data.parquet`.
 * Non-fatal: logs and returns null on any error or when no date column exists.
 */
async function generateMonthlyRollup(
  db: Database,
  tableId: number,
  tableName: string,
  parquetPath: string,
  productDir: string,
  useAzure: boolean,
  tenantId?: number,
): Promise<{ rollupName: string; rowCount: number; rollupPath: string } | null> {
  const safeAlias = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
  const descView = `__rd_${safeAlias}`;
  const escaped = parquetPath.replace(/'/g, "''");

  await db.exec(`CREATE OR REPLACE VIEW "${descView}" AS SELECT * FROM read_parquet('${escaped}');`);
  const cols = await db.all(`DESCRIBE "${descView}"`) as Array<{ column_name: string; column_type: string }>;
  await db.exec(`DROP VIEW IF EXISTS "${descView}";`);

  const DATE_TYPES = ['DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ'];
  const NUMERIC_TYPES = ['BIGINT', 'INTEGER', 'DOUBLE', 'FLOAT', 'DECIMAL', 'HUGEINT', 'UBIGINT', 'UINTEGER', 'INT4', 'INT8', 'INT2', 'TINYINT', 'SMALLINT', 'REAL', 'NUMERIC'];

  const dateCol = cols.find((c) =>
    DATE_TYPES.some((t) => c.column_type.toUpperCase().split('(')[0].trim() === t),
  );
  if (!dateCol) return null;

  // Exclude surrogate/natural key columns (PKs) from GROUP BY to ensure real aggregation.
  const pkRows = await (tenantId
    ? tenantQuery(tenantId, (trx) =>
        trx('product_columns')
          .where({ product_table_id: tableId })
          .whereIn('column_role', ['surrogate_key', 'natural_key'])
          .select('column_name'))
    : semanticDb('product_columns')
        .where({ product_table_id: tableId })
        .whereIn('column_role', ['surrogate_key', 'natural_key'])
        .select('column_name')
  ) as Array<{ column_name: string }>;
  const pkSet = new Set(pkRows.map((r) => r.column_name));

  const measures = cols.filter(
    (c) =>
      c.column_name !== dateCol.column_name &&
      !pkSet.has(c.column_name) &&
      !c.column_name.toLowerCase().endsWith('_id') &&
      !c.column_name.toLowerCase().endsWith('_key') &&
      NUMERIC_TYPES.some((t) => c.column_type.toUpperCase().startsWith(t)),
  );
  if (measures.length === 0) return null;

  // Dims: everything that is not the date col, not a PK, and not a measure
  const dims = cols.filter(
    (c) =>
      c.column_name !== dateCol.column_name &&
      !pkSet.has(c.column_name) &&
      !measures.find((m) => m.column_name === c.column_name),
  );

  const rollupName = rollupViewName(tableName);
  const rollupDir = useAzure ? null : path.join(productDir, rollupName);
  if (rollupDir) fs.mkdirSync(rollupDir, { recursive: true });

  const rollupPath = useAzure
    ? `${productDir.replace(/\\/g, '/')}/${rollupName}/data.parquet`
    : path.join(rollupDir!, 'data.parquet').replace(/\\/g, '/');

  const escapedRollup = rollupPath.replace(/'/g, "''");

  const selects = [
    `date_trunc('month', "${dateCol.column_name}") AS month`,
    ...dims.map((c) => `"${c.column_name}"`),
    ...measures.map((c) => `SUM("${c.column_name}") AS "${c.column_name}"`),
    `COUNT(*) AS _row_count`,
  ];
  const groupBy = [
    `date_trunc('month', "${dateCol.column_name}")`,
    ...dims.map((c) => `"${c.column_name}"`),
  ].join(', ');

  const rollupSelectSql = `SELECT ${selects.join(', ')} FROM read_parquet('${escaped}') GROUP BY ${groupBy} ORDER BY month`;
  await writeParquet(db, rollupPath, rollupSelectSql);

  const cnt = await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${escapedRollup}');`);
  const rowCount = Number((cnt[0] as { n: unknown }).n ?? 0);

  return { rollupName, rowCount, rollupPath };
}

/**
 * Runs transformations for a data product's tables, respecting DAG order.
 */
export async function runProductTransformation(
  product: ProductRow,
  tables: TableRow[],
  tenantId?: number,
): Promise<TransformResult[]> {
  // Feature flag: route through the new dbt-duckdb engine instead.
  // Phase 1 default: OFF. Set USE_DBT_TRANSFORMATIONS=true to opt a backend
  // instance into the dbt path for every transformation run.
  // See docs/rfc-001-dbt-transformations.md.
  if (process.env.USE_DBT_TRANSFORMATIONS === 'true' && tenantId) {
    const { runProductTransformationDbt } = await import('./dbtRunner');
    const dbtResults = await runProductTransformationDbt(product, tables, tenantId);
    // Map DbtTransformResult to the legacy TransformResult shape so callers
    // are unaffected by the engine swap.
    return dbtResults.map((r) => ({
      table_name: r.table_name,
      status: r.status,
      row_count: r.row_count,
      error: r.error,
    }));
  }

  const runStart = Date.now();
  const connection = await tenantQuery(tenantId, (trx) =>
    trx('connections').where({ id: product.connection_id }).first()
  );
  const warehousePath = connection?.warehouse_path;

  if (!warehousePath) {
    throw new Error('Connection has no warehouse path — ingestion may not have run yet');
  }

  const useAzure = isAzurePath(warehousePath);

  // Local mode: verify directory exists
  if (!useAzure) {
    const resolvedWarehouse = path.resolve(warehousePath);
    if (!fs.existsSync(resolvedWarehouse)) {
      throw new Error(`Warehouse directory not found: ${resolvedWarehouse}. Run data ingestion first.`);
    }
  }

  // Product output paths.
  //   v2 (opt-in via WAREHOUSE_LAYOUT_VERSION=v2): tenant-prefixed,
  //       id-stable layout `<root>/tenant_<tid>/product_<pid>/<table>`.
  //       Matches the source-side path pattern from SyncOrchestrator and
  //       eliminates the cross-tenant collision risk where two tenants
  //       with a product named "Sales" would share `./warehouse/product/sales`.
  //   v1 (default, legacy): `./warehouse/product/<slug>` for local;
  //       `az://<container>/products/<slug>` for Azure.
  // Mixed-state is fine: existing rows keep their old `delta_path` until
  // re-refreshed; new writes from v2 builds go to the new layout. The
  // catalog reads `delta_path` verbatim so consumers don't care.
  const layout = warehouseLayoutVersion();
  const productDir = layout === 'v2' && tenantId
    ? productBasePathV2(tenantId, product.id)
    : productBasePath(warehousePath, productSlug(product.name));

  if (!useAzure) {
    fs.mkdirSync(productDir, { recursive: true });
  } else if (tenantId) {
    // Per-tenant-container mode: make sure the tenant's Blob container exists
    // before DuckDB writes product Parquet into it. No-op in shared mode.
    await ensureWarehouseContainer(tenantId);
  }

  const sorted = [...tables].sort((a, b) => a.dag_order - b.dag_order);
  const db = await Database.create(':memory:');
  const results: TransformResult[] = [];

  try {
    await setupDuckDBForWarehouse(db, useAzure);

    // ── Register source tables in DuckDB ────────────────────────────────
    // Two distinct ingestion paths populate two different sources of truth:
    //
    //   1. Legacy ETL flow → writes to `ingested_tables` (one row per
    //      synced table) with the delta_path on disk / blob.
    //   2. Source-connector flow (ExactOnline / NetSuite / …) → DOES NOT
    //      write to `ingested_tables` (see ConnectorFactory.ts comment).
    //      Table names live on `connections.selected_entities` and the
    //      Parquet files sit at `<warehouse_path>/<entity>/data.parquet`.
    //
    // Without a fallback for path #2, source-connector products had ZERO
    // source views registered → every transformation that referenced
    // SalesInvoices / Items / etc. failed with Catalog/Binder errors →
    // AI repair tried to fix it with empty schemas → the runner persisted
    // Claude's "I cannot repair this without schemas" prose as the new
    // SQL → death spiral. Was the root cause of the corrupted
    // fact_sales_* SQL we saw in the dock.
    const ingestedTables = await tenantQuery(tenantId, (trx) =>
      trx('ingested_tables').where({ connection_id: product.connection_id, status: 'done' })
    );

    let sourceViewsRegistered = 0;
    if (ingestedTables.length > 0) {
      for (const it of ingestedTables) {
        const deltaPath = (it.delta_path as string).replace(/\\/g, '/');

        if (isAzurePath(deltaPath)) {
          // Azure: use the blob URI directly
          await createScanView(db, it.table_name, deltaPath);
        } else {
          // Local: resolve against warehouse path
          let hostPath: string;
          if (deltaPath.startsWith('/warehouse/')) {
            const tableDirName = deltaPath.split('/').pop()!;
            hostPath = path.resolve(warehousePath, tableDirName);
          } else {
            hostPath = deltaPath;
          }
          await createScanView(db, it.table_name, hostPath);
        }
        sourceViewsRegistered++;
      }
    } else {
      // Fallback for source-connector connections — same logic the
      // DuckDBConnector uses when it has to query a connector-style
      // warehouse: walk `selected_entities` and resolve each to its
      // Parquet directory under the connection's warehouse_path.
      const connRow = await tenantQuery(tenantId, (trx) =>
        trx('connections').where({ id: product.connection_id }).first(),
      );
      const selectedEntities: string[] = Array.isArray(connRow?.selected_entities)
        ? (connRow.selected_entities as string[])
        : [];
      if (selectedEntities.length > 0) {
        log.info(
          `No ingested_tables for connection ${product.connection_id} ` +
          `— falling back to ${selectedEntities.length} source-connector entit${selectedEntities.length === 1 ? 'y' : 'ies'} ` +
          `via selected_entities`,
        );
        for (const entityName of selectedEntities) {
          const entityPath = useAzure
            ? `${warehousePath}/${entityName}`
            : path.resolve(warehousePath, entityName);
          try {
            await createScanView(db, entityName, entityPath);
            sourceViewsRegistered++;
          } catch (err) {
            log.warn(
              { err },
              `failed to register ${entityName} at ${entityPath}`,
            );
          }
        }
      }
    }
    log.info(
      `Registered ${sourceViewsRegistered} source view(s) for "${product.name}"`,
    );

    // Load shared dimensions from dependency products (conformed dims)
    await loadDependencyDimensions(db, product.id, productDir, useAzure, tenantId);

    // Pre-load existing product tables
    const allProductTables = await tenantQuery(tenantId, (trx) =>
      trx('product_tables')
        .whereIn('star_schema_id', function () {
          this.select('id').from('star_schemas').where({ data_product_id: product.id });
        })
        .where('transformation_status', 'success')
    );

    log.info(`Pre-loading ${allProductTables.length} existing product tables for "${product.name}"`);
    for (const pt of allProductTables) {
      if (sorted.some((s) => s.id === pt.id)) continue;

      const ptPath = productTablePath(productDir, pt.table_name);

      // Local mode: skip directories that don't exist yet (avoids a noisy
      // DuckDB error). createScanView handles delta-vs-parquet detection.
      if (!useAzure && !fs.existsSync(ptPath)) {
        log.info(`  skip (no dir): ${pt.table_name}`);
        continue;
      }
      try {
        await createScanView(db, pt.table_name, ptPath);
        log.info(`  loaded${useAzure ? ' (azure)' : ''}: ${pt.table_name}`);
      } catch {
        log.info(`  skip: ${pt.table_name}`);
      }
    }

    // Execute each transformation in order
    for (const table of sorted) {
      // Shared/conformed dimensions live in another product. The metadata row
      // exists here as a stub (transformation_sql=null, is_shared_dimension=true)
      // and the actual parquet was loaded by loadDependencyDimensions above.
      // Skip materialization — but mark the row 'success' so the UI doesn't
      // perpetually show it as draft/stuck. ALSO copy delta_path from the
      // upstream owner so the catalog preview can read the stub's data.
      if (table.is_shared_dimension) {
        const mirrored = await publishStubFromUpstream(
          tenantId,
          table.id,
          product.id,
          table.table_name,
        );
        results.push({
          table_name: table.table_name,
          status: 'success',
          row_count: mirrored?.rowCount ?? 0,
        });
        log.info(`Skipped shared dim ${table.table_name} — points at upstream parquet`);
        continue;
      }

      const tableOutputPath = productTablePath(productDir, table.table_name);

      if (!useAzure) {
        fs.mkdirSync(tableOutputPath, { recursive: true });
      }

      await markProductTableRunning(tenantId, table.id);

      try {
        // Create views for previously materialized product tables in this run
        for (const prev of results) {
          if (prev.status === 'success') {
            const prevPath = productTablePath(productDir, prev.table_name);
            try {
              await createScanView(db, prev.table_name, prevPath);
            } catch { /* best-effort */ }
          }
        }

        // Execute the transformation SQL. If it fails with a Binder Error
        // (the AI referenced a column that doesn't exist on a dim/source),
        // do a single AI repair pass with the actual schemas of every view
        // currently registered in this DuckDB session, then retry. Persist
        // the repaired SQL so subsequent runs use the fixed version.
        let sql = table.transformation_sql;
        let aiRepaired = false;
        const tempTable = `__temp_${table.table_name}`;

        // Guard: missing/empty transformation_sql produces "AS null;" which
        // DuckDB parses as a syntax error. Fail clearly instead so the user
        // knows to author the SQL or re-run schema design.
        if (!sql || typeof sql !== 'string' || sql.trim() === '') {
          throw new Error(
            `No transformation SQL defined for ${table.table_name}. ` +
            `Open the data product, edit this table, and add the SELECT that builds it ` +
            `(or re-run "Design star schema" to let the AI regenerate it).`,
          );
        }
        // Detect prose-where-SQL-should-be early so we can regenerate from
        // scratch instead of feeding apology text to the parser → repair
        // loop, which historically just kept overwriting bad SQL with
        // worse prose. A real transformation always starts with SELECT,
        // WITH, or an opening parenthesis.
        if (!isSqlShaped(sql)) {
          log.warn(`${table.table_name} has non-SQL transformation_sql — regenerating from scratch.`);
          const schemasText = await collectAvailableSchemas(db);
          if (!schemasText) {
            throw new Error(
              `transformation_sql for "${table.table_name}" is not valid SQL ` +
              `(it looks like LLM commentary). The AI repair pass needs ` +
              `the available schemas to regenerate it, but none are loaded ` +
              `for this run. Re-run "Prepare my data" or edit the SQL by hand.`,
            );
          }
          try {
            const { generateTransformationFromScratch } = await import('../ai/AIService');
            const fresh = await generateTransformationFromScratch(
              table.table_name, table.table_role, schemasText,
            );
            if (!fresh || !isSqlShaped(fresh)) {
              throw new Error(
                `Could not regenerate transformation_sql for "${table.table_name}" ` +
                `— AI returned non-SQL. The stored value is corrupted; ` +
                `please rebuild this product.`,
              );
            }
            sql = fresh;
            aiRepaired = true;
            // Persist immediately so subsequent retries don't re-trigger this
            // (which would burn AI tokens for the same fix every time).
            await tenantQuery(tenantId, (trx) =>
              trx('product_tables').where({ id: table.id }).update({ transformation_sql: sql }),
            );
            log.info(`${table.table_name} regenerated from scratch — persisted`);
          } catch (regenErr) {
            // If we can't reach Claude (credits, network, etc.) we don't
            // want every refresh to keep trying forever. Throw a clean
            // user-facing message and let the dock surface it; the user
            // can either top up credits, edit the SQL, or rebuild the
            // product. The next refresh will hit the same shape check
            // but produce the same clear message — no token burn.
            const { AiCreditExhaustedError } = await import('../ai/AIService');
            if (regenErr instanceof AiCreditExhaustedError) {
              throw new Error(
                `transformation_sql for "${table.table_name}" is not valid SQL ` +
                `and AI auto-repair is unavailable (Anthropic credits exhausted). ` +
                `Top up credits in the Anthropic console, or rebuild this product, ` +
                `or edit the SQL manually in /products.`,
              );
            }
            throw regenErr;
          }
        }

        try {
          await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${sql};`);
        } catch (firstErr) {
          const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          // Extended from Binder/Catalog only → also catches Parser/syntax
          // errors. Real-world cause: occasionally the LLM leaks reasoning
          // text into the transformation_sql field (e.g. "I need to check
          // what tables are available..." instead of a SELECT). Without a
          // repair attempt, every subsequent run hits the same parse error
          // forever. The repair pass writes proper SQL from scratch using
          // the live schema.
          const isRepairable =
            /Binder Error|Catalog Error|Referenced column|does not have a column|Parser Error|syntax error/i
              .test(errMsg);
          if (!isRepairable) throw firstErr;

          log.warn(`${table.table_name} failed (${errMsg.slice(0, 160)}) — attempting AI repair`);
          const schemasText = await collectAvailableSchemas(db);
          const { repairTransformationSql, AiCreditExhaustedError } = await import('../ai/AIService');
          let repaired: string;
          try {
            repaired = await repairTransformationSql(
              table.table_name,
              table.table_role,
              sql,
              errMsg,
              schemasText,
            );
          } catch (repairErr) {
            if (repairErr instanceof AiCreditExhaustedError) {
              throw new Error(
                `${table.table_name} failed and AI auto-repair is unavailable ` +
                `(Anthropic credits exhausted). Original error: ${errMsg.slice(0, 240)}`,
              );
            }
            throw repairErr;
          }
          if (!repaired || repaired.trim() === sql.trim()) {
            throw firstErr; // repair produced nothing useful
          }
          // Reject AI apology prose ("I cannot repair…", "Since no available
          // schemas…") — without this gate the runner would persist that
          // text as the new transformation_sql, and every subsequent run
          // would feed Claude its own apology and get worse output. The
          // higher-level shape check is the single source of truth.
          if (!isSqlShaped(repaired)) {
            log.warn(`${table.table_name} AI repair returned non-SQL — rejecting`);
            throw firstErr;
          }
          sql = repaired;
          aiRepaired = true;
          await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
          await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${sql};`);
          log.info(`${table.table_name} repaired by AI — retry succeeded`);
        }

        const rowResult = await db.all(`SELECT COUNT(*) AS cnt FROM ${tempTable}`);
        let rowCount = Number((rowResult[0] as { cnt: number | bigint })?.cnt ?? 0);

        if (aiRepaired) {
          await tenantQuery(tenantId, (trx) =>
            trx('product_tables').where({ id: table.id }).update({ transformation_sql: sql }),
          );
        }

        try {
          await runTransformationChecks(db, tempTable, table.id, table.table_role, table.transformation_sql, tenantId);
        } catch (checkErr) {
          log.warn({ err: checkErr }, `Quality checks failed for ${table.table_name}`);
        }

        // Write output
        const parquetPath = useAzure
          ? `${tableOutputPath}/data.parquet`
          : path.join(tableOutputPath, 'data.parquet').replace(/\\/g, '/');
        const escapedPath = parquetPath.replace(/'/g, "''");

        const existingParquet = useAzure
          ? false  // Azure: always overwrite for now (incremental merge on blob needs read-back)
          : fs.existsSync(path.join(tableOutputPath, 'data.parquet'));

        // Feature-flagged Delta write path. Routes through the Python
        // sidecar which computes row_hash + change counts + writes Delta.
        // Replaces the parquet write entirely when STORAGE_FORMAT=delta_v1.
        // Same code path for dim and fact (per user spec: facts overwrite
        // each refresh too, change counts tracked for the chart).
        const { isDeltaStorageEnabled, writeDeltaWithSidecar, isSidecarReachable } = await import('./warehouse/deltaWriter');
        if (isDeltaStorageEnabled()) {
          // Fast-fail check — the sidecar is a separate Python process
          // and a missing script / missing python3 should surface here
          // (before we run the AI-generated SQL into a tmp parquet) not
          // 30 seconds later when spawn fails. Same error class either
          // way; this just turns a deferred failure into an immediate one.
          if (!isSidecarReachable()) {
            throw new Error(
              'Delta storage is enabled (default) but the Python sidecar script is not reachable. ' +
              'Check SCD2_SIDECAR_PATH (defaults to <repo>/etl/scd2/commit_table.py), ' +
              'or set STORAGE_FORMAT=parquet to opt out of Delta storage.',
            );
          }
          // Pull business-key columns (for diffing) + all column names (for
          // hashing) in one round-trip.
          const cols = await tenantQuery(tenantId, (trx) =>
            trx('product_columns')
              .where({ product_table_id: table.id })
              .select('column_name', 'column_role'),
          ) as Array<{ column_name: string; column_role: string | null }>;
          const businessKeyColumns = cols
            .filter((c) => c.column_role === 'surrogate_key' || c.column_role === 'natural_key')
            .map((c) => c.column_name);
          const businessColumns = cols.map((c) => c.column_name);

          // The Delta path writes directly at `tableOutputPath` (the dim's
          // directory). No `data.parquet` suffix — Delta owns the directory
          // layout (`_delta_log/` + parquet data files inside).
          await writeDeltaWithSidecar({
            db,
            deltaUri: tableOutputPath,
            selectSql: `SELECT * FROM ${tempTable}`,
            productTableId: table.id,
            tenantId,
            businessKeyColumns,
            businessColumns,
          });

          await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
          await publishProductTable(tenantId, table.id, tableOutputPath, rowCount);

          // Sync product_columns from the same DESCRIBE we'd have done on
          // parquet — uses the existing scan view machinery to read the
          // freshly-written Delta.
          try {
            const descView = `__desc_${table.table_name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            await createScanView(db, descView, tableOutputPath);
            const actualCols = await db.all(`DESCRIBE "${descView}"`) as Array<{ column_name: string; column_type: string }>;
            await db.exec(`DROP VIEW IF EXISTS "${descView}";`);
            // Filter out the technical _row_hash column before sync — it's
            // an implementation detail, never a business column.
            const businessCols = actualCols.filter((c) => c.column_name !== '_row_hash');
            await syncProductColumns(table.id, businessCols, tenantId);
          } catch (syncErr) {
            log.warn({ err: syncErr }, `Column sync failed for ${table.table_name}`);
          }

          results.push({ table_name: table.table_name, status: 'success', row_count: rowCount });

          // Monthly rollup is intentionally skipped on the Delta path —
          // generateMonthlyRollup() reads via DuckDB read_parquet() which
          // doesn't understand Delta directory layouts. Rollups are
          // best-effort (dashboards fall back to raw fact scans), so we
          // leave them off until the rollup helper is generalised to read
          // through the shared createScanView. Tracked in the SCD2 backlog.
          continue;  // Skip the legacy parquet branch entirely
        }

        if (table.load_mode === 'incremental' && existingParquet && !useAzure) {
          // Incremental (local only for now)
          const bkCols = await tenantQuery(tenantId, (trx) =>
            trx('product_columns')
              .where({ product_table_id: table.id })
              .whereIn('column_role', ['surrogate_key', 'natural_key'])
              .select('column_name')
          );

          if (bkCols.length > 0) {
            await db.exec(`CREATE OR REPLACE TABLE __existing AS SELECT * FROM read_parquet('${escapedPath}');`);
            const bkList = bkCols.map((c: { column_name: string }) => `"${c.column_name}"`).join(', ');
            await db.exec(`
              CREATE OR REPLACE TABLE __merged AS
              WITH combined AS (
                SELECT *, 1 AS __src_priority FROM ${tempTable}
                UNION ALL
                SELECT *, 2 AS __src_priority FROM __existing
              ),
              ranked AS (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY ${bkList} ORDER BY __src_priority) AS __rn
                FROM combined
              )
              SELECT * EXCLUDE (__src_priority, __rn) FROM ranked WHERE __rn = 1;
            `);
            await db.exec(`DROP TABLE IF EXISTS __existing;`);
            await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
            await writeParquet(db, parquetPath, 'SELECT * FROM __merged');
            const mergedCount = await db.all('SELECT COUNT(*) AS cnt FROM __merged');
            rowCount = Number(mergedCount[0]?.cnt ?? rowCount);
            await db.exec(`DROP TABLE IF EXISTS __merged;`);
          } else {
            await db.exec(`CREATE OR REPLACE TABLE __existing AS SELECT * FROM read_parquet('${escapedPath}');`);
            await db.exec(`INSERT INTO __existing SELECT * FROM ${tempTable};`);
            const totalCount = await db.all('SELECT COUNT(*) AS cnt FROM __existing');
            rowCount = Number(totalCount[0]?.cnt ?? rowCount);
            await writeParquet(db, parquetPath, 'SELECT * FROM __existing');
            await db.exec(`DROP TABLE IF EXISTS __existing;`);
            await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
          }
        } else {
          // Full overwrite — writeParquet handles the Azure staging dance
          // internally so callers don't need to branch.
          await writeParquet(db, parquetPath, `SELECT * FROM ${tempTable}`);
          await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
        }

        await publishProductTable(tenantId, table.id, tableOutputPath, rowCount);

        // Sync product_columns to match actual materialized output
        try {
          const descView = `__desc_${table.table_name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          await db.exec(`CREATE OR REPLACE VIEW "${descView}" AS SELECT * FROM read_parquet('${escapedPath}');`);
          const actualCols = await db.all(`DESCRIBE "${descView}"`) as Array<{ column_name: string; column_type: string }>;
          await db.exec(`DROP VIEW IF EXISTS "${descView}";`);
          await syncProductColumns(table.id, actualCols, tenantId);
        } catch (syncErr) {
          log.warn({ err: syncErr }, `Column sync failed for ${table.table_name}`);
        }

        results.push({ table_name: table.table_name, status: 'success', row_count: rowCount });

        // Generate monthly rollup for fact tables — best-effort, non-fatal.
        // The location is RECORDED, not just logged: productContext reads it
        // back to tell the model a pre-aggregation exists. Cleared when this
        // refresh produced none, so a table that stops qualifying (date column
        // dropped, measures removed) does not keep advertising a stale rollup.
        if (table.table_role === 'fact') {
          try {
            const rollup = await generateMonthlyRollup(db, table.id, table.table_name, parquetPath, productDir, useAzure, tenantId);
            await publishRollup(tenantId, table.id, rollup && { uri: rollup.rollupPath, rowCount: rollup.rowCount });
            if (rollup) {
              log.info(`Rollup: ${rollup.rollupName} (${rollup.rowCount} rows) at ${rollup.rollupPath}`);
            }
          } catch (rollupErr) {
            log.warn({ err: rollupErr }, `Rollup generation skipped for ${table.table_name}`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await markProductTableFailed(tenantId, table.id, msg);
        results.push({ table_name: table.table_name, status: 'error', error: msg });
      }
    }
  } finally {
    await db.close();
  }

  // Sync updated product_columns to Neo4j (once after all tables)
  if (results.some((r) => r.status === 'success')) {
    try {
      await syncProductToNeo4j(product.id, tenantId);
    } catch (neo4jErr) {
      log.warn({ err: neo4jErr }, `Neo4j product sync failed (non-fatal)`);
    }

    // Invalidate pooled DuckDB instances so subsequent queries see fresh tables.
    try {
      await DuckDBConnector.invalidateWarehouse(warehousePath);
    } catch (invErr) {
      log.warn({ err: invErr }, `DuckDB pool invalidation failed (non-fatal)`);
    }

    // Pre-warm the pool so the first post-transformation dashboard request
    // doesn't pay the view-registration cost (~500ms on a cold pool).
    const warmConn = new DuckDBConnector(warehousePath);
    warmConn.connect()
      .then(() => { warmConn.disconnect(); })
      .catch((err) => log.warn({ err }, 'DuckDB pool warm-up failed (non-fatal)'));

    // Bust the widget result cache + filter dropdown options cache so
    // stale rows / stale dropdowns aren't served from memory. Both
    // cache-bust on the same trigger because new data may add new
    // dimension values AND make old aggregates stale.
    if (tenantId) {
      invalidateWidgetCache(tenantId);
      invalidateFilterOptionsCache(tenantId);
    }

    // Broadcast the same invalidation to other processes. When this runs in the
    // jobs-worker container the three clears above only affect the worker's own
    // (unused) caches — the API container would keep serving pre-refresh widget
    // rows, stale filter dropdowns, and pooled DuckDB sessions whose registered
    // views still point at the old file set. No-op without Redis.
    publishInvalidation({ tenantId: tenantId ?? undefined, warehousePath });
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  trackMetric('transformation_ms', Date.now() - runStart, {
    productId: String(product.id),
    tables: String(tables.length),
  });
  trackEvent('transformation_complete', {
    productId: String(product.id),
    outcome: successCount === tables.length ? 'success' : successCount > 0 ? 'partial' : 'failure',
  }, { succeeded: successCount, total: tables.length });

  return results;
}

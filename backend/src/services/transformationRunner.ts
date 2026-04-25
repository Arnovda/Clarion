/**
 * Transformation Runner — executes DuckDB SQL to materialize product tables
 * as Parquet files in the warehouse.
 *
 * Supports both local filesystem and Azure Blob Storage.
 * Execution order follows the DAG: dimensions (dag_order=0) first, then facts (dag_order=1).
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Database } from 'duckdb-async';
import { semanticDb } from '../db/knex';
import { runTransformationChecks } from './transformationChecks';
import { tenantQuery } from './tenantQuery';
import { syncProductToNeo4j } from './productGraphSync';
import { DuckDBConnector } from '../connectors/DuckDBConnector';
import { invalidateWidgetCache } from './widgetCache';
import { trackMetric, trackEvent } from '../utils/monitoring';

interface ProductRow {
  id: number;
  name: string;
  connection_id: number;
}

interface TableRow {
  id: number;
  table_name: string;
  table_role: string;
  transformation_sql: string;
  dag_order: number;
  load_mode: string; // 'full' | 'incremental'
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
    console.log(`[transformationRunner] Synced product_columns for table ${productTableId}: ` +
      `removed ${toRemove.length}, added ${actualCols.filter((ac) => !existingMap.has(ac.column_name)).length}`);
  }
}

/** Check if a path is an Azure Blob URI. */
function isAzurePath(p: string): boolean {
  return p.startsWith('az://') || p.startsWith('abfss://');
}

/** Set up Azure credentials in a DuckDB session. */
async function setupAzure(db: Database): Promise<void> {
  await db.exec('INSTALL azure; LOAD azure;');
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
  if (connStr) {
    const escaped = connStr.replace(/'/g, "''");
    await db.exec(`
      CREATE SECRET azure_secret (
        TYPE AZURE,
        PROVIDER config,
        CONNECTION_STRING '${escaped}'
      );
    `);
  }
  try {
    const ver = await db.all(
      `SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'azure'`,
    );
    console.log(`[transformationRunner] azure ext: ${JSON.stringify(ver)}`);
  } catch { /* non-fatal */ }
}

/** Parse an Azure Blob URI like `az://<container>/<path>` into parts. */
function parseAzurePath(azPath: string): { container: string; blob: string } {
  const match = azPath.match(/^az:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid Azure path: ${azPath}`);
  return { container: match[1], blob: match[2] };
}

/**
 * Write the result of a SELECT to Azure Blob Storage as Parquet.
 *
 * DuckDB's azure extension (v1.4) returns "Writing to Azure containers is
 * currently not supported" on COPY TO az://... — so we stage Parquet to a
 * local temp file and upload via @azure/storage-blob.
 */
async function writeParquetToAzure(
  db: Database,
  selectSql: string,
  azurePath: string,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbridge-pq-'));
  const tmpFile = path.join(tmpDir, 'data.parquet').replace(/\\/g, '/');
  const escaped = tmpFile.replace(/'/g, "''");
  try {
    await db.exec(`COPY (${selectSql}) TO '${escaped}' (FORMAT PARQUET);`);

    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING not set');

    const { container, blob } = parseAzurePath(azurePath);
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const svc = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = svc.getContainerClient(container);
    await containerClient.createIfNotExists();
    const blobClient = containerClient.getBlockBlobClient(blob);
    await blobClient.uploadFile(tmpFile);
    console.log(`[transformationRunner] uploaded parquet → ${azurePath}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Build the product output directory/URI for a product. */
function productBasePath(warehousePath: string, productSlug: string): string {
  if (isAzurePath(warehousePath)) {
    // az://warehouse/tenant_1/conn_4 → az://warehouse/tenant_1/products/my_product
    const parts = warehousePath.replace(/\/conn_\d+$/, '');
    return `${parts}/products/${productSlug}`;
  }
  return path.resolve('./warehouse/product', productSlug);
}

/** Build the path for a specific product table. */
function productTablePath(productDir: string, tableName: string): string {
  if (isAzurePath(productDir)) {
    return `${productDir}/${tableName}`;
  }
  return path.join(productDir, tableName);
}

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

/** Create a delta_scan or read_parquet view, handling both local and Azure paths. */
async function createScanView(db: Database, viewName: string, scanPath: string, useAzure: boolean): Promise<void> {
  const escaped = scanPath.replace(/'/g, "''");
  // Always try delta_scan first (ingested tables are Delta format)
  let deltaErr: unknown;
  try {
    await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM delta_scan('${escaped}');`);
    return;
  } catch (e) {
    deltaErr = e;
    // Fall through to parquet
  }

  // Product tables are written as <dir>/data.parquet; try that first (works
  // for both local and Azure — the azure extension supports parquet reads).
  try {
    await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${escaped}/data.parquet');`);
    return;
  } catch { /* skip */ }

  // Glob fallback (local only — azure ext doesn't support globs reliably).
  if (!useAzure) {
    try {
      await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${escaped}/*.parquet');`);
      return;
    } catch { /* skip */ }
  }

  // Single-file fallback (path might already point at a .parquet file).
  try {
    await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${escaped}');`);
    return;
  } catch (parquetErr) {
    const dMsg = deltaErr instanceof Error ? deltaErr.message : String(deltaErr);
    const pMsg = parquetErr instanceof Error ? parquetErr.message : String(parquetErr);
    console.warn(`[transformationRunner] createScanView("${viewName}") failed — path=${scanPath} delta=${dMsg} parquet=${pMsg}`);
  }
}

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
    // Find the shared dimension tables in the source product
    const sharedTables = await tenantQuery(tenantId, (trx) =>
      trx('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': dep.source_product_id, 'pt.is_shared_dimension': true })
        .select('pt.table_name', 'pt.delta_path')
    );

    const sourceConn = await tenantQuery(tenantId, (trx) =>
      trx('connections').where({ id: dep.connection_id }).first()
    );
    const sourceWarehouse = sourceConn?.warehouse_path;
    if (!sourceWarehouse) continue;

    const sourceSlug = (dep.source_product_name as string).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const sourceProductDir = productBasePath(sourceWarehouse, sourceSlug);

    for (const tbl of sharedTables) {
      const tblPath = (tbl.delta_path as string) || productTablePath(sourceProductDir, tbl.table_name as string);
      try {
        await createScanView(db, tbl.table_name as string, useAzure ? tblPath : tblPath.replace(/\\/g, '/'), useAzure);
        console.log(`  [dep] loaded shared dim: ${dep.source_product_name}.${tbl.table_name}`);
      } catch {
        console.warn(`  [dep] could not load ${dep.source_product_name}.${tbl.table_name} — skipping`);
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
): Promise<{ rollupName: string; rowCount: number } | null> {
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

  const rollupName = `rollup_monthly_${tableName}`;
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
  if (useAzure) {
    await writeParquetToAzure(db, rollupSelectSql, rollupPath);
  } else {
    await db.exec(`COPY (${rollupSelectSql}) TO '${escapedRollup}' (FORMAT PARQUET);`);
  }

  const cnt = await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${escapedRollup}');`);
  const rowCount = Number((cnt[0] as { n: unknown }).n ?? 0);

  return { rollupName, rowCount };
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

  // Product output paths
  const productSlug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const productDir = productBasePath(warehousePath, productSlug);

  if (!useAzure) {
    fs.mkdirSync(productDir, { recursive: true });
  }

  const sorted = [...tables].sort((a, b) => a.dag_order - b.dag_order);
  const db = await Database.create(':memory:');
  const results: TransformResult[] = [];

  try {
    await db.exec('INSTALL delta; LOAD delta;');

    if (useAzure) {
      await setupAzure(db);
    }

    // Create views for raw source tables (from ingestion)
    const ingestedTables = await tenantQuery(tenantId, (trx) =>
      trx('ingested_tables').where({ connection_id: product.connection_id, status: 'done' })
    );

    for (const it of ingestedTables) {
      const deltaPath = (it.delta_path as string).replace(/\\/g, '/');

      if (isAzurePath(deltaPath)) {
        // Azure: use the blob URI directly
        await createScanView(db, it.table_name, deltaPath, true);
      } else {
        // Local: resolve against warehouse path
        let hostPath: string;
        if (deltaPath.startsWith('/warehouse/')) {
          const tableDirName = deltaPath.split('/').pop()!;
          hostPath = path.resolve(warehousePath, tableDirName);
        } else {
          hostPath = deltaPath;
        }
        await createScanView(db, it.table_name, hostPath.replace(/\\/g, '/'), false);
      }
    }

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

    console.log(`[transformationRunner] Pre-loading ${allProductTables.length} existing product tables for "${product.name}"`);
    for (const pt of allProductTables) {
      if (sorted.some((s) => s.id === pt.id)) continue;

      const ptPath = productTablePath(productDir, pt.table_name);

      if (useAzure) {
        try {
          await createScanView(db, pt.table_name, ptPath, true);
          console.log(`  loaded (azure): ${pt.table_name}`);
        } catch { console.log(`  skip: ${pt.table_name}`); }
      } else {
        const localDir = ptPath.replace(/\\/g, '/');
        if (!fs.existsSync(ptPath)) { console.log(`  skip (no dir): ${pt.table_name}`); continue; }
        try {
          await createScanView(db, pt.table_name, localDir, false);
          console.log(`  loaded: ${pt.table_name}`);
        } catch { console.log(`  skip: ${pt.table_name}`); }
      }
    }

    // Execute each transformation in order
    for (const table of sorted) {
      const tableOutputPath = productTablePath(productDir, table.table_name);

      if (!useAzure) {
        fs.mkdirSync(tableOutputPath, { recursive: true });
      }

      await tenantQuery(tenantId, (trx) =>
        trx('product_tables').where({ id: table.id }).update({
          transformation_status: 'running',
          last_run_error: null,
        })
      );

      try {
        // Create views for previously materialized product tables in this run
        for (const prev of results) {
          if (prev.status === 'success') {
            const prevPath = productTablePath(productDir, prev.table_name);
            try {
              await createScanView(db, prev.table_name, useAzure ? prevPath : prevPath.replace(/\\/g, '/'), useAzure);
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

        try {
          await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${sql};`);
        } catch (firstErr) {
          const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          const isBinder = /Binder Error|Catalog Error|Referenced column|does not have a column/i.test(errMsg);
          if (!isBinder) throw firstErr;

          console.warn(`[transformationRunner] ${table.table_name} failed (${errMsg.slice(0, 160)}) — attempting AI repair`);
          const schemasText = await collectAvailableSchemas(db);
          const { repairTransformationSql } = await import('../ai/AIService');
          const repaired = await repairTransformationSql(
            table.table_name,
            table.table_role,
            sql,
            errMsg,
            schemasText,
          );
          if (!repaired || repaired.trim() === sql.trim()) {
            throw firstErr; // repair produced nothing useful
          }
          sql = repaired;
          aiRepaired = true;
          await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
          await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${sql};`);
          console.log(`[transformationRunner] ${table.table_name} repaired by AI — retry succeeded`);
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
          console.warn(`[transformationRunner] Quality checks failed for ${table.table_name}:`, checkErr);
        }

        // Write output
        const parquetPath = useAzure
          ? `${tableOutputPath}/data.parquet`
          : path.join(tableOutputPath, 'data.parquet').replace(/\\/g, '/');
        const escapedPath = parquetPath.replace(/'/g, "''");

        const existingParquet = useAzure
          ? false  // Azure: always overwrite for now (incremental merge on blob needs read-back)
          : fs.existsSync(path.join(tableOutputPath, 'data.parquet'));

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
            await db.exec(`COPY __merged TO '${escapedPath}' (FORMAT PARQUET);`);
            const mergedCount = await db.all('SELECT COUNT(*) AS cnt FROM __merged');
            rowCount = Number(mergedCount[0]?.cnt ?? rowCount);
            await db.exec(`DROP TABLE IF EXISTS __merged;`);
          } else {
            await db.exec(`CREATE OR REPLACE TABLE __existing AS SELECT * FROM read_parquet('${escapedPath}');`);
            await db.exec(`INSERT INTO __existing SELECT * FROM ${tempTable};`);
            const totalCount = await db.all('SELECT COUNT(*) AS cnt FROM __existing');
            rowCount = Number(totalCount[0]?.cnt ?? rowCount);
            await db.exec(`COPY __existing TO '${escapedPath}' (FORMAT PARQUET);`);
            await db.exec(`DROP TABLE IF EXISTS __existing;`);
            await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
          }
        } else {
          // Full overwrite — Azure requires staging-then-upload (DuckDB azure
          // ext can't COPY TO az://); local writes stay direct.
          if (useAzure) {
            await writeParquetToAzure(db, `SELECT * FROM ${tempTable}`, parquetPath);
          } else {
            await db.exec(`COPY ${tempTable} TO '${escapedPath}' (FORMAT PARQUET);`);
          }
          await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
        }

        await tenantQuery(tenantId, (trx) =>
          trx('product_tables').where({ id: table.id }).update({
            transformation_status: 'success',
            delta_path: tableOutputPath,
            row_count: rowCount,
            last_run_at: new Date().toISOString(),
            last_run_error: null,
          })
        );

        // Sync product_columns to match actual materialized output
        try {
          const descView = `__desc_${table.table_name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          await db.exec(`CREATE OR REPLACE VIEW "${descView}" AS SELECT * FROM read_parquet('${escapedPath}');`);
          const actualCols = await db.all(`DESCRIBE "${descView}"`) as Array<{ column_name: string; column_type: string }>;
          await db.exec(`DROP VIEW IF EXISTS "${descView}";`);
          await syncProductColumns(table.id, actualCols, tenantId);
        } catch (syncErr) {
          console.warn(`[transformationRunner] Column sync failed for ${table.table_name}:`, syncErr);
        }

        results.push({ table_name: table.table_name, status: 'success', row_count: rowCount });

        // Generate monthly rollup for fact tables — best-effort, non-fatal
        if (table.table_role === 'fact') {
          try {
            const rollup = await generateMonthlyRollup(db, table.id, table.table_name, parquetPath, productDir, useAzure, tenantId);
            if (rollup) {
              console.log(`[transformationRunner] Rollup: ${rollup.rollupName} (${rollup.rowCount} rows)`);
            }
          } catch (rollupErr) {
            console.warn(`[transformationRunner] Rollup generation skipped for ${table.table_name}:`, rollupErr);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await tenantQuery(tenantId, (trx) =>
          trx('product_tables').where({ id: table.id }).update({
            transformation_status: 'error',
            last_run_at: new Date().toISOString(),
            last_run_error: msg,
          })
        );
        results.push({ table_name: table.table_name, status: 'error', error: msg });
      }
    }
  } finally {
    await db.close();
  }

  // Sync updated product_columns to Neo4j (once after all tables)
  if (results.some((r) => r.status === 'success')) {
    try {
      await syncProductToNeo4j(product.id);
    } catch (neo4jErr) {
      console.warn(`[transformationRunner] Neo4j product sync failed (non-fatal):`, neo4jErr);
    }

    // Invalidate pooled DuckDB instances so subsequent queries see fresh tables.
    try {
      await DuckDBConnector.invalidateWarehouse(warehousePath);
    } catch (invErr) {
      console.warn(`[transformationRunner] DuckDB pool invalidation failed (non-fatal):`, invErr);
    }

    // Pre-warm the pool so the first post-transformation dashboard request
    // doesn't pay the view-registration cost (~500ms on a cold pool).
    const warmConn = new DuckDBConnector(warehousePath);
    warmConn.connect()
      .then(() => { warmConn.disconnect(); })
      .catch((err) => console.warn('[transformationRunner] DuckDB pool warm-up failed (non-fatal):', err));

    // Bust the widget result cache so stale rows aren't served from memory.
    if (tenantId) {
      invalidateWidgetCache(tenantId);
    }
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

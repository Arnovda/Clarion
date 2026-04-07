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
        CONNECTION_STRING '${escaped}'
      );
    `);
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

/** Create a delta_scan or read_parquet view, handling both local and Azure paths. */
async function createScanView(db: Database, viewName: string, scanPath: string, useAzure: boolean): Promise<void> {
  const escaped = scanPath.replace(/'/g, "''");
  // Always try delta_scan first (ingested tables are Delta format)
  try {
    await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM delta_scan('${escaped}');`);
    return;
  } catch {
    // Fall through to parquet
  }

  if (!useAzure) {
    // Local: try parquet glob
    try {
      await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${escaped}/*.parquet');`);
      return;
    } catch { /* skip */ }
    // Try single file
    try {
      await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${escaped}');`);
    } catch { /* skip */ }
  }
}

/**
 * Runs transformations for a data product's tables, respecting DAG order.
 */
export async function runProductTransformation(
  product: ProductRow,
  tables: TableRow[],
  tenantId?: number,
): Promise<TransformResult[]> {
  const connection = await semanticDb('connections').where({ id: product.connection_id }).first();
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
    const ingestedTables = await semanticDb('ingested_tables')
      .where({ connection_id: product.connection_id, status: 'done' });

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

    // Pre-load existing product tables
    const allProductTables = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      return trx('product_tables')
        .whereIn('star_schema_id', function () {
          this.select('id').from('star_schemas').where({ data_product_id: product.id });
        })
        .where('transformation_status', 'success');
    });

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

      await semanticDb('product_tables').where({ id: table.id }).update({
        transformation_status: 'running',
        last_run_error: null,
      });

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

        const rows = await db.all(table.transformation_sql);
        let rowCount = rows.length;

        const tempTable = `__temp_${table.table_name}`;
        await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${table.transformation_sql};`);

        try {
          await runTransformationChecks(db, tempTable, table.id, table.table_role, table.transformation_sql);
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
          const bkCols = await semanticDb('product_columns')
            .where({ product_table_id: table.id })
            .whereIn('column_role', ['surrogate_key', 'natural_key'])
            .select('column_name');

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
          // Full overwrite (works for both local and Azure)
          await db.exec(`COPY ${tempTable} TO '${escapedPath}' (FORMAT PARQUET);`);
          await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);
        }

        await semanticDb('product_tables').where({ id: table.id }).update({
          transformation_status: 'success',
          delta_path: tableOutputPath,
          row_count: rowCount,
          last_run_at: new Date().toISOString(),
          last_run_error: null,
        });

        results.push({ table_name: table.table_name, status: 'success', row_count: rowCount });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await semanticDb('product_tables').where({ id: table.id }).update({
          transformation_status: 'error',
          last_run_at: new Date().toISOString(),
          last_run_error: msg,
        });
        results.push({ table_name: table.table_name, status: 'error', error: msg });
      }
    }
  } finally {
    await db.close();
  }

  return results;
}

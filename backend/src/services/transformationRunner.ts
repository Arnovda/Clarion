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

/**
 * Deterministic SQL auto-fixer — parses DuckDB error messages and applies
 * the suggested corrections without needing an AI call.
 *
 * Handles:
 * 1. "Referenced column X not found, Candidate bindings: Y" → replace X with best match Y
 * 2. "Table with name X does not exist! Did you mean Y?" → replace X with best available view
 * 3. "Values list alias does not have a column named X" + candidate → replace
 */
function autoFixSql(sql: string, errorMessage: string, availableViews?: string[]): string {
  let fixed = sql;

  // Pattern 1: "Referenced column "X" not found ... Candidate bindings: "Y", "Z"
  const colNotFound = errorMessage.match(
    /Referenced column "([^"]+)" not found[\s\S]*?Candidate bindings:\s*"([^"]+)"/
  );
  if (colNotFound) {
    const [, badCol, suggestedCol] = colNotFound;
    const escaped = badCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
    fixed = sql.replace(pattern, suggestedCol);
    if (fixed !== sql) return fixed;
  }

  // Pattern 2: "Table with name X does not exist!"
  // DuckDB's "Did you mean" suggestion is often wrong (picks alphabetically closest).
  // Instead, find the best semantic match from available DuckDB views using JOIN context.
  const tableNotFound = errorMessage.match(
    /Table with name (\w+) does not exist!/
  );
  if (tableNotFound && availableViews && availableViews.length > 0) {
    const badTable = tableNotFound[1];
    const bestMatch = findBestTableMatch(badTable, availableViews, sql);
    if (bestMatch) {
      const escaped = badTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
      fixed = sql.replace(pattern, bestMatch);
      if (fixed !== sql) return fixed;
    }
  }

  // Pattern 3: "Binder Error: column X not found" with "Candidate bindings" (alternate format)
  const binderCol = errorMessage.match(
    /column "([^"]+)" not found[\s\S]*?Candidate bindings:\s*"([^"]+)"/i
  );
  if (binderCol) {
    const [, badCol, suggestedCol] = binderCol;
    const escaped = badCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
    fixed = sql.replace(pattern, suggestedCol);
    if (fixed !== sql) return fixed;
  }

  return fixed; // No fix found — return unchanged
}

/**
 * Find the best matching view name for a missing table reference.
 * Uses the SQL context to match JOIN column references against available views.
 * e.g., "LEFT JOIN dim_klant dc ON ... = dc.customer_key" → finds dim_customer
 * because dim_customer has a customer_key column.
 */
function findBestTableMatch(badTable: string, availableViews: string[], sql?: string, db?: Database): string | null {
  const badParts = badTable.toLowerCase().split('_');
  const badPrefix = badParts[0]; // "dim", "fact", etc.

  // Filter to same prefix only
  const candidates = availableViews.filter(v => v.toLowerCase().startsWith(badPrefix + '_'));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]; // Only one option — use it

  // Try to extract alias and referenced columns from the SQL JOIN clause
  if (sql) {
    // Find: "JOIN dim_klant <alias>" or "JOIN dim_klant AS <alias>"
    const joinPattern = new RegExp(
      `JOIN\\s+${badTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:AS\\s+)?(\\w+)`,
      'i'
    );
    const joinMatch = sql.match(joinPattern);
    if (joinMatch) {
      const alias = joinMatch[1];
      // Find all column references using this alias: alias.column_name
      const colRefs = [...sql.matchAll(new RegExp(`${alias}\\.(\\w+)`, 'g'))].map(m => m[1]);
      if (colRefs.length > 0) {
        // The candidate with a column matching one of these references is our target
        // Check column names by looking at the candidate view names
        // e.g., if alias refs "customer_key", the view dim_customer likely has it
        for (const candidate of candidates) {
          const entityPart = candidate.split('_').slice(1).join('_'); // "customer"
          for (const col of colRefs) {
            if (col.toLowerCase().includes(entityPart) || entityPart.includes(col.toLowerCase().replace('_key', ''))) {
              return candidate;
            }
          }
        }
      }
    }
  }

  // Fallback: longest common substring on the entity portion
  const badSuffix = badParts.slice(1).join('_');
  let bestMatch: string | null = null;
  let bestScore = 0;
  for (const view of candidates) {
    const viewSuffix = view.toLowerCase().split('_').slice(1).join('_');
    let score = 0;
    // Exact part matches
    for (const part of badParts.slice(1)) {
      for (const vPart of view.toLowerCase().split('_').slice(1)) {
        if (part === vPart) score += 10;
        else if (vPart.includes(part) || part.includes(vPart)) score += 5;
      }
    }
    // LCS bonus
    let max = 0;
    for (let i = 0; i < badSuffix.length; i++)
      for (let j = i + 1; j <= badSuffix.length; j++)
        if (viewSuffix.includes(badSuffix.substring(i, j)) && j - i > max) max = j - i;
    score += max;
    if (score > bestScore) { bestScore = score; bestMatch = view; }
  }
  return bestScore >= 3 ? bestMatch : null;
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
 * Runs transformations for a data product's tables, respecting DAG order.
 */
export async function runProductTransformation(
  product: ProductRow,
  tables: TableRow[],
  tenantId?: number,
): Promise<TransformResult[]> {
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

        // ── Deterministic auto-fix: retry with DuckDB's own column/table suggestions ──
        // Collect available view/table names in DuckDB for table name resolution
        let availableViews: string[] = [];
        try {
          const viewRows = await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
          availableViews = viewRows.map((r: { table_name: string }) => r.table_name);
        } catch { /* best-effort */ }

        let sql = table.transformation_sql;
        const MAX_AUTOFIX = 5;
        for (let fix = 0; fix < MAX_AUTOFIX; fix++) {
          try {
            await db.all(sql);
            break; // SQL is valid
          } catch (sqlErr: unknown) {
            const errMsg = sqlErr instanceof Error ? sqlErr.message : String(sqlErr);
            const patched = autoFixSql(sql, errMsg, availableViews);
            if (patched === sql) throw sqlErr; // No fix found — rethrow
            console.log(`[transformationRunner] Auto-fixed SQL for ${table.table_name} (attempt ${fix + 1}): ${errMsg.substring(0, 80)}`);
            sql = patched;
          }
        }
        // Update table SQL if it was patched
        if (sql !== table.transformation_sql) {
          table.transformation_sql = sql;
          await tenantQuery(tenantId, (trx) =>
            trx('product_tables').where({ id: table.id }).update({ transformation_sql: sql, updated_at: new Date().toISOString() })
          );
        }

        const rows = await db.all(sql);
        let rowCount = rows.length;

        const tempTable = `__temp_${table.table_name}`;
        await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${sql};`);

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
          // Full overwrite (works for both local and Azure)
          await db.exec(`COPY ${tempTable} TO '${escapedPath}' (FORMAT PARQUET);`);
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
  }

  return results;
}

/**
 * Transformation Runner — executes DuckDB SQL to materialize product tables
 * as Delta Lake Parquet files in the warehouse/product/ directory.
 *
 * Execution order follows the DAG: dimensions (dag_order=0) first, then facts (dag_order=1).
 * Each table gets its own Delta directory under ./warehouse/product/{product_name}/{table_name}/.
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
}

interface TransformResult {
  table_name: string;
  status: 'success' | 'error';
  row_count?: number;
  error?: string;
}

/**
 * Runs transformations for a data product's tables, respecting DAG order.
 *
 * Steps:
 * 1. Open a DuckDB in-memory session
 * 2. Install + load the Delta extension
 * 3. Create views for source Delta tables (raw layer)
 * 4. Create views for already-materialized product tables (for fact→dim references)
 * 5. Execute each table's transformation SQL in DAG order
 * 6. Write results as Delta tables to ./warehouse/product/{product}/{table}/
 */
export async function runProductTransformation(
  product: ProductRow,
  tables: TableRow[],
): Promise<TransformResult[]> {
  // Get the connection's warehouse path for source data
  const connection = await semanticDb('connections').where({ id: product.connection_id }).first();
  const warehousePath = connection?.warehouse_path;

  if (!warehousePath) {
    throw new Error('Connection has no warehouse path — ingestion may not have run yet');
  }

  // Ensure the raw warehouse directory exists
  const resolvedWarehouse = path.resolve(warehousePath);
  if (!fs.existsSync(resolvedWarehouse)) {
    throw new Error(`Warehouse directory not found: ${resolvedWarehouse}. Run data ingestion first.`);
  }

  // Ensure base product directory exists
  const productBaseDir = path.resolve('./warehouse/product');
  fs.mkdirSync(productBaseDir, { recursive: true });

  // Product output directory
  const productSlug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const productDir = path.resolve(productBaseDir, productSlug);
  fs.mkdirSync(productDir, { recursive: true });

  // Sort by DAG order (dims first)
  const sorted = [...tables].sort((a, b) => a.dag_order - b.dag_order);

  const db = await Database.create(':memory:');
  const results: TransformResult[] = [];

  try {
    // Install Delta extension
    await db.exec('INSTALL delta; LOAD delta;');

    // Create views for raw source tables (from ingestion)
    const ingestedTables = await semanticDb('ingested_tables')
      .where({ connection_id: product.connection_id, status: 'done' });

    for (const it of ingestedTables) {
      const deltaPath = (it.delta_path as string).replace(/\\/g, '/');
      // Remap Docker path to host path if needed
      const hostPath = deltaPath.startsWith('/warehouse/')
        ? path.resolve('./warehouse', deltaPath.replace('/warehouse/', ''))
        : deltaPath;
      await db.exec(`CREATE OR REPLACE VIEW "${it.table_name}" AS SELECT * FROM delta_scan('${hostPath.replace(/'/g, "''")}');`);
    }

    // Execute each transformation in order
    for (const table of sorted) {
      const deltaDir = path.join(productDir, table.table_name);
      fs.mkdirSync(deltaDir, { recursive: true });

      // Mark as running
      await semanticDb('product_tables').where({ id: table.id }).update({
        transformation_status: 'running',
        last_run_error: null,
      });

      try {
        // Also create views for product tables that have already been materialized
        // (so facts can reference dims via surrogate keys)
        for (const prev of results) {
          if (prev.status === 'success') {
            const prevDir = path.join(productDir, prev.table_name).replace(/\\/g, '/');
            const hasDelta = fs.existsSync(path.join(productDir, prev.table_name, '_delta_log'));
            try {
              if (hasDelta) {
                await db.exec(`CREATE OR REPLACE VIEW "${prev.table_name}" AS SELECT * FROM delta_scan('${prevDir.replace(/'/g, "''")}');`);
              } else {
                // Parquet output — COPY TO writes a single file or directory of .parquet files
                await db.exec(`CREATE OR REPLACE VIEW "${prev.table_name}" AS SELECT * FROM read_parquet('${prevDir.replace(/'/g, "''")}/*.parquet');`);
              }
            } catch {
              // Best-effort: try reading as a single parquet file (COPY TO sometimes writes table_name.parquet)
              try {
                await db.exec(`CREATE OR REPLACE VIEW "${prev.table_name}" AS SELECT * FROM read_parquet('${prevDir.replace(/'/g, "''")}');`);
              } catch { /* skip — will fail at SQL execution if actually needed */ }
            }
          }
        }

        // Execute the transformation SQL to get the result
        const rows = await db.all(table.transformation_sql);
        const rowCount = rows.length;

        // Write to Delta format using COPY TO
        // First create a temp table, then COPY TO Delta
        const tempTable = `__temp_${table.table_name}`;
        await db.exec(`CREATE OR REPLACE TABLE ${tempTable} AS ${table.transformation_sql};`);

        // Run quality checks (BK uniqueness + fan-out) while temp table exists
        try {
          await runTransformationChecks(db, tempTable, table.id, table.table_role, table.transformation_sql);
        } catch (checkErr) {
          console.warn(`[transformationRunner] Quality checks failed for ${table.table_name}:`, checkErr);
          // Non-blocking — checks failing should not stop the transformation
        }

        const parquetFile = path.join(deltaDir, 'data.parquet').replace(/\\/g, '/');
        await db.exec(`COPY ${tempTable} TO '${parquetFile}' (FORMAT PARQUET);`);
        await db.exec(`DROP TABLE IF EXISTS ${tempTable};`);

        // Update metadata
        await semanticDb('product_tables').where({ id: table.id }).update({
          transformation_status: 'success',
          delta_path: deltaDir,
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

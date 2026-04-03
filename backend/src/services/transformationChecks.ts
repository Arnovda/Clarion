/**
 * Transformation Quality Checks — mandatory validation after each table materializes.
 *
 * Two checks:
 * 1. BK Uniqueness — duplicate business keys corrupt upsert/SCD targets.
 * 2. Fan-out Detection — misconfigured JOINs silently multiply rows.
 *
 * Both run automatically inside the transformation runner after SQL execution.
 * Results are persisted to the `transformation_checks` table.
 */

import { Database } from 'duckdb-async';
import { semanticDb } from '../db/knex';

interface CheckResult {
  check_type: 'bk_uniqueness' | 'fan_out';
  status: 'pass' | 'fail' | 'skip' | 'error';
  bk_columns: string[];
  total_rows: number;
  distinct_bk_rows: number;
  duplicate_count: number;
  sample_duplicates: Record<string, unknown>[];
  message: string;
}

/**
 * Identifies business key columns for a product table from its column metadata.
 *
 * Dimensions: surrogate_key or natural_key columns.
 * Facts: all foreign_key + degenerate_dimension columns form the composite grain.
 */
async function resolveBkColumns(tableId: number, tableRole: string): Promise<string[]> {
  const columns = await semanticDb('product_columns')
    .where({ product_table_id: tableId })
    .select('column_name', 'column_role');

  if (tableRole === 'fact') {
    // Fact grain = all FKs + degenerate dimensions
    const grain = columns
      .filter((c: any) => c.column_role === 'foreign_key' || c.column_role === 'degenerate_dimension')
      .map((c: any) => c.column_name);
    return grain;
  }

  // Dimension / junk / bridge: prefer surrogate_key, fall back to natural_key
  const sk = columns.filter((c: any) => c.column_role === 'surrogate_key').map((c: any) => c.column_name);
  if (sk.length > 0) return sk;

  const nk = columns.filter((c: any) => c.column_role === 'natural_key').map((c: any) => c.column_name);
  if (nk.length > 0) return nk;

  // No key columns found — skip
  return [];
}

/**
 * Run BK Uniqueness check against a temp table in the DuckDB session.
 */
async function checkBkUniqueness(
  db: Database,
  tempTable: string,
  bkColumns: string[],
): Promise<CheckResult> {
  if (bkColumns.length === 0) {
    return {
      check_type: 'bk_uniqueness',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'No business key columns defined — skipped.',
    };
  }

  const bkList = bkColumns.map((c) => `"${c}"`).join(', ');

  // Count total rows
  const totalResult = await db.all(`SELECT COUNT(*) AS cnt FROM ${tempTable}`);
  const totalRows = Number(totalResult[0]?.cnt ?? 0);

  // Find duplicates
  const dupSql = `
    SELECT ${bkList}, COUNT(*) AS duplicate_count
    FROM ${tempTable}
    GROUP BY ${bkList}
    HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC
    LIMIT 10
  `;
  const duplicates = await db.all(dupSql);
  const dupGroupCount = duplicates.length;

  // If we hit the limit of 10, get the real count
  let realDupCount = dupGroupCount;
  if (dupGroupCount >= 10) {
    const countSql = `
      SELECT COUNT(*) AS cnt FROM (
        SELECT ${bkList}
        FROM ${tempTable}
        GROUP BY ${bkList}
        HAVING COUNT(*) > 1
      ) sub
    `;
    const countResult = await db.all(countSql);
    realDupCount = Number(countResult[0]?.cnt ?? dupGroupCount);
  }

  // Count distinct BK combos
  const bkConcat = bkColumns.length === 1
    ? `"${bkColumns[0]}"`
    : `CONCAT(${bkColumns.map((c) => `COALESCE(CAST("${c}" AS VARCHAR), '')`).join(", '|', ")})`;
  const distinctResult = await db.all(`SELECT COUNT(DISTINCT ${bkConcat}) AS cnt FROM ${tempTable}`);
  const distinctBkRows = Number(distinctResult[0]?.cnt ?? 0);

  if (realDupCount === 0) {
    return {
      check_type: 'bk_uniqueness',
      status: 'pass',
      bk_columns: bkColumns,
      total_rows: totalRows,
      distinct_bk_rows: distinctBkRows,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `BK uniqueness passed — ${totalRows} rows, all business keys unique.`,
    };
  }

  return {
    check_type: 'bk_uniqueness',
    status: 'fail',
    bk_columns: bkColumns,
    total_rows: totalRows,
    distinct_bk_rows: distinctBkRows,
    duplicate_count: realDupCount,
    sample_duplicates: duplicates.map((d) => ({ ...d })),
    message: `BK uniqueness FAILED — ${realDupCount} duplicate business key group(s) found in ${totalRows} rows.`,
  };
}

/**
 * Run Fan-out Detection check against a temp table in the DuckDB session.
 * Only applies to tables whose transformation SQL contains a JOIN.
 */
async function checkFanOut(
  db: Database,
  tempTable: string,
  bkColumns: string[],
  transformationSql: string,
): Promise<CheckResult> {
  // Only check if the SQL contains a JOIN
  const hasJoin = /\bJOIN\b/i.test(transformationSql);
  if (!hasJoin) {
    return {
      check_type: 'fan_out',
      status: 'skip',
      bk_columns: bkColumns,
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'No JOINs in transformation SQL — fan-out check skipped.',
    };
  }

  if (bkColumns.length === 0) {
    return {
      check_type: 'fan_out',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'No business key columns defined — fan-out check skipped.',
    };
  }

  const bkConcat = bkColumns.length === 1
    ? `"${bkColumns[0]}"`
    : `CONCAT(${bkColumns.map((c) => `COALESCE(CAST("${c}" AS VARCHAR), '')`).join(", '|', ")})`;

  const sql = `
    SELECT
      COUNT(*)                         AS total_rows,
      COUNT(DISTINCT ${bkConcat})      AS distinct_bk_rows,
      COUNT(*) - COUNT(DISTINCT ${bkConcat}) AS fan_out_surplus
    FROM ${tempTable}
  `;
  const result = await db.all(sql);
  const totalRows = Number(result[0]?.total_rows ?? 0);
  const distinctBkRows = Number(result[0]?.distinct_bk_rows ?? 0);
  const surplus = Number(result[0]?.fan_out_surplus ?? 0);

  if (surplus === 0) {
    return {
      check_type: 'fan_out',
      status: 'pass',
      bk_columns: bkColumns,
      total_rows: totalRows,
      distinct_bk_rows: distinctBkRows,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Fan-out check passed — ${totalRows} rows, no row multiplication detected.`,
    };
  }

  // Get sample duplicated BK values for debugging
  const bkList = bkColumns.map((c) => `"${c}"`).join(', ');
  const sampleSql = `
    SELECT ${bkList}, COUNT(*) AS row_count
    FROM ${tempTable}
    GROUP BY ${bkList}
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `;
  const samples = await db.all(sampleSql);

  return {
    check_type: 'fan_out',
    status: 'fail',
    bk_columns: bkColumns,
    total_rows: totalRows,
    distinct_bk_rows: distinctBkRows,
    duplicate_count: surplus,
    sample_duplicates: samples.map((s) => ({ ...s })),
    message: `Fan-out FAILED — ${surplus} surplus rows detected (${totalRows} total vs ${distinctBkRows} distinct BKs). JOINs may be multiplying rows.`,
  };
}

/**
 * Main entry point — runs both checks and persists results.
 * Called from transformationRunner after the SQL executes successfully.
 *
 * @param db        Active DuckDB session (temp table still exists)
 * @param tempTable Name of the temp table holding the transformation output
 * @param tableId   product_tables.id
 * @param tableRole 'fact' | 'dimension' | 'junk' | 'bridge'
 * @param sql       The transformation SQL (used to detect JOINs)
 */
export async function runTransformationChecks(
  db: Database,
  tempTable: string,
  tableId: number,
  tableRole: string,
  sql: string,
): Promise<CheckResult[]> {
  const bkColumns = await resolveBkColumns(tableId, tableRole);
  const results: CheckResult[] = [];

  try {
    const bkResult = await checkBkUniqueness(db, tempTable, bkColumns);
    results.push(bkResult);
  } catch (err) {
    results.push({
      check_type: 'bk_uniqueness',
      status: 'error',
      bk_columns: bkColumns,
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `BK check error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const fanOutResult = await checkFanOut(db, tempTable, bkColumns, sql);
    results.push(fanOutResult);
  } catch (err) {
    results.push({
      check_type: 'fan_out',
      status: 'error',
      bk_columns: bkColumns,
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Fan-out check error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Persist results (delete previous checks for this table, insert new ones)
  await semanticDb('transformation_checks').where({ product_table_id: tableId }).del();
  for (const r of results) {
    await semanticDb('transformation_checks').insert({
      product_table_id: tableId,
      check_type: r.check_type,
      status: r.status,
      bk_columns: JSON.stringify(r.bk_columns),
      total_rows: r.total_rows,
      distinct_bk_rows: r.distinct_bk_rows,
      duplicate_count: r.duplicate_count,
      sample_duplicates: JSON.stringify(r.sample_duplicates),
      message: r.message,
    });
  }

  return results;
}

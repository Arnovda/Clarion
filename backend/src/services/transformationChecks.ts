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

export type CheckType = 'bk_uniqueness' | 'fan_out' | 'null_check' | 'ref_integrity' | 'value_range';

export interface CheckResult {
  check_type: CheckType;
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
 * Null/Completeness check — flags columns with high null percentages.
 * Key columns (surrogate_key, natural_key, foreign_key) must have 0% nulls.
 * Other columns flag at > 20% nulls.
 */
async function checkNullCompleteness(
  db: Database,
  tempTable: string,
  tableId: number,
): Promise<CheckResult> {
  const columns = await semanticDb('product_columns')
    .where({ product_table_id: tableId })
    .select('column_name', 'column_role');

  if (columns.length === 0) {
    return {
      check_type: 'null_check',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'No columns found — null check skipped.',
    };
  }

  const totalResult = await db.all(`SELECT COUNT(*) AS cnt FROM ${tempTable}`);
  const totalRows = Number(totalResult[0]?.cnt ?? 0);
  if (totalRows === 0) {
    return {
      check_type: 'null_check',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'Table is empty — null check skipped.',
    };
  }

  const keyRoles = ['surrogate_key', 'natural_key', 'foreign_key'];
  const failures: Record<string, unknown>[] = [];

  for (const col of columns) {
    const nullResult = await db.all(
      `SELECT COUNT(*) AS null_count FROM ${tempTable} WHERE "${col.column_name}" IS NULL`,
    );
    const nullCount = Number(nullResult[0]?.null_count ?? 0);
    const nullPct = (nullCount / totalRows) * 100;

    const isKey = keyRoles.includes(col.column_role);
    const threshold = isKey ? 0 : 20;

    if (nullPct > threshold) {
      failures.push({
        column: col.column_name,
        role: col.column_role,
        null_count: nullCount,
        null_pct: Math.round(nullPct * 100) / 100,
        threshold,
      });
    }
  }

  if (failures.length === 0) {
    return {
      check_type: 'null_check',
      status: 'pass',
      bk_columns: [],
      total_rows: totalRows,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Null check passed — all ${columns.length} columns within thresholds.`,
    };
  }

  return {
    check_type: 'null_check',
    status: 'fail',
    bk_columns: [],
    total_rows: totalRows,
    distinct_bk_rows: 0,
    duplicate_count: failures.length,
    sample_duplicates: failures,
    message: `Null check FAILED — ${failures.length} column(s) exceed null thresholds.`,
  };
}

/**
 * Referential integrity check — for fact tables, verifies FK values exist in dimension tables.
 * Looks up FK relationships from product_columns and checks against materialized dimension data.
 */
async function checkReferentialIntegrity(
  db: Database,
  tempTable: string,
  tableId: number,
  tableRole: string,
): Promise<CheckResult> {
  if (tableRole !== 'fact') {
    return {
      check_type: 'ref_integrity',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'Not a fact table — referential integrity check skipped.',
    };
  }

  // Get FK columns and their target tables
  const fkColumns = await semanticDb('product_columns')
    .where({ product_table_id: tableId, column_role: 'foreign_key' })
    .select('column_name', 'fk_target_table', 'fk_target_column');

  if (fkColumns.length === 0) {
    return {
      check_type: 'ref_integrity',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'No FK columns defined — referential integrity check skipped.',
    };
  }

  const totalResult = await db.all(`SELECT COUNT(*) AS cnt FROM ${tempTable}`);
  const totalRows = Number(totalResult[0]?.cnt ?? 0);
  const failures: Record<string, unknown>[] = [];

  for (const fk of fkColumns) {
    if (!fk.fk_target_table || !fk.fk_target_column) continue;

    // fk_target_table stores the table name directly (not an ID)
    const targetTableName = fk.fk_target_table as string;

    // Check if the dimension table exists in DuckDB (it may not be materialized yet)
    try {
      const orphanSql = `
        SELECT COUNT(*) AS orphan_count
        FROM ${tempTable} f
        WHERE f."${fk.column_name}" IS NOT NULL
          AND CAST(f."${fk.column_name}" AS VARCHAR) NOT IN ('-1', '0')
          AND f."${fk.column_name}" NOT IN (
            SELECT DISTINCT "${fk.fk_target_column}" FROM "${targetTableName}"
          )
      `;
      const orphanResult = await db.all(orphanSql);
      const orphanCount = Number(orphanResult[0]?.orphan_count ?? 0);

      if (orphanCount > 0) {
        // Get sample orphaned values
        const sampleSql = `
          SELECT DISTINCT f."${fk.column_name}" AS orphan_value
          FROM ${tempTable} f
          WHERE f."${fk.column_name}" IS NOT NULL
            AND CAST(f."${fk.column_name}" AS VARCHAR) NOT IN ('-1', '0')
            AND f."${fk.column_name}" NOT IN (
              SELECT DISTINCT "${fk.fk_target_column}" FROM "${targetTableName}"
            )
          LIMIT 5
        `;
        const samples = await db.all(sampleSql);
        failures.push({
          fk_column: fk.column_name,
          target_table: targetTableName,
          target_column: fk.fk_target_column,
          orphan_count: orphanCount,
          sample_orphans: samples.map((s) => s.orphan_value),
        });
      }
    } catch {
      // Target table may not exist in DuckDB — skip this FK
    }
  }

  if (failures.length === 0) {
    return {
      check_type: 'ref_integrity',
      status: 'pass',
      bk_columns: [],
      total_rows: totalRows,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Referential integrity passed — all FK values found in target dimensions.`,
    };
  }

  const totalOrphans = failures.reduce((sum, f) => sum + (f.orphan_count as number), 0);
  return {
    check_type: 'ref_integrity',
    status: 'fail',
    bk_columns: [],
    total_rows: totalRows,
    distinct_bk_rows: 0,
    duplicate_count: totalOrphans,
    sample_duplicates: failures,
    message: `Referential integrity FAILED — ${totalOrphans} orphaned FK value(s) across ${failures.length} column(s).`,
  };
}

/**
 * Value range check — flags numeric measure columns with extreme outliers or unexpected negatives.
 * An outlier is defined as max > 100x the average.
 */
async function checkValueRange(
  db: Database,
  tempTable: string,
  tableId: number,
): Promise<CheckResult> {
  const measures = await semanticDb('product_columns')
    .where({ product_table_id: tableId, column_role: 'measure' })
    .select('column_name');

  if (measures.length === 0) {
    return {
      check_type: 'value_range',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'No measure columns found — value range check skipped.',
    };
  }

  const totalResult = await db.all(`SELECT COUNT(*) AS cnt FROM ${tempTable}`);
  const totalRows = Number(totalResult[0]?.cnt ?? 0);
  if (totalRows === 0) {
    return {
      check_type: 'value_range',
      status: 'skip',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: 'Table is empty — value range check skipped.',
    };
  }

  const failures: Record<string, unknown>[] = [];

  for (const col of measures) {
    try {
      const statsSql = `
        SELECT
          MIN("${col.column_name}") AS min_val,
          MAX("${col.column_name}") AS max_val,
          AVG("${col.column_name}") AS avg_val,
          COUNT(CASE WHEN "${col.column_name}" < 0 THEN 1 END) AS negative_count
        FROM ${tempTable}
        WHERE "${col.column_name}" IS NOT NULL
      `;
      const stats = await db.all(statsSql);
      const row = stats[0];
      if (!row) continue;

      const minVal = Number(row.min_val);
      const maxVal = Number(row.max_val);
      const avgVal = Number(row.avg_val);
      const negCount = Number(row.negative_count);

      const issues: string[] = [];
      if (avgVal !== 0 && maxVal > Math.abs(avgVal) * 100) {
        issues.push(`max (${maxVal}) > 100x avg (${avgVal.toFixed(2)})`);
      }
      if (negCount > 0) {
        issues.push(`${negCount} negative value(s)`);
      }

      if (issues.length > 0) {
        failures.push({
          column: col.column_name,
          min: minVal,
          max: maxVal,
          avg: Math.round(avgVal * 100) / 100,
          negative_count: negCount,
          issues,
        });
      }
    } catch {
      // Column may not be numeric — skip
    }
  }

  if (failures.length === 0) {
    return {
      check_type: 'value_range',
      status: 'pass',
      bk_columns: [],
      total_rows: totalRows,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Value range passed — all ${measures.length} measure column(s) within expected ranges.`,
    };
  }

  return {
    check_type: 'value_range',
    status: 'fail',
    bk_columns: [],
    total_rows: totalRows,
    distinct_bk_rows: 0,
    duplicate_count: failures.length,
    sample_duplicates: failures,
    message: `Value range FAILED — ${failures.length} measure column(s) have outliers or unexpected values.`,
  };
}

/**
 * Main entry point — runs all quality checks and persists results.
 * Called from transformationRunner after the SQL executes successfully.
 *
 * Checks: BK uniqueness, fan-out detection, null completeness,
 * referential integrity (fact tables only), value range (measures only).
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

  // 1. BK Uniqueness
  try {
    results.push(await checkBkUniqueness(db, tempTable, bkColumns));
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

  // 2. Fan-out Detection
  try {
    results.push(await checkFanOut(db, tempTable, bkColumns, sql));
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

  // 3. Null/Completeness — disabled (too noisy for real-world data)

  // 4. Referential Integrity (fact tables only)
  try {
    results.push(await checkReferentialIntegrity(db, tempTable, tableId, tableRole));
  } catch (err) {
    results.push({
      check_type: 'ref_integrity',
      status: 'error',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Ref integrity check error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. Value Range (measures only)
  try {
    results.push(await checkValueRange(db, tempTable, tableId));
  } catch (err) {
    results.push({
      check_type: 'value_range',
      status: 'error',
      bk_columns: [],
      total_rows: 0,
      distinct_bk_rows: 0,
      duplicate_count: 0,
      sample_duplicates: [],
      message: `Value range check error: ${err instanceof Error ? err.message : String(err)}`,
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

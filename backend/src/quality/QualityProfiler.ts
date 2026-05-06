/**
 * QualityProfiler — computes per-field stats for any table reachable through
 * a BaseConnector (DuckDB on parquet/delta, in practice). Results are stored
 * in dataset_profiles + field_profiles + quality_score_history.
 *
 * Source-tables and product-tables share the same code path: the caller
 * resolves the table to a URI via the catalog, builds a DuckDBConnector,
 * and hands it here. The legacy SQLite-via-better-sqlite3 implementation
 * was removed when the platform standardised on DuckDB-on-parquet for all
 * data access.
 */

import { semanticDb } from '../db/knex';
import { BaseConnector } from '../connectors/BaseConnector';
import { tenantQuery } from '../services/tenantQuery';

export interface FieldStat {
  field_name:     string;
  data_type:      string;
  null_count:     number;
  null_pct:       number;
  distinct_count: number;
  distinct_pct:   number;
  min_value:      string | null;
  max_value:      string | null;
  mean_value:     number | null;
  median_value:   number | null;
  top_values:     Array<{ value: string; count: number; pct: number }>;
  histogram:      Array<{ label: string; count: number }>;
}

export interface ProfileResult {
  profileId:         number;
  rowCount:          number;
  fields:            FieldStat[];
  overallScore:      number;
  completenessScore: number;
  uniquenessScore:   number;
  validityScore:     number | null;
}

const NUMERIC_RE = /^(int|integer|real|float|double|numeric|decimal|bigint|smallint|tinyint)/i;
function isNumeric(type: string) { return NUMERIC_RE.test(type); }

/**
 * Connector-based quality profiler — works with any BaseConnector (DuckDB, SQLite, etc).
 * Uses generic SQL via executeQuery() instead of better-sqlite3 PRAGMAs.
 *
 * `tenantId` is required for the persistence step — without it, the inserts
 * land on a pooled connection without `app.current_tenant` set, and RLS
 * defaults / FK checks fail (e.g. `dataset_profiles_connection_id_foreign`
 * fires because the visible connections set is empty).
 */
export async function runQualityProfileWithConnector(
  connectionId: number,
  tableName: string,
  connector: BaseConnector,
  columnDefs?: Array<{ name: string; type: string }>,
  overrideBkColumn?: string,
  tenantId?: number,
): Promise<ProfileResult> {
  // Column definitions — use provided list, or introspect via DESCRIBE-style query
  let cols: Array<{ name: string; type: string }>;
  if (columnDefs && columnDefs.length > 0) {
    cols = columnDefs;
  } else {
    const sampleResult = await connector.executeQuery(`SELECT * FROM "${tableName}" LIMIT 1`);
    if (sampleResult.rows.length > 0) {
      cols = Object.keys(sampleResult.rows[0] as object).map((k) => ({ name: k, type: 'TEXT' }));
    } else {
      cols = [];
    }
  }

  // ── Query 1: Batched stats — one SELECT computes row count + per-column stats ──
  // Columns are chunked to avoid excessively long SQL for very wide tables.
  const COL_BATCH_SIZE = 50;
  const statsMap = new Map<string, {
    nulls: number; distinct: number;
    min: unknown; max: unknown;
    avg: number | null; median: number | null;
  }>();
  let rowCount = 0;

  for (let chunk = 0; chunk < cols.length; chunk += COL_BATCH_SIZE) {
    const batch = cols.slice(chunk, chunk + COL_BATCH_SIZE);
    const selectParts: string[] = ['COUNT(*) AS "__row_count"'];

    for (const col of batch) {
      const fn = col.name;
      const q = `"${fn}"`;
      selectParts.push(`SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS "${fn}__nulls"`);
      selectParts.push(`COUNT(DISTINCT ${q}) AS "${fn}__distinct"`);
      selectParts.push(`MIN(${q}) AS "${fn}__min"`);
      selectParts.push(`MAX(${q}) AS "${fn}__max"`);
      if (isNumeric(col.type)) {
        selectParts.push(`AVG(${q}) AS "${fn}__avg"`);
        selectParts.push(`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${q}) AS "${fn}__median"`);
      }
    }

    const sql = `SELECT ${selectParts.join(', ')} FROM "${tableName}"`;
    const statsResult = await connector.executeQuery(sql);
    const row = statsResult.rows[0] as Record<string, unknown>;

    if (chunk === 0) {
      rowCount = Number(row['__row_count'] ?? 0);
    }

    for (const col of batch) {
      const fn = col.name;
      statsMap.set(fn, {
        nulls:    Number(row[`${fn}__nulls`] ?? 0),
        distinct: Number(row[`${fn}__distinct`] ?? 0),
        min:      row[`${fn}__min`] ?? null,
        max:      row[`${fn}__max`] ?? null,
        avg:      isNumeric(col.type) ? (row[`${fn}__avg`] != null ? Number(row[`${fn}__avg`]) : null) : null,
        median:   isNumeric(col.type) ? (row[`${fn}__median`] != null ? Number(row[`${fn}__median`]) : null) : null,
      });
    }
  }

  // ── Query 2: Top values — UNION ALL of per-column GROUP BY ──
  const TOP_BATCH_SIZE = 20;
  const topMap = new Map<string, Array<{ value: string; count: number; pct: number }>>();

  for (let chunk = 0; chunk < cols.length; chunk += TOP_BATCH_SIZE) {
    const batch = cols.slice(chunk, chunk + TOP_BATCH_SIZE);
    const unionParts: string[] = [];

    for (const col of batch) {
      const fn = col.name;
      unionParts.push(
        `SELECT * FROM (SELECT '${fn.replace(/'/g, "''")}' AS "__field", CAST("${fn}" AS VARCHAR) AS "__val", COUNT(*) AS "__cnt" FROM "${tableName}" WHERE "${fn}" IS NOT NULL GROUP BY "${fn}" ORDER BY "__cnt" DESC LIMIT 5)`,
      );
    }

    if (unionParts.length > 0) {
      try {
        const topResult = await connector.executeQuery(unionParts.join(' UNION ALL '));
        for (const r of topResult.rows) {
          const row = r as Record<string, unknown>;
          const field = row['__field'] as string;
          if (!topMap.has(field)) topMap.set(field, []);
          topMap.get(field)!.push({
            value: String(row['__val']),
            count: Number(row['__cnt']),
            pct: rowCount > 0 ? Number(row['__cnt']) / rowCount : 0,
          });
        }
      } catch { /* skip — some columns may not cast to VARCHAR */ }
    }
  }

  // ── Build FieldStat[] from batched results ──
  const fields: FieldStat[] = [];

  for (const col of cols) {
    const fn = col.name;
    const dataType = col.type || 'TEXT';
    const stats = statsMap.get(fn);
    const nullCount    = stats?.nulls ?? 0;
    const distinctCount = stats?.distinct ?? 0;
    const nullPct      = rowCount > 0 ? nullCount / rowCount : 0;
    const distinctPct  = rowCount > 0 ? distinctCount / rowCount : 0;
    const minValue     = stats?.min != null ? String(stats.min) : null;
    const maxValue     = stats?.max != null ? String(stats.max) : null;
    const meanValue    = stats?.avg ?? null;
    const medianValue  = stats?.median ?? null;
    const topValues    = topMap.get(fn) ?? [];

    // Histogram — use top-values for low-cardinality categorical columns
    let histogram: Array<{ label: string; count: number }> = [];
    if (!isNumeric(dataType) && distinctCount <= 20 && rowCount > 0) {
      histogram = topValues.map((r) => ({ label: String(r.value).slice(0, 20), count: r.count }));
    }
    // Numeric histograms and date distributions skipped in batch mode —
    // they would require additional per-column queries and provide marginal value
    // during schema profiling. The quality panel can compute them on-demand.

    fields.push({
      field_name: fn, data_type: dataType,
      null_count: nullCount, null_pct: nullPct,
      distinct_count: distinctCount, distinct_pct: distinctPct,
      min_value: minValue, max_value: maxValue,
      mean_value: meanValue, median_value: medianValue,
      top_values: topValues, histogram,
    });
  }

  // Business-key column selection
  let pkField: FieldStat | null = null;
  if (overrideBkColumn) {
    pkField = fields.find((f) => f.field_name === overrideBkColumn) ?? null;
  }
  if (!pkField && fields.length > 0) {
    // Without PRAGMA pk info, pick the most distinct column
    pkField = fields.reduce(
      (best, f) => f.distinct_pct > best.distinct_pct ? f : best,
      fields[0],
    );
  }

  const bkColumnUsed = pkField?.field_name ?? null;
  const completenessScore = pkField ? 1 - pkField.null_pct : 1;
  const uniquenessScore = pkField ? pkField.distinct_pct : 1;
  const validityScore: number | null = null;
  const overallScore = (completenessScore + uniquenessScore) / 2;

  // Persist — wrapped in tenantQuery so SET LOCAL app.current_tenant is set
  // for every insert. Without this, the pooled connection may not have tenant
  // context, RLS blocks the FK lookup against `connections`, and we get
  // "violates foreign key constraint dataset_profiles_connection_id_foreign"
  // even when the connection exists.
  const profileId: number = await tenantQuery(tenantId, async (trx) => {
    const [pRow] = await trx('dataset_profiles')
      .insert({
        connection_id: connectionId,
        table_name: tableName,
        row_count: rowCount,
        overall_score: overallScore,
        completeness_score: completenessScore,
        uniqueness_score: uniquenessScore,
        validity_score: validityScore,
        consistency_score: null,
        timeliness_score: null,
        accuracy_score: null,
        business_key_column: bkColumnUsed,
      })
      .returning('id');
    const id: number = typeof pRow === 'object' ? (pRow as { id: number }).id : pRow;

    for (const f of fields) {
      await trx('field_profiles').insert({
        profile_id: id,
        field_name: f.field_name,
        data_type: f.data_type,
        null_count: f.null_count,
        null_pct: f.null_pct,
        distinct_count: f.distinct_count,
        distinct_pct: f.distinct_pct,
        min_value: f.min_value,
        max_value: f.max_value,
        mean_value: f.mean_value,
        median_value: f.median_value,
        top_values: JSON.stringify(f.top_values),
        histogram: JSON.stringify(f.histogram),
      });
    }

    const today = new Date().toISOString().split('T')[0];
    await trx('quality_score_history')
      .insert({
        connection_id: connectionId,
        table_name: tableName,
        score_date: today,
        overall_score: overallScore,
        completeness_score: completenessScore,
        uniqueness_score: uniquenessScore,
        validity_score: null,
        consistency_score: null,
        timeliness_score: null,
        accuracy_score: null,
      })
      .onConflict(['connection_id', 'table_name', 'score_date'])
      .merge(['overall_score', 'completeness_score', 'uniqueness_score',
              'validity_score', 'consistency_score', 'timeliness_score', 'accuracy_score']);

    return id;
  });

  return { profileId, rowCount, fields, overallScore, completenessScore, uniquenessScore, validityScore };
}

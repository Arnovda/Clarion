/**
 * QualityProfiler — reads a SQLite source table and computes per-field stats.
 * Results are stored in dataset_profiles + field_profiles + quality_score_history.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { semanticDb } from '../db/knex';

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
const DATE_RE    = /^(date|datetime|timestamp)/i;

function isNumeric(type: string) { return NUMERIC_RE.test(type); }
function isDate(type: string)    { return DATE_RE.test(type); }

export async function runQualityProfile(
  connectionId:    number,
  tableName:       string,
  filepath:        string,
  overrideBkColumn?: string,   // user-specified BK column; overrides auto-detection
): Promise<ProfileResult> {
  const absPath = path.resolve(filepath);
  if (!fs.existsSync(absPath)) throw new Error(`SQLite file not found: ${absPath}`);

  const db = new Database(absPath, { readonly: true });

  try {
    // Row count
    const { cnt: rowCount } = db.prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).get() as { cnt: number };

    // Column definitions
    const colDefs = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
      name: string; type: string; pk: number;
    }>;

    // Primary-key column name(s) — used for uniqueness score
    const pkCols = colDefs.filter((c) => c.pk > 0).map((c) => c.name);

    const fields: FieldStat[] = [];

    for (const col of colDefs) {
      const { name: fn, type: rawType } = col;
      const dataType = rawType || 'TEXT';
      const numeric  = isNumeric(dataType);

      // ── Null count ──────────────────────────────────────────────────────
      const { cnt: nullCount } = db
        .prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}" WHERE "${fn}" IS NULL`)
        .get() as { cnt: number };
      const nullPct = rowCount > 0 ? nullCount / rowCount : 0;

      // ── Distinct count ──────────────────────────────────────────────────
      const { cnt: distinctCount } = db
        .prepare(`SELECT COUNT(DISTINCT "${fn}") AS cnt FROM "${tableName}"`)
        .get() as { cnt: number };
      const distinctPct = rowCount > 0 ? distinctCount / rowCount : 0;

      // ── Min / Max ───────────────────────────────────────────────────────
      let minValue: string | null = null;
      let maxValue: string | null = null;
      if (rowCount > 0) {
        try {
          const mm = db
            .prepare(`SELECT MIN("${fn}") AS mn, MAX("${fn}") AS mx FROM "${tableName}"`)
            .get() as { mn: unknown; mx: unknown };
          minValue = mm.mn != null ? String(mm.mn) : null;
          maxValue = mm.mx != null ? String(mm.mx) : null;
        } catch { /* skip */ }
      }

      // ── Mean / Median (numeric only) ────────────────────────────────────
      let meanValue:   number | null = null;
      let medianValue: number | null = null;
      if (numeric && rowCount > 0) {
        try {
          const nonNull = rowCount - nullCount;
          const { avg } = db
            .prepare(`SELECT AVG("${fn}") AS avg FROM "${tableName}" WHERE "${fn}" IS NOT NULL`)
            .get() as { avg: number | null };
          meanValue = avg;

          if (nonNull > 0) {
            const med = db
              .prepare(`
                SELECT "${fn}" AS val FROM "${tableName}"
                WHERE "${fn}" IS NOT NULL ORDER BY "${fn}"
                LIMIT 1 OFFSET ${Math.floor(nonNull / 2)}
              `)
              .get() as { val: number } | undefined;
            medianValue = med?.val ?? null;
          }
        } catch { /* skip */ }
      }

      // ── Top values ──────────────────────────────────────────────────────
      const topRows = db
        .prepare(`
          SELECT "${fn}" AS v, COUNT(*) AS cnt FROM "${tableName}"
          WHERE "${fn}" IS NOT NULL
          GROUP BY "${fn}" ORDER BY cnt DESC LIMIT 5
        `)
        .all() as Array<{ v: unknown; cnt: number }>;
      const topValues = topRows.map((r) => ({
        value: String(r.v),
        count: r.cnt,
        pct:   rowCount > 0 ? r.cnt / rowCount : 0,
      }));

      // ── Histogram ───────────────────────────────────────────────────────
      let histogram: Array<{ label: string; count: number }> = [];

      if (numeric && minValue != null && maxValue != null && rowCount > 0) {
        const mn = Number(minValue), mx = Number(maxValue);
        if (!isNaN(mn) && !isNaN(mx) && mx > mn) {
          const buckets = 10;
          const bsize   = (mx - mn) / buckets;
          try {
            const hrows = db
              .prepare(`
                SELECT CAST(("${fn}" - ${mn}) / ${bsize} AS INT) AS b, COUNT(*) AS cnt
                FROM "${tableName}" WHERE "${fn}" IS NOT NULL
                GROUP BY b ORDER BY b
              `)
              .all() as Array<{ b: number; cnt: number }>;
            for (let i = 0; i < buckets; i++) {
              const matched = hrows.filter((r) => (i === buckets - 1 ? r.b >= i : r.b === i));
              histogram.push({
                label: (mn + i * bsize).toFixed(1),
                count: matched.reduce((s, r) => s + r.cnt, 0),
              });
            }
          } catch { /* skip */ }
        }
      } else if (!numeric && distinctCount <= 20 && rowCount > 0) {
        histogram = topRows.map((r) => ({ label: String(r.v).slice(0, 20), count: r.cnt }));
      } else if (isDate(dataType) && rowCount > 0) {
        // Counts per month — label = YYYY-MM
        try {
          const mrows = db
            .prepare(`
              SELECT strftime('%Y-%m', "${fn}") AS m, COUNT(*) AS cnt
              FROM "${tableName}" WHERE "${fn}" IS NOT NULL
              GROUP BY m ORDER BY m DESC LIMIT 12
            `)
            .all() as Array<{ m: string; cnt: number }>;
          histogram = mrows.reverse().map((r) => ({ label: r.m, count: r.cnt }));
        } catch { /* skip */ }
      }

      fields.push({
        field_name: fn, data_type: dataType,
        null_count: nullCount, null_pct: nullPct,
        distinct_count: distinctCount, distinct_pct: distinctPct,
        min_value: minValue, max_value: maxValue,
        mean_value: meanValue, median_value: medianValue,
        top_values: topValues, histogram,
      });
    }

    // ── Business-key column selection ────────────────────────────────────────
    // Priority: 1) user override, 2) SQLite PRAGMA PK, 3) most-distinct fallback
    let pkField: FieldStat | null = null;

    if (overrideBkColumn) {
      pkField = fields.find((f) => f.field_name === overrideBkColumn) ?? null;
    }
    if (!pkField && pkCols.length > 0) {
      pkField = fields.find((f) => pkCols.includes(f.field_name)) ?? null;
    }
    if (!pkField && fields.length > 0) {
      pkField = fields.reduce(
        (best, f) => f.distinct_pct > best.distinct_pct ? f : best,
        fields[0],
      );
    }

    const bkColumnUsed = pkField?.field_name ?? null;

    // BK Completeness: what % of BK rows have a non-null value
    const completenessScore: number = pkField ? 1 - pkField.null_pct : 1;

    // BK Uniqueness: what % of BK values are distinct (should be 100% for a true PK)
    const uniquenessScore: number = pkField ? pkField.distinct_pct : 1;

    // Rules pass rate — populated by evaluateRules() after profiling; null for now
    const validityScore: number | null = null;

    // Overall = simple average of available scores (2 now, 3 once rules run)
    const overallScore = (completenessScore + uniquenessScore) / 2;

    // ── Persist dataset_profiles ─────────────────────────────────────────
    const [pRow] = await semanticDb('dataset_profiles')
      .insert({
        connection_id:      connectionId,
        table_name:         tableName,
        row_count:          rowCount,
        overall_score:      overallScore,
        completeness_score: completenessScore,
        uniqueness_score:   uniquenessScore,
        validity_score:     validityScore,
        consistency_score:  null,
        timeliness_score:   null,
        accuracy_score:     null,
        business_key_column: bkColumnUsed,
      })
      .returning('id');
    const profileId: number = typeof pRow === 'object' ? (pRow as { id: number }).id : pRow;

    // ── Persist field_profiles ───────────────────────────────────────────
    for (const f of fields) {
      await semanticDb('field_profiles').insert({
        profile_id:     profileId,
        field_name:     f.field_name,
        data_type:      f.data_type,
        null_count:     f.null_count,
        null_pct:       f.null_pct,
        distinct_count: f.distinct_count,
        distinct_pct:   f.distinct_pct,
        min_value:      f.min_value,
        max_value:      f.max_value,
        mean_value:     f.mean_value,
        median_value:   f.median_value,
        top_values:     JSON.stringify(f.top_values),
        histogram:      JSON.stringify(f.histogram),
      });
    }

    // ── Upsert daily score history ────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    await semanticDb('quality_score_history')
      .insert({
        connection_id:      connectionId,
        table_name:         tableName,
        score_date:         today,
        overall_score:      overallScore,
        completeness_score: completenessScore,
        uniqueness_score:   uniquenessScore,
        validity_score:     null,
        consistency_score:  null,
        timeliness_score:   null,
        accuracy_score:     null,
      })
      .onConflict(['connection_id', 'table_name', 'score_date'])
      .merge(['overall_score', 'completeness_score', 'uniqueness_score',
              'validity_score', 'consistency_score', 'timeliness_score', 'accuracy_score']);

    return { profileId, rowCount, fields, overallScore, completenessScore, uniquenessScore, validityScore };
  } finally {
    db.close();
  }
}

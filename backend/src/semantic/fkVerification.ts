/**
 * Foreign-key verification — the single rule that decides whether the DATA
 * backs a proposed relationship.
 *
 * Extracted from SchemaProfiler so it can be imported without dragging in the
 * connector layer (and, through it, DuckDB's native binding). It only ever
 * needed an object that can run a query, and keeping it here lets the
 * relationship canvas reuse the *same* thresholds and the *same* sample as the
 * automatic detector. A canvas reporting 97% for a candidate the detector
 * silently rejected would be lying to the user about which one is wrong.
 *
 * There is exactly one implementation of this test. Three call sites propose
 * candidates — the connector's heuristic scan, Claude's unmatched-key pass and
 * Claude's data-model pass — and they used to have three separate copies of the
 * check, which is how the third kept inventing `-> GLClassifications.Name` for a
 * whole production sync after the other two were fixed.
 */

/**
 * Foreign-key verification thresholds.
 *
 * FK_SAMPLE_SIZE is deliberately larger than the old 500: the sample bounds how
 * many distinct source values are checked, and a bigger one makes containment a
 * better estimate. It does NOT, on its own, stop a small-domain false positive —
 * that is what FK_MIN_DISTINCT is for.
 */
const FK_SAMPLE_SIZE = Number(process.env.FK_SAMPLE_SIZE) || 1000;
/** Below this many distinct source values, agreement is not evidence. */
const FK_MIN_DISTINCT = Number(process.env.FK_MIN_DISTINCT) || 8;
/** A key is near-unique in its own table; measured, not guessed from its name. */
const FK_TARGET_UNIQUENESS = Number(process.env.FK_TARGET_UNIQUENESS) || 0.99;
/** A real FK's values are a near-subset of the parent's keys. */
const FK_MIN_CONTAINMENT = Number(process.env.FK_MIN_CONTAINMENT) || 0.85;

export interface FkVerdict {
  ok: boolean;
  reason: 'ok' | 'too-few-distinct' | 'target-not-key' | 'low-containment';
  containment: number;
  sampled: number;
  targetRows: number;
  targetDistinct: number;
}

/** Human-readable rejection reason, for the log line. */
export function describeFkVerdict(v: FkVerdict): string {
  switch (v.reason) {
    case 'ok':               return `containment ${Math.round(v.containment * 100)}%`;
    case 'too-few-distinct': return `only ${v.sampled} distinct source values (min ${FK_MIN_DISTINCT})`;
    case 'target-not-key':   return `target not unique (${v.targetDistinct}/${v.targetRows} distinct)`;
    case 'low-containment':  return `containment ${Math.round(v.containment * 100)}% (min ${Math.round(FK_MIN_CONTAINMENT * 100)}%)`;
  }
}

/**
 * Decide whether the DATA backs a foreign-key candidate.
 *
 * There are three places a candidate can be proposed — the connector's
 * heuristic scan, Claude's unmatched-key matching (Pass A), and Claude's
 * data-model pass (Pass B) — and every one of them needs the SAME test.
 * They used to have three separate copies of it, which is how the Pass B copy
 * kept inventing `→ GLClassifications.Name` for a whole production sync after
 * the other two were fixed. One implementation, one rule.
 *
 * Three guards, none of which raw value-overlap can express:
 *   • the target must be a KEY — near-unique in its own table. MEASURED, not
 *     pattern-matched on the column name: some source systems legitimately key
 *     on a natural or name column.
 *   • the source must have enough distinct values that agreement is not
 *     coincidence. A line counter with 40 values that all happen to exist in
 *     some code table scores 100% at ANY sample size.
 *   • containment must be high. A foreign key's values are a near-subset of
 *     its parent's keys; 50% agreement never described one.
 *
 * `matched` and `sampled` come from the SAME sample. Counting matches over a
 * sample but the total over the whole column understates wide keys by the
 * sampling ratio and rejects exactly the ones worth having.
 */
export async function verifyFkCandidate(
  connector: { executeQuery(sql: string): Promise<{ rows: unknown[] }> },
  fromTable: string, fromColumn: string, toTable: string, toColumn: string,
): Promise<FkVerdict> {
  const result = await connector.executeQuery(
    `WITH src AS (
       SELECT DISTINCT "${fromColumn}" AS v
       FROM "${fromTable}" WHERE "${fromColumn}" IS NOT NULL LIMIT ${FK_SAMPLE_SIZE}
     )
     SELECT (SELECT COUNT(*) FROM src) AS sampled,
            (SELECT COUNT(*) FROM src x
               WHERE EXISTS (SELECT 1 FROM "${toTable}" t
                             WHERE CAST(t."${toColumn}" AS TEXT) = CAST(x.v AS TEXT))) AS matched,
            (SELECT COUNT(*) FROM "${toTable}" WHERE "${toColumn}" IS NOT NULL) AS target_rows,
            (SELECT COUNT(DISTINCT "${toColumn}") FROM "${toTable}" WHERE "${toColumn}" IS NOT NULL) AS target_distinct`,
  );
  const row = result.rows[0] as
    { sampled: number; matched: number; target_rows: number; target_distinct: number } | undefined;
  const sampled       = Number(row?.sampled ?? 0);
  const containment   = sampled > 0 ? Number(row?.matched ?? 0) / sampled : 0;
  const targetRows    = Number(row?.target_rows ?? 0);
  const targetDistinct = Number(row?.target_distinct ?? 0);
  const base = { containment, sampled, targetRows, targetDistinct };

  if (sampled < FK_MIN_DISTINCT) return { ok: false, reason: 'too-few-distinct', ...base };
  if (!(targetRows > 0 && targetDistinct / targetRows >= FK_TARGET_UNIQUENESS)) {
    return { ok: false, reason: 'target-not-key', ...base };
  }
  if (containment < FK_MIN_CONTAINMENT) return { ok: false, reason: 'low-containment', ...base };
  return { ok: true, reason: 'ok', ...base };
}

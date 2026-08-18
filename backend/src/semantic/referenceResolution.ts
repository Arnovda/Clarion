/**
 * Settling a documented reference's TARGET COLUMN against the tenant's data.
 *
 * A source's docs normally mark a foreign key by hyperlinking the property to
 * the target ENTITY. Which COLUMN of it the key lands on is not stated, and the
 * obvious resolution — take the entity's primary key — is wrong wherever the
 * entity carries a second, readable key. Exact Online: `JournalCode`, a string
 * of journal codes, was pointed at `Journals.ID`, a GUID. It measures 0%
 * containment. `Journals.Code` measures 100%.
 *
 * **The column is not a matter of opinion — it is determinable.** So it must
 * not be resolved by anybody's judgement, and least of all patched by hand into
 * a catalogue, where it rots invisibly. It is resolved the same way every other
 * relationship claim in this platform is settled: by measurement, against the
 * three fixed rules in `fkVerification.ts`.
 *
 * A reference resolved here stays attributed to the SOURCE. The vendor asserted
 * the relationship; the data settled the endpoint; no human judgement entered.
 * That is categorically different from a curated entry, where a person decided
 * the relationship exists at all.
 *
 * **The unique-winner rule is the safety catch.** Type compatibility narrows
 * the candidates but cannot separate `Code` from `Description` — both are
 * strings. If two candidates both pass every rule we cannot tell which the
 * vendor meant, so we refuse rather than pick. Refusing sends it to *To review*
 * with its measurement, which is the right home for something we cannot settle.
 */
import { verifyFkCandidate, describeFkVerdict } from './fkVerification';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'referenceResolution' });

/** Matches `FK_TARGET_UNIQUENESS` in fkVerification — a key is near-unique. */
const TARGET_UNIQUENESS = Number(process.env.FK_TARGET_UNIQUENESS) || 0.99;

/** Wall-clock budget for one candidate measurement. */
const CANDIDATE_TIMEOUT_MS = Number(process.env.FK_RESOLVE_TIMEOUT_MS) || 15000;

export interface UnresolvedRef {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  rejectedColumn: string;
  candidates: string[];
}

export interface Resolved {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  containment: number;
}

interface Queryable {
  executeQuery(sql: string): Promise<{ rows: unknown[] }>;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Which of a table's columns are near-unique, in ONE query for the whole table.
 *
 * This is the difference between a workable step and an unaffordable one. Across
 * Exact Online's 35 unresolved references the type filter leaves 371 candidate
 * columns; measuring containment for each would be 371 queries. But "the target
 * must be a key" is a property of the COLUMN, not of the reference — thirteen
 * references into `PaymentConditions` share one answer — so uniqueness is
 * measured once per table and almost always leaves exactly one survivor.
 *
 * Returns null when the table cannot be read at all (not yet synced, or the
 * warehouse is empty), which is a refusal rather than an error: a reference we
 * cannot measure is one we must not claim.
 */
export async function keyLikeColumns(
  connector: Queryable,
  table: string,
  candidates: readonly string[],
): Promise<string[] | null> {
  if (candidates.length === 0) return [];
  const selects = candidates
    .map((c, i) => `COUNT(DISTINCT ${ident(c)}) AS d${i}`)
    .join(', ');
  try {
    const res = await connector.executeQuery(
      `SELECT COUNT(*) AS n, ${selects} FROM ${ident(table)}`,
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const rows = Number(row.n ?? row.N ?? 0);
    // An empty table proves nothing either way. Saying "no column is a key"
    // would be a claim; saying "we could not tell" is the truth.
    if (!Number.isFinite(rows) || rows === 0) return null;
    return candidates.filter((_, i) => {
      const d = Number(row[`d${i}`] ?? row[`D${i}`] ?? 0);
      return Number.isFinite(d) && d > 0 && d / rows >= TARGET_UNIQUENESS;
    });
  } catch (err) {
    log.warn({ err, table }, 'could not measure key columns — references into this table stay unresolved');
    return null;
  }
}

/**
 * Settle each reference, or refuse it.
 *
 * Refusal is silent to the user and loud in the log: the relationship simply is
 * not claimed at the documented rung, and the ordinary value-overlap detector
 * may still surface it into *To review*, where a person decides.
 */
export async function resolveDocumentedReferences(
  connector: Queryable,
  refs: readonly UnresolvedRef[],
): Promise<{ resolved: Resolved[]; refused: number; ambiguous: number }> {
  const resolved: Resolved[] = [];
  let refused = 0;
  let ambiguous = 0;
  if (refs.length === 0) return { resolved, refused, ambiguous };

  // One uniqueness probe per target table, shared by every reference into it.
  const byTarget = new Map<string, Set<string>>();
  for (const r of refs) {
    const set = byTarget.get(r.toTable) ?? new Set<string>();
    for (const c of r.candidates) set.add(c);
    byTarget.set(r.toTable, set);
  }
  const keysByTable = new Map<string, string[] | null>();
  for (const [table, cands] of byTarget) {
    keysByTable.set(table, await keyLikeColumns(connector, table, [...cands]));
  }

  for (const r of refs) {
    const keyCols = keysByTable.get(r.toTable);
    const viable = keyCols === null || keyCols === undefined
      ? []
      : r.candidates.filter((c) => keyCols.includes(c));
    const label = `${r.fromTable}.${r.fromColumn} → ${r.toTable}`;
    if (viable.length === 0) {
      refused += 1;
      log.info(`[FK docs] ${label}: no near-unique column of the right type — left to review`);
      continue;
    }

    const passing: Resolved[] = [];
    for (const cand of viable) {
      try {
        const v = await Promise.race([
          verifyFkCandidate(connector, r.fromTable, r.fromColumn, r.toTable, cand),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('resolve timeout')), CANDIDATE_TIMEOUT_MS)),
        ]);
        if (v.ok) {
          passing.push({
            fromTable: r.fromTable, fromColumn: r.fromColumn,
            toTable: r.toTable, toColumn: cand,
            containment: v.containment,
          });
        } else {
          log.debug(`[FK docs] ${label}.${cand}: ${describeFkVerdict(v)}`);
        }
      } catch (err) {
        log.warn({ err }, `[FK docs] ${label}.${cand}: measurement failed`);
      }
    }

    if (passing.length === 1) {
      resolved.push(passing[0]);
      log.info(
        `[FK docs] ${label}.${passing[0].toColumn} resolved by measurement `
        + `(${Math.round(passing[0].containment * 100)}% containment; the vendor's own `
        + `${r.rejectedColumn} does not fit by type)`,
      );
    } else if (passing.length > 1) {
      // Two columns that both look like the key. We cannot tell which the
      // vendor meant, and picking the higher containment would be exactly the
      // guess this whole mechanism exists to avoid.
      ambiguous += 1;
      log.info(
        `[FK docs] ${label}: ${passing.length} columns pass `
        + `(${passing.map((p) => p.toColumn).join(', ')}) — ambiguous, left to review`,
      );
    } else {
      refused += 1;
      log.info(`[FK docs] ${label}: no candidate column holds — left to review`);
    }
  }

  return { resolved, refused, ambiguous };
}

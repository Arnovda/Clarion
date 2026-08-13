/**
 * Match edges, phrased for the AI as identity assertions rather than joins.
 *
 * A `kind='match'` relationship says "rows on both sides describe the same
 * real-world things". That is NOT a foreign key, and it must not reach the model
 * looking like one: phrased as an ordinary relationship, the AI would emit a
 * JOIN, and joining two systems on an unverified key silently produces a wrong
 * total rather than an error.
 *
 * So the description says what it is, says what it is not, and carries the
 * measured match rate — because "87% matched" is the difference between a link
 * the model should lean on and one it should mention with a caveat.
 *
 * Read from Postgres, not Neo4j: `kind` and `measured` live only in Postgres
 * (migration 77), and a match spans two connections while
 * `getRelationshipsForContext` is scoped to one.
 */

import type { Knex } from 'knex';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'matchAssertions' });

export interface MatchAssertion {
  from_table: string;
  from_column: string | null;
  to_table: string;
  to_column: string | null;
  relationship_type: string;
  description: string;
}

interface Row {
  from_table: string;
  from_column: string | null;
  to_table: string;
  to_column: string | null;
  from_source: string | null;
  to_source: string | null;
  measured: unknown;
  description: string | null;
}

/** Phrase one match edge as a sentence the model cannot mistake for a join. */
export function phraseAssertion(row: Row): MatchAssertion {
  const rate = (() => {
    const m = typeof row.measured === 'string'
      ? (() => { try { return JSON.parse(row.measured as string); } catch { return null; } })()
      : row.measured as { matchRate?: number } | null;
    const r = m?.matchRate;
    return typeof r === 'number' ? Math.round(r * 100) : null;
  })();

  const where = row.from_source && row.to_source
    ? ` (${row.from_source} and ${row.to_source})`
    : '';

  const parts = [
    `IDENTITY LINK${where}: rows in ${row.from_table} and ${row.to_table} describe the SAME real-world`
    + ` entities, identified by ${row.from_column ?? '?'} and ${row.to_column ?? '?'}.`,
    rate != null ? `About ${rate}% of them line up.` : null,
    'This is NOT a foreign key. Do not JOIN on it as if one table referenced the other;'
    + ' use it only to explain that the two sources describe the same things.',
    row.description ? `The user says: ${row.description}` : null,
  ].filter(Boolean);

  return {
    from_table: row.from_table,
    from_column: row.from_column,
    to_table: row.to_table,
    to_column: row.to_column,
    // Deliberately not one of the cardinality values a join uses — a model
    // pattern-matching on relationship_type must not find something joinable.
    relationship_type: 'same_entity_as',
    description: parts.join(' '),
  };
}

/**
 * Every confirmed match edge with at least one leg in `connectionId`.
 *
 * Only confirmed ones: an unreviewed AI guess about identity is exactly the kind
 * of thing that should not be shaping answers before a human has looked at it.
 */
export async function getMatchAssertions(
  db: Knex,
  tenantId: number | undefined,
  connectionId: number,
): Promise<MatchAssertion[]> {
  if (!tenantId) return [];
  try {
    const rows: Row[] = await db('table_relationships as r')
      .join('source_tables as ft', 'r.from_table_id', 'ft.id')
      .join('source_tables as tt', 'r.to_table_id', 'tt.id')
      .leftJoin('source_columns as fc', 'r.from_column_id', 'fc.id')
      .leftJoin('source_columns as tc', 'r.to_column_id', 'tc.id')
      .leftJoin('connections as fs', 'ft.connection_id', 'fs.id')
      .leftJoin('connections as ts', 'tt.connection_id', 'ts.id')
      .where('r.tenant_id', tenantId)
      .andWhere('r.kind', 'match')
      .andWhere('r.confirmed_by_user', true)
      .andWhere(function () {
        this.where('ft.connection_id', connectionId).orWhere('tt.connection_id', connectionId);
      })
      .select(
        'ft.table_name as from_table', 'fc.column_name as from_column',
        'tt.table_name as to_table', 'tc.column_name as to_column',
        'fs.name as from_source', 'ts.name as to_source',
        'r.measured', 'r.description',
      );
    return rows.map(phraseAssertion);
  } catch (err) {
    // Context enrichment must never be the reason a design run fails. Losing an
    // assertion degrades the answer; throwing loses the whole request.
    log.warn({ err, connectionId }, 'could not load match assertions');
    return [];
  }
}

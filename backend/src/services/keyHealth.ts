/**
 * How the keys of a workspace's product tables are made — read off the SQL
 * the build actually runs — and what that allows.
 *
 * The rule (packages/connectors/src/keys.ts): a lookup's key is
 * `clarion_key('<Entity>', <source id>)`, a stable BIGINT, and a fact computes
 * the same call on its own column. Tables built before 2026-09-24 have one of
 * two older forms:
 *
 *   - UNSTABLE: `ROW_NUMBER() OVER (ORDER BY …) AS x_key`. Rebuilding such a
 *     lookup ALONE renumbers it while the facts keep the old numbers — rows
 *     move to the neighbouring customer, no error anywhere. Its facts can only
 *     have got the key by joining the lookup at their own build time.
 *   - RAW: the source id itself (`a.ID AS x_key`, phase 1). Stable — a lone
 *     rebuild is safe — but a GUID join is twice as slow and 7.5× bigger.
 *
 * This service is the one reader of that state, used by the declaration route
 * (a save must not make the two ends of a join disagree), the run guard (a
 * lone rebuild of an UNSTABLE lookup is refused), the Build page (the upgrade
 * offer) and the upgrade workflow itself. Every query filters `tenant_id`
 * explicitly (the reqDb pool-race rule).
 */
import type { Knex } from 'knex';
import { tenantQuery } from './tenantQuery';
import {
  keyFormOf,
  keyRuleViolations,
  isDateDimension,
  type KeyForm,
  type KeyRuleJoin,
  type KeyRuleTable,
} from '@databridge/connectors/dist/keys';

export interface KeyTableRow {
  id: number;
  table_name: string;
  table_role: string | null;
  transformation_sql: string | null;
  product_id: number;
  product_name: string;
  connection_id: number | null;
  columns: Array<{ id: number; column_name: string; column_role: string | null; transformation_expression: string | null; data_type: string | null; fk_target_table: string | null; fk_target_column: string | null }>;
}

export interface KeyJoinRow extends KeyRuleJoin {
  from_table_id: number;
  to_table_id: number;
}

export interface KeyGraph {
  /** Originals only — a copy of a shared lookup resolves to the table it copies. */
  tables: KeyTableRow[];
  /** Joins between originals, deduplicated (a join recorded in two subjects is one join). */
  joins: KeyJoinRow[];
}

/**
 * Every original product table of one connection, with its key-relevant
 * columns and every join that touches it (from any subject of the tenant —
 * a lookup's joins are recorded in the subjects that USE it).
 */
export async function loadKeyGraph(
  db: Knex | Knex.Transaction,
  tenantId: number,
  connectionId: number,
): Promise<KeyGraph> {
  const all: Array<{
    id: number; table_name: string; table_role: string | null; transformation_sql: string | null;
    source_product_table_id: number | null; is_shared_dimension: boolean | null;
    product_id: number; product_name: string; connection_id: number | null;
  }> = await db('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .where('dp.tenant_id', tenantId)
    .andWhere('dp.connection_id', connectionId)
    .select(
      'pt.id', 'pt.table_name', 'pt.table_role', 'pt.transformation_sql',
      'pt.source_product_table_id', 'pt.is_shared_dimension',
      'dp.id as product_id', 'dp.name as product_name', 'dp.connection_id',
    );

  // A copy (a stub of a shared lookup) has no SQL of its own: its key is its
  // original's key. Resolve every id to the table that really builds it.
  const realOf = new Map<number, number>();
  for (const t of all) realOf.set(Number(t.id), Number(t.source_product_table_id ?? t.id));
  const originals = all.filter((t) => !t.source_product_table_id && !(t.is_shared_dimension && !t.transformation_sql));
  const originalIds = new Set(originals.map((t) => Number(t.id)));
  // A copy whose pointer was never written (pre-migration-102) is not an
  // original either; resolve it by name to the original on this connection.
  const byName = new Map(originals.map((t) => [t.table_name.toLowerCase(), Number(t.id)]));
  for (const t of all) {
    const id = Number(t.id);
    if (!originalIds.has(id) && !t.source_product_table_id) {
      const named = byName.get(t.table_name.toLowerCase());
      if (named) realOf.set(id, named);
    }
  }

  const ids = originals.map((t) => Number(t.id));
  const cols: Array<KeyTableRow['columns'][number] & { product_table_id: number }> = ids.length === 0 ? [] : await db('product_columns as pc')
    .join('product_tables as pt', 'pt.id', 'pc.product_table_id')
    .whereIn('pc.product_table_id', ids)
    .andWhere('pt.tenant_id', tenantId)
    .select('pc.id', 'pc.product_table_id', 'pc.column_name', 'pc.column_role', 'pc.transformation_expression', 'pc.data_type', 'pc.fk_target_table', 'pc.fk_target_column');
  const colsOf = new Map<number, KeyTableRow['columns']>();
  for (const c of cols) {
    const list = colsOf.get(Number(c.product_table_id)) ?? [];
    list.push({
      id: Number(c.id), column_name: c.column_name, column_role: c.column_role, transformation_expression: c.transformation_expression,
      data_type: c.data_type, fk_target_table: c.fk_target_table, fk_target_column: c.fk_target_column,
    });
    colsOf.set(Number(c.product_table_id), list);
  }

  const allIds = [...realOf.keys()];
  const rels: Array<{ from_table_id: number; to_table_id: number; from_column_name: string; to_column_name: string }> = allIds.length === 0 ? [] : await db('product_relationships as pr')
    .join('star_schemas as ss', 'ss.id', 'pr.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .where('dp.tenant_id', tenantId)
    .andWhere((qb) => { qb.whereIn('pr.from_table_id', allIds).orWhereIn('pr.to_table_id', allIds); })
    .select('pr.from_table_id', 'pr.to_table_id', 'pr.from_column_name', 'pr.to_column_name');

  const nameOf = new Map(originals.map((t) => [Number(t.id), t.table_name]));
  const joins: KeyJoinRow[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    const from = realOf.get(Number(r.from_table_id));
    const to = realOf.get(Number(r.to_table_id));
    if (from == null || to == null || !nameOf.has(from) || !nameOf.has(to)) continue;
    const k = `${from}.${r.from_column_name}>${to}.${r.to_column_name}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    joins.push({
      from_table_id: from, to_table_id: to,
      from_table: nameOf.get(from)!, from_column: r.from_column_name,
      to_table: nameOf.get(to)!, to_column: r.to_column_name,
    });
  }

  return {
    tables: originals.map((t) => ({
      id: Number(t.id), table_name: t.table_name, table_role: t.table_role, transformation_sql: t.transformation_sql,
      product_id: Number(t.product_id), product_name: t.product_name, connection_id: t.connection_id == null ? null : Number(t.connection_id),
      columns: colsOf.get(Number(t.id)) ?? [],
    })),
    joins,
  };
}

function asRuleTable(t: KeyTableRow, sqlOverride?: string): KeyRuleTable {
  return {
    table_name: t.table_name,
    table_role: t.table_role,
    transformation_sql: sqlOverride ?? t.transformation_sql,
    columns: t.columns.map((c) => ({ column_name: c.column_name, column_role: c.column_role, transformation_expression: c.transformation_expression })),
  };
}

/**
 * Would saving `newSql` on this table break a join? Consistent mode: a legacy
 * table keeps saving while its partner is legacy too; an unstable key, or
 * switching ONE end of a join to clarion_key alone, is refused.
 */
export function declarationKeyViolations(graph: KeyGraph, tableId: number, newSql: string): string[] {
  const table = graph.tables.find((t) => t.id === tableId);
  if (!table) return [];
  return keyRuleViolations(
    graph.tables.map((t) => asRuleTable(t, t.id === tableId ? newSql : undefined)),
    graph.joins,
    { mode: 'consistent', onlyTables: [table.table_name] },
  );
}

export type KeyStatus = 'hashed' | 'raw' | 'unstable' | 'no-key';

export interface TableKeyHealth {
  id: number;
  table_name: string;
  table_role: string | null;
  product_id: number;
  product_name: string;
  status: KeyStatus;
  /** Key columns and how each is made. */
  keys: Array<{ column: string; role: string; form: KeyForm }>;
}

/** Per key column, how it is made; per table, the worst of them. */
export function tableKeyHealth(t: KeyTableRow): TableKeyHealth {
  const keys = t.columns
    .filter((c) => c.column_role === 'surrogate_key' || c.column_role === 'foreign_key')
    .filter((c) => !(c.column_role === 'surrogate_key' && isDateDimension(t.table_name)))
    .filter((c) => !(c.column_role === 'foreign_key' && c.fk_target_table && isDateDimension(c.fk_target_table)))
    .map((c) => ({ column: c.column_name, role: c.column_role as string, form: keyFormOf(t.transformation_sql, c.column_name, c.transformation_expression) }));
  let status: KeyStatus = keys.length === 0 ? 'no-key' : 'hashed';
  for (const k of keys) {
    if (k.form.kind === 'unstable') { status = 'unstable'; break; }
    if (k.form.kind !== 'hashed') status = 'raw';
  }
  return {
    id: t.id, table_name: t.table_name, table_role: t.table_role,
    product_id: t.product_id, product_name: t.product_name, status, keys,
  };
}

export interface ConnectionKeyHealth {
  /** Tables whose keys renumber on every build — a lone rebuild corrupts the facts. */
  unstable: TableKeyHealth[];
  /** Tables whose keys are the raw source id — safe, but slow joins. */
  raw: TableKeyHealth[];
  /** Tables already on clarion_key. */
  hashed: number;
  /** Lookups with no surrogate key at all (first-generation connector templates): a Rebuild moves them. */
  noKey: TableKeyHealth[];
}

export function summariseKeyHealth(graph: KeyGraph): ConnectionKeyHealth {
  const out: ConnectionKeyHealth = { unstable: [], raw: [], hashed: 0, noKey: [] };
  for (const t of graph.tables) {
    if (isDateDimension(t.table_name)) continue;
    const h = tableKeyHealth(t);
    if (h.status === 'unstable') out.unstable.push(h);
    else if (h.status === 'raw') out.raw.push(h);
    else if (h.status === 'hashed') out.hashed++;
    else if (t.table_role === 'dimension' && graph.joins.some((j) => j.to_table_id === t.id)) out.noKey.push(h);
  }
  return out;
}

/**
 * The tables that must be rebuilt together with this one, because they hold
 * its keys: every table with a join INTO it. Empty for a fact.
 */
export function dependentsOf(graph: KeyGraph, tableId: number): KeyTableRow[] {
  const ids = new Set(graph.joins.filter((j) => j.to_table_id === tableId && j.from_table_id !== tableId).map((j) => j.from_table_id));
  return graph.tables.filter((t) => ids.has(t.id));
}

/**
 * Why rebuilding these tables WITHOUT the rest would corrupt joins — null when
 * it is safe. A lookup whose key renumbers per build is safe to rebuild only
 * together with every table holding its keys.
 */
export function loneRebuildRefusal(graph: KeyGraph, tableIds: readonly number[]): string | null {
  const inRun = new Set(tableIds);
  for (const id of tableIds) {
    const t = graph.tables.find((x) => x.id === id);
    if (!t) continue;
    if (tableKeyHealth(t).status !== 'unstable') continue;
    const outside = dependentsOf(graph, id).filter((d) => !inRun.has(d.id));
    if (outside.length === 0) continue;
    const names = [...new Set(outside.map((d) => `${d.table_name} (${d.product_name})`))].slice(0, 4).join(', ');
    return `${t.table_name} numbers its keys on every build, so rebuilding it on its own would point ${names} at the wrong rows. `
      + 'Upgrade the keys once (Build → "Upgrade keys") — after that any table can be rebuilt on its own.';
  }
  return null;
}

/**
 * The same refusal for a run of whole SUBJECTS (a pipeline, a scheduled
 * transformation): every table of `productIds` is in the run; a renumbering
 * lookup whose dependents are outside it is refused. Null = safe.
 */
export async function unstableKeyRefusalForProducts(
  tenantId: number,
  productIds: readonly number[],
): Promise<string | null> {
  if (productIds.length === 0) return null;
  const connIds = await tenantQuery(tenantId, (db) => db('data_products')
    .whereIn('id', [...productIds]).andWhere('tenant_id', tenantId).whereNotNull('connection_id')
    .distinct('connection_id')) as Array<{ connection_id: number }>;
  const inRun = new Set(productIds.map(Number));
  for (const c of connIds) {
    const graph = await tenantQuery(tenantId, (db) => loadKeyGraph(db, tenantId, Number(c.connection_id)));
    const refusal = loneRebuildRefusal(graph, graph.tables.filter((t) => inRun.has(t.product_id)).map((t) => t.id));
    if (refusal) return refusal;
  }
  return null;
}

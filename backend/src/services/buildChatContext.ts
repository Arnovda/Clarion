/**
 * Coverage context for the Build page's "Ask about your subjects" chat.
 *
 * Assembles, from the real catalog, everything the chat model may state as
 * fact: the built subjects (with their metrics, questions and tables), the
 * synced source tables (with measured row counts), and which subject reads
 * which table — so "Quotations isn't part of any subject yet" is a database
 * answer, never a guess.
 *
 * Every query filters tenant_id EXPLICITLY (the reqDb pool-race rule, same
 * as buildOverview): the caller passes a Knex instance, but an authorisation
 * or scoping decision must not depend on which pooled connection it lands on.
 */

import type { Knex } from 'knex';

export interface CoverageContext {
  /** The prompt-ready text block. */
  text: string;
  /** Connection ids in scope — for validating a proposal's connection_id. */
  connectionIds: Set<number>;
  /** Synced table names per connection — for validating proposal entities. */
  syncedTablesByConnection: Map<number, Set<string>>;
  /** Existing product names (lowercased) — a proposal must not collide. */
  productNamesLower: Set<string>;
}

const trim = (s: unknown, max: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export async function buildCoverageContext(db: Knex, tenantId: number): Promise<CoverageContext> {
  const [connections, sourceTables, products, kpis, productSources, productTables, profiles] = await Promise.all([
    db('connections').where({ tenant_id: tenantId }).select('id', 'name', 'connector_type'),
    db('source_tables').where({ tenant_id: tenantId, is_active: true })
      .select('id', 'connection_id', 'table_name', 'display_name', 'description'),
    db('data_products').where({ tenant_id: tenantId })
      .select('id', 'name', 'description', 'kind', 'hidden', 'connection_id'),
    db('product_kpis as pk')
      .join('data_products as dp', 'pk.data_product_id', 'dp.id')
      .where('dp.tenant_id', tenantId)
      .select('pk.data_product_id', 'pk.name', 'pk.question_text'),
    db('data_product_sources as dps')
      .join('data_products as dp', 'dps.data_product_id', 'dp.id')
      .where('dp.tenant_id', tenantId)
      .select('dps.data_product_id', 'dps.table_name'),
    db('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where('dp.tenant_id', tenantId)
      .where('pt.is_shared_dimension', false)
      .select('dp.id as product_id', 'pt.display_name'),
    db('dataset_profiles')
      .where({ tenant_id: tenantId })
      .whereNotNull('row_count')
      .orderBy('profiled_at', 'asc')
      .select('connection_id', 'table_name', 'row_count'),
  ]);

  // Ascending order → the latest profile per (connection, table) wins.
  const rowCount = new Map<string, number>();
  for (const p of profiles as Array<{ connection_id: number; table_name: string; row_count: number }>) {
    rowCount.set(`${p.connection_id}|${p.table_name}`, Number(p.row_count));
  }

  const kpisByProduct = new Map<number, Array<{ name: string; question_text: string | null }>>();
  for (const k of kpis as Array<{ data_product_id: number; name: string; question_text: string | null }>) {
    const list = kpisByProduct.get(k.data_product_id) ?? [];
    list.push(k);
    kpisByProduct.set(k.data_product_id, list);
  }

  const tablesByProduct = new Map<number, string[]>();
  for (const t of productTables as Array<{ product_id: number; display_name: string | null }>) {
    if (!t.display_name) continue;
    const list = tablesByProduct.get(t.product_id) ?? [];
    if (!list.includes(t.display_name)) list.push(t.display_name);
    tablesByProduct.set(t.product_id, list);
  }

  const productsBySourceTable = new Map<string, string[]>();
  const productNameById = new Map<number, string>();
  for (const p of products as Array<{ id: number; name: string }>) productNameById.set(p.id, p.name);
  for (const ps of productSources as Array<{ data_product_id: number; table_name: string }>) {
    const pname = productNameById.get(ps.data_product_id);
    if (!pname) continue;
    const list = productsBySourceTable.get(ps.table_name) ?? [];
    if (!list.includes(pname)) list.push(pname);
    productsBySourceTable.set(ps.table_name, list);
  }

  const lines: string[] = [];

  const analytics = (products as Array<{ id: number; name: string; description: string | null; kind: string | null; hidden: boolean | null }>)
    .filter((p) => (p.kind ?? 'analytics') === 'analytics');
  const reference = (products as Array<{ id: number; name: string; kind: string | null }>)
    .filter((p) => p.kind === 'reference');

  lines.push('YOUR SUBJECTS (built topics):');
  if (analytics.length === 0) {
    lines.push('  (none built yet)');
  }
  for (const p of analytics) {
    lines.push(`- ${p.name}${p.hidden === true ? ' (hidden — the eye toggle on Build shows it back)' : ''} — ${trim(p.description, 140) || 'no description'}`);
    const tbls = tablesByProduct.get(p.id) ?? [];
    if (tbls.length) lines.push(`  Contains: ${tbls.slice(0, 10).join(', ')}`);
    const pk = (kpisByProduct.get(p.id) ?? []).slice(0, 8);
    if (pk.length) {
      lines.push(`  Metrics: ${pk.map((k) => k.question_text ? `${k.name} ("${trim(k.question_text, 70)}")` : k.name).join('; ')}`);
    }
  }
  if (reference.length > 0) {
    lines.push(`SHARED DATA (lookups every subject can slice by): ${reference.map((p) => (tablesByProduct.get(p.id) ?? []).join(', ') || p.name).join(', ')}`);
  }

  const connectionIds = new Set<number>();
  const syncedTablesByConnection = new Map<number, Set<string>>();

  for (const conn of connections as Array<{ id: number; name: string; connector_type: string | null }>) {
    connectionIds.add(conn.id);
    const tables = (sourceTables as Array<{ connection_id: number; table_name: string; display_name: string | null; description: string | null }>)
      .filter((t) => t.connection_id === conn.id);
    const nameSet = new Set(tables.map((t) => t.table_name));
    syncedTablesByConnection.set(conn.id, nameSet);
    if (tables.length === 0) continue;

    lines.push('');
    lines.push(`SOURCE: ${conn.name} (connection_id ${conn.id}) — synced tables:`);
    for (const t of tables.slice(0, 80)) {
      const rc = rowCount.get(`${conn.id}|${t.table_name}`);
      const rcNote = rc === undefined ? '' : rc === 0 ? ' (NO ROWS — synced but empty)' : ` (~${rc} rows)`;
      const used = productsBySourceTable.get(t.table_name);
      const usedNote = used?.length ? ` — used by: ${used.join(', ')}` : ' — not part of any subject yet';
      lines.push(`- ${t.table_name}${rcNote}${usedNote}`);
    }
    if (tables.length > 80) lines.push(`  (+${tables.length - 80} more tables not listed)`);
  }

  return {
    text: lines.join('\n'),
    connectionIds,
    syncedTablesByConnection,
    productNamesLower: new Set((products as Array<{ name: string }>).map((p) => p.name.trim().toLowerCase())),
  };
}

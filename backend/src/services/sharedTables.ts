/**
 * Shared tables — a copy row and the original it stands for.
 *
 * When a subject uses a lookup another subject owns (Purchasing uses the
 * Journal that Reference builds), the build writes a COPY row into the using
 * subject's star schema: `is_shared_dimension = true`, no SQL, the columns
 * copied. The copy is load-bearing — relationships, the runner's dependency
 * loading and the topics graph all key on it — but it is not a table in its
 * own right. Everything a person or the model reads about it must come from
 * the original.
 *
 * `product_tables.source_product_table_id` is the pointer from copy to
 * original. Migration 31 created it in April 2026 and four readers were built
 * on it (the SQL tab's "built once in …", the refusal to save SQL on a copy,
 * the subject payload's owner enrichment, the quality resolver) — and nothing
 * ever WROTE it, so all four silently fell back to the empty copy. This module
 * is the one writer.
 *
 * WHY A SQL UPDATE AFTER THE BUILD INSTEAD OF ONLY SETTING IT ON INSERT. The
 * builder does set it on insert when the original is part of the same build.
 * But three cases have the original somewhere else: an addition from the Build
 * chat (the original is in a subject built earlier), a rebuild that retired
 * the original (the FK is ON DELETE SET NULL, so a copy in a subject outside
 * the rebuild loses its pointer the moment its original is deleted), and every
 * copy written before this existed. Linking by name at the end of each build
 * covers all three with one rule, and it is idempotent — it only touches
 * copies that have no pointer.
 */
import type { Knex } from 'knex';

/**
 * The rule, in SQL, shared by `linkSharedTables` and migration 102 so the
 * backfill and the build cannot drift apart.
 *
 * A copy's original is a row in the SAME tenant with the SAME table name that
 * is not itself a copy, and that the copy's subject can actually reach: on the
 * same source, or in a subject it declares a dependency on (dependencies are
 * what the runner loads shared lookups through, and they are not bound to a
 * connection). When several qualify, a declared dependency wins, then a row
 * that has SQL (it builds something), then the oldest.
 *
 * Placeholders, in order: tenant id, then connection id or NULL (NULL = every
 * connection of the tenant).
 */
export const LINK_SHARED_TABLES_SQL = `
UPDATE product_tables AS stub
   SET source_product_table_id = pick.owner_id,
       updated_at = NOW()
  FROM (
    SELECT DISTINCT ON (s.id) s.id AS stub_id, o.id AS owner_id
      FROM product_tables s
      JOIN star_schemas ss ON ss.id = s.star_schema_id
      JOIN data_products sp ON sp.id = ss.data_product_id
      JOIN product_tables o
        ON o.table_name = s.table_name
       AND o.id <> s.id
       AND COALESCE(o.is_shared_dimension, false) = false
      JOIN star_schemas os ON os.id = o.star_schema_id
      JOIN data_products op ON op.id = os.data_product_id
     WHERE s.is_shared_dimension = true
       AND s.source_product_table_id IS NULL
       AND sp.tenant_id = ?
       AND op.tenant_id = sp.tenant_id
       AND (?::integer IS NULL OR sp.connection_id = ?::integer)
       AND (
             op.connection_id = sp.connection_id
          OR EXISTS (
               SELECT 1 FROM data_product_dependencies d
                WHERE d.dependent_product_id = sp.id
                  AND d.source_product_id = op.id
             )
       )
     ORDER BY s.id,
       (EXISTS (
          SELECT 1 FROM data_product_dependencies d
           WHERE d.dependent_product_id = sp.id
             AND d.source_product_id = op.id
       )) DESC,
       (o.transformation_sql IS NOT NULL) DESC,
       o.id ASC
  ) AS pick
 WHERE stub.id = pick.stub_id
`;

/**
 * Point every unlinked copy at its original. Returns how many copies were
 * linked. Runs inside the caller's transaction when given one, so a build's
 * copies are linked in the same commit that creates them.
 *
 * `tenantId` is required: this writes across products, and the tenant filter
 * is the authorisation statement (RLS would AND its own predicate on top, but
 * a cross-product write must never depend on the session variable alone).
 */
export async function linkSharedTables(
  db: Knex | Knex.Transaction,
  tenantId: number,
  connectionId?: number | null,
): Promise<number> {
  const conn = connectionId ?? null;
  const result = await db.raw(LINK_SHARED_TABLES_SQL, [tenantId, conn, conn]);
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}

/**
 * Whether a product table is a copy, and of what. `ownerTableId` is null for
 * an original, and for a copy nothing could link yet (its original was never
 * built) — callers must treat that second case as "a copy with no original",
 * not as an original.
 */
export interface SharedTableInfo {
  isCopy: boolean;
  ownerTableId: number | null;
}

export function sharedTableInfo(row: {
  is_shared_dimension?: boolean | null;
  source_product_table_id?: number | null;
}): SharedTableInfo {
  const owner = row.source_product_table_id != null ? Number(row.source_product_table_id) : null;
  return { isCopy: row.is_shared_dimension === true || owner != null, ownerTableId: owner };
}

/**
 * If `id` names a COPY of a shared lookup — the table itself, or one of its
 * columns — return where its original lives; otherwise null. Used to REFUSE
 * edits on a copy: a description changed on Purchasing's Journal would land on
 * the copy, never reach the original, and fork one definition into two.
 *
 * `id` may be either id space (`id` or the graph-minted `neo4j_pg_id`), the
 * same rule as the ownership gate. Explicit tenant filter throughout.
 */
export async function sharedOriginalOf(
  db: Knex | Knex.Transaction,
  tenantId: number,
  kind: 'product_tables' | 'product_columns',
  id: number,
): Promise<{ tableId: number | null; productId: number | null; productName: string | null } | null> {
  // A malformed id is not a copy — and must not reach an integer comparison.
  if (!Number.isInteger(id) || id <= 0) return null;
  let tableRow: { id: number; is_shared_dimension: boolean | null; source_product_table_id: number | null } | undefined;
  if (kind === 'product_columns') {
    tableRow = await db('product_columns as pc')
      .join('product_tables as pt', 'pt.id', 'pc.product_table_id')
      .where((qb) => { qb.where('pc.id', id).orWhere('pc.neo4j_pg_id', id); })
      .andWhere('pt.tenant_id', tenantId)
      .first('pt.id', 'pt.is_shared_dimension', 'pt.source_product_table_id');
  } else {
    tableRow = await db('product_tables as pt')
      .where((qb) => { qb.where('pt.id', id).orWhere('pt.neo4j_pg_id', id); })
      .andWhere('pt.tenant_id', tenantId)
      .first('pt.id', 'pt.is_shared_dimension', 'pt.source_product_table_id');
  }
  if (!tableRow || !sharedTableInfo(tableRow).isCopy) return null;
  if (tableRow.source_product_table_id == null) return { tableId: null, productId: null, productName: null };
  const owner = await db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .where('pt.id', tableRow.source_product_table_id)
    .andWhere('dp.tenant_id', tenantId)
    .first('pt.id as table_id', 'dp.id as product_id', 'dp.name as product_name');
  return owner
    ? { tableId: Number(owner.table_id), productId: Number(owner.product_id), productName: String(owner.product_name) }
    : { tableId: null, productId: null, productName: null };
}

/** The sentence a refused edit on a copy answers with. */
export function sharedEditRefusal(original: { productName: string | null }): string {
  return original.productName
    ? `This table is shared from ${original.productName} — change it there.`
    : 'This table is shared from another subject — change it there.';
}

/**
 * SQL predicate: `alias` is an ORIGINAL (not a copy of a shared lookup). For
 * listings that must show each table once — the catalog tree, search.
 */
export function originalTableSql(alias: string): string {
  return `(COALESCE(${alias}.is_shared_dimension, false) = false AND ${alias}.source_product_table_id IS NULL)`;
}

/**
 * The joins a subject's tables take part in ELSEWHERE.
 *
 * A lookup's joins are recorded where they are used: Sales' star schema holds
 * `fact_sales_invoice_lines.item_key → dim_item.item_key`, with `dim_item`
 * being Sales' COPY of the Item that Reference builds. Reference's own star
 * holds none of them — so read from Reference alone, every lookup "joins to
 * nothing yet", which is exactly wrong: they are the most-joined tables there
 * are. This finds every relationship, in any other subject of the tenant,
 * with an end on a copy of one of `productId`'s originals, and resolves the
 * other end to where that table really lives (a copy of a third subject's
 * lookup resolves to its original).
 *
 * Table names are shared by a copy and its original, so the relationships
 * come back in the same shape the subject payload already uses — by name —
 * and the other-subject tables come back beside them, each naming its
 * subject. Explicit tenant filter throughout.
 */
export interface ExternalJoinTable {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  subject_id: number;
  subject_name: string;
}
export interface ExternalJoin {
  id: number;
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: string;
  /** The subject whose star records this join. */
  in_subject_id: number;
  in_subject_name: string;
  /** Which of this subject's tables it touches — to group it under its star. */
  own_table_id: number;
  /** The table on the other end, or null when both ends are this subject's own. */
  other_table_id: number | null;
  /** The endpoint pairs, as (real table id, column), for the diagram's join fields. */
  endpoints: Array<{ tableId: number; column: string }>;
}

export async function loadExternalJoins(
  db: Knex | Knex.Transaction,
  tenantId: number,
  productId: number,
): Promise<{ tables: ExternalJoinTable[]; joins: ExternalJoin[] }> {
  const empty = { tables: [] as ExternalJoinTable[], joins: [] as ExternalJoin[] };

  // This subject's originals.
  const originals: Array<{ id: number; table_name: string }> = await db('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .where('dp.id', productId)
    .andWhere('dp.tenant_id', tenantId)
    .whereRaw(originalTableSql('pt'))
    .select('pt.id', 'pt.table_name');
  if (originals.length === 0) return empty;
  const ownIds = new Set(originals.map((o) => Number(o.id)));

  // Their copies in other subjects.
  const copies: Array<{ id: number; owner_id: number }> = await db('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .whereIn('pt.source_product_table_id', [...ownIds])
    .andWhere('dp.tenant_id', tenantId)
    .andWhereNot('dp.id', productId)
    .select('pt.id', 'pt.source_product_table_id as owner_id');
  if (copies.length === 0) return empty;
  const ownerOfCopy = new Map(copies.map((c) => [Number(c.id), Number(c.owner_id)]));
  const copyIds = [...ownerOfCopy.keys()];

  const rels: Array<{
    id: number; from_table_id: number; to_table_id: number;
    from_column_name: string; to_column_name: string; relationship_type: string;
    in_subject_id: number; in_subject_name: string;
  }> = await db('product_relationships as pr')
    .join('star_schemas as ss', 'ss.id', 'pr.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .where('dp.tenant_id', tenantId)
    .andWhereNot('dp.id', productId)
    .andWhere((qb) => { qb.whereIn('pr.from_table_id', copyIds).orWhereIn('pr.to_table_id', copyIds); })
    .select(
      'pr.id', 'pr.from_table_id', 'pr.to_table_id', 'pr.from_column_name', 'pr.to_column_name',
      'pr.relationship_type', 'dp.id as in_subject_id', 'dp.name as in_subject_name',
    )
    .orderBy('pr.id');
  if (rels.length === 0) return empty;

  // Every endpoint, with where it really lives: a copy resolves to its
  // original (ours or a third subject's), anything else is itself.
  const endIds = new Set<number>();
  for (const r of rels) { endIds.add(Number(r.from_table_id)); endIds.add(Number(r.to_table_id)); }
  const endRows: Array<{ id: number; source_product_table_id: number | null }> = await db('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .whereIn('pt.id', [...endIds])
    .andWhere('dp.tenant_id', tenantId)
    .select('pt.id', 'pt.source_product_table_id');
  const realOf = new Map<number, number>();
  for (const e of endRows) realOf.set(Number(e.id), Number(e.source_product_table_id ?? e.id));

  const realIds = new Set<number>([...realOf.values()]);
  const realRows: Array<{
    id: number; table_name: string; display_name: string | null; description: string | null;
    table_role: string; subject_id: number; subject_name: string;
  }> = await db('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .whereIn('pt.id', [...realIds])
    .andWhere('dp.tenant_id', tenantId)
    .select(
      'pt.id', 'pt.table_name', 'pt.display_name', 'pt.description', 'pt.table_role',
      'dp.id as subject_id', 'dp.name as subject_name',
    );
  const real = new Map(realRows.map((r) => [Number(r.id), r]));

  const tables = new Map<number, ExternalJoinTable>();
  const joins: ExternalJoin[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    const fromReal = realOf.get(Number(r.from_table_id));
    const toReal = realOf.get(Number(r.to_table_id));
    if (fromReal == null || toReal == null) continue;
    const from = real.get(fromReal);
    const to = real.get(toReal);
    if (!from || !to) continue;
    const fromOwn = ownIds.has(fromReal);
    const toOwn = ownIds.has(toReal);
    if (!fromOwn && !toOwn) continue;
    // The same join is often recorded in several subjects (every subject that
    // uses both tables): list it once.
    const key = `${fromReal}.${r.from_column_name}>${toReal}.${r.to_column_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const other = fromOwn && toOwn ? null : (fromOwn ? to : from);
    if (other) {
      tables.set(Number(other.id), {
        id: Number(other.id), table_name: other.table_name, display_name: other.display_name,
        description: other.description, table_role: other.table_role,
        subject_id: Number(other.subject_id), subject_name: other.subject_name,
      });
    }
    joins.push({
      id: Number(r.id),
      from_table_name: from.table_name,
      from_column_name: r.from_column_name,
      to_table_name: to.table_name,
      to_column_name: r.to_column_name,
      relationship_type: r.relationship_type,
      in_subject_id: Number(r.in_subject_id),
      in_subject_name: r.in_subject_name,
      own_table_id: fromOwn ? fromReal : toReal,
      other_table_id: other ? Number(other.id) : null,
      endpoints: [
        { tableId: fromReal, column: r.from_column_name },
        { tableId: toReal, column: r.to_column_name },
      ],
    });
  }
  return { tables: [...tables.values()], joins };
}

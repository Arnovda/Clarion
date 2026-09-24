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

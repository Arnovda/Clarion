/**
 * productGraphSync.ts — Syncs product tables/columns from Postgres to Neo4j.
 * Called after design, transformation runs, and deletion.
 */

import { semanticDb } from '../db/knex';
import * as graph from '../db/semanticGraph';
import { nextPgId } from '../db/semanticGraph';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'productGraphSync' });

/**
 * Sync a data product's tables and columns to Neo4j.
 * - Allocates neo4j_pg_id for any rows that don't have one yet.
 * - Upserts ProductTable / ProductColumn nodes in Neo4j.
 * - Removes orphaned Neo4j nodes.
 */
export async function syncProductToNeo4j(productId: number): Promise<void> {
  try {
    const product = await semanticDb('data_products').where({ id: productId }).first();
    if (!product) return;

    const schemas = await semanticDb('star_schemas').where({ data_product_id: productId });
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    if (!schemaIds.length) {
      // Product has no schemas — remove any leftover Neo4j nodes
      await graph.deleteProductGraph(productId);
      return;
    }

    const tables = await semanticDb('product_tables').whereIn('star_schema_id', schemaIds);
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await semanticDb('product_columns')
          .whereIn('product_table_id', tableIds)
          // Don't sync technical columns to Neo4j — they're physical-storage
          // metadata, not semantic, and would clutter the graph.
          .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
      : [];

    // Allocate neo4j_pg_id for tables that don't have one
    for (const table of tables) {
      if (!table.neo4j_pg_id) {
        const pgId = await nextPgId();
        await semanticDb('product_tables').where({ id: table.id }).update({ neo4j_pg_id: pgId });
        table.neo4j_pg_id = pgId;
      }
    }

    // Allocate neo4j_pg_id for columns that don't have one
    for (const col of columns) {
      if (!col.neo4j_pg_id) {
        const pgId = await nextPgId();
        await semanticDb('product_columns').where({ id: col.id }).update({ neo4j_pg_id: pgId });
        col.neo4j_pg_id = pgId;
      }
    }

    // Build lookup: postgres table id → neo4j pgId
    const tableIdToPgId = new Map<number, number>();
    for (const t of tables) {
      tableIdToPgId.set(t.id, t.neo4j_pg_id);
    }

    // Map tables for upsert
    const mappedTables = tables.map((t: Record<string, unknown>) => ({
      pgId:                  t.neo4j_pg_id as number,
      starSchemaId:          t.star_schema_id as number,
      tableName:             t.table_name as string,
      displayName:           (t.display_name as string | null) ?? (t.table_name as string),
      description:           t.description as string | null,
      tableRole:             t.table_role as string,
      dagOrder:              (t.dag_order as number) ?? 0,
      rowCount:              t.row_count as number | null,
      transformationStatus:  t.transformation_status as string | null,
      aiDraft:               Boolean(t.ai_draft),
      lastRunAt:             t.last_run_at ? String(t.last_run_at) : null,
    }));

    // Map columns for upsert
    const mappedColumns = columns.map((c: Record<string, unknown>) => {
      const tablePgId = tableIdToPgId.get(c.product_table_id as number);
      const parentTable = tables.find((t: { id: number }) => t.id === (c.product_table_id as number));
      return {
        pgId:                      c.neo4j_pg_id as number,
        tablePgId:                 tablePgId!,
        tableName:                 parentTable?.table_name as string ?? '',
        columnName:                c.column_name as string,
        dataType:                  c.data_type as string | null,
        displayName:               (c.display_name as string | null) ?? (c.column_name as string),
        description:               c.description as string | null,
        columnRole:                c.column_role as string | null,
        fkTargetTable:             c.fk_target_table as string | null,
        fkTargetColumn:            c.fk_target_column as string | null,
        transformationExpression:  c.transformation_expression as string | null,
        additivity:                c.additivity as string | null,
        scdType:                   (c.scd_type as number) ?? 1,
        sortOrder:                 (c.sort_order as number) ?? 0,
        aiDraft:                   Boolean(c.ai_draft),
      };
    });

    // The product row carries the tenant, so the graph nodes can be stamped
    // without threading a parameter through every caller. Neo4j has no tenant
    // scoping of its own; the property is both the stamp on every node and the
    // predicate on every tenant-scoped read — a node written without it would
    // be invisible and unattributable, so a tenant-less row refuses to sync.
    const tenantId = Number(product.tenant_id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      log.warn({ productId }, 'Product row carries no tenant — skipping Neo4j sync rather than writing unattributable nodes');
      return;
    }
    await graph.upsertProductGraph(productId, mappedTables, mappedColumns, tenantId);
  } catch (err) {
    // Non-fatal: log and continue — Neo4j sync failure shouldn't block product operations
    log.error({ err }, `Failed to sync product ${productId} to Neo4j`);
  }
}

/**
 * Remove all Neo4j nodes for a data product.
 */
export async function deleteProductFromNeo4j(productId: number): Promise<void> {
  try {
    await graph.deleteProductGraph(productId);
  } catch (err) {
    log.error({ err }, `Failed to delete product ${productId} from Neo4j`);
  }
}

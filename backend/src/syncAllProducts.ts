/**
 * One-shot script: sync all existing data products from Postgres to Neo4j.
 * Run with: npx ts-node src/syncAllProducts.ts
 *
 * Uses the admin (databridge) role directly to bypass RLS.
 */

import knex from 'knex';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

import { ensureNeo4jConstraints } from './db/neo4j';
import { nextPgId, upsertProductGraph } from './db/semanticGraph';

// Admin connection — bypasses RLS
const adminDb = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL ?? 'postgresql://databridge:databridge@localhost:5432/databridge',
});

async function main() {
  console.log('Ensuring Neo4j constraints…');
  await ensureNeo4jConstraints();

  const products = await adminDb('data_products').select('id', 'name', 'status', 'tenant_id');
  console.log(`Found ${products.length} data product(s).`);

  for (const p of products) {
    console.log(`  Syncing "${p.name}" (id=${p.id}, status=${p.status})…`);

    const schemas = await adminDb('star_schemas').where({ data_product_id: p.id });
    const schemaIds = schemas.map((s: { id: number }) => s.id);

    if (!schemaIds.length) {
      console.log(`    ⚠ No star schemas — skipping`);
      continue;
    }

    const tables = await adminDb('product_tables').whereIn('star_schema_id', schemaIds);
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await adminDb('product_columns').whereIn('product_table_id', tableIds)
      : [];

    // Allocate neo4j_pg_id for tables that don't have one
    for (const table of tables) {
      if (!table.neo4j_pg_id) {
        const pgId = await nextPgId();
        await adminDb('product_tables').where({ id: table.id }).update({ neo4j_pg_id: pgId });
        table.neo4j_pg_id = pgId;
      }
    }

    // Allocate neo4j_pg_id for columns that don't have one
    for (const col of columns) {
      if (!col.neo4j_pg_id) {
        const pgId = await nextPgId();
        await adminDb('product_columns').where({ id: col.id }).update({ neo4j_pg_id: pgId });
        col.neo4j_pg_id = pgId;
      }
    }

    // Build lookup: postgres table id → neo4j pgId
    const tableIdToPgId = new Map<number, number>();
    for (const t of tables) tableIdToPgId.set(t.id, t.neo4j_pg_id);

    const mappedTables = tables.map((t: Record<string, unknown>) => ({
      pgId:                 t.neo4j_pg_id as number,
      starSchemaId:         t.star_schema_id as number,
      tableName:            t.table_name as string,
      displayName:          (t.display_name as string | null) ?? (t.table_name as string),
      description:          t.description as string | null,
      tableRole:            t.table_role as string,
      dagOrder:             (t.dag_order as number) ?? 0,
      rowCount:             t.row_count as number | null,
      transformationStatus: t.transformation_status as string | null,
      aiDraft:              Boolean(t.ai_draft),
      lastRunAt:            t.last_run_at ? String(t.last_run_at) : null,
    }));

    const mappedColumns = columns.map((c: Record<string, unknown>) => {
      const tablePgId = tableIdToPgId.get(c.product_table_id as number);
      const parentTable = tables.find((t: { id: number }) => t.id === (c.product_table_id as number));
      return {
        pgId:                     c.neo4j_pg_id as number,
        tablePgId:                tablePgId!,
        tableName:                parentTable?.table_name as string ?? '',
        columnName:               c.column_name as string,
        dataType:                 c.data_type as string | null,
        displayName:              (c.display_name as string | null) ?? (c.column_name as string),
        description:              c.description as string | null,
        columnRole:               c.column_role as string | null,
        fkTargetTable:            c.fk_target_table as string | null,
        fkTargetColumn:           c.fk_target_column as string | null,
        transformationExpression: c.transformation_expression as string | null,
        additivity:               c.additivity as string | null,
        scdType:                  (c.scd_type as number) ?? 1,
        sortOrder:                (c.sort_order as number) ?? 0,
        aiDraft:                  Boolean(c.ai_draft),
      };
    });

    // Stamp the tenant so this backfill produces nodes a tenant-scoped read can
    // see. A product row without one cannot be attributed — skip it loudly
    // rather than write nodes no tenant-scoped read will ever find.
    const tenantId = Number(p.tenant_id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      console.warn(`    ! product ${p.id} carries no tenant_id — SKIPPED (would create unattributable graph nodes)`);
      continue;
    }
    await upsertProductGraph(p.id, mappedTables, mappedColumns, tenantId);

    console.log(`    ✓ ${tables.length} tables, ${columns.length} columns synced`);
  }

  await adminDb.destroy();
  console.log('\nAll products synced to Neo4j.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});

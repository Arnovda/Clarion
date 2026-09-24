/**
 * Point every existing copy of a shared lookup at its original.
 *
 * `product_tables.source_product_table_id` has existed since migration 31 and
 * no code ever wrote it, so every copy row in production (Purchasing › Journal,
 * the Date under every subject, …) has NULL there. The catalog, the SQL tab,
 * the refusal to save SQL on a copy and the subject payload all read that
 * column to find the original — and all fell back to the empty copy. From now
 * on `buildBusMatrix` links copies as it writes them (services/sharedTables.ts);
 * this backfills the ones already written.
 *
 * The rule is a FROZEN COPY of `LINK_SHARED_TABLES_SQL` as it stood on
 * 2026-09-24, minus the connection filter (every tenant, every source). A
 * migration records what was done; importing the live constant would let a
 * later edit change the meaning of a migration that already ran.
 *
 * `down` is a deliberate no-op: after this migration, builds write the same
 * pointer, and there is no way to tell which rows this migration linked from
 * the ones a later build did. Clearing them all would break every build made
 * since. The column itself belongs to migration 31.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
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
           AND op.tenant_id = sp.tenant_id
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
  `);
}

export async function down(): Promise<void> {
  // Intentionally empty — see the header.
}

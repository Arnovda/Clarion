/**
 * Re-run the data_products.kind backfill from migration 20260510000054.
 *
 * Why: that migration ran the backfill ONCE at deploy time, then relied
 * on the bus-matrix builder to set `kind` on new inserts going forward.
 * The bus-matrix builder didn't set it, so every product created since
 * has landed with the column default 'analytics' — including dim-only
 * "Reference" products that should be classified as reference data.
 *
 * The forward fix is in services/busMatrixBuilder.ts (sets `kind`
 * explicitly on insert). This migration re-applies the same rule to
 * fix existing rows the regression touched.
 *
 * Safe to re-run — the rule is idempotent (a product that's already
 * correctly tagged just gets the same value re-written).
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE data_products SET kind = 'reference'
    WHERE id IN (
      SELECT dp.id
      FROM data_products dp
      LEFT JOIN product_kpis pk
        ON pk.data_product_id = dp.id
      LEFT JOIN star_schemas ss
        ON ss.data_product_id = dp.id
      LEFT JOIN product_tables pt
        ON pt.star_schema_id = ss.id AND pt.table_role = 'fact'
      GROUP BY dp.id
      HAVING COUNT(DISTINCT pk.id) = 0
         AND COUNT(DISTINCT pt.id) = 0
    )
  `);
}

export async function down(_knex: Knex): Promise<void> {
  // Intentionally a no-op. The forward backfill is idempotent; the
  // "down" direction has no meaningful inverse (we don't know which
  // rows were 'analytics' before this migration ran).
}

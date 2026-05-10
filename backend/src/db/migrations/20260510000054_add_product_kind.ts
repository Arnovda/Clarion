/**
 * Two-tier catalog: classify every data product as `analytics` or `reference`.
 *
 * Background: today's catalog renders every data_product as a peer card,
 * including bundled "Reference" products that contain only dimension
 * tables. Users get vague entries like "Reference" with 5 dim tables
 * inside and no metrics. The new /catalog UI splits per-source into two
 * columns — Analytics on the left, Reference data on the right — and
 * unfolds Reference products so each constituent dim becomes its own
 * first-class entry.
 *
 * `kind` drives that split. Backfill rule: a product with zero metrics
 * AND zero fact tables is reference-shaped — it has nothing to analyse,
 * only entities to slice by. Everything else stays analytics.
 *
 * Default 'analytics' on new rows so the AI design step's existing
 * output (which has been producing a mix) keeps working until the
 * starSchemaPrompt change ships in the same release.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('data_products', 'kind');
  if (!has) {
    await knex.schema.alterTable('data_products', (t) => {
      t.text('kind').notNullable().defaultTo('analytics');
    });
  }

  // Backfill: products with no metrics AND no fact tables → 'reference'.
  // Catches the existing "Reference" products in EO + wholesale_erp plus
  // any zero-metric "Customers"/"Suppliers"-style entity products.
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

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS data_products_kind_idx
    ON data_products (kind)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS data_products_kind_idx`);
  const has = await knex.schema.hasColumn('data_products', 'kind');
  if (has) {
    await knex.schema.alterTable('data_products', (t) => {
      t.dropColumn('kind');
    });
  }
}

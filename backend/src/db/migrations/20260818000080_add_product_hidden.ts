/**
 * Build page — show/hide as the topic selection mechanism.
 *
 * `data_products.hidden`
 *   The Build page builds EVERYTHING the connector's template can build
 *   (activation-not-determination, warehouse doc §2.1b: hiding a row is the
 *   per-customer choice, designing per customer is not). "Which topics does
 *   this tenant see" is therefore a visibility flag on the product, not a
 *   different build. The rail's YOUR DATA group and any other topic listing
 *   filter on it; the product itself — tables, KPIs, warehouse files —
 *   stays fully materialised so un-hiding is instant and free.
 *
 * Nullable boolean, no backfill: NULL and false both mean visible (every
 * product that exists today was deliberately built and is being used), so
 * writing a default would churn rows for no semantic gain. Readers must
 * treat only `hidden === true` as hidden.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('data_products', 'hidden');
  if (!has) {
    await knex.schema.alterTable('data_products', (t) => {
      t.boolean('hidden');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('data_products', 'hidden');
  if (has) {
    await knex.schema.alterTable('data_products', (t) => {
      t.dropColumn('hidden');
    });
  }
}

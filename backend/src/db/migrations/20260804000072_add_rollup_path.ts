import type { Knex } from 'knex';

/**
 * Make the monthly rollup discoverable.
 *
 * `generateMonthlyRollup` (Sprint 1.2) writes a pre-aggregated
 * `rollup_monthly_<table>/data.parquet` next to every fact table that has a
 * date column and at least one measure, and the dashboard prompt instructs the
 * model to prefer it for any monthly/quarterly/yearly query. But the rollup was
 * only ever LOGGED — nothing recorded that it existed, so the only way to find
 * one was `productContext.detectRollupTables`, an `fs.readdirSync` of the v1
 * local layout that bails outright on `az://` paths. Production runs Azure on
 * the v2 layout, so the scan always returned empty: the rollups were written
 * every refresh and never advertised once, and every dashboard query went to
 * the full fact table.
 *
 * Storing the URI rather than a boolean is deliberate. It is the same reason
 * `product_tables.delta_path` holds an absolute URI: the reader must not have
 * to re-derive a location from environment + layout version, which is exactly
 * the re-derivation that broke here.
 *
 * NULL means "no rollup" — either the table is not a fact, or it has no date
 * column / no measures, both of which make `generateMonthlyRollup` return null.
 * The value is rewritten on every refresh, so a fact that stops qualifying
 * clears it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('product_tables', (t) => {
    t.text('rollup_path').nullable();
    t.bigInteger('rollup_row_count').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('product_tables', (t) => {
    t.dropColumn('rollup_path');
    t.dropColumn('rollup_row_count');
  });
}

import type { Knex } from 'knex';

/**
 * Immutable vendor-description base for the AI enrichment layer
 * (docs/backlog/semantic-enrichment-plan.md Phase 3).
 *
 * `vendor_description` holds the connector-documented text VERBATIM and is
 * written only by the schema profiler. `description` remains the display
 * text: identical to the base until an enrichment draft is approved, and
 * restored from the base when an enrichment is rejected. This is what keeps
 * the catalog auditable against the vendor's own documentation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (t) => {
    t.text('vendor_description').nullable();
  });
  await knex.schema.alterTable('source_columns', (t) => {
    t.text('vendor_description').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (t) => {
    t.dropColumn('vendor_description');
  });
  await knex.schema.alterTable('source_columns', (t) => {
    t.dropColumn('vendor_description');
  });
}

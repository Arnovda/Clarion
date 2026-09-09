import type { Knex } from 'knex';

/**
 * Ingestion chain, phase 1 (docs/backlog/ingestion-chain-assessment.md §7) —
 * four additive nullable columns, one migration, because they ship together.
 *
 * `source_columns.source_data_type` (E6)
 *   The type the SOURCE declares — `Edm.Guid`, Odoo `many2one`, `char` — as
 *   opposed to `data_type`, which is what the column became once it landed
 *   in DuckDB. After landing a GUID and a short code are both VARCHAR, so
 *   nothing downstream could tell them apart; the type-class rule that
 *   refuses a GUID→code relationship (`columnTypes.ts`) could only fire
 *   inside the connector package, before the profile. Kept verbatim, never
 *   normalised: it is the vendor's word, and `typeClass()` reads it.
 *   NULL = the connector publishes no types (the four direct databases,
 *   files) or the row predates this column. Filled on the next Analyse.
 *
 * `product_tables.degraded_reason` + `degraded_at` (D3, the half that stops
 *   an AI repair from persisting)
 *   A transformation that failed because a SOURCE column vanished used to be
 *   repaired by the model and the repaired SQL written back, so the topic
 *   got narrower overnight with nothing on screen. The repair may still run
 *   — for THIS run, in memory — but the stored SQL stays as a person wrote or
 *   approved it, and the table carries the missing column's name here until
 *   a person decides. Cleared by the next run that needs no repair.
 *   `transformation_status` deliberately stays 'success' while degraded:
 *   thirty-odd readers filter on that value and a degraded table still
 *   answers questions — narrower, and visibly so, is the whole point.
 *
 * `product_relationships.provenance` + `column_lineage.provenance` (E5)
 *   The one provenance ladder (`shared/provenance.ts`) carried past the
 *   product boundary, where it used to die: a join a template shipped, one
 *   the model proposed, and one Clarion derived from the SQL were
 *   indistinguishable. Values are the ladder's rungs; NULL = written before
 *   this column and honestly unknown.
 *
 * `down` drops all five so the chain still rolls back end to end.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_columns', (t) => {
    t.text('source_data_type').nullable();
  });
  await knex.schema.alterTable('product_tables', (t) => {
    t.text('degraded_reason').nullable();
    t.timestamp('degraded_at', { useTz: true }).nullable();
  });
  await knex.schema.alterTable('product_relationships', (t) => {
    t.text('provenance').nullable();
  });
  await knex.schema.alterTable('column_lineage', (t) => {
    t.text('provenance').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('column_lineage', (t) => { t.dropColumn('provenance'); });
  await knex.schema.alterTable('product_relationships', (t) => { t.dropColumn('provenance'); });
  await knex.schema.alterTable('product_tables', (t) => {
    t.dropColumn('degraded_at');
    t.dropColumn('degraded_reason');
  });
  await knex.schema.alterTable('source_columns', (t) => { t.dropColumn('source_data_type'); });
}

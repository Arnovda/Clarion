/**
 * The declaration contract, first slice (docs/backlog/declarative-data-engineering.md §3.4).
 *
 * `product_tables.declared_by` + `declared_at` — WHO last saved this table's
 * SQL as a declaration, and WHEN. Until now a table's `transformation_sql`
 * was written by three actors that left no trace of each other: the
 * bus-matrix builder (a template or the model), the notebook's deploy cell
 * (copied over it on every Deploy) and the refine chat. A curator's edit was
 * indistinguishable from the model's, and the next Deploy silently reverted
 * it.
 *
 * `declared_at` beside the existing `last_run_at` is also what lets the
 * catalog say "changed since the last build" without a status flip: a saved
 * table keeps `transformation_status = 'success'` — so it keeps serving Ask
 * AI, which filters on that status — and the screen shows the pending
 * rebuild instead of the table vanishing.
 *
 * Both nullable: every row written before this migration is honestly
 * "declared by nobody in particular". `down` drops both.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('product_tables', (t) => {
    t.text('declared_by').nullable();
    t.timestamp('declared_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('product_tables', (t) => {
    t.dropColumn('declared_at');
    t.dropColumn('declared_by');
  });
}

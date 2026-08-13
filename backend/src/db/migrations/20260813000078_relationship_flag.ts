import type { Knex } from 'knex';

/**
 * A third state for a relationship: **flagged**.
 *
 * Until now a person could only confirm a relationship or delete it, which
 * leaves nowhere to put the most common real finding: *"the data says this does
 * not hold, but I am not deleting it — the source probably has not finished
 * syncing."* Deleting loses a link that is very likely real; confirming asserts
 * something the data contradicts. Both are wrong, so people do neither and the
 * finding evaporates the moment the panel closes.
 *
 * `flagged_at` NULL means not flagged — a nullable timestamp rather than a
 * boolean because *when* someone raised it is what tells you whether a sync has
 * had time to fix it since.
 *
 * Deliberately NOT `approval_status`. `source_tables` and `source_columns` carry
 * that column with its own draft/approved/flagged vocabulary tied to the AI
 * review queue; a relationship's flag is an observation about the DATA, not a
 * step in that queue, and overloading one word across two meanings is how the
 * two quietly diverge.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('table_relationships', (t) => {
    t.timestamp('flagged_at', { useTz: true }).nullable();
    t.text('flagged_reason').nullable();
  });

  // Finding what is flagged is the whole point of flagging, and that read is
  // "the few rows where this is set" — a partial index keeps it cheap without
  // paying for the overwhelming majority of rows that never will be.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS table_relationships_flagged_idx
      ON table_relationships (tenant_id, from_table_id)
      WHERE flagged_at IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS table_relationships_flagged_idx');
  await knex.schema.alterTable('table_relationships', (t) => {
    t.dropColumn('flagged_at');
    t.dropColumn('flagged_reason');
  });
}

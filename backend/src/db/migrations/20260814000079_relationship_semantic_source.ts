import type { Knex } from 'knex';

/**
 * Record WHICH channel produced a relationship.
 *
 * `source_tables` and `source_columns` have carried `semantic_source` since
 * migration 68. `table_relationships` never did, and the consequence is that
 * five genuinely different detection channels were flattened into three
 * presentational states by `deriveProvenance`:
 *
 *   if (confirmed_by_user) 'human'; else if (ai_draft) 'ai'; else 'declared'
 *
 * So a relationship a Clarion engineer hand-wrote into the connector rendered
 * as "Documented by the source", claiming the vendor's authority for our own
 * work — and three very different kinds of guess (a column-name pattern, a
 * value-overlap scan, and two separate AI passes) all rendered identically as
 * "Suggested by Clarion".
 *
 * The values are deliberately finer-grained than the ladder on tables and
 * columns, because for a relationship the CHANNEL is the whole question:
 *
 *   vendor_docs   the source system documents this link in its own data model
 *   curated       hand-written in Clarion's connector; ours, not the vendor's
 *   declared      a real foreign-key constraint read out of the database
 *   name_pattern  column naming heuristic, then verified against the data
 *   value_overlap found by comparing values alone — the weakest signal there is
 *   ai_suggested  AI matched an unmatched key column, then verified
 *   ai_model      AI read the schema and proposed it, then verified
 *
 * NULL means "written before this migration" and must render as unknown rather
 * than as any particular channel. Existing rows are deliberately NOT
 * backfilled: the information to do it honestly is gone, and guessing would put
 * a confident label on exactly the rows most likely to be wrong — the ones a
 * pre-rebuild detector produced.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('table_relationships', 'semantic_source');
  if (!has) {
    await knex.schema.alterTable('table_relationships', (t) => {
      t.text('semantic_source');
    });
  }

  // Partial index: the canvas filters on this to answer "show me only what the
  // vendor documents", and the NULL rows are the majority on any tenant
  // profiled before today — indexing them would be dead weight.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS table_relationships_semantic_source_idx
      ON table_relationships (semantic_source)
      WHERE semantic_source IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS table_relationships_semantic_source_idx');
  const has = await knex.schema.hasColumn('table_relationships', 'semantic_source');
  if (has) {
    await knex.schema.alterTable('table_relationships', (t) => {
      t.dropColumn('semantic_source');
    });
  }
}

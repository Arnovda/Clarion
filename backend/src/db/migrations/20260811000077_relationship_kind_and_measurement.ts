/**
 * Relationship canvas — three additive columns on `table_relationships`.
 *
 * `kind` — 'join' | 'match'
 *   A relationship inside one source is a foreign key: structural, and
 *   verifiable by asking whether the values exist in the target. A relationship
 *   BETWEEN two sources is not — there is no column in Shopify pointing at
 *   Exact Online's account id. What connects them is an assertion about the
 *   real world ("these two rows are the same company"), whose truth lives PER
 *   ROW and is verified by a match rate, not by containment.
 *
 *   Storing both as one kind is what makes cross-system look easy and then be
 *   quietly wrong: the AI prompt would phrase an identity assertion as a JOIN,
 *   and a query would silently produce a cross product or a wrong total.
 *
 *   Defaults to 'join' so every existing row keeps its current meaning and no
 *   backfill is needed — everything written before this migration was
 *   single-source by construction.
 *
 * `measured` — jsonb, nullable
 *   What the measurement endpoint found when a human last checked: containment,
 *   cardinality, orphan count, and when it was sampled. Stored rather than
 *   recomputed because the canvas shows it on every edge and re-measuring a
 *   whole graph on load would be both slow and pointless — the data only moves
 *   when a sync runs. NULL means "never measured", which is not the same as
 *   "measured and found wanting" and must not render as a zero.
 *
 * `match_keys` — jsonb, nullable
 *   For a match edge: which attributes the two sides are matched on
 *   (vat_number, email, …), in priority order. Meaningless for a join, hence
 *   nullable rather than defaulted.
 *
 * Deliberately NOT added: a `connection_id`. This table has never had one —
 * scope resolves through `from_table_id` (see db/semanticCacheScope.ts), and
 * adding a second path to the same answer is how the two drift apart.
 *
 * Additive only — new nullable/defaulted columns on an existing table. Safe
 * under the 0%-traffic deploy model, where the new revision shares this
 * database with the live one: the old code simply does not select these
 * columns. Columns inherit the table's RLS policy and grants, so there is no
 * policy work here.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasKind = await knex.schema.hasColumn('table_relationships', 'kind');
  if (!hasKind) {
    await knex.schema.alterTable('table_relationships', (t) => {
      t.text('kind').notNullable().defaultTo('join');
    });
  }

  const hasMeasured = await knex.schema.hasColumn('table_relationships', 'measured');
  if (!hasMeasured) {
    await knex.schema.alterTable('table_relationships', (t) => {
      t.jsonb('measured');
    });
  }

  const hasMatchKeys = await knex.schema.hasColumn('table_relationships', 'match_keys');
  if (!hasMatchKeys) {
    await knex.schema.alterTable('table_relationships', (t) => {
      t.jsonb('match_keys');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['kind', 'measured', 'match_keys']) {
    const has = await knex.schema.hasColumn('table_relationships', col);
    if (has) {
      await knex.schema.alterTable('table_relationships', (t) => {
        t.dropColumn(col);
      });
    }
  }
}

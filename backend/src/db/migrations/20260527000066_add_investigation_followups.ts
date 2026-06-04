/**
 * Persist AI-generated follow-up questions on an investigation.
 *
 * The conclusion step already understands the whole trail; having it
 * emit 2-3 sensible next questions produces far better follow-ups than
 * the old frontend templating, which naively interpolated the user's
 * raw question into "Show me <X> broken down by month" — nonsense for
 * diagnostic asks like "why don't you show any data?".
 *
 * Stored as jsonb (array of strings) so it survives a refresh / replay.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('investigations', 'conclusion_followups');
  if (!has) {
    await knex.schema.alterTable('investigations', (t) => {
      t.jsonb('conclusion_followups').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('investigations', 'conclusion_followups');
  if (has) {
    await knex.schema.alterTable('investigations', (t) => {
      t.dropColumn('conclusion_followups');
    });
  }
}

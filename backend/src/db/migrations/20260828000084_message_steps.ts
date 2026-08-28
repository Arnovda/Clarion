import type { Knex } from 'knex';

/**
 * Ask AI worksheet (owner brief 2026-08-28, docs/backlog/ask-ai-worksheet.md):
 * a question+answer is a STEP in a TREE, not a chat message. The tree is
 * derived from `parent_message_id` — deliberately NO ordered array / path
 * column (the brief's §3 rule; siblings order by created_at).
 *
 * - parent_message_id — the step this one branched from. NULL means either
 *   the thread root (new worksheet threads) or a legacy pre-worksheet row;
 *   legacy conversations are chained linearly AT READ TIME on the client,
 *   never rewritten.
 * - label   — short spine label; NULL = derive the auto-label client-side
 *   from the question (brief §4.5). Only a user rename persists a value.
 * - starred — spine star; also exempts the step from collapsing (§4.6).
 * - data_as_of — warehouse freshness AT ASK TIME (oldest source table the
 *   answer used), so a restored snapshot can honestly say how old its data
 *   was and "newer data available" is computable without re-query (§4.4).
 *
 * ON DELETE SET NULL keeps children valid if a parent row ever disappears
 * (conversation deletion cascades the whole set anyway).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_messages', (table) => {
    table.integer('parent_message_id').nullable()
      .references('id').inTable('conversation_messages').onDelete('SET NULL');
    table.text('label');
    table.boolean('starred').notNullable().defaultTo(false);
    table.timestamp('data_as_of', { useTz: true });
  });

  // The tree is read per conversation; the FK lookup is per parent.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS conversation_messages_parent_idx
      ON conversation_messages (conversation_id, parent_message_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS conversation_messages_parent_idx');
  await knex.schema.alterTable('conversation_messages', (table) => {
    table.dropColumn('parent_message_id');
    table.dropColumn('label');
    table.dropColumn('starred');
    table.dropColumn('data_as_of');
  });
}

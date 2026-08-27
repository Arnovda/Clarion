/**
 * Ask AI Release 1 — "tell the truth" persistence.
 *
 * `conversation_messages.meta`
 *   One nullable JSONB column holding the answer metadata the chat used to
 *   DROP on persist — assumptions, confidence sub-scores, uncertainty notes,
 *   clarify intent + options, the visualization hint, forecast payload,
 *   flagReason, policyNotice, per-answer source freshness, answer latency,
 *   and the repair loop's plain-language summary. Before this column, a
 *   reloaded conversation silently looked MORE certain than it was (the
 *   assumptions footnote, clarify chips and chart choice all vanished), and
 *   a corrected answer lost its "what I checked" trail.
 *
 *   Deliberately one JSONB rather than ten typed columns: every field is
 *   display metadata read back as a unit by exactly one surface (the chat),
 *   never filtered or joined on. The precedent is the investigate mode's
 *   markers in the `debug` JSONB — this gives that pattern a proper home.
 *
 * Nullable, no backfill: old messages simply have no meta and render as
 * before.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('conversation_messages', 'meta');
  if (!has) {
    await knex.schema.alterTable('conversation_messages', (t) => {
      t.jsonb('meta');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('conversation_messages', 'meta');
  if (has) {
    await knex.schema.alterTable('conversation_messages', (t) => {
      t.dropColumn('meta');
    });
  }
}

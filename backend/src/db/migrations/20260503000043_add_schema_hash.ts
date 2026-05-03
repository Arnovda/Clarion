/**
 * Adds `connections.schema_hash` — fingerprint of the introspected schema
 * (table names + column names + types + nullable flags) used to gate the
 * AI-draft step of profiling.
 *
 * Why: every successful sync triggers schema profiling, which calls Claude
 * to generate descriptions. But the SCHEMA changes far less often than the
 * DATA — once we've drafted descriptions for "Accounts.AccountID is the
 * primary key", the answer doesn't change next sync. Re-running Claude
 * every time would torch the budget on scheduled refreshes.
 *
 * Flow:
 *   • First sync:   schema_hash NULL → run Claude → store new hash.
 *   • Next sync:    re-introspect → hash matches → SKIP Claude entirely.
 *                   Just refresh last_profiled_at + timestamps.
 *   • Schema drift: hash differs → run Claude (currently regenerates all
 *                   tables; future optimisation: only changed tables).
 *
 * Hash is sha256 of a normalised schema descriptor — insensitive to
 * column order / sample values, sensitive to adds/drops/type changes /
 * nullability changes.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (t) => {
    // Hex-encoded sha256 → 64 chars; varchar(128) for headroom.
    t.string('schema_hash', 128).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (t) => {
    t.dropColumn('schema_hash');
  });
}

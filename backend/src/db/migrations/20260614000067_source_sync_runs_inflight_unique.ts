/**
 * Enforce "at most one in-flight sync per connection" as a DB invariant.
 *
 * The orchestrator's `triggerSync` did a SELECT-for-in-flight then INSERT with
 * no lock — a TOCTOU race where two concurrent triggers (double-click, retry,
 * scheduler + manual) could both insert a `queued` row and run two workers
 * against the same warehouse paths. A partial unique index makes the invariant
 * impossible to violate; `triggerSync` now catches the conflict (23505) and
 * returns the run that won the race.
 *
 * Before creating the index we close out any pre-existing duplicate in-flight
 * rows (keep the newest per connection) so the unique index can be built.
 */

import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Fail all but the most recent in-flight run per connection so the unique
  // index below can be created without collision.
  await knex.raw(`
    UPDATE source_sync_runs s
       SET status = 'failed',
           completed_at = NOW(),
           error_message = COALESCE(error_message, 'Superseded — duplicate in-flight run closed by migration')
     WHERE s.status IN ('queued', 'running')
       AND s.id < (
         SELECT MAX(s2.id) FROM source_sync_runs s2
          WHERE s2.connection_id = s.connection_id
            AND s2.status IN ('queued', 'running')
       )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_source_sync_runs_inflight
      ON source_sync_runs (connection_id)
      WHERE status IN ('queued', 'running')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS uq_source_sync_runs_inflight`);
}

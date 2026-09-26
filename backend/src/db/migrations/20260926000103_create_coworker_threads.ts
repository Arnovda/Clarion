/**
 * `coworker_threads` — the Studio coworker's conversations, kept.
 *
 * Until now a conversation lived only in the browser tab: a reload, a
 * "New conversation" or a second device, and what you had asked Clarion was
 * gone. The owner: "I want to keep a history of what I asked to Clarion."
 *
 * ONE ROW PER THREAD, the conversation as a JSON snapshot. The panel already
 * holds exactly this shape (messages with their trail, and the proposals they
 * carried with their decision), and nothing on the server reads inside it —
 * it is a record for the person who wrote it, not data the platform queries.
 * A row per message would buy nothing but joins.
 *
 * THE ID COMES FROM THE CLIENT (a UUID). A turn starts streaming the moment
 * the person presses Enter; making the browser wait for a round trip to learn
 * the thread's id first would put a network hop in front of every first
 * message, and saving is an upsert on that id either way.
 *
 * PER USER, never shared. RLS isolates tenants; the per-user half is an
 * explicit user_id filter on every query (and on the upsert's conflict
 * update, so guessing a colleague's id cannot overwrite their thread).
 */

import type { Knex } from 'knex';

const TABLE = 'coworker_threads';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    // The first question, bounded — what the history list shows.
    t.string('title', 200).notNullable();
    // Where the person was when the thread started ("Reference › Item").
    t.string('context_label', 200).nullable();
    t.integer('message_count').notNullable().defaultTo(0);
    t.jsonb('messages').notNullable().defaultTo('[]');
    t.jsonb('proposals').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE "${TABLE}" ALTER COLUMN tenant_id
    SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
  `);

  await knex.raw(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON "${TABLE}"
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  // The history list: my threads, newest first.
  await knex.raw(`CREATE INDEX idx_coworker_threads_user ON "${TABLE}" (tenant_id, user_id, updated_at DESC)`);

  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    // No sequence: the id is a client-supplied UUID.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}

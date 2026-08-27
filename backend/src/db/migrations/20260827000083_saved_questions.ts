/**
 * Ask AI Release 3 — "answers go somewhere".
 *
 * `saved_questions` — a named, re-runnable question with its approved SQL.
 * Two trust tiers on one table:
 *   - saved     (verified = false): any user keeps a question they'll re-ask.
 *   - VERIFIED  (verified = true):  a curator (admin/analyst) approved the
 *     SQL. Ask AI reuses a verified question's SQL on an EXACT match of the
 *     normalized question text (owner decision 2026-08-27 §8.3: exact-match
 *     first, fuzzy is a later measured step), and the answer card shows
 *     "Verified by your team" — human-attributed trust, the Genie
 *     trusted-asset / Cortex verified-query pattern.
 *
 * `normalized_question` is stored (not derived at query time) so the exact-
 * match lookup is one indexed read on the hot path of every chat question.
 *
 * Also in this migration, same release:
 *   - `email_schedules.dashboard_id` becomes NULLABLE and
 *     `saved_question_id` is added — a schedule now targets a dashboard XOR
 *     a saved question ("email me this every Monday" from a chat answer).
 *     A CHECK enforces exactly one target so a row can never be ambiguous.
 *   - `definition_gaps.conversation_message_id` — thumbs-down gaps point at
 *     the exchange they report, so the admin gaps page can show the
 *     question/answer/SQL and offer one-click "fix & verify" (promote the
 *     corrected answer into the verified set).
 */

import type { Knex } from 'knex';

const TBL = 'saved_questions';

export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable(TBL);
  if (!exists) {
    await knex.schema.createTable(TBL, (t) => {
      t.increments('id').primary();
      t.integer('tenant_id').notNullable()
        .references('id').inTable('tenants').onDelete('CASCADE');
      t.integer('created_by');
      t.text('question').notNullable();
      t.text('normalized_question').notNullable();
      t.text('sql').notNullable();
      t.jsonb('tables_used');
      t.jsonb('visualization');
      t.integer('connection_id').notNullable();
      t.text('data_layer').notNullable().defaultTo('product');
      t.boolean('verified').notNullable().defaultTo(false);
      t.integer('verified_by');
      t.timestamp('verified_at', { useTz: true });
      t.integer('times_used').notNullable().defaultTo(0);
      t.timestamp('last_used_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });

    await knex.raw(`
      ALTER TABLE "${TBL}" ALTER COLUMN tenant_id
      SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
    `);

    // RLS — canonical policy name + predicate (see migration 74's header).
    await knex.raw(`ALTER TABLE "${TBL}" ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE "${TBL}" FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TBL}"`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON "${TBL}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);

    // One saved copy of a question per tenant+connection keeps the list and
    // the verified lookup unambiguous — saving the same question twice is a
    // 409 in the route, backed here by the index (race-safe).
    await knex.raw(`
      CREATE UNIQUE INDEX idx_saved_questions_tenant_conn_norm
        ON "${TBL}" (tenant_id, connection_id, normalized_question)
    `);
    await knex.raw(`CREATE INDEX idx_saved_questions_tenant ON "${TBL}" (tenant_id)`);

    const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
    if (hasAppRole.rows.length > 0) {
      await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TBL}" TO databridge_app`);
      await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${TBL}_id_seq TO databridge_app`);
    }
  }

  // email_schedules: polymorphic target (dashboard XOR saved question).
  const hasSqCol = await knex.schema.hasColumn('email_schedules', 'saved_question_id');
  if (!hasSqCol) {
    await knex.raw(`ALTER TABLE email_schedules ALTER COLUMN dashboard_id DROP NOT NULL`);
    await knex.schema.alterTable('email_schedules', (t) => {
      t.integer('saved_question_id')
        .references('id').inTable(TBL).onDelete('CASCADE');
    });
    await knex.raw(`
      ALTER TABLE email_schedules
        ADD CONSTRAINT email_schedules_one_target
        CHECK ((dashboard_id IS NOT NULL)::int + (saved_question_id IS NOT NULL)::int = 1)
    `);
  }

  // definition_gaps: link feedback gaps to the exchange they report.
  const hasMsgCol = await knex.schema.hasColumn('definition_gaps', 'conversation_message_id');
  if (!hasMsgCol) {
    await knex.schema.alterTable('definition_gaps', (t) => {
      t.integer('conversation_message_id')
        .references('id').inTable('conversation_messages').onDelete('SET NULL');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasMsgCol = await knex.schema.hasColumn('definition_gaps', 'conversation_message_id');
  if (hasMsgCol) {
    await knex.schema.alterTable('definition_gaps', (t) => {
      t.dropColumn('conversation_message_id');
    });
  }
  const hasSqCol = await knex.schema.hasColumn('email_schedules', 'saved_question_id');
  if (hasSqCol) {
    await knex.raw(`ALTER TABLE email_schedules DROP CONSTRAINT IF EXISTS email_schedules_one_target`);
    await knex.schema.alterTable('email_schedules', (t) => {
      t.dropColumn('saved_question_id');
    });
  }
  await knex.schema.dropTableIfExists(TBL);
}

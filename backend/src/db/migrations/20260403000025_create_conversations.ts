import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── Conversations ──────────────────────────────────────────────────────────
  await knex.schema.createTable('conversations', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants');
    table.integer('user_id').notNullable().references('id').inTable('users');
    table.text('title').notNullable().defaultTo('New conversation');
    table.boolean('starred').notNullable().defaultTo(false);
    table.text('source_key');          // e.g. "c:1" or "v:2" — which data source was queried
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`ALTER TABLE conversations ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE conversations FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY conversations_tenant ON conversations
      USING  (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // ── Messages ───────────────────────────────────────────────────────────────
  await knex.schema.createTable('conversation_messages', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants');
    table.integer('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.text('role').notNullable();            // 'user' | 'assistant'
    table.text('content').notNullable();          // the displayed text
    table.text('question');                       // original user question (on assistant messages)
    table.text('sql');
    table.jsonb('tables_used');                   // string[]
    table.float('confidence');
    table.text('warning');
    table.boolean('blocked').defaultTo(false);
    table.boolean('needs_clarification').defaultTo(false);
    table.jsonb('mismatches');
    table.jsonb('ambiguities');
    table.boolean('error').defaultTo(false);
    table.jsonb('debug');
    table.jsonb('rows');                          // result rows (capped at 200)
    table.boolean('was_repaired').defaultTo(false);
    table.text('reasoning');
    table.text('query_layer');                    // 'product' | 'source'
    // Feedback
    table.text('feedback');                       // 'up' | 'down' | null
    table.text('feedback_comment');               // optional comment with feedback
    table.timestamp('feedback_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE conversation_messages FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY conversation_messages_tenant ON conversation_messages
      USING  (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // Indexes
  await knex.raw(`CREATE INDEX idx_conversations_user ON conversations (user_id)`);
  await knex.raw(`CREATE INDEX idx_conversations_tenant ON conversations (tenant_id)`);
  await knex.raw(`CREATE INDEX idx_conversations_starred ON conversations (user_id, starred) WHERE starred = true`);
  await knex.raw(`CREATE INDEX idx_conv_messages_conv ON conversation_messages (conversation_id)`);
  await knex.raw(`CREATE INDEX idx_conv_messages_tenant ON conversation_messages (tenant_id)`);
  await knex.raw(`CREATE INDEX idx_conv_messages_feedback ON conversation_messages (feedback) WHERE feedback IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_messages');
  await knex.schema.dropTableIfExists('conversations');
}

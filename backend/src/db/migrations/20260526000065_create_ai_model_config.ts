/**
 * Per-call-category AI model overrides.
 *
 * Extends the coarse tenant-level `ai_routing_mode` (claude/hybrid/azure)
 * with fine-grained, per-category model selection. Admins can pick a
 * different provider + model for each category of AI call — e.g. keep
 * Claude Sonnet for NL→SQL but use Azure GPT-4o-mini for formatting.
 *
 * Categories are logical groupings of the ~42 internal call labels.
 * When a row exists for (tenant_id, call_category), it overrides the
 * global routing mode for all calls in that category. When no row
 * exists, the global mode applies.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ai_model_config', (t) => {
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('call_category').notNullable();
    t.text('provider').notNullable().defaultTo('anthropic');
    t.text('model_id').notNullable();
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    t.primary(['tenant_id', 'call_category']);
  });

  await knex.raw(`ALTER TABLE ai_model_config ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY ai_model_config_tenant_isolation ON ai_model_config
      USING (tenant_id = current_setting('app.current_tenant')::int)
  `);
  await knex.raw(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ai_model_config TO databridge_app
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_model_config');
}

import type { Knex } from 'knex';

/**
 * 4-3 — a tenant can switch AI OFF. `ai_routing_mode = 'off'` means no
 * call of any kind leaves for an AI provider: Ask AI, dashboard generation,
 * profiling passes, briefs, repairs all refuse with a clear message. The
 * CHECK constraint from migration 61 admitted only claude/hybrid/azure.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_ai_routing_mode_check`);
  await knex.raw(`
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_ai_routing_mode_check
      CHECK (ai_routing_mode IN ('claude', 'hybrid', 'azure', 'off'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`UPDATE tenants SET ai_routing_mode = 'claude' WHERE ai_routing_mode = 'off'`);
  await knex.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_ai_routing_mode_check`);
  await knex.raw(`
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_ai_routing_mode_check
      CHECK (ai_routing_mode IN ('claude', 'hybrid', 'azure'))
  `);
}

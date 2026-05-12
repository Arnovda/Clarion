/**
 * Add `tenants.ai_routing_mode` — the per-tenant AI backend toggle.
 *
 * Three modes:
 *   - 'claude'  : every AI call goes to Anthropic (current behaviour,
 *                 and the default for every existing tenant).
 *   - 'hybrid'  : row-touching calls (insights, narration, format
 *                 answer, explain widget, schema sample-value calls,
 *                 investigations) route to Azure AI Foundry; pure
 *                 schema-only calls (NL→SQL, dashboard generation,
 *                 transformation design) stay on Claude. Privacy
 *                 win without giving up Claude's quality where it
 *                 matters most.
 *   - 'azure'   : every AI call routes to Azure AI Foundry.
 *
 * The toggle takes effect for the NEXT AI call after a successful
 * PUT; no restart needed. Admins can flip back to 'claude' at any
 * time if quality regresses.
 *
 * When Azure environment variables aren't set, the router falls
 * back to Claude regardless of the mode — so the migration can
 * land before Foundry is provisioned.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('tenants', 'ai_routing_mode');
  if (!has) {
    await knex.schema.alterTable('tenants', (t) => {
      t.text('ai_routing_mode').notNullable().defaultTo('claude');
    });
  }
  // CHECK constraint to keep accidental typos out. Knex doesn't
  // have a portable CHECK builder, so raw SQL.
  await knex.raw(`
    ALTER TABLE tenants
      DROP CONSTRAINT IF EXISTS tenants_ai_routing_mode_check
  `);
  await knex.raw(`
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_ai_routing_mode_check
      CHECK (ai_routing_mode IN ('claude', 'hybrid', 'azure'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_ai_routing_mode_check`);
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('ai_routing_mode');
  });
}

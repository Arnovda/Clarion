import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasAutoApprove = await knex.schema.hasColumn('tenants', 'auto_approve_ai_drafts');
  if (!hasAutoApprove) {
    await knex.schema.alterTable('tenants', (t) => {
      t.boolean('auto_approve_ai_drafts').notNullable().defaultTo(true);
      t.integer('auto_approve_delay_days').notNullable().defaultTo(7);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasAutoApprove = await knex.schema.hasColumn('tenants', 'auto_approve_ai_drafts');
  if (hasAutoApprove) {
    await knex.schema.alterTable('tenants', (t) => {
      t.dropColumn('auto_approve_delay_days');
      t.dropColumn('auto_approve_ai_drafts');
    });
  }
}

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('quality_alerts', 'ai_context');
  if (!hasColumn) {
    await knex.schema.alterTable('quality_alerts', (table) => {
      table.text('ai_context').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('quality_alerts', 'ai_context');
  if (hasColumn) {
    await knex.schema.alterTable('quality_alerts', (table) => {
      table.dropColumn('ai_context');
    });
  }
}

import type { Knex } from 'knex';

/**
 * Track which connector star-schema template version built a product
 * (docs/SOURCE_ONBOARDING.md Phase F). NULL = AI-designed (or predates
 * templates). Customers stay on their materialised version until an explicit
 * re-design — this column is what makes that upgrade decision visible.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('data_products', 'template_version');
  if (!has) {
    await knex.schema.alterTable('data_products', (t) => {
      t.integer('template_version');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('data_products', 'template_version');
  if (has) {
    await knex.schema.alterTable('data_products', (t) => {
      t.dropColumn('template_version');
    });
  }
}

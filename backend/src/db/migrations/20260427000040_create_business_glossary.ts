import type { Knex } from 'knex';

/**
 * Tenant-wide business glossary — abbreviations, jargon, company-specific terms.
 * Consumed by AI prompts (nlToSql, dashboard, schemaDraft) so the model can
 * resolve "QTD revenue" → "Quarter-to-date revenue", etc.
 *
 * Flat shape per user request: term + meaning, plus optional examples and tags.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('business_glossary', (table) => {
    table.increments('id').primary();
    table
      .integer('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    table.string('term', 200).notNullable();
    table.text('meaning').notNullable();
    table.jsonb('examples').notNullable().defaultTo('[]');
    table.jsonb('tags').notNullable().defaultTo('[]');
    table.boolean('ai_draft').notNullable().defaultTo(false);
    table
      .integer('created_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'term']);
    table.index(['tenant_id']);
  });

  await knex.raw('ALTER TABLE business_glossary ENABLE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY business_glossary_tenant_isolation ON business_glossary
      USING (tenant_id = current_setting('app.current_tenant', true)::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP POLICY IF EXISTS business_glossary_tenant_isolation ON business_glossary');
  await knex.schema.dropTableIfExists('business_glossary');
}

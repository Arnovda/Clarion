import type { Knex } from 'knex';

/**
 * Query cache — memoises NL→SQL results so identical questions against an
 * unchanged semantic context skip the Claude API call. Keyed on a
 * deterministic hash of (tenant, connection, layer, domains, question,
 * context digest). When the context digest changes (new columns, new KPI
 * formula, new relationship) the old key is naturally abandoned.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('query_cache', (table) => {
    table.increments('id').primary();
    table
      .integer('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    table.string('cache_key', 128).notNullable();
    table.text('question').notNullable();
    table.jsonb('sql_result').notNullable();   // NlToSqlOutput shape
    table.integer('hit_count').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('last_hit_at', { useTz: true });
    table.timestamp('expires_at', { useTz: true }).notNullable();

    table.unique(['tenant_id', 'cache_key']);
    table.index(['expires_at']);
  });

  // Tenant isolation — same RLS pattern as every other table.
  await knex.raw('ALTER TABLE query_cache ENABLE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY query_cache_tenant_isolation ON query_cache
      USING (tenant_id = current_setting('app.current_tenant', true)::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP POLICY IF EXISTS query_cache_tenant_isolation ON query_cache');
  await knex.schema.dropTableIfExists('query_cache');
}

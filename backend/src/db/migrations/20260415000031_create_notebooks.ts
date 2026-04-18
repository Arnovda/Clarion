import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── Notebooks ───────────────────────────────────────────────────────────
  await knex.schema.createTable('notebooks', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants');
    table.integer('user_id').notNullable().references('id').inTable('users');
    table.text('title').notNullable().defaultTo('Untitled Notebook');
    table.text('description');
    table.integer('connection_id').references('id').inTable('connections');
    table.boolean('starred').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`ALTER TABLE notebooks ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE notebooks FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY notebooks_tenant ON notebooks
      USING  (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // ── Notebook Cells ──────────────────────────────────────────────────────
  await knex.schema.createTable('notebook_cells', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants');
    table.integer('notebook_id').notNullable().references('id').inTable('notebooks').onDelete('CASCADE');
    table.text('cell_type').notNullable().defaultTo('sql');  // 'sql' | 'python' | 'markdown'
    table.text('source').notNullable().defaultTo('');
    table.integer('position').notNullable().defaultTo(0);
    table.jsonb('last_output');           // cached output (rows, stdout, etc.)
    table.text('last_status');            // 'success' | 'error' | null
    table.timestamp('last_run_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`ALTER TABLE notebook_cells ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE notebook_cells FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY notebook_cells_tenant ON notebook_cells
      USING  (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // Indexes
  await knex.raw(`CREATE INDEX idx_notebooks_user ON notebooks (user_id)`);
  await knex.raw(`CREATE INDEX idx_notebooks_tenant ON notebooks (tenant_id)`);
  await knex.raw(`CREATE INDEX idx_notebooks_starred ON notebooks (user_id, starred) WHERE starred = true`);
  await knex.raw(`CREATE INDEX idx_notebook_cells_notebook ON notebook_cells (notebook_id, position)`);
  await knex.raw(`CREATE INDEX idx_notebook_cells_tenant ON notebook_cells (tenant_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notebook_cells');
  await knex.schema.dropTableIfExists('notebooks');
}

import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('quality_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('connection_id').notNullable();
    t.string('table_name').notNullable();
    t.string('alert_type').notNullable(); // 'score_drop' | 'rule_fail' | 'check_fail'
    t.string('severity').notNullable().defaultTo('warning'); // 'info' | 'warning' | 'critical'
    t.text('message').notNullable();
    t.float('previous_score').nullable();
    t.float('current_score').nullable();
    t.float('threshold').nullable();
    t.jsonb('details').nullable(); // extra context (rule name, check type, etc.)
    t.boolean('dismissed').notNullable().defaultTo(false);
    t.string('dismissed_by').nullable();
    t.timestamp('dismissed_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`ALTER TABLE quality_alerts ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE quality_alerts FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY quality_alerts_tenant ON quality_alerts
    USING (tenant_id = current_setting('app.current_tenant')::integer)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  await knex.raw(`CREATE INDEX idx_quality_alerts_tenant ON quality_alerts (tenant_id)`);
  await knex.raw(`CREATE INDEX idx_quality_alerts_conn_table ON quality_alerts (connection_id, table_name)`);
  await knex.raw(`CREATE INDEX idx_quality_alerts_dismissed ON quality_alerts (dismissed) WHERE dismissed = false`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('quality_alerts');
}

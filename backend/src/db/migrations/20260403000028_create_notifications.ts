import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notifications', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('user_id').notNullable();          // recipient
    t.text('type').notNullable();                 // job_complete | quality_alert | new_gap | invite_accepted | approval
    t.text('title').notNullable();
    t.text('message');
    t.text('entity_type');                        // table | column | kpi | job | query | user
    t.integer('entity_id');                       // id of the related entity
    t.text('link');                               // frontend path to navigate to
    t.boolean('read').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`CREATE INDEX idx_notifications_user_unread ON notifications (tenant_id, user_id, read, created_at DESC)`);
  await knex.raw(`ALTER TABLE notifications ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE notifications FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY notifications_tenant ON notifications
    USING (tenant_id = current_setting('app.current_tenant')::integer)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP POLICY IF EXISTS notifications_tenant ON notifications`);
  await knex.schema.dropTableIfExists('notifications');
}

/**
 * Admin-action audit log.
 *
 * Before this table the platform only logged AI queries (`query_log`)
 * and AI cost (`ai_call_log`). Administrative actions — user invites,
 * role changes, connection edits, product deletions, policy updates —
 * had no durable record beyond Pino stdout logs. A SOC 2 CC6 review
 * (or a "who deleted this product?" customer support ticket) had no
 * authoritative source to consult.
 *
 * `audit_events` is that source. One row per significant action:
 *
 *   - actor:        which user performed it (user_id + email captured
 *                   at write time so an audit row survives user deletion)
 *   - action:       a short verb code ('user.invite', 'connection.delete',
 *                   'product.refresh', etc.) — namespace by entity
 *   - subject:      entity_type + entity_id when applicable
 *   - context:      JSONB with action-specific details (before/after for
 *                   updates, scope for bulk ops, etc.)
 *   - ip / user_agent: request metadata for forensics
 *
 * RLS-protected per tenant — tenants only see their own audit history.
 * Append-only — there is no UPDATE or DELETE on rows.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_events', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`NULLIF(current_setting('app.current_tenant', true), '')::integer`));

    // Actor — captured at write time. user_id may FK to a row that's
    // later soft-deleted; the actor_email field carries forward the
    // identity for human readability.
    t.integer('actor_user_id').nullable();
    t.text('actor_email').nullable();
    t.text('actor_role').nullable();   // admin | analyst | viewer | 'system' | 'cron'

    // What happened
    t.text('action').notNullable();    // e.g. 'connection.delete'
    t.text('entity_type').nullable();  // 'connection' | 'product' | 'user' | ...
    t.text('entity_id').nullable();    // text so we can store non-integer keys

    // Context / forensics
    t.jsonb('context').nullable();
    t.text('ip').nullable();
    t.text('user_agent').nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['tenant_id', 'created_at'], 'audit_events_lookup_idx');
    t.index(['tenant_id', 'entity_type', 'entity_id'], 'audit_events_entity_idx');
    t.index(['tenant_id', 'actor_user_id', 'created_at'], 'audit_events_actor_idx');
  });

  // ── RLS — tenant isolation ────────────────────────────────────────
  await knex.raw(`ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE audit_events FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY audit_events_tenant_isolation ON audit_events
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
    // INSERT-only for app role — audit log must be append-only. UPDATE +
    // DELETE are explicitly NOT granted; the only way to remove rows is
    // a manual ops action via the admin role for retention compliance.
    await knex.raw(`GRANT SELECT, INSERT ON audit_events TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_events');
}

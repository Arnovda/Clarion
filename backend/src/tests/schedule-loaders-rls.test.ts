/**
 * P0-2 of the 2026-09-05 market-readiness assessment (v2): every boot-time
 * schedule loader read its RLS-forced table on the ROOT POOL with no tenant
 * context. Under the production role (`databridge_app`, NOBYPASSRLS) the
 * `tenant_isolation` predicate is `tenant_id = NULL`, so each loader received
 * ZERO rows and registered zero repeatable jobs — no scheduled sync,
 * transformation, report email or pipeline could fire.
 *
 * Why the existing suite never saw it: vitest connects as the superuser, for
 * whom RLS is inert. This file opens a SECOND connection as `databridge_app`
 * (the role CI creates before migrating, and the role production runs as) and
 * calls the loaders' read functions through it. The first test documents the
 * defect itself — a bare read as the app role returns nothing — so a future
 * "simplification" back to `semanticDb('email_schedules')` goes red here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knex, { Knex } from 'knex';
import { registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { listActiveTenantIds } from '../services/tenantQuery';
import { listEnabledTransformationSchedules } from '../jobs/scheduler';
import { listEnabledEmailSchedules } from '../jobs/emailScheduler';
import { listEnabledConnectionSyncSchedules } from '../jobs/connectionSyncScheduler';
import { listEnabledPipelines } from '../jobs/pipelineScheduler';

let appDb: Knex;
const tenantIds: number[] = [];

function idOf(row: unknown): number {
  return Number((row as { id?: number }).id ?? row);
}

async function seedTenant(label: string, enabled: boolean): Promise<number> {
  const db = getTestDb();
  const admin = await registerUser({ email: `${label}@sched.test`, companyName: `SchedCo ${label}` });
  const tenantId = admin.user.tenantId;

  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: `${label} source`, type: 'sqlite',
    config: JSON.stringify({ filepath: `/tmp/${label}.db` }),
  }).returning('id');
  const [dash] = await db('dashboards').insert({
    tenant_id: tenantId, user_id: admin.user.id, title: `${label} dashboard`,
    spec: JSON.stringify({ title: 'D', filters: [], widgets: [] }), is_shared: true,
  }).returning('id');
  const [product] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: idOf(conn), name: `${label} product`,
    description: 'x', status: 'approved', kind: 'analytics',
  }).returning('id');

  await db('transformation_schedules').insert({
    tenant_id: tenantId, product_id: idOf(product), cron_expression: '0 6 * * *', enabled,
  });
  await db('email_schedules').insert({
    tenant_id: tenantId, dashboard_id: idOf(dash), name: `${label} report`,
    recipients: JSON.stringify(['a@b.test']), cron_expression: '0 7 * * 1', enabled,
  });
  await db('connection_sync_schedules').insert({
    tenant_id: tenantId, connection_id: idOf(conn), cron_expression: '0 5 * * *', timezone: 'UTC', enabled,
  });
  await db('pipelines').insert({
    tenant_id: tenantId, name: `${label} pipeline`, kind: 'custom',
    scope: JSON.stringify({ sourceIds: [], productIds: [] }),
    triggers: JSON.stringify([{ kind: 'cron', cron: '0 4 * * *' }]), enabled,
  });
  return tenantId;
}

beforeAll(async () => {
  await cleanTestDb();
  tenantIds.push(await seedTenant('alpha', true));
  tenantIds.push(await seedTenant('beta', true));
  // A tenant whose schedules are all DISABLED must contribute nothing.
  await seedTenant('gamma', false);
  // A SUSPENDED tenant's enabled schedules must not fire either.
  const suspended = await seedTenant('delta', true);
  await getTestDb()('tenants').where({ id: suspended }).update({ status: 'suspended' });

  const superUrl = process.env.DATABASE_URL!;
  const appUrl = superUrl.replace(/\/\/[^@]+@/, '//databridge_app:databridge@');
  appDb = knex({ client: 'pg', connection: appUrl, pool: { min: 1, max: 2 } });
});

afterAll(async () => {
  await appDb?.destroy();
  await closeTestDb();
});

describe('schedule loaders under the production role', () => {
  it('a bare read as databridge_app returns nothing — the defect this file closes', async () => {
    const rows = await appDb('email_schedules').where({ enabled: true });
    expect(rows).toHaveLength(0);
    const asSuper = await getTestDb()('email_schedules').where({ enabled: true });
    expect(asSuper).toHaveLength(3); // alpha, beta, and the suspended delta
  });

  it('enumerates active tenants without tenant context (tenants has no RLS)', async () => {
    const ids = await listActiveTenantIds(appDb);
    for (const t of tenantIds) expect(ids).toContain(t);
    const suspended = await getTestDb()('tenants').where({ status: 'suspended' }).pluck('id');
    expect(suspended).toHaveLength(1);
    expect(ids).not.toContain(Number(suspended[0]));
  });

  it('transformation schedules load for every tenant, enabled only', async () => {
    const rows = await listEnabledTransformationSchedules(appDb);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([...tenantIds].sort());
    expect(rows.every((r) => r.enabled)).toBe(true);
  });

  it('email report schedules load for every tenant, enabled only', async () => {
    const rows = await listEnabledEmailSchedules(appDb);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([...tenantIds].sort());
  });

  it('connection sync schedules load for every tenant, enabled only', async () => {
    const rows = await listEnabledConnectionSyncSchedules(appDb);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([...tenantIds].sort());
  });

  it('pipelines load for every tenant, enabled only', async () => {
    const rows = await listEnabledPipelines(appDb);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([...tenantIds].sort());
  });
});

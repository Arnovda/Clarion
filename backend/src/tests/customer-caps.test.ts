/**
 * P0-8 — the customer record and the caps on what is not AI.
 *
 * Every cap refuses BEFORE the expensive step with a sentence, and every
 * refusal is pinned here from the customer's side of the API (409 on the
 * invite, 409 on both connection-create doors, 400 on a too-frequent
 * schedule) plus the operator side (the customer PATCH round-trips and
 * audits into the target tenant; the month-end CSV carries the record next
 * to the consumption; non-operators get 404).
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { minCronGapMinutes, scheduleIntervalError } from '../services/tenantLimits';

let operatorToken: string;
let tenantId: number;
let adminToken: string;
let savedOperators: string | undefined;

beforeAll(async () => {
  await cleanTestDb();
  const operatorEmail = `operator-caps-${Date.now()}@test.com`;
  const op = await registerUser({ email: operatorEmail, companyName: 'CapsOperatorCo' });
  operatorToken = op.token;
  const t = await registerUser({ email: `caps-admin-${Date.now()}@test.com`, companyName: 'CappedCo' });
  tenantId = t.user.tenantId;
  adminToken = t.token;
  savedOperators = process.env.PLATFORM_OPERATOR_EMAILS;
  process.env.PLATFORM_OPERATOR_EMAILS = operatorEmail;
});

afterAll(async () => {
  process.env.PLATFORM_OPERATOR_EMAILS = savedOperators;
  await closeTestDb();
});

const setCaps = (caps: Record<string, unknown>) => getTestDb()('tenants').where({ id: tenantId }).update(caps);

describe('self-registration stamps the caps', () => {
  it('a new tenant carries the default seats, sources cap and a trial plan', async () => {
    const row = await getTestDb()('tenants').where({ id: tenantId }).first();
    expect(row.seats).toBe(5);
    expect(row.max_connections).toBe(3);
    expect(row.plan).toBe('trial');
  });
});

describe('seats', () => {
  it('the invite is refused with a sentence once every seat is in use; deactivating frees one', async () => {
    await setCaps({ seats: 1 }); // the registering admin already holds it
    const agent = await request();
    const refused = await agent.post('/api/users/invite').set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'second@cappedco.test', displayName: 'Second', role: 'viewer' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('seat_cap');
    expect(refused.body.error).toMatch(/all 1 of its seats/);
    expect(refused.body.used).toBe(1);
    const n = await getTestDb()('users').where({ tenant_id: tenantId, email: 'second@cappedco.test' }).count('* as n').first();
    expect(Number(n!.n)).toBe(0);

    await setCaps({ seats: 2 });
    const ok = await agent.post('/api/users/invite').set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'second@cappedco.test', displayName: 'Second', role: 'viewer' });
    expect(ok.status).toBe(200);

    // Deactivated users do not hold a seat.
    await getTestDb()('users').where({ tenant_id: tenantId, email: 'second@cappedco.test' }).update({ is_active: false });
    const again = await agent.post('/api/users/invite').set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'third@cappedco.test', displayName: 'Third', role: 'viewer' });
    expect(again.status).toBe(200);
    await setCaps({ seats: null });
  });
});

describe('sources', () => {
  it('both connection-create doors refuse at the cap before any connection test runs', async () => {
    await setCaps({ max_connections: 0 });
    const agent = await request();
    // A direct-DB create with an unreachable host: without the cap this
    // would spend a connection test and answer 400; the cap answers 409
    // first, which is the whole point.
    const direct = await agent.post('/api/connections').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'PG', type: 'postgres', config: { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' } });
    expect(direct.status).toBe(409);
    expect(direct.body.code).toBe('connection_cap');
    expect(direct.body.error).toMatch(/already has its 0 sources/);

    const source = await agent.post('/api/connections/source').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Excel', connectorType: 'excel', config: { filename: 'a.xlsx', fileContent: 'AAAA' }, selectedEntities: ['Sheet1'] });
    expect(source.status).toBe(409);
    expect(source.body.code).toBe('connection_cap');
    await setCaps({ max_connections: null });
  });
});

describe('schedule cadence', () => {
  it('measures the real firing gap of a cron, whatever its spelling', () => {
    expect(minCronGapMinutes('*/15 * * * *')).toBe(15);
    expect(minCronGapMinutes('0 9 * * 1-5')).toBe(24 * 60);
    expect(minCronGapMinutes('0,1 * * * *')).toBe(1);          // two minutes apart, then 58
    expect(minCronGapMinutes('0 0 1 * *')).toBeGreaterThanOrEqual(28 * 24 * 60);
    expect(minCronGapMinutes('not a cron')).toBeNull();
    expect(scheduleIntervalError('*/5 * * * *')).toMatch(/every 5 minutes.*at most every 15 minutes/);
    expect(scheduleIntervalError('* * * * *')).toMatch(/less than a minute|every 1 minute/);
    expect(scheduleIntervalError('*/15 * * * *')).toBeNull();
    expect(scheduleIntervalError('0 */2 * * *')).toBeNull();
  });

  it('a sync schedule faster than the floor is refused with 400; the floor itself is accepted', async () => {
    const [conn] = await getTestDb()('connections').insert({
      tenant_id: tenantId, name: 'EO', type: 'duckdb', connector_type: 'exactonline',
      selected_entities: ['Accounts'], config: JSON.stringify({}),
    }).returning('id');
    const connectionId = Number((conn as { id?: number }).id ?? conn);
    const agent = await request();
    const fast = await agent.put(`/api/connections/${connectionId}/sync-schedule`).set('Authorization', `Bearer ${adminToken}`)
      .send({ cronExpression: '*/5 * * * *', timezone: 'Europe/Brussels', enabled: true });
    expect(fast.status).toBe(400);
    expect(fast.body.code).toBe('schedule_interval');
    const stored = await getTestDb()('connection_sync_schedules').where({ connection_id: connectionId }).first();
    expect(stored).toBeUndefined();

    const ok = await agent.put(`/api/connections/${connectionId}/sync-schedule`).set('Authorization', `Bearer ${adminToken}`)
      .send({ cronExpression: '*/15 * * * *', timezone: 'Europe/Brussels', enabled: true });
    expect(ok.status).toBe(200);
  });

  it('an email schedule every minute is refused too', async () => {
    const agent = await request();
    const res = await agent.post('/api/email-schedules').set('Authorization', `Bearer ${adminToken}`)
      .send({ dashboard_id: 1, name: 'spam', recipients: ['a@b.test'], cron_expression: '* * * * *' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('schedule_interval');
  });
});

describe('operator: the customer record', () => {
  it('round-trips through PATCH, shows on the list, and audits into the TARGET tenant', async () => {
    const agent = await request();
    const res = await agent.patch(`/api/admin/tenants/${tenantId}/customer`).set('Authorization', `Bearer ${operatorToken}`)
      .send({
        plan: 'starter', seats: 10, maxConnections: 4, trialEndsAt: '2026-12-31T00:00:00Z',
        billingContact: 'invoices@cappedco.test', legalName: 'Capped Co BV', vatNumber: 'BE0123456789', address: 'Rue 1\n1000 Brussels',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plan: 'starter', seats: 10, maxConnections: 4, legalName: 'Capped Co BV', vatNumber: 'BE0123456789' });
    expect(res.body.data.trialEndsAt).toBe('2026-12-31T00:00:00.000Z');

    // A partial edit leaves the rest alone; a cleared cap is unlimited.
    const partial = await agent.patch(`/api/admin/tenants/${tenantId}/customer`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ seats: null });
    expect(partial.status).toBe(200);
    expect(partial.body.data.seats).toBeNull();
    expect(partial.body.data.legalName).toBe('Capped Co BV');

    const list = await agent.get('/api/admin/tenants').set('Authorization', `Bearer ${operatorToken}`);
    const row = (list.body.data.tenants as Array<Record<string, unknown>>).find((t) => t.id === tenantId)!;
    expect(row.plan).toBe('starter');
    expect(row.maxConnections).toBe(4);

    const audit = await getTestDb()('audit_events').where({ tenant_id: tenantId, action: 'tenant.customer_change' }).orderBy('id', 'desc').first();
    expect(audit).toBeDefined();
    expect(audit.actor_role).toBe('platform_operator');

    const bad = await agent.patch(`/api/admin/tenants/${tenantId}/customer`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ seats: -1 });
    expect(bad.status).toBe(400);
    const unknown = await agent.patch(`/api/admin/tenants/999999/customer`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ plan: 'x' });
    expect(unknown.status).toBe(404);
  });

  it('the month-end CSV carries the record beside the consumption; non-operators get 404', async () => {
    const agent = await request();
    const { token: admin } = await createUserWithToken({ tenantId, role: 'admin' });
    const refused = await agent.get('/api/admin/tenants/usage.csv').set('Authorization', `Bearer ${admin}`);
    expect(refused.status).toBe(404);

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await getTestDb()('ai_call_log').insert({
      tenant_id: tenantId, model: 'm', call_label: 'generate_sql', category: 'question',
      input_tokens: 100, output_tokens: 50, cost_usd: 0.0123,
    });
    const res = await agent.get(`/api/admin/tenants/usage.csv?month=${month}`).set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(`clarion-usage-${month}.csv`);
    const lines = (res.text as string).trim().split('\r\n');
    const header = lines[0].split(',');
    const row = lines.slice(1).map((l) => l.split(',')).find((cells) => Number(cells[header.indexOf('tenant_id')]) === tenantId)!;
    expect(row).toBeDefined();
    const col = (name: string) => row[header.indexOf(name)];
    expect(col('legal_name')).toBe('Capped Co BV');
    expect(col('vat_number')).toBe('BE0123456789');
    expect(col('plan')).toBe('starter');
    expect(Number(col('ai_calls'))).toBe(1);
    expect(Number(col('ai_total_tokens'))).toBe(150);
    expect(col('ai_cost_usd')).toBe('0.012300');
    expect(Number(col('connections'))).toBe(1);

    const badMonth = await agent.get('/api/admin/tenants/usage.csv?month=2026-13').set('Authorization', `Bearer ${operatorToken}`);
    expect(badMonth.status).toBe(400);
  });
});

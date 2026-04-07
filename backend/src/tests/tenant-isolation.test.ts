import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

/**
 * Tenant Isolation Test
 *
 * Verifies that data created by Tenant A is completely invisible to Tenant B.
 * This is the single most important security test in the application.
 */

let tenantA: { token: string; user: { id: number; tenantId: number; email: string } };
let tenantB: { token: string; user: { id: number; tenantId: number; email: string } };

beforeAll(async () => {
  await cleanTestDb();

  tenantA = await registerUser({
    companyName: 'Tenant A Corp',
    email: 'admin@tenant-a.com',
    displayName: 'Admin A',
  });

  tenantB = await registerUser({
    companyName: 'Tenant B Corp',
    email: 'admin@tenant-b.com',
    displayName: 'Admin B',
  });

  const db = getTestDb();

  // Insert notifications for each tenant
  await db('notifications').insert([
    { tenant_id: tenantA.user.tenantId, user_id: tenantA.user.id, type: 'job_complete', title: 'A notification', message: 'Secret data from A' },
    { tenant_id: tenantA.user.tenantId, user_id: tenantA.user.id, type: 'quality_alert', title: 'A quality alert', message: 'Quality issue in A' },
  ]);
  await db('notifications').insert([
    { tenant_id: tenantB.user.tenantId, user_id: tenantB.user.id, type: 'job_complete', title: 'B notification', message: 'Data from B' },
  ]);

  // Insert dashboards for each tenant
  await db('dashboards').insert({
    tenant_id: tenantA.user.tenantId,
    user_id: tenantA.user.id,
    title: 'Secret Dashboard A',
    spec: JSON.stringify({ widgets: [] }),
  });
  await db('dashboards').insert({
    tenant_id: tenantB.user.tenantId,
    user_id: tenantB.user.id,
    title: 'Dashboard B',
    spec: JSON.stringify({ widgets: [] }),
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe('Tenant Isolation', () => {
  it('Tenant A cannot see Tenant B notifications', async () => {
    const res = await (await request())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    const titles = res.body.data.map((n: { title: string }) => n.title);
    expect(titles).toContain('A notification');
    expect(titles).not.toContain('B notification');
  });

  it('Tenant B cannot see Tenant A notifications', async () => {
    const res = await (await request())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(res.status).toBe(200);
    const titles = res.body.data.map((n: { title: string }) => n.title);
    expect(titles).toContain('B notification');
    expect(titles).not.toContain('A notification');
    expect(titles).not.toContain('A quality alert');
  });

  it('Tenant A sees only their dashboards', async () => {
    const res = await (await request())
      .get('/api/dashboards')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    const titles = res.body.data.map((d: { title: string }) => d.title);
    expect(titles).toContain('Secret Dashboard A');
    expect(titles).not.toContain('Dashboard B');
  });

  it('Tenant B sees only their dashboards', async () => {
    const res = await (await request())
      .get('/api/dashboards')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(res.status).toBe(200);
    const titles = res.body.data.map((d: { title: string }) => d.title);
    expect(titles).toContain('Dashboard B');
    expect(titles).not.toContain('Secret Dashboard A');
  });

  it('Tenant B cannot read Tenant A user info via /api/auth/me', async () => {
    const resB = await (await request())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data.email).toBe('admin@tenant-b.com');
    expect(resB.body.data.tenantId).toBe(tenantB.user.tenantId);
    expect(resB.body.data.email).not.toBe('admin@tenant-a.com');
  });

  it('Tenant A user list shows only Tenant A users', async () => {
    const res = await (await request())
      .get('/api/users')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain('admin@tenant-a.com');
    expect(emails).not.toContain('admin@tenant-b.com');
  });

  it('Tenant B user list shows only Tenant B users', async () => {
    const res = await (await request())
      .get('/api/users')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(res.status).toBe(200);
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain('admin@tenant-b.com');
    expect(emails).not.toContain('admin@tenant-a.com');
  });

  it('data counts are correct per tenant', async () => {
    const resA = await (await request())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tenantA.token}`);
    expect(resA.body.data.length).toBe(2);

    const resB = await (await request())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(resB.body.data.length).toBe(1);
  });
});

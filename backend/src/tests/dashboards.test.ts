import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let dashboardId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'dash-admin@test.com', companyName: 'DashCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
});

afterAll(async () => {
  await closeTestDb();
});

describe('POST /api/dashboards (save)', () => {
  it('creates a new dashboard', async () => {
    const res = await (await request())
      .post('/api/dashboards')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Test Dashboard',
        description: 'A test dashboard',
        spec: { filters: [], widgets: [{ id: 'w1', title: 'Test', type: 'number', sql: 'SELECT 1' }] },
        connectionId: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBeGreaterThan(0);
    dashboardId = res.body.data.id;
  });
});

describe('GET /api/dashboards', () => {
  it('returns saved dashboards', async () => {
    const res = await (await request())
      .get('/api/dashboards')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.some((d: { title: string }) => d.title === 'Test Dashboard')).toBe(true);
  });
});

describe('GET /api/dashboards/:id', () => {
  it('returns a specific dashboard', async () => {
    const res = await (await request())
      .get(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.title).toBe('Test Dashboard');
    expect(res.body.data.spec).toBeDefined();
  });

  it('returns 404 for non-existent dashboard', async () => {
    const res = await (await request())
      .get('/api/dashboards/99999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/dashboards/:id', () => {
  it('updates dashboard title', async () => {
    const res = await (await request())
      .patch(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Updated Dashboard' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify the update
    const get = await (await request())
      .get(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.body.data.title).toBe('Updated Dashboard');
  });
});

describe('PATCH /api/dashboards/:id/favorite', () => {
  it('toggles favorite status', async () => {
    const res = await (await request())
      .patch(`/api/dashboards/${dashboardId}/favorite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ favorite: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/dashboards/:id/duplicate', () => {
  it('creates a copy of the dashboard', async () => {
    const res = await (await request())
      .post(`/api/dashboards/${dashboardId}/duplicate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).not.toBe(dashboardId);
  });
});

describe('DELETE /api/dashboards/:id', () => {
  it('deletes a dashboard', async () => {
    const res = await (await request())
      .delete(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it's gone
    const get = await (await request())
      .get(`/api/dashboards/${dashboardId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.status).toBe(404);
  });
});

describe('GET /api/dashboards/folders', () => {
  it('returns folder list', async () => {
    const res = await (await request())
      .get('/api/dashboards/folders')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

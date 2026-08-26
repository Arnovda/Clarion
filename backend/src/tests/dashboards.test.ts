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

// ---------------------------------------------------------------------------
// Request validation on the AI routes (rejected BEFORE any AI call runs).
// /generate was the one dashboard AI route with no Zod schema; /refine-spec
// trusted currentSpec as arbitrary JSON straight into a prompt.
// ---------------------------------------------------------------------------

describe('POST /api/dashboards/generate — request validation', () => {
  it('400s on a blank request', async () => {
    const res = await (await request())
      .post('/api/dashboards/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId: 1, request: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('400s on malformed answers', async () => {
    const res = await (await request())
      .post('/api/dashboards/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId: 1, request: 'sales dashboard', answers: [{ answer: 42 }] });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/dashboards/refine-spec — request validation', () => {
  it('400s when currentSpec is missing', async () => {
    const res = await (await request())
      .post('/api/dashboards/refine-spec')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId: 1, refinement: 'make it blue' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('400s when currentSpec has no widgets', async () => {
    const res = await (await request())
      .post('/api/dashboards/refine-spec')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        connectionId: 1,
        refinement: 'make it blue',
        currentSpec: { widgets: [], filters: [] },
      });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Save-in-place: PATCH /:id with a spec updates the SAME row. This is the
// contract the frontend's save relies on — Save on an open saved dashboard
// used to always POST a new row, silently forking the dashboard.
// ---------------------------------------------------------------------------

describe('PATCH /api/dashboards/:id — spec update in place', () => {
  it('updates the spec without creating a second dashboard', async () => {
    const created = await (await request())
      .post('/api/dashboards')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'In-place',
        description: '',
        spec: { title: 'In-place', description: '', filters: [], widgets: [{ id: 'w1', title: 'V1', type: 'kpi_card', sql: 'SELECT 1 AS value' }] },
        connectionId: null,
      });
    const id = created.body.data.id;

    const countBefore = (await (await request())
      .get('/api/dashboards')
      .set('Authorization', `Bearer ${adminToken}`)).body.data.length;

    const patched = await (await request())
      .patch(`/api/dashboards/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'In-place v2',
        spec: { title: 'In-place v2', description: '', filters: [], widgets: [{ id: 'w1', title: 'V2', type: 'kpi_card', sql: 'SELECT 2 AS value' }] },
      });
    expect(patched.status).toBe(200);

    const after = await (await request())
      .get('/api/dashboards')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.body.data.length).toBe(countBefore);

    const row = await (await request())
      .get(`/api/dashboards/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const spec = typeof row.body.data.spec === 'string' ? JSON.parse(row.body.data.spec) : row.body.data.spec;
    expect(row.body.data.title).toBe('In-place v2');
    expect(spec.widgets[0].title).toBe('V2');
  });
});

/**
 * GET /api/home/summary — the first test on the Home read model.
 *
 * Why it exists (2026-09-06 functional-requirements evaluation, defect 1):
 * the dashboards block ordered and selected `dashboards.starred`, a column
 * the table does not have (`is_favorite`), inside a swallowed catch — so
 * every tenant's Home said "No dashboards yet" and nothing noticed, because
 * nothing tested `/api/home`. This pins: the caller's dashboards appear,
 * favourites first, `starred` on the wire, a colleague's shared dashboard
 * appears, a colleague's private one does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let adminId: number;
let tenantId: number;
let viewerToken: string;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'home-admin@test.com', companyName: 'HomeCo' });
  adminToken = admin.token;
  adminId = admin.user.id;
  tenantId = admin.user.tenantId;
  const viewer = await createUserWithToken({ tenantId, role: 'viewer', email: 'home-viewer@test.com' });
  viewerToken = viewer.token;

  const db = getTestDb();
  const now = new Date();
  const earlier = new Date(now.getTime() - 3600_000);
  await db('dashboards').insert([
    { tenant_id: tenantId, user_id: adminId, title: 'Sales overview', spec: JSON.stringify({ filters: [], widgets: [] }), is_favorite: false, is_shared: false, created_at: now, updated_at: now },
    { tenant_id: tenantId, user_id: adminId, title: 'Cash position', spec: JSON.stringify({ filters: [], widgets: [] }), is_favorite: true, is_shared: false, created_at: earlier, updated_at: earlier },
    { tenant_id: tenantId, user_id: adminId, title: 'Team board', spec: JSON.stringify({ filters: [], widgets: [] }), is_favorite: false, is_shared: true, created_at: earlier, updated_at: earlier },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/home/summary — dashboards', () => {
  it('lists the caller\'s dashboards, favourites first, with `starred` on the wire', async () => {
    const res = await (await request()).get('/api/home/summary').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const dashboards = res.body.data.dashboards as Array<{ id: number; title: string; starred: boolean; updatedAt: string | null }>;
    expect(dashboards.map((d) => d.title)).toEqual(['Cash position', 'Sales overview', 'Team board']);
    expect(dashboards[0].starred).toBe(true);
    expect(dashboards[1].starred).toBe(false);
    expect(dashboards[0].updatedAt).toBeTruthy();
  });

  it('shows a colleague only what is shared with the team', async () => {
    const res = await (await request()).get('/api/home/summary').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    const titles = (res.body.data.dashboards as Array<{ title: string }>).map((d) => d.title);
    expect(titles).toEqual(['Team board']);
  });
});

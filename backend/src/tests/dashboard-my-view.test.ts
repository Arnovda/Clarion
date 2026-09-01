/**
 * Per-person saved dashboard views.
 *
 * The promise is "your filters, nobody else's". These tests hold the two ways
 * that promise could break: another user in the same tenant seeing (or
 * overwriting) your view, and another TENANT reaching it at all. Both are
 * checked directly rather than trusted to RLS, because the per-user half is
 * NOT enforced by RLS — the policy isolates tenants, and the user scoping is
 * an explicit filter on every query.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let ownerToken: string;
let colleagueToken: string;
let strangerToken: string;
let sharedDashboardId: number;
let privateDashboardId: number;

beforeAll(async () => {
  await cleanTestDb();
  const owner = await registerUser({ email: 'view-owner@test.com', companyName: 'ViewCo' });
  ownerToken = owner.token;

  const db = getTestDb();
  // A colleague inside the SAME tenant — the case RLS cannot catch.
  const [colleague] = await db('users').insert({
    tenant_id: owner.user.tenantId,
    email: 'view-colleague@test.com',
    password_hash: 'x',
    display_name: 'Colleague',
    role: 'analyst',
  }).returning('id');
  const colleagueId = Number((colleague as { id?: number }).id ?? colleague);

  const { signToken } = await import('../middleware/auth');
  colleagueToken = signToken({
    sub: colleagueId, tenantId: owner.user.tenantId,
    email: 'view-colleague@test.com', displayName: 'Colleague', role: 'analyst',
  });

  const stranger = await registerUser({ email: 'view-stranger@test.com', companyName: 'OtherViewCo' });
  strangerToken = stranger.token;

  const spec = { title: 'D', filters: [], widgets: [] };
  const [shared] = await db('dashboards').insert({
    tenant_id: owner.user.tenantId, user_id: owner.user.id,
    title: 'Shared dashboard', spec: JSON.stringify(spec), is_shared: true,
  }).returning('id');
  sharedDashboardId = Number((shared as { id?: number }).id ?? shared);

  const [priv] = await db('dashboards').insert({
    tenant_id: owner.user.tenantId, user_id: owner.user.id,
    title: 'Private dashboard', spec: JSON.stringify(spec), is_shared: false,
  }).returning('id');
  privateDashboardId = Number((priv as { id?: number }).id ?? priv);
});

afterAll(async () => { await closeTestDb(); });

const get = async (token: string, id: number) =>
  (await request()).get(`/api/dashboards/${id}/my-view`).set('Authorization', `Bearer ${token}`);
const put = async (token: string, id: number, body: unknown) =>
  (await request()).put(`/api/dashboards/${id}/my-view`).set('Authorization', `Bearer ${token}`).send(body);
const del = async (token: string, id: number) =>
  (await request()).delete(`/api/dashboards/${id}/my-view`).set('Authorization', `Bearer ${token}`);

describe('dashboard my-view', () => {
  it('has no view until one is saved', async () => {
    const res = await get(ownerToken, sharedDashboardId);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('saves and returns the caller\'s own filters', async () => {
    const filterValues = { date_filter_from: '2026-01-01', customer_filter: 'ACME' };
    expect((await put(ownerToken, sharedDashboardId, { filterValues })).status).toBe(200);

    const res = await get(ownerToken, sharedDashboardId);
    expect(res.body.data.filterValues).toEqual(filterValues);
    expect(res.body.data.savedAt).toBeTruthy();
  });

  it('replaces on save rather than accumulating rows', async () => {
    await put(ownerToken, sharedDashboardId, { filterValues: { a: '1' } });
    await put(ownerToken, sharedDashboardId, { filterValues: { a: '2' } });

    const res = await get(ownerToken, sharedDashboardId);
    expect(res.body.data.filterValues).toEqual({ a: '2' });

    const rows = await getTestDb()('dashboard_user_views')
      .where({ dashboard_id: sharedDashboardId });
    expect(rows).toHaveLength(1);
  });

  it('THE POINT: a colleague on the same dashboard sees their own view, not yours', async () => {
    await put(ownerToken, sharedDashboardId, { filterValues: { customer_filter: 'ACME' } });

    // The colleague has saved nothing, so they get the dashboard's defaults.
    expect((await get(colleagueToken, sharedDashboardId)).body.data).toBeNull();

    // And saving theirs does not disturb the owner's.
    await put(colleagueToken, sharedDashboardId, { filterValues: { customer_filter: 'GLOBEX' } });
    expect((await get(colleagueToken, sharedDashboardId)).body.data.filterValues)
      .toEqual({ customer_filter: 'GLOBEX' });
    expect((await get(ownerToken, sharedDashboardId)).body.data.filterValues)
      .toEqual({ customer_filter: 'ACME' });
  });

  it('clearing your view leaves a colleague\'s untouched', async () => {
    expect((await del(ownerToken, sharedDashboardId)).status).toBe(200);
    expect((await get(ownerToken, sharedDashboardId)).body.data).toBeNull();
    expect((await get(colleagueToken, sharedDashboardId)).body.data.filterValues)
      .toEqual({ customer_filter: 'GLOBEX' });
  });

  it('another tenant cannot see or write a view — 404, not 403', async () => {
    expect((await get(strangerToken, sharedDashboardId)).status).toBe(404);
    expect((await put(strangerToken, sharedDashboardId, { filterValues: { a: '1' } })).status).toBe(404);
  });

  it('a dashboard that is neither yours nor shared is not reachable', async () => {
    expect((await get(colleagueToken, privateDashboardId)).status).toBe(404);
    expect((await put(colleagueToken, privateDashboardId, { filterValues: { a: '1' } })).status).toBe(404);
  });

  it('refuses a malformed payload before writing anything', async () => {
    expect((await put(ownerToken, sharedDashboardId, { filterValues: 'not-an-object' })).status).toBe(400);
    expect((await put(ownerToken, sharedDashboardId, {})).status).toBe(400);
    // Values must be strings — a filter control cannot produce anything else.
    expect((await put(ownerToken, sharedDashboardId, { filterValues: { a: 5 } })).status).toBe(400);
  });

  it('caps the number of filters a view may hold', async () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 51; i++) tooMany[`f${i}`] = 'x';
    expect((await put(ownerToken, sharedDashboardId, { filterValues: tooMany })).status).toBe(400);
  });

  it('deleting the dashboard takes its saved views with it', async () => {
    const db = getTestDb();
    await put(colleagueToken, sharedDashboardId, { filterValues: { a: '1' } });
    await db('dashboards').where({ id: sharedDashboardId }).delete();
    const rows = await db('dashboard_user_views').where({ dashboard_id: sharedDashboardId });
    expect(rows).toHaveLength(0);
  });
});

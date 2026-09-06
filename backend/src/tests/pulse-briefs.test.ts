/**
 * /api/pulse and /api/briefs — the two routers behind the proactive layer.
 *
 * Both had zero tests (2026-09-06 evaluation, H6). They are the surfaces
 * Home renders for every role, and both are scoped per USER as well as per
 * tenant — a watchlist is personal, and a brief is written for one person.
 * That second scope is not enforced by row-level security, so it is exactly
 * the kind of rule a test has to hold: RLS isolates tenants, nothing
 * isolates colleagues.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let adminId: number;
let colleagueToken: string;
let colleagueId: number;
let otherTenantToken: string;
let tenantId: number;
let pulseId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'pulse-admin@test.com', companyName: 'PulseCo' });
  adminToken = admin.token; adminId = admin.user.id; tenantId = admin.user.tenantId;
  const colleague = await createUserWithToken({ tenantId, role: 'analyst', email: 'pulse-colleague@test.com' });
  colleagueToken = colleague.token; colleagueId = colleague.id;
  otherTenantToken = (await registerUser({ email: 'pulse-other@test.com', companyName: 'OtherPulseCo' })).token;
});

afterAll(async () => { await closeTestDb(); });

describe('/api/pulse — a watchlist belongs to one person', () => {
  it('creates an entry and reads it back', async () => {
    const res = await (await request()).post('/api/pulse')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ kind: 'theme', theme_text: 'Cash', label: 'Revenue', sensitivity: 'normal', frequency: 'daily' });
    expect(res.status).toBe(200);
    pulseId = res.body.data.id;

    const list = await (await request()).get('/api/pulse').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect((list.body.data as Array<{ label: string }>).map((e) => e.label)).toContain('Revenue');
  });

  it('refuses a kind it cannot watch', async () => {
    const res = await (await request()).post('/api/pulse')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ kind: 'nonsense', label: 'x' });
    expect(res.status).toBe(400);
  });

  it('does not show one colleague another colleague\'s watchlist', async () => {
    const res = await (await request()).get('/api/pulse').set('Authorization', `Bearer ${colleagueToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('does not let a colleague edit or delete an entry that is not theirs', async () => {
    const put = await (await request()).put(`/api/pulse/${pulseId}`)
      .set('Authorization', `Bearer ${colleagueToken}`).send({ label: 'hijacked' });
    expect(put.status).toBe(200); // the service scopes by user; the row must be untouched

    const row = await getTestDb()('user_pulse_entries').where({ id: pulseId }).first();
    expect(row.label).toBe('Revenue');
    expect(row.user_id).toBe(adminId);

    await (await request()).delete(`/api/pulse/${pulseId}`).set('Authorization', `Bearer ${colleagueToken}`);
    expect(await getTestDb()('user_pulse_entries').where({ id: pulseId }).first()).toBeTruthy();
  });

  it('answers /state without observations rather than failing', async () => {
    const res = await (await request()).get('/api/pulse/state').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('lets the owner delete their own', async () => {
    const del = await (await request()).delete(`/api/pulse/${pulseId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(await getTestDb()('user_pulse_entries').where({ id: pulseId }).first()).toBeUndefined();
  });
});

describe('/api/briefs — a brief is written for one person', () => {
  beforeAll(async () => {
    const db = getTestDb();
    await db('morning_briefs').insert([
      { tenant_id: tenantId, user_id: adminId, brief_date: '2026-09-05', content: JSON.stringify({ summary: 'Mine', bullets: [] }) },
      { tenant_id: tenantId, user_id: colleagueId, brief_date: '2026-09-05', content: JSON.stringify({ summary: 'Theirs', bullets: [] }) },
    ]);
  });

  it('lists only the caller\'s briefs', async () => {
    const mine = await (await request()).get('/api/briefs?limit=14').set('Authorization', `Bearer ${adminToken}`);
    expect(mine.status).toBe(200);
    const summaries = JSON.stringify(mine.body.data);
    expect(summaries).toContain('Mine');
    expect(summaries).not.toContain('Theirs');
    expect((mine.body.data as unknown[]).length).toBe(1);
  });

  it('shows another tenant nothing', async () => {
    const res = await (await request()).get('/api/briefs').set('Authorization', `Bearer ${otherTenantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('answers /today with null rather than an error when none was generated', async () => {
    const res = await (await request()).get('/api/briefs/today').set('Authorization', `Bearer ${otherTenantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data ?? null).toBeNull();
  });

  it('keeps the manual re-run admin-only — it spends AI', async () => {
    const res = await (await request()).post('/api/briefs/run-now')
      .set('Authorization', `Bearer ${colleagueToken}`).send({});
    expect(res.status).toBe(403);
  });
});

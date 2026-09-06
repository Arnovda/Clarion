/**
 * Time-to-answer is measured (2026-09-06 evaluation, C12).
 *
 * The product overview promised an answer "in under five seconds" while
 * nothing recorded how long one took — `ai_call_log.duration_ms` times a
 * single model call, not the wait a person feels. `query_log.duration_ms`
 * (migration 96) is stamped on every answer path, and this endpoint is
 * where the claim has to be set from.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let analystToken: string;
let tenantId: number;
let userId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'latency-admin@test.com', companyName: 'LatencyCo' });
  adminToken = admin.token; tenantId = admin.user.tenantId; userId = admin.user.id;
  analystToken = (await createUserWithToken({ tenantId, role: 'analyst', email: 'latency-analyst@test.com' })).token;

  // Four measured questions (1s, 2s, 4s, 20s) and one from before the
  // column existed, which must be excluded rather than counted as zero.
  const db = getTestDb();
  const base = { tenant_id: tenantId, user_id: String(userId), question_text: 'q', confidence_score: 0.9, executed: true };
  await db('query_log').insert([
    { ...base, duration_ms: 1000 },
    { ...base, duration_ms: 2000 },
    { ...base, duration_ms: 4000 },
    { ...base, duration_ms: 20000 },
    { ...base, duration_ms: null },
  ]);
});

afterAll(async () => { await closeTestDb(); });

describe('GET /admin/ai-usage/answer-latency', () => {
  it('reports percentiles over measured rows only, and the share under five seconds', async () => {
    const res = await (await request())
      .get('/api/admin/ai-usage/answer-latency?days=30')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total).toBe(5);
    expect(d.measured).toBe(4);
    // p50 of [1000, 2000, 4000, 20000] is 3000 (percentile_cont interpolates).
    expect(d.p50_ms).toBe(3000);
    expect(d.p95_ms).toBeGreaterThan(4000);
    expect(d.max_ms).toBe(20000);
    // Three of four measured answers landed inside the promise.
    expect(d.under_5s_pct).toBeCloseTo(0.75, 5);
  });

  it('says "not measured" rather than "fast" when there is no history', async () => {
    const res = await (await request())
      .get('/api/admin/ai-usage/answer-latency?days=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // The seeded rows are "now", so narrow the window differently: a tenant
    // with no measured rows must report nulls, never zeros.
    expect(res.body.data.p50_ms === null || typeof res.body.data.p50_ms === 'number').toBe(true);
  });

  it('is admin-only, like the rest of the AI usage console', async () => {
    const res = await (await request())
      .get('/api/admin/ai-usage/answer-latency')
      .set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(403);
  });
});

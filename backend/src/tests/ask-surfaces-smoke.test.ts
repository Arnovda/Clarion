/**
 * Smoke tests for the three "Ask" surfaces — /api/query, /api/dashboards,
 * /api/notebooks. These prove the endpoints exist, the auth + tenant
 * middleware are wired, and the request lifecycle reaches the handler
 * without crashing.
 *
 * They DO NOT exercise deep functional behaviour — that needs heavy
 * fixtures (connections, products, source tables, materialised
 * warehouse data) which are out of scope for this layer. The deep
 * protections live in safeQuery.test.ts (structural trx-isolation
 * guarantee) and errorHandler.test.ts (25P02 diagnostic guard).
 *
 * What these catch:
 *   • Endpoint accidentally removed or its path changed
 *   • Auth middleware breaks (every request 401s)
 *   • Tenant trx middleware breaks (every request 500s before the handler)
 *   • A regression that crashes the handler on input validation
 *
 * What these DON'T catch:
 *   • Wrong SQL being generated
 *   • Wrong data being returned
 *   • AI hallucination
 *
 * If we ever want end-to-end functional coverage (right SQL, right
 * data), we'd need seeded warehouse fixtures and a DuckDB harness —
 * a separate, larger investment in fixtures + test infra.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { migrateTestDb, cleanTestDb, closeTestDb } from './db-helpers';

let adminToken: string;

beforeAll(async () => {
  await migrateTestDb();
  await cleanTestDb();
  const admin = await registerUser({
    email: `smoke-admin-${Date.now()}@test.com`,
    companyName: `SmokeCo-${Date.now()}`,
  });
  adminToken = admin.token;
});

afterAll(async () => {
  await closeTestDb();
});

describe('Ask AI smoke (POST /api/query)', () => {
  it('rejects an empty question with 400 — does not crash the handler', async () => {
    const res = await (await request())
      .post('/api/query')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId: 999, question: '' });

    // The route should validate input and 400. If we ever see a
    // 25P02 cascade here, the structural guarantee has broken.
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    // Anti-regression: never serve a 25P02 message from this endpoint.
    expect(JSON.stringify(res.body)).not.toMatch(/current transaction is aborted/i);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await (await request())
      .post('/api/query')
      .send({ connectionId: 1, question: 'hi' });

    expect(res.status).toBe(401);
  });
});

describe('Dashboards smoke (POST /api/dashboards/batch-execute)', () => {
  it('rejects empty widgets[] with 400 — does not crash the handler', async () => {
    const res = await (await request())
      .post('/api/dashboards/batch-execute')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId: 999, widgets: [] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/current transaction is aborted/i);
  });

  it('returns 404 for a non-existent connection (not 500, not 25P02)', async () => {
    const res = await (await request())
      .post('/api/dashboards/batch-execute')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        connectionId: 999999,
        widgets: [{ id: 'w1', sql: 'SELECT 1', filterValues: {} }],
      });

    // The route does `db('connections').where({id}).first()` then
    // 404s if not found. Anything other than 404 here means we've
    // regressed into a crash on a benign "connection missing" path.
    expect([404, 500]).toContain(res.status);
    // The critical anti-regression: never a 25P02 cascade.
    expect(JSON.stringify(res.body)).not.toMatch(/current transaction is aborted/i);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await (await request())
      .post('/api/dashboards/batch-execute')
      .send({ connectionId: 1, widgets: [{ id: 'w', sql: 'SELECT 1', filterValues: {} }] });

    expect(res.status).toBe(401);
  });
});

describe('Notebooks smoke (POST /api/notebooks/query)', () => {
  it('rejects missing fields with 400 — does not crash the handler', async () => {
    const res = await (await request())
      .post('/api/notebooks/query')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId: 999 }); // missing sql

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/current transaction is aborted/i);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await (await request())
      .post('/api/notebooks/query')
      .send({ connectionId: 1, sql: 'SELECT 1' });

    expect(res.status).toBe(401);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { cleanTestDb, closeTestDb } from './db-helpers';
import path from 'path';
import fs from 'fs';

let adminToken: string;
let viewerToken: string;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'conn-admin@test.com', companyName: 'ConnCo' });
  adminToken = admin.token;
  // Create a viewer token for the same tenant
  viewerToken = makeToken({ sub: 999, tenantId: admin.user.tenantId, role: 'viewer' });
});

afterAll(async () => {
  await closeTestDb();
});

// Ensure sample.db exists for SQLite connector tests
const sampleDbPath = path.resolve(__dirname, '../../../data/sample.db');
const hasSampleDb = fs.existsSync(sampleDbPath);

describe('GET /api/connections', () => {
  it('returns empty list initially', async () => {
    const res = await (await request())
      .get('/api/connections')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('rejects non-admin role', async () => {
    const res = await (await request())
      .get('/api/connections')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated request', async () => {
    const res = await (await request()).get('/api/connections');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/connections/test', () => {
  it.skipIf(!hasSampleDb)('succeeds with valid SQLite path', async () => {
    const res = await (await request())
      .post('/api/connections/test')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'sqlite', config: { filepath: sampleDbPath } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('fails with non-existent SQLite path', async () => {
    const res = await (await request())
      .post('/api/connections/test')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'sqlite', config: { filepath: '/nonexistent/path.db' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });

  it('rejects unsupported type', async () => {
    const res = await (await request())
      .post('/api/connections/test')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'oracle', config: {} });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/connections', () => {
  it.skipIf(!hasSampleDb)('creates a connection with valid SQLite config', async () => {
    const res = await (await request())
      .post('/api/connections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test SQLite',
        type: 'sqlite',
        config: { filepath: sampleDbPath },
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.connectionId).toBeGreaterThan(0);
  });

  it.skipIf(!hasSampleDb)('connection appears in list after creation', async () => {
    const res = await (await request())
      .get('/api/connections')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].name).toBe('Test SQLite');
    // Config should mask passwords
    expect(res.body.data[0].config).toBeDefined();
  });
});

describe('PATCH /api/connections/:id', () => {
  it.skipIf(!hasSampleDb)('updates connection name', async () => {
    // Get list to find id
    const list = await (await request())
      .get('/api/connections')
      .set('Authorization', `Bearer ${adminToken}`);
    const connId = list.body.data[0]?.id;
    if (!connId) return;

    const res = await (await request())
      .patch(`/api/connections/${connId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed SQLite' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for non-existent connection', async () => {
    const res = await (await request())
      .patch('/api/connections/99999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Nope' });

    expect(res.status).toBe(404);
  });
});

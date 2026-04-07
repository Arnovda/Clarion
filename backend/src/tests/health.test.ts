import { describe, it, expect, afterAll } from 'vitest';
import { request } from './helpers';
import { closeTestDb } from './db-helpers';

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await (await request()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

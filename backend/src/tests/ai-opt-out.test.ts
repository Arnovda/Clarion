/**
 * 4-3 — a tenant can switch AI off, and then nothing leaves for a provider.
 *
 * The gate is enforceAiBudget in AIService, the one point every AI call
 * passes, so the test drives callClaude itself under the tenant's context:
 * with the mode 'off' it must throw AiDisabledError BEFORE any client is
 * built (no API key is configured here — a real attempt would fail
 * differently). Plus the routing route's contract and the error handler's
 * response shape.
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request_ from 'supertest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { withTenantAiContext, AiDisabledError } from '../services/aiBudget';
import { invalidateTenantAiMode, getTenantAiMode } from '../services/ai/tenantAiMode';
import { callClaude } from '../ai/AIService';
import { errorHandler } from '../middleware/errorHandler';

let tenantId: number;
let adminToken: string;

beforeAll(async () => {
  await cleanTestDb();
  const t = await registerUser({ companyName: 'OptOutCo' });
  tenantId = t.user.tenantId; adminToken = t.token;
});
afterAll(async () => { await closeTestDb(); });

describe('AI off (4-3)', () => {
  it('the routing route accepts off and refuses anything else', async () => {
    const agent = await request();
    const bad = await agent.put('/api/admin/ai-routing').set('Authorization', `Bearer ${adminToken}`).send({ mode: 'nope' });
    expect(bad.status).toBe(400);
    const ok = await agent.put('/api/admin/ai-routing').set('Authorization', `Bearer ${adminToken}`).send({ mode: 'off' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.mode).toBe('off');
    const row = await getTestDb()('tenants').where({ id: tenantId }).first();
    expect(row.ai_routing_mode).toBe('off');
    const get = await agent.get('/api/admin/ai-routing').set('Authorization', `Bearer ${adminToken}`);
    expect(get.body.data.mode).toBe('off');
    invalidateTenantAiMode(tenantId);
    expect(await getTenantAiMode(tenantId)).toBe('off');
  });

  it('every AI call for that tenant is refused at the gate, before any provider is contacted', async () => {
    invalidateTenantAiMode(tenantId);
    await withTenantAiContext(tenantId, async () => {
      await expect(callClaude('system', 'user', { callLabel: 'nl_to_sql' })).rejects.toBeInstanceOf(AiDisabledError);
    });
    // Switching back on lets the gate through (the call then fails on the
    // missing API key — a different error, which is the point).
    await getTestDb()('tenants').where({ id: tenantId }).update({ ai_routing_mode: 'claude' });
    invalidateTenantAiMode(tenantId);
    await withTenantAiContext(tenantId, async () => {
      await expect(callClaude('system', 'user', { callLabel: 'nl_to_sql', maxTokens: 5 })).rejects.not.toBeInstanceOf(AiDisabledError);
    });
  });

  it('the error handler answers 403 ai_disabled with a sentence naming the setting', async () => {
    const app = express();
    app.get('/boom', (_req, _res, next) => next(new AiDisabledError(tenantId)));
    app.use(errorHandler);
    const res = await request_(app).get('/boom');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ai_disabled');
    expect(res.body.error).toMatch(/switched off/);
  });
});

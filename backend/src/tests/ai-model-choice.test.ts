/**
 * Per-category model choice: the tenant admin chooses, the platform decides
 * what can be chosen.
 *
 *   - PUT refuses a model that is not on the approved list, and stores nothing.
 *   - A stored choice that falls off the list is IGNORED at call time (the
 *     category uses its default) and the screen is told so.
 *   - An approved Anthropic choice reaches the Claude-only paths too
 *     (streaming / multi-turn), which read no override before; an Azure
 *     choice cannot reach them and they stay on Claude.
 *   - The override read works without an ambient tenant variable — it used
 *     to go to the bare pool, where the policy had nothing to compare with.
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { resolveModel } from '../services/ai/router';
import { invalidateCallCategoryCache, getCallCategoryConfig } from '../services/ai/callCategoryConfig';
import { claudeModelFor } from '../ai/AIService';

let tenantId: number;
let adminToken: string;
let otherTenantId: number;

beforeAll(async () => {
  await cleanTestDb();
  const t = await registerUser({ companyName: 'ModelChoiceCo' });
  tenantId = t.user.tenantId; adminToken = t.token;
  const o = await registerUser({ companyName: 'OtherModelCo' });
  otherTenantId = o.user.tenantId;
});
afterAll(async () => { await closeTestDb(); });

const put = async (category: string, body: unknown, token = adminToken) =>
  (await request()).put(`/api/admin/ai-routing/categories/${category}`).set('Authorization', `Bearer ${token}`).send(body as object);

describe('per-category model choice', () => {
  it('offers the approved list and refuses anything else, storing nothing', async () => {
    const agent = await request();
    const get = await agent.get('/api/admin/ai-routing').set('Authorization', `Bearer ${adminToken}`);
    const ids = get.body.data.availableModels.map((m: { model_id: string }) => m.model_id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-5');
    // No Azure env in tests: no guessed Azure names either.
    expect(get.body.data.availableModels.every((m: { provider: string }) => m.provider === 'anthropic')).toBe(true);

    const bad = await put('nl_to_sql', { provider: 'anthropic', model_id: 'claude-3-opus-20240229' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not one of the models/);
    const azureGuess = await put('nl_to_sql', { provider: 'azure-openai', model_id: 'gpt-4o' });
    expect(azureGuess.status).toBe(400);
    expect(await getTestDb()('ai_model_config').where({ tenant_id: tenantId })).toHaveLength(0);

    expect((await put('nl_to_sql', { provider: 'anthropic' })).status).toBe(400);
    expect((await put('nope_category', { provider: 'anthropic', model_id: 'claude-sonnet-5' })).status).toBe(400);
  });

  it('stores an approved choice, and the Claude-only paths use it', async () => {
    const ok = await put('nl_to_sql', { provider: 'anthropic', model_id: 'claude-opus-5' });
    expect(ok.status).toBe(200);
    invalidateCallCategoryCache(tenantId);

    // Read with NO ambient tenant variable — a worker's situation.
    expect(await getCallCategoryConfig(tenantId, 'nl_to_sql')).toEqual({ provider: 'anthropic', model_id: 'claude-opus-5' });
    expect(await resolveModel({ callLabel: 'generate_sql_streaming', kind: 'schema', tenantId }))
      .toEqual({ provider: 'anthropic', modelId: 'claude-opus-5' });
    // Ask AI's SQL stream and its repair loop both read it now.
    expect(await claudeModelFor('generate_sql_streaming', tenantId, 'claude-sonnet-5')).toBe('claude-opus-5');
    expect(await claudeModelFor('multi_turn', tenantId, 'claude-sonnet-5')).toBe('claude-opus-5');
    // Another category, and another tenant, keep the default.
    expect(await claudeModelFor('bus_matrix_streaming', tenantId, 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(await claudeModelFor('generate_sql_streaming', otherTenantId, 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(await claudeModelFor('generate_sql_streaming', null, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('ignores a stored choice that is no longer approved, and says so on the screen', async () => {
    await getTestDb()('ai_model_config')
      .insert({ tenant_id: tenantId, call_category: 'products', provider: 'anthropic', model_id: 'claude-retired-1' });
    invalidateCallCategoryCache(tenantId);

    expect(await resolveModel({ callLabel: 'bus_matrix_streaming', kind: 'schema', tenantId })).toBeNull();
    expect(await claudeModelFor('bus_matrix_streaming', tenantId, 'claude-sonnet-5')).toBe('claude-sonnet-5');

    const cats = await (await request()).get('/api/admin/ai-routing/categories').set('Authorization', `Bearer ${adminToken}`);
    expect(cats.status).toBe(200);
    const byCat = Object.fromEntries(cats.body.data.categories.map((c: { category: string }) => [c.category, c]));
    expect(byCat.products.overrideApproved).toBe(false);
    expect(byCat.nl_to_sql.overrideApproved).toBe(true);
    expect(byCat.dashboards.overrideApproved).toBeNull();
  });

  it('an Azure override cannot reach a streaming call — it stays on Claude', async () => {
    await getTestDb()('ai_model_config')
      .insert({ tenant_id: tenantId, call_category: 'dashboards', provider: 'azure-openai', model_id: 'gpt-4o' });
    invalidateCallCategoryCache(tenantId);
    expect(await claudeModelFor('dashboard_spec', tenantId, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('clearing returns the category to its default; a non-admin cannot change it', async () => {
    const del = await (await request()).delete('/api/admin/ai-routing/categories/nl_to_sql').set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    invalidateCallCategoryCache(tenantId);
    expect(await claudeModelFor('generate_sql_streaming', tenantId, 'claude-sonnet-5')).toBe('claude-sonnet-5');

    const analyst = await createUserWithToken({ tenantId, role: 'analyst' });
    expect((await put('nl_to_sql', { provider: 'anthropic', model_id: 'claude-opus-5' }, analyst.token)).status).toBe(403);
  });
});

/**
 * The Studio coworker.
 *
 * What this pins, in order of how much it would hurt to lose:
 *
 *  1. A PROPOSAL WRITES NOTHING. The turn streams a proposal and the database
 *     is untouched — the person's Keep is the only write, and it goes through
 *     the ordinary route. This is the property the whole design rests on.
 *  2. The flag is the undo button: off → status says so and the turn route
 *     answers 404 like a route that does not exist.
 *  3. Roles: viewers get neither the panel nor the route.
 *  4. The tools reach the product through the SAME routes, with the person's
 *     own token (a loopback call a viewer could not make fails for them too).
 *  5. The cost rules: at most MAX_STEPS model steps, the last one forced to
 *     answer without tools; earlier turns go back as text only.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../ai/AIService', async (orig) => {
  const actual = await orig<typeof import('../ai/AIService')>();
  return { ...actual, callClaudeWithTools: vi.fn() };
});

import { callClaudeWithTools } from '../ai/AIService';
import { getApp, request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { setFlagRollout, invalidateFeatureFlagCache } from '../services/featureFlags';
import { setInternalApiBase } from '../services/coworker/internalApi';
import { compactHistory, clipResult, MAX_STEPS } from '../services/coworker/agent';
import { invalidateTenantAiMode } from '../services/ai/tenantAiMode';

const mockModel = vi.mocked(callClaudeWithTools);

let server: Server;
let base: string;
let adminToken: string;
let tenantId: number;
let viewerToken: string;

function modelStep(content: unknown[]) {
  return { content, stopReason: 'end_turn', model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 };
}

async function turn(token: string, body: unknown): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const res = await fetch(`${base}/api/coworker/turn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text.split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)));
  return { status: res.status, events };
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'cw-admin@test.com', companyName: 'CoworkerCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  viewerToken = (await createUserWithToken({ tenantId, role: 'viewer' })).token;

  const app = await getApp();
  server = (app as unknown as { listen: (p: number) => Server }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setInternalApiBase(`${base}/api`);
});

afterAll(async () => {
  setInternalApiBase(null);
  await new Promise((r) => server.close(r));
  await getTestDb()('feature_flags').where({ key: 'ai_coworker' }).del();
  invalidateFeatureFlagCache();
  await closeTestDb();
});

beforeEach(() => { mockModel.mockReset(); });

describe('the flag is the undo button', () => {
  it('off: status says so, and the turn route does not exist', async () => {
    await setFlagRollout(getTestDb(), 'ai_coworker', 'off', [], 'test');
    const s = await (await request()).get('/api/coworker/status').set('Authorization', `Bearer ${adminToken}`);
    expect(s.status).toBe(200);
    expect(s.body.data.enabled).toBe(false);
    const t = await turn(adminToken, { message: 'hello' });
    expect(t.status).toBe(404);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('on for this tenant: curators get it, viewers never do', async () => {
    await setFlagRollout(getTestDb(), 'ai_coworker', 'tenants', [tenantId], 'test');
    const a = await (await request()).get('/api/coworker/status').set('Authorization', `Bearer ${adminToken}`);
    expect(a.body.data.enabled).toBe(true);
    const v = await (await request()).get('/api/coworker/status').set('Authorization', `Bearer ${viewerToken}`);
    expect(v.body.data.enabled).toBe(false);
    const t = await turn(viewerToken, { message: 'hello' });
    expect(t.status).toBe(403);
  });

  it('refuses an empty message before any model call', async () => {
    const t = await turn(adminToken, { message: '   ' });
    expect(t.status).toBe(400);
    expect(mockModel).not.toHaveBeenCalled();
  });
});

describe('a proposal writes nothing', () => {
  it('streams narration, a checked proposal and the answer — and the glossary is untouched', async () => {
    await setFlagRollout(getTestDb(), 'ai_coworker', 'tenants', [tenantId], 'test');
    mockModel
      .mockImplementationOnce(async (opts) => {
        opts.onText?.('I will prepare the term.');
        return modelStep([
          { type: 'text', text: 'I will prepare the term.' },
          { type: 'tool_use', id: 'tu_1', name: 'propose_glossary_term', input: { term: 'Active customer', meaning: 'A customer with an invoice in the last 12 months.' } },
        ]);
      })
      .mockImplementationOnce(async () => modelStep([{ type: 'text', text: "I've proposed the term — keep it to save it." }]));

    const before = await getTestDb()('business_glossary').where({ tenant_id: tenantId }).count<{ count: string }[]>('* as count');
    const t = await turn(adminToken, { message: 'Define active customer', context: { path: '/catalog' } });
    expect(t.status).toBe(200);

    const types = t.events.map((e) => e.type);
    expect(types).toContain('text');
    expect(t.events.find((e) => e.type === 'segment' && e.kind === 'thought')?.text).toBe('I will prepare the term.');
    const steps = t.events.filter((e) => e.type === 'step');
    expect(steps.map((s) => s.status)).toEqual(['running', 'done']);
    expect(steps[0].tool).toBe('propose');
    const proposal = t.events.find((e) => e.type === 'proposal')?.proposal as Record<string, unknown>;
    expect(proposal).toMatchObject({ kind: 'glossary', term: 'Active customer' });
    expect(t.events.find((e) => e.type === 'segment' && e.kind === 'answer')?.text).toMatch(/proposed/);
    expect(t.events[t.events.length - 1]).toMatchObject({ type: 'done', steps: 2 });

    const after = await getTestDb()('business_glossary').where({ tenant_id: tenantId }).count<{ count: string }[]>('* as count');
    expect(Number(after[0].count)).toBe(Number(before[0].count));

    // The tool's result went back to the model as a tool_result for tu_1.
    const second = mockModel.mock.calls[1][0];
    const last = second.messages[second.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
  });

  it('a refused proposal becomes a failed step the model reads — not a crash', async () => {
    await getTestDb()('business_glossary').insert({ tenant_id: tenantId, term: 'Churn', meaning: 'Lost customers.', examples: '[]', tags: '[]', links: '[]' });
    mockModel
      .mockImplementationOnce(async () => modelStep([
        { type: 'tool_use', id: 'tu_dup', name: 'propose_glossary_term', input: { term: 'churn', meaning: 'x' } },
      ]))
      .mockImplementationOnce(async () => modelStep([{ type: 'text', text: 'That term already exists.' }]));
    const t = await turn(adminToken, { message: 'Define churn' });
    const failed = t.events.find((e) => e.type === 'step' && e.status === 'failed');
    expect(String(failed?.detail)).toMatch(/already has "churn"/);
    const toolResult = (mockModel.mock.calls[1][0].messages.at(-1)!.content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', is_error: true });
    expect(t.events.some((e) => e.type === 'proposal')).toBe(false);
  });

  it('a read tool reaches the product through the routes, as the person', async () => {
    mockModel
      .mockImplementationOnce(async () => modelStep([
        { type: 'tool_use', id: 'tu_def', name: 'list_definitions', input: {} },
      ]))
      .mockImplementationOnce(async () => modelStep([{ type: 'text', text: 'You have one term.' }]));
    const t = await turn(adminToken, { message: 'What terms do we have?' });
    const done = t.events.find((e) => e.type === 'step' && e.status === 'done');
    expect(done?.label).toBe('Reading the definitions');
    const toolResult = (mockModel.mock.calls[1][0].messages.at(-1)!.content as Array<Record<string, unknown>>)[0];
    expect(String(toolResult.content)).toContain('Churn');
  });
});

describe('the Studio pages\' questions', () => {
  it('source_status: the last syncs and what failed — never the source\'s configuration', async () => {
    const db = getTestDb();
    const [c] = await db('connections').insert({
      tenant_id: tenantId, name: 'Odoo', type: 'duckdb', connector_type: 'odoo',
      selected_entities: ['res_partner', 'sale_order'], config: JSON.stringify({ password: 'hunter2' }),
      connector_config_encrypted: 'CIPHERTEXT',
    }).returning('id');
    const connectionId = Number((c as { id?: number }).id ?? c);
    await db('source_sync_runs').insert({
      tenant_id: tenantId, connection_id: connectionId, status: 'partial',
      error_message: '1 of 2 entities failed: res_partner (HTTP 500)',
      failed_entities: JSON.stringify({ res_partner: 'HTTP 500' }), row_counts: JSON.stringify({ sale_order: 40 }),
      queued_at: new Date(), completed_at: new Date(),
    });
    mockModel
      .mockImplementationOnce(async () => modelStep([{ type: 'tool_use', id: 'tu_src', name: 'source_status', input: { connection_id: connectionId } }]))
      .mockImplementationOnce(async () => modelStep([{ type: 'text', text: 'res_partner failed.' }]));
    const t = await turn(adminToken, { message: 'Why did the sync fail?', context: { path: '/sources', connectionId, label: 'Odoo' } });
    expect(t.events.find((e) => e.type === 'focus')?.target).toEqual({ kind: 'source', connectionId });
    const sent = String((mockModel.mock.calls[1][0].messages.at(-1)!.content as Array<Record<string, unknown>>)[0].content);
    expect(sent).toContain('res_partner (HTTP 500)');
    expect(sent).toContain('"rows":40');
    expect(sent).not.toMatch(/hunter2|CIPHERTEXT/);
    // The page's context reached the model as the "where" line.
    expect(String(mockModel.mock.calls[0][0].messages[0].content)).toContain(`source id ${connectionId}`);
  });

  it('check_relationship: follows onto the canvas, and another tenant\'s relationship is not found', async () => {
    const db = getTestDb();
    const [c] = await db('connections').insert({ tenant_id: tenantId, name: 'EO', type: 'duckdb', connector_type: 'exactonline', selected_entities: ['A'], config: '{}' }).returning('id');
    const connectionId = Number((c as { id?: number }).id ?? c);
    const [ft] = await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'Invoices' }).returning('id');
    const [tt] = await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'Accounts' }).returning('id');
    const fromTableId = Number((ft as { id?: number }).id ?? ft);
    const toTableId = Number((tt as { id?: number }).id ?? tt);
    const [r] = await db('table_relationships').insert({ tenant_id: tenantId, from_table_id: fromTableId, to_table_id: toTableId, relationship_type: 'many_to_one', ai_draft: true }).returning('id');
    const relId = Number((r as { id?: number }).id ?? r);
    mockModel
      .mockImplementationOnce(async () => modelStep([{ type: 'tool_use', id: 'tu_rel', name: 'check_relationship', input: { relationship_id: relId } }]))
      .mockImplementationOnce(async () => modelStep([{ type: 'text', text: 'It names no columns.' }]));
    const t = await turn(adminToken, { message: 'Does this hold?', context: { path: '/relationships', relationshipId: relId } });
    expect(t.events.find((e) => e.type === 'focus')?.target).toEqual({ kind: 'relations', tableId: fromTableId, relationshipId: relId });
    const sent = String((mockModel.mock.calls[1][0].messages.at(-1)!.content as Array<Record<string, unknown>>)[0].content);
    expect(sent).toContain('Invoices.? → Accounts.?');
    expect(sent).toContain('cannot be measured');
    expect(String(mockModel.mock.calls[0][0].messages[0].content)).toContain(`relationship id ${relId}`);

    // A relationship of another tenant: a failed step, never its content.
    const other = await registerUser({ email: 'cw-other@test.com', companyName: 'OtherCo' });
    const [oc] = await db('connections').insert({ tenant_id: other.user.tenantId, name: 'X', type: 'duckdb', connector_type: 'odoo', selected_entities: ['a'], config: '{}' }).returning('id');
    const [ot] = await db('source_tables').insert({ tenant_id: other.user.tenantId, connection_id: Number((oc as { id?: number }).id ?? oc), table_name: 'SecretTable' }).returning('id');
    const otId = Number((ot as { id?: number }).id ?? ot);
    const [orl] = await db('table_relationships').insert({ tenant_id: other.user.tenantId, from_table_id: otId, to_table_id: otId, relationship_type: 'many_to_one' }).returning('id');
    mockModel.mockReset();
    mockModel
      .mockImplementationOnce(async () => modelStep([{ type: 'tool_use', id: 'tu_x', name: 'check_relationship', input: { relationship_id: Number((orl as { id?: number }).id ?? orl) } }]))
      .mockImplementationOnce(async () => modelStep([{ type: 'text', text: 'Not found.' }]));
    const x = await turn(adminToken, { message: 'Check it' });
    expect(x.events.find((e) => e.type === 'step' && e.status === 'failed')?.detail).toBe('Not found in this workspace.');
    expect(JSON.stringify(mockModel.mock.calls[1][0].messages)).not.toContain('SecretTable');
  });
});

describe('the tenant\'s privacy choice', () => {
  it('a tenant that keeps row data off Claude never gets the tool that reads rows', async () => {
    const tools = async () => {
      mockModel.mockReset();
      mockModel.mockImplementationOnce(async () => modelStep([{ type: 'text', text: 'ok' }]));
      await turn(adminToken, { message: 'hi' });
      return (mockModel.mock.calls[0][0].tools as Array<{ name: string }>).map((t) => t.name);
    };
    await getTestDb()('tenants').where({ id: tenantId }).update({ ai_routing_mode: 'hybrid' });
    invalidateTenantAiMode(tenantId);
    const hybrid = await tools();
    expect(hybrid).not.toContain('preview_rows');
    expect(hybrid).toContain('open_table');
    await getTestDb()('tenants').where({ id: tenantId }).update({ ai_routing_mode: 'claude' });
    invalidateTenantAiMode(tenantId);
    expect(await tools()).toContain('preview_rows');
  });
});

describe('the cost rules', () => {
  it('stops at MAX_STEPS, forcing the last step to answer without tools', async () => {
    mockModel.mockImplementation(async (opts) => (opts.forceAnswer
      ? modelStep([{ type: 'text', text: 'Here is where I got.' }])
      : modelStep([{ type: 'tool_use', id: `tu_${Math.random()}`, name: 'list_definitions', input: {} }])));
    const t = await turn(adminToken, { message: 'Keep looking forever' });
    expect(mockModel).toHaveBeenCalledTimes(MAX_STEPS);
    expect(mockModel.mock.calls[MAX_STEPS - 1][0].forceAnswer).toBe(true);
    expect(mockModel.mock.calls.slice(0, -1).every((c) => !c[0].forceAnswer)).toBe(true);
    expect(t.events.find((e) => e.type === 'segment' && e.kind === 'answer')?.text).toBe('Here is where I got.');
  });

  it('earlier turns go back as text only, capped, opening with the user and never ending on one', () => {
    const long = 'x'.repeat(5000);
    const out = compactHistory([
      { role: 'assistant', content: 'stray opener' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: long },
      { role: 'user', content: 'dangling' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[0].content).toBe('a\n\nb');
    expect((out[1].content as string).length).toBeLessThanOrEqual(1500);
  });

  it('clips what a tool hands back to the model', () => {
    expect(clipResult({ big: 'y'.repeat(20000) }).length).toBeLessThanOrEqual(6000);
  });
});

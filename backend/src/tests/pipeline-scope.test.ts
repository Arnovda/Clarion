/**
 * A custom refresh pipeline runs what its canvas shows (2026-09-24).
 *
 * The defect, from production: a pipeline drawn as "0 sources, 5 products"
 * — the source deliberately clicked off, greyed out on its own canvas —
 * still started a source sync, because resolveScope added every source
 * feeding an in-scope product and forced `shouldSyncSources: true`. The
 * sync failed, the gate skipped all five products, and the run did the one
 * thing the pipeline said it would not and none of what it said it would.
 *
 * Also pinned: `pipelines.last_status` follows the run. It was written
 * once, 'queued', at enqueue, so the pipeline list read "queued" forever.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { resolveScope } from '../services/pipelineService';
import { runPipelineWorkflow } from '../services/busMatrixOrchestrator';

const db = getTestDb();

let tenantId: number;
let conn: number;
let dim: number;
let fact: number;

const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'pipeline-scope@test.com', companyName: 'ScopeCo' });
  tenantId = admin.user.tenantId;

  conn = idOf((await db('connections').insert({
    tenant_id: tenantId, name: 'Exact Online', type: 'duckdb', connector_type: 'exactonline', config: '{}',
  }).returning('id'))[0]);
  const st = idOf((await db('source_tables').insert({
    tenant_id: tenantId, connection_id: conn, table_name: 'Accounts',
  }).returning('id'))[0]);
  dim = idOf((await db('data_products').insert({
    tenant_id: tenantId, connection_id: conn, name: 'Reference', status: 'approved', kind: 'reference',
  }).returning('id'))[0]);
  fact = idOf((await db('data_products').insert({
    tenant_id: tenantId, connection_id: conn, name: 'Sales', status: 'approved', kind: 'analytics',
  }).returning('id'))[0]);
  await db('data_product_sources').insert([
    { tenant_id: tenantId, data_product_id: dim, source_table_id: st, table_name: 'Accounts' },
    { tenant_id: tenantId, data_product_id: fact, source_table_id: st, table_name: 'Accounts' },
  ]);
  await db('data_product_dependencies').insert({
    tenant_id: tenantId, dependent_product_id: fact, source_product_id: dim,
  });
});

afterAll(async () => { await closeTestDb(); });

describe('a custom pipeline syncs only the sources on its canvas', () => {
  it('products only → no source sync, upstream products still pulled in', async () => {
    const r = await resolveScope({ type: 'custom', sourceIds: [], productIds: [fact] }, tenantId);
    expect(r.sourceIds).toEqual([]);
    expect(r.shouldSyncSources).toBe(false);
    // The fact's dimension comes along: a fact rebuilt without it is wrong.
    expect(r.productIds.sort()).toEqual([dim, fact].sort());
  });

  it('a source picked on the canvas is synced', async () => {
    const r = await resolveScope({ type: 'custom', sourceIds: [conn], productIds: [fact] }, tenantId);
    expect(r.sourceIds).toEqual([conn]);
    expect(r.shouldSyncSources).toBe(true);
  });

  it('skipSourceSync wins over a picked source', async () => {
    const r = await resolveScope({ type: 'custom', sourceIds: [conn], productIds: [fact], skipSourceSync: true }, tenantId);
    expect(r.sourceIds).toEqual([]);
    expect(r.shouldSyncSources).toBe(false);
  });

  it('a source id from another tenant is dropped', async () => {
    const r = await resolveScope({ type: 'custom', sourceIds: [conn + 100_000], productIds: [] }, tenantId);
    expect(r.sourceIds).toEqual([]);
  });

  it('the built-in "from source" scope still syncs, unchanged', async () => {
    const r = await resolveScope({ type: 'from-source', sourceId: conn }, tenantId);
    expect(r.sourceIds).toEqual([conn]);
    expect(r.shouldSyncSources).toBe(true);
  });
});

describe('the pipeline row follows its run', () => {
  async function newRun(): Promise<{ pipelineId: number; runId: number }> {
    const pipelineId = idOf((await db('pipelines').insert({
      tenant_id: tenantId, name: `P${Date.now()}${Math.random()}`, kind: 'custom',
      scope: JSON.stringify({ type: 'custom', sourceIds: [], productIds: [] }),
      last_status: 'queued',
    }).returning('id'))[0]);
    const runId = idOf((await db('pipeline_runs').insert({
      tenant_id: tenantId, pipeline_id: pipelineId, status: 'queued', triggered_by: 'test',
    }).returning('id'))[0]);
    return { pipelineId, runId };
  }

  it('a finished run replaces "queued" on the pipeline', async () => {
    const { pipelineId, runId } = await newRun();
    await runPipelineWorkflow({
      scope: { sourceIds: [], productIds: [], shouldSyncSources: false },
      pipelineRunId: runId, tenantId, emit: () => undefined,
    });
    expect((await db('pipeline_runs').where({ id: runId }).first()).status).toBe('succeeded');
    expect((await db('pipelines').where({ id: pipelineId }).first()).last_status).toBe('succeeded');
  });

  it('a run that throws is settled on both rows, never left running', async () => {
    const { pipelineId, runId } = await newRun();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runPipelineWorkflow({
      scope: { sourceIds: [], productIds: [], shouldSyncSources: false },
      pipelineRunId: runId, tenantId, emit: () => undefined, abortSignal: ctrl.signal,
    })).rejects.toBeTruthy();
    expect((await db('pipeline_runs').where({ id: runId }).first()).status).toBe('cancelled');
    expect((await db('pipelines').where({ id: pipelineId }).first()).last_status).toBe('cancelled');
  });
});

/**
 * P1-1 — liveness-based reapers + per-tenant fairness.
 *
 * The defect was reproduced at SQL level before the change: a RUNNING
 * sync started 31 minutes ago — with activity seconds old — was failed
 * by the verbatim old rule (`COALESCE(started_at, queued_at) < NOW() -
 * 30 minutes`). Age cannot separate "orphaned" from "big"; the tests
 * below pin that the new rules can.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanTestDb, closeTestDb } from './db-helpers';
import { semanticDb } from '../db/knex';
import { reapStaleWork } from '../services/reapers';
import { deferWhenTenantBusy, FAIRNESS_RETRY_MS } from '../jobs/tenantFairness';
import { DelayedError } from 'bullmq';

let tenantId: number;
let connectionId: number;

beforeAll(async () => {
  await cleanTestDb();
  const [t] = await semanticDb('tenants')
    .insert({ name: 'ReaperCo', slug: `reaperco-${Date.now()}`, status: 'active' })
    .returning('id');
  tenantId = typeof t === 'object' ? (t as { id: number }).id : (t as number);
  const [c] = await semanticDb('connections')
    .insert({ tenant_id: tenantId, name: 'reap-conn', type: 'sqlite', config: JSON.stringify({}) })
    .returning('id');
  connectionId = typeof c === 'object' ? (c as { id: number }).id : (c as number);
});

afterAll(async () => {
  await closeTestDb();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/**
 * One connection per running row — uq_source_sync_runs_inflight allows a
 * single in-flight run per connection (the P0-era TOCTOU fix), which is
 * exactly right and means each synthetic run needs its own connection.
 */
async function insertRun(row: Record<string, unknown>): Promise<number> {
  const [c] = await semanticDb('connections')
    .insert({ tenant_id: tenantId, name: `reap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: 'sqlite', config: JSON.stringify({}) })
    .returning('id');
  const connId = typeof c === 'object' ? (c as { id: number }).id : (c as number);
  const [r] = await semanticDb('source_sync_runs')
    .insert({ tenant_id: tenantId, connection_id: connId, status: 'running', ...row })
    .returning('id');
  return typeof r === 'object' ? (r as { id: number }).id : (r as number);
}

describe('reapStaleWork — sync runs', () => {
  it('a long run with a FRESH heartbeat survives; a quiet one is reaped; pre-migration rows fall back to age', async () => {
    // The exact production shape the old rule killed: old start, alive now.
    const healthy = await insertRun({
      queued_at: minutesAgo(46), started_at: minutesAgo(45), heartbeat_at: minutesAgo(1),
    });
    // Orphaned: started long ago, heartbeat stopped 20 minutes ago.
    const orphaned = await insertRun({
      queued_at: minutesAgo(40), started_at: minutesAgo(39), heartbeat_at: minutesAgo(20),
    });
    // Written before the heartbeat column existed: NULL heartbeat, old start.
    const preMigration = await insertRun({
      queued_at: minutesAgo(35), started_at: minutesAgo(34), heartbeat_at: null,
    });
    // Young and beating: untouched.
    const young = await insertRun({
      queued_at: minutesAgo(2), started_at: minutesAgo(1), heartbeat_at: minutesAgo(1),
    });

    await reapStaleWork(semanticDb);

    const status = async (id: number) =>
      (await semanticDb('source_sync_runs').where({ id }).first()).status;
    expect(await status(healthy)).toBe('running');
    expect(await status(orphaned)).toBe('failed');
    expect(await status(preMigration)).toBe('failed');
    expect(await status(young)).toBe('running');

    await semanticDb('source_sync_runs').whereIn('id', [healthy, orphaned, preMigration, young]).del();
  });

  it('the absolute ceiling reaps even a run that never stops beating', async () => {
    const wedged = await insertRun({
      queued_at: hoursAgo(5), started_at: hoursAgo(5), heartbeat_at: minutesAgo(1),
    });
    await reapStaleWork(semanticDb);
    const row = await semanticDb('source_sync_runs').where({ id: wedged }).first();
    expect(row.status).toBe('failed');
    await semanticDb('source_sync_runs').where({ id: wedged }).del();
  });
});

describe('reapStaleWork — profiling', () => {
  it('a profiling with a fresh heartbeat survives an old start; a quiet one dies', async () => {
    await semanticDb('connections').where({ id: connectionId }).update({
      profiling_status: 'running',
      profiling_started_at: minutesAgo(45),
      profiling_heartbeat_at: minutesAgo(1),
    });
    await reapStaleWork(semanticDb);
    let row = await semanticDb('connections').where({ id: connectionId }).first();
    expect(row.profiling_status).toBe('running');

    await semanticDb('connections').where({ id: connectionId }).update({
      profiling_heartbeat_at: minutesAgo(15),
    });
    await reapStaleWork(semanticDb);
    row = await semanticDb('connections').where({ id: connectionId }).first();
    expect(row.profiling_status).toBe('error');

    await semanticDb('connections').where({ id: connectionId }).update({
      profiling_status: null, profiling_started_at: null, profiling_heartbeat_at: null,
      profiling_phase: null, profiling_message: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Fairness guard — fakes, no Redis
// ---------------------------------------------------------------------------

type FakeJob = { id: string; data: { tenantId?: number }; moveToDelayed: (ts: number, token?: string) => Promise<void> };

function fakeQueue(active: Array<{ id: string; data: { tenantId?: number } }>) {
  return { name: 'fake', getActive: async () => active } as never;
}

describe('deferWhenTenantBusy', () => {
  const mkJob = (id: string, tenantId: number): { job: FakeJob; delayedTo: number[] } => {
    const delayedTo: number[] = [];
    return {
      job: { id, data: { tenantId }, moveToDelayed: async (ts) => { delayedTo.push(ts); } },
      delayedTo,
    };
  };

  it('runs when no other job of the same tenant is active (other tenants do not count)', async () => {
    const { job, delayedTo } = mkJob('j2', 7);
    await deferWhenTenantBusy(job as never, fakeQueue([{ id: 'j1', data: { tenantId: 8 } }]), 'tok');
    expect(delayedTo).toHaveLength(0);
  });

  it('defers with DelayedError when the tenant already holds a slot', async () => {
    const { job, delayedTo } = mkJob('j2', 7);
    await expect(
      deferWhenTenantBusy(job as never, fakeQueue([{ id: 'j1', data: { tenantId: 7 } }]), 'tok'),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(delayedTo).toHaveLength(1);
    expect(delayedTo[0]).toBeGreaterThan(Date.now() + FAIRNESS_RETRY_MS - 5_000);
  });

  it('does not count the job itself, and fails OPEN when the check errors', async () => {
    const { job: self, delayedTo } = mkJob('j1', 7);
    await deferWhenTenantBusy(self as never, fakeQueue([{ id: 'j1', data: { tenantId: 7 } }]), 'tok');
    expect(delayedTo).toHaveLength(0);

    const broken = { name: 'fake', getActive: async () => { throw new Error('redis gone'); } } as never;
    const { job, delayedTo: d2 } = mkJob('j2', 7);
    // Fairness must never break the work itself.
    await deferWhenTenantBusy(job as never, broken, 'tok');
    expect(d2).toHaveLength(0);
  });
});

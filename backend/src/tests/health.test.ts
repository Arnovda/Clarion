import { describe, it, expect, afterAll } from 'vitest';
import { request } from './helpers';
import { closeTestDb } from './db-helpers';
import { runHealthChecks, summarizeHealth, type CheckStatus } from '../services/healthCheck';

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/health', () => {
  it('returns ok, with every component reported', async () => {
    const res = await (await request()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The deep check must always REPORT each component, even the ones that
    // are 'skipped' here (no Redis/Neo4j/blob in the test environment) —
    // an absent key would mean the component silently left the check.
    for (const key of ['postgres', 'redis', 'neo4j', 'blob', 'worker_transformation', 'worker_bus_matrix']) {
      expect(res.body.checks).toHaveProperty(key);
    }
  });
});

describe('runHealthChecks (deep health, P0-6)', () => {
  const ok = async (): Promise<CheckStatus> => 'ok';
  const err = async (): Promise<CheckStatus> => 'error';
  const skip = async (): Promise<CheckStatus> => 'skipped';
  const allOk = {
    postgres: ok, redis: ok, neo4j: ok, blob: ok,
    workerTransformation: ok, workerBusMatrix: ok,
  };

  it('is healthy when every component answers', async () => {
    const { ok: verdict, checks } = await runHealthChecks(allOk);
    expect(verdict).toBe(true);
    expect(checks.redis).toBe('ok');
  });

  it('a dead Redis fails the check — the original P0-6 defect direction', async () => {
    // Before this check existed, /api/health answered 200 with Redis dead and
    // deploy.yml promoted the revision to 100% traffic on that answer.
    const { ok: verdict, checks } = await runHealthChecks({ ...allOk, redis: err });
    expect(verdict).toBe(false);
    expect(checks.redis).toBe('error');
  });

  it('a dead Neo4j fails the check', async () => {
    const { ok: verdict } = await runHealthChecks({ ...allOk, neo4j: err });
    expect(verdict).toBe(false);
  });

  it('nobody listening on the transformation queue fails the check — the dead jobs-worker signal', async () => {
    const { ok: verdict, checks } = await runHealthChecks({ ...allOk, workerTransformation: err });
    expect(verdict).toBe(false);
    expect(checks.worker_transformation).toBe('error');
  });

  it('a component that is not configured is skipped, and skipped is NOT broken', async () => {
    // Local dev and CI run without Redis/Neo4j/blob on purpose; "absent by
    // configuration" failing the check would block nothing real and break
    // every environment that is allowed to run without the dependency.
    const { ok: verdict, checks } = await runHealthChecks({
      ...allOk, redis: skip, neo4j: skip, blob: skip,
      workerTransformation: skip, workerBusMatrix: skip,
    });
    expect(verdict).toBe(true);
    expect(checks.blob).toBe('skipped');
  });

  it('summarizeHealth: any single error outweighs every ok', () => {
    expect(summarizeHealth({ a: 'ok', b: 'skipped', c: 'ok' })).toBe(true);
    expect(summarizeHealth({ a: 'ok', b: 'error', c: 'ok' })).toBe(false);
  });
});

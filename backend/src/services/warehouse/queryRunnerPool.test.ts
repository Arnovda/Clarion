/**
 * Guards the child-runner's safety valve: it must disable itself rather than
 * fail queries when it can't actually be used. The pool's spawn path needs a
 * compiled child script and real processes, so it is exercised in CI/e2e
 * rather than here; what is tested here is the decision to use it at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('runnerEnabled', () => {
  const saved = process.env.DUCKDB_RUNNER;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.DUCKDB_RUNNER;
    else process.env.DUCKDB_RUNNER = saved;
  });

  it('is off unless explicitly set to "child"', async () => {
    delete process.env.DUCKDB_RUNNER;
    const { runnerEnabled } = await import('./queryRunnerPool');
    expect(runnerEnabled()).toBe(false);
  });

  it('ignores any other value', async () => {
    process.env.DUCKDB_RUNNER = 'true';
    const { runnerEnabled } = await import('./queryRunnerPool');
    expect(runnerEnabled()).toBe(false);
  });

  it('falls back to in-process when the compiled child script is absent', async () => {
    // Under vitest we run from TypeScript sources, so queryRunnerChild.js does
    // not exist next to this module. Enabling the flag must NOT make queries
    // fail — it must quietly degrade.
    process.env.DUCKDB_RUNNER = 'child';
    const { runnerEnabled } = await import('./queryRunnerPool');
    expect(runnerEnabled()).toBe(false);
  });

  it('starts with an empty runner pool', async () => {
    const { _runnerCount } = await import('./queryRunnerPool');
    expect(_runnerCount()).toBe(0);
  });
});

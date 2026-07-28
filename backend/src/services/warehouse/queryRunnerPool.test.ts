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

/**
 * Per-runner resource budget. One invariant: the AGGREGATE budget of all runner
 * processes must not exceed what a single in-process DuckDB session was allowed.
 * Without it, enabling DUCKDB_RUNNER=child multiplies DUCKDB_MEMORY_LIMIT by
 * DUCKDB_RUNNER_MAX and the replica gets OOM-killed under concurrent load — the
 * opposite of what the runner exists to fix.
 */
describe('dividedMemoryLimit', () => {
  it('divides a percentage so all runners together stay within the original budget', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    expect(dividedMemoryLimit('70%', 4)).toBe('17%');
    expect(17 * 4).toBeLessThanOrEqual(70);
  });

  it('leaves the budget untouched for a single runner', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    expect(dividedMemoryLimit('70%', 1)).toBe('70%');
  });

  it('never yields 0% however many runners are configured', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    expect(dividedMemoryLimit('70%', 1000)).toBe('1%');
  });

  it('divides absolute sizes and normalises them to MB', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    expect(dividedMemoryLimit('2GB', 4)).toBe('512MB');
    expect(dividedMemoryLimit('1024MB', 2)).toBe('512MB');
  });

  it('floors an absolute share so a runner is not left spilling on every query', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    // 256MB / 8 = 32MB, below the floor.
    expect(dividedMemoryLimit('256MB', 8)).toBe('128MB');
  });

  it('tolerates whitespace and lowercase units', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    expect(dividedMemoryLimit(' 70 % ', 2)).toBe('35%');
    expect(dividedMemoryLimit('2gb', 2)).toBe('1024MB');
  });

  it('passes a malformed value through instead of inventing a number', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    // applyResourceGuardrails rejects these anyway; substituting a value here
    // would hide the typo rather than surface it.
    expect(dividedMemoryLimit('lots', 4)).toBe('lots');
    expect(dividedMemoryLimit('', 4)).toBe('');
  });

  it('treats a nonsensical divisor as one runner', async () => {
    const { dividedMemoryLimit } = await import('./queryRunnerPool');
    expect(dividedMemoryLimit('70%', 0)).toBe('70%');
    expect(dividedMemoryLimit('70%', -3)).toBe('70%');
  });
});

describe('dividedThreads', () => {
  it('divides the thread budget', async () => {
    const { dividedThreads } = await import('./queryRunnerPool');
    expect(dividedThreads('8', 4)).toBe('2');
  });

  it('always leaves each runner at least one thread', async () => {
    const { dividedThreads } = await import('./queryRunnerPool');
    expect(dividedThreads('2', 4)).toBe('1');
    expect(dividedThreads('1', 16)).toBe('1');
  });

  it('passes a non-integer value through', async () => {
    const { dividedThreads } = await import('./queryRunnerPool');
    expect(dividedThreads('many', 2)).toBe('many');
  });
});

describe('budget divisor', () => {
  const savedMax = process.env.DUCKDB_RUNNER_MAX;
  const savedConc = process.env.DUCKDB_MAX_CONCURRENT_QUERIES;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (savedMax === undefined) delete process.env.DUCKDB_RUNNER_MAX;
    else process.env.DUCKDB_RUNNER_MAX = savedMax;
    if (savedConc === undefined) delete process.env.DUCKDB_MAX_CONCURRENT_QUERIES;
    else process.env.DUCKDB_MAX_CONCURRENT_QUERIES = savedConc;
  });

  it('accounts for the concurrency cap, which defaults ABOVE the runner cap', async () => {
    // A busy keyed runner makes runQuery spawn an extra process, and only IDLE
    // runners can be evicted — so the real ceiling on live processes is the
    // global query concurrency (default 6), not DUCKDB_RUNNER_MAX (default 4).
    delete process.env.DUCKDB_RUNNER_MAX;
    delete process.env.DUCKDB_MAX_CONCURRENT_QUERIES;
    const { _budgetDivisor } = await import('./queryRunnerPool');
    expect(_budgetDivisor()).toBe(6);
  });

  it('follows whichever cap is higher', async () => {
    process.env.DUCKDB_RUNNER_MAX = '10';
    process.env.DUCKDB_MAX_CONCURRENT_QUERIES = '6';
    const a = await import('./queryRunnerPool');
    expect(a._budgetDivisor()).toBe(10);

    vi.resetModules();
    process.env.DUCKDB_RUNNER_MAX = '4';
    process.env.DUCKDB_MAX_CONCURRENT_QUERIES = '12';
    const b = await import('./queryRunnerPool');
    expect(b._budgetDivisor()).toBe(12);
  });

  it('keeps the aggregate memory budget within one in-process session at the defaults', async () => {
    delete process.env.DUCKDB_RUNNER_MAX;
    delete process.env.DUCKDB_MAX_CONCURRENT_QUERIES;
    const { _budgetDivisor, dividedMemoryLimit } = await import('./queryRunnerPool');
    const d = _budgetDivisor();
    const share = Number(dividedMemoryLimit('70%', d).replace('%', ''));
    expect(share * d).toBeLessThanOrEqual(70);
  });
});

describe('runnerEnv', () => {
  it('divides the DuckDB budget and inherits everything else', async () => {
    const { runnerEnv } = await import('./queryRunnerPool');
    const env = runnerEnv(
      {
        DUCKDB_MEMORY_LIMIT: '2GB',
        DUCKDB_THREADS: '4',
        AZURE_STORAGE_CONNECTION_STRING: 'secret',
        DUCKDB_MAX_RESULT_ROWS: '100000',
      },
      4,
    );

    expect(env.DUCKDB_MEMORY_LIMIT).toBe('512MB');
    expect(env.DUCKDB_THREADS).toBe('1');
    // The child cannot read az:// without the secret, and must keep the same
    // result-row cap as the in-process path.
    expect(env.AZURE_STORAGE_CONNECTION_STRING).toBe('secret');
    expect(env.DUCKDB_MAX_RESULT_ROWS).toBe('100000');
  });

  it('applies the same defaults as applyResourceGuardrails when unset', async () => {
    const { runnerEnv } = await import('./queryRunnerPool');
    // Defaults in duckdb.ts are '70%' and 2 threads — divided, not inherited raw.
    const env = runnerEnv({}, 4);
    expect(env.DUCKDB_MEMORY_LIMIT).toBe('17%');
    expect(env.DUCKDB_THREADS).toBe('1');
  });

  it('does not mutate the parent environment', async () => {
    const { runnerEnv } = await import('./queryRunnerPool');
    const parent = { DUCKDB_MEMORY_LIMIT: '70%', DUCKDB_THREADS: '2' };
    runnerEnv(parent, 4);
    expect(parent.DUCKDB_MEMORY_LIMIT).toBe('70%');
    expect(parent.DUCKDB_THREADS).toBe('2');
  });
});

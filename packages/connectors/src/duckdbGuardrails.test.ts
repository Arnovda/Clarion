/**
 * The worker's DuckDB guardrails, pinned against the REAL binding.
 *
 * The finding this file exists for (2026-09-10, phase-2 PoC): DuckDB 1.4.2
 * rejects `SET memory_limit='60%'` with a parser error, and the guardrail's
 * try/catch — written for "a build without the setting" — swallowed it. So
 * the ceiling phase 0 said it added to every worker session was never set;
 * the session ran at DuckDB's default the whole time. A test that only
 * checks the SQL string would have passed then too, which is why the
 * assertion here reads the setting BACK from a live session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from 'duckdb-async';
import { applyWorkerGuardrails, createGuardedDuckDb, resolveMemoryLimit, visibleMemoryBytes } from './duckdbGuardrails';

const GiB = 1024 * 1024 * 1024;

describe('resolveMemoryLimit (pure)', () => {
  it('resolves a percentage against the memory this process is allowed, in MB', () => {
    expect(resolveMemoryLimit('60%', 2 * GiB)).toBe('1228MB');
    expect(resolveMemoryLimit('70%', 1 * GiB)).toBe('716MB');
    expect(resolveMemoryLimit(' 50 % ', 1 * GiB)).toBe('512MB');
  });

  it('passes absolute sizes through untouched', () => {
    expect(resolveMemoryLimit('512MB', 8 * GiB)).toBe('512MB');
    expect(resolveMemoryLimit('1GB', 8 * GiB)).toBe('1GB');
    expect(resolveMemoryLimit('1.5gb', 8 * GiB)).toBe('1.5gb');
  });

  it('refuses garbage and impossible inputs rather than inventing a number', () => {
    expect(resolveMemoryLimit('lots', 8 * GiB)).toBeNull();
    expect(resolveMemoryLimit("60%'; DROP TABLE x; --", 8 * GiB)).toBeNull();
    expect(resolveMemoryLimit('0%', 8 * GiB)).toBeNull();
    expect(resolveMemoryLimit('60%', 0)).toBeNull();
  });

  it('never resolves below a 64MB floor and never above 100%', () => {
    expect(resolveMemoryLimit('1%', 512 * 1024 * 1024)).toBe('64MB');
    expect(resolveMemoryLimit('250%', 1 * GiB)).toBe('1024MB');
  });
});

describe('applyWorkerGuardrails (real DuckDB)', () => {
  const saved = { limit: process.env.DUCKDB_MEMORY_LIMIT, threads: process.env.DUCKDB_THREADS };
  afterEach(() => {
    if (saved.limit === undefined) delete process.env.DUCKDB_MEMORY_LIMIT; else process.env.DUCKDB_MEMORY_LIMIT = saved.limit;
    if (saved.threads === undefined) delete process.env.DUCKDB_THREADS; else process.env.DUCKDB_THREADS = saved.threads;
  });

  async function setting(db: Database, name: string): Promise<string> {
    const rows = await db.all(`SELECT current_setting('${name}') AS v`) as Array<{ v: string }>;
    return String(rows[0].v);
  }

  it('a percentage really lands on the session (the defect: it used to be silently ignored)', async () => {
    process.env.DUCKDB_MEMORY_LIMIT = '60%';
    process.env.DUCKDB_THREADS = '1';
    const db = await Database.create(':memory:');
    try {
      const before = await setting(db, 'memory_limit');
      await applyWorkerGuardrails(db);
      const after = await setting(db, 'memory_limit');
      expect(after).not.toBe(before);
      // DuckDB reports the limit in binary units; the resolved value is 60% of
      // the memory visible to this process, so the two must agree within
      // rounding of the MiB/MB conversion.
      const expectedMb = Number(resolveMemoryLimit('60%', visibleMemoryBytes())!.replace(/MB$/, ''));
      const m = /^([\d.]+)\s*(KiB|MiB|GiB|TiB)$/.exec(after);
      expect(m).not.toBeNull();
      const reportedMiB = Number(m![1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 * 1024 }[m![2]] ?? 1);
      expect(Math.abs(reportedMiB - expectedMb * 1e6 / (1024 * 1024))).toBeLessThan(expectedMb * 0.02 + 1);
      expect(await setting(db, 'threads')).toBe('1');
    } finally {
      await db.close();
    }
  });

  it('an absolute value lands verbatim, and createGuardedDuckDb applies the same rule', async () => {
    process.env.DUCKDB_MEMORY_LIMIT = '256MB';
    const db = await createGuardedDuckDb();
    try {
      expect(await setting(db, 'memory_limit')).toBe('244.1 MiB');
    } finally {
      await db.close();
    }
  });
});

/**
 * `applyResourceGuardrails` — pinned against the REAL DuckDB binding.
 *
 * 2026-09-10: DuckDB 1.4.2 rejects `SET memory_limit='70%'` (parser error:
 * unknown unit '%'), and the guardrail's try/catch — meant for a build that
 * lacks the setting — swallowed it. Production sets `DUCKDB_MEMORY_LIMIT=70%`
 * (infra/variables.tf), so every backend session, every child query runner
 * and every worker writer ran at DuckDB's own default. The percentage is now
 * resolved to an absolute size before the SET; this test reads the setting
 * back from a live session so a string-level regression cannot pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from 'duckdb-async';
import { applyResourceGuardrails, resolveMemoryLimit, visibleMemoryBytes } from './duckdb';
import { dividedMemoryLimit } from './queryRunnerPool';

const GiB = 1024 * 1024 * 1024;

describe('resolveMemoryLimit', () => {
  it('turns a percentage into MB of the memory this process is allowed', () => {
    expect(resolveMemoryLimit('70%', 2 * GiB)).toBe('1433MB');
    expect(resolveMemoryLimit('512MB', 2 * GiB)).toBe('512MB');
    expect(resolveMemoryLimit('nope', 2 * GiB)).toBeNull();
  });

  it('composes with the runner pool division: a divided percentage still resolves', () => {
    // The child runner receives e.g. '11%' (70% / 6) and resolves it itself.
    expect(resolveMemoryLimit(dividedMemoryLimit('70%', 6), 2 * GiB)).toBe('225MB');
  });
});

describe('applyResourceGuardrails (real DuckDB)', () => {
  const saved = process.env.DUCKDB_MEMORY_LIMIT;
  afterEach(() => {
    if (saved === undefined) delete process.env.DUCKDB_MEMORY_LIMIT; else process.env.DUCKDB_MEMORY_LIMIT = saved;
  });

  it("the production value '70%' actually changes the session's memory_limit", async () => {
    process.env.DUCKDB_MEMORY_LIMIT = '70%';
    const db = await Database.create(':memory:');
    try {
      const read = async () => String((await db.all(`SELECT current_setting('memory_limit') AS v`) as Array<{ v: string }>)[0].v);
      const before = await read();
      await applyResourceGuardrails(db);
      const after = await read();
      expect(after).not.toBe(before);
      const expectedMb = Number(resolveMemoryLimit('70%', visibleMemoryBytes())!.replace(/MB$/, ''));
      const m = /^([\d.]+)\s*(MiB|GiB)$/.exec(after);
      expect(m).not.toBeNull();
      const reportedMiB = Number(m![1]) * (m![2] === 'GiB' ? 1024 : 1);
      expect(Math.abs(reportedMiB - expectedMb * 1e6 / (1024 * 1024))).toBeLessThan(expectedMb * 0.02 + 1);
    } finally {
      await db.close();
    }
  });
});

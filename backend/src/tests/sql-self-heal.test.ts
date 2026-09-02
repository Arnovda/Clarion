import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both collaborators are mocked: this suite is about the ORDER of operations
// and the refusals, not about Claude or the policy loader.
const repairReadQuerySql = vi.fn();
vi.mock('../ai/AIService', () => ({
  repairReadQuerySql: (...args: unknown[]) => repairReadQuerySql(...args),
  // Real class shape: the service checks `instanceof` on the repair failure.
  AiCreditExhaustedError: class AiCreditExhaustedError extends Error {},
}));

const applyDataPolicies = vi.fn();
vi.mock('../services/policyEngine', () => ({
  applyDataPolicies: (...args: unknown[]) => applyDataPolicies(...args),
}));

import { executeWithSelfHeal, isRepairableSqlError } from '../services/sqlSelfHeal';

/** The failure this whole feature exists for — the user's production case. */
const BINDER_ERROR =
  'Binder Error: Values list "pe" does not have a column named "AccountCode"';

const GOOD_SQL = 'SELECT SupplierName, SUM(cost) AS total FROM purchases GROUP BY SupplierName';

function base(overrides: Partial<Parameters<typeof executeWithSelfHeal>[0]> = {}) {
  return {
    sql: GOOD_SQL,
    question: 'how does total purchase cost compare across suppliers?',
    schemaContext: 'purchases(SupplierName VARCHAR, cost DOUBLE)',
    userId: 7,
    userRole: 'viewer',
    tenantId: 42,
    execute: vi.fn(async () => [{ SupplierName: 'ACME', total: 10 }]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: policies are a pass-through that reports nothing applied.
  applyDataPolicies.mockImplementation(async (sql: string) => ({
    sql, policiesApplied: 0, policyNames: [],
  }));
});

describe('isRepairableSqlError', () => {
  it('matches the compile errors a rewrite can fix, across dialects', () => {
    for (const msg of [
      BINDER_ERROR,
      'Catalog Error: Table with name foo does not exist',
      'Parser Error: syntax error at or near "GROUP"',
      'column "accountcode" does not exist',                 // Postgres
      'Unknown column \'AccountCode\' in \'field list\'',     // MySQL
      'Invalid column name \'AccountCode\'.',                 // SQL Server
      'no such column: AccountCode',                          // SQLite
      'column "x" must appear in the GROUP BY clause',
    ]) {
      expect(isRepairableSqlError(msg), msg).toBe(true);
    }
  });

  it('does NOT match conditions a rewrite cannot fix', () => {
    // Retrying these burns a model call and delays telling the user the truth.
    for (const msg of [
      'Query timed out after 45000ms',
      'permission denied for table invoices',
      'Connection terminated unexpectedly',
      'Out of Memory Error: could not allocate',
      'ECONNREFUSED 127.0.0.1:5432',
    ]) {
      expect(isRepairableSqlError(msg), msg).toBe(false);
    }
  });
});

describe('executeWithSelfHeal', () => {
  it('returns rows untouched when the query works, and never calls the model', async () => {
    const opts = base();
    const out = await executeWithSelfHeal(opts);

    expect(out.rows).toEqual([{ SupplierName: 'ACME', total: 10 }]);
    expect(out.repair).toBeUndefined();
    expect(out.sql).toBe(GOOD_SQL);
    expect(repairReadQuerySql).not.toHaveBeenCalled();
    expect(opts.execute).toHaveBeenCalledTimes(1);
  });

  it('repairs a binder error and reports the CORRECTED sql as the one that ran', async () => {
    const fixed = 'SELECT SupplierName, SUM(cost) AS total FROM purchases GROUP BY SupplierName, AccountCode';
    repairReadQuerySql.mockResolvedValue(fixed);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error(BINDER_ERROR))
      .mockResolvedValueOnce([{ SupplierName: 'ACME', total: 10 }]);

    const out = await executeWithSelfHeal(base({ execute }));

    expect(out.rows).toHaveLength(1);
    // The card and the query log must show the SQL that produced the numbers.
    expect(out.sql).toBe(fixed);
    expect(out.repair?.failedSql).toBe(GOOD_SQL);
    expect(out.repair?.error).toBe(BINDER_ERROR);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('repairs from the PRE-policy sql and re-applies policies to the result', async () => {
    // The ordering rule. Policies wrap the query; handing the model the
    // wrapped text and trusting its rewrite would let it drop the wrapper.
    const WRAP = (sql: string) => `SELECT * FROM (${sql}) AS _policy_filtered WHERE region = 'BE'`;
    applyDataPolicies.mockImplementation(async (sql: string) => ({
      sql: WRAP(sql), policiesApplied: 1, policyNames: ['region'],
    }));
    const fixed = 'SELECT SupplierName FROM purchases GROUP BY SupplierName';
    repairReadQuerySql.mockResolvedValue(fixed);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error(BINDER_ERROR))
      .mockResolvedValueOnce([]);

    const out = await executeWithSelfHeal(base({ execute }));

    // The model saw the bare SQL, never the policy wrapper.
    expect(repairReadQuerySql).toHaveBeenCalledWith(
      expect.any(String), GOOD_SQL, BINDER_ERROR, expect.any(String),
    );
    // Policies were applied AGAIN, to the repaired text — not carried over.
    expect(applyDataPolicies).toHaveBeenCalledTimes(2);
    expect(applyDataPolicies.mock.calls[1][0]).toBe(fixed);
    // And what actually executed on the retry is the wrapped repaired query.
    expect(execute.mock.calls[1][0]).toBe(WRAP(fixed));
    expect(out.policy.policiesApplied).toBe(1);
  });

  it('refuses a repair that would read outside the tenant, and reports the original error', async () => {
    // Fresh model output carries no more trust than first-pass generation:
    // the read guard runs again before anything executes.
    repairReadQuerySql.mockResolvedValue(
      "SELECT * FROM read_parquet('az://warehouse/tenant_99/x.parquet')",
    );
    const execute = vi.fn().mockRejectedValueOnce(new Error(BINDER_ERROR));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow(BINDER_ERROR);
    expect(execute).toHaveBeenCalledTimes(1); // the repair never ran
  });

  it('refuses a repair that drops a data policy', async () => {
    applyDataPolicies
      .mockImplementationOnce(async (sql: string) => ({ sql, policiesApplied: 1, policyNames: ['region'] }))
      .mockImplementationOnce(async (sql: string) => ({ sql, policiesApplied: 0, policyNames: [] }));
    repairReadQuerySql.mockResolvedValue('SELECT SupplierName FROM other_table');
    const execute = vi.fn().mockRejectedValueOnce(new Error(BINDER_ERROR));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow(BINDER_ERROR);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects prose instead of persisting an apology as SQL', async () => {
    repairReadQuerySql.mockResolvedValue(
      "I cannot repair this query because the schema does not include AccountCode.",
    );
    const execute = vi.fn().mockRejectedValueOnce(new Error(BINDER_ERROR));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow(BINDER_ERROR);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('treats unchanged SQL as the declined-to-fix signal it is', async () => {
    // The prompt tells the model to return the original when it cannot fix
    // the error. Re-running it would fail identically.
    repairReadQuerySql.mockResolvedValue(`  ${GOOD_SQL}  `);
    const execute = vi.fn().mockRejectedValueOnce(new Error(BINDER_ERROR));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow(BINDER_ERROR);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a repair for an error a rewrite cannot fix', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('Query timed out after 45000ms'));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow('timed out');
    expect(repairReadQuerySql).not.toHaveBeenCalled();
  });

  it('reports the ORIGINAL error when the repaired query also fails', async () => {
    // The second error describes the machinery's attempt; the first describes
    // what the user asked for.
    repairReadQuerySql.mockResolvedValue('SELECT SupplierName FROM purchases');
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error(BINDER_ERROR))
      .mockRejectedValueOnce(new Error('Catalog Error: something else entirely'));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow(BINDER_ERROR);
  });

  it('reports the original error when the model itself is unavailable', async () => {
    repairReadQuerySql.mockRejectedValue(new Error('credits exhausted'));
    const execute = vi.fn().mockRejectedValueOnce(new Error(BINDER_ERROR));

    await expect(executeWithSelfHeal(base({ execute }))).rejects.toThrow(BINDER_ERROR);
  });

  it('announces the repair once, before the model call', async () => {
    repairReadQuerySql.mockResolvedValue('SELECT SupplierName FROM purchases');
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error(BINDER_ERROR))
      .mockResolvedValueOnce([]);
    const onRepairStart = vi.fn();

    await executeWithSelfHeal(base({ execute, onRepairStart }));
    expect(onRepairStart).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing needed repairing', async () => {
    const onRepairStart = vi.fn();
    await executeWithSelfHeal(base({ onRepairStart }));
    expect(onRepairStart).not.toHaveBeenCalled();
  });
});

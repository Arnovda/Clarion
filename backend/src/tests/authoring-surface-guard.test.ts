/**
 * Two Tier-1 fixes, 2026-09-07:
 *
 * (1) THE GUARD. `products/cells.ts` (cell execute + the preceding-cell views
 *     it chains) and the refinement PREVIEW ran AI-authored SQL raw. DDL was
 *     allowed, and so was `read_parquet('az://…')` aimed at ANOTHER tenant's
 *     warehouse prefix — the P0-1 vector on two surfaces the notebook guard
 *     never covered. Both now go through `assertSafeReadQuery`.
 *
 *     These are pure-function tests on the guard itself rather than route
 *     tests: reaching the execute route needs a materialised product table and
 *     a live DuckDB session, and what actually changed is WHICH strings are
 *     admitted. The strings below are the ones those two surfaces pass in.
 *
 * (2) ONE SESSION BUILDER. `buildNamespacedDuckDB` (notebooks) and
 *     `buildConnectionWarehouseSession` (preview + cells) were near-identical
 *     copies that both lacked managed grids and monthly rollups, while the Ask
 *     AI session registered them — so the escape hatch saw LESS than the front
 *     door. There is one builder now, and the notebook is a caller.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertSafeReadQuery, UnsafeSqlError } from '../utils/sqlGuard';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('the guard now on cell execute and the refinement preview', () => {
  it('admits the ordinary transformation SELECT these surfaces are for', () => {
    const sql = `SELECT c.customer_key, SUM(f.amount) AS total
                 FROM fact_sales f JOIN dim_customer c ON c.customer_key = f.customer_key
                 GROUP BY 1`;
    expect(assertSafeReadQuery(sql)).toContain('SELECT');
  });

  it('admits a CTE — the shape a refinement proposal usually writes', () => {
    const sql = `WITH m AS (SELECT * FROM fact_sales) SELECT COUNT(*) FROM m`;
    expect(() => assertSafeReadQuery(sql)).not.toThrow();
  });

  it('REFUSES a cross-tenant warehouse read — the reason this guard exists', () => {
    // The whole point: nothing about this is syntactically odd, and it ran.
    expect(() => assertSafeReadQuery(
      "SELECT * FROM read_parquet('az://warehouse/tenant_999/conn_1/Accounts/data.parquet')",
    )).toThrow(UnsafeSqlError);
  });

  it('REFUSES the quoted-function form of the same read', () => {
    expect(() => assertSafeReadQuery(
      `SELECT * FROM "read_parquet"('az://warehouse/tenant_999/x.parquet')`,
    )).toThrow(UnsafeSqlError);
  });

  it('REFUSES a bare-path read, which needs no read_* function at all', () => {
    expect(() => assertSafeReadQuery(
      "SELECT * FROM '/warehouse/tenant_999/conn_1/Accounts/data.parquet'",
    )).toThrow(UnsafeSqlError);
  });

  it('REFUSES reading the process environment', () => {
    expect(() => assertSafeReadQuery("SELECT * FROM read_text('/proc/self/environ')"))
      .toThrow(UnsafeSqlError);
  });

  it('REFUSES DDL — a cell drafts a transformation, and a transformation is a SELECT', () => {
    expect(() => assertSafeReadQuery('DROP TABLE dim_customer')).toThrow(UnsafeSqlError);
    expect(() => assertSafeReadQuery('CREATE TABLE evil AS SELECT 1')).toThrow(UnsafeSqlError);
  });

  it('still allows a column whose NAME merely contains a denylisted word', () => {
    expect(() => assertSafeReadQuery('SELECT my_read_text, query_count FROM dim_customer'))
      .not.toThrow();
  });
});

describe('the guard is actually wired into both surfaces', () => {
  // Source-level assertions on purpose: the defect was an ABSENT call, and an
  // absent call is what regresses. Driving the routes would need a live
  // warehouse; this pins the thing that was missing.
  const cells = read('routes/products/cells.ts');
  const refine = read('routes/products/refineChat.ts');

  it('cell execute guards the SQL it runs', () => {
    expect(cells).toContain("import { assertSafeReadQuery } from '../../utils/sqlGuard'");
    expect(cells).toContain('duckDb.all(assertSafeReadQuery(sqlToRun))');
    expect(cells).not.toContain('duckDb.all(sqlToRun.trim())');
  });

  it('cell chaining guards each predecessor before it becomes a VIEW', () => {
    // An unguarded predecessor is the same hole one step back.
    const chain = cells.slice(cells.indexOf('for (const prev of precedingCells)'));
    const viewAt = chain.indexOf('CREATE OR REPLACE VIEW');
    const guardAt = chain.indexOf('assertSafeReadQuery(prevSql)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(viewAt); // guarded BEFORE it is registered
  });

  it('the refinement preview guards the INNER sql, not just its own wrapper', () => {
    expect(refine).toContain("import { assertSafeReadQuery } from '../../utils/sqlGuard'");
    expect(refine).toContain('assertSafeReadQuery(plan.sql)');
  });
});

describe('one warehouse session builder', () => {
  const shared = read('services/productWarehouse.ts');
  const notebooks = read('routes/notebooks.ts');

  it('the notebook no longer carries its own copy', () => {
    expect(notebooks).not.toContain('async function buildNamespacedDuckDB');
    expect(notebooks).toContain("import { buildConnectionWarehouseSession } from '../services/productWarehouse'");
  });

  it('every notebook session comes from the shared builder', () => {
    // Two CALL sites (the import has no paren, so it does not match here):
    // POST /notebooks/query and POST /notebooks/cells/:id/execute.
    const calls = notebooks.match(/buildConnectionWarehouseSession\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it('the shared builder registers grids and rollups — what the notebook used to lack', () => {
    expect(shared).toContain('listManagedGridTables');
    expect(shared).toContain('rollupViewName');
  });

  it('a grid never shadows an already-registered table', () => {
    // A user's existing `FROM budget` must not silently change meaning.
    expect(shared).toContain('registeredNames.has(g.viewName)');
  });

  it('tenantId is required, so the compiler names every caller', () => {
    // The mechanism moved when the session became scope-aware: the tenant used
    // to be a positional argument, and is now a field on the QueryScope the
    // builder takes. The GUARANTEE is unchanged and is what this pins — a
    // caller cannot omit it, so the compiler still names every call site.
    expect(shared).toMatch(/scope: QueryScope,\s*\n\): Promise<Database>/);
    expect(shared).not.toContain('listSourceTables(undefined');
    expect(shared).not.toContain('listProductTablesForScope(undefined');

    // And the field itself must stay REQUIRED. `tenantId?: number` would
    // compile everywhere and silently reintroduce the D2 defect: no tenant
    // context, an RLS predicate of `tenant_id = NULL`, and a session that
    // registers zero views while looking perfectly healthy.
    const scopeSrc = readFileSync(join(SRC, 'services', 'queryScope.ts'), 'utf8');
    expect(scopeSrc).toContain('tenantId: number | undefined;');
    expect(scopeSrc).not.toContain('tenantId?:');
  });
});

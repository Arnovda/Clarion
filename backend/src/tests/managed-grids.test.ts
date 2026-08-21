/**
 * Managed grids — /api/grids + the pure derivation/coercion layer.
 *
 * What this guards, beyond "the route returns 200":
 *  1. **Identifier safety** — user-chosen names become warehouse identifiers
 *     (view name, parquet columns). The derivation must be total and its
 *     output must satisfy the strict patterns, whatever the input.
 *  2. **Tenant isolation** — grids are enumerable by id; the other tenant
 *     gets 404 (never 403 — a 403 confirms the id exists).
 *  3. **Role gate** — analyst allowed, viewer refused on every route.
 *  4. **Spreadsheet-shaped values** — `1.234,56` and `21/08/2026` are what a
 *     Belgian Excel produces; refusing them would make paste useless.
 *  5. **Save is truth-first** — rows commit even when warehouse
 *     materialisation fails (the route records the error instead of 500ing).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import {
  deriveGridSlug,
  deriveColumnKey,
  normalizeColumns,
  coerceRow,
  parseFlexibleNumber,
  parseFlexibleDate,
  isValidGridSlug,
  isValidColumnKey,
  GridValidationError,
} from '../services/managedGrids';
import { gridViewName, gridBasePath } from '../services/warehouse';

// ─── Pure derivation layer ──────────────────────────────────────────────────

describe('grid identifier derivation', () => {
  it('derives safe slugs from arbitrary names', () => {
    expect(deriveGridSlug('Budget 2026')).toBe('budget_2026');
    expect(deriveGridSlug('  Omzet / regio!  ')).toBe('omzet_regio');
    expect(deriveGridSlug('2026 targets')).toBe('g_2026_targets');
    expect(deriveGridSlug('***')).toBe('table');
    for (const name of ['Budget 2026', "a'; DROP TABLE--", '€€€', 'x'.repeat(200)]) {
      const slug = deriveGridSlug(name);
      expect(isValidGridSlug(slug)).toBe(true);
    }
  });

  it('derives unique, safe column keys', () => {
    const taken = new Set<string>();
    const k1 = deriveColumnKey('GL account', taken); taken.add(k1);
    const k2 = deriveColumnKey('GL Account', taken); taken.add(k2);
    expect(k1).toBe('gl_account');
    expect(k2).toBe('gl_account_2');
    expect(isValidColumnKey(deriveColumnKey('1st month', new Set()))).toBe(true);
    expect(isValidColumnKey(deriveColumnKey('!!!', new Set()))).toBe(true);
  });

  it('normalizeColumns keeps supplied keys and refuses duplicates', () => {
    const cols = normalizeColumns([
      { key: 'amount', name: 'Renamed amount', type: 'number' },
      { name: 'Period', type: 'date' },
    ]);
    expect(cols[0]).toEqual({ key: 'amount', name: 'Renamed amount', type: 'number' });
    expect(cols[1].key).toBe('period');
    expect(() => normalizeColumns([
      { key: 'a', name: 'A', type: 'text' },
      { key: 'a', name: 'B', type: 'text' },
    ])).toThrow(GridValidationError);
    expect(() => normalizeColumns([])).toThrow(GridValidationError);
  });

  it('gridViewName + gridBasePath follow the naming contract', () => {
    expect(gridViewName('budget_2026')).toBe('grid_budget_2026');
    const p = gridBasePath(42, 7, 3).replace(/\\/g, '/');
    expect(p).toContain('tenant_42');
    expect(p).toContain('grids/grid_7_v3');
  });
});

describe('spreadsheet-shaped value parsing', () => {
  it('parses eu and en number formats', () => {
    expect(parseFlexibleNumber('1.234,56')).toBe(1234.56);
    expect(parseFlexibleNumber('1,234.56')).toBe(1234.56);
    expect(parseFlexibleNumber('12,5')).toBe(12.5);
    expect(parseFlexibleNumber('1,234,567')).toBe(1234567);
    expect(parseFlexibleNumber('€ 120 000')).toBe(120000);
    expect(parseFlexibleNumber('-3.5')).toBe(-3.5);
    expect(parseFlexibleNumber('abc')).toBeNull();
    expect(parseFlexibleNumber('')).toBeNull();
  });

  it('parses iso and day-first dates', () => {
    expect(parseFlexibleDate('2026-08-21')).toBe('2026-08-21');
    expect(parseFlexibleDate('21/08/2026')).toBe('2026-08-21');
    expect(parseFlexibleDate('1.9.2026')).toBe('2026-09-01');
    expect(parseFlexibleDate('2026/08/21')).toBe('2026-08-21');
    expect(parseFlexibleDate('21/13/2026')).toBeNull();
    expect(parseFlexibleDate('not a date')).toBeNull();
  });

  it('coerceRow validates per type, drops undeclared keys, and names the failure', () => {
    const cols = normalizeColumns([
      { name: 'Category', type: 'text' },
      { name: 'Amount', type: 'number' },
      { name: 'Period', type: 'date' },
      { name: 'Active', type: 'boolean' },
    ]);
    const clean = coerceRow(
      { category: 'Rent', amount: '1.234,56', period: '21/08/2026', active: 'yes', stale_key: 'x' },
      cols, 0,
    );
    expect(clean).toEqual({ category: 'Rent', amount: 1234.56, period: '2026-08-21', active: true });
    expect('stale_key' in clean).toBe(false);
    expect(() => coerceRow({ amount: 'oops' }, cols, 4)).toThrow(/Row 5.*Amount.*not a number/s);
  });
});

// ─── Routes ─────────────────────────────────────────────────────────────────

let adminToken: string;
let analystToken: string;
let viewerToken: string;
let otherToken: string;
let tenantId: number;
let gridId: number;

describe('/api/grids', () => {
  beforeAll(async () => {
    await cleanTestDb();
    const admin = await registerUser({ email: 'grids-admin@test.com', companyName: 'GridCo' });
    adminToken = admin.token;
    tenantId = admin.user.tenantId;
    analystToken = makeToken({ tenantId, role: 'analyst', email: 'grids-analyst@test.com' });
    viewerToken = makeToken({ tenantId, role: 'viewer', email: 'grids-viewer@test.com' });
    const other = await registerUser({ email: 'grids-other@test.com', companyName: 'OtherGridCo' });
    otherToken = other.token;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('creates a grid with derived keys and slug', async () => {
    const res = await request()
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Budget 2026',
        kind: 'budget',
        columns: [
          { name: 'Category', type: 'text' },
          { name: 'Period', type: 'date' },
          { name: 'Amount', type: 'number' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    gridId = res.body.data.id;
    expect(res.body.data.slug).toBe('budget_2026');
    expect(res.body.data.viewName).toBe('grid_budget_2026');
    expect(res.body.data.columns.map((c: { key: string }) => c.key)).toEqual(['category', 'period', 'amount']);
    // Materialisation ran (or recorded why it couldn't) — never silence.
    const row = await getTestDb()('managed_grids').where({ id: gridId }).first();
    expect(row.warehouse_path !== null || row.materialize_error !== null).toBe(true);
  });

  it('refuses a name that collides on slug', async () => {
    const res = await request()
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'budget   2026!', columns: [{ name: 'A', type: 'text' }] });
    expect(res.status).toBe(409);
  });

  it('saves rows with spreadsheet-shaped values and updates the count', async () => {
    const res = await request()
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${analystToken}`)
      .send({
        rows: [
          { data: { category: 'Rent', period: '21/01/2026', amount: '1.250,00' } },
          { data: { category: 'Salaries', period: '2026-01-21', amount: 84000 } },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.rowCount).toBe(2);
    const stored = await getTestDb()('managed_grid_rows')
      .where({ grid_id: gridId })
      .orderBy('position', 'asc');
    expect(stored).toHaveLength(2);
    expect(stored[0].data.amount).toBe(1250);
    expect(stored[0].data.period).toBe('2026-01-21');
  });

  it('rejects an invalid value with the row and column named', async () => {
    const res = await request()
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${analystToken}`)
      .send({ rows: [{ data: { category: 'X', amount: 'twelve' } }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Row 1/);
    expect(res.body.error).toMatch(/Amount/);
    // The failed save must not have replaced the previous rows.
    const stored = await getTestDb()('managed_grid_rows').where({ grid_id: gridId });
    expect(stored).toHaveLength(2);
  });

  it('renaming keeps the slug; column update with preserved key survives', async () => {
    const res = await request()
      .put(`/api/grids/${gridId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Budget FY26',
        columns: [
          { key: 'category', name: 'Cost category', type: 'text' },
          { key: 'period', name: 'Period', type: 'date' },
          { key: 'amount', name: 'Amount', type: 'number' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Budget FY26');
    expect(res.body.data.slug).toBe('budget_2026');
    expect(res.body.data.columns[0]).toEqual({ key: 'category', name: 'Cost category', type: 'text' });
  });

  it('lists the tenant grids', async () => {
    const res = await request().get('/api/grids').set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].rowCount).toBe(2);
  });

  it('is tenant-isolated: the other tenant sees nothing and gets 404 by id', async () => {
    const list = await request().get('/api/grids').set('Authorization', `Bearer ${otherToken}`);
    expect(list.body.data).toHaveLength(0);
    for (const [method, path] of [
      ['get', `/api/grids/${gridId}`],
      ['delete', `/api/grids/${gridId}`],
    ] as const) {
      const res = await request()[method](path).set('Authorization', `Bearer ${otherToken}`);
      expect(res.status).toBe(404);
    }
    const rowsRes = await request()
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ rows: [] });
    expect(rowsRes.status).toBe(404);
  });

  it('refuses viewers on every route', async () => {
    for (const res of await Promise.all([
      request().get('/api/grids').set('Authorization', `Bearer ${viewerToken}`),
      request().post('/api/grids').set('Authorization', `Bearer ${viewerToken}`).send({ name: 'X', columns: [{ name: 'A', type: 'text' }] }),
      request().get(`/api/grids/${gridId}`).set('Authorization', `Bearer ${viewerToken}`),
      request().put(`/api/grids/${gridId}/rows`).set('Authorization', `Bearer ${viewerToken}`).send({ rows: [] }),
      request().delete(`/api/grids/${gridId}`).set('Authorization', `Bearer ${viewerToken}`),
    ])) {
      expect(res.status).toBe(403);
    }
  });

  it('enforces the row cap with a business-language refusal', async () => {
    const rows = Array.from({ length: 10_001 }, () => ({ data: {} }));
    const res = await request()
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows });
    expect(res.status).toBe(400);
  });

  it('deletes the grid and its rows', async () => {
    const res = await request()
      .delete(`/api/grids/${gridId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const db = getTestDb();
    expect(await db('managed_grids').where({ id: gridId }).first()).toBeUndefined();
    expect(await db('managed_grid_rows').where({ grid_id: gridId })).toHaveLength(0);
  });
});

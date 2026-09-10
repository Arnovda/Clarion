/**
 * The topic Delta writer, end to end, nothing mocked: DuckDB 1.4.2 (the
 * backend's own binding) produces the new state and the change counts,
 * the Python sidecar (`etl/scd2/commit_table.py`, deltalake 1.x) commits
 * the Delta version, and the same DuckDB reads it back through
 * `createScanView` — the read every prompt, dashboard and notebook uses.
 *
 * The 2026-09-10 rewrite moved everything proportional to the table out of
 * the sidecar (it loaded the whole table into pandas twice — 6.7 GB peak
 * on the 3M-row PoC table, in a 1 GiB container). This suite pins what the
 * chart shows for each kind of refresh, and that DuckDB can read what the
 * newer delta-rs writes.
 *
 * The end-to-end half needs `python3` with `deltalake` + `pyarrow`; CI's
 * api-tests job installs the image's pins. Without them it SKIPS and says
 * so — never silently passes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'duckdb-async';

import { registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import {
  countChangesAgainstPrevious,
  duplicateKeyRows,
  maintainDeltaTables,
  rowHashExpression,
  writeDeltaWithSidecar,
} from '../services/warehouse/deltaWriter';
import { createScanView, setupDuckDBForWarehouse } from '../services/warehouse';

const sidecarDeps = spawnSync(process.env.PYTHON_BIN ?? 'python3', ['-c', 'import deltalake, pyarrow'], { encoding: 'utf8' });
const haveSidecar = sidecarDeps.status === 0;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-delta-topic-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

async function session(): Promise<Database> {
  const db = await Database.create(':memory:');
  await setupDuckDBForWarehouse(db, false);
  return db;
}

describe('rowHashExpression', () => {
  it('hashes the business columns the SELECT actually carries, in declared order, NULL spelled out', async () => {
    const db = await session();
    try {
      const expr = rowHashExpression(['b', 'a', 'missing', '_row_hash'], ['a', 'b', 'c']);
      expect(expr).toBe(`md5(concat_ws(chr(31), COALESCE(CAST("b" AS VARCHAR), 'NULL'), COALESCE(CAST("a" AS VARCHAR), 'NULL')))`);
      const rows = await db.all(`SELECT ${expr} AS h FROM (SELECT 'x' AS a, NULL::INT AS b, 1 AS c)`) as Array<{ h: string }>;
      // md5('NULL' + US + 'x'), the same string the sidecar's Python fallback builds.
      const expected = await db.all(`SELECT md5('NULL' || chr(31) || 'x') AS h`) as Array<{ h: string }>;
      expect(rows[0].h).toBe(expected[0].h);
      expect(rowHashExpression(['nope'], ['a'])).toBe(`'no-business-columns'`);
    } finally { await db.close(); }
  });
});

describe('countChangesAgainstPrevious + duplicateKeyRows (real DuckDB, parquet previous state)', () => {
  it('classifies unchanged / updated / inserted / deleted on the key, and reports null when there is no previous state', async () => {
    const db = await session();
    try {
      const prevDir = path.join(root, 'prev');
      fs.mkdirSync(prevDir, { recursive: true });
      const hash = rowHashExpression(['id', 'v'], ['id', 'v']);
      await db.exec(`COPY (SELECT *, ${hash} AS _row_hash FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) t(id, v)) TO '${prevDir.replace(/'/g, "''")}/data.parquet' (FORMAT PARQUET)`);
      const newState = `SELECT *, ${hash} AS _row_hash FROM (VALUES (1, 'a'), (2, 'B'), (4, 'd')) t(id, v)`;
      expect(await countChangesAgainstPrevious(db, prevDir, newState, ['id'])).toEqual({
        rows_unchanged: 1, rows_updated: 1, rows_inserted: 1, rows_deleted: 1, rows_total: 3,
      });
      expect(await countChangesAgainstPrevious(db, path.join(root, 'nowhere'), newState, ['id'])).toBeNull();
      expect(await countChangesAgainstPrevious(db, prevDir, newState, [])).toBeNull();
      expect(await duplicateKeyRows(db, `SELECT * FROM (VALUES (1), (1), (2), (2), (2)) t(id)`, ['id'])).toBe(3);
      expect(await duplicateKeyRows(db, `SELECT * FROM (VALUES (1), (2)) t(id)`, ['id'])).toBe(0);
    } finally { await db.close(); }
  });
});

describe.skipIf(!haveSidecar)('writeDeltaWithSidecar end to end (DuckDB 1.4.2 ↔ deltalake 1.x)', () => {
  let tenantId: number;
  let tableId: number;
  const tableDir = path.join(root, 'dim_account');

  beforeAll(async () => {
    await cleanTestDb();
    const admin = await registerUser({ email: 'admin@deltatopic.test', companyName: 'Delta Topic BV' });
    tenantId = admin.user.tenantId;
    const db = getTestDb();
    const [conn] = await db('connections').insert({
      tenant_id: tenantId, name: 'Exact (delta)', type: 'duckdb', connector_type: 'exactonline',
      selected_entities: ['Accounts'], warehouse_path: root, query_engine: 'duckdb', config: JSON.stringify({}),
    }).returning('id');
    const [product] = await db('data_products').insert({
      tenant_id: tenantId, connection_id: idOf(conn), name: 'Sales', description: 'delta', status: 'approved', kind: 'analytics',
    }).returning('id');
    const [schema] = await db('star_schemas').insert({
      tenant_id: tenantId, data_product_id: idOf(product), name: 'Sales star', grain: 'one row per account',
    }).returning('id');
    const [dim] = await db('product_tables').insert({
      tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'dim_account', table_role: 'dimension', dag_order: 0,
      transformation_sql: 'SELECT 1',
    }).returning('id');
    tableId = idOf(dim);
  });

  afterAll(async () => {
    await closeTestDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const history = async () => getTestDb()('product_table_refresh_history').where({ product_table_id: tableId }).orderBy('id');

  it('first run: creates the Delta table, DuckDB reads it back, the chart says all inserted', async () => {
    const db = await session();
    try {
      const r = await writeDeltaWithSidecar({
        db, deltaUri: tableDir,
        selectSql: `SELECT * FROM (VALUES (1, 'Van Damme', 'BE'), (2, 'Peeters', 'BE'), (3, 'Nord', 'DE')) t(account_key, account_name, country)`,
        productTableId: tableId, tenantId, businessKeyColumns: ['account_key'], businessColumns: ['account_key', 'account_name', 'country'],
      });
      expect(r.status).toBe('ok');
      expect(r.firstRun).toBe(true);
      expect(r.writeMode).toBe('overwrite');
      expect([r.rowsInserted, r.rowsTotal, r.rowsUpdated, r.rowsDeleted]).toEqual([3, 3, 0, 0]);
      expect(fs.existsSync(path.join(tableDir, '_delta_log'))).toBe(true);

      await createScanView(db, 'dim_account', tableDir);
      const rows = await db.all(`SELECT account_key, account_name FROM dim_account ORDER BY account_key`) as Array<{ account_key: number; account_name: string }>;
      expect(rows.map((x) => x.account_name)).toEqual(['Van Damme', 'Peeters', 'Nord']);
      const cols = (await db.all(`DESCRIBE dim_account`) as Array<{ column_name: string }>).map((c) => c.column_name);
      expect(cols).toContain('_row_hash');
    } finally { await db.close(); }
  });

  it('refresh: the counts are what changed on the key, and the table holds the new state', async () => {
    const db = await session();
    try {
      const r = await writeDeltaWithSidecar({
        db, deltaUri: tableDir,
        selectSql: `SELECT * FROM (VALUES (1, 'Van Damme', 'BE'), (2, 'Peeters NV', 'BE'), (4, 'Sud', 'FR')) t(account_key, account_name, country)`,
        productTableId: tableId, tenantId, businessKeyColumns: ['account_key'], businessColumns: ['account_key', 'account_name', 'country'],
      });
      expect(r.firstRun).toBe(false);
      expect([r.rowsUnchanged, r.rowsUpdated, r.rowsInserted, r.rowsDeleted, r.rowsTotal]).toEqual([1, 1, 1, 1, 3]);
      await createScanView(db, 'dim_account', tableDir);
      const rows = await db.all(`SELECT account_key FROM dim_account ORDER BY account_key`) as Array<{ account_key: number }>;
      expect(rows.map((x) => Number(x.account_key))).toEqual([1, 2, 4]);
      const h = await history();
      expect(h.map((x) => [x.status, Number(x.rows_inserted), Number(x.rows_updated), Number(x.rows_deleted)])).toEqual([
        ['ok', 3, 0, 0], ['ok', 1, 1, 1],
      ]);
    } finally { await db.close(); }
  });

  it('a repeating business key gives up on counts (all inserted) instead of counting wrong', async () => {
    const db = await session();
    try {
      const r = await writeDeltaWithSidecar({
        db, deltaUri: tableDir,
        selectSql: `SELECT * FROM (VALUES (1, 'a', 'BE'), (1, 'b', 'BE')) t(account_key, account_name, country)`,
        productTableId: tableId, tenantId, businessKeyColumns: ['account_key'], businessColumns: ['account_key', 'account_name', 'country'],
      });
      expect([r.rowsUnchanged, r.rowsUpdated, r.rowsInserted, r.rowsDeleted, r.rowsTotal]).toEqual([0, 0, 2, 0, 2]);
    } finally { await db.close(); }
  });

  it('a zero-row refresh preserves the table and says so; the catalog count is what the table holds', async () => {
    const db = await session();
    try {
      const r = await writeDeltaWithSidecar({
        db, deltaUri: tableDir,
        selectSql: `SELECT 1 AS account_key, 'x' AS account_name, 'BE' AS country WHERE FALSE`,
        productTableId: tableId, tenantId, businessKeyColumns: ['account_key'], businessColumns: ['account_key', 'account_name', 'country'],
      });
      expect(r.preservedExisting).toBe(true);
      expect(r.writeMode).toBe('preserved');
      expect(r.rowsTotal).toBe(2);
      await createScanView(db, 'dim_account', tableDir);
      expect(Number((await db.all(`SELECT COUNT(*) AS n FROM dim_account`) as Array<{ n: number }>)[0].n)).toBe(2);
    } finally { await db.close(); }
  });

  it('a new column widens the table; maintenance compacts the versions and DuckDB still reads it', async () => {
    const db = await session();
    try {
      await writeDeltaWithSidecar({
        db, deltaUri: tableDir,
        selectSql: `SELECT * FROM (VALUES (1, 'a', 'BE', 10.5), (2, 'b', 'BE', 20.0)) t(account_key, account_name, country, credit_limit)`,
        productTableId: tableId, tenantId, businessKeyColumns: ['account_key'], businessColumns: ['account_key', 'account_name', 'country', 'credit_limit'],
      });
      const results = await maintainDeltaTables([tableDir, path.join(root, 'prev'), path.join(root, 'nowhere')]);
      expect(results.map((x) => [x.delta_path === tableDir, !!x.skipped, !!x.error])).toEqual([[true, false, false], [false, true, false], [false, true, false]]);
      expect(results[0].compact?.totalConsideredFiles).toBeGreaterThanOrEqual(1);
      expect(results[0].vacuum_files_removed).toBe(0); // every superseded file is minutes old
      await createScanView(db, 'dim_account', tableDir);
      const rows = await db.all(`SELECT account_key, credit_limit FROM dim_account ORDER BY account_key`) as Array<{ account_key: number; credit_limit: number }>;
      expect(rows.map((x) => Number(x.credit_limit))).toEqual([10.5, 20]);
    } finally { await db.close(); }
  });

  it('the soft-delete firewall holds on Delta: createScanView hides _clarion_deleted rows and both technical columns behind delta_scan', async () => {
    // No product table carries the columns today; the day a source table is
    // written as Delta, this is the read every prompt and dashboard goes
    // through — and phase 2 found the parquet FALLBACKS registered raw.
    const db = await session();
    const dir = path.join(root, 'src_delta');
    try {
      await writeDeltaWithSidecar({
        db, deltaUri: dir,
        selectSql: `SELECT * FROM (VALUES
          (1, 'alive',   TIMESTAMPTZ '2026-09-10 00:00:00+00', false),
          (2, 'deleted', TIMESTAMPTZ '2026-09-10 00:00:00+00', true),
          (3, 'legacy',  NULL::TIMESTAMPTZ, NULL::BOOLEAN)
        ) t(id, name, _clarion_synced_at, _clarion_deleted)`,
        productTableId: tableId, tenantId, businessKeyColumns: [], businessColumns: ['id', 'name'],
      });
      await createScanView(db, 'src_delta', dir);
      const rows = await db.all(`SELECT * FROM src_delta ORDER BY id`) as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.name)).toEqual(['alive', 'legacy']);
      expect(Object.keys(rows[0])).not.toContain('_clarion_deleted');
      expect(Object.keys(rows[0])).not.toContain('_clarion_synced_at');
    } finally { await db.close(); }
  });
});

if (!haveSidecar) {
  it('sidecar deps missing: the end-to-end suite above was SKIPPED (install deltalake + pyarrow for python3)', () => {
    expect(haveSidecar).toBe(false);
  });
}

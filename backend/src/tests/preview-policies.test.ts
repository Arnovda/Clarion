/**
 * Sample rows obey data policies (2026-09-06 evaluation, defects 2 + 6).
 *
 * `GET /semantic/preview` and `GET /semantic/product-preview` used to run
 * `SELECT * FROM "t"` — the product one for ANY role with no policy, the
 * source one admin-only (a 403 as UX for the analysts and viewers the
 * catalog shows a Sample tab to). Both now read through
 * `services/previewRead`, which this file drives end-to-end on the source
 * route against a real SQLite table: the viewer gets the row filter and the
 * mask, the analyst is admitted, the admin sees everything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-preview-'));
process.env.SQLITE_SOURCE_DIR = tmpDir;
const dbPath = path.join(tmpDir, 'preview.db');

let request: typeof import('./helpers').request;
let closeTestDb: typeof import('./db-helpers').closeTestDb;
let previewSql: typeof import('../services/previewRead').previewSql;

let adminToken: string;
let analystToken: string;
let viewerToken: string;
let tenantId: number;
let connectionId: number;

beforeAll(async () => {
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, iban TEXT, region TEXT);
    INSERT INTO customers VALUES (1, 'Van Damme BVBA', 'BE71 0961 2345 6769', 'North');
    INSERT INTO customers VALUES (2, 'Peeters NV',     'BE68 5390 0754 7034', 'South');
    INSERT INTO customers VALUES (3, 'Janssens & Co',  'BE62 5100 0754 7061', 'North');
  `);
  sqlite.close();

  const helpers = await import('./helpers');
  const dbh = await import('./db-helpers');
  request = helpers.request; closeTestDb = dbh.closeTestDb;
  previewSql = (await import('../services/previewRead')).previewSql;

  await dbh.cleanTestDb();
  const admin = await helpers.registerUser({ email: 'admin@preview.test', companyName: 'PreviewCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  analystToken = (await helpers.createUserWithToken({ tenantId, role: 'analyst', email: 'analyst@preview.test' })).token;
  viewerToken = (await helpers.createUserWithToken({ tenantId, role: 'viewer', email: 'viewer@preview.test' })).token;

  const db = dbh.getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Preview source', type: 'sqlite',
    config: JSON.stringify({ filepath: dbPath }),
  }).returning('id');
  connectionId = Number((conn as { id?: number }).id ?? conn);
  // The route validates the table against the Postgres mirror, not the graph.
  await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'customers', display_name: 'Customers' });

  await db('data_policies').insert([
    { tenant_id: tenantId, name: 'North only', role: 'viewer', table_name: 'customers', filter_expression: "region = 'North'", policy_type: 'row_filter', is_active: true },
    { tenant_id: tenantId, name: 'Mask IBAN', role: 'viewer', table_name: 'customers', column_name: 'iban', filter_expression: 'masked', policy_type: 'column_mask', is_active: true },
  ]);
});

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const url = () => `/api/semantic/preview?connectionId=${connectionId}&table=customers&limit=10`;

describe('previewSql', () => {
  it('names every column and never selects *', () => {
    const sql = previewSql('customers', ['id', 'we"ird', 'iban'], 500);
    expect(sql).toBe('SELECT "id", "we""ird", "iban" FROM "customers" LIMIT 50');
    expect(sql).not.toContain('*');
  });
});

describe('GET /semantic/preview under data policies', () => {
  it('gives the viewer only the filtered rows, with the masked column keeping its name', async () => {
    const res = await (await request()).get(url()).set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.region)).toEqual(['North', 'North']);
    expect(rows.every((r) => r.iban === '***')).toBe(true);
    expect(res.body.data.columns).toEqual(['id', 'name', 'iban', 'region']);
    expect(res.body.data.policiesApplied).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('BE71');
  });

  it('admits the analyst (the catalog shows them the Sample tab)', async () => {
    const res = await (await request()).get(url()).set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    expect((res.body.data.rows as unknown[]).length).toBe(3);
  });

  it('leaves the admin unmasked', async () => {
    const res = await (await request()).get(url()).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows[0].iban).toBe('BE71 0961 2345 6769');
    expect(res.body.data.policiesApplied).toBe(0);
  });

  it('refuses a table the connection does not have', async () => {
    const res = await (await request())
      .get(`/api/semantic/preview?connectionId=${connectionId}&table=sqlite_master`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

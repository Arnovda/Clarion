/**
 * P0-4 of the 2026-09-05 market-readiness assessment (v2): `applyDataPolicies`
 * ran on Ask AI and the Excel add-in only. A column an admin masked for the
 * viewer role was `***` in Ask AI and the real value on the dashboard the
 * same answer was pinned to; a row filter held in one place and not the
 * other. This file drives real SQL through the shared `readPolicy` helpers
 * and through the dashboard execute route against a real SQLite source, and
 * pins that the viewer sees masked + filtered rows while the admin sees all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// The SQLite connector confines file paths to SQLITE_SOURCE_DIR, read at
// module load — so it is pinned before the app is imported (dynamically, below).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-policy-'));
process.env.SQLITE_SOURCE_DIR = tmpDir;
const dbPath = path.join(tmpDir, 'policy.db');

let request: typeof import('./helpers').request;
let getTestDb: typeof import('./db-helpers').getTestDb;
let closeTestDb: typeof import('./db-helpers').closeTestDb;
let prepareUserRead: typeof import('../services/readPolicy').prepareUserRead;
let prepareUnattendedRead: typeof import('../services/readPolicy').prepareUnattendedRead;

let adminToken: string;
let viewerToken: string;
let viewerId: number;
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
  const rp = await import('../services/readPolicy');
  request = helpers.request; getTestDb = dbh.getTestDb; closeTestDb = dbh.closeTestDb;
  prepareUserRead = rp.prepareUserRead; prepareUnattendedRead = rp.prepareUnattendedRead;

  await dbh.cleanTestDb();
  const admin = await helpers.registerUser({ email: 'admin@policy.test', companyName: 'PolicyCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  const viewer = await helpers.createUserWithToken({ tenantId, role: 'viewer', email: 'viewer@policy.test' });
  viewerToken = viewer.token; viewerId = viewer.id;

  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Policy source', type: 'sqlite',
    config: JSON.stringify({ filepath: dbPath }),
  }).returning('id');
  connectionId = Number((conn as { id?: number }).id ?? conn);

  await db('data_policies').insert([
    {
      tenant_id: tenantId, name: 'North only for viewers', role: 'viewer',
      table_name: 'customers', filter_expression: "region = 'North'", policy_type: 'row_filter', is_active: true,
    },
    {
      tenant_id: tenantId, name: 'Mask IBAN for viewers', role: 'viewer',
      table_name: 'customers', column_name: 'iban', filter_expression: 'masked', policy_type: 'column_mask', is_active: true,
    },
  ]);
});

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SQL = 'SELECT id, name, iban, region FROM customers ORDER BY id';

describe('readPolicy helpers', () => {
  it('guards first: a bypass attempt is refused before any policy runs', async () => {
    await expect(
      prepareUserRead(`SELECT * FROM "read_text"('/proc/self/environ')`, { userId: viewerId, role: 'viewer', tenantId }),
    ).rejects.toThrow(/Refused/);
  });

  it('rewrites the viewer\'s SQL with the row filter and the mask', async () => {
    const out = await prepareUserRead(SQL, { userId: viewerId, role: 'viewer', tenantId });
    expect(out.policy.policiesApplied).toBe(2);
    expect(out.sql).toContain("region = 'North'");
    expect(out.sql).toContain("'***'");
  });

  it('masks an ALIAS-qualified reference too, and keeps the column name (the core-loop catch)', async () => {
    const out = await prepareUserRead('SELECT c.name, c.iban FROM customers c ORDER BY c.iban', { userId: viewerId, role: 'viewer', tenantId });
    expect(out.sql).toContain("'***' AS iban");
    expect(out.sql).not.toContain("c.'***'");
    expect(out.sql).toMatch(/ORDER BY '\*\*\*'/);
  });

  it('leaves the admin\'s SQL untouched', async () => {
    const out = await prepareUserRead(SQL, { userId: 1, role: 'admin', tenantId });
    expect(out.policy.policiesApplied).toBe(0);
    expect(out.sql).toBe(SQL);
  });

  it('an unattended read gets every policy in the tenant, whoever it targets', async () => {
    const out = await prepareUnattendedRead(SQL, tenantId);
    expect(out.policy.policiesApplied).toBe(2);
    expect(out.sql).toContain("'***'");
  });

  it('policies belong to their tenant: another tenant sees none', async () => {
    const out = await prepareUnattendedRead(SQL, tenantId + 1);
    expect(out.policy.policiesApplied).toBe(0);
  });
});

describe('POST /api/dashboards/execute applies policies', () => {
  const exec = async (token: string) =>
    (await request())
      .post('/api/dashboards/execute')
      .set('Authorization', `Bearer ${token}`)
      .send({ connectionId, sql: SQL, filterValues: {}, dataLayer: 'source' });

  it('the viewer gets North rows only, with the IBAN masked', async () => {
    const res = await exec(viewerToken);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.region)).toEqual(['North', 'North']);
    expect(rows.every((r) => r.iban === '***')).toBe(true);
    // The unmasked value never reaches the wire.
    expect(JSON.stringify(res.body)).not.toContain('BE71');
  });

  it('the admin gets every row unmasked', async () => {
    const res = await exec(adminToken);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0].iban).toBe('BE71 0961 2345 6769');
  });
});

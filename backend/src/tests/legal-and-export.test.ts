/**
 * P0-7, engineering half — acceptance records and the tenant data export.
 *
 * The constants stay "not in force" until counsel; the tests inject the
 * in-force state through the service's test hook and pin both sides of the
 * flag: nothing asked or written while off, refusal + recorded acceptance
 * + the version-bump re-ask while on. The export is opened as a real ZIP
 * (central directory parsed here) and checked for what it must contain and
 * what it must never contain.
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { _setLegalForTests } from '../services/legal';
import { ZipStreamWriter } from '../utils/zipStream';
import { REDACTED_COLUMN_RE, EXPORT_OMITTED_TABLES } from '../services/tenantExport';

let tenantId: number;
let adminToken: string;
let adminEmail: string;
let otherEmail: string;
let otherToken: string;

beforeAll(async () => {
  await cleanTestDb();
  adminEmail = `legal-admin-${Date.now()}@test.com`;
  const t = await registerUser({ email: adminEmail, companyName: 'LegalCo', password: 'TestPassword123!' });
  tenantId = t.user.tenantId; adminToken = t.token;
  otherEmail = `other-${Date.now()}@test.com`;
  const o = await registerUser({ email: otherEmail, companyName: 'OtherCo', password: 'TestPassword123!' });
  otherToken = o.token;
});

afterAll(async () => { _setLegalForTests(null); await closeTestDb(); });
afterEach(() => { _setLegalForTests(null); });

const db = () => getTestDb();
const V1 = { terms: '1.0', privacy: '1.0', dpa: '1.0' };
const V2 = { terms: '1.1', privacy: '1.0', dpa: '1.0' };

describe('while the documents are drafts (LEGAL_IN_FORCE = false)', () => {
  it('registration asks for nothing, records nothing, and the gate is inert', async () => {
    const rows = await db()('legal_acceptances').where({ tenant_id: tenantId });
    expect(rows).toHaveLength(0);
    const agent = await request();
    const st = await agent.get('/api/legal/status').set('Authorization', `Bearer ${adminToken}`);
    expect(st.status).toBe(200);
    expect(st.body.data.inForce).toBe(false);
    expect(st.body.data.acceptanceRequired).toBe(false);
    const acc = await agent.post('/api/legal/accept').set('Authorization', `Bearer ${adminToken}`).send({ acceptTerms: true });
    expect(acc.status).toBe(409);
    expect(acc.body.code).toBe('not_in_force');
  });
});

describe('once in force', () => {
  it('refuses a registration without acceptance and creates nothing', async () => {
    _setLegalForTests({ inForce: true, versions: V1 });
    const agent = await request();
    const email = `refused-${Date.now()}@test.com`;
    const res = await agent.post('/api/auth/register').send({ companyName: 'NoTermsCo', email, password: 'TestPassword123!', displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('terms_required');
    expect(await db()('users').where({ email }).first()).toBeUndefined();
    expect(await db()('tenants').where({ name: 'NoTermsCo' }).first()).toBeUndefined();
  });

  it('records the acceptance in the same act as the registration', async () => {
    _setLegalForTests({ inForce: true, versions: V1 });
    const agent = await request();
    const email = `accepted-${Date.now()}@test.com`;
    const res = await agent.post('/api/auth/register').set('X-Forwarded-For', '198.51.100.7')
      .send({ companyName: 'TermsCo', email, password: 'TestPassword123!', displayName: 'Y', acceptTerms: true });
    expect(res.status).toBe(201);
    const user = await db()('users').where({ email }).first();
    const row = await db()('legal_acceptances').where({ user_id: user.id }).first();
    expect(row).toBeDefined();
    expect(row.tenant_id).toBe(user.tenant_id);
    expect(row.terms_version).toBe('1.0');
    expect(row.source).toBe('register');
    expect(row.ip).toBe('198.51.100.7');
    const st = await agent.get('/api/legal/status').set('Authorization', `Bearer ${res.body.data.token}`);
    expect(st.body.data.acceptanceRequired).toBe(false);
  });

  it('an existing user is asked on their next visit, once accepted the gate clears, a version bump re-asks', async () => {
    _setLegalForTests({ inForce: true, versions: V1 });
    const agent = await request();
    const st1 = await agent.get('/api/legal/status').set('Authorization', `Bearer ${adminToken}`);
    expect(st1.body.data.inForce).toBe(true);
    expect(st1.body.data.acceptanceRequired).toBe(true);
    expect(st1.body.data.accepted).toBeNull();

    // A body that mentions the field without saying true is not consent.
    const no = await agent.post('/api/legal/accept').set('Authorization', `Bearer ${adminToken}`).send({ acceptTerms: false });
    expect(no.status).toBe(400);

    const yes = await agent.post('/api/legal/accept').set('Authorization', `Bearer ${adminToken}`).send({ acceptTerms: true });
    expect(yes.status).toBe(200);
    expect(yes.body.data.acceptanceRequired).toBe(false);
    expect(yes.body.data.accepted).toEqual(V1);
    const audit = await db()('audit_events').where({ tenant_id: tenantId, action: 'legal.accept' }).first();
    expect(audit).toBeDefined();

    _setLegalForTests({ inForce: true, versions: V2 });
    const st2 = await agent.get('/api/legal/status').set('Authorization', `Bearer ${adminToken}`);
    expect(st2.body.data.acceptanceRequired).toBe(true);
    expect(st2.body.data.accepted).toEqual(V1);
    const again = await agent.post('/api/legal/accept').set('Authorization', `Bearer ${adminToken}`).send({ acceptTerms: true });
    expect(again.body.data.acceptanceRequired).toBe(false);
    const rows = await db()('legal_acceptances').where({ tenant_id: tenantId, user_id: (await db()('users').where({ email: adminEmail }).first()).id }).orderBy('id');
    expect(rows.map((r: { terms_version: string }) => r.terms_version)).toEqual(['1.0', '1.1']);
  });
});

// ── ZIP reading, enough to verify the export ──────────────────────────────
function readZip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    out.set(name, buf.subarray(dataStart, dataStart + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('the zip stream writer', () => {
  it('produces an archive a reader can open, with the right bytes per entry', async () => {
    const chunks: Buffer[] = [];
    const zip = new ZipStreamWriter({ write: (c) => { chunks.push(c); } });
    await zip.addFile('a.txt', 'hello');
    await zip.beginEntry('dir/b.json');
    await zip.write('[1,');
    await zip.write('2]');
    await zip.endEntry();
    await zip.finish();
    const files = readZip(Buffer.concat(chunks));
    expect([...files.keys()]).toEqual(['a.txt', 'dir/b.json']);
    expect(files.get('a.txt')!.toString()).toBe('hello');
    expect(files.get('dir/b.json')!.toString()).toBe('[1,2]');
  });
});

describe('the tenant data export', () => {
  it('is admin-only and audited', async () => {
    const agent = await request();
    const viewer = await createUserWithToken({ tenantId, role: 'viewer' });
    const v = await agent.get('/api/settings/export.zip').set('Authorization', `Bearer ${viewer.token}`);
    expect(v.status).toBe(403);
  });

  it('holds every table of this tenant and nothing of another, with secrets withheld and named', async () => {
    const agent = await request();
    const res = await agent.get('/api/settings/export.zip').set('Authorization', `Bearer ${adminToken}`)
      .buffer(true).parse((r, cb) => { const bufs: Buffer[] = []; r.on('data', (d: Buffer) => bufs.push(d)); r.on('end', () => cb(null, Buffer.concat(bufs))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    const files = readZip(res.body as Buffer);
    expect(files.has('README.txt')).toBe(true);
    expect(files.has('manifest.json')).toBe(true);
    expect(files.has('warehouse.json')).toBe(true);

    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.tenantId).toBe(tenantId);
    expect(manifest.tenantName).toBe('LegalCo');
    const usersEntry = manifest.tables.find((t: { table: string }) => t.table === 'users');
    expect(usersEntry.rows).toBeGreaterThanOrEqual(2); // admin + the viewer created above
    expect(usersEntry.redactedColumns).toContain('password_hash');
    for (const t of EXPORT_OMITTED_TABLES) expect(files.has(`tables/${t}.json`)).toBe(false);
    expect(manifest.omittedTables).toContain('refresh_tokens');
    // Every tenant-scoped table that is not omitted is present.
    const cols = await db().raw(`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'`);
    for (const r of cols.rows as Array<{ table_name: string }>) {
      if (EXPORT_OMITTED_TABLES.has(r.table_name)) continue;
      expect(files.has(`tables/${r.table_name}.json`)).toBe(true);
    }

    const users = JSON.parse(files.get('tables/users.json')!.toString());
    expect(users.some((u: { email: string }) => u.email === adminEmail)).toBe(true);
    expect(users.some((u: { email: string }) => u.email === otherEmail)).toBe(false);
    for (const u of users) for (const k of Object.keys(u)) expect(REDACTED_COLUMN_RE.test(k)).toBe(false);

    // The acceptance history is the customer's evidence — it travels.
    const acc = JSON.parse(files.get('tables/legal_acceptances.json')!.toString());
    expect(acc.length).toBeGreaterThanOrEqual(2);

    // The other tenant's whole export knows nothing of this one.
    const other = await agent.get('/api/settings/export.zip').set('Authorization', `Bearer ${otherToken}`)
      .buffer(true).parse((r, cb) => { const bufs: Buffer[] = []; r.on('data', (d: Buffer) => bufs.push(d)); r.on('end', () => cb(null, Buffer.concat(bufs))); });
    const otherUsers = JSON.parse(readZip(other.body as Buffer).get('tables/users.json')!.toString());
    expect(otherUsers.some((u: { email: string }) => u.email === adminEmail)).toBe(false);

    const audit = await db()('audit_events').where({ tenant_id: tenantId, action: 'tenant.export' }).first();
    expect(audit).toBeDefined();
  });
});

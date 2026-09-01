/**
 * The Build page's "Ask about your subjects" chat + the additive extend flow.
 *
 * What this guards:
 *
 *  1. **The extend guards run BEFORE the queue check** — unknown connection
 *     (404), unsynced entities (400) and a subject-name collision (409) must
 *     be caught in every environment, including ones without Redis, and must
 *     be caught BEFORE anything is enqueued. Adding a subject that collides
 *     would arm buildBusMatrix's retire-and-replace sweep against an
 *     existing product — the one thing an ADDITIVE flow must never do.
 *  2. **Role gates** — both endpoints are admin+analyst; a viewer is refused.
 *  3. **The coverage context is real catalog data** — subjects, coverage
 *     ("used by" / "not part of any subject yet") and row counts come from
 *     the database, and tenant scoping is explicit (another tenant's tables
 *     must not appear).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { buildCoverageContext } from '../services/buildChatContext';

let adminToken: string;
let tenantId: number;
let adminUserId: number;
let connectionId: number;
let otherTenantId: number;
let otherAdminUserId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'chat-admin@test.com', companyName: 'ChatCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  adminUserId = admin.user.id;

  const other = await registerUser({ email: 'chat-other@test.com', companyName: 'OtherChatCo' });
  otherTenantId = other.user.tenantId;
  otherAdminUserId = other.user.id;

  const db = getTestDb();

  const [conn] = await db('connections')
    .insert({
      tenant_id: tenantId, name: 'Exact Online', type: 'duckdb',
      connector_type: 'exactonline', config: JSON.stringify({}),
    })
    .returning('id');
  connectionId = Number((conn as { id?: number }).id ?? conn);

  const [tbl] = await db('source_tables').insert(
    { tenant_id: tenantId, connection_id: connectionId, table_name: 'SalesInvoiceLines' },
  ).returning('id');
  await db('source_tables').insert(
    { tenant_id: tenantId, connection_id: connectionId, table_name: 'Quotations' },
  );

  const [product] = await db('data_products')
    .insert({
      tenant_id: tenantId, connection_id: connectionId,
      name: 'Sales', status: 'approved', kind: 'analytics',
      description: 'Sales invoices and what you earned',
    })
    .returning('id');
  const productId = Number((product as { id?: number }).id ?? product);
  await db('data_product_sources').insert({
    tenant_id: tenantId,
    data_product_id: productId,
    source_table_id: Number((tbl as { id?: number }).id ?? tbl),
    table_name: 'SalesInvoiceLines',
  });

  // Another tenant's table with a telltale name — must never reach the
  // coverage context of the first tenant.
  const [otherConn] = await db('connections')
    .insert({ tenant_id: otherTenantId, name: 'Other EO', type: 'duckdb', config: JSON.stringify({}) })
    .returning('id');
  await db('source_tables').insert({
    tenant_id: otherTenantId,
    connection_id: Number((otherConn as { id?: number }).id ?? otherConn),
    table_name: 'OtherTenantSecretTable',
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe('buildCoverageContext', () => {
  it('states subjects and per-table coverage from real rows, tenant-scoped', async () => {
    const ctx = await buildCoverageContext(getTestDb(), tenantId);
    expect(ctx.text).toContain('Sales');
    expect(ctx.text).toContain('SalesInvoiceLines');
    expect(ctx.text).toMatch(/SalesInvoiceLines.*used by: Sales/);
    expect(ctx.text).toMatch(/Quotations.*not part of any subject yet/);
    expect(ctx.text).not.toContain('OtherTenantSecretTable');
    expect(ctx.connectionIds.has(connectionId)).toBe(true);
    expect(ctx.syncedTablesByConnection.get(connectionId)?.has('Quotations')).toBe(true);
    expect(ctx.productNamesLower.has('sales')).toBe(true);
  });
});

describe('POST /api/products/bus-matrix/extend-start', () => {
  const start = async (token: string, body: Record<string, unknown>) =>
    (await request())
      .post('/api/products/bus-matrix/extend-start')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('refuses a viewer', async () => {
    const viewer = makeToken({ sub: adminUserId, tenantId, role: 'viewer' });
    const res = await start(viewer, { connectionId, name: 'Quotations', entities: ['Quotations'] });
    expect(res.status).toBe(403);
  });

  it('404s an unknown connection before touching the queue', async () => {
    const res = await start(adminToken, { connectionId: 999999, name: 'Quotations', entities: ['Quotations'] });
    expect(res.status).toBe(404);
  });

  it("404s another tenant's connection (isolation, not 403)", async () => {
    // A REAL user of the other tenant — since P1-3, requireAuth refuses a
    // token whose (tenant, user) pair matches no row, so a mismatched
    // forgery would 401 before the route's isolation gate ever ran.
    const otherAdmin = makeToken({ sub: otherAdminUserId, tenantId: otherTenantId, role: 'admin' });
    const res = await start(otherAdmin, { connectionId, name: 'Quotations', entities: ['Quotations'] });
    expect(res.status).toBe(404);
  });

  it('400s entities that are not synced, naming them', async () => {
    const res = await start(adminToken, { connectionId, name: 'Projects', entities: ['Projects', 'Quotations'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Projects');
    expect(res.body.error).not.toContain('Quotations,');
  });

  it('409s a subject-name collision (case-insensitive) before enqueueing', async () => {
    const res = await start(adminToken, { connectionId, name: '  sAlEs ', entities: ['Quotations'] });
    expect(res.status).toBe(409);
  });

  it('validates the body shape (empty entities refused)', async () => {
    const res = await start(adminToken, { connectionId, name: 'Quotations', entities: [] });
    expect(res.status).toBe(400);
  });

  it('409s when no build exists to extend (additions build on the full build)', async () => {
    const db = getTestDb();
    const [bareConn] = await db('connections')
      .insert({ tenant_id: tenantId, name: 'Bare source', type: 'duckdb', config: JSON.stringify({}) })
      .returning('id');
    const bareConnId = Number((bareConn as { id?: number }).id ?? bareConn);
    await db('source_tables').insert({
      tenant_id: tenantId, connection_id: bareConnId, table_name: 'Quotations',
    });
    const res = await start(adminToken, { connectionId: bareConnId, name: 'Quotations', entities: ['Quotations'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Create my topics');
  });
});

describe('POST /api/products/build-chat', () => {
  it('refuses a viewer without spending an AI call', async () => {
    const viewer = makeToken({ sub: adminUserId, tenantId, role: 'viewer' });
    const res = await (await request())
      .post('/api/products/build-chat')
      .set('Authorization', `Bearer ${viewer}`)
      .send({ messages: [{ role: 'user', content: 'What is covered?' }] });
    expect(res.status).toBe(403);
  });

  it('validates the body shape', async () => {
    const res = await (await request())
      .post('/api/products/build-chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });
});

/**
 * GET /api/products/build-overview — the Build page's read model.
 *
 * What this guards, beyond "the route returns 200":
 *
 *  1. **The plan is the real template.** The page shows what a build WOULD
 *     create before it runs; that promise is only honest because it comes
 *     from instantiating the connector's actual star-schema template against
 *     the actually-synced table names. A connection with enough Exact Online
 *     entities must yield a plan with analytics topics; one with no tables
 *     must yield none.
 *  2. **No warehouse vocabulary in the payload.** The plan ships display
 *     names only — `dim_`/`fact_`/`fct_` reaching this response means a
 *     physical name would land in a business user's sentence.
 *  3. **The hidden flag round-trips**, and only `true` means hidden — the
 *     column is nullable and every pre-existing product must stay visible.
 *  4. **Tenant isolation** — sources and products are enumerable by id, and
 *     this endpoint aggregates both.
 *  5. **Role gate** — analyst allowed (the role table grants product design
 *     to analysts), viewer refused.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let otherToken: string;
let eoConnectionId: number;
let emptyConnectionId: number;
let visibleProductId: number;
let hiddenProductId: number;

// Enough of the EO catalog that the template keeps at least one fact table
// (sales invoice lines need SalesInvoiceLines + SalesInvoices) plus the
// conformed lookups. Deliberately NOT the full catalog: graceful degradation
// dropping the un-synced facts is part of what "the plan is real" means.
const EO_TABLES = [
  'Accounts', 'Items', 'ItemGroups', 'GLAccounts', 'Journals',
  'PaymentConditions', 'SalesInvoices', 'SalesInvoiceLines', 'TransactionLines',
];

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'build-admin@test.com', companyName: 'BuildCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;

  const other = await registerUser({ email: 'build-other@test.com', companyName: 'OtherBuildCo' });
  otherToken = other.token;

  const db = getTestDb();

  const [eoConn] = await db('connections')
    .insert({
      tenant_id: tenantId, name: 'Exact Online', type: 'duckdb',
      connector_type: 'exactonline', profiling_status: 'done',
      config: JSON.stringify({}),
    })
    .returning('id');
  eoConnectionId = Number((eoConn as { id?: number }).id ?? eoConn);

  const [emptyConn] = await db('connections')
    .insert({
      tenant_id: tenantId, name: 'Empty source', type: 'sqlite',
      config: JSON.stringify({ filepath: '/tmp/empty.db' }),
    })
    .returning('id');
  emptyConnectionId = Number((emptyConn as { id?: number }).id ?? emptyConn);

  await db('source_tables').insert(
    EO_TABLES.map((t) => ({ tenant_id: tenantId, connection_id: eoConnectionId, table_name: t })),
  );

  const [visible] = await db('data_products')
    .insert({
      tenant_id: tenantId, connection_id: eoConnectionId,
      name: 'Finance', status: 'approved', kind: 'analytics',
    })
    .returning('id');
  visibleProductId = Number((visible as { id?: number }).id ?? visible);

  const [hidden] = await db('data_products')
    .insert({
      tenant_id: tenantId, connection_id: eoConnectionId,
      name: 'Sales', status: 'approved', kind: 'analytics', hidden: true,
    })
    .returning('id');
  hiddenProductId = Number((hidden as { id?: number }).id ?? hidden);
});

afterAll(async () => {
  await closeTestDb();
});

interface OverviewSource {
  id: number;
  name: string;
  hasTemplate: boolean;
  tableCount: number;
  plan: { templateVersion: number; topics: Array<{ name: string; kind: string; sharedData: string[]; sampleQuestions: string[] }> } | null;
  products: Array<{ id: number; name: string; hidden: boolean; kind: string }>;
}

async function fetchOverview(token: string) {
  const res = await (await request())
    .get('/api/products/build-overview')
    .set('Authorization', `Bearer ${token}`);
  return res;
}

describe('GET /api/products/build-overview', () => {
  it('returns a real template plan for a covered source and none for an empty one', async () => {
    const res = await fetchOverview(adminToken);
    expect(res.status).toBe(200);
    const sources = res.body.data.sources as OverviewSource[];
    expect(sources).toHaveLength(2);

    const eo = sources.find((s) => s.id === eoConnectionId)!;
    expect(eo.hasTemplate).toBe(true);
    expect(eo.tableCount).toBe(EO_TABLES.length);
    const analytics = eo.plan!.topics.filter((t) => t.kind === 'analytics');
    expect(analytics.length).toBeGreaterThan(0);
    // The plan degrades to what was synced: no purchasing entities were
    // inserted, so a Purchasing topic surviving would mean the plan is a
    // hand-maintained copy rather than the instantiated template.
    expect(eo.plan!.topics.some((t) => /purchas/i.test(t.name))).toBe(false);

    const empty = sources.find((s) => s.id === emptyConnectionId)!;
    expect(empty.hasTemplate).toBe(false);
    expect(empty.plan).toBeNull();
    expect(empty.tableCount).toBe(0);
  });

  it('ships display names only — no warehouse table names anywhere in the plan', async () => {
    const res = await fetchOverview(adminToken);
    const eo = (res.body.data.sources as OverviewSource[]).find((s) => s.id === eoConnectionId)!;
    const planText = JSON.stringify(eo.plan);
    expect(planText).not.toMatch(/dim_/);
    expect(planText).not.toMatch(/fact_/);
    expect(planText).not.toMatch(/fct_/);
    // Shared lookups are humanised display names, not snake_case identifiers.
    for (const t of eo.plan!.topics) {
      for (const name of t.sharedData) expect(name).not.toMatch(/_/);
    }
  });

  it('round-trips the hidden flag and treats only true as hidden', async () => {
    const res = await fetchOverview(adminToken);
    const eo = (res.body.data.sources as OverviewSource[]).find((s) => s.id === eoConnectionId)!;
    const byId = new Map(eo.products.map((p) => [p.id, p]));
    expect(byId.get(visibleProductId)!.hidden).toBe(false); // column is NULL
    expect(byId.get(hiddenProductId)!.hidden).toBe(true);
  });

  it('lets an analyst toggle visibility through PUT /products/:id', async () => {
    const analystToken = makeToken({ tenantId, role: 'analyst', email: 'build-analyst@test.com' });
    const put = await (await request())
      .put(`/api/products/${visibleProductId}`)
      .set('Authorization', `Bearer ${analystToken}`)
      .send({ hidden: true });
    expect(put.status).toBe(200);

    const res = await fetchOverview(adminToken);
    const eo = (res.body.data.sources as OverviewSource[]).find((s) => s.id === eoConnectionId)!;
    expect(eo.products.find((p) => p.id === visibleProductId)!.hidden).toBe(true);

    // Put it back — later assertions in this file must not depend on order.
    await (await request())
      .put(`/api/products/${visibleProductId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hidden: false });
  });

  it('is tenant-isolated', async () => {
    const res = await fetchOverview(otherToken);
    expect(res.status).toBe(200);
    expect(res.body.data.sources).toHaveLength(0);
    expect(res.body.data.unassignedProducts).toHaveLength(0);
  });

  it('refuses viewers', async () => {
    const viewerToken = makeToken({ tenantId, role: 'viewer', email: 'build-viewer@test.com' });
    const res = await fetchOverview(viewerToken);
    expect(res.status).toBe(403);
  });
});

/**
 * GET /api/products/:id/topic — the topic page's single read model.
 *
 * What this actually guards, beyond "the route returns 200":
 *
 *  1. **Tenant isolation.** The topic page is the front door, reachable by a
 *     viewer with nothing but a product id — and ids come from a shared
 *     sequence, so they are trivially enumerable. A cross-tenant read here
 *     would hand over another company's subject areas and metric names.
 *  2. **The break-down line never leaks a physical name.** It is rendered
 *     verbatim into a sentence a business user reads, so a `dim_gl_account`
 *     slipping through is a visible product defect, not a cosmetic one.
 *  3. **The measure/lookup split.** "3 tables · 5 shared lookups" is wrong in
 *     an obvious way if dimensions are counted as the topic's own tables.
 *  4. **pendingChanges counts real divergence.** Whitespace-only differences
 *     between a deploy cell and the deployed SQL must NOT read as "2 changes
 *     not deployed" — a permanent false badge trains people to ignore it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let otherToken: string;
let productId: number;
let factTableId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'topic-admin@test.com', companyName: 'TopicCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;

  const other = await registerUser({ email: 'topic-other@test.com', companyName: 'OtherCo' });
  otherToken = other.token;

  const db = getTestDb();

  const [product] = await db('data_products')
    .insert({
      tenant_id: tenantId,
      connection_id: null,
      name: 'Finance',
      description: 'General ledger, receivables and payables.',
      status: 'approved',
      kind: 'analytics',
    })
    .returning('id');
  productId = typeof product === 'object' ? (product as { id: number }).id : (product as number);

  const [schema] = await db('star_schemas')
    .insert({
      tenant_id: tenantId,
      data_product_id: productId,
      name: 'finance_star',
      description: null,
      grain: null,
      fact_table_type: 'transaction',
    })
    .returning('id');
  const schemaId = typeof schema === 'object' ? (schema as { id: number }).id : (schema as number);

  // One measure table + three lookups. `dim_gl_account` has NO display_name
  // on purpose: it is the case where the label has to be humanised rather
  // than passed through.
  const rows = await db('product_tables')
    .insert([
      {
        tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fct_gl_transactions',
        display_name: 'GL transactions', description: 'One row per general-ledger line',
        table_role: 'fact', dag_order: 1, transformation_status: 'success',
        transformation_sql: 'select * from exactonline.transaction_lines',
        last_run_at: new Date().toISOString(), row_count: 4812,
      },
      {
        tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_accounts',
        display_name: 'Accounts', table_role: 'dimension', dag_order: 0,
        transformation_status: 'success', row_count: 23,
      },
      {
        tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_gl_account',
        display_name: null, table_role: 'dimension', dag_order: 0,
        transformation_status: 'success', row_count: 370,
      },
      {
        tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_date',
        display_name: 'Date', table_role: 'dimension', dag_order: 0,
        transformation_status: 'success', row_count: 5114,
      },
    ])
    .returning(['id', 'table_name']);
  factTableId = (rows as Array<{ id: number; table_name: string }>)
    .find((r) => r.table_name === 'fct_gl_transactions')!.id;

  await db('product_kpis').insert([
    {
      tenant_id: tenantId, data_product_id: productId,
      name: 'Outstanding receivables', description: 'Invoiced but unpaid',
      question_text: 'Who owes me money right now?', ai_draft: false,
    },
    // No question_text — the fallback must produce the KPI name, not null.
    {
      tenant_id: tenantId, data_product_id: productId,
      name: 'Invoiced sales revenue', description: null, ai_draft: false,
    },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/products/:id/topic', () => {
  it('returns the topic read model', async () => {
    const res = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe('Finance');
    expect(res.body.data.kind).toBe('analytics');
  });

  it('counts measures and shared lookups separately', async () => {
    const res = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.data.counts.tables).toBe(1);
    expect(res.body.data.counts.sharedLookups).toBe(3);
    expect(res.body.data.counts.metrics).toBe(2);
  });

  it('humanises lens labels and sorts date last', async () => {
    const res = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${adminToken}`);

    const dims = res.body.data.dimensions as string[];
    // No physical name may reach the break-down sentence.
    for (const d of dims) {
      expect(d).not.toMatch(/^dim[_-]/i);
      expect(d).not.toContain('_');
    }
    expect(dims).toContain('Accounts');
    expect(dims).toContain('GL account');
    expect(dims[dims.length - 1]).toBe('Date');
  });

  it('falls back to the KPI name when no question phrasing is stored', async () => {
    const res = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${adminToken}`);

    const questions = res.body.data.questions as Array<{ text: string; derived: boolean }>;
    const stored = questions.find((q) => q.text === 'Who owes me money right now?');
    const fallback = questions.find((q) => q.text === 'Invoiced sales revenue');
    expect(stored?.derived).toBe(false);
    expect(fallback?.derived).toBe(true);
  });

  it('does not count a whitespace-only difference as an undeployed change', async () => {
    const db = getTestDb();
    await db('product_table_cells').insert({
      tenant_id: tenantId,
      product_table_id: factTableId,
      cell_type: 'sql',
      // Same statement, reformatted. Reformatting is not a change a user made.
      source: 'select *\n  from exactonline.transaction_lines',
      position: 0,
      is_deploy_cell: true,
    });

    const res = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.data.pendingChanges).toBe(0);

    await db('product_table_cells')
      .where({ product_table_id: factTableId })
      .update({ source: 'select * from exactonline.transaction_lines where deleted is null' });

    const res2 = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res2.body.data.pendingChanges).toBe(1);
  });

  it('refuses another tenant with 404, not 403', async () => {
    const res = await (await request())
      .get(`/api/products/${productId}/topic`)
      .set('Authorization', `Bearer ${otherToken}`);

    // 404, never 403 — a 403 confirms the id exists and belongs to someone else.
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await (await request()).get(`/api/products/${productId}/topic`);
    expect(res.status).toBe(401);
  });
});

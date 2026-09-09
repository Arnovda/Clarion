/**
 * Phase 0 of the ingestion-chain assessment (docs/backlog/ingestion-chain-
 * assessment.md §7): the defects that were broken TODAY, none of them
 * architecture. Each test here was red against the pre-fix code, and each
 * pins the mechanism rather than the wording, so a later "simplification"
 * that reintroduces one goes red.
 *
 *  1. Scheduled transformations always failed — the worker filtered
 *     `product_tables` on a `product_id` column that has never existed.
 *  2. Quality checks never blocked — a duplicate-grain fact published.
 *  3. The pipeline runner built facts on top of a failed source sync.
 *  4. A source sync invalidated nothing (pinned at source level: the sync
 *     worker cannot run here, and what matters is that the call is wired).
 *  5. PATCH /semantic/product-tables|columns wrote only the graph while the
 *     AI context reads Postgres.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { registerUser, request } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { loadTransformableTables } from '../services/transformationRunner';
import { blockingCheckFailure, type CheckResult } from '../services/transformationChecks';
import { sourceIdsByProduct, upstreamProductsWithin } from '../services/pipelineService';

// The product-layer PATCH routes write Neo4j first; there is no graph here,
// and the graph half is pinned in semanticGraph.tenant.test.ts. What this
// file asserts is the Postgres half those routes never had.
const graphCalls: string[] = [];
vi.mock('../db/semanticGraph', async (orig) => ({
  ...(await orig<typeof import('../db/semanticGraph')>()),
  updateProductTable: vi.fn(async () => { graphCalls.push('table'); }),
  updateProductColumn: vi.fn(async () => { graphCalls.push('column'); }),
}));

const db = getTestDb();
const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

let token: string;
let tenantId: number;
let connA: number;
let connB: number;
let dimProduct: number;   // reads source A, owns dim_customer
let factProduct: number;  // reads source A, depends on dimProduct
let otherProduct: number; // reads source B only
let dimTableId: number;
let dimColumnId: number;

async function id(row: unknown): Promise<number> {
  return Number((row as { id?: number }).id ?? row);
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'phase0@test.com', companyName: 'Phase0Co' });
  token = admin.token;
  tenantId = admin.user.tenantId;

  connA = await id((await db('connections').insert({
    tenant_id: tenantId, name: 'Source A', type: 'duckdb', connector_type: 'exactonline', config: '{}',
  }).returning('id'))[0]);
  connB = await id((await db('connections').insert({
    tenant_id: tenantId, name: 'Source B', type: 'duckdb', connector_type: 'odoo', config: '{}',
  }).returning('id'))[0]);

  const [stA] = await db('source_tables').insert({ tenant_id: tenantId, connection_id: connA, table_name: 'customers' }).returning('id');
  const [stB] = await db('source_tables').insert({ tenant_id: tenantId, connection_id: connB, table_name: 'partners' }).returning('id');

  dimProduct = await id((await db('data_products').insert({
    tenant_id: tenantId, connection_id: connA, name: 'Reference', status: 'approved', kind: 'reference',
  }).returning('id'))[0]);
  factProduct = await id((await db('data_products').insert({
    tenant_id: tenantId, connection_id: connA, name: 'Sales', status: 'approved', kind: 'analytics',
  }).returning('id'))[0]);
  otherProduct = await id((await db('data_products').insert({
    tenant_id: tenantId, connection_id: connB, name: 'Purchasing', status: 'approved', kind: 'analytics',
  }).returning('id'))[0]);

  await db('data_product_sources').insert([
    { tenant_id: tenantId, data_product_id: dimProduct, source_table_id: await id(stA), table_name: 'customers' },
    { tenant_id: tenantId, data_product_id: factProduct, source_table_id: await id(stA), table_name: 'customers' },
    { tenant_id: tenantId, data_product_id: otherProduct, source_table_id: await id(stB), table_name: 'partners' },
  ]);
  await db('data_product_dependencies').insert({
    tenant_id: tenantId, dependent_product_id: factProduct, source_product_id: dimProduct,
  });

  // One star schema with a dim, a fact and a stub (shared dim from elsewhere).
  const schemaId = await id((await db('star_schemas').insert({
    tenant_id: tenantId, data_product_id: dimProduct, name: 'Reference star',
  }).returning('id'))[0]);
  const rows = await db('product_tables').insert([
    { tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_customer', table_role: 'dimension', transformation_sql: 'SELECT 1', dag_order: 0, display_name: 'Customer', description: 'One row per customer' },
    { tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fact_sales', table_role: 'fact', transformation_sql: 'SELECT 1', dag_order: 1 },
    { tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_date', table_role: 'dimension', transformation_sql: null, dag_order: 0, is_shared_dimension: true },
    { tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_orphan', table_role: 'dimension', transformation_sql: null, dag_order: 0 },
  ]).returning(['id', 'table_name']);
  dimTableId = Number((rows as Array<{ id: number; table_name: string }>).find((r) => r.table_name === 'dim_customer')!.id);
  dimColumnId = await id((await db('product_columns').insert({
    tenant_id: tenantId, product_table_id: dimTableId, column_name: 'customer_name', data_type: 'VARCHAR',
    display_name: 'Customer', description: 'Legal name', column_role: 'attribute',
  }).returning('id'))[0]);
});

afterAll(async () => { await closeTestDb(); });

describe('1. scheduled transformations load their tables through the star schema', () => {
  it('resolves a product to its runnable tables via star_schema_id, in DAG order, stubs included', async () => {
    const tables = await loadTransformableTables(tenantId, dimProduct);
    const names = tables.map((t) => t.table_name);
    // dims first, fact last
    expect(names.indexOf('fact_sales')).toBe(names.length - 1);
    expect(names).toContain('dim_customer');
    expect(names).toContain('dim_date');    // stub: no SQL but is_shared_dimension
    expect(names).not.toContain('dim_orphan'); // no SQL and not a stub → nothing to run
  });

  it('a product with no star schema runs nothing rather than failing', async () => {
    expect(await loadTransformableTables(tenantId, otherProduct)).toEqual([]);
  });

  it('the column that does not exist is gone from every loader', () => {
    // The defect was `where({ product_id: productId })` on product_tables.
    // Every path that feeds runProductTransformation goes through the one
    // shared loader now; a fresh copy of the old filter is what this stops.
    for (const f of ['jobs/workers.ts', 'routes/schedules.ts', 'services/busMatrixOrchestrator.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/product_tables'\)\s*\.where\(\{\s*product_id/);
      expect(src, f).toContain('loadTransformableTables');
    }
  });
});

describe('2. a failed grain check blocks publication', () => {
  const base = (over: Partial<CheckResult>): CheckResult => ({
    check_type: 'bk_uniqueness', status: 'pass', bk_columns: ['customer_key', 'invoice_no'],
    total_rows: 100, distinct_bk_rows: 100, duplicate_count: 0, sample_duplicates: [], message: '',
    ...over,
  });

  it('duplicate business keys refuse, and the sentence names the grain', () => {
    const msg = blockingCheckFailure([base({ status: 'fail', duplicate_count: 7, distinct_bk_rows: 93 })]);
    expect(msg).toMatch(/Refusing to publish/);
    expect(msg).toContain('7 duplicate');
    expect(msg).toContain('customer_key, invoice_no');
    expect(msg).toContain('previously published version is untouched');
  });

  it('data-quality findings warn but do not refuse', () => {
    expect(blockingCheckFailure([
      base({ check_type: 'ref_integrity', status: 'fail' }),
      base({ check_type: 'value_range', status: 'fail' }),
    ])).toBeNull();
  });

  it('a check that could not RUN is not a failed check', () => {
    expect(blockingCheckFailure([base({ status: 'error', message: 'BK check error: boom' })])).toBeNull();
    expect(blockingCheckFailure([])).toBeNull();
    expect(blockingCheckFailure([base({ status: 'skip' })])).toBeNull();
  });

  it('the runner throws on the blocker BEFORE any write', () => {
    const src = read('services/transformationRunner.ts');
    const block = src.indexOf('blockingCheckFailure(checkResults)');
    const write = src.indexOf('writeDeltaWithSidecar({');
    expect(block).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(block);
    expect(src).toContain('throw new Error(blocker)');
  });
});

describe('3. the pipeline runner refuses to build on a failed source', () => {
  it('maps every product to the sources it actually reads', async () => {
    const m = await sourceIdsByProduct([dimProduct, factProduct, otherProduct], tenantId);
    expect(m.get(dimProduct)).toEqual([connA]);
    expect(m.get(factProduct)).toEqual([connA]);
    expect(m.get(otherProduct)).toEqual([connB]);
  });

  it('knows which products in a run build on which others', async () => {
    const up = await upstreamProductsWithin([dimProduct, factProduct, otherProduct], tenantId);
    expect(up.get(factProduct)).toEqual([dimProduct]);
    expect(up.has(dimProduct)).toBe(false);
    expect(up.has(otherProduct)).toBe(false);
  });

  it('an upstream outside the run does not count', async () => {
    const up = await upstreamProductsWithin([factProduct], tenantId);
    expect(up.has(factProduct)).toBe(false);
  });

  it('the gate is wired ahead of runProductTransformation and propagates one hop', () => {
    const src = read('services/busMatrixOrchestrator.ts');
    const gate = src.indexOf('failedSourceIds.has(sid)');
    const propagate = src.indexOf('skippedProducts.has(up)');
    const run = src.indexOf('runProductTransformation(product, tables, tenantId)', gate);
    expect(gate).toBeGreaterThan(0);
    expect(propagate).toBeGreaterThan(gate);
    expect(run).toBeGreaterThan(propagate);
    expect(src).toContain("status: 'skipped'");
  });
});

describe('4. a source sync makes its rows visible', () => {
  it('SyncOrchestrator invalidates the source warehouse pool and broadcasts it', () => {
    const src = read('orchestrator/SyncOrchestrator.ts');
    expect(src).toContain('DuckDBConnector.invalidateWarehouse(duckdbReadPath)');
    expect(src).toContain('publishInvalidation({ warehousePath: duckdbReadPath })');
    // The broadcast must NOT carry a tenantId: the subscriber treats one as
    // "drop the widget + filter caches", which hold product-layer rows a
    // source sync does not change.
    expect(src).not.toMatch(/publishInvalidation\(\{\s*tenantId/);
  });
});

describe('5. product-layer edits reach Postgres, where the AI reads them', () => {
  it('PATCH /semantic/product-columns/:id mirrors display name, description and role', async () => {
    graphCalls.length = 0;
    const res = await (await request())
      .patch(`/api/semantic/product-columns/${dimColumnId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ display_name: 'Customer name', description: 'The legal name on the invoice', column_role: 'attribute', owner_name: 'Finance' });
    expect(res.status).toBe(200);
    expect(graphCalls).toEqual(['column']);
    const row = await db('product_columns').where({ id: dimColumnId }).first();
    expect(row.display_name).toBe('Customer name');
    expect(row.description).toBe('The legal name on the invoice');
    expect(row.column_role).toBe('attribute');
    expect(row.ai_draft).toBe(false);
  });

  it('PATCH /semantic/product-tables/:id mirrors what product_tables can hold', async () => {
    const res = await (await request())
      .patch(`/api/semantic/product-tables/${dimTableId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'One row per customer we invoice', domains: ['finance'] });
    expect(res.status).toBe(200);
    const row = await db('product_tables').where({ id: dimTableId }).first();
    expect(row.description).toBe('One row per customer we invoice');
    expect(row.display_name).toBe('Customer'); // untouched — not in the patch
    expect(row.ai_draft).toBe(false);
  });

  it('accepts the graph-minted id too', async () => {
    await db('product_columns').where({ id: dimColumnId }).update({ neo4j_pg_id: 987654 });
    const res = await (await request())
      .patch('/api/semantic/product-columns/987654')
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Reached through the graph id' });
    expect(res.status).toBe(200);
    const row = await db('product_columns').where({ id: dimColumnId }).first();
    expect(row.description).toBe('Reached through the graph id');
  });

  it('another tenant cannot edit it (404, never 403)', async () => {
    const mallory = await registerUser({ email: 'mallory-phase0@test.com', companyName: 'MalloryCo' });
    const res = await (await request())
      .patch(`/api/semantic/product-columns/${dimColumnId}`)
      .set('Authorization', `Bearer ${mallory.token}`)
      .send({ description: 'stolen' });
    expect(res.status).toBe(404);
    const row = await db('product_columns').where({ id: dimColumnId }).first();
    expect(row.description).toBe('Reached through the graph id');
  });
});

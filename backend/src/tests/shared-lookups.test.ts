/**
 * SHARED LOOKUPS — a copy is a pointer to its original, never a table of its
 * own (2026-09-24, from the owner's screenshots: Journal had data and SQL
 * under Reference, and neither under Purchasing).
 *
 * The defect underneath: a copy row (`is_shared_dimension`) was supposed to
 * point at its original through `source_product_table_id`, four readers were
 * built on that pointer, and nothing ever wrote it. Pinned here, both halves:
 *
 *   - the pointer is WRITTEN (linkSharedTables — the builder's call and the
 *     backfill rule), idempotently, and only within the tenant;
 *   - every reader goes THROUGH it: the catalog resolves a copy to the
 *     original's data, the declaration says "built once in Reference" and
 *     refuses SQL on a copy (even one nothing could link), definition edits
 *     on a copy are refused, the catalog counts and search show each table
 *     once, Ask AI's context describes a lookup once with the ORIGINAL's
 *     columns, and sample rows come from the original without the technical
 *     columns.
 *
 * Real Postgres, real DuckDB, real Parquet. Nothing mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'duckdb-async';

process.env.STORAGE_FORMAT = 'parquet';

import { request, registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { linkSharedTables } from '../services/sharedTables';
import { resolveProductTableById, listProductTablesForScope } from '../services/tableCatalog';
import { buildProductSemanticContext } from '../services/productContext';
import { scopeOf } from '../services/queryScope';

const warehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-shared-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminToken: string;
let tenantId: number;
let connectionId: number;
let referenceId: number;
let purchasingId: number;
let originalId: number;
let copyId: number;
let copyColumnId: number;
let orphanCopyId: number;
let factId: number;
let otherTenantCopyId: number;

const originalDir = path.join(warehouse, 'product', 'dim_journal');

async function writeParquet(dir: string, selectSql: string) {
  fs.mkdirSync(dir, { recursive: true });
  const db = await Database.create(':memory:');
  try {
    const out = path.join(dir, 'data.parquet').replace(/'/g, "''");
    await db.exec(`COPY (${selectSql}) TO '${out}' (FORMAT PARQUET)`);
  } finally {
    await db.close();
  }
}

async function subject(db: ReturnType<typeof getTestDb>, tid: number, connId: number, name: string, kind: string) {
  const [p] = await db('data_products').insert({
    tenant_id: tid, connection_id: connId, name, status: 'approved', kind,
  }).returning('id');
  const [s] = await db('star_schemas').insert({
    tenant_id: tid, data_product_id: idOf(p), name, grain: kind === 'reference' ? 'Conformed dimensions' : 'one row per purchase line',
  }).returning('id');
  return { productId: idOf(p), schemaId: idOf(s) };
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@shared.test', companyName: 'Shared BV' });
  adminToken = admin.token; tenantId = admin.user.tenantId;

  // The original's data: a business column, a join key the table marks
  // technical, and the storage machinery every user-facing read hides.
  await writeParquet(originalDir, `
    SELECT * FROM (VALUES
      (1, '830', 'Lettrage', 'h1'),
      (2, '570', 'Kas',      'h2'),
      (3, '700', 'Verkopen', 'h3')
    ) AS t(journal_key, code, description, _row_hash)`);

  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Exact (shared)', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Journals'], warehouse_path: warehouse, query_engine: 'duckdb',
    last_sync_status: 'succeeded', config: JSON.stringify({}),
  }).returning('id');
  connectionId = idOf(conn);

  // Reference BUILDS the Journal lookup.
  const ref = await subject(db, tenantId, connectionId, 'Reference', 'reference');
  referenceId = ref.productId;
  const [orig] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: ref.schemaId, table_name: 'dim_journal', display_name: 'Journal',
    description: 'Every journal a booking can land in', table_role: 'dimension', dag_order: 0,
    is_shared_dimension: false, transformation_sql: 'SELECT 1', transformation_status: 'success',
    delta_path: originalDir, row_count: 3, last_run_at: new Date().toISOString(),
  }).returning('id');
  originalId = idOf(orig);
  await db('product_columns').insert([
    { tenant_id: tenantId, product_table_id: originalId, column_name: 'journal_key', data_type: 'INTEGER', column_role: 'surrogate_key', is_technical: true, sort_order: 0 },
    { tenant_id: tenantId, product_table_id: originalId, column_name: 'code', display_name: 'Journal code', data_type: 'VARCHAR', column_role: 'attribute', description: 'The code accountants use', sort_order: 1 },
    { tenant_id: tenantId, product_table_id: originalId, column_name: 'description', display_name: 'Journal name', data_type: 'VARCHAR', column_role: 'attribute', sort_order: 2 },
  ]);

  // Purchasing BUILDS one measures table and USES the Journal — a copy row
  // exactly as the builder writes it: no SQL, no data, no pointer.
  const pur = await subject(db, tenantId, connectionId, 'Purchasing', 'analytics');
  purchasingId = pur.productId;
  const [fact] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: pur.schemaId, table_name: 'fact_purchase_entry_lines', display_name: 'Purchase Entry Lines',
    table_role: 'fact', dag_order: 1, is_shared_dimension: false, transformation_sql: 'SELECT 1',
    transformation_status: 'success', delta_path: path.join(warehouse, 'product', 'fact_purchase_entry_lines'), row_count: 247,
  }).returning('id');
  factId = idOf(fact);
  const [copy] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: pur.schemaId, table_name: 'dim_journal', display_name: 'Journal',
    table_role: 'dimension', dag_order: 0, is_shared_dimension: true, transformation_sql: null,
    transformation_status: 'draft',
  }).returning('id');
  copyId = idOf(copy);
  // The copy's own columns — copied once, and here deliberately STALE: an
  // edit made on the original never reached them.
  const [copyCol] = await db('product_columns').insert({
    tenant_id: tenantId, product_table_id: copyId, column_name: 'code', data_type: 'VARCHAR',
    column_role: 'attribute', description: 'STALE copy text', sort_order: 1,
  }).returning('id');
  copyColumnId = idOf(copyCol);

  // A copy of a lookup nobody built — nothing to link it to.
  const [orphan] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: pur.schemaId, table_name: 'dim_cost_centre', display_name: 'Cost centre',
    table_role: 'dimension', dag_order: 0, is_shared_dimension: true, transformation_status: 'draft',
  }).returning('id');
  orphanCopyId = idOf(orphan);

  // Another tenant with the SAME names — must never be linked across.
  const other = await registerUser({ email: 'other@shared.test', companyName: 'Other BV' });
  const otherTenant = other.user.tenantId;
  const [oconn] = await db('connections').insert({
    tenant_id: otherTenant, name: 'Exact (other)', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: [], warehouse_path: warehouse, query_engine: 'duckdb', config: JSON.stringify({}),
  }).returning('id');
  const oref = await subject(db, otherTenant, idOf(oconn), 'Reference', 'reference');
  await db('product_tables').insert({
    tenant_id: otherTenant, star_schema_id: oref.schemaId, table_name: 'dim_journal', table_role: 'dimension',
    dag_order: 0, is_shared_dimension: false, transformation_sql: 'SELECT 1', transformation_status: 'success', delta_path: '/elsewhere',
  });
  const opur = await subject(db, otherTenant, idOf(oconn), 'Purchasing', 'analytics');
  const [ocopy] = await db('product_tables').insert({
    tenant_id: otherTenant, star_schema_id: opur.schemaId, table_name: 'dim_journal', table_role: 'dimension',
    dag_order: 0, is_shared_dimension: true, transformation_status: 'draft',
  }).returning('id');
  otherTenantCopyId = idOf(ocopy);
}, 60_000);

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(warehouse, { recursive: true, force: true });
});

describe('the pointer is written', () => {
  it('links a copy to its original, only within the tenant, and only once', async () => {
    const db = getTestDb();
    const linked = await linkSharedTables(db, tenantId, connectionId);
    expect(linked).toBe(1); // the Journal copy; the orphan has no original

    const copy = await db('product_tables').where({ id: copyId }).first();
    expect(Number(copy.source_product_table_id)).toBe(originalId);
    const orphan = await db('product_tables').where({ id: orphanCopyId }).first();
    expect(orphan.source_product_table_id).toBeNull();
    const original = await db('product_tables').where({ id: originalId }).first();
    expect(original.source_product_table_id).toBeNull();

    // The other tenant's copy is untouched by this tenant's call...
    const otherCopy = await db('product_tables').where({ id: otherTenantCopyId }).first();
    expect(otherCopy.source_product_table_id).toBeNull();

    // ...and running again changes nothing.
    expect(await linkSharedTables(db, tenantId, connectionId)).toBe(0);
  });
});

describe('the backfill (migration 102)', () => {
  it('links existing copies in every tenant, each to its own tenant\u2019s original', async () => {
    const db = getTestDb();
    const { up } = await import('../db/migrations/20260924000102_link_shared_tables');
    // The other tenant's copy was never linked (the helper above is
    // tenant-scoped); the migration runs across all tenants.
    await up(db);
    const otherCopy = await db('product_tables').where({ id: otherTenantCopyId }).first();
    expect(otherCopy.source_product_table_id).not.toBeNull();
    const target = await db('product_tables').where({ id: otherCopy.source_product_table_id }).first();
    expect(target.tenant_id).toBe(otherCopy.tenant_id);
    expect(target.delta_path).toBe('/elsewhere');
    // Our copy keeps its original; the orphan stays unlinked.
    expect(Number((await db('product_tables').where({ id: copyId }).first()).source_product_table_id)).toBe(originalId);
    expect((await db('product_tables').where({ id: orphanCopyId }).first()).source_product_table_id).toBeNull();
  });
});

describe('readers go through the pointer', () => {
  it('the catalog resolves a copy to the original’s data', async () => {
    const resolved = await resolveProductTableById(tenantId, copyId);
    expect(resolved).not.toBeNull();
    expect(resolved!.uri).toBe(originalDir);
    expect(resolved!.rowCount).toBe(3);

    // In a session listing, the copy and its original agree by location —
    // which is what keeps the bare name `dim_journal` registered.
    const listed = await listProductTablesForScope({ tenantId, connectionIds: [connectionId] });
    const journals = listed.filter((t) => t.tableName === 'dim_journal');
    expect(journals.length).toBe(2);
    expect(new Set(journals.map((t) => t.uri))).toEqual(new Set([originalDir]));
  });

  it('the declaration says where the copy is built, and refuses SQL on it', async () => {
    const r = await request();
    const decl = await r.get(`/api/products/tables/${copyId}/declaration`).set(auth(adminToken));
    expect(decl.status).toBe(200);
    expect(decl.body.data.is_copy).toBe(true);
    expect(decl.body.data.shared_from).toMatchObject({ tableId: originalId, productId: referenceId, productName: 'Reference' });

    const put = await r.put(`/api/products/tables/${copyId}/sql`).set(auth(adminToken)).send({ sql: 'SELECT 1 AS x' });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain('shared from Reference');

    // A copy nothing could link is still a copy: a SQL saved there would be
    // stored and never built (the runner skips copies).
    const orphanPut = await r.put(`/api/products/tables/${orphanCopyId}/sql`).set(auth(adminToken)).send({ sql: 'SELECT 1 AS x' });
    expect(orphanPut.status).toBe(400);
    expect(orphanPut.body.error).toContain('shared from another subject');
    const orphan = await getTestDb()('product_tables').where({ id: orphanCopyId }).first();
    expect(orphan.transformation_sql).toBeNull();
  });

  it('refuses definition edits on a copy, so one definition cannot fork', async () => {
    const r = await request();
    const col = await r.patch(`/api/semantic/product-columns/${copyColumnId}`).set(auth(adminToken)).send({ description: 'edited on the copy' });
    expect(col.status).toBe(400);
    expect(col.body.error).toContain('shared from Reference');
    const tbl = await r.patch(`/api/products/tables/${copyId}`).set(auth(adminToken)).send({ description: 'edited on the copy' });
    expect(tbl.status).toBe(400);
    const row = await getTestDb()('product_columns').where({ id: copyColumnId }).first();
    expect(row.description).toBe('STALE copy text');
  });

  it('the subject payload marks the copy and names its original', async () => {
    const r = await request();
    const res = await r.get(`/api/products/${purchasingId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const tables = (res.body.data.star_schemas as Array<{ tables: Array<Record<string, unknown>> }>).flatMap((s) => s.tables);
    const copy = tables.find((t) => Number(t.id) === copyId)!;
    expect(copy.is_reference).toBe(true);
    expect(Number(copy.owner_table_id)).toBe(originalId);
    expect(copy.owner_product_name).toBe('Reference');
    expect(Number(copy.row_count)).toBe(3);
    const orphan = tables.find((t) => Number(t.id) === orphanCopyId)!;
    expect(orphan.is_reference).toBe(true);
    const fact = tables.find((t) => Number(t.id) === factId)!;
    expect(fact.is_reference).toBeFalsy();
  });
});

describe('each table appears once', () => {
  it('a subject counts the tables it builds, not the lookups it uses', async () => {
    const r = await request();
    const res = await r.get('/api/catalog/products').set(auth(adminToken));
    expect(res.status).toBe(200);
    const bySubject = new Map((res.body.data as Array<{ label: string; tableCount: number; meta: { sharedTableCount: number } }>)
      .map((s) => [s.label, s]));
    expect(bySubject.get('Purchasing')!.tableCount).toBe(1);
    expect(bySubject.get('Purchasing')!.meta.sharedTableCount).toBe(2);
    expect(bySubject.get('Reference')!.tableCount).toBe(1);
    expect(bySubject.get('Reference')!.meta.sharedTableCount).toBe(0);
  });

  it('search finds the original, never the copy', async () => {
    const r = await request();
    const res = await r.get('/api/catalog/search?q=journal').set(auth(adminToken));
    expect(res.status).toBe(200);
    const tableHits = (res.body.data as Array<{ kind: string; tableId: string; schemaLabel: string }>).filter((h) => h.kind === 'table');
    expect(tableHits.map((h) => Number(h.tableId))).toEqual([originalId]);
    expect(tableHits[0].schemaLabel).toBe('Reference');
  });

  it('Ask AI’s context describes a lookup once, with the original’s columns', async () => {
    // The copy as the runner leaves it after a refresh: marked success.
    const db = getTestDb();
    await db('product_tables').where({ id: copyId }).update({ transformation_status: 'success' });
    try {
      const ctx = await buildProductSemanticContext(scopeOf(tenantId, connectionId), db);
      const text = ctx!.semanticContext;
      expect(text.match(/Table dim_journal /g)?.length).toBe(1);
      expect(text).toContain('The code accountants use');
      expect(text).not.toContain('STALE copy text');
      expect(text).not.toContain('one row per purchase line) — Every journal');

      // Scoped to Purchasing alone, the copy still reads as its original.
      const scoped = await buildProductSemanticContext(scopeOf(tenantId, connectionId, [purchasingId]), db);
      expect(scoped!.semanticContext).toContain('The code accountants use');
      expect(scoped!.semanticContext).not.toContain('STALE copy text');
    } finally {
      await db('product_tables').where({ id: copyId }).update({ transformation_status: 'draft' });
    }
  });
});

describe('sample rows', () => {
  it('come from the original, without technical columns, under business names', async () => {
    const r = await request();
    const res = await r.get(`/api/semantic/product-preview?productTableId=${copyId}&limit=5`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBe(3);
    expect(res.body.data.columns).toEqual(['code', 'description']);
    expect(res.body.data.labels).toMatchObject({ code: 'Journal code', description: 'Journal name' });
  });
});

describe('the builder links what it writes', () => {
  it('points every copy — the shared lookup and the Date — at the original the same build made', async () => {
    const { buildBusMatrix } = await import('../services/busMatrixBuilder');
    const db = getTestDb();
    const [conn] = await db('connections').insert({
      tenant_id: tenantId, name: 'ERP (builder)', type: 'duckdb', connector_type: 'odoo', config: JSON.stringify({}),
    }).returning('id');
    const builderConn = idOf(conn);

    const matrix = {
      rationale: 'test',
      dim_date_range: { start: '2024-01-01', end: '2024-12-31' },
      conformed_dimensions: [{
        table_name: 'dim_customer', display_name: 'Customer', description: 'One row per customer',
        transformation_sql: 'SELECT id AS customer_key, name AS customer_name FROM customers',
        source_tables: ['customers'],
        columns: [
          { column_name: 'customer_key', data_type: 'INTEGER', display_name: 'Customer key', description: 'Key', column_role: 'surrogate_key', transformation_expression: 'id' },
          { column_name: 'customer_name', data_type: 'VARCHAR', display_name: 'Customer', description: 'Name', column_role: 'attribute', transformation_expression: 'name' },
        ],
      }],
      fact_tables: [{
        table_name: 'fact_sales', display_name: 'Sales', description: 'One row per invoice line', grain: 'One row per invoice line',
        fact_table_type: 'transaction',
        transformation_sql: 'SELECT s.customer_id AS customer_key, s.amount FROM sales s',
        source_tables: ['sales'], dimensions_used: ['dim_customer', 'dim_date'],
        columns: [
          { column_name: 'customer_key', data_type: 'INTEGER', display_name: 'Customer key', description: 'FK', column_role: 'foreign_key', transformation_expression: 's.customer_id', fk_target_table: 'dim_customer', fk_target_column: 'customer_key' },
          { column_name: 'amount', data_type: 'DECIMAL', display_name: 'Amount', description: 'Line amount', column_role: 'measure', transformation_expression: 's.amount', additivity: 'additive' },
        ],
      }],
      relationships: [{ from_table_name: 'fact_sales', from_column_name: 'customer_key', to_table_name: 'dim_customer', to_column_name: 'customer_key', relationship_type: 'fact_to_dim' }],
      data_products: [
        { name: 'Reference', description: 'Shared lookups', build_order: 1, fact_tables: [], owned_dimensions: ['dim_customer'] },
        { name: 'Sales', description: 'Sales analytics', build_order: 2, fact_tables: ['fact_sales'], owned_dimensions: [] },
      ],
      proposed_kpis: [],
    } as unknown as Parameters<typeof buildBusMatrix>[0]['busMatrix'];

    const tablesOf = async (productId: number) => db('product_tables as pt')
      .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
      .where('ss.data_product_id', productId)
      .select('pt.id', 'pt.table_name', 'pt.is_shared_dimension', 'pt.source_product_table_id');

    for (let pass = 0; pass < 2; pass++) {
      // Twice: the second build retires the first — the new copies must
      // point at the NEW originals, not keep a pointer the rebuild nulled.
      const built = await buildBusMatrix({ connectionId: builderConn, tenantId, userEmail: 'a@b', busMatrix: matrix });
      const refId = built.products.find((p) => p.name === 'Reference')!.id;
      const salesId = built.products.find((p) => p.name === 'Sales')!.id;
      const ref = await tablesOf(refId);
      const sales = await tablesOf(salesId);
      const original = (name: string) => ref.find((t: { table_name: string }) => t.table_name === name)!;
      const copy = (name: string) => sales.find((t: { table_name: string }) => t.table_name === name)!;

      expect(copy('dim_customer').is_shared_dimension).toBe(true);
      expect(Number(copy('dim_customer').source_product_table_id)).toBe(Number(original('dim_customer').id));
      expect(copy('dim_date').is_shared_dimension).toBe(true);
      expect(Number(copy('dim_date').source_product_table_id)).toBe(Number(original('dim_date').id));
      expect(original('dim_customer').source_product_table_id).toBeNull();
      expect(sales.find((t: { table_name: string }) => t.table_name === 'fact_sales')!.source_product_table_id).toBeNull();
    }
  });
});

describe('a lookup’s joins are read where they are recorded', () => {
  it('the owning subject carries the joins its lookups take part in elsewhere', async () => {
    const db = getTestDb();
    await linkSharedTables(db, tenantId);
    // Purchasing records its measures table joining ITS copy of the Journal —
    // exactly where the builder writes such a join.
    const purSchema = await db('star_schemas').where({ data_product_id: purchasingId }).first('id');
    await db('product_columns').insert({
      tenant_id: tenantId, product_table_id: factId, column_name: 'journal_key', data_type: 'INTEGER',
      column_role: 'foreign_key', is_technical: true, sort_order: 0,
    });
    await db('product_relationships').insert({
      tenant_id: tenantId, star_schema_id: purSchema.id, from_table_id: factId, from_column_name: 'journal_key',
      to_table_id: copyId, to_column_name: 'journal_key', relationship_type: 'many_to_one',
    });

    const r = await request();
    const ref = await r.get(`/api/products/${referenceId}`).set(auth(adminToken));
    expect(ref.status).toBe(200);
    const ext = ref.body.data.external_joins;
    expect(ext.relationships).toHaveLength(1);
    expect(ext.relationships[0]).toMatchObject({
      from_table_name: 'fact_purchase_entry_lines', from_column_name: 'journal_key',
      to_table_name: 'dim_journal', to_column_name: 'journal_key',
      in_subject_name: 'Purchasing', own_table_id: originalId, other_table_id: factId,
    });
    // The far end names its subject and carries the field the join lands on.
    expect(ext.tables).toHaveLength(1);
    expect(ext.tables[0]).toMatchObject({ id: factId, subject_name: 'Purchasing', table_role: 'fact' });
    expect(ext.tables[0].join_columns.map((c: { column_name: string }) => c.column_name)).toEqual(['journal_key']);
    // …and the lookup's own key, hidden as technical elsewhere, is shipped as
    // its join field so the line lands on a named field at both ends.
    const orig = (ref.body.data.star_schemas as Array<{ tables: Array<{ id: number; join_columns: Array<{ column_name: string }> }> }>)
      .flatMap((s) => s.tables).find((t) => Number(t.id) === originalId)!;
    expect(orig.join_columns.map((c) => c.column_name)).toContain('journal_key');

    // The subject that records the join lists it as its own — not twice.
    const pur = await r.get(`/api/products/${purchasingId}`).set(auth(adminToken));
    expect(pur.body.data.external_joins.relationships).toHaveLength(0);
    const purRels = (pur.body.data.star_schemas as Array<{ relationships: unknown[] }>).flatMap((s) => s.relationships);
    expect(purRels).toHaveLength(1);
  });

  it('another tenant cannot read a subject, joins included', async () => {
    const other = await registerUser({ email: 'peek@shared.test', companyName: 'Peek BV' });
    const r = await request();
    const res = await r.get(`/api/products/${referenceId}`).set(auth(other.token));
    expect(res.status).toBe(404);
  });
});

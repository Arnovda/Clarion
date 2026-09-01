/**
 * GET /api/lineage/table — anchored column-level lineage.
 *
 * What this guards:
 *  1. **Both directions agree.** The same column_lineage rows read from the
 *     source anchor and from the product anchor must describe the same
 *     edges — one store, two projections.
 *  2. **Name matches stay inside the connection.** `source_table_name` is a
 *     name, and names repeat across connections/tenants: an identically
 *     named table on another connection must not appear downstream.
 *  3. **The is_technical firewall holds here too** — `_row_hash` must not
 *     surface as a lineage endpoint.
 *  4. **Unresolved upstream names still render.** Lineage can name a source
 *     table the catalog no longer has; the edge is the fact and must
 *     survive with tableId null rather than vanish.
 *  5. Tenant isolation (404, not 403) and the viewer gate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let otherToken: string;
let srcTableId: number;
let productTableId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'lineage-admin@test.com', companyName: 'LineageCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  const other = await registerUser({ email: 'lineage-other@test.com', companyName: 'OtherLineageCo' });
  otherToken = other.token;

  const db = getTestDb();
  const insertId = async (table: string, row: Record<string, unknown>): Promise<number> => {
    const [r] = await db(table).insert(row).returning('id');
    return Number((r as { id?: number }).id ?? r);
  };

  const connId = await insertId('connections', {
    tenant_id: tenantId, name: 'EO', type: 'duckdb', connector_type: 'exactonline',
    config: JSON.stringify({}),
  });
  // A second connection with an identically-named table — the name-scoping trap.
  const otherConnId = await insertId('connections', {
    tenant_id: tenantId, name: 'Other conn', type: 'sqlite', config: JSON.stringify({ filepath: '/tmp/o.db' }),
  });

  srcTableId = await insertId('source_tables', {
    tenant_id: tenantId, connection_id: connId, table_name: 'SalesInvoices', display_name: 'Sales invoices',
  });
  await insertId('source_tables', {
    tenant_id: tenantId, connection_id: otherConnId, table_name: 'SalesInvoices',
  });
  const srcColAmount = await insertId('source_columns', {
    tenant_id: tenantId, table_id: srcTableId, column_name: 'AmountDC', display_name: 'Amount',
  });
  void srcColAmount;
  await insertId('source_columns', {
    tenant_id: tenantId, table_id: srcTableId, column_name: 'InvoiceDate',
  });
  await insertId('source_columns', {
    tenant_id: tenantId, table_id: srcTableId, column_name: 'UntouchedColumn',
  });

  const productId = await insertId('data_products', {
    tenant_id: tenantId, connection_id: connId, name: 'Sales', status: 'approved', kind: 'analytics',
  });
  const schemaId = await insertId('star_schemas', {
    tenant_id: tenantId, data_product_id: productId, name: 'sales_star', fact_table_type: 'transaction',
  });
  productTableId = await insertId('product_tables', {
    tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fact_sales', display_name: 'Sales lines',
    table_role: 'fact', dag_order: 1, transformation_status: 'success',
  });

  const colAmount = await insertId('product_columns', {
    tenant_id: tenantId, product_table_id: productTableId, column_name: 'amount',
    display_name: 'Amount', column_role: 'measure', transformation_expression: 'SalesInvoices.AmountDC',
  });
  const colDate = await insertId('product_columns', {
    tenant_id: tenantId, product_table_id: productTableId, column_name: 'invoice_date',
    column_role: 'attribute', transformation_expression: 'CAST(SalesInvoices.InvoiceDate AS DATE)',
  });
  const colHash = await insertId('product_columns', {
    tenant_id: tenantId, product_table_id: productTableId, column_name: '_row_hash', is_technical: true,
  });
  const colGhost = await insertId('product_columns', {
    tenant_id: tenantId, product_table_id: productTableId, column_name: 'ghost_ref',
  });

  await db('column_lineage').insert([
    { tenant_id: tenantId, product_column_id: colAmount, source_table_name: 'SalesInvoices', source_column_name: 'AmountDC', transformation_description: 'Amount in division currency, unchanged' },
    { tenant_id: tenantId, product_column_id: colDate, source_table_name: 'SalesInvoices', source_column_name: 'InvoiceDate', transformation_description: 'Cast to DATE' },
    // The firewall case: a technical column fed by the same source table.
    { tenant_id: tenantId, product_column_id: colHash, source_table_name: 'SalesInvoices', source_column_name: 'AmountDC', transformation_description: 'hash input' },
    // The unresolved case: names a table the catalog does not have.
    { tenant_id: tenantId, product_column_id: colGhost, source_table_name: 'RetiredTable', source_column_name: 'OldColumn', transformation_description: null },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

async function fetchLineage(token: string, layer: string, tableId: number) {
  const agent = await request();
  return agent.get(`/api/lineage/table?layer=${layer}&tableId=${tableId}`).set('Authorization', `Bearer ${token}`);
}

describe('GET /api/lineage/table', () => {
  it('source anchor: shows downstream product columns with transformations, only fed source columns', async () => {
    const res = await fetchLineage(adminToken, 'source', srcTableId);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.anchor.tableName).toBe('SalesInvoices');
    expect(d.products).toHaveLength(1);
    const p = d.products[0];
    expect(p.tableName).toBe('fact_sales');
    const colNames = p.columns.map((c: { name: string }) => c.name).sort();
    expect(colNames).toEqual(['amount', 'invoice_date']); // _row_hash filtered, ghost_ref not fed by this table
    expect(p.columns.find((c: { name: string }) => c.name === 'invoice_date').transformation).toBe('Cast to DATE');
    // Only the fed source columns render; the untouched one is a count, not a row.
    const srcColNames = d.sources[0].columns.map((c: { name: string }) => c.name).sort();
    expect(srcColNames).toEqual(['AmountDC', 'InvoiceDate']);
    expect(d.totalSourceColumns).toBe(3);
    expect(d.edges).toHaveLength(2);
  });

  it('product anchor: shows upstream sources, resolves catalog ids, keeps unresolved names', async () => {
    const res = await fetchLineage(adminToken, 'product', productTableId);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const byName = new Map(d.sources.map((s: { tableName: string }) => [s.tableName, s]));
    const resolved = byName.get('SalesInvoices') as { tableId: number | null } | undefined;
    const ghost = byName.get('RetiredTable') as { tableId: number | null } | undefined;
    expect(resolved?.tableId).toBe(srcTableId);
    expect(ghost).toBeDefined();
    expect(ghost?.tableId).toBeNull();
    // The product node lists its non-technical columns; _row_hash never appears.
    const pCols = d.products[0].columns.map((c: { name: string }) => c.name);
    expect(pCols).not.toContain('_row_hash');
    expect(pCols).toContain('amount');
    // Both directions describe the same SalesInvoices edges.
    const salesEdges = d.edges.filter((e: { sourceTable: string }) => e.sourceTable === 'SalesInvoices');
    expect(salesEdges).toHaveLength(2);
  });

  it('is tenant-isolated (404, not 403)', async () => {
    const res = await fetchLineage(otherToken, 'source', srcTableId);
    expect(res.status).toBe(404);
  });

  it('refuses viewers', async () => {
    const viewerToken = (await createUserWithToken({ tenantId, role: 'viewer', email: 'lineage-viewer@test.com' })).token;
    const res = await fetchLineage(viewerToken, 'source', srcTableId);
    expect(res.status).toBe(403);
  });

  it('rejects a bad layer', async () => {
    const res = await fetchLineage(adminToken, 'everything', srcTableId);
    expect(res.status).toBe(400);
  });
});

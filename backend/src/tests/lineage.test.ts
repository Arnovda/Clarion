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

// ─── Lineage read off the table's CURRENT SQL (2026-09-25) ───────────────────
//
// The owner: keys belong in the lineage, and a column made by combining two
// fields must show both. The stored column_lineage rows are written once, at
// build time, and go stale when the SQL changes (the key upgrade rewrites
// every key) — so the SQL is read, and a stored row the SQL contradicts
// must not survive.
describe('lineage from the SQL', () => {
  let factId: number;
  let accountsId: number;
  let linesId: number;
  const cols: Record<string, number> = {};

  beforeAll(async () => {
    const db = getTestDb();
    const insertId = async (table: string, row: Record<string, unknown>): Promise<number> => {
      const [r] = await db(table).insert(row).returning('id');
      return Number((r as { id?: number }).id ?? r);
    };
    const connId = await insertId('connections', {
      tenant_id: tenantId, name: 'EO sql', type: 'duckdb', connector_type: 'exactonline', config: JSON.stringify({}),
    });
    linesId = await insertId('source_tables', { tenant_id: tenantId, connection_id: connId, table_name: 'SalesInvoiceLines' });
    const headers = await insertId('source_tables', { tenant_id: tenantId, connection_id: connId, table_name: 'SalesInvoiceHeaders' });
    accountsId = await insertId('source_tables', { tenant_id: tenantId, connection_id: connId, table_name: 'Accounts' });
    for (const c of ['ID', 'InvoiceID', 'Item', 'Quantity', 'UnitPrice']) {
      await insertId('source_columns', { tenant_id: tenantId, table_id: linesId, column_name: c });
    }
    for (const c of ['InvoiceID', 'InvoiceTo', 'InvoiceDate']) {
      await insertId('source_columns', { tenant_id: tenantId, table_id: headers, column_name: c });
    }
    for (const c of ['ID', 'Code', 'Name']) {
      await insertId('source_columns', { tenant_id: tenantId, table_id: accountsId, column_name: c });
    }
    const productId = await insertId('data_products', {
      tenant_id: tenantId, connection_id: connId, name: 'Sales (sql)', status: 'approved', kind: 'analytics',
    });
    const schemaId = await insertId('star_schemas', {
      tenant_id: tenantId, data_product_id: productId, name: 'sales_sql', fact_table_type: 'transaction',
    });
    factId = await insertId('product_tables', {
      tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fact_sales_invoice_lines', table_role: 'fact',
      dag_order: 1, transformation_status: 'success',
      transformation_sql: `
        WITH lines AS (
          SELECT l.ID, l.InvoiceID, l.Item, l.Quantity * l.UnitPrice AS gross FROM SalesInvoiceLines l
        )
        SELECT
          clarion_key('accounts', h.InvoiceTo) AS invoice_to_account_key,
          clarion_key('items', x.Item) AS item_key,
          x.ID AS sales_invoice_line_id,
          x.gross,
          concat_ws(' - ', a.Code, a.Name) AS customer_label
        FROM lines x
        JOIN SalesInvoiceHeaders h ON h.InvoiceID = x.InvoiceID
        LEFT JOIN Accounts a ON a.ID = h.InvoiceTo`,
    });
    const col = async (name: string, extra: Record<string, unknown> = {}) => {
      cols[name] = await insertId('product_columns', { tenant_id: tenantId, product_table_id: factId, column_name: name, ...extra });
    };
    await col('invoice_to_account_key', { is_technical: true, column_role: 'foreign_key' });
    await col('item_key', { is_technical: true, column_role: 'foreign_key' });
    await col('sales_invoice_line_id');
    await col('gross', { column_role: 'measure' });
    await col('customer_label');
    await col('_row_hash', { is_technical: true });
    // Stale: written by the ROW_NUMBER era, before the key upgrade rewrote
    // the key. The SQL now says InvoiceTo — this row must not survive.
    await db('column_lineage').insert({
      tenant_id: tenantId, product_column_id: cols.invoice_to_account_key,
      source_table_name: 'Accounts', source_column_name: 'ID', transformation_description: 'ROW_NUMBER() over accounts',
    });
  });

  it('product anchor: keys, a combined column and a CTE, all from the SQL', async () => {
    const res = await fetchLineage(adminToken, 'product', factId);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const names = d.products[0].columns.map((c: { name: string }) => c.name);
    expect(names).toContain('invoice_to_account_key');
    expect(names).not.toContain('_row_hash');
    expect(d.products[0].columns.find((c: { name: string }) => c.name === 'item_key').technical).toBe(true);

    const into = (colName: string) => d.edges
      .filter((e: { productColumnId: number }) => e.productColumnId === cols[colName])
      .map((e: { sourceTable: string; sourceColumn: string }) => `${e.sourceTable}.${e.sourceColumn}`)
      .sort();
    expect(into('invoice_to_account_key')).toEqual(['SalesInvoiceHeaders.InvoiceTo']); // the stale Accounts.ID is gone
    expect(into('item_key')).toEqual(['SalesInvoiceLines.Item']);                          // through the CTE
    expect(into('gross')).toEqual(['SalesInvoiceLines.Quantity', 'SalesInvoiceLines.UnitPrice']);
    expect(into('customer_label')).toEqual(['Accounts.Code', 'Accounts.Name']);
    const key = d.edges.find((e: { productColumnId: number }) => e.productColumnId === cols.invoice_to_account_key);
    expect(key.transformation).toContain('clarion_key');
    expect(key.provenance).toBe('derived');
    const id = d.edges.find((e: { productColumnId: number }) => e.productColumnId === cols.sales_invoice_line_id);
    expect(id.transformation).toBe('Copied as-is');
  });

  it('source anchor: the same edges, seen from the source table', async () => {
    const res = await fetchLineage(adminToken, 'source', accountsId);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const fed = d.edges.map((e: { sourceColumn: string; productColumnId: number }) => `${e.sourceColumn}->${e.productColumnId}`).sort();
    // Code and Name into the label; NOT the stale ID into the key.
    expect(fed).toEqual([`Code->${cols.customer_label}`, `Name->${cols.customer_label}`].sort());

    const lines = await fetchLineage(adminToken, 'source', linesId);
    const intoKey = lines.body.data.edges.filter((e: { productColumnId: number }) => e.productColumnId === cols.item_key);
    expect(intoKey.map((e: { sourceColumn: string }) => e.sourceColumn)).toEqual(['Item']);
  });
});

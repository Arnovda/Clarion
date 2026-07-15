/**
 * ExactOnline star-schema template conformance tests.
 *
 * Same three layers of proof as the Odoo template suite:
 *   1. Structural validation against the EO entity catalog (also enforced
 *      generically by conformance.test.ts).
 *   2. Degradation behaviour on partial entity selections.
 *   3. EXECUTION: every dim/fact SQL and every KPI formula runs in DuckDB
 *      against synthetic source tables mirroring the EO fields the SQL reads
 *      (names verified against the vendor docs transcription in docs.ts),
 *      with output columns asserted equal to the declared column metadata.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from 'duckdb-async';
import { EXACT_ONLINE_STAR_SCHEMA_TEMPLATE } from './starSchemaTemplate';
import { EXACT_ONLINE_ENTITIES } from './entities';
import { EXACT_ONLINE_COLUMN_DOCS } from './docs';
import { instantiateStarSchemaTemplate, validateStarSchemaTemplate } from '../starSchema';

const CATALOG = EXACT_ONLINE_ENTITIES.map((e) => e.name);
const T = EXACT_ONLINE_STAR_SCHEMA_TEMPLATE;

// ─── 1. Structure ───────────────────────────────────────────────────────────

describe('EXACT_ONLINE_STAR_SCHEMA_TEMPLATE structure', () => {
  it('passes template validation against the entity catalog', () => {
    expect(validateStarSchemaTemplate(T, CATALOG)).toEqual([]);
  });

  it('references only vendor-documented source columns (docs.ts transcription)', () => {
    // Every column lineage must point at a field that exists in the vendor's
    // REST reference — this is what "no guessed field names" means in code.
    const errs: string[] = [];
    for (const t of [...T.dimensions, ...T.facts]) {
      for (const c of t.columns) {
        if (!c.sourceEntity || !c.sourceColumn) continue;
        const docs = EXACT_ONLINE_COLUMN_DOCS[c.sourceEntity];
        if (!docs) { errs.push(`${t.tableName}.${c.name}: no docs for entity ${c.sourceEntity}`); continue; }
        if (!docs.some((d) => d.name === c.sourceColumn)) {
          errs.push(`${t.tableName}.${c.name}: ${c.sourceEntity}.${c.sourceColumn} not in the vendor docs`);
        }
      }
    }
    expect(errs).toEqual([]);
  });

  it('degrades to a sales-only instantiation when only sales entities are synced', () => {
    const r = instantiateStarSchemaTemplate(T, [
      'SalesInvoices', 'SalesInvoiceLines', 'Accounts', 'Items', 'ItemGroups',
    ])!;
    expect(r.facts.map((f) => f.tableName)).toEqual(['fact_sales_invoice_lines']);
    expect(r.dimensions.map((d) => d.tableName).sort()).toEqual(['dim_account', 'dim_item', 'dim_item_group']);
    expect(r.products.map((p) => p.name)).toEqual(['Core dimensions', 'Sales']);
    expect(r.kpis.map((k) => k.name)).toEqual(['Invoiced sales revenue']);
  });

  it('falls back to null (AI path) when no fact-bearing entities are synced', () => {
    expect(instantiateStarSchemaTemplate(T, ['Accounts', 'Items'])).toBeNull();
  });
});

// ─── 2. Execution against synthetic EO source tables ───────────────────────

/**
 * Synthetic source tables: the EO fields the template SQL reads. GUIDs are
 * VARCHAR (equality-joinable like the UUIDs auto-detect infers), dates are
 * ISO strings in VARCHAR — deliberately, to prove the TRY_CAST(… AS DATE)
 * normalisation works on the string form the connector actually writes.
 */
const SOURCE_DDL: Record<string, string> = {
  Accounts: `ID VARCHAR, Code VARCHAR, Name VARCHAR, City VARCHAR, CountryName VARCHAR, Email VARCHAR,
    Phone VARCHAR, VATNumber VARCHAR, Status VARCHAR, IsSales BOOLEAN, IsSupplier BOOLEAN, Parent VARCHAR`,
  Items: `ID VARCHAR, Code VARCHAR, Description VARCHAR, ItemGroup VARCHAR, Unit VARCHAR,
    IsSalesItem BOOLEAN, IsStockItem BOOLEAN, StandardSalesPrice DOUBLE, CostPriceStandard DOUBLE`,
  ItemGroups: `ID VARCHAR, Code VARCHAR, Description VARCHAR`,
  GLAccounts: `ID VARCHAR, Code VARCHAR, Description VARCHAR, TypeDescription VARCHAR, BalanceSide VARCHAR`,
  Journals: `ID VARCHAR, Code VARCHAR, Description VARCHAR, Type BIGINT`,
  PaymentConditions: `ID VARCHAR, Code VARCHAR, Description VARCHAR, PaymentDays BIGINT`,
  SalesInvoices: `InvoiceID VARCHAR, InvoiceNumber BIGINT, InvoiceDate VARCHAR, DueDate VARCHAR,
    StatusDescription VARCHAR, TypeDescription VARCHAR, InvoiceTo VARCHAR, OrderedBy VARCHAR,
    Journal VARCHAR, PaymentCondition VARCHAR, Currency VARCHAR`,
  SalesInvoiceLines: `ID VARCHAR, InvoiceID VARCHAR, Item VARCHAR, GLAccount VARCHAR, Description VARCHAR,
    Quantity DOUBLE, NetPrice DOUBLE, AmountDC DOUBLE, AmountFC DOUBLE, VATAmountDC DOUBLE`,
  SalesOrders: `OrderID VARCHAR, OrderNumber BIGINT, OrderDate VARCHAR, StatusDescription VARCHAR,
    OrderedBy VARCHAR, InvoiceTo VARCHAR, Currency VARCHAR`,
  SalesOrderLines: `ID VARCHAR, OrderID VARCHAR, Item VARCHAR, Description VARCHAR, Quantity DOUBLE,
    QuantityDelivered DOUBLE, QuantityInvoiced DOUBLE, NetPrice DOUBLE, Discount DOUBLE, AmountDC DOUBLE`,
  PurchaseOrders: `PurchaseOrderID VARCHAR, OrderNumber BIGINT, OrderDate VARCHAR, Supplier VARCHAR, Currency VARCHAR`,
  PurchaseOrderLines: `ID VARCHAR, PurchaseOrderID VARCHAR, Item VARCHAR, Description VARCHAR, Quantity DOUBLE,
    ReceivedQuantity DOUBLE, InvoicedQuantity DOUBLE, NetPrice DOUBLE, AmountDC DOUBLE`,
  TransactionLines: `ID VARCHAR, EntryNumber BIGINT, Date VARCHAR, FinancialYear BIGINT, FinancialPeriod BIGINT,
    JournalCode VARCHAR, GLAccount VARCHAR, Account VARCHAR, Item VARCHAR, InvoiceNumber BIGINT,
    Description VARCHAR, Currency VARCHAR, Quantity DOUBLE, AmountDC DOUBLE, AmountFC DOUBLE, AmountVATFC DOUBLE`,
  Receivables: `ID VARCHAR, InvoiceDate VARCHAR, DueDate VARCHAR, LastPaymentDate VARCHAR, InvoiceNumber BIGINT,
    Account VARCHAR, GLAccount VARCHAR, Journal VARCHAR, PaymentCondition VARCHAR, Currency VARCHAR,
    Description VARCHAR, IsFullyPaid BOOLEAN, AmountDC DOUBLE, AmountFC DOUBLE`,
  Payments: `ID VARCHAR, InvoiceDate VARCHAR, DueDate VARCHAR, InvoiceNumber BIGINT, Account VARCHAR,
    GLAccount VARCHAR, Journal VARCHAR, Currency VARCHAR, Description VARCHAR, AmountDC DOUBLE, AmountFC DOUBLE`,
};

describe('EXACT_ONLINE_STAR_SCHEMA_TEMPLATE execution (DuckDB)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await Database.create(':memory:');
    for (const [table, ddl] of Object.entries(SOURCE_DDL)) {
      await db.run(`CREATE TABLE "${table}" (${ddl})`);
    }
    // Seed an invoice + a credit note: EO credit-note lines are natively
    // negative, so net revenue must come out as 100 - 40 = 60 with no
    // sign-flip logic in the template.
    await db.run(`INSERT INTO SalesInvoices VALUES
      ('inv-1', 26001, '2026-01-15T00:00:00', '2026-02-14T00:00:00', 'Processed', 'Invoice', 'acc-1', 'acc-1', 'VRK', '14', 'EUR'),
      ('inv-2', 26002, '2026-02-01T00:00:00', '2026-03-03T00:00:00', 'Processed', 'Credit note', 'acc-1', 'acc-1', 'VRK', '14', 'EUR')`);
    await db.run(`INSERT INTO SalesInvoiceLines VALUES
      ('l-1', 'inv-1', 'item-1', 'gl-1', 'Widgets', 2, 50, 100, 100, 21),
      ('l-2', 'inv-2', 'item-1', 'gl-1', 'Widgets returned', -1, 40, -40, -40, -8.4)`);
  });

  afterAll(async () => { await db.close(); });

  it('every template table has covered source entities in the synthetic schema', () => {
    for (const t of [...T.dimensions, ...T.facts]) {
      for (const e of t.sourceEntities) {
        expect(SOURCE_DDL[e], `missing synthetic DDL for ${e} (used by ${t.tableName})`).toBeDefined();
      }
    }
  });

  it('every dim and fact SQL executes and its output columns match the declared columns', async () => {
    for (const t of [...T.dimensions, ...T.facts]) {
      const described = (await db.all(`DESCRIBE ${t.sql}`)) as Array<{ column_name: string }>;
      const actual = described.map((r) => r.column_name).sort();
      const declared = t.columns.map((c) => c.name).sort();
      expect(actual, `columns of ${t.tableName}`).toEqual(declared);
      await db.all(t.sql);
    }
  });

  it('materialises the full template and runs every KPI formula', async () => {
    for (const t of [...T.dimensions, ...T.facts]) {
      await db.run(`CREATE OR REPLACE TABLE ${t.tableName} AS ${t.sql}`);
    }
    for (const k of T.kpis) {
      const rows = await db.all(k.formulaSql);
      expect(rows, `KPI '${k.name}'`).toHaveLength(1);
    }
  });

  it('nets invoices and credit notes without sign-flip logic, and casts ISO dates', async () => {
    const rows = (await db.all(
      "SELECT SUM(amount_dc) AS net, strftime(MIN(invoice_date), '%Y-%m-%d') AS first_date FROM fact_sales_invoice_lines",
    )) as Array<{ net: number; first_date: string }>;
    expect(Number(rows[0].net)).toBe(60); // 100 - 40, natively negative credit note
    expect(rows[0].first_date).toBe('2026-01-15'); // TRY_CAST on ISO string worked
  });
});

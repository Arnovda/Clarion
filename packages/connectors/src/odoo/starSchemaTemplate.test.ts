/**
 * Odoo star-schema template conformance tests.
 *
 * Three layers of proof that the template is safe to instantiate for any
 * customer without an AI in the loop:
 *   1. Structural validation against the Odoo entity catalog.
 *   2. Degradation behaviour on partial entity selections.
 *   3. EXECUTION: every dim/fact SQL and every KPI formula actually runs in
 *      DuckDB against synthetic source tables that mirror the Odoo fields the
 *      SQL reads (same names, same DuckDB types the sync writer produces),
 *      and each table's output columns exactly match its declared columns.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from 'duckdb-async';
import { ODOO_STAR_SCHEMA_TEMPLATE } from './starSchemaTemplate';
import { ODOO_ENTITIES } from './entities';
import { instantiateStarSchemaTemplate, validateStarSchemaTemplate } from '../starSchema';

const CATALOG = ODOO_ENTITIES.map((e) => e.name);
const T = ODOO_STAR_SCHEMA_TEMPLATE;

// ─── 1. Structure ───────────────────────────────────────────────────────────

describe('ODOO_STAR_SCHEMA_TEMPLATE structure', () => {
  it('passes template validation against the entity catalog', () => {
    expect(validateStarSchemaTemplate(T, CATALOG)).toEqual([]);
  });

  it('survives fully with all catalog entities selected', () => {
    const r = instantiateStarSchemaTemplate(T, CATALOG)!;
    expect(r.dimensions).toHaveLength(T.dimensions.length);
    expect(r.facts).toHaveLength(T.facts.length);
    expect(r.products).toHaveLength(T.products.length);
  });

  it('degrades to a sales-only instantiation when only sales entities are synced', () => {
    const r = instantiateStarSchemaTemplate(T, [
      'sale_order', 'sale_order_line', 'res_partner', 'res_company', 'res_currency',
    ])!;
    expect(r.facts.map((f) => f.tableName)).toEqual(['fact_sales_order_lines']);
    expect(r.dimensions.map((d) => d.tableName).sort()).toEqual(['dim_company', 'dim_currency', 'dim_partner']);
    expect(r.products.map((p) => p.name)).toEqual(['Core dimensions', 'Sales']);
    expect(r.kpis.map((k) => k.name)).toEqual(['Confirmed sales value']);
  });

  it('falls back to null (AI path) when no fact-bearing entities are synced', () => {
    expect(instantiateStarSchemaTemplate(T, ['res_partner', 'res_currency'])).toBeNull();
  });
});

// ─── 2. Execution against synthetic Odoo source tables ─────────────────────

/**
 * Synthetic source tables: the Odoo fields the template SQL reads, with the
 * DuckDB types the sync writer's explicit column schema produces
 * (odooTypeToDuckDb: many2one/integer→BIGINT, monetary→DECIMAL(18,4),
 * float→DOUBLE, char/selection→VARCHAR, boolean→BOOLEAN, date→DATE,
 * datetime→TIMESTAMP).
 */
const SOURCE_DDL: Record<string, string> = {
  res_partner: `id BIGINT, name VARCHAR, email VARCHAR, phone VARCHAR, city VARCHAR, zip VARCHAR,
    vat VARCHAR, is_company BOOLEAN, active BOOLEAN, parent_id BIGINT, company_id BIGINT`,
  product_product: `id BIGINT, product_tmpl_id BIGINT, default_code VARCHAR, active BOOLEAN`,
  product_template: `id BIGINT, name VARCHAR, type VARCHAR, categ_id BIGINT, uom_id BIGINT, list_price DOUBLE`,
  product_category: `id BIGINT, name VARCHAR, complete_name VARCHAR, parent_id BIGINT`,
  account_account: `id BIGINT, code VARCHAR, name VARCHAR, account_type VARCHAR`,
  account_journal: `id BIGINT, name VARCHAR, code VARCHAR, type VARCHAR, company_id BIGINT, currency_id BIGINT`,
  res_company: `id BIGINT, name VARCHAR, currency_id BIGINT`,
  res_currency: `id BIGINT, name VARCHAR, symbol VARCHAR, active BOOLEAN`,
  account_payment_term: `id BIGINT, name VARCHAR`,
  uom_uom: `id BIGINT, name VARCHAR`,
  account_move: `id BIGINT, name VARCHAR, move_type VARCHAR, state VARCHAR, invoice_date DATE,
    invoice_date_due DATE, partner_id BIGINT, journal_id BIGINT, company_id BIGINT,
    currency_id BIGINT, invoice_payment_term_id BIGINT`,
  account_move_line: `id BIGINT, move_id BIGINT, product_id BIGINT, account_id BIGINT, partner_id BIGINT,
    journal_id BIGINT, company_id BIGINT, currency_id BIGINT, quantity DOUBLE,
    price_unit DECIMAL(18,4), price_subtotal DECIMAL(18,4), price_total DECIMAL(18,4),
    display_type VARCHAR, date DATE, debit DECIMAL(18,4), credit DECIMAL(18,4), balance DECIMAL(18,4)`,
  sale_order: `id BIGINT, name VARCHAR, date_order TIMESTAMP, state VARCHAR, partner_id BIGINT,
    company_id BIGINT, currency_id BIGINT`,
  sale_order_line: `id BIGINT, order_id BIGINT, product_id BIGINT, product_uom_qty DOUBLE,
    qty_delivered DOUBLE, qty_invoiced DOUBLE, price_unit DECIMAL(18,4), discount DOUBLE,
    price_subtotal DECIMAL(18,4), price_total DECIMAL(18,4)`,
  purchase_order: `id BIGINT, name VARCHAR, date_order TIMESTAMP, state VARCHAR, partner_id BIGINT,
    company_id BIGINT, currency_id BIGINT`,
  purchase_order_line: `id BIGINT, order_id BIGINT, product_id BIGINT, product_qty DOUBLE,
    qty_received DOUBLE, qty_invoiced DOUBLE, price_unit DECIMAL(18,4),
    price_subtotal DECIMAL(18,4), price_total DECIMAL(18,4)`,
  account_payment: `id BIGINT, date DATE, payment_type VARCHAR, partner_type VARCHAR, state VARCHAR,
    partner_id BIGINT, journal_id BIGINT, company_id BIGINT, currency_id BIGINT, amount DECIMAL(18,4)`,
  stock_move: `id BIGINT, date TIMESTAMP, state VARCHAR, reference VARCHAR, product_id BIGINT,
    company_id BIGINT, product_uom_qty DOUBLE`,
};

describe('ODOO_STAR_SCHEMA_TEMPLATE execution (DuckDB)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await Database.create(':memory:');
    for (const [table, ddl] of Object.entries(SOURCE_DDL)) {
      await db.run(`CREATE TABLE ${table} (${ddl})`);
    }
    // Seed one customer invoice line + one credit-note line so the sign logic
    // and the display_type filter are exercised with real rows.
    await db.run(`INSERT INTO account_move VALUES
      (1, 'INV/2026/0001', 'out_invoice', 'posted', DATE '2026-01-15', DATE '2026-02-14', 10, 1, 1, 1, 1),
      (2, 'RINV/2026/0001', 'out_refund', 'posted', DATE '2026-02-01', DATE '2026-03-03', 10, 1, 1, 1, 1)`);
    await db.run(`INSERT INTO account_move_line
      (id, move_id, product_id, account_id, quantity, price_unit, price_subtotal, price_total, display_type, date, debit, credit, balance)
      VALUES
      (100, 1, 5, 7, 2, 50, 100, 121, 'product', DATE '2026-01-15', 0, 100, -100),
      (101, 2, 5, 7, 1, 50, 50, 60.5, 'product', DATE '2026-02-01', 50, 0, 50),
      (102, 1, NULL, 7, 0, 0, 21, 21, 'tax', DATE '2026-01-15', 0, 21, -21)`);
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
      await db.all(t.sql); // and it actually runs
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

  it('fact_invoice_lines applies the sign convention and drops non-product lines', async () => {
    const fact = T.facts.find((f) => f.tableName === 'fact_invoice_lines')!;
    const rows = (await db.all(fact.sql)) as Array<{ invoice_line_id: number | bigint; amount_signed: unknown }>;
    expect(rows).toHaveLength(2); // the 'tax' line is excluded
    const byId = new Map(rows.map((r) => [Number(r.invoice_line_id), Number(r.amount_signed)]));
    expect(byId.get(100)).toBe(100);  // out_invoice keeps its sign
    expect(byId.get(101)).toBe(-50);  // out_refund is negated
  });
});

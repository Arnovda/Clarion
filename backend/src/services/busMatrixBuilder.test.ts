/**
 * synthesizeFkRelationships — the relationship rows derived from column
 * fk_target metadata when the AI's relationships[] list omits them.
 *
 * The case that matters is dim_date: the prompt forbids listing it as a
 * table (auto-injected) and the model reliably omits the relationships
 * touching it too, so an AI-built topic rendered its Date lookup as "not
 * linked yet" (owner screenshot, 2026-08-20). The column metadata is where
 * those joins survive; these tests pin that they become rows — and that the
 * synthesis can never duplicate, self-reference, or invent a target.
 */

import { describe, it, expect } from 'vitest';
import { synthesizeFkRelationships, SynthesizableTable } from './busMatrixBuilder';

const factTable: SynthesizableTable = {
  table_name: 'fact_inventory_snapshot',
  table_role: 'fact',
  columns: [
    { column_name: 'snapshot_date_key', fk_target_table: 'dim_date', fk_target_column: 'date_key' },
    { column_name: 'item_key', fk_target_table: 'dim_item', fk_target_column: 'item_key' },
    { column_name: 'quantity_on_hand', fk_target_table: null, fk_target_column: null },
  ],
};

const known = new Set(['fact_inventory_snapshot', 'dim_item', 'dim_date']);

describe('synthesizeFkRelationships', () => {
  it('derives the dim_date link the relationships list omitted', () => {
    const out = synthesizeFkRelationships([factTable], [
      { from_table_name: 'fact_inventory_snapshot', from_column_name: 'item_key', to_table_name: 'dim_item' },
    ], known);
    expect(out).toEqual([{
      from_table_name: 'fact_inventory_snapshot',
      from_column_name: 'snapshot_date_key',
      to_table_name: 'dim_date',
      to_column_name: 'date_key',
      relationship_type: 'fact_to_dim',
    }]);
  });

  it('never duplicates a link the list already asserts', () => {
    const out = synthesizeFkRelationships([factTable], [
      { from_table_name: 'fact_inventory_snapshot', from_column_name: 'snapshot_date_key', to_table_name: 'dim_date' },
      { from_table_name: 'fact_inventory_snapshot', from_column_name: 'item_key', to_table_name: 'dim_item' },
    ], known);
    expect(out).toEqual([]);
  });

  it('skips targets the schema does not know — a bad fk_target must not invent a row', () => {
    const out = synthesizeFkRelationships([{
      table_name: 'fact_x',
      table_role: 'fact',
      columns: [{ column_name: 'ghost_key', fk_target_table: 'dim_ghost', fk_target_column: 'ghost_key' }],
    }], [], new Set(['fact_x']));
    expect(out).toEqual([]);
  });

  it('skips self-references and columns without a complete fk target', () => {
    const out = synthesizeFkRelationships([{
      table_name: 'dim_item',
      table_role: 'dimension',
      columns: [
        { column_name: 'parent_item_key', fk_target_table: 'dim_item', fk_target_column: 'item_key' },
        { column_name: 'group_key', fk_target_table: 'dim_item_group', fk_target_column: null },
      ],
    }], [], new Set(['dim_item', 'dim_item_group']));
    expect(out).toEqual([]);
  });

  it('types a dimension-to-dimension link as dim_to_dim', () => {
    const out = synthesizeFkRelationships([{
      table_name: 'dim_item',
      table_role: 'dimension',
      columns: [{ column_name: 'group_key', fk_target_table: 'dim_item_group', fk_target_column: 'group_key' }],
    }], [], new Set(['dim_item', 'dim_item_group']));
    expect(out).toHaveLength(1);
    expect(out[0].relationship_type).toBe('dim_to_dim');
  });
});

/**
 * prepareExtensionMatrix — the guards that make an ADDITIVE topic build safe.
 *
 * The prompt tells the model the rules; these tests pin that the rules hold
 * even when the model ignores them, because a violation here is not a bad
 * answer — it is buildBusMatrix's retire-and-replace sweep firing on an
 * existing product, or a duplicate shared lookup diverging from its owner.
 */
import { prepareExtensionMatrix, ExtensionSchemaContext } from './busMatrixBuilder';
import type { BusMatrixOutput, BusMatrixDimension } from '../ai/prompts/busMatrixPrompt';

const dimItemShadow: BusMatrixDimension = {
  table_name: 'dim_item',
  display_name: 'Item',
  description: 'Items you buy and sell',
  transformation_sql: 'SELECT 1 AS item_key',
  source_tables: ['Items'],
  columns: [
    { column_name: 'item_key', data_type: 'INTEGER', display_name: 'Item Key', description: 'Surrogate', column_role: 'surrogate_key', transformation_expression: 'ROW_NUMBER()', scd_type: 1, sort_order: 0, lineage: [] },
  ],
};

function extCtx(overrides?: Partial<ExtensionSchemaContext>): ExtensionSchemaContext {
  return {
    productName: 'Quotations',
    existingProductNames: ['Sales', 'Shared data'],
    existingTableNames: ['dim_item', 'fact_sales_invoice_lines', 'dim_date'],
    reusableDims: [dimItemShadow],
    ...overrides,
  };
}

function extMatrix(overrides?: Partial<BusMatrixOutput>): BusMatrixOutput {
  return {
    rationale: 'x',
    conformed_dimensions: [],
    fact_tables: [{
      table_name: 'fact_quotation_lines',
      display_name: 'Quotation lines',
      description: 'One row per quotation line',
      grain: 'One row per quotation line',
      fact_table_type: 'transaction',
      transformation_sql: 'SELECT 1',
      source_tables: ['QuotationLines'],
      dimensions_used: ['dim_item', 'dim_date'],
      columns: [],
    }],
    relationships: [],
    data_products: [{ name: 'Quotations', description: 'Quotes', build_order: 3, fact_tables: ['fact_quotation_lines'], owned_dimensions: [] }],
    proposed_kpis: [{ name: 'Open quote value', description: '', formula_plain_text: '', formula_sql: 'SUM(x)', additivity: 'additive', product_name: 'Wrong name' }],
    dim_date_range: { start: '2020-01-01', end: '2027-12-31' },
    ...overrides,
  };
}

describe('prepareExtensionMatrix', () => {
  it('appends shadows for reused dims and reports them for dependency wiring', () => {
    const m = extMatrix();
    const result = prepareExtensionMatrix(m, extCtx());
    expect(result.errors).toEqual([]);
    expect(result.usedExistingDims).toEqual(['dim_item']);
    // Shadow present in conformed_dimensions (stub loop copies its columns)…
    expect(m.conformed_dimensions.map((d) => d.table_name)).toContain('dim_item');
    // …but never owned by the new product (owning it would re-materialise it).
    expect(m.data_products[0].owned_dimensions).not.toContain('dim_item');
  });

  it('drops an AI redefinition of an existing dim and reuses the real one instead', () => {
    const m = extMatrix({
      conformed_dimensions: [{ ...dimItemShadow, description: 'AI rewrote this', transformation_sql: 'SELECT 2' }],
    });
    const result = prepareExtensionMatrix(m, extCtx());
    expect(result.errors).toEqual([]);
    const dimItem = m.conformed_dimensions.find((d) => d.table_name === 'dim_item');
    // The surviving entry is the DB-derived shadow, not the AI's rewrite.
    expect(dimItem?.description).toBe('Items you buy and sell');
    expect(result.usedExistingDims).toEqual(['dim_item']);
  });

  it('refuses a fact whose name collides with an existing table', () => {
    const m = extMatrix();
    m.fact_tables[0].table_name = 'fact_sales_invoice_lines';
    m.data_products[0].fact_tables = ['fact_sales_invoice_lines'];
    const result = prepareExtensionMatrix(m, extCtx());
    expect(result.errors.some((e) => e.includes('fact_sales_invoice_lines'))).toBe(true);
  });

  it('refuses a product name that already exists (case-insensitive)', () => {
    const result = prepareExtensionMatrix(extMatrix(), extCtx({ productName: 'sales' }));
    expect(result.errors.some((e) => e.toLowerCase().includes('already exists'))).toBe(true);
  });

  it('refuses a fact using a dimension that neither exists nor is defined', () => {
    const m = extMatrix();
    m.fact_tables[0].dimensions_used = ['dim_ghost', 'dim_date'];
    const result = prepareExtensionMatrix(m, extCtx());
    expect(result.errors.some((e) => e.includes('dim_ghost'))).toBe(true);
  });

  it('forces the approved name, build_order 2, full ownership, and KPI product names', () => {
    const m = extMatrix({
      conformed_dimensions: [{ ...dimItemShadow, table_name: 'dim_quotation_status', display_name: 'Quote status', description: 'Status' }],
    });
    m.fact_tables[0].dimensions_used = ['dim_quotation_status', 'dim_date'];
    m.data_products = [{ name: 'Totally different', description: 'd', build_order: 1, fact_tables: [], owned_dimensions: [] }];
    const result = prepareExtensionMatrix(m, extCtx());
    expect(result.errors).toEqual([]);
    expect(m.data_products).toHaveLength(1);
    expect(m.data_products[0].name).toBe('Quotations');
    expect(m.data_products[0].build_order).toBe(2);
    expect(m.data_products[0].owned_dimensions).toEqual(['dim_quotation_status']);
    expect(m.data_products[0].fact_tables).toEqual(['fact_quotation_lines']);
    expect(m.proposed_kpis.every((k) => k.product_name === 'Quotations')).toBe(true);
  });

  it('refuses a design with nothing to measure', () => {
    const m = extMatrix({ fact_tables: [] });
    m.data_products[0].fact_tables = [];
    const result = prepareExtensionMatrix(m, extCtx());
    expect(result.errors.some((e) => e.includes('nothing to measure'))).toBe(true);
  });
});

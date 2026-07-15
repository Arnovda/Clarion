/**
 * Star-schema template instantiation tests (pure, no I/O).
 *
 * `instantiateStarSchemaTemplate` is the graceful-degradation contract from
 * docs/SOURCE_ONBOARDING.md Phase F: partial entity selections must yield an
 * internally-consistent sub-template, never a broken one.
 */

import { describe, expect, it } from 'vitest';
import {
  instantiateStarSchemaTemplate,
  validateStarSchemaTemplate,
  type StarSchemaTemplate,
} from './starSchema';

/** Minimal synthetic template: 2 dims, 2 facts, 3 products. */
const T: StarSchemaTemplate = {
  version: 1,
  dimensions: [
    {
      tableName: 'dim_customer', displayName: 'Customers', description: 'd',
      sourceEntities: ['customers'],
      sql: 'SELECT id AS customer_id, name FROM customers',
      columns: [
        { name: 'customer_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
        { name: 'name', dataType: 'VARCHAR', displayName: 'Name', description: 'd', role: 'attribute' },
      ],
    },
    {
      tableName: 'dim_item', displayName: 'Items', description: 'd',
      sourceEntities: ['items', 'item_groups'],
      sql: 'SELECT i.id AS item_id FROM items i JOIN item_groups g ON i.group_id = g.id',
      columns: [{ name: 'item_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' }],
    },
  ],
  facts: [
    {
      tableName: 'fact_orders', displayName: 'Orders', description: 'd',
      grain: 'One row per order', factTableType: 'transaction',
      sourceEntities: ['orders'],
      dimensionsUsed: ['dim_customer', 'dim_item', 'dim_date'],
      sql: 'SELECT id AS order_id, customer_id, item_id, amount FROM orders',
      columns: [
        { name: 'order_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
        { name: 'customer_id', dataType: 'BIGINT', displayName: 'Customer', description: 'd', role: 'foreign_key', fkTargetTable: 'dim_customer', fkTargetColumn: 'customer_id' },
        { name: 'item_id', dataType: 'BIGINT', displayName: 'Item', description: 'd', role: 'foreign_key', fkTargetTable: 'dim_item', fkTargetColumn: 'item_id' },
        { name: 'amount', dataType: 'DECIMAL(18,4)', displayName: 'Amount', description: 'd', role: 'measure', additivity: 'additive' },
      ],
    },
    {
      tableName: 'fact_tickets', displayName: 'Tickets', description: 'd',
      grain: 'One row per ticket', factTableType: 'transaction',
      sourceEntities: ['tickets'],
      dimensionsUsed: ['dim_customer', 'dim_date'],
      sql: 'SELECT id AS ticket_id, customer_id FROM tickets',
      columns: [
        { name: 'ticket_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
        { name: 'customer_id', dataType: 'BIGINT', displayName: 'Customer', description: 'd', role: 'foreign_key', fkTargetTable: 'dim_customer', fkTargetColumn: 'customer_id' },
      ],
    },
  ],
  products: [
    { name: 'Core', description: 'd', buildOrder: 1, factTables: [], ownedDimensions: ['dim_customer'] },
    { name: 'Sales', description: 'd', buildOrder: 2, factTables: ['fact_orders'], ownedDimensions: ['dim_item'] },
    { name: 'Support', description: 'd', buildOrder: 3, factTables: ['fact_tickets'], ownedDimensions: [] },
  ],
  relationships: [
    { fromTable: 'fact_orders', fromColumn: 'customer_id', toTable: 'dim_customer', toColumn: 'customer_id', type: 'fact_to_dim' },
    { fromTable: 'fact_orders', fromColumn: 'item_id', toTable: 'dim_item', toColumn: 'item_id', type: 'fact_to_dim' },
    { fromTable: 'fact_tickets', fromColumn: 'customer_id', toTable: 'dim_customer', toColumn: 'customer_id', type: 'fact_to_dim' },
  ],
  kpis: [
    { name: 'Order value', description: 'd', formulaPlainText: 'p', formulaSql: 'SELECT SUM(amount) FROM fact_orders', additivity: 'additive', productName: 'Sales', requiresTables: ['fact_orders'] },
    { name: 'Ticket count', description: 'd', formulaPlainText: 'p', formulaSql: 'SELECT COUNT(*) FROM fact_tickets', additivity: 'additive', productName: 'Support', requiresTables: ['fact_tickets'] },
  ],
};

const ALL = ['customers', 'items', 'item_groups', 'orders', 'tickets'];

describe('instantiateStarSchemaTemplate', () => {
  it('keeps everything when all entities are available', () => {
    const r = instantiateStarSchemaTemplate(T, ALL)!;
    expect(r.dimensions.map((d) => d.tableName)).toEqual(['dim_customer', 'dim_item']);
    expect(r.facts.map((f) => f.tableName)).toEqual(['fact_orders', 'fact_tickets']);
    expect(r.products.map((p) => p.name)).toEqual(['Core', 'Sales', 'Support']);
    expect(r.relationships).toHaveLength(3);
    expect(r.kpis).toHaveLength(2);
  });

  it('drops a dim when ANY of its source entities is missing, and repairs references', () => {
    const r = instantiateStarSchemaTemplate(T, ['customers', 'items', 'orders', 'tickets'])!; // no item_groups
    expect(r.dimensions.map((d) => d.tableName)).toEqual(['dim_customer']);
    // fact_orders survives (its own entity is there); its dims list is trimmed, dim_date kept
    const orders = r.facts.find((f) => f.tableName === 'fact_orders')!;
    expect(orders.dimensionsUsed).toEqual(['dim_customer', 'dim_date']);
    // relationship to the dropped dim is gone
    expect(r.relationships.some((rel) => rel.toTable === 'dim_item')).toBe(false);
    // Sales lost its owned dim but keeps its fact
    expect(r.products.find((p) => p.name === 'Sales')!.ownedDimensions).toEqual([]);
  });

  it('drops facts, their product (when empty), and their KPIs', () => {
    const r = instantiateStarSchemaTemplate(T, ['customers', 'orders'])!; // no tickets/items
    expect(r.facts.map((f) => f.tableName)).toEqual(['fact_orders']);
    expect(r.products.map((p) => p.name)).toEqual(['Core', 'Sales']);
    expect(r.kpis.map((k) => k.name)).toEqual(['Order value']);
  });

  it('drops a KPI whose required table is dropped even if its product survives', () => {
    const twoFactProduct: StarSchemaTemplate = {
      ...T,
      products: [
        { name: 'Everything', description: 'd', buildOrder: 1, factTables: ['fact_orders', 'fact_tickets'], ownedDimensions: ['dim_customer', 'dim_item'] },
      ],
      kpis: T.kpis.map((k) => ({ ...k, productName: 'Everything' })),
    };
    const r = instantiateStarSchemaTemplate(twoFactProduct, ['customers', 'items', 'item_groups', 'orders'])!;
    expect(r.products).toHaveLength(1);
    expect(r.kpis.map((k) => k.name)).toEqual(['Order value']); // Ticket count dropped with fact_tickets
  });

  it('keeps a product as dims-only when its fact drops but an owned dim survives', () => {
    // Only tickets selected: Core survives (dim_customer), Sales degrades to a
    // dims-only owner? No — Sales owns dim_item, which drops with its
    // entities, so Sales drops entirely. Build order renumbers 1..N.
    const r = instantiateStarSchemaTemplate(T, ['customers', 'tickets'])!;
    expect(r.products.map((p) => [p.name, p.buildOrder])).toEqual([['Core', 1], ['Support', 2]]);

    // When the fact drops but the product still owns a surviving dim, it
    // degrades to dims-only rather than disappearing:
    const t2: StarSchemaTemplate = {
      ...T,
      products: [
        { name: 'Sales', description: 'd', buildOrder: 1, factTables: ['fact_orders'], ownedDimensions: ['dim_customer'] },
        { name: 'Support', description: 'd', buildOrder: 2, factTables: ['fact_tickets'], ownedDimensions: ['dim_item'] },
      ],
    };
    const r2 = instantiateStarSchemaTemplate(t2, ['customers', 'tickets'])!; // orders + items missing
    expect(r2.products.map((p) => [p.name, p.factTables, p.ownedDimensions])).toEqual([
      ['Sales', [], ['dim_customer']],
      ['Support', ['fact_tickets'], []],
    ]);
  });

  it('re-homes a surviving dim with no owner to the first surviving product', () => {
    // Defensive branch: a (malformed) template whose dim has no owner at all.
    const t3: StarSchemaTemplate = {
      ...T,
      products: [
        { name: 'Support', description: 'd', buildOrder: 5, factTables: ['fact_tickets'], ownedDimensions: [] },
      ],
    };
    const r = instantiateStarSchemaTemplate(t3, ['customers', 'tickets'])!;
    expect(r.products).toHaveLength(1);
    expect(r.products[0].ownedDimensions).toEqual(['dim_customer']);
    expect(r.products[0].buildOrder).toBe(1); // renumbered from 5
  });

  it('returns null when no fact survives (caller falls back to the AI designer)', () => {
    expect(instantiateStarSchemaTemplate(T, ['customers'])).toBeNull();
    expect(instantiateStarSchemaTemplate(T, [])).toBeNull();
  });
});

describe('validateStarSchemaTemplate', () => {
  it('accepts the synthetic template', () => {
    expect(validateStarSchemaTemplate(T, ALL)).toEqual([]);
  });

  it('flags structural violations', () => {
    const bad: StarSchemaTemplate = {
      ...T,
      facts: [{ ...T.facts[0], grain: 'per order', dimensionsUsed: ['dim_nope'] }],
      products: [
        { name: 'P1', description: 'd', buildOrder: 1, factTables: ['fact_orders'], ownedDimensions: ['dim_customer'] },
        { name: 'P2', description: 'd', buildOrder: 1, factTables: ['fact_orders'], ownedDimensions: ['dim_item'] },
      ],
      kpis: [{ ...T.kpis[0], productName: 'Ghost', requiresTables: ['fact_missing'] }],
    };
    const errs = validateStarSchemaTemplate(bad, ALL);
    expect(errs.some((e) => e.includes("grain must start with 'One row per'"))).toBe(true);
    expect(errs.some((e) => e.includes("unknown dim 'dim_nope'"))).toBe(true);
    expect(errs.some((e) => e.includes('duplicate buildOrder'))).toBe(true);
    expect(errs.some((e) => e.includes('owned by more than one product'))).toBe(true);
    expect(errs.some((e) => e.includes("productName 'Ghost'"))).toBe(true);
    expect(errs.some((e) => e.includes("unknown table 'fact_missing'"))).toBe(true);
  });

  it('flags source entities missing from the catalog', () => {
    const errs = validateStarSchemaTemplate(T, ['customers']); // most entities absent
    expect(errs.some((e) => e.includes("references 'orders'"))).toBe(true);
  });
});

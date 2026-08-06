/**
 * Star-schema template instantiation tests (pure, no I/O).
 *
 * `instantiateStarSchemaTemplate` is the graceful-degradation contract from
 * docs/SOURCE_ONBOARDING.md Phase F: partial entity selections must yield an
 * internally-consistent sub-template, never a broken one.
 */

import { describe, expect, it } from 'vitest';
import {
  dateKeyColumn,
  dateKeyExpr,
  instantiateStarSchemaTemplate,
  validateStarSchemaTemplate,
  withUnknownMember,
  type StarSchemaTemplate,
} from './starSchema';

/** Minimal synthetic template: 2 dims, 2 facts, 3 products. */
const T: StarSchemaTemplate = {
  version: 1,
  dimensions: [
    {
      tableName: 'dim_customer', displayName: 'Customers', description: 'd',
      sourceEntities: ['customers'],
      sql: withUnknownMember(
        'SELECT id AS customer_id, name FROM customers',
        [
          { name: 'customer_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
          { name: 'name', dataType: 'VARCHAR', displayName: 'Name', description: 'd', role: 'attribute' },
        ],
        { keyColumn: 'customer_id', keyLiteral: '-1', labelColumn: 'name' },
      ),
      columns: [
        { name: 'customer_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
        { name: 'name', dataType: 'VARCHAR', displayName: 'Name', description: 'd', role: 'attribute' },
      ],
    },
    {
      tableName: 'dim_item', displayName: 'Items', description: 'd',
      sourceEntities: ['items', 'item_groups'],
      sql: withUnknownMember(
        'SELECT i.id AS item_id FROM items i JOIN item_groups g ON i.group_id = g.id',
        [{ name: 'item_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' }],
        { keyColumn: 'item_id', keyLiteral: '-1' },
      ),
      columns: [{ name: 'item_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' }],
    },
  ],
  facts: [
    {
      tableName: 'fact_orders', displayName: 'Orders', description: 'd',
      grain: 'One row per order', factTableType: 'transaction',
      sourceEntities: ['orders'],
      dimensionsUsed: ['dim_customer', 'dim_item', 'dim_date'],
      sql: `SELECT id AS order_id, customer_id, item_id, amount, ${dateKeyExpr('ordered_on')} AS order_date_key FROM orders`,
      columns: [
        { name: 'order_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
        { name: 'customer_id', dataType: 'BIGINT', displayName: 'Customer', description: 'd', role: 'foreign_key', fkTargetTable: 'dim_customer', fkTargetColumn: 'customer_id' },
        { name: 'item_id', dataType: 'BIGINT', displayName: 'Item', description: 'd', role: 'foreign_key', fkTargetTable: 'dim_item', fkTargetColumn: 'item_id' },
        { name: 'amount', dataType: 'DECIMAL(18,4)', displayName: 'Amount', description: 'd', role: 'measure', additivity: 'additive' },
        dateKeyColumn('order_date_key', 'Order date key', 'd'),
      ],
    },
    {
      tableName: 'fact_tickets', displayName: 'Tickets', description: 'd',
      grain: 'One row per ticket', factTableType: 'transaction',
      sourceEntities: ['tickets'],
      dimensionsUsed: ['dim_customer', 'dim_date'],
      sql: `SELECT id AS ticket_id, customer_id, ${dateKeyExpr('opened_on')} AS opened_date_key FROM tickets`,
      columns: [
        { name: 'ticket_id', dataType: 'BIGINT', displayName: 'ID', description: 'd', role: 'natural_key' },
        { name: 'customer_id', dataType: 'BIGINT', displayName: 'Customer', description: 'd', role: 'foreign_key', fkTargetTable: 'dim_customer', fkTargetColumn: 'customer_id' },
        dateKeyColumn('opened_date_key', 'Opened date key', 'd'),
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
    { fromTable: 'fact_orders', fromColumn: 'order_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_tickets', fromColumn: 'opened_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
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
    expect(r.relationships).toHaveLength(5);
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

  // ── Joinability ───────────────────────────────────────────────────────────
  // These are the checks that would have caught the orphaned calendar: both
  // templates declared dim_date on every fact and joined it from none, and the
  // whole conformance suite passed anyway.

  it('flags a dimension a fact uses but cannot reach', () => {
    const orphaned: StarSchemaTemplate = {
      ...T,
      relationships: T.relationships.filter((r) => r.toTable !== 'dim_date'),
    };
    const errs = validateStarSchemaTemplate(orphaned, ALL);
    expect(errs.some((e) => e.includes("dimensionsUsed lists 'dim_date' but no relationship joins them"))).toBe(true);
  });

  it('flags a join the fact never declared', () => {
    const undeclared: StarSchemaTemplate = {
      ...T,
      facts: T.facts.map((f) =>
        f.tableName === 'fact_tickets' ? { ...f, dimensionsUsed: ['dim_date'] } : f,
      ),
    };
    const errs = validateStarSchemaTemplate(undeclared, ALL);
    expect(errs.some((e) => e.includes("joins 'dim_customer' but does not list it in dimensionsUsed"))).toBe(true);
  });

  it('requires a dim_date relationship to target date_key', () => {
    const wrongCol: StarSchemaTemplate = {
      ...T,
      relationships: T.relationships.map((r) =>
        r.toTable === 'dim_date' ? { ...r, toColumn: 'full_date' } : r,
      ),
    };
    const errs = validateStarSchemaTemplate(wrongCol, ALL);
    expect(errs.some((e) => e.includes("must target 'date_key'"))).toBe(true);
  });

  it('flags a dimension with no unknown member', () => {
    const noUnknown: StarSchemaTemplate = {
      ...T,
      dimensions: T.dimensions.map((d) =>
        d.tableName === 'dim_item' ? { ...d, sql: 'SELECT id AS item_id FROM items' } : d,
      ),
    };
    const errs = validateStarSchemaTemplate(noUnknown, ALL);
    expect(errs.some((e) => e.includes("dim 'dim_item': no unknown member"))).toBe(true);
  });

  it('refuses a generated surrogate key in a connector template', () => {
    // ROW_NUMBER() keys are regenerated on every full-overwrite refresh, so a
    // dimension rebuilt on its own silently re-points every fact into it.
    const surrogate: StarSchemaTemplate = {
      ...T,
      dimensions: T.dimensions.map((d) =>
        d.tableName === 'dim_item'
          ? { ...d, columns: [{ ...d.columns[0], role: 'surrogate_key' as const }] }
          : d,
      ),
    };
    const errs = validateStarSchemaTemplate(surrogate, ALL);
    expect(errs.some((e) => e.includes('is a surrogate_key'))).toBe(true);
  });

  it('keeps calendar relationships alive through graceful degradation', () => {
    // dim_date is never in the survivor set (the platform injects it), so the
    // relationship filter has to special-case it or the calendar comes back
    // orphaned exactly as before.
    const r = instantiateStarSchemaTemplate(T, ['customers', 'orders'])!;
    expect(r.relationships.some((rel) => rel.toTable === 'dim_date')).toBe(true);
    expect(validateStarSchemaTemplate(r, ALL).filter((e) => !e.includes('entity catalog'))).toEqual([]);
  });
});

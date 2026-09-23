/**
 * Search results as a tree (lib/catalogSearchTree.ts): flat hits come back
 * as catalog › schema › table › columns, in ranking order, subjects first.
 */
import { describe, it, expect } from 'vitest';
import { groupSearchHits, matchRange } from '../lib/catalogSearchTree';
import type { CatalogSearchHit } from '../lib/catalog';

const hit = (over: Partial<CatalogSearchHit>): CatalogSearchHit => ({
  kind: 'table', catalog: 'products', schemaSlug: 'sales_3', schemaLabel: 'Sales',
  tableId: '10', tableLabel: 'Invoice lines', tableName: 'fact_invoice_lines', role: 'fact', ...over,
});

describe('groupSearchHits', () => {
  it('groups a table hit and its column hits under one table, one schema, one catalog', () => {
    const tree = groupSearchHits([
      hit({ kind: 'table' }),
      hit({ kind: 'column', columnName: 'net_amount', columnLabel: 'Net amount' }),
      hit({ kind: 'column', columnName: 'net_amount' }), // a duplicate column hit is folded
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].schemas).toHaveLength(1);
    const t = tree[0].schemas[0].tables[0];
    expect(t.tableMatched).toBe(true);
    expect(t.columns).toEqual([{ name: 'net_amount', label: 'Net amount' }]);
  });

  it('a column-only match leaves tableMatched false, so the tree can render the table unbolded', () => {
    const tree = groupSearchHits([hit({ kind: 'column', columnName: 'vat' })]);
    expect(tree[0].schemas[0].tables[0].tableMatched).toBe(false);
  });

  it('keeps the backend ranking within a schema and puts Subjects before Sources', () => {
    const tree = groupSearchHits([
      hit({ catalog: 'sources', schemaSlug: 'exact_1', schemaLabel: 'Exact', tableId: '1', tableLabel: 'Accounts', tableName: 'Accounts', role: 'source' }),
      hit({ tableId: '11', tableLabel: 'Customers', tableName: 'dim_customer', role: 'dimension' }),
      hit({ tableId: '10' }),
    ]);
    expect(tree.map((c) => c.catalog)).toEqual(['products', 'sources']);
    expect(tree[0].schemas[0].tables.map((t) => t.tableId)).toEqual(['11', '10']);
  });

  it('two schemas of one catalog stay apart', () => {
    const tree = groupSearchHits([
      hit({ schemaSlug: 'sales_3', schemaLabel: 'Sales' }),
      hit({ schemaSlug: 'finance_4', schemaLabel: 'Finance', tableId: '20', tableLabel: 'Ledger', tableName: 'fact_ledger' }),
    ]);
    expect(tree[0].schemas.map((s) => s.schemaLabel)).toEqual(['Sales', 'Finance']);
  });
});

describe('matchRange', () => {
  it('finds the query case-insensitively and returns its span', () => {
    expect(matchRange('waterinfo_meetreeksen_data', 'Meetreeksen')).toEqual([10, 21]);
  });
  it('null when absent or empty', () => {
    expect(matchRange('dim_customer', 'zzz')).toBeNull();
    expect(matchRange('dim_customer', '  ')).toBeNull();
  });
});

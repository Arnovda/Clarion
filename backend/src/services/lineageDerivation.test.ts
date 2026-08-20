/**
 * lineageDerivation — the deterministic column-lineage the builder writes
 * when the AI design omitted lineage[] (which the prompt tells it to do for
 * trivial columns).
 *
 * The guards are the tests that matter: a fact's JOIN to a dimension table
 * (for surrogate keys) must never mint a lineage row — source_table_name
 * means a SOURCE-layer table; CTE names must not be attributable; comments
 * and string literals must not mint aliases.
 */

import { describe, it, expect } from 'vitest';
import { parseAliasMap, deriveColumnLineage, stripSqlNoise } from './lineageDerivation';

const FACT_SQL = `
  -- measures per item-warehouse combination
  SELECT s.ID, s.ItemCode, TRY_CAST(s.CurrentStock AS DOUBLE) AS quantity_on_hand
  FROM ItemWarehouses s
  JOIN Items i ON i.Code = s.ItemCode
  LEFT JOIN dim_item d ON d.item_code = s.ItemCode
`;

const ALLOWED = new Set(['ItemWarehouses', 'Items']);

describe('parseAliasMap', () => {
  it('maps aliases and bare table names from FROM/JOIN', () => {
    const m = parseAliasMap(FACT_SQL);
    expect(m.get('s')).toBe('ItemWarehouses');
    expect(m.get('i')).toBe('Items');
    expect(m.get('items')).toBe('Items');
    expect(m.get('d')).toBe('dim_item');
  });

  it('excludes CTE names — a ref through a CTE is not attributable', () => {
    const m = parseAliasMap('WITH latest AS (SELECT * FROM Items) SELECT * FROM latest l JOIN Warehouses w ON 1=1');
    expect(m.has('latest')).toBe(false);
    expect(m.has('l')).toBe(false);
    expect(m.get('w')).toBe('Warehouses');
    // The CTE body's own FROM still registers its physical table.
    expect(m.get('items')).toBe('Items');
  });

  it('never mints an alias from a comment or string literal', () => {
    const m = parseAliasMap(stripSqlNoise("SELECT 'from FakeTable f' AS note FROM Items -- join Ghost g"));
    expect(m.get('items')).toBe('Items');
    expect(m.has('faketable')).toBe(false);
    expect(m.has('ghost')).toBe(false);
  });
});

describe('deriveColumnLineage', () => {
  const aliasMap = parseAliasMap(FACT_SQL);

  it('a plain copy names its source exactly, described as such', () => {
    expect(deriveColumnLineage('s.ItemCode', aliasMap, ALLOWED)).toEqual([{
      source_table_name: 'ItemWarehouses',
      source_column_name: 'ItemCode',
      transformation_description: 'Copied as-is',
    }]);
  });

  it('a transform keeps the reference but no prose — the expression is the honest description', () => {
    const out = deriveColumnLineage('TRY_CAST(s.CurrentStock AS DOUBLE)', aliasMap, ALLOWED);
    expect(out).toEqual([{
      source_table_name: 'ItemWarehouses',
      source_column_name: 'CurrentStock',
      transformation_description: null,
    }]);
  });

  it('a multi-source expression yields one row per distinct reference', () => {
    const out = deriveColumnLineage("COALESCE(i.Description, s.ItemCode, s.ItemCode)", aliasMap, ALLOWED);
    expect(out).toHaveLength(2);
    expect(out.map((l) => `${l.source_table_name}.${l.source_column_name}`).sort()).toEqual([
      'ItemWarehouses.ItemCode', 'Items.Description',
    ]);
  });

  it('NEVER attributes a dimension-table join — only declared source tables qualify', () => {
    expect(deriveColumnLineage('COALESCE(d.item_key, -1)', aliasMap, ALLOWED)).toEqual([]);
  });

  it('a bare identifier resolves only when the table reads exactly one source', () => {
    const soloMap = parseAliasMap('SELECT * FROM Warehouses');
    expect(deriveColumnLineage('Code', soloMap, new Set(['Warehouses']), 'Warehouses')).toEqual([{
      source_table_name: 'Warehouses',
      source_column_name: 'Code',
      transformation_description: 'Copied as-is',
    }]);
    // Two sources → a bare name is ambiguous → no guess.
    expect(deriveColumnLineage('Code', aliasMap, ALLOWED, undefined)).toEqual([]);
  });

  it('skips storage columns and empty expressions', () => {
    expect(deriveColumnLineage('s._row_hash', aliasMap, ALLOWED)).toEqual([]);
    expect(deriveColumnLineage(null, aliasMap, ALLOWED)).toEqual([]);
    expect(deriveColumnLineage("ROW_NUMBER() OVER (ORDER BY s.ItemCode)", aliasMap, ALLOWED)).toEqual([{
      source_table_name: 'ItemWarehouses',
      source_column_name: 'ItemCode',
      transformation_description: null,
    }]);
  });
});

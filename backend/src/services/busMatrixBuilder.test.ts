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

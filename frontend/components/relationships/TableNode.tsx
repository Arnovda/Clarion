'use client';

import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { KeyRound, Hash, Plus, Minus } from 'lucide-react';
import {
  HEADER_H, ROW_H, FOOTER_H, NODE_W, handleLeft, handleRight, rowCentreY, nodeHeight,
} from './geometry';
import type { GraphColumn } from './types';

export interface TableNodeData {
  tableId: number;
  label: string;
  relationshipCount: number;
  sourceColor: string;
  /** Exactly the columns to render, in order. The parent decides which. */
  columns: GraphColumn[];
  /** How many of the table's columns are not shown. */
  hiddenCount: number;
  /** Columns that are an endpoint of the relationship currently selected. */
  highlightColumnIds: ReadonlySet<number>;
  showingAll: boolean;
  dimmed: boolean;
  /** The table this view is about — rendered as the centre of attention. */
  focused: boolean;
  onToggleAllColumns: (tableId: number) => void;
}

const HANDLE_STYLE: React.CSSProperties = {
  width: 9,
  height: 9,
  background: '#ffffff',
  border: '1.5px solid #b8bec5',
  borderRadius: 9,
};

/**
 * A table on the canvas.
 *
 * It shows the columns it CONNECTS ON, not all of them. A table with forty
 * columns has perhaps three that participate in a relationship; rendering the
 * other thirty-seven buries the answer to the only question being asked, and
 * rendering none makes the user expand things to find it. Showing the join
 * surface means every edge lands on a named field at both ends, immediately.
 *
 * `+N more fields` reveals the rest, which is what drawing a NEW relationship
 * needs — that is the one job that legitimately wants the whole column list.
 *
 * HANDLES ARE SIBLINGS OF THE BOX, NOT CHILDREN. The box clips its content to
 * keep its rounded corners; a handle inside it gets clipped exactly at the node
 * edge, which is the only place it is ever useful.
 */
function TableNodeImpl({ data, selected }: NodeProps<TableNodeData>) {
  const { columns, hiddenCount, showingAll, focused } = data;
  const hasFooter = hiddenCount > 0 || showingAll;
  const height = nodeHeight(columns.length, hasFooter);

  return (
    <div
      style={{ position: 'relative', width: NODE_W, height }}
      className={data.dimmed ? 'opacity-40 transition-opacity' : 'transition-opacity'}
    >
      {/* Whole-node handles, so a table with no shown columns is still linkable. */}
      <Handle
        type="source" position={Position.Left} id={handleLeft('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, left: -5, transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source" position={Position.Right} id={handleRight('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, right: -5, transform: 'translateY(-50%)' }}
      />

      {columns.map((col, i) => {
        const top = rowCentreY(i);
        return (
          <span key={col.id}>
            <Handle
              type="source" position={Position.Left} id={handleLeft(col.id)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, left: -5, transform: 'translateY(-50%)' }}
            />
            <Handle
              type="source" position={Position.Right} id={handleRight(col.id)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, right: -5, transform: 'translateY(-50%)' }}
            />
          </span>
        );
      })}

      <div
        className="overflow-hidden rounded-xl bg-raised"
        style={{
          width: NODE_W,
          height,
          border: `1px solid ${focused ? data.sourceColor : '#d0d5da'}`,
          boxShadow: focused
            ? `0 0 0 4px ${data.sourceColor}26, 0 10px 28px rgba(15,26,34,0.14)`
            : selected
              ? '0 0 0 3px rgba(22,78,99,0.14), 0 6px 18px rgba(15,26,34,0.10)'
              : '0 1px 3px rgba(15,26,34,0.07)',
        }}
      >
        <div className="relative flex items-start gap-2 pl-4 pr-3" style={{ height: HEADER_H }}>
          {/* Source colour lives here and nowhere else: one strong mark reads as
              identity, the same tint spread over header, border and every row
              reads as "everything is beige". */}
          <span
            className="absolute inset-y-0 left-0 w-[5px]"
            style={{ background: data.sourceColor }}
            aria-hidden
          />
          <div className="min-w-0 flex-1 pt-[10px]">
            <div className={`truncate leading-tight text-ink ${focused ? 'text-[14px] font-semibold' : 'text-[13px] font-medium'}`}>
              {data.label}
            </div>
            <div className="truncate text-[11px] leading-tight text-muted">
              {data.relationshipCount === 0
                ? 'Not connected to anything'
                : `${data.relationshipCount} relationship${data.relationshipCount === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>

        {columns.map((col) => {
          const lit = data.highlightColumnIds.has(col.id);
          return (
            <div
              key={col.id}
              className="flex items-center gap-1.5 border-t border-line/50 pl-4 pr-3 text-[11.5px]"
              style={{
                height: ROW_H,
                background: lit ? `${data.sourceColor}1a` : undefined,
                color: lit ? '#0f1a22' : '#334049',
                fontWeight: lit ? 600 : 400,
              }}
            >
              {col.is_measure
                ? <Hash size={11} className="shrink-0 text-muted2" />
                : <KeyRound size={11} className="shrink-0" style={{ color: lit ? data.sourceColor : '#8891a0' }} />}
              <span className="min-w-0 flex-1 truncate">{col.column_name}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted2">
                {(col.data_type ?? '').slice(0, 7)}
              </span>
            </div>
          );
        })}

        {hasFooter && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); data.onToggleAllColumns(data.tableId); }}
            className="flex w-full items-center gap-1.5 border-t border-line/50 pl-4 pr-3 text-left text-[11px] text-muted hover:bg-soft hover:text-ink2"
            style={{ height: FOOTER_H }}
          >
            {data.showingAll ? <Minus size={10} /> : <Plus size={10} />}
            {data.showingAll ? 'Show only linked fields' : `${hiddenCount} more field${hiddenCount === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);

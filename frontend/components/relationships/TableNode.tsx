'use client';

import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { ChevronDown, ChevronRight, KeyRound, Hash } from 'lucide-react';
import {
  HEADER_H, ROW_H, NODE_W, handleLeft, handleRight, rowCentreY, nodeHeight,
} from './geometry';
import type { GraphColumn } from './types';

export interface TableNodeData {
  tableId: number;
  label: string;
  subtitle: string | null;
  relationshipCount: number;
  laneColor: string;
  columns: GraphColumn[];
  expanded: boolean;
  /** Dimmed when a search or filter is active and this node is not a match. */
  dimmed: boolean;
  focused: boolean;
  onToggle: (tableId: number) => void;
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
 * Collapsed by default — name, source colour, relationship count. Sixty tables
 * showing forty columns each is the hairball this design exists to avoid, and a
 * column list nobody is looking at is pure noise. Columns appear when the user
 * expands the node, and only then do per-column handles exist to draw from.
 *
 * HANDLES ARE SIBLINGS OF THE BOX, NOT CHILDREN. The box clips its content to
 * keep its rounded corners; a handle inside it gets clipped exactly at the node
 * edge, which is the only place it is ever useful.
 */
function TableNodeImpl({ data, selected }: NodeProps<TableNodeData>) {
  const { columns, expanded } = data;
  const height = nodeHeight(expanded, columns.length);

  return (
    <div
      style={{ position: 'relative', width: NODE_W, height }}
      className={data.dimmed ? 'opacity-35 transition-opacity' : 'transition-opacity'}
    >
      {/* Whole-node handles — the only drawable anchor while collapsed. */}
      <Handle
        type="source" position={Position.Left} id={handleLeft('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, left: -5, transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source" position={Position.Right} id={handleRight('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, right: -5, transform: 'translateY(-50%)' }}
      />

      {expanded && columns.map((col, i) => {
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
          // Border takes the source colour; selection adds a ring rather than
          // recolouring, so "which system" never stops being readable.
          border: `1px solid ${data.laneColor}55`,
          boxShadow: selected || data.focused
            ? `0 0 0 3px ${data.laneColor}33, 0 6px 18px rgba(15,26,34,0.12)`
            : '0 1px 2px rgba(15,26,34,0.06)',
        }}
      >
        <button
          type="button"
          onClick={() => data.onToggle(data.tableId)}
          className="relative flex w-full items-start gap-2 pl-4 pr-3 text-left"
          style={{ height: HEADER_H, background: `${data.laneColor}14` }}
          title={data.expanded ? 'Hide columns' : 'Show columns'}
        >
          {/* Full-height spine — the strongest and cheapest source cue. */}
          <span
            className="absolute inset-y-0 left-0 w-[4px]"
            style={{ background: data.laneColor }}
            aria-hidden
          />
          <span className="min-w-0 flex-1 pt-[10px]">
            <span className="block truncate text-[13px] font-medium leading-tight text-ink">
              {data.label}
            </span>
            <span className="block truncate text-[11px] leading-tight text-muted">
              {data.relationshipCount === 0
                ? 'No relationships'
                : `${data.relationshipCount} relationship${data.relationshipCount === 1 ? '' : 's'}`}
            </span>
          </span>
          <span className="mt-[17px] shrink-0 text-muted2">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>

        {expanded && columns.map((col) => (
          <div
            key={col.id}
            className="flex items-center gap-1.5 border-t px-3 pl-4 text-[11.5px] text-ink2"
            style={{ height: ROW_H, borderColor: `${data.laneColor}22` }}
          >
            {col.is_measure
              ? <Hash size={11} className="shrink-0 text-muted2" />
              : <KeyRound size={11} className="shrink-0 text-muted2" />}
            <span className="min-w-0 flex-1 truncate">{col.column_name}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted2">
              {(col.data_type ?? '').slice(0, 8)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);

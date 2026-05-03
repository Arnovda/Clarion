'use client';

import dagre from 'dagre';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  Connection, Edge, Node, NodeProps,
  Handle, Position,
  EdgeProps, getBezierPath, EdgeLabelRenderer,
  useReactFlow, ReactFlowProvider, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import api from '@/lib/api';
import { SourceTable, SourceColumn, Relationship } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants — must match exactly so handles line up with column rows
// ─────────────────────────────────────────────────────────────────────────────
export const HEADER_H = 58;  // px — table header block height
export const ROW_H    = 30;  // px — each column row height
export const NODE_W   = 248; // px — fixed node width

// Handle IDs
const hL = (id: number | 'table') => `L_${id}`;
const hR = (id: number | 'table') => `R_${id}`;

function parseHandle(h: string | null | undefined): number | null {
  if (!h) return null;
  const m = h.match(/^[LR]_(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relationship type metadata
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_META: Record<string, { color: string; bg: string; border: string; label: string; src: string; tgt: string }> = {
  many_to_one:  { color: '#d97706', bg: '#fffbeb', border: '#fcd34d', label: 'Many → One',  src: 'N', tgt: '1' },
  one_to_many:  { color: '#2563eb', bg: '#eff6ff', border: '#93c5fd', label: 'One → Many',  src: '1', tgt: 'N' },
  one_to_one:   { color: '#059669', bg: '#ecfdf5', border: '#6ee7b7', label: 'One → One',   src: '1', tgt: '1' },
  many_to_many: { color: '#7c3aed', bg: '#f5f3ff', border: '#c4b5fd', label: 'Many ↔ Many', src: 'N', tgt: 'N' },
};
const getMeta = (t: string) =>
  TYPE_META[t] ?? { color: '#64748b', bg: '#f8fafc', border: '#cbd5e1', label: t, src: '?', tgt: '?' };

// ─────────────────────────────────────────────────────────────────────────────
// Table node
// Handles are siblings of the visual box, NOT inside overflow:hidden.
// Positioned with absolute top values relative to the node root.
// ─────────────────────────────────────────────────────────────────────────────
interface TableNodeData {
  table:          SourceTable;
  columns:        SourceColumn[];
  allColumnCount: number;              // total columns (before filtering)
  relCount:       number;              // number of relationships this table participates in
  searchDimmed:   boolean;             // true when search is active and this table doesn't match
  focused:        boolean;
  focusColId:     number | null;       // column the user clicked (blue tint)
  pairedColIds:   Set<number>;         // paired columns in column-focus mode (amber tint)
  colSideMap:     Map<number, 'N'|'1'>; // table-focus mode: N→blue, 1→orange
  onSelectTable:  (id: number) => void;
  onSelectColumn: (tableId: number, colId: number) => void;
  // Custom-view mode fields
  mode?:            'all' | 'view';
  viewId?:          number | null;
  onShowRelations?: (tableId: number) => void;
  onRemoveFromView?: (tableId: number) => void;
}

const HANDLE_STYLE = {
  width: 10, height: 10,
  background: '#93c5fd',
  border: '2px solid white',
  borderRadius: '50%',
  cursor: 'crosshair',
  zIndex: 20,
};

export function TableNode({ data }: NodeProps<TableNodeData>) {
  const { table, columns, allColumnCount, relCount, searchDimmed, focused, focusColId, pairedColIds, colSideMap,
          onSelectTable, onSelectColumn,
          mode, viewId, onShowRelations, onRemoveFromView } = data;
  // Neutral grays for non-focused; ocean accent only when this table is focused.
  // The AI-draft yellow pill is the page's primary call-to-action; saturated
  // colors here would compete with it.
  const borderColor = focused ? '#0e7490' /* ocean */ : '#cbd5e1' /* slate-300 */;
  const totalH = HEADER_H + columns.length * ROW_H;
  const isViewMode = mode === 'view';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    // Root: position:relative, NO overflow:hidden — handles can poke out the sides
    <div style={{ position: 'relative', width: NODE_W, height: totalH,
      opacity: searchDimmed ? 0.25 : 1, transition: 'opacity 0.2s',
      pointerEvents: searchDimmed ? 'none' : 'auto',
    }}>

      {/* ── Handles — positioned relative to the root div ── */}
      {/* Table-level (header) */}
      <Handle type="source" position={Position.Left}  id={hL('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, left: -5, transform: 'translateY(-50%)' }} />
      <Handle type="source" position={Position.Right} id={hR('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, right: -5, transform: 'translateY(-50%)' }} />

      {/* Column-level */}
      {columns.map((col, i) => {
        const top = HEADER_H + i * ROW_H + ROW_H / 2;
        return (
          <Fragment key={col.id}>
            <Handle type="source" position={Position.Left}  id={hL(col.id)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, left: -5, transform: 'translateY(-50%)' }} />
            <Handle type="source" position={Position.Right} id={hR(col.id)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, right: -5, transform: 'translateY(-50%)' }} />
          </Fragment>
        );
      })}

      {/* ── Visual box — overflow:hidden only here so corners are clean ── */}
      <div style={{
        position: 'absolute', inset: 0,
        border: `2px solid ${borderColor}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: '#fff',
        boxShadow: focused
          ? '0 0 0 3px #bae0e8 /* ocean tint */, 0 4px 20px rgba(14,116,144,.16)'
          : '0 1px 3px rgba(15,23,42,.06), 0 4px 12px rgba(15,23,42,.04)',
      }}>
        {/* Header — clickable to select/highlight this table */}
        <div
          onClick={(e) => { e.stopPropagation(); onSelectTable(table.id); }}
          style={{
            height: HEADER_H,
            // Neutral header — slate-800 baseline, ocean tint when focused.
            background: focused ? '#0f172a' : '#1e293b',
            padding: '9px 12px',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            cursor: 'pointer',
          }}>
          <p style={{ margin: 0, color: '#fff', fontSize: 13, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {table.display_name || table.table_name}
          </p>
          <p style={{ margin: '2px 0 0', color: '#94a3b8' /* slate-400 */, fontSize: 10, fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{table.table_name} · {columns.length === allColumnCount ? `${columns.length} cols` : `${columns.length}/${allColumnCount} cols`}</span>
            {relCount > 0 && (
              <span style={{
                background: 'rgba(255,255,255,0.12)', padding: '0 5px', borderRadius: 99,
                fontSize: 9, fontWeight: 600, color: '#cbd5e1', lineHeight: '16px',
              }}>{relCount} rel{relCount !== 1 ? 's' : ''}</span>
            )}
          </p>
          {table.ai_draft && (
            <span style={{
              position: 'absolute', top: 7, right: isViewMode ? 30 : 10,
              fontSize: 9, background: '#fef3c7', color: '#b45309',
              padding: '1px 6px', borderRadius: 99, fontWeight: 700,
            }}>draft</span>
          )}
          {/* 3-dot menu for custom-view mode */}
          {isViewMode && (
            <div ref={menuRef} className="nopan nodrag nowheel" style={{ position: 'absolute', top: 6, right: 6 }}>
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
                style={{
                  background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4,
                  color: '#fff', cursor: 'pointer', padding: '2px 5px', fontSize: 14, lineHeight: 1,
                }}
              >
                &#8942;
              </button>
              {menuOpen && (
                <div style={{
                  position: 'absolute', top: 26, right: 0, zIndex: 50,
                  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
                  boxShadow: '0 4px 16px rgba(0,0,0,.15)', minWidth: 160, overflow: 'hidden',
                }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onShowRelations?.(table.id); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none',
                      padding: '8px 12px', fontSize: 12, color: '#334155', cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    Show relations
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRemoveFromView?.(table.id); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none',
                      padding: '8px 12px', fontSize: 12, color: '#ef4444', cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#fef2f2')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    Remove from view
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Column rows */}
        {columns.map((col, i) => {
          const dot      = col.is_dimension ? '#a78bfa' : col.is_measure ? '#34d399' : '#cbd5e1';
          const isFocus  = col.id === focusColId;
          const isPaired = pairedColIds.has(col.id);
          const side     = colSideMap.get(col.id);   // 'N' | '1' | undefined

          // Priority: focusCol > N/1 from colSideMap > paired-no-side (amber fallback) > default
          const rowBg   = isFocus    ? '#dbeafe'
                        : side==='N' ? '#dbeafe'
                        : side==='1' ? '#fff7ed'
                        : isPaired   ? '#fef3c7'   // null column IDs — no side known
                        : i % 2 === 0 ? '#fff' : '#f8fafc';
          const leftBdr = isFocus    ? '3px solid #2563eb'
                        : side==='N' ? '3px solid #2563eb'
                        : side==='1' ? '3px solid #f97316'
                        : isPaired   ? '3px solid #f59e0b'
                        : '3px solid transparent';
          const textCol = isFocus || side==='N' ? '#1d4ed8'
                        : side==='1'            ? '#c2410c'
                        : isPaired              ? '#92400e'
                        : '#334155';
          const bold = isFocus || !!side || isPaired;

          return (
            <div
              key={col.id}
              onClick={(e) => { e.stopPropagation(); onSelectColumn(table.id, col.id); }}
              style={{
                height: ROW_H,
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '0 14px',
                background: rowBg,
                borderTop: '1px solid #f1f5f9',
                borderLeft: leftBdr,
                cursor: 'pointer',
              }}
            >
              {/* dimension/measure dot */}
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
              {/* name */}
              <span style={{ fontSize: 11, color: textCol, fontWeight: bold ? 700 : 500,
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {col.display_name || col.column_name}
              </span>
              {/* paired indicator */}
              {isPaired && (
                <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 700, flexShrink: 0 }}>◀</span>
              )}
              {/* type */}
              {!isPaired && (
                <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>
                  {col.data_type?.toLowerCase().slice(0, 7)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Relationship edge — hover tooltip, visual highlight, cardinality badges
// ─────────────────────────────────────────────────────────────────────────────
interface RelEdgeData {
  relType:    string;
  relId:      number;
  selected:   boolean;
  fromLabel:  string;
  toLabel:    string;
  onSelect:   (id: number) => void;
  onHover:    (id: number | null) => void;
  onDelete:   (id: number) => void;
  onConfirm:  (id: number) => void;   // confirm AI draft
  hovered:    boolean;
  dimmed:      boolean;
  highlighted: boolean;
  aiDraft:    boolean;                 // edge comes from AI suggestion
  searchDimmed: boolean;               // dimmed by search filter
  parallelOffset: number;              // curvature offset for fanning parallel edges (0 = default)
  warnings:   string[];                // validation warnings to show as icons
}

function RelationshipEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps<RelEdgeData>) {
  const meta          = getMeta(data?.relType ?? '');
  const isSelected    = data?.selected    ?? false;
  const isHovered     = data?.hovered     ?? false;
  const isDimmed      = data?.dimmed      ?? false;
  const isHighlighted = data?.highlighted ?? false;
  const isAiDraft     = data?.aiDraft     ?? false;
  const isSearchDim   = data?.searchDimmed ?? false;
  const parallelOff   = data?.parallelOffset ?? 0;
  const warnings      = data?.warnings ?? [];
  const hasWarning    = warnings.length > 0;
  const active        = isSelected || isHovered;
  const color         = active ? '#1d4ed8' : isDimmed || isSearchDim ? '#cbd5e1' : hasWarning && !isAiDraft ? '#ef4444' : isAiDraft ? '#f59e0b' : meta.color;
  const strokeW       = active ? 3.5 : isDimmed || isSearchDim ? 1.5 : 2;
  const opacity       = isDimmed || isSearchDim ? 0.15 : 1;
  const markerId      = `arr-${id}`;

  // N/1 label colours: grey unless this edge is explicitly highlighted
  const nColor = (active || isHighlighted) ? '#2563eb' : '#94a3b8';
  const oColor = (active || isHighlighted) ? '#f97316' : '#94a3b8';
  const srcLabelColor = meta.src === 'N' ? nColor : meta.src === '1' ? oColor : '#94a3b8';
  const tgtLabelColor = meta.tgt === 'N' ? nColor : meta.tgt === '1' ? oColor : '#94a3b8';

  // Fan parallel edges apart by varying curvature
  const baseCurvature = 0.35;
  const curvature = baseCurvature + parallelOff * 0.45;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature,
  });

  return (
    <g style={{ opacity, transition: 'opacity 0.2s' }}>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
        </marker>
      </defs>

      {/* White knockout — keeps line readable when it crosses over a node */}
      <path d={edgePath} fill="none" stroke="white" strokeWidth={strokeW + 6} />

      {/* Wide invisible hit zone */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onClick={() => data?.onSelect(data.relId)}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (data && confirm('Delete this relationship?')) data.onDelete(data.relId);
        }}
      />

      {/* Visible stroke */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeW}
        strokeDasharray={isAiDraft ? '6 3' : isSelected ? '7 4' : undefined}
        markerEnd={`url(#${markerId})`}
        style={{ cursor: 'pointer', transition: 'stroke 0.15s, stroke-width 0.15s' }}
        onClick={() => data?.onSelect(data.relId)}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (data && confirm('Delete this relationship?')) data.onDelete(data.relId);
        }}
      />

      <EdgeLabelRenderer>
        {/* Source cardinality — plain text, no box */}
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${
            sourceX + (sourcePosition === Position.Right ? 14 : -14)
          }px,${sourceY - 11}px)`,
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: srcLabelColor }}>
            {meta.src}
          </span>
        </div>

        {/* Target cardinality — plain text, no box */}
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${
            targetX + (targetPosition === Position.Left ? -14 : 14)
          }px,${targetY - 11}px)`,
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: tgtLabelColor }}>
            {meta.tgt}
          </span>
        </div>

        {/* Centre click/hover target — invisible by default, shows label only when active */}
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'all', cursor: 'pointer',
          transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
        }}
          onClick={() => data?.onSelect(data.relId)}
          onMouseEnter={() => data?.onHover(data.relId)}
          onMouseLeave={() => data?.onHover(null)}
        >
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: 'white',
            background: isAiDraft && !active ? '#f59e0b' : color,
            padding: '2px 8px', borderRadius: 99,
            border: `1.5px solid ${isAiDraft && !active ? '#f59e0b' : color}`,
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 4px rgba(0,0,0,.12)',
            transition: 'all 0.15s',
            opacity: active || isAiDraft ? 1 : 0,
            pointerEvents: active || isAiDraft ? 'all' : 'none',
          }}>
            {isAiDraft && !active ? 'draft' : meta.label}
          </span>
          {/* Inline confirm / reject for AI draft edges */}
          {isAiDraft && isHovered && (
            <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
              <button
                onClick={(e) => { e.stopPropagation(); data?.onConfirm(data.relId); }}
                title="Confirm relationship"
                style={{
                  width: 24, height: 24, borderRadius: '50%', border: '2px solid #16a34a',
                  background: '#fff', color: '#16a34a', fontSize: 14, fontWeight: 700,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 1px 4px rgba(0,0,0,.15)',
                }}
              >&#10003;</button>
              <button
                onClick={(e) => { e.stopPropagation(); data?.onDelete(data.relId); }}
                title="Flag issue with relationship"
                style={{
                  width: 24, height: 24, borderRadius: '50%', border: '2px solid #dc2626',
                  background: '#fff', color: '#dc2626', fontSize: 14, fontWeight: 700,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 1px 4px rgba(0,0,0,.15)',
                }}
              >&#10005;</button>
            </div>
          )}
        </div>

        {/* Validation warning icon — always visible when there are warnings */}
        {hasWarning && !isDimmed && !isSearchDim && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'all',
            transform: `translate(-50%,-50%) translate(${labelX + 40}px,${labelY}px)`,
            cursor: 'default',
          }}
            title={warnings.join('\n')}
          >
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              background: '#fef2f2', border: '1.5px solid #fca5a5',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 1px 4px rgba(0,0,0,.1)',
            }}>
              <span style={{ fontSize: 12, color: '#dc2626', fontWeight: 800, lineHeight: 1 }}>!</span>
            </div>
          </div>
        )}

        {/* Hover tooltip — appears above the centre label */}
        {isHovered && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%, -100%) translate(${labelX}px,${labelY - 18}px)`,
            zIndex: 9999,
          }}>
            <div style={{
              background: '#1e293b',
              color: '#f1f5f9',
              borderRadius: 10,
              padding: '8px 12px',
              minWidth: 180,
              maxWidth: 260,
              boxShadow: '0 4px 20px rgba(0,0,0,.25)',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'nowrap',
            }}>
              {/* From */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: '#94a3b8', fontSize: 10 }}>FROM</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{data?.fromLabel ?? '—'}</span>
              </div>
              {/* Arrow + type */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: meta.color, fontWeight: 800, fontSize: 13 }}>{meta.src}</span>
                <div style={{ flex: 1, height: 1.5, background: meta.color, borderRadius: 1 }} />
                <span style={{ fontSize: 10, color: meta.color, fontWeight: 700 }}>{meta.label}</span>
                <div style={{ flex: 1, height: 1.5, background: meta.color, borderRadius: 1 }} />
                <span style={{ color: meta.color, fontWeight: 800, fontSize: 13 }}>{meta.tgt}</span>
              </div>
              {/* To */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#94a3b8', fontSize: 10 }}>TO</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{data?.toLabel ?? '—'}</span>
              </div>
              {/* Warnings */}
              {warnings.length > 0 && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #334155' }}>
                  {warnings.map((w, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: i > 0 ? 2 : 0 }}>
                      <span style={{ color: '#fca5a5', fontSize: 10 }}>⚠</span>
                      <span style={{ color: '#fca5a5', fontSize: 10 }}>{w}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Arrow pointing down */}
              <div style={{
                position: 'absolute', bottom: -6, left: '50%',
                transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop: '6px solid #1e293b',
              }} />
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
}

const nodeTypes = { tableNode: TableNode };
const edgeTypes = { relEdge: RelationshipEdge };

// ─────────────────────────────────────────────────────────────────────────────
// New-relationship dialog
// ─────────────────────────────────────────────────────────────────────────────
interface PendingConn {
  fromTableId: number; toTableId: number;
  fromColId: number | null; toColId: number | null;
}

// ── Smart column matching: guesses FK→PK pair between two tables ──
function guessColumnPair(
  fromTable: SourceTable, toTable: SourceTable,
  fromCols: SourceColumn[], toCols: SourceColumn[],
): { fromColId: string; toColId: string; type: string } | null {
  const toName = (toTable.table_name ?? '').toLowerCase().replace(/s$/, ''); // singular
  const fromName = (fromTable.table_name ?? '').toLowerCase().replace(/s$/, '');

  // Strategy 1: fromTable has {toTableName}_id → toTable has id
  const fkCol = fromCols.find((c) => {
    const cn = c.column_name.toLowerCase();
    return cn === `${toName}_id` || cn === `${toName}id` || cn === `fk_${toName}`;
  });
  const pkCol = toCols.find((c) => {
    const cn = c.column_name.toLowerCase();
    return cn === 'id' || cn === `${toName}_id` || cn === `pk_${toName}`;
  });
  if (fkCol && pkCol) return { fromColId: String(fkCol.id), toColId: String(pkCol.id), type: 'many_to_one' };

  // Strategy 2: reverse — toTable has {fromTableName}_id → fromTable has id
  const revFk = toCols.find((c) => {
    const cn = c.column_name.toLowerCase();
    return cn === `${fromName}_id` || cn === `${fromName}id` || cn === `fk_${fromName}`;
  });
  const revPk = fromCols.find((c) => {
    const cn = c.column_name.toLowerCase();
    return cn === 'id' || cn === `${fromName}_id` || cn === `pk_${fromName}`;
  });
  if (revFk && revPk) return { fromColId: String(revPk.id), toColId: String(revFk.id), type: 'one_to_many' };

  // Strategy 3: exact column name match (e.g. both have "product_id")
  for (const fc of fromCols) {
    const cn = fc.column_name.toLowerCase();
    if (!cn.endsWith('_id') && !cn.endsWith('id')) continue;
    const match = toCols.find((tc) => tc.column_name.toLowerCase() === cn);
    if (match) return { fromColId: String(fc.id), toColId: String(match.id), type: 'many_to_one' };
  }

  return null;
}

function NewRelDialog({
  pending, tables, allColumns, onConfirm, onCancel,
}: {
  pending: PendingConn; tables: SourceTable[];
  allColumns: Record<number, SourceColumn[]>;
  onConfirm: (fCol: number | null, tCol: number | null, type: string) => void;
  onCancel: () => void;
}) {
  const ft = tables.find((t) => t.id === pending.fromTableId);
  const tt = tables.find((t) => t.id === pending.toTableId);

  // Smart column matching — auto-suggest when no columns were explicitly dragged
  const suggestion = useMemo(() => {
    if (pending.fromColId || pending.toColId) return null;   // user already picked handles
    if (!ft || !tt) return null;
    return guessColumnPair(ft, tt, allColumns[ft.id] ?? [], allColumns[tt.id] ?? []);
  }, [pending.fromColId, pending.toColId, ft, tt, allColumns]);

  const [fromCol, setFromCol] = useState(
    pending.fromColId ? String(pending.fromColId) : suggestion?.fromColId ?? '',
  );
  const [toCol, setToCol] = useState(
    pending.toColId ? String(pending.toColId) : suggestion?.toColId ?? '',
  );
  const [type, setType] = useState(suggestion?.type ?? 'many_to_one');
  const [showSuggestion, setShowSuggestion] = useState(!!suggestion);

  if (!ft || !tt) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm space-y-4">
        <div>
          <h3 className="font-bold text-slate-900">New relationship</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            <span className="font-semibold text-slate-700">{ft.display_name || ft.table_name}</span>
            <span className="mx-2 text-slate-400">→</span>
            <span className="font-semibold text-slate-700">{tt.display_name || tt.table_name}</span>
          </p>
        </div>

        {/* Smart suggestion banner */}
        {showSuggestion && suggestion && (
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            <span className="text-blue-500 text-sm mt-0.5">💡</span>
            <div className="flex-1">
              <p className="text-xs font-medium text-blue-700">Auto-detected column match</p>
              <p className="text-[10px] text-blue-600 mt-0.5">
                {(allColumns[ft.id] ?? []).find((c) => String(c.id) === suggestion.fromColId)?.column_name}
                {' → '}
                {(allColumns[tt.id] ?? []).find((c) => String(c.id) === suggestion.toColId)?.column_name}
              </p>
            </div>
            <button onClick={() => {
              setFromCol(''); setToCol(''); setType('many_to_one'); setShowSuggestion(false);
            }} className="text-blue-400 hover:text-blue-600 text-xs" title="Dismiss suggestion">✕</button>
          </div>
        )}

        {([
          { label: 'From column', tid: pending.fromTableId, val: fromCol, set: setFromCol },
          { label: 'To column',   tid: pending.toTableId,   val: toCol,   set: setToCol   },
        ] as const).map(({ label, tid, val, set }) => (
          <div key={label}>
            <label className="text-xs font-medium text-slate-500 block mb-1">
              {label} <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <select value={val} onChange={(e) => set(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— any column —</option>
              {(allColumns[tid] ?? []).map((c) => (
                <option key={c.id} value={String(c.id)}>{c.display_name || c.column_name}</option>
              ))}
            </select>
          </div>
        ))}

        <div>
          <label className="text-xs font-medium text-slate-500 block mb-2">Relationship type</label>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(TYPE_META).map(([key, m]) => (
              <button key={key} onClick={() => setType(key)}
                style={type === key ? { background: m.bg, borderColor: m.color } : {}}
                className={`py-2 rounded-lg border text-center transition-all ${
                  type === key ? '' : 'border-slate-200 hover:border-slate-300'
                }`}>
                <span style={{ color: m.color, fontWeight: 800, fontSize: 13, display: 'block' }}>
                  {m.src}→{m.tgt}
                </span>
                <span style={{ color: type === key ? m.color : '#94a3b8', fontSize: 9 }}>{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-1">
          <button onClick={() => onConfirm(fromCol ? Number(fromCol) : null, toCol ? Number(toCol) : null, type)}
            className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 font-medium transition-colors">
            Save relationship
          </button>
          <button onClick={onCancel}
            className="px-4 py-2 border border-slate-200 text-sm rounded-lg hover:bg-slate-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Right panel
// ─────────────────────────────────────────────────────────────────────────────
interface PanelProps {
  relationships: Relationship[]; tables: SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  connectionId: string;
  selectedRelId: number | null;
  onSelect: (id: number | null) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: string) => void;
  onReload: () => void;
  onResetLayout: () => void;
  draftCount: number;
  onStartDraftReview: () => void;
}

function RelationshipPanel({ relationships, tables, columnsByTable, connectionId, selectedRelId, onSelect, onDelete, onChangeType, onReload, onResetLayout, draftCount, onStartDraftReview }: PanelProps) {
  const [reSuggesting, setReSuggesting] = useState(false);
  const [reSuggestStatus, setReSuggestStatus] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  function handleCancel() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setReSuggesting(false);
      setReSuggestStatus('Cancelled');
      setTimeout(() => setReSuggestStatus(''), 2000);
    }
  }

  async function handleReSuggest() {
    if (!confirm('This will delete all AI-draft relationships and re-generate them with correct column links. Manually confirmed relationships are kept. Continue?')) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setReSuggesting(true);
    setReSuggestStatus('Starting…');
    try {
      const token = localStorage.getItem('databridge_token');
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'}/semantic/relationships/re-suggest?connectionId=${connectionId}`, {
        method: 'POST',
        headers: {
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6));
                setReSuggestStatus(evt.message ?? '');
              } catch { /* ignore parse errors */ }
            }
          }
        }
      }

      abortRef.current = null;
      await onReload();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // cancelled by user
      setReSuggestStatus(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setTimeout(() => {
        setReSuggesting(false);
        setReSuggestStatus('');
      }, 2000);
    }
  }
  const tName = (id: number) => { const t = tables.find((t) => t.id === id); return t?.display_name || t?.table_name || '—'; };
  const cName = (tid: number, cid: number | null) => {
    if (!cid) return null;
    const c = (columnsByTable[tid] ?? []).find((c) => c.id === cid);
    return c?.display_name || c?.column_name || null;
  };
  const sel = selectedRelId ? relationships.find((r) => r.id === selectedRelId) : null;

  return (
    <div className="flex flex-col bg-white border-l border-slate-200 flex-shrink-0" style={{ width: 280 }}>
      <div className="px-4 py-3 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm font-bold text-slate-800">Relationships</p>
            <p className="text-[11px] text-slate-400">{relationships.length} defined · click a line to inspect</p>
          </div>
          {sel && (
            <button onClick={() => onSelect(null)}
              className="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors">
              ← All
            </button>
          )}
        </div>
        {/* Action buttons */}
        {!sel && (
          <div className="flex gap-2">
            <button
              onClick={handleReSuggest}
              disabled={reSuggesting}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {reSuggesting ? (
                <>
                  <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  Re-suggesting…
                </>
              ) : <>⚡ Re-suggest</>}
            </button>
            {reSuggesting && (
              <button
                onClick={handleCancel}
                className="flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
                title="Cancel re-suggest"
              >
                ✕ Cancel
              </button>
            )}
            <button
              onClick={onResetLayout}
              title="Reset to auto-layout"
              className="flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
            >
              ↺ Layout
            </button>
          </div>
        )}
        {reSuggestStatus && (
          <div className="text-xs text-blue-600 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 animate-pulse">
            {reSuggestStatus}
          </div>
        )}
        {!sel && (
          <button
            onClick={onStartDraftReview}
            disabled={draftCount === 0}
            className={`w-full flex items-center justify-center gap-1.5 mt-2 py-2 text-xs font-semibold rounded-lg transition-colors ${
              draftCount > 0
                ? 'text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200'
                : 'text-slate-400 bg-slate-50 border border-slate-200 cursor-default'
            }`}
          >
            <span>⚡</span> Review all drafts
            {draftCount > 0 ? (
              <span className="ml-1 px-1.5 py-0 bg-amber-200 text-amber-800 rounded-full text-[10px] font-bold">{draftCount}</span>
            ) : (
              <span className="ml-1 text-[10px] text-slate-400">none</span>
            )}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Detail view */}
        {sel && (() => {
          const m = getMeta(sel.relationship_type);
          return (
            <div className="p-4 space-y-4">
              <div className="bg-slate-50 rounded-xl p-4 space-y-2.5">
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">From</p>
                  <p className="text-sm font-bold text-slate-800 mt-0.5">{tName(sel.from_table_id)}</p>
                  <p className="text-xs font-mono text-slate-500">
                    {cName(sel.from_table_id, sel.from_column_id) ?? <span className="italic text-slate-400">any column</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2 pl-1">
                  <span style={{ fontSize: 12, fontWeight: 800, color: m.color, background: m.bg, padding: '1px 6px', borderRadius: 99, border: `1px solid ${m.border}` }}>{m.src}</span>
                  <div style={{ flex: 1, height: 2, background: m.color, borderRadius: 1 }} />
                  <svg width="8" height="10" viewBox="0 0 8 10"><path d="M0 0 L8 5 L0 10z" fill={m.color} /></svg>
                  <span style={{ fontSize: 12, fontWeight: 800, color: m.color, background: m.bg, padding: '1px 6px', borderRadius: 99, border: `1px solid ${m.border}` }}>{m.tgt}</span>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">To</p>
                  <p className="text-sm font-bold text-slate-800 mt-0.5">{tName(sel.to_table_id)}</p>
                  <p className="text-xs font-mono text-slate-500">
                    {cName(sel.to_table_id, sel.to_column_id) ?? <span className="italic text-slate-400">any column</span>}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-500 mb-2">Relationship type</p>
                <div className="space-y-1.5">
                  {Object.entries(TYPE_META).map(([key, m]) => (
                    <button key={key} onClick={() => onChangeType(sel.id, key)}
                      style={sel.relationship_type === key ? { background: m.bg, borderColor: m.color } : {}}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-all ${sel.relationship_type === key ? '' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: m.color, minWidth: 44 }}>{m.src}→{m.tgt}</span>
                      <span style={{ fontSize: 11, color: sel.relationship_type === key ? m.color : '#94a3b8' }}>{m.label}</span>
                      {sel.relationship_type === key && (
                        <svg className="ml-auto w-4 h-4" style={{ color: m.color }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {sel.ai_draft && (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <span className="text-amber-400">⚡</span>
                  <p className="text-xs text-amber-700">AI-suggested — review and confirm</p>
                </div>
              )}

              <button onClick={() => { onDelete(sel.id); onSelect(null); }}
                className="w-full py-2 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors font-medium">
                Delete relationship
              </button>
            </div>
          );
        })()}

        {/* List view */}
        {!sel && (
          <div className="p-3 space-y-2">
            {relationships.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <p className="text-3xl mb-2">🔗</p>
                <p className="text-sm font-medium">No relationships yet</p>
                <p className="text-xs mt-1 px-4">Drag from a column handle (●) on the side of a node to another node's column</p>
              </div>
            )}
            {relationships.map((r) => {
              const m = getMeta(r.relationship_type);
              const fc = cName(r.from_table_id, r.from_column_id);
              const tc = cName(r.to_table_id,   r.to_column_id);
              return (
                <button key={r.id} onClick={() => onSelect(r.id)}
                  className="w-full text-left bg-slate-50 hover:bg-blue-50 border border-slate-100 hover:border-blue-200 rounded-xl p-3 transition-all group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-700 truncate">
                        {tName(r.from_table_id)}{fc && <span className="font-mono text-slate-400">.{fc}</span>}
                      </p>
                      <div className="flex items-center gap-1 my-0.5">
                        <span style={{ fontSize: 10, fontWeight: 800, color: m.color }}>{m.src}</span>
                        <div style={{ width: 20, height: 1.5, background: m.color, borderRadius: 1 }} />
                        <svg width="5" height="7" viewBox="0 0 5 7"><path d="M0 0 L5 3.5 L0 7z" fill={m.color} /></svg>
                        <span style={{ fontSize: 10, fontWeight: 800, color: m.color }}>{m.tgt}</span>
                        <span style={{ fontSize: 9, color: m.color, opacity: 0.8, marginLeft: 2 }}>{m.label}</span>
                      </div>
                      <p className="text-xs font-semibold text-slate-700 truncate">
                        {tName(r.to_table_id)}{tc && <span className="font-mono text-slate-400">.{tc}</span>}
                      </p>
                    </div>
                    <svg className="w-4 h-4 text-slate-300 group-hover:text-blue-400 mt-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                  {r.ai_draft && <span className="text-[9px] px-1.5 bg-amber-100 text-amber-600 rounded font-medium">AI draft</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100 space-y-1">
        {Object.entries(TYPE_META).map(([k, m]) => (
          <div key={k} className="flex items-center gap-2">
            <div style={{ width: 18, height: 2, background: m.color, borderRadius: 1 }} />
            <span style={{ color: m.color, fontSize: 10, fontWeight: 700 }}>{m.src}→{m.tgt}</span>
            <span className="text-[10px] text-slate-400">{m.label}</span>
          </div>
        ))}
        <p className="text-[10px] text-slate-400 pt-1 border-t border-slate-50 mt-1">
          ● = column handle · drag to create · click line to inspect
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas controller
// ─────────────────────────────────────────────────────────────────────────────
function CanvasController({ zoomToTableId }: { zoomToTableId: number | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!zoomToTableId) return;
    const t = setTimeout(() => {
      fitView({ nodes: [{ id: String(zoomToTableId) }], duration: 600, padding: 0.4, maxZoom: 1.1 });
    }, 150);
    return () => clearTimeout(t);
  }, [zoomToTableId, fitView]);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dagre layout — arranges nodes hierarchically so edges never cross through them
// N-side tables go LEFT, 1-side (parent) tables go RIGHT
// ─────────────────────────────────────────────────────────────────────────────

function getDagrePositions(
  tables:         SourceTable[],
  columnsByTable: Record<number, SourceColumn[]>,
  relationships:  Relationship[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir:  'LR',   // left → right: N-side left, 1-side right
    ranksep:  160,    // horizontal gap between ranks
    nodesep:  40,     // vertical gap between nodes in the same column
    marginx:  40,
    marginy:  40,
  });

  // Register every node with its actual pixel dimensions
  tables.forEach((t) => {
    const h = HEADER_H + (columnsByTable[t.id]?.length ?? 0) * ROW_H;
    g.setNode(String(t.id), { width: NODE_W, height: h });
  });

  // Edges define the hierarchy (dagre uses these to rank nodes)
  relationships.forEach((r) => {
    g.setEdge(String(r.from_table_id), String(r.to_table_id));
  });

  dagre.layout(g);

  // dagre centers nodes on (x,y); React Flow positions from top-left corner
  const positions = new Map<string, { x: number; y: number }>();
  tables.forEach((t) => {
    const n = g.node(String(t.id));
    if (n) {
      const h = HEADER_H + (columnsByTable[t.id]?.length ?? 0) * ROW_H;
      positions.set(String(t.id), { x: n.x - NODE_W / 2, y: n.y - h / 2 });
    }
  });
  return positions;
}

// Fallback grid used only before relationships have loaded
function gridFallback(i: number): { x: number; y: number } {
  return { x: (i % 3) * (NODE_W + 160) + 60, y: Math.floor(i / 3) * 380 + 60 };
}

function buildNodes(
  tables:          SourceTable[],
  columnsByTable:  Record<number, SourceColumn[]>,
  posMap:          Map<string, { x: number; y: number }>,
  focusTableId:    number | null,
  focusColId:      number | null,
  pairedColIds:    Set<number>,
  colSideMap:      Map<number, 'N' | '1'>,
  onSelectTable:   (id: number) => void,
  onSelectColumn:  (tableId: number, colId: number) => void,
  viewMode?:       { mode: 'view'; viewId: number; onShowRelations: (id: number) => void; onRemoveFromView: (id: number) => void },
  relationshipColIds?: Set<number>,
  relCountMap?: Map<number, number>,   // table id → relationship count
  searchDimmedIds?: Set<number>,       // tables that don't match the search query
): Node[] {
  return tables.map((t, i) => {
    const allCols = columnsByTable[t.id] ?? [];
    const cols = relationshipColIds
      ? allCols.filter((c) => relationshipColIds.has(c.id))
      : allCols;
    return {
      id:       String(t.id),
      type:     'tableNode',
      position: posMap.get(String(t.id)) ?? gridFallback(i),
      data: {
        table:          t,
        columns:        cols,
        allColumnCount: allCols.length,
        relCount:       relCountMap?.get(t.id) ?? 0,
        searchDimmed:   searchDimmedIds?.has(t.id) ?? false,
        focused:        t.id === focusTableId,
        focusColId,
        pairedColIds,
        colSideMap,
        onSelectTable,
        onSelectColumn,
        ...(viewMode ? {
          mode:              viewMode.mode,
          viewId:            viewMode.viewId,
          onShowRelations:   viewMode.onShowRelations,
          onRemoveFromView:  viewMode.onRemoveFromView,
        } : {}),
      },
    };
  });
}

function buildEdges(
  relationships:    Relationship[],
  tables:           SourceTable[],
  columnsByTable:   Record<number, SourceColumn[]>,
  posMap:           Map<string, { x: number; y: number }>,
  selectedRelId:    number | null,
  hoveredRelId:     number | null,
  onSelect:         (id: number) => void,
  onHover:          (id: number | null) => void,
  highlightRelIds:  Set<number>,   // non-empty = filter active
  onDelete:         (id: number) => void,
  onConfirm:        (id: number) => void,
  searchDimmedIds?: Set<number>,
): Edge[] {
  const hasFilter = highlightRelIds.size > 0;
  const tName = (id: number) => { const t = tables.find((t) => t.id === id); return t?.display_name || t?.table_name || ''; };
  const cName = (tid: number, cid: number | null) => {
    if (!cid) return null;
    const c = (columnsByTable[tid] ?? []).find((c) => c.id === cid);
    return c?.display_name || c?.column_name || null;
  };

  // ── Parallel edge detection: group edges by table pair ──
  const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const pairGroups = new Map<string, number[]>(); // key → list of rel ids
  relationships.forEach((r) => {
    const k = pairKey(r.from_table_id, r.to_table_id);
    if (!pairGroups.has(k)) pairGroups.set(k, []);
    pairGroups.get(k)!.push(r.id);
  });
  // For each rel, compute its offset within its parallel group: 0, ±1, ±2 …
  const parallelOffsets = new Map<number, number>();
  pairGroups.forEach((ids) => {
    if (ids.length <= 1) { parallelOffsets.set(ids[0], 0); return; }
    ids.forEach((id, i) => {
      // Center the group around 0: e.g. 3 edges → offsets -1, 0, +1
      const offset = i - (ids.length - 1) / 2;
      parallelOffsets.set(id, offset);
    });
  });

  // ── Validation warnings ──
  // 1) Duplicate detection: same from_table+to_table+from_col+to_col
  const dupKeys = new Map<string, number>();
  const dupRelIds = new Set<number>();
  relationships.forEach((r) => {
    const dk = `${r.from_table_id}:${r.to_table_id}:${r.from_column_id ?? ''}:${r.to_column_id ?? ''}`;
    if (dupKeys.has(dk)) { dupRelIds.add(r.id); dupRelIds.add(dupKeys.get(dk)!); }
    else dupKeys.set(dk, r.id);
  });

  // 2) Build a quick set of existing column IDs per table for orphan detection
  const colIdSets = new Map<number, Set<number>>();
  for (const [tid, cols] of Object.entries(columnsByTable)) {
    colIdSets.set(Number(tid), new Set(cols.map((c) => c.id)));
  }

  return relationships.map((r) => {
    const srcPos  = posMap.get(String(r.from_table_id));
    const tgtPos  = posMap.get(String(r.to_table_id));
    const srcIsRight = srcPos && tgtPos ? srcPos.x > tgtPos.x : false;

    const srcHandle = r.from_column_id
      ? (srcIsRight ? hL(r.from_column_id) : hR(r.from_column_id))
      : (srcIsRight ? hL('table')           : hR('table'));
    const tgtHandle = r.to_column_id
      ? (srcIsRight ? hR(r.to_column_id) : hL(r.to_column_id))
      : (srcIsRight ? hR('table')         : hL('table'));

    const fc = cName(r.from_table_id, r.from_column_id);
    const tc = cName(r.to_table_id,   r.to_column_id);
    const fromLabel = fc ? `${tName(r.from_table_id)}.${fc}` : tName(r.from_table_id);
    const toLabel   = tc ? `${tName(r.to_table_id)}.${tc}`   : tName(r.to_table_id);

    // Compute warnings
    const warnings: string[] = [];
    if (!r.from_column_id && !r.to_column_id) {
      warnings.push('No column assignment — join columns not specified');
    } else if (!r.from_column_id || !r.to_column_id) {
      warnings.push('Partial column assignment — one side is missing');
    }
    if (dupRelIds.has(r.id)) {
      warnings.push('Exact duplicate — identical join already exists (same tables + same columns)');
    }
    // Orphan FK: column ID references a column not present in the table
    if (r.from_column_id && colIdSets.has(r.from_table_id) && !colIdSets.get(r.from_table_id)!.has(r.from_column_id)) {
      warnings.push('Orphan FK — from-column not found in source table');
    }
    if (r.to_column_id && colIdSets.has(r.to_table_id) && !colIdSets.get(r.to_table_id)!.has(r.to_column_id)) {
      warnings.push('Orphan FK — to-column not found in target table');
    }

    return {
      id:           `rel-${r.id}`,
      source:       String(r.from_table_id),
      target:       String(r.to_table_id),
      sourceHandle: srcHandle,
      targetHandle: tgtHandle,
      type:         'relEdge',
      data: {
        relType:   r.relationship_type ?? 'many_to_one',
        relId:     r.id,
        selected:  r.id === selectedRelId,
        hovered:   r.id === hoveredRelId,
        dimmed:      hasFilter && !highlightRelIds.has(r.id),
        highlighted: hasFilter &&  highlightRelIds.has(r.id),
        aiDraft:     r.ai_draft ?? false,
        searchDimmed: searchDimmedIds ? (searchDimmedIds.has(r.from_table_id) && searchDimmedIds.has(r.to_table_id)) : false,
        parallelOffset: parallelOffsets.get(r.id) ?? 0,
        warnings,
        fromLabel, toLabel,
        onSelect, onHover, onDelete, onConfirm,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner canvas
// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  connectionId:      string;
  tables:            SourceTable[];
  columnsByTable:    Record<number, SourceColumn[]>;
  focusTableId?:     number | null;   // drives highlighting
  focusColumnId?:    number | null;
  zoomToTableId?:    number | null;   // drives zoom — only set from left pane clicks
  onSelectTable?:    (id: number) => void;
  onSelectColumn?:   (tableId: number, colId: number) => void;
  onClearSelection?: () => void;
  viewId?:           number | null;   // when set, operate in custom-view mode
  /**
   * Hide the right-side relationships panel. Used by the new /catalog
   * SourceRootPanel where the panel is redundant — the List + Review queue
   * tabs cover the same ground with better UX.
   */
  hideSidebar?:      boolean;
}

function Canvas({ connectionId, tables, columnsByTable, focusTableId, focusColumnId,
                  zoomToTableId, onSelectTable, onSelectColumn, onClearSelection, viewId,
                  hideSidebar }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [selectedRelId, setSelectedRelId] = useState<number | null>(null);
  const [hoveredRelId,  setHoveredRelId]  = useState<number | null>(null);
  const [pendingConn,   setPendingConn]   = useState<PendingConn | null>(null);

  // ── Compact mode: only show relationship columns ──
  // Default ON: wide schemas (ExactOnline Accounts has 163 cols) make
  // full-mode nodes ~5000px tall, which forces fit-view to zoom way out
  // and renders text unreadable. Compact mode hides non-relationship
  // columns, keeping nodes a reasonable height. The user can toggle it
  // off (button or "C" key) to see every column when they need to.
  const [compactMode, setCompactMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // ── Bulk draft review mode ──
  const [draftReviewActive, setDraftReviewActive] = useState(false);
  const [draftReviewIdx, setDraftReviewIdx]       = useState(0);

  // ── Custom-view mode state ──
  const isViewMode = viewId != null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [viewDetail, setViewDetail] = useState<any>(null);
  const viewTables = useMemo<SourceTable[]>(() => {
    if (!isViewMode || !viewDetail?.viewTables) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return viewDetail.viewTables.map((vt: any) => ({
      id: vt.table_id,
      connection_id: 0,
      table_name: vt.table_name,
      display_name: vt.display_name || vt.table_name,
      description: '',
      ai_draft: false,
      is_active: true,
    }));
  }, [isViewMode, viewDetail]);
  const viewColumnsByTable = useMemo<Record<number, SourceColumn[]>>(() => {
    if (!isViewMode || !viewDetail?.viewTables) return {};
    const map: Record<number, SourceColumn[]> = {};
    // Columns arrive as a flat array with table_id on each entry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allCols: any[] = viewDetail.columns ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of allCols) {
      const tid = c.table_id;
      if (!map[tid]) map[tid] = [];
      map[tid].push({
        id: c.id ?? c.column_id,
        table_id: tid,
        column_name: c.column_name,
        display_name: c.display_name || c.column_name,
        description: c.description ?? '',
        data_type: c.data_type ?? '',
        example_values: c.example_values ?? null,
        is_dimension: c.is_dimension ?? false,
        is_measure: c.is_measure ?? false,
        ai_draft: c.ai_draft ?? false,
      } as SourceColumn);
    }
    return map;
  }, [isViewMode, viewDetail]);
  const viewRelationships = useMemo<Relationship[]>(() => {
    if (!isViewMode || !viewDetail?.relationships) return [];
    const tableIds = new Set(viewTables.map((t) => t.id));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (viewDetail.relationships ?? []).filter((r: any) =>
      tableIds.has(r.from_table_id) && tableIds.has(r.to_table_id)
    ).map((r: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      id: r.id,
      from_table_id: r.from_table_id,
      from_column_id: r.from_column_id ?? null,
      to_table_id: r.to_table_id,
      to_column_id: r.to_column_id ?? null,
      from_table_name: r.from_table_name ?? '',
      to_table_name: r.to_table_name ?? '',
      relationship_type: r.relationship_type ?? 'many_to_one',
      description: r.description ?? r.label ?? '',
      ai_draft: r.ai_draft ?? false,
    }));
  }, [isViewMode, viewDetail, viewTables]);

  // Effective tables/columns/rels for current mode
  const effTables         = isViewMode ? viewTables : tables;
  const effColumnsByTable = isViewMode ? viewColumnsByTable : columnsByTable;
  const effRelationships  = isViewMode ? viewRelationships : relationships;

  // Stable map of node id → position (preserves user-dragged positions)
  const posMap            = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Set to true on first relationship load or when user clicks "Reset layout"
  const needsDagreLayout  = useRef(true);

  // ── Load view detail when viewId changes ──
  const reloadViewDetail = useCallback(async () => {
    if (!viewId) { setViewDetail(null); return; }
    try {
      const res = await api.get(`/cross-views/${viewId}`);
      setViewDetail(res.data.data ?? res.data);
    } catch { setViewDetail(null); }
  }, [viewId]);

  useEffect(() => {
    if (isViewMode) {
      posMap.current.clear();
      needsDagreLayout.current = true;
      reloadViewDetail();
    }
  }, [isViewMode, reloadViewDetail]);

  // Seed posMap from view detail pos_x/pos_y
  useEffect(() => {
    if (!isViewMode || !viewDetail?.viewTables) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewDetail.viewTables.forEach((vt: any) => {
      if (vt.pos_x != null && vt.pos_y != null) {
        posMap.current.set(String(vt.table_id), { x: vt.pos_x, y: vt.pos_y });
      }
    });
    needsDagreLayout.current = false;
  }, [isViewMode, viewDetail]);

  // ── Compute highlight / dim sets from current focus ──
  const highlightRelIds = useMemo(() => {
    const ids = new Set<number>();
    if (focusColumnId) {
      effRelationships.forEach((r) => {
        if (r.from_column_id === focusColumnId || r.to_column_id === focusColumnId) ids.add(r.id);
      });
    } else if (focusTableId) {
      effRelationships.forEach((r) => {
        if (r.from_table_id === focusTableId || r.to_table_id === focusTableId) ids.add(r.id);
      });
    }
    return ids;
  }, [focusColumnId, focusTableId, effRelationships]);

  const pairedColIds = useMemo(() => {
    const ids = new Set<number>();
    if (focusColumnId) {
      effRelationships.forEach((r) => {
        if (r.from_column_id === focusColumnId && r.to_column_id)   ids.add(r.to_column_id);
        if (r.to_column_id   === focusColumnId && r.from_column_id) ids.add(r.from_column_id);
      });
    }
    return ids;
  }, [focusColumnId, effRelationships]);

  const colSideMap = useMemo(() => {
    const map = new Map<number, 'N' | '1'>();
    const fSide = (type: string): 'N' | '1' =>
      (type === 'many_to_one'  || type === 'many_to_many') ? 'N' : '1';
    const tSide = (type: string): 'N' | '1' =>
      (type === 'one_to_many'  || type === 'many_to_many') ? 'N' : '1';

    const relevant = effRelationships.filter((r) => {
      if (focusColumnId)
        return r.from_column_id === focusColumnId || r.to_column_id === focusColumnId;
      if (focusTableId)
        return r.from_table_id === focusTableId || r.to_table_id === focusTableId;
      return false;
    });

    relevant.forEach((r) => {
      if (r.from_column_id) map.set(r.from_column_id, fSide(r.relationship_type ?? ''));
      if (r.to_column_id)   map.set(r.to_column_id,   tSide(r.relationship_type ?? ''));
    });

    return map;
  }, [focusTableId, focusColumnId, effRelationships]);

  // ── View-mode actions: show relations, remove from view ──
  const handleShowRelations = useCallback(async (tableId: number) => {
    if (!viewId) return;
    try {
      const res = await api.get(`/cross-views/related-tables/${tableId}`);
      const payload = res.data.data ?? res.data ?? {};
      const relatedTables: any[] = payload.tables ?? payload ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
      const existingIds = new Set(viewTables.map((t) => t.id));
      const srcPos = posMap.current.get(String(tableId)) ?? { x: 400, y: 300 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toAdd = relatedTables.filter((rt: any) => !existingIds.has(rt.id));
      if (toAdd.length === 0) return;

      // Place related tables in a circle around the source.
      const RADIUS = Math.max(350, toAdd.length * 60);
      await Promise.all(toAdd.map((rt: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const angle = (2 * Math.PI * i) / toAdd.length - Math.PI / 2; // start at top
        const posX = Math.round(srcPos.x + RADIUS * Math.cos(angle));
        const posY = Math.round(srcPos.y + RADIUS * Math.sin(angle));
        return api.post(`/cross-views/${viewId}/tables`, { tableId: rt.id, posX, posY });
      }));
      await reloadViewDetail();
    } catch { /* ignore */ }
  }, [viewId, viewTables, reloadViewDetail]);

  const handleRemoveFromView = useCallback(async (tableId: number) => {
    if (!viewId) return;
    try {
      await api.delete(`/cross-views/${viewId}/tables/${tableId}`);
      await reloadViewDetail();
    } catch { /* ignore */ }
  }, [viewId, reloadViewDetail]);

  // ── API (all-tables mode) ──
  const reload = useCallback(async () => {
    if (isViewMode) return; // view mode uses reloadViewDetail instead
    const res = await api.get(`/semantic/relationships?connectionId=${connectionId}`);
    setRelationships(res.data.data);
  }, [connectionId, isViewMode]);

  useEffect(() => { if (!isViewMode) reload(); }, [reload, isViewMode]);

  const deleteRel = useCallback(async (id: number) => {
    await api.delete(`/semantic/relationships/${id}`);
    if (isViewMode) await reloadViewDetail(); else await reload();
  }, [reload, isViewMode, reloadViewDetail]);

  const confirmRel = useCallback(async (id: number) => {
    await api.patch(`/semantic/relationships/${id}`, { ai_draft: false });
    if (isViewMode) await reloadViewDetail(); else await reload();
  }, [reload, isViewMode, reloadViewDetail]);

  // ── Draft review: computed list of drafts ──
  const draftRels = useMemo(() => effRelationships.filter((r) => r.ai_draft), [effRelationships]);
  const currentDraft = draftReviewActive && draftRels.length > 0
    ? draftRels[Math.min(draftReviewIdx, draftRels.length - 1)]
    : null;

  // ── Rebuild graph whenever any relevant data changes ──
  const rebuildGraph = useCallback(() => {
    // Apply layout positions on first load (or after a reset).
    if (needsDagreLayout.current && effTables.length > 0 && !isViewMode) {
      if (effRelationships.length > 0) {
        const dagrePos = getDagrePositions(effTables, effColumnsByTable, effRelationships);
        dagrePos.forEach((pos, id) => posMap.current.set(id, pos));
        needsDagreLayout.current = false;
      }
    }

    const selTable  = onSelectTable  ?? (() => {});
    const selColumn = onSelectColumn ?? (() => {});
    const viewModeArg = isViewMode && viewId
      ? { mode: 'view' as const, viewId, onShowRelations: handleShowRelations, onRemoveFromView: handleRemoveFromView }
      : undefined;

    // Compact mode: collect column IDs that participate in any relationship
    let relColIds: Set<number> | undefined;
    if (compactMode) {
      relColIds = new Set<number>();
      for (const r of effRelationships) {
        if (r.from_column_id) relColIds.add(r.from_column_id);
        if (r.to_column_id) relColIds.add(r.to_column_id);
      }
    }

    // Relationship count per table
    const relCountMap = new Map<number, number>();
    for (const r of effRelationships) {
      relCountMap.set(r.from_table_id, (relCountMap.get(r.from_table_id) ?? 0) + 1);
      relCountMap.set(r.to_table_id,   (relCountMap.get(r.to_table_id)   ?? 0) + 1);
    }

    // Search filter: dim tables that don't match
    let searchDimmedIds: Set<number> | undefined;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      searchDimmedIds = new Set<number>();
      for (const t of effTables) {
        const name = (t.display_name || t.table_name || '').toLowerCase();
        if (!name.includes(q)) searchDimmedIds.add(t.id);
      }
    }

    const newNodes = buildNodes(
      effTables, effColumnsByTable, posMap.current,
      focusTableId ?? null, focusColumnId ?? null,
      pairedColIds, colSideMap,
      selTable, selColumn,
      viewModeArg,
      relColIds,
      relCountMap,
      searchDimmedIds,
    );
    setNodes(newNodes);
    setEdges(buildEdges(
      effRelationships, effTables, effColumnsByTable,
      posMap.current, selectedRelId, hoveredRelId,
      setSelectedRelId, setHoveredRelId,
      highlightRelIds, deleteRel, confirmRel,
      searchDimmedIds,
    ));
  }, [effTables, effColumnsByTable, focusTableId, focusColumnId, effRelationships, selectedRelId, hoveredRelId,
      highlightRelIds, pairedColIds, colSideMap, onSelectTable, onSelectColumn,
      isViewMode, viewId, handleShowRelations, handleRemoveFromView, compactMode, deleteRel, confirmRel, searchQuery]);

  useEffect(() => { rebuildGraph(); }, [rebuildGraph]);

  // Reset layout: clear all positions, re-run dagre on next rebuild
  const { fitView, screenToFlowPosition } = useReactFlow();

  // Whole-schema viewport: fit everything once nodes are mounted. Two
  // staggered attempts handle the case where React Flow hasn't measured
  // node DOM on the first tick.
  const viewportInitialised = useRef(false);
  useEffect(() => {
    if (viewportInitialised.current) return;
    if (nodes.length === 0) return;
    viewportInitialised.current = true;
    const t1 = setTimeout(() => fitView({ duration: 0,   padding: 0.2 }),  60);
    const t2 = setTimeout(() => fitView({ duration: 300, padding: 0.2 }), 220);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [nodes, fitView]);

  function resetLayout() {
    posMap.current.clear();
    needsDagreLayout.current = true;
    rebuildGraph();
    setTimeout(() => fitView({ duration: 600, padding: 0.2 }), 50);
  }

  // ── Draft review: zoom to current draft relationship ──
  useEffect(() => {
    if (!currentDraft) return;
    // Select the current draft and zoom to both connected tables
    setSelectedRelId(currentDraft.id);
    const t = setTimeout(() => {
      fitView({
        nodes: [
          { id: String(currentDraft.from_table_id) },
          { id: String(currentDraft.to_table_id) },
        ],
        duration: 500, padding: 0.35, maxZoom: 1.1,
      });
    }, 100);
    return () => clearTimeout(t);
  }, [currentDraft, fitView]);

  const changeType = useCallback(async (id: number, type: string) => {
    await api.patch(`/semantic/relationships/${id}`, { relationship_type: type });
    if (isViewMode) {
      await reloadViewDetail();
    } else {
      setRelationships((prev) => prev.map((r) => r.id === id ? { ...r, relationship_type: type } : r));
    }
  }, [isViewMode, reloadViewDetail]);

  // ── Node drag — update position map so edges follow the moved node ──
  // In view mode, also persist position to the backend
  const dragSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes);
    let moved = false;
    changes.forEach((c) => {
      if (c.type === 'position' && c.position) {
        posMap.current.set(c.id, c.position);
        moved = true;
        // Persist position in view mode (debounced)
        if (isViewMode && viewId && c.dragging === false) {
          const tableId = c.id;
          clearTimeout(dragSaveTimers.current[tableId]);
          dragSaveTimers.current[tableId] = setTimeout(() => {
            const pos = posMap.current.get(tableId);
            if (pos) {
              api.patch(`/cross-views/${viewId}/tables/${tableId}/position`, {
                posX: Math.round(pos.x), posY: Math.round(pos.y),
              }).catch(() => {});
            }
          }, 300);
        }
      }
    });
    if (moved) {
      setEdges(buildEdges(
        effRelationships, effTables, effColumnsByTable,
        posMap.current, selectedRelId, hoveredRelId,
        setSelectedRelId, setHoveredRelId,
        highlightRelIds, deleteRel, confirmRel,
      ));
    }
  }, [onNodesChange, effRelationships, effTables, effColumnsByTable, selectedRelId, hoveredRelId, highlightRelIds, isViewMode, viewId, deleteRel, confirmRel]);

  // ── Drop handler (view mode): add a table from the left panel ──
  const handleDrop = useCallback(async (event: React.DragEvent) => {
    if (!isViewMode || !viewId) return;
    event.preventDefault();
    const tableIdStr = event.dataTransfer.getData('application/x-table-id')
      || event.dataTransfer.getData('text/plain');
    if (!tableIdStr) return;
    const tableId = Number(tableIdStr);
    if (isNaN(tableId) || tableId <= 0) return;
    if (viewTables.some((t) => t.id === tableId)) return;
    let posX = 100, posY = 100;
    try {
      const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      posX = Math.round(flowPos.x);
      posY = Math.round(flowPos.y);
    } catch { /* empty state — no ReactFlow mounted yet */ }
    try {
      await api.post(`/cross-views/${viewId}/tables`, { tableId, posX, posY });
      await reloadViewDetail();
    } catch { /* ignore */ }
  }, [isViewMode, viewId, viewTables, screenToFlowPosition, reloadViewDetail]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!isViewMode) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, [isViewMode]);

  // ── Connect ──
  const onConnect = useCallback((c: Connection) => {
    const fromTableId = Number(c.source), toTableId = Number(c.target);
    if (fromTableId === toTableId) return;
    setPendingConn({
      fromTableId, toTableId,
      fromColId: parseHandle(c.sourceHandle),
      toColId:   parseHandle(c.targetHandle),
    });
  }, []);

  async function confirmNewRel(fromColId: number | null, toColId: number | null, type: string) {
    if (!pendingConn) return;
    await api.post('/semantic/relationships', {
      from_table_id: pendingConn.fromTableId, to_table_id: pendingConn.toTableId,
      from_column_id: fromColId, to_column_id: toColId, relationship_type: type,
    });
    setPendingConn(null);
    if (isViewMode) await reloadViewDetail(); else await reload();
  }

  // ── Keyboard shortcuts: Delete = remove selected rel, Esc = deselect, C = toggle compact ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedRelId) {
          e.preventDefault();
          if (confirm('Delete this relationship?')) deleteRel(selectedRelId);
          setSelectedRelId(null);
        }
      } else if (e.key === 'Escape') {
        setSelectedRelId(null);
        setHoveredRelId(null);
        onClearSelection?.();
      } else if (e.key === 'c' || e.key === 'C') {
        setCompactMode((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedRelId, deleteRel, onClearSelection]);

  // ── Empty state for custom view mode ──
  if (isViewMode && viewTables.length === 0 && viewDetail) {
    return (
      <div className="flex flex-1 min-h-0" style={{ height: '100%' }}>
        <div
          className="flex-1 flex items-center justify-center text-slate-400 text-sm"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="text-center">
            <p className="text-3xl mb-2">&#128269;</p>
            <p className="font-medium">Drag a table from the left panel to start building this view</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0" style={{ height: '100%' }}>
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes} edges={edges}
          nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onPaneClick={() => {
            setSelectedRelId(null);
            setHoveredRelId(null);
            onClearSelection?.();
          }}
          connectionMode={ConnectionMode.Loose}
          fitView fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15} maxZoom={1.5}
          deleteKeyCode={null}
        >
          <Background color="#e2e8f0" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) => {
              if (n.data?.focused) return '#2563eb';
              // Colour intensity by relationship count: 0 rels = light, 5+ = darkest
              const rc = Math.min(n.data?.relCount ?? 0, 5);
              const lightness = 70 - rc * 8; // 70% → 30%
              return `hsl(222, 80%, ${lightness}%)`;
            }}
            nodeStrokeColor="#bfdbfe"
            maskColor="rgba(241,245,249,0.7)"
            style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
          />
          <CanvasController zoomToTableId={zoomToTableId ?? null} />
        </ReactFlow>

        {/* ── Toolbar: search + compact toggle ── */}
        <div style={{
          position: 'absolute', top: 10, right: 10, zIndex: 10,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {/* Search input */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', left: 8, pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Filter tables…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: searchQuery ? 180 : 140,
                padding: '6px 8px 6px 28px',
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                fontSize: 12,
                background: '#fff',
                outline: 'none',
                boxShadow: '0 1px 4px rgba(0,0,0,.1)',
                transition: 'width 0.2s',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#93c5fd')}
              onBlur={(e) => (e.currentTarget.style.borderColor = '#cbd5e1')}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#94a3b8', fontSize: 14, lineHeight: 1, padding: 2,
                }}
                title="Clear search"
              >×</button>
            )}
          </div>

          {/* Compact mode toggle */}
          <button
            onClick={() => setCompactMode((v) => !v)}
            title={compactMode ? 'Show all columns (C)' : 'Show only relationship columns (C)'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              background: compactMode ? '#1e40af' : '#fff',
              color: compactMode ? '#fff' : '#475569',
              border: compactMode ? '1px solid #1e40af' : '1px solid #cbd5e1',
              borderRadius: 8,
              fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 4px rgba(0,0,0,.1)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 3H3v7h18V3zM21 14H3v7h18v-7z" />
            </svg>
            {compactMode ? 'Compact' : 'Full'}
          </button>
        </div>

        {/* ── Draft review floating panel ── */}
        {draftReviewActive && currentDraft && (() => {
          const meta = getMeta(currentDraft.relationship_type);
          const idx  = Math.min(draftReviewIdx, draftRels.length - 1);
          const tNameFn = (id: number) => {
            const t = effTables.find((t) => t.id === id);
            return t?.display_name || t?.table_name || '—';
          };
          const cNameFn = (tid: number, cid: number | null) => {
            if (!cid) return null;
            const c = (effColumnsByTable[tid] ?? []).find((c) => c.id === cid);
            return c?.display_name || c?.column_name || null;
          };
          const fc = cNameFn(currentDraft.from_table_id, currentDraft.from_column_id);
          const tc = cNameFn(currentDraft.to_table_id, currentDraft.to_column_id);

          return (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 30, background: '#fff', borderRadius: 16,
              border: '1px solid #e2e8f0', boxShadow: '0 8px 32px rgba(0,0,0,.15)',
              padding: '16px 20px', minWidth: 420, maxWidth: 520,
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>⚡</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Review AI Suggestions</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: '#64748b',
                    background: '#f1f5f9', padding: '2px 8px', borderRadius: 99,
                  }}>{idx + 1} / {draftRels.length}</span>
                </div>
                <button
                  onClick={() => { setDraftReviewActive(false); setSelectedRelId(null); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}
                  title="Exit review"
                >×</button>
              </div>

              {/* Relationship detail */}
              <div style={{
                background: '#f8fafc', borderRadius: 10, padding: '10px 14px', marginBottom: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>
                    {tNameFn(currentDraft.from_table_id)}
                    {fc && <span style={{ fontFamily: 'monospace', color: '#64748b', fontWeight: 500 }}>.{fc}</span>}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, paddingLeft: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: meta.color }}>{meta.src}</span>
                  <div style={{ flex: 1, height: 1.5, background: meta.color, borderRadius: 1 }} />
                  <span style={{ fontSize: 9, color: meta.color, fontWeight: 700 }}>{meta.label}</span>
                  <div style={{ flex: 1, height: 1.5, background: meta.color, borderRadius: 1 }} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: meta.color }}>{meta.tgt}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>
                    {tNameFn(currentDraft.to_table_id)}
                    {tc && <span style={{ fontFamily: 'monospace', color: '#64748b', fontWeight: 500 }}>.{tc}</span>}
                  </span>
                </div>
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={async () => {
                    await confirmRel(currentDraft.id);
                    // Stay on same index — list will shrink, so next draft slides in
                  }}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 8, border: '2px solid #16a34a',
                    background: '#f0fdf4', color: '#16a34a', fontWeight: 700, fontSize: 12,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}
                >✓ Confirm</button>
                <button
                  onClick={async () => {
                    await deleteRel(currentDraft.id);
                    // Same — list shrinks
                  }}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 8, border: '2px solid #dc2626',
                    background: '#fef2f2', color: '#dc2626', fontWeight: 700, fontSize: 12,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}
                >✗ Delete</button>
                <button
                  onClick={() => setDraftReviewIdx((i) => Math.min(i + 1, draftRels.length - 1))}
                  disabled={idx >= draftRels.length - 1}
                  style={{
                    padding: '8px 14px', borderRadius: 8, border: '1px solid #cbd5e1',
                    background: '#fff', color: '#475569', fontWeight: 600, fontSize: 12,
                    cursor: idx >= draftRels.length - 1 ? 'default' : 'pointer',
                    opacity: idx >= draftRels.length - 1 ? 0.4 : 1,
                  }}
                >Skip →</button>
              </div>

              {/* Progress bar */}
              <div style={{ marginTop: 10, height: 3, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: '#16a34a', borderRadius: 2,
                  width: `${Math.round(((idx + 1) / draftRels.length) * 100)}%`,
                  transition: 'width 0.3s',
                }} />
              </div>
            </div>
          );
        })()}

        {/* Exit review when all drafts are done */}
        {draftReviewActive && draftRels.length === 0 && (() => {
          return (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 30, background: '#fff', borderRadius: 16,
              border: '1px solid #e2e8f0', boxShadow: '0 8px 32px rgba(0,0,0,.15)',
              padding: '20px 24px', textAlign: 'center', minWidth: 320,
            }}>
              <span style={{ fontSize: 28 }}>🎉</span>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginTop: 8 }}>All drafts reviewed!</p>
              <p style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>Every relationship has been confirmed or removed.</p>
              <button
                onClick={() => { setDraftReviewActive(false); setSelectedRelId(null); }}
                style={{
                  marginTop: 12, padding: '8px 20px', borderRadius: 8,
                  background: '#1e40af', color: '#fff', fontWeight: 600, fontSize: 12,
                  cursor: 'pointer', border: 'none',
                }}
              >Done</button>
            </div>
          );
        })()}
      </div>

      {!isViewMode && !hideSidebar && (
        <RelationshipPanel
          relationships={effRelationships} tables={effTables} columnsByTable={effColumnsByTable}
          connectionId={connectionId}
          selectedRelId={selectedRelId} onSelect={setSelectedRelId}
          onDelete={deleteRel} onChangeType={changeType}
          onReload={reload}
          onResetLayout={resetLayout}
          draftCount={draftRels.length}
          onStartDraftReview={() => { setDraftReviewIdx(0); setDraftReviewActive(true); }}
        />
      )}

      {pendingConn && (
        <NewRelDialog
          pending={pendingConn} tables={effTables} allColumns={effColumnsByTable}
          onConfirm={confirmNewRel} onCancel={() => setPendingConn(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function RelationshipCanvas(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

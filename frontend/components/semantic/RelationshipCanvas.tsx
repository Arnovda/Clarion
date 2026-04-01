'use client';

import dagre from 'dagre';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls,
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
const HEADER_H = 58;  // px — table header block height
const ROW_H    = 30;  // px — each column row height
const NODE_W   = 248; // px — fixed node width

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

function TableNode({ data }: NodeProps<TableNodeData>) {
  const { table, columns, focused, focusColId, pairedColIds, colSideMap,
          onSelectTable, onSelectColumn,
          mode, viewId, onShowRelations, onRemoveFromView } = data;
  const borderColor = focused ? '#2563eb' : '#bfdbfe';
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
    <div style={{ position: 'relative', width: NODE_W, height: totalH }}>

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
          ? '0 0 0 3px #bfdbfe, 0 4px 20px rgba(37,99,235,.18)'
          : '0 2px 8px rgba(0,0,0,.08)',
      }}>
        {/* Header — clickable to select/highlight this table */}
        <div
          onClick={(e) => { e.stopPropagation(); onSelectTable(table.id); }}
          style={{
            height: HEADER_H,
            background: focused ? '#1d4ed8' : '#1e40af',
            padding: '9px 12px',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            cursor: 'pointer',
          }}>
          <p style={{ margin: 0, color: '#fff', fontSize: 13, fontWeight: 700,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {table.display_name || table.table_name}
          </p>
          <p style={{ margin: '2px 0 0', color: '#93c5fd', fontSize: 10, fontFamily: 'monospace' }}>
            {table.table_name} · {columns.length} cols
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
  hovered:    boolean;
  dimmed:      boolean;  // true when a focus filter is active and this edge isn't highlighted
  highlighted: boolean;  // true when a filter IS active and this edge IS part of the selection
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
  const active        = isSelected || isHovered;
  const color         = active ? '#1d4ed8' : isDimmed ? '#cbd5e1' : meta.color;
  const strokeW       = active ? 3.5 : isDimmed ? 1.5 : 2;
  const opacity       = isDimmed ? 0.3 : 1;
  const markerId      = `arr-${id}`;

  // N/1 label colours: grey unless this edge is explicitly highlighted
  const nColor = (active || isHighlighted) ? '#2563eb' : '#94a3b8';
  const oColor = (active || isHighlighted) ? '#f97316' : '#94a3b8';
  const srcLabelColor = meta.src === 'N' ? nColor : meta.src === '1' ? oColor : '#94a3b8';
  const tgtLabelColor = meta.tgt === 'N' ? nColor : meta.tgt === '1' ? oColor : '#94a3b8';

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.35,
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
      />

      {/* Visible stroke */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeW}
        strokeDasharray={isSelected ? '7 4' : undefined}
        markerEnd={`url(#${markerId})`}
        style={{ cursor: 'pointer', transition: 'stroke 0.15s, stroke-width 0.15s' }}
        onClick={() => data?.onSelect(data.relId)}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
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
        }}
          onClick={() => data?.onSelect(data.relId)}
          onMouseEnter={() => data?.onHover(data.relId)}
          onMouseLeave={() => data?.onHover(null)}
        >
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: 'white',
            background: color,
            padding: '2px 8px', borderRadius: 99,
            border: `1.5px solid ${color}`,
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 4px rgba(0,0,0,.12)',
            transition: 'all 0.15s',
            opacity: active ? 1 : 0,
            pointerEvents: active ? 'all' : 'none',
          }}>
            {meta.label}
          </span>
        </div>

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
  const [fromCol, setFromCol] = useState(pending.fromColId ? String(pending.fromColId) : '');
  const [toCol,   setToCol]   = useState(pending.toColId   ? String(pending.toColId)   : '');
  const [type,    setType]    = useState('many_to_one');
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
}

function RelationshipPanel({ relationships, tables, columnsByTable, connectionId, selectedRelId, onSelect, onDelete, onChangeType, onReload, onResetLayout }: PanelProps) {
  const [reSuggesting, setReSuggesting] = useState(false);

  async function handleReSuggest() {
    if (!confirm('This will delete all AI-draft relationships and re-generate them with correct column links. Manually confirmed relationships are kept. Continue?')) return;
    setReSuggesting(true);
    try {
      await api.post(`/semantic/relationships/re-suggest?connectionId=${connectionId}`);
      await onReload();
    } finally {
      setReSuggesting(false);
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
            <button
              onClick={onResetLayout}
              title="Reset to auto-layout"
              className="flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
            >
              ↺ Layout
            </button>
          </div>
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
    ranksep:  280,    // wide horizontal gap — gives edges room to exit cleanly
    nodesep:  80,     // vertical gap between nodes in the same column
    marginx:  80,
    marginy:  80,
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
): Node[] {
  return tables.map((t, i) => ({
    id:       String(t.id),
    type:     'tableNode',
    position: posMap.get(String(t.id)) ?? gridFallback(i),
    data: {
      table:          t,
      columns:        columnsByTable[t.id] ?? [],
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
  }));
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
): Edge[] {
  const hasFilter = highlightRelIds.size > 0;
  const tName = (id: number) => { const t = tables.find((t) => t.id === id); return t?.display_name || t?.table_name || ''; };
  const cName = (tid: number, cid: number | null) => {
    if (!cid) return null;
    const c = (columnsByTable[tid] ?? []).find((c) => c.id === cid);
    return c?.display_name || c?.column_name || null;
  };

  return relationships.map((r) => {
    const srcPos  = posMap.get(String(r.from_table_id));
    const tgtPos  = posMap.get(String(r.to_table_id));
    // source is to the RIGHT of target → exit left side, enter right side
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
        fromLabel, toLabel,
        onSelect, onHover,
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
}

function Canvas({ connectionId, tables, columnsByTable, focusTableId, focusColumnId,
                  zoomToTableId, onSelectTable, onSelectColumn, onClearSelection, viewId }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [selectedRelId, setSelectedRelId] = useState<number | null>(null);
  const [hoveredRelId,  setHoveredRelId]  = useState<number | null>(null);
  const [pendingConn,   setPendingConn]   = useState<PendingConn | null>(null);

  // ── Custom-view mode state ──
  const isViewMode = viewId != null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [viewDetail, setViewDetail] = useState<any>(null);
  const viewTables = useMemo<SourceTable[]>(() => {
    if (!isViewMode || !viewDetail?.tables) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return viewDetail.tables.map((vt: any) => ({
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
    if (!isViewMode || !viewDetail?.tables) return {};
    const map: Record<number, SourceColumn[]> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewDetail.tables.forEach((vt: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map[vt.table_id] = (vt.columns ?? []).map((c: any) => ({
        id: c.id ?? c.column_id,
        table_id: vt.table_id,
        column_name: c.column_name,
        display_name: c.display_name || c.column_name,
        description: c.description ?? '',
        data_type: c.data_type ?? '',
        example_values: c.example_values ?? null,
        is_dimension: c.is_dimension ?? false,
        is_measure: c.is_measure ?? false,
        ai_draft: c.ai_draft ?? false,
      }));
    });
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
    if (!isViewMode || !viewDetail?.tables) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewDetail.tables.forEach((vt: any) => {
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
      const related = res.data.data ?? res.data ?? [];
      const existingIds = new Set(viewTables.map((t) => t.id));
      // Source table position
      const srcPos = posMap.current.get(String(tableId)) ?? { x: 400, y: 300 };
      const RADIUS = 350;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toAdd = related.filter((rt: any) => !existingIds.has(rt.table_id ?? rt.id));
      await Promise.all(toAdd.map((rt: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const angle = (2 * Math.PI * i) / (toAdd.length || 1);
        const posX = Math.round(srcPos.x + RADIUS * Math.cos(angle));
        const posY = Math.round(srcPos.y + RADIUS * Math.sin(angle));
        const tId = rt.table_id ?? rt.id;
        return api.post(`/cross-views/${viewId}/tables`, { tableId: tId, posX, posY });
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

  // ── Rebuild graph whenever any relevant data changes ──
  const rebuildGraph = useCallback(() => {
    // Apply dagre layout when relationships first arrive or after a reset (all-tables mode only)
    if (needsDagreLayout.current && effRelationships.length > 0 && effTables.length > 0 && !isViewMode) {
      const dagrePos = getDagrePositions(effTables, effColumnsByTable, effRelationships);
      dagrePos.forEach((pos, id) => posMap.current.set(id, pos));
      needsDagreLayout.current = false;
    }

    const selTable  = onSelectTable  ?? (() => {});
    const selColumn = onSelectColumn ?? (() => {});
    const viewModeArg = isViewMode && viewId
      ? { mode: 'view' as const, viewId, onShowRelations: handleShowRelations, onRemoveFromView: handleRemoveFromView }
      : undefined;
    const newNodes = buildNodes(
      effTables, effColumnsByTable, posMap.current,
      focusTableId ?? null, focusColumnId ?? null,
      pairedColIds, colSideMap,
      selTable, selColumn,
      viewModeArg,
    );
    setNodes(newNodes);
    setEdges(buildEdges(
      effRelationships, effTables, effColumnsByTable,
      posMap.current, selectedRelId, hoveredRelId,
      setSelectedRelId, setHoveredRelId,
      highlightRelIds,
    ));
  }, [effTables, effColumnsByTable, focusTableId, focusColumnId, effRelationships, selectedRelId, hoveredRelId,
      highlightRelIds, pairedColIds, colSideMap, onSelectTable, onSelectColumn,
      isViewMode, viewId, handleShowRelations, handleRemoveFromView]);

  useEffect(() => { rebuildGraph(); }, [rebuildGraph]);

  // Reset layout: clear all positions, re-run dagre on next rebuild
  const { fitView, screenToFlowPosition } = useReactFlow();
  function resetLayout() {
    posMap.current.clear();
    needsDagreLayout.current = true;
    rebuildGraph();
    setTimeout(() => fitView({ duration: 600, padding: 0.2 }), 50);
  }

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
        highlightRelIds,
      ));
    }
  }, [onNodesChange, effRelationships, effTables, effColumnsByTable, selectedRelId, hoveredRelId, highlightRelIds, isViewMode, viewId]);

  // ── Drop handler (view mode): add a table from the left panel ──
  const handleDrop = useCallback(async (event: React.DragEvent) => {
    if (!isViewMode || !viewId) return;
    event.preventDefault();
    const tableIdStr = event.dataTransfer.getData('application/x-table-id');
    if (!tableIdStr) return;
    const tableId = Number(tableIdStr);
    // Check if already in view
    if (viewTables.some((t) => t.id === tableId)) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    try {
      await api.post(`/cross-views/${viewId}/tables`, {
        tableId, posX: Math.round(flowPos.x), posY: Math.round(flowPos.y),
      });
      await reloadViewDetail();
    } catch { /* ignore */ }
  }, [isViewMode, viewId, viewTables, screenToFlowPosition, reloadViewDetail]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!isViewMode) return;
    event.preventDefault();
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
      <div className="flex-1 relative" onDragOver={handleDragOver} onDrop={handleDrop}>
        <ReactFlow
          nodes={nodes} edges={edges}
          nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={() => {
            setSelectedRelId(null);
            setHoveredRelId(null);
            onClearSelection?.();
          }}
          connectionMode={ConnectionMode.Loose}
          fitView fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15} maxZoom={1.5}
        >
          <Background color="#e2e8f0" gap={24} size={1} />
          <Controls showInteractive={false} />
          <CanvasController zoomToTableId={zoomToTableId ?? null} />
        </ReactFlow>
      </div>

      {!isViewMode && (
        <RelationshipPanel
          relationships={effRelationships} tables={effTables} columnsByTable={effColumnsByTable}
          connectionId={connectionId}
          selectedRelId={selectedRelId} onSelect={setSelectedRelId}
          onDelete={deleteRel} onChangeType={changeType}
          onReload={reload}
          onResetLayout={resetLayout}
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

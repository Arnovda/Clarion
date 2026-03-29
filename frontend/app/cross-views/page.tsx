'use client';

/**
 * Cross-source integration canvas — modelled after RelationshipCanvas.tsx
 * Uses ReactFlow with per-column handles, a NewRelDialog, and a right panel.
 */

import dagre from 'dagre';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, BackgroundVariant, Controls,
  useNodesState, useEdgesState,
  Connection, Edge, Node, NodeProps,
  Handle, Position,
  EdgeProps, getBezierPath, EdgeLabelRenderer,
  useReactFlow, ReactFlowProvider, ConnectionMode,
  NodeDragHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';
import Nav from '@/components/Nav';
import api from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants — must match exactly so handles line up with column rows
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_H = 62;
const ROW_H    = 30;
const NODE_W   = 256;

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
// Connection colours — one accent per source system
// ─────────────────────────────────────────────────────────────────────────────
const CONN_PALETTES = [
  { header: '#1e40af', sub: '#93c5fd' },   // blue
  { header: '#6d28d9', sub: '#c4b5fd' },   // purple
  { header: '#065f46', sub: '#6ee7b7' },   // emerald
  { header: '#92400e', sub: '#fcd34d' },   // amber
  { header: '#881337', sub: '#fca5a5' },   // rose
];
const connPaletteMap = new Map<number, typeof CONN_PALETTES[0]>();
function getConnPalette(connId: number): typeof CONN_PALETTES[0] {
  if (!connPaletteMap.has(connId)) {
    connPaletteMap.set(connId, CONN_PALETTES[connPaletteMap.size % CONN_PALETTES.length]);
  }
  return connPaletteMap.get(connId)!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────────────────────────────────────
interface CrossView   { id: number; name: string; description?: string }
interface Connection  { id: number; name: string }
interface SourceTable { id: number; connection_id: number; table_name: string; display_name?: string }
interface SourceColumn {
  id: number; table_id: number; column_name: string; display_name?: string;
  data_type?: string; is_dimension?: boolean; is_measure?: boolean;
}
interface ViewTable {
  view_table_id: number; table_id: number; table_name: string; display_name?: string;
  connection_id: number; connection_name: string; pos_x: number; pos_y: number;
}
interface CrossRel {
  id: number; from_table_id: number; from_column_id?: number;
  to_table_id: number; to_column_id?: number;
  relationship_type: string; label?: string;
}

interface TableNodeData {
  tableId:        number;
  tableName:      string;
  displayName?:   string;
  connectionId:   number;
  connectionName: string;
  columns:        SourceColumn[];
  headerBg:       string;
  accentColor:    string;
  focused:        boolean;
  onRemove:       (tableId: number) => void;
}

interface RelEdgeData {
  relType:    string;
  relId:      number;
  selected:   boolean;
  fromLabel:  string;
  toLabel:    string;
  onSelect:   (id: number) => void;
  onHover:    (id: number | null) => void;
  hovered:    boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table node
// ─────────────────────────────────────────────────────────────────────────────
const HANDLE_STYLE = {
  width: 10, height: 10,
  background: '#93c5fd',
  border: '2px solid white',
  borderRadius: '50%',
  cursor: 'crosshair',
  zIndex: 20,
};

function TableNode({ data }: NodeProps<TableNodeData>) {
  const { tableId, tableName, displayName, connectionId, connectionName,
          columns, headerBg, accentColor, focused, onRemove } = data;
  const borderColor = focused ? '#2563eb' : '#bfdbfe';
  const totalH = HEADER_H + columns.length * ROW_H;

  return (
    <div style={{ position: 'relative', width: NODE_W, height: totalH }}>

      {/* Handles — table-level */}
      <Handle type="source" position={Position.Left}  id={hL('table')}
        style={{ ...HANDLE_STYLE, background: accentColor, position: 'absolute', top: HEADER_H / 2, left: -5, transform: 'translateY(-50%)' }} />
      <Handle type="source" position={Position.Right} id={hR('table')}
        style={{ ...HANDLE_STYLE, background: accentColor, position: 'absolute', top: HEADER_H / 2, right: -5, transform: 'translateY(-50%)' }} />

      {/* Handles — per column */}
      {columns.map((col, i) => {
        const top = HEADER_H + i * ROW_H + ROW_H / 2;
        return (
          <Fragment key={col.id}>
            <Handle type="source" position={Position.Left}  id={hL(col.id)}
              style={{ ...HANDLE_STYLE, background: accentColor, position: 'absolute', top, left: -5, transform: 'translateY(-50%)' }} />
            <Handle type="source" position={Position.Right} id={hR(col.id)}
              style={{ ...HANDLE_STYLE, background: accentColor, position: 'absolute', top, right: -5, transform: 'translateY(-50%)' }} />
          </Fragment>
        );
      })}

      {/* Visual box */}
      <div style={{
        position: 'absolute', inset: 0,
        border: `2px solid ${borderColor}`,
        borderRadius: 12, overflow: 'hidden', background: '#fff',
        boxShadow: focused
          ? '0 0 0 3px #bfdbfe, 0 4px 20px rgba(37,99,235,.18)'
          : '0 2px 8px rgba(0,0,0,.08)',
      }}>
        {/* Header */}
        <div style={{
          height: HEADER_H, background: headerBg,
          padding: '8px 12px 8px 12px',
          display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'relative',
        }}>
          <p style={{ margin: 0, color: '#fff', fontSize: 13, fontWeight: 700,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 20 }}>
            {displayName || tableName}
          </p>
          <p style={{ margin: '2px 0 0', fontSize: 10, fontFamily: 'monospace', color: accentColor }}>
            {tableName} · {columns.length} cols
          </p>
          <div style={{ marginTop: 3 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, color: accentColor,
              background: 'rgba(255,255,255,0.15)',
              padding: '1px 6px', borderRadius: 99, border: `1px solid ${accentColor}22`,
            }}>
              {connectionName}
            </span>
          </div>
          {/* Remove button */}
          <button
            className="nodrag nopan"
            onClick={(e) => { e.stopPropagation(); onRemove(tableId); }}
            style={{
              position: 'absolute', top: 7, right: 8,
              background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4,
              color: 'rgba(255,255,255,0.8)', cursor: 'pointer', width: 18, height: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
              lineHeight: 1,
            }}
            title="Remove from canvas"
          >×</button>
        </div>

        {/* Column rows */}
        {columns.map((col, i) => {
          const dot = col.is_dimension ? '#a78bfa' : col.is_measure ? '#34d399' : '#cbd5e1';
          return (
            <div key={col.id} style={{
              height: ROW_H, display: 'flex', alignItems: 'center', gap: 6,
              padding: '0 14px',
              background: i % 2 === 0 ? '#fff' : '#f8fafc',
              borderTop: '1px solid #f1f5f9',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#334155', fontWeight: 500,
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {col.display_name || col.column_name}
              </span>
              <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>
                {col.data_type?.toLowerCase().slice(0, 7)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Relationship edge
// ─────────────────────────────────────────────────────────────────────────────
function CrossRelEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps<RelEdgeData>) {
  const meta       = getMeta(data?.relType ?? '');
  const isSelected = data?.selected ?? false;
  const isHovered  = data?.hovered  ?? false;
  const active     = isSelected || isHovered;
  const color      = active ? '#1d4ed8' : meta.color;
  const strokeW    = active ? 3.5 : 2;
  const markerId   = `arr-${id}`;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.35,
  });

  return (
    <g>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
        </marker>
      </defs>

      <path d={edgePath} fill="none" stroke="white" strokeWidth={strokeW + 6} />

      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onClick={() => data?.onSelect(data.relId)}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
      />

      <path d={edgePath} fill="none" stroke={color} strokeWidth={strokeW}
        strokeDasharray={isSelected ? '7 4' : undefined}
        markerEnd={`url(#${markerId})`}
        style={{ cursor: 'pointer', transition: 'stroke 0.15s, stroke-width 0.15s' }}
        onClick={() => data?.onSelect(data.relId)}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
      />

      <EdgeLabelRenderer>
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${
            sourceX + (sourcePosition === Position.Right ? 14 : -14)
          }px,${sourceY - 11}px)`,
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: active ? '#2563eb' : '#94a3b8' }}>
            {meta.src}
          </span>
        </div>

        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${
            targetX + (targetPosition === Position.Left ? -14 : 14)
          }px,${targetY - 11}px)`,
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: active ? '#f97316' : '#94a3b8' }}>
            {meta.tgt}
          </span>
        </div>

        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'all', cursor: 'pointer',
          transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
        }}
          onClick={() => data?.onSelect(data.relId)}
          onMouseEnter={() => data?.onHover(data.relId)}
          onMouseLeave={() => data?.onHover(null)}
        >
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'white',
            background: color, padding: '2px 8px', borderRadius: 99,
            border: `1.5px solid ${color}`, whiteSpace: 'nowrap',
            boxShadow: '0 1px 4px rgba(0,0,0,.12)', transition: 'all 0.15s',
            opacity: active ? 1 : 0, pointerEvents: active ? 'all' : 'none',
          }}>
            {meta.label}
          </span>
        </div>

        {isHovered && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%, -100%) translate(${labelX}px,${labelY - 18}px)`,
            zIndex: 9999,
          }}>
            <div style={{
              background: '#1e293b', color: '#f1f5f9', borderRadius: 10,
              padding: '8px 12px', minWidth: 200, boxShadow: '0 4px 20px rgba(0,0,0,.25)',
              fontSize: 11, lineHeight: 1.5, whiteSpace: 'nowrap',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: '#94a3b8', fontSize: 10 }}>FROM</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{data?.fromLabel ?? '—'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: meta.color, fontWeight: 800, fontSize: 13 }}>{meta.src}</span>
                <div style={{ flex: 1, height: 1.5, background: meta.color, borderRadius: 1 }} />
                <span style={{ fontSize: 10, color: meta.color, fontWeight: 700 }}>{meta.label}</span>
                <div style={{ flex: 1, height: 1.5, background: meta.color, borderRadius: 1 }} />
                <span style={{ color: meta.color, fontWeight: 800, fontSize: 13 }}>{meta.tgt}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#94a3b8', fontSize: 10 }}>TO</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{data?.toLabel ?? '—'}</span>
              </div>
              <div style={{
                position: 'absolute', bottom: -6, left: '50%', transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
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
const edgeTypes = { crossRelEdge: CrossRelEdge };

// ─────────────────────────────────────────────────────────────────────────────
// New relationship dialog
// ─────────────────────────────────────────────────────────────────────────────
interface PendingConn {
  fromTableId: number; toTableId: number;
  fromColId: number | null; toColId: number | null;
}

function NewRelDialog({
  pending, viewTables, allColumns, onConfirm, onCancel,
}: {
  pending: PendingConn;
  viewTables: ViewTable[];
  allColumns: Record<number, SourceColumn[]>;
  onConfirm: (fCol: number | null, tCol: number | null, type: string) => void;
  onCancel:  () => void;
}) {
  const ft = viewTables.find((t) => t.table_id === pending.fromTableId);
  const tt = viewTables.find((t) => t.table_id === pending.toTableId);
  const [fromCol, setFromCol] = useState(pending.fromColId ? String(pending.fromColId) : '');
  const [toCol,   setToCol]   = useState(pending.toColId   ? String(pending.toColId)   : '');
  const [type,    setType]    = useState('many_to_one');
  if (!ft || !tt) return null;

  const ftPalette = getConnPalette(ft.connection_id);
  const ttPalette = getConnPalette(tt.connection_id);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm space-y-4">
        <div>
          <h3 className="font-bold text-slate-900">New relationship</h3>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full text-white"
              style={{ background: ftPalette.header }}>
              {ft.display_name || ft.table_name}
            </span>
            <span className="text-slate-400">→</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full text-white"
              style={{ background: ttPalette.header }}>
              {tt.display_name || tt.table_name}
            </span>
          </div>
          <div className="flex gap-1.5 mt-1">
            <span className="text-[10px] text-slate-400"
              style={{ color: ftPalette.header }}>{ft.connection_name}</span>
            <span className="text-[10px] text-slate-300">→</span>
            <span className="text-[10px]"
              style={{ color: ttPalette.header }}>{tt.connection_name}</span>
          </div>
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
// Right panel — relationship list + detail
// ─────────────────────────────────────────────────────────────────────────────
function IntegrationPanel({
  relationships, viewTables, columnsByTable,
  selectedRelId, onSelect, onDelete, onChangeType,
}: {
  relationships:  CrossRel[];
  viewTables:     ViewTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  selectedRelId:  number | null;
  onSelect:    (id: number | null) => void;
  onDelete:    (id: number) => void;
  onChangeType: (id: number, type: string) => void;
}) {
  const tName = (id: number) => {
    const t = viewTables.find((x) => x.table_id === id);
    return t?.display_name || t?.table_name || '—';
  };
  const cName = (tid: number, cid?: number) => {
    if (!cid) return null;
    const c = (columnsByTable[tid] ?? []).find((c) => c.id === cid);
    return c?.display_name || c?.column_name || null;
  };
  const connName = (tableId: number) => {
    const t = viewTables.find((x) => x.table_id === tableId);
    return t?.connection_name ?? '';
  };

  const sel = selectedRelId ? relationships.find((r) => r.id === selectedRelId) : null;

  return (
    <div className="flex flex-col bg-white border-l border-slate-200 flex-shrink-0" style={{ width: 280 }}>
      <div className="px-4 py-3 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-slate-800">Integrations</p>
            <p className="text-[11px] text-slate-400">{relationships.length} defined · click a line to inspect</p>
          </div>
          {sel && (
            <button onClick={() => onSelect(null)}
              className="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors">
              ← All
            </button>
          )}
        </div>
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
                  <p className="text-[10px] text-slate-400">{connName(sel.from_table_id)}</p>
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
                  <p className="text-[10px] text-slate-400">{connName(sel.to_table_id)}</p>
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
                <p className="text-sm font-medium">No integrations yet</p>
                <p className="text-xs mt-1 px-4">Drag from a column handle (●) on the side of a card to another card's column</p>
              </div>
            )}
            {relationships.map((r) => {
              const m  = getMeta(r.relationship_type);
              const fc = cName(r.from_table_id, r.from_column_id);
              const tc = cName(r.to_table_id,   r.to_column_id);
              return (
                <button key={r.id} onClick={() => onSelect(r.id)}
                  className="w-full text-left bg-slate-50 hover:bg-blue-50 border border-slate-100 hover:border-blue-200 rounded-xl p-3 transition-all group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="text-[9px] font-medium px-1.5 py-0 rounded text-white"
                          style={{ background: getConnPalette(viewTables.find(x=>x.table_id===r.from_table_id)?.connection_id ?? 0).header }}>
                          {connName(r.from_table_id)}
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-slate-700 truncate">
                        {tName(r.from_table_id)}{fc && <span className="font-mono text-slate-400">.{fc}</span>}
                      </p>
                      <div className="flex items-center gap-1 my-0.5">
                        <span style={{ fontSize: 10, fontWeight: 800, color: m.color }}>{m.src}</span>
                        <div style={{ width: 20, height: 1.5, background: m.color, borderRadius: 1 }} />
                        <svg width="5" height="7" viewBox="0 0 5 7"><path d="M0 0 L5 3.5 L0 7z" fill={m.color} /></svg>
                        <span style={{ fontSize: 10, fontWeight: 800, color: m.color }}>{m.tgt}</span>
                      </div>
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="text-[9px] font-medium px-1.5 py-0 rounded text-white"
                          style={{ background: getConnPalette(viewTables.find(x=>x.table_id===r.to_table_id)?.connection_id ?? 0).header }}>
                          {connName(r.to_table_id)}
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-slate-700 truncate">
                        {tName(r.to_table_id)}{tc && <span className="font-mono text-slate-400">.{tc}</span>}
                      </p>
                    </div>
                    <svg className="w-4 h-4 text-slate-300 group-hover:text-blue-400 mt-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
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
          Drag handle ● · click line to edit
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Views sidebar
// ─────────────────────────────────────────────────────────────────────────────
function ViewsSidebar({
  views, activeId, onSelect, onCreate, onDelete,
}: {
  views: CrossView[]; activeId: number | null;
  onSelect: (v: CrossView) => void;
  onCreate: () => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 flex-shrink-0" style={{ width: 210 }}>
      <div className="px-3 pt-3 pb-2 flex items-center justify-between flex-shrink-0 border-b border-slate-100">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Views</p>
        <button onClick={onCreate} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ New</button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {views.length === 0 && (
          <p className="px-3 py-4 text-xs text-slate-400 italic">No views yet.</p>
        )}
        {views.map((v) => (
          <div key={v.id}
            className={`group flex items-start px-3 py-2.5 transition-colors cursor-pointer ${
              activeId === v.id ? 'bg-blue-50' : 'hover:bg-slate-50'
            }`}
            onClick={() => onSelect(v)}
          >
            <div className="flex-1 min-w-0">
              <p className={`text-sm truncate ${activeId === v.id ? 'text-blue-700 font-semibold' : 'text-slate-700'}`}>
                {v.name}
              </p>
              {v.description && (
                <p className="text-[10px] text-slate-400 truncate mt-0.5">{v.description}</p>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(v.id); }}
              className="flex-shrink-0 opacity-0 group-hover:opacity-100 ml-1 mt-0.5 p-0.5 rounded text-slate-300 hover:text-red-400 transition-all"
              title="Delete view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Table palette (drag source)
// ─────────────────────────────────────────────────────────────────────────────
function TablePalette({
  connections, tablesByConn, loadingConns, expandedConns, onToggleConn, onDragStart,
}: {
  connections:  Connection[];
  tablesByConn: Record<number, SourceTable[]>;
  loadingConns: Set<number>;
  expandedConns: Set<number>;
  onToggleConn:  (id: number) => void;
  onDragStart:   (e: React.DragEvent, table: SourceTable) => void;
}) {
  return (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 flex-shrink-0 overflow-y-auto" style={{ width: 190 }}>
      <div className="px-3 pt-3 pb-2 flex-shrink-0 border-b border-slate-100">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Tables</p>
        <p className="text-[10px] text-slate-400 mt-0.5">Drag onto canvas</p>
      </div>
      {connections.map((conn) => {
        const tables   = tablesByConn[conn.id] ?? [];
        const loading  = loadingConns.has(conn.id);
        const expanded = expandedConns.has(conn.id);
        const pal      = getConnPalette(conn.id);
        return (
          <div key={conn.id}>
            <button
              onClick={() => onToggleConn(conn.id)}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-bold transition-colors select-none"
              style={{ background: pal.header + '18', color: pal.header, borderBottom: `1px solid ${pal.header}22` }}
            >
              <svg className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
              <span className="truncate flex-1 text-left">{conn.name}</span>
              {loading && <div className="w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />}
              {!loading && tables.length > 0 && <span className="text-[10px] opacity-60">{tables.length}</span>}
            </button>
            {expanded && !loading && (
              <div>
                {tables.length === 0 && (
                  <p className="px-4 py-2 text-[10px] text-slate-400 italic">No tables</p>
                )}
                {tables.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, t)}
                    className="flex items-center gap-1.5 px-4 py-1.5 cursor-grab active:cursor-grabbing hover:bg-slate-50 select-none"
                  >
                    <svg className="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M10 4v16M3 4h18a1 1 0 011 1v14a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1z" />
                    </svg>
                    <span className="text-xs text-slate-700 truncate">{t.display_name || t.table_name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner canvas — uses useReactFlow (must be inside ReactFlowProvider)
// ─────────────────────────────────────────────────────────────────────────────
function InnerCanvas() {
  const { screenToFlowPosition } = useReactFlow();

  // ── Views list ───────────────────────────────────────────────────────────
  const [views, setViews]         = useState<CrossView[]>([]);
  const [activeView, setActiveView] = useState<CrossView | null>(null);

  // ── Canvas data ──────────────────────────────────────────────────────────
  const [viewTables, setViewTables]         = useState<ViewTable[]>([]);
  const [columns, setColumns]               = useState<SourceColumn[]>([]);
  const [relationships, setRelationships]   = useState<CrossRel[]>([]);

  // ── Source palette ───────────────────────────────────────────────────────
  const [connections, setConnections]   = useState<Connection[]>([]);
  const [tablesByConn, setTablesByConn] = useState<Record<number, SourceTable[]>>({});
  const [loadingConns, setLoadingConns] = useState<Set<number>>(new Set());
  const [expandedConns, setExpandedConns] = useState<Set<number>>(new Set());

  // ── ReactFlow state ──────────────────────────────────────────────────────
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelEdgeData>([]);

  // ── Interaction state ────────────────────────────────────────────────────
  const [pending, setPending]       = useState<PendingConn | null>(null);
  const [selectedRelId, setSelectedRelId] = useState<number | null>(null);
  const [hoveredRelId, setHoveredRelId]   = useState<number | null>(null);

  // ── New view modal ───────────────────────────────────────────────────────
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName]           = useState('');
  const [newDesc, setNewDesc]           = useState('');
  const [saving, setSaving]             = useState(false);

  const pendingDropRef = useRef<SourceTable | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────
  const colsByTable = useMemo(() => {
    const m: Record<number, SourceColumn[]> = {};
    for (const col of columns) {
      if (!m[col.table_id]) m[col.table_id] = [];
      m[col.table_id].push(col);
    }
    return m;
  }, [columns]);

  // ── Build ReactFlow nodes from viewTables ────────────────────────────────
  const buildNodes = useCallback((
    vts: ViewTable[], cols: Record<number, SourceColumn[]>, selRelId: number | null,
    onRemove: (tableId: number) => void,
  ): Node<TableNodeData>[] =>
    vts.map((vt) => {
      const pal = getConnPalette(vt.connection_id);
      return {
        id:   String(vt.table_id),
        type: 'tableNode',
        position: { x: vt.pos_x, y: vt.pos_y },
        data: {
          tableId:        vt.table_id,
          tableName:      vt.table_name,
          displayName:    vt.display_name,
          connectionId:   vt.connection_id,
          connectionName: vt.connection_name,
          columns:        cols[vt.table_id] ?? [],
          headerBg:       pal.header,
          accentColor:    pal.sub,
          focused:        false,
          onRemove,
        },
      };
    }),
  []);

  // ── Build ReactFlow edges from relationships ─────────────────────────────
  const buildEdges = useCallback((
    rels: CrossRel[], vts: ViewTable[], cols: Record<number, SourceColumn[]>,
    selId: number | null, hovId: number | null,
    onSelect: (id: number) => void, onHover: (id: number | null) => void,
  ): Edge<RelEdgeData>[] =>
    rels.map((r) => {
      const fromVt = vts.find((x) => x.table_id === r.from_table_id);
      const toVt   = vts.find((x) => x.table_id === r.to_table_id);
      if (!fromVt || !toVt) return null as unknown as Edge<RelEdgeData>;

      const fromColName = r.from_column_id
        ? (cols[r.from_table_id] ?? []).find((c) => c.id === r.from_column_id)?.display_name
          || (cols[r.from_table_id] ?? []).find((c) => c.id === r.from_column_id)?.column_name
          || String(r.from_column_id)
        : (fromVt.display_name || fromVt.table_name);
      const toColName = r.to_column_id
        ? (cols[r.to_table_id] ?? []).find((c) => c.id === r.to_column_id)?.display_name
          || (cols[r.to_table_id] ?? []).find((c) => c.id === r.to_column_id)?.column_name
          || String(r.to_column_id)
        : (toVt.display_name || toVt.table_name);

      const srcHandle = r.from_column_id ? hR(r.from_column_id) : hR('table');
      const tgtHandle = r.to_column_id   ? hL(r.to_column_id)   : hL('table');

      return {
        id:           String(r.id),
        source:       String(r.from_table_id),
        target:       String(r.to_table_id),
        sourceHandle: srcHandle,
        targetHandle: tgtHandle,
        type:         'crossRelEdge',
        data: {
          relType:   r.relationship_type,
          relId:     r.id,
          selected:  selId === r.id,
          hovered:   hovId === r.id,
          fromLabel: fromColName,
          toLabel:   toColName,
          onSelect,
          onHover,
        },
      };
    }).filter(Boolean),
  []);

  // Stable callbacks for remove/select/hover (avoid rebuilding nodes/edges on every render)
  const handleRemoveRef   = useRef<(tableId: number) => void>(() => {});
  const handleSelectRef   = useRef<(id: number) => void>(() => {});
  const handleHoverRef    = useRef<(id: number | null) => void>(() => {});

  // ── Sync nodes/edges whenever data changes ───────────────────────────────
  useEffect(() => {
    setNodes(buildNodes(viewTables, colsByTable, selectedRelId, handleRemoveRef.current));
  }, [viewTables, colsByTable, selectedRelId, buildNodes, setNodes]);

  useEffect(() => {
    setEdges(buildEdges(relationships, viewTables, colsByTable, selectedRelId, hoveredRelId,
      handleSelectRef.current, handleHoverRef.current));
  }, [relationships, viewTables, colsByTable, selectedRelId, hoveredRelId, buildEdges, setEdges]);

  // Stable wrappers
  const handleRemoveTable = useCallback(async (tableId: number) => {
    if (!activeView) return;
    try {
      await api.delete(`/cross-views/${activeView.id}/tables/${tableId}`);
      setViewTables((p) => p.filter((x) => x.table_id !== tableId));
      setRelationships((p) => p.filter((r) => r.from_table_id !== tableId && r.to_table_id !== tableId));
    } catch { /* ignore */ }
  }, [activeView]);
  handleRemoveRef.current = handleRemoveTable;

  const handleSelectRel = useCallback((id: number) => setSelectedRelId(id), []);
  handleSelectRef.current = handleSelectRel;

  const handleHoverRel = useCallback((id: number | null) => setHoveredRelId(id), []);
  handleHoverRef.current = handleHoverRel;

  // ── Load on mount ────────────────────────────────────────────────────────
  useEffect(() => {
    api.get('/cross-views').then((r) => {
      const list: CrossView[] = r.data.data ?? [];
      setViews(list);
      if (list.length) loadView(list[0]);
    }).catch(() => {});

    api.get('/connections').then((r) => {
      const conns: Connection[] = r.data.data ?? [];
      setConnections(conns);
      if (conns.length) {
        setExpandedConns(new Set([conns[0].id]));
        loadPaletteTables(conns[0].id);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPaletteTables(connId: number) {
    if (tablesByConn[connId]) return;
    setLoadingConns((p) => new Set(p).add(connId));
    try {
      const r = await api.get(`/semantic/tables?connectionId=${connId}`);
      setTablesByConn((p) => ({ ...p, [connId]: r.data.data ?? [] }));
    } finally {
      setLoadingConns((p) => { const s = new Set(p); s.delete(connId); return s; });
    }
  }

  function togglePaletteConn(connId: number) {
    setExpandedConns((p) => { const s = new Set(p); s.has(connId) ? s.delete(connId) : s.add(connId); return s; });
    loadPaletteTables(connId);
  }

  async function loadView(view: CrossView) {
    setActiveView(view);
    setSelectedRelId(null);
    try {
      const r = await api.get(`/cross-views/${view.id}`);
      const { viewTables: vt, columns: cols, relationships: rels } = r.data.data;
      setViewTables(vt ?? []);
      setColumns(cols ?? []);
      setRelationships(rels ?? []);
    } catch {
      setViewTables([]); setColumns([]); setRelationships([]);
    }
  }

  // ── Delete a view ────────────────────────────────────────────────────────
  async function handleDeleteView(id: number) {
    if (!confirm('Delete this view? This cannot be undone.')) return;
    try {
      await api.delete(`/cross-views/${id}`);
      setViews((p) => p.filter((v) => v.id !== id));
      if (activeView?.id === id) {
        setActiveView(null);
        setViewTables([]);
        setColumns([]);
        setRelationships([]);
      }
    } catch { /* ignore */ }
  }

  // ── Create new view ──────────────────────────────────────────────────────
  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const r = await api.post('/cross-views', { name: newName.trim(), description: newDesc.trim() || undefined });
      const created: CrossView = { id: r.data.data.id, name: newName.trim(), description: newDesc.trim() || undefined };
      setViews((p) => [created, ...p]);
      setShowNewModal(false); setNewName(''); setNewDesc('');
      loadView(created);
    } finally { setSaving(false); }
  }

  // ── Drop from palette onto canvas ────────────────────────────────────────
  function handlePaletteDragStart(e: React.DragEvent, table: SourceTable) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', String(table.id));
    pendingDropRef.current = table;
  }

  async function handleCanvasDrop(e: React.DragEvent) {
    e.preventDefault();
    const table = pendingDropRef.current;
    if (!table || !activeView) return;
    pendingDropRef.current = null;

    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    try {
      await api.post(`/cross-views/${activeView.id}/tables`, {
        tableId: table.id, posX: position.x, posY: position.y,
      });
      const vr = await api.get(`/cross-views/${activeView.id}`);
      const { viewTables: vt, columns: cols, relationships: rels } = vr.data.data;
      setViewTables(vt ?? []);
      setColumns(cols ?? []);
      setRelationships(rels ?? []);
    } catch { /* ignore */ }
  }

  // ── Node drag stop → persist position ───────────────────────────────────
  const onNodeDragStop: NodeDragHandler = useCallback(async (_, node) => {
    if (!activeView) return;
    const tableId = Number(node.id);
    setViewTables((p) => p.map((vt) =>
      vt.table_id === tableId ? { ...vt, pos_x: node.position.x, pos_y: node.position.y } : vt
    ));
    await api.patch(`/cross-views/${activeView.id}/tables/${tableId}/position`, {
      posX: node.position.x, posY: node.position.y,
    }).catch(() => {});
  }, [activeView]);

  // ── ReactFlow connection (handle drag) ───────────────────────────────────
  const onConnect = useCallback((params: Connection) => {
    const fromTableId = Number(params.source);
    const toTableId   = Number(params.target);
    const fromColId   = parseHandle(params.sourceHandle);
    const toColId     = parseHandle(params.targetHandle);
    setPending({ fromTableId, toTableId, fromColId, toColId });
  }, []);

  // ── Confirm new relationship ─────────────────────────────────────────────
  async function handleConfirmRel(fCol: number | null, tCol: number | null, type: string) {
    if (!pending || !activeView) return;
    setPending(null);
    try {
      const r = await api.post(`/cross-views/${activeView.id}/relationships`, {
        fromTableId: pending.fromTableId, fromColumnId: fCol,
        toTableId:   pending.toTableId,   toColumnId:   tCol,
        relationshipType: type,
      });
      setRelationships((p) => [...p, {
        id: r.data.data.id,
        from_table_id: pending.fromTableId, from_column_id: fCol ?? undefined,
        to_table_id:   pending.toTableId,   to_column_id:   tCol ?? undefined,
        relationship_type: type,
      }]);
    } catch { /* ignore */ }
  }

  // ── Delete / change relationship type ────────────────────────────────────
  async function handleDeleteRel(relId: number) {
    if (!activeView) return;
    await api.delete(`/cross-views/${activeView.id}/relationships/${relId}`).catch(() => {});
    setRelationships((p) => p.filter((r) => r.id !== relId));
  }

  async function handleChangeType(relId: number, type: string) {
    // No dedicated PATCH yet — delete + recreate preserving column links
    const rel = relationships.find((r) => r.id === relId);
    if (!rel || !activeView) return;
    await handleDeleteRel(relId);
    try {
      const r = await api.post(`/cross-views/${activeView.id}/relationships`, {
        fromTableId: rel.from_table_id, fromColumnId: rel.from_column_id,
        toTableId:   rel.to_table_id,   toColumnId:   rel.to_column_id,
        relationshipType: type,
      });
      setRelationships((p) => [...p, { ...rel, id: r.data.data.id, relationship_type: type }]);
      setSelectedRelId(r.data.data.id);
    } catch { /* ignore */ }
  }

  // ── Auto-layout with dagre ────────────────────────────────────────────────
  function resetLayout() {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', ranksep: 120, nodesep: 60 });
    g.setDefaultEdgeLabel(() => ({}));
    viewTables.forEach((vt) => {
      const h = HEADER_H + (colsByTable[vt.table_id]?.length ?? 0) * ROW_H;
      g.setNode(String(vt.table_id), { width: NODE_W, height: h });
    });
    relationships.forEach((r) => g.setEdge(String(r.from_table_id), String(r.to_table_id)));
    dagre.layout(g);

    const updated = viewTables.map((vt) => {
      const n = g.node(String(vt.table_id));
      return { ...vt, pos_x: n.x - NODE_W / 2, pos_y: n.y - (HEADER_H + (colsByTable[vt.table_id]?.length ?? 0) * ROW_H) / 2 };
    });
    setViewTables(updated);

    if (activeView) {
      updated.forEach((vt) =>
        api.patch(`/cross-views/${activeView.id}/tables/${vt.table_id}/position`, {
          posX: vt.pos_x, posY: vt.pos_y,
        }).catch(() => {})
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col bg-slate-100" style={{ height: '100vh', overflow: 'hidden' }}>
      <Nav />

      <div className="flex flex-1 min-h-0">
        <ViewsSidebar
          views={views} activeId={activeView?.id ?? null}
          onSelect={loadView} onCreate={() => setShowNewModal(true)}
          onDelete={handleDeleteView}
        />

        <TablePalette
          connections={connections} tablesByConn={tablesByConn}
          loadingConns={loadingConns} expandedConns={expandedConns}
          onToggleConn={togglePaletteConn} onDragStart={handlePaletteDragStart}
        />

        {/* ReactFlow canvas */}
        <div
          className="flex-1 min-h-0"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleCanvasDrop}
        >
          {!activeView ? (
            <div className="flex-1 h-full flex items-center justify-center text-slate-400">
              <div className="text-center">
                <p className="text-sm font-medium mb-1">No view selected</p>
                <p className="text-xs">Create a new view or select one from the left</p>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes} edges={edges}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStop={onNodeDragStop}
              nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              connectionMode={ConnectionMode.Loose}
              fitView fitViewOptions={{ padding: 0.25 }}
              onPaneClick={() => setSelectedRelId(null)}
              deleteKeyCode={null}
              minZoom={0.2} maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
              <Controls showInteractive={false} />

              {/* Top toolbar */}
              <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}
                className="flex items-center gap-2 bg-white rounded-xl shadow-sm border border-slate-200 px-3 py-1.5">
                <span className="text-sm font-semibold text-slate-700">{activeView.name}</span>
                {viewTables.length > 0 && (
                  <button onClick={resetLayout}
                    className="text-xs text-slate-500 hover:text-slate-800 px-2 py-0.5 rounded hover:bg-slate-100 transition-colors">
                    ↺ Layout
                  </button>
                )}
              </div>

              {/* Empty state */}
              {viewTables.length === 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div className="text-center text-slate-400">
                    <p className="text-4xl mb-3">🗂️</p>
                    <p className="text-sm font-medium">Canvas is empty</p>
                    <p className="text-xs mt-1">Drag tables from the left panel onto this canvas</p>
                  </div>
                </div>
              )}
            </ReactFlow>
          )}
        </div>

        {/* Right panel */}
        <IntegrationPanel
          relationships={relationships} viewTables={viewTables}
          columnsByTable={colsByTable}
          selectedRelId={selectedRelId}
          onSelect={setSelectedRelId} onDelete={handleDeleteRel} onChangeType={handleChangeType}
        />
      </div>

      {/* New relationship dialog */}
      {pending && (
        <NewRelDialog
          pending={pending} viewTables={viewTables} allColumns={colsByTable}
          onConfirm={handleConfirmRel} onCancel={() => setPending(null)}
        />
      )}

      {/* New view modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-slate-900 mb-4">New integration view</h2>
            <div className="mb-3">
              <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                placeholder="e.g. Sales × HR overview" />
            </div>
            <div className="mb-5">
              <label className="block text-xs font-medium text-slate-600 mb-1">Description (optional)</label>
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                placeholder="Short description" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowNewModal(false); setNewName(''); setNewDesc(''); }}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !newName.trim()}
                className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40">
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page export — wrap with ReactFlowProvider
// ─────────────────────────────────────────────────────────────────────────────
export default function IntegrationsPage() {
  return (
    <ReactFlowProvider>
      <InnerCanvas />
    </ReactFlowProvider>
  );
}

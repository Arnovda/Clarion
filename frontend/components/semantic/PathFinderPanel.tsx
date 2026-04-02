'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  Node, Edge, NodeProps,
  Handle, Position,
  EdgeProps, getBezierPath, EdgeLabelRenderer,
  ReactFlowProvider, useReactFlow, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import api from '@/lib/api';
import { SourceTable, SourceColumn } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants (match RelationshipCanvas)
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_H = 50;
const ROW_H    = 26;
const NODE_W   = 220;

const TYPE_META: Record<string, { color: string; label: string; src: string; tgt: string }> = {
  many_to_one:  { color: '#d97706', label: 'N → 1',  src: 'N', tgt: '1' },
  one_to_many:  { color: '#2563eb', label: '1 → N',  src: '1', tgt: 'N' },
  one_to_one:   { color: '#059669', label: '1 → 1',  src: '1', tgt: '1' },
  many_to_many: { color: '#7c3aed', label: 'N ↔ N',  src: 'N', tgt: 'N' },
};
const getMeta = (t: string) =>
  TYPE_META[t] ?? { color: '#64748b', label: t, src: '?', tgt: '?' };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface PathTable {
  pgId: number;
  tableName: string;
  displayName: string;
}
interface PathRel {
  pgId: number;
  fromTablePgId: number;
  fromColPgId: number | null;
  fromColName: string | null;
  toTablePgId: number;
  toColPgId: number | null;
  toColName: string | null;
  relType: string;
}
interface PathResult {
  tables: PathTable[];
  relationships: PathRel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact table node for path display
// ─────────────────────────────────────────────────────────────────────────────
interface PathNodeData {
  label: string;
  subLabel: string;
  isEndpoint: boolean; // from/to table highlighted differently
  columns: { name: string; highlighted: boolean }[];
}

function PathTableNode({ data }: NodeProps<PathNodeData>) {
  const { label, subLabel, isEndpoint, columns } = data;
  const totalH = HEADER_H + columns.length * ROW_H;
  const borderColor = isEndpoint ? '#2563eb' : '#94a3b8';

  return (
    <div style={{ position: 'relative', width: NODE_W, height: totalH }}>
      {/* Table-level handles */}
      <Handle type="source" position={Position.Left} id="L_table"
        style={{ width: 8, height: 8, background: '#93c5fd', border: '2px solid white', borderRadius: '50%',
          position: 'absolute', top: HEADER_H / 2, left: -4, transform: 'translateY(-50%)' }} />
      <Handle type="source" position={Position.Right} id="R_table"
        style={{ width: 8, height: 8, background: '#93c5fd', border: '2px solid white', borderRadius: '50%',
          position: 'absolute', top: HEADER_H / 2, right: -4, transform: 'translateY(-50%)' }} />

      {/* Column handles */}
      {columns.map((_, i) => {
        const top = HEADER_H + i * ROW_H + ROW_H / 2;
        return (
          <div key={i}>
            <Handle type="source" position={Position.Left} id={`L_${i}`}
              style={{ width: 8, height: 8, background: '#93c5fd', border: '2px solid white', borderRadius: '50%',
                position: 'absolute', top, left: -4, transform: 'translateY(-50%)' }} />
            <Handle type="source" position={Position.Right} id={`R_${i}`}
              style={{ width: 8, height: 8, background: '#93c5fd', border: '2px solid white', borderRadius: '50%',
                position: 'absolute', top, right: -4, transform: 'translateY(-50%)' }} />
          </div>
        );
      })}

      <div style={{
        position: 'absolute', inset: 0, borderRadius: 10, overflow: 'hidden',
        border: `2px solid ${borderColor}`, background: '#fff',
        boxShadow: isEndpoint
          ? '0 0 0 3px #bfdbfe, 0 4px 16px rgba(37,99,235,.15)'
          : '0 2px 8px rgba(0,0,0,.08)',
      }}>
        <div style={{
          height: HEADER_H, padding: '8px 12px',
          background: isEndpoint ? '#1d4ed8' : '#475569',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
          <p style={{ margin: 0, color: '#fff', fontSize: 12, fontWeight: 700,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </p>
          <p style={{ margin: '1px 0 0', color: 'rgba(255,255,255,.6)', fontSize: 9, fontFamily: 'monospace' }}>
            {subLabel}
          </p>
        </div>
        {columns.map((col, i) => (
          <div key={i} style={{
            height: ROW_H, display: 'flex', alignItems: 'center', gap: 6,
            padding: '0 12px',
            background: col.highlighted ? '#dbeafe' : i % 2 === 0 ? '#fff' : '#f8fafc',
            borderTop: '1px solid #f1f5f9',
            borderLeft: col.highlighted ? '3px solid #2563eb' : '3px solid transparent',
          }}>
            <span style={{
              fontSize: 11, fontWeight: col.highlighted ? 700 : 500,
              color: col.highlighted ? '#1d4ed8' : '#334155',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{col.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Path edge
// ─────────────────────────────────────────────────────────────────────────────
interface PathEdgeData {
  relType: string;
  fromColName: string | null;
  toColName: string | null;
  pathIndex: number;  // which path this edge belongs to
  activePathIndex: number; // which path is currently active (-1 = all)
}

const PATH_COLORS = ['#2563eb', '#d97706', '#059669', '#7c3aed', '#dc2626', '#0891b2', '#be185d', '#65a30d'];

function PathEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps<PathEdgeData>) {
  const meta = getMeta(data?.relType ?? '');
  const pathIdx = data?.pathIndex ?? 0;
  const activeIdx = data?.activePathIndex ?? -1;
  const isActive = activeIdx === -1 || activeIdx === pathIdx;
  const pathColor = PATH_COLORS[pathIdx % PATH_COLORS.length];
  const color = isActive ? pathColor : '#e2e8f0';
  const markerId = `parr-${id}`;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.3,
  });

  return (
    <g style={{ opacity: isActive ? 1 : 0.15, transition: 'opacity 0.2s' }}>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
        </marker>
      </defs>
      <path d={edgePath} fill="none" stroke="white" strokeWidth={8} />
      <path d={edgePath} fill="none" stroke={color} strokeWidth={2.5}
        markerEnd={`url(#${markerId})`}
        style={{ transition: 'stroke 0.2s' }}
      />
      <EdgeLabelRenderer>
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, color: '#fff',
            background: isActive ? pathColor : '#cbd5e1',
            padding: '2px 7px', borderRadius: 99,
            boxShadow: '0 1px 4px rgba(0,0,0,.12)',
            whiteSpace: 'nowrap',
          }}>
            {meta.src} → {meta.tgt}
          </span>
        </div>
        {/* Source cardinality label */}
        {isActive && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%,-50%) translate(${
              sourceX + (sourcePosition === Position.Right ? 16 : -16)
            }px,${sourceY - 12}px)`,
          }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: pathColor }}>
              {meta.src}
            </span>
          </div>
        )}
        {/* Target cardinality label */}
        {isActive && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%,-50%) translate(${
              targetX + (targetPosition === Position.Left ? -16 : 16)
            }px,${targetY - 12}px)`,
          }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: pathColor }}>
              {meta.tgt}
            </span>
          </div>
        )}
        {/* Column names near endpoints */}
        {isActive && data?.fromColName && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%,-50%) translate(${sourceX + (sourcePosition === Position.Right ? 16 : -16)}px,${sourceY + 10}px)`,
          }}>
            <span style={{ fontSize: 8, fontFamily: 'monospace', color: pathColor, fontWeight: 600 }}>
              {data.fromColName}
            </span>
          </div>
        )}
        {isActive && data?.toColName && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%,-50%) translate(${targetX + (targetPosition === Position.Left ? -16 : 16)}px,${targetY + 10}px)`,
          }}>
            <span style={{ fontSize: 8, fontFamily: 'monospace', color: pathColor, fontWeight: 600 }}>
              {data.toColName}
            </span>
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
}

const pathNodeTypes = { pathTableNode: PathTableNode };
const pathEdgeTypes = { pathEdge: PathEdge };

// ─────────────────────────────────────────────────────────────────────────────
// Dagre layout for path nodes
// ─────────────────────────────────────────────────────────────────────────────
function layoutPathNodes(
  nodes: Node[], edges: Edge[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 200, nodesep: 60, marginx: 60, marginy: 60 });

  nodes.forEach((n) => {
    const colCount = (n.data as PathNodeData).columns.length;
    g.setNode(n.id, { width: NODE_W, height: HEADER_H + colCount * ROW_H });
  });
  edges.forEach((e) => { g.setEdge(e.source, e.target); });
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n) => {
    const layoutNode = g.node(n.id);
    if (layoutNode) {
      const colCount = (n.data as PathNodeData).columns.length;
      const h = HEADER_H + colCount * ROW_H;
      positions.set(n.id, { x: layoutNode.x - NODE_W / 2, y: layoutNode.y - h / 2 });
    }
  });
  return positions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas inner
// ─────────────────────────────────────────────────────────────────────────────
function PathCanvas({
  connectionId, tables, columnsByTable, paths, fromTableId, toTableId, activePathIndex,
}: {
  connectionId: string;
  tables: SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  paths: PathResult[];
  fromTableId: number;
  toTableId: number;
  activePathIndex: number; // -1 = show all
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (paths.length === 0) return;

    // Collect all unique table IDs across all paths
    const tableIdSet = new Set<number>();
    // Collect highlighted columns per table
    const highlightedCols = new Map<number, Set<string>>(); // tableId → col names

    paths.forEach((p) => {
      p.tables.forEach((t) => tableIdSet.add(t.pgId));
      p.relationships.forEach((r) => {
        if (r.fromColName) {
          if (!highlightedCols.has(r.fromTablePgId)) highlightedCols.set(r.fromTablePgId, new Set());
          highlightedCols.get(r.fromTablePgId)!.add(r.fromColName);
        }
        if (r.toColName) {
          if (!highlightedCols.has(r.toTablePgId)) highlightedCols.set(r.toTablePgId, new Set());
          highlightedCols.get(r.toTablePgId)!.add(r.toColName);
        }
      });
    });

    // Build nodes — only show columns involved in joins
    const newNodes: Node[] = [];
    tableIdSet.forEach((tid) => {
      const pathTable = paths[0].tables.find((t) => t.pgId === tid)
        ?? paths.flatMap((p) => p.tables).find((t) => t.pgId === tid);
      const srcTable = tables.find((t) => t.id === tid);
      const label = srcTable?.display_name || pathTable?.displayName || pathTable?.tableName || String(tid);
      const subLabel = srcTable?.table_name || pathTable?.tableName || '';
      const allCols = columnsByTable[tid] ?? [];
      const hlNames = highlightedCols.get(tid) ?? new Set();

      // Show only join columns for intermediate tables; show all for endpoints
      const isEndpoint = tid === fromTableId || tid === toTableId;
      const cols = isEndpoint
        ? allCols.map((c) => ({ name: c.display_name || c.column_name, highlighted: hlNames.has(c.column_name) }))
        : allCols.filter((c) => hlNames.has(c.column_name)).map((c) => ({ name: c.display_name || c.column_name, highlighted: true }));

      // If intermediate has no join columns visible, show a placeholder
      const finalCols = cols.length > 0 ? cols : [{ name: '(join column)', highlighted: true }];

      newNodes.push({
        id: String(tid),
        type: 'pathTableNode',
        position: { x: 0, y: 0 },
        data: { label, subLabel, isEndpoint, columns: finalCols },
      });
    });

    // Build preliminary edges for dagre (just need source/target for ranking)
    const prelEdges: { source: string; target: string }[] = [];
    paths.forEach((p) => {
      // Use path table order for edge direction (consecutive pairs)
      for (let ti = 0; ti < p.tables.length - 1; ti++) {
        prelEdges.push({
          source: String(p.tables[ti].pgId),
          target: String(p.tables[ti + 1].pgId),
        });
      }
    });

    // Layout first, then build edges with correct handle sides
    const positions = layoutPathNodes(newNodes, prelEdges.map((e, i) => ({
      id: `prel-${i}`, source: e.source, target: e.target, type: 'pathEdge',
    } as Edge)));
    newNodes.forEach((n) => {
      const pos = positions.get(n.id);
      if (pos) n.position = pos;
    });

    // Now build real edges using positions for handle side
    const newEdges: Edge[] = [];
    paths.forEach((p, pi) => {
      // Walk path in table order; match each step to a relationship
      for (let ti = 0; ti < p.tables.length - 1; ti++) {
        const srcTid = p.tables[ti].pgId;
        const tgtTid = p.tables[ti + 1].pgId;

        // Find the relationship for this hop (may be in either direction)
        const rel = p.relationships.find((r) =>
          (r.fromTablePgId === srcTid && r.toTablePgId === tgtTid) ||
          (r.fromTablePgId === tgtTid && r.toTablePgId === srcTid)
        );
        if (!rel) continue;

        const isForward = rel.fromTablePgId === srcTid;
        const fromColName = isForward ? rel.fromColName : rel.toColName;
        const toColName   = isForward ? rel.toColName   : rel.fromColName;
        const relType     = isForward ? rel.relType
          : rel.relType === 'many_to_one' ? 'one_to_many'
          : rel.relType === 'one_to_many' ? 'many_to_one'
          : rel.relType;

        const srcPos = positions.get(String(srcTid));
        const tgtPos = positions.get(String(tgtTid));
        const srcIsRight = srcPos && tgtPos ? srcPos.x > tgtPos.x : false;

        newEdges.push({
          id: `path-${pi}-${ti}`,
          source: String(srcTid),
          target: String(tgtTid),
          sourceHandle: srcIsRight ? 'L_table' : 'R_table',
          targetHandle: srcIsRight ? 'R_table' : 'L_table',
          type: 'pathEdge',
          data: {
            relType,
            fromColName,
            toColName,
            pathIndex: pi,
            activePathIndex: activePathIndex,
          },
        });
      }
    });

    setNodes(newNodes);
    setEdges(newEdges);

    setTimeout(() => fitView({ duration: 500, padding: 0.25 }), 100);
  }, [paths, fromTableId, toTableId, activePathIndex, tables, columnsByTable, fitView, setNodes, setEdges]);

  // Update activePathIndex on edges without full rebuild
  useEffect(() => {
    setEdges((prev) =>
      prev.map((e) => ({
        ...e,
        data: { ...e.data, activePathIndex },
      })),
    );
  }, [activePathIndex, setEdges]);

  if (paths.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        <div className="text-center">
          <p className="text-4xl mb-3">🔍</p>
          <p className="font-medium">Select two tables to find join paths</p>
          <p className="text-xs mt-1">Use the dropdowns on the left to pick a start and end table</p>
        </div>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes} edges={edges}
      nodeTypes={pathNodeTypes} edgeTypes={pathEdgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView fitViewOptions={{ padding: 0.25 }}
      connectionMode={ConnectionMode.Loose}
      minZoom={0.2} maxZoom={1.5}
      nodesDraggable
      nodesConnectable={false}
    >
      <Background color="#e2e8f0" gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => n.data?.isEndpoint ? '#2563eb' : '#475569'}
        nodeStrokeColor="#bfdbfe"
        maskColor="rgba(241,245,249,0.7)"
        style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
      />
    </ReactFlow>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main panel
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  connectionId: string;
  tables: SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
}

export default function PathFinderPanel({ connectionId, tables, columnsByTable }: Props) {
  const [fromTableId, setFromTableId] = useState<number | null>(null);
  const [toTableId, setToTableId]     = useState<number | null>(null);
  const [paths, setPaths]             = useState<PathResult[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [activePathIdx, setActivePathIdx] = useState(-1); // -1 = all paths

  const canSearch = fromTableId && toTableId && fromTableId !== toTableId;

  const handleSearch = useCallback(async () => {
    if (!canSearch) return;
    setLoading(true);
    setError(null);
    setPaths([]);
    setActivePathIdx(-1);
    try {
      const res = await api.get(`/semantic/paths`, {
        params: { connectionId, fromTableId, toTableId },
      });
      const data = res.data?.data ?? res.data;
      const resultPaths: PathResult[] = data?.paths ?? [];
      setPaths(resultPaths);
      if (resultPaths.length === 0) {
        setError('No join path found between these tables');
      }
    } catch {
      setError('Failed to find paths');
    } finally {
      setLoading(false);
    }
  }, [canSearch, connectionId, fromTableId, toTableId]);

  // Auto-search when both tables are selected
  useEffect(() => {
    if (canSearch) handleSearch();
  }, [fromTableId, toTableId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tName = (id: number) => {
    const t = tables.find((t) => t.id === id);
    return t?.display_name || t?.table_name || String(id);
  };

  // Swap button
  const handleSwap = () => {
    setFromTableId(toTableId);
    setToTableId(fromTableId);
  };

  return (
    <div className="flex flex-1 min-h-0" style={{ height: '100%' }}>
      {/* Left control panel */}
      <div className="flex flex-col bg-white border-r border-slate-200 flex-shrink-0" style={{ width: 280 }}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🔍</span>
            <div>
              <p className="text-sm font-bold text-slate-800">Path Finder</p>
              <p className="text-[11px] text-slate-400">Find join paths between tables</p>
            </div>
          </div>
        </div>

        {/* Table selectors */}
        <div className="px-4 py-3 space-y-3 border-b border-slate-100 flex-shrink-0">
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">From table</label>
            <select
              value={fromTableId ?? ''}
              onChange={(e) => setFromTableId(e.target.value ? Number(e.target.value) : null)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">Select table…</option>
              {tables.filter((t) => t.is_active).map((t) => (
                <option key={t.id} value={t.id}>{t.display_name || t.table_name}</option>
              ))}
            </select>
          </div>

          {/* Swap button */}
          <div className="flex justify-center">
            <button
              onClick={handleSwap}
              disabled={!fromTableId && !toTableId}
              className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-30"
              title="Swap tables"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">To table</label>
            <select
              value={toTableId ?? ''}
              onChange={(e) => setToTableId(e.target.value ? Number(e.target.value) : null)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">Select table…</option>
              {tables.filter((t) => t.is_active && t.id !== fromTableId).map((t) => (
                <option key={t.id} value={t.id}>{t.display_name || t.table_name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">Finding paths…</span>
              </div>
            </div>
          )}

          {error && !loading && (
            <div className="p-4">
              <div className="bg-slate-50 rounded-xl p-4 text-center">
                <p className="text-2xl mb-2">🚫</p>
                <p className="text-sm font-medium text-slate-600">{error}</p>
                <p className="text-xs text-slate-400 mt-1">These tables may not be connected through relationships</p>
              </div>
            </div>
          )}

          {!loading && paths.length > 0 && (
            <div className="p-3 space-y-2">
              {/* All paths toggle */}
              <button
                onClick={() => setActivePathIdx(-1)}
                className={`w-full text-left px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                  activePathIdx === -1
                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                    : 'border-slate-100 text-slate-500 hover:bg-slate-50'
                }`}
              >
                All paths ({paths.length})
              </button>

              {paths.map((p, i) => {
                const pathColor = PATH_COLORS[i % PATH_COLORS.length];
                const hops = p.tables.length - 1;
                return (
                  <button
                    key={i}
                    onClick={() => setActivePathIdx(i)}
                    className={`w-full text-left rounded-xl border p-3 transition-all ${
                      activePathIdx === i
                        ? 'border-blue-200 bg-blue-50'
                        : 'border-slate-100 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: pathColor, flexShrink: 0 }} />
                      <span className="text-xs font-bold text-slate-700">Path {i + 1}</span>
                      <span className="text-[10px] text-slate-400 ml-auto">{hops} hop{hops !== 1 ? 's' : ''}</span>
                    </div>
                    {/* Step-through preview */}
                    <div className="space-y-0.5">
                      {p.tables.map((t, ti) => (
                        <div key={ti} className="flex items-center gap-1.5">
                          {ti > 0 && (
                            <span className="text-[9px] text-slate-300 ml-2">↓</span>
                          )}
                          <span className={`text-[11px] ${
                            t.pgId === fromTableId || t.pgId === toTableId
                              ? 'font-bold text-slate-800'
                              : 'text-slate-500'
                          }`}>
                            {t.displayName || t.tableName}
                          </span>
                          {/* Show join column for the relationship leading TO this table */}
                          {ti > 0 && (() => {
                            const rel = p.relationships[ti - 1];
                            if (!rel) return null;
                            const colName = rel.toColName;
                            return colName ? (
                              <span className="text-[9px] font-mono text-slate-400">.{colName}</span>
                            ) : null;
                          })()}
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && !error && paths.length === 0 && fromTableId && toTableId && fromTableId === toTableId && (
            <div className="p-4 text-center">
              <p className="text-sm text-slate-400">Select two different tables</p>
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100">
          <p className="text-[10px] text-slate-400">
            Shows all shortest join paths between two tables through existing relationships.
            Each colour represents a different path.
          </p>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0">
        <ReactFlowProvider>
          <PathCanvas
            connectionId={connectionId}
            tables={tables}
            columnsByTable={columnsByTable}
            paths={paths}
            fromTableId={fromTableId ?? 0}
            toTableId={toTableId ?? 0}
            activePathIndex={activePathIdx}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

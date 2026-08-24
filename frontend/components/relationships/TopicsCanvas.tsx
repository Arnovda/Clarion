'use client';

/**
 * <TopicsCanvas> — the relations canvas for the TOPIC layer.
 *
 * The owner's ask (2026-08-21): "a relation canvas for my topics as well,
 * just like I have for my sources — so I can always see what's linked to
 * what, including the budgets or mappings." Same language as the source
 * canvas and the topic diagram: one anchor in the middle, its neighbours on
 * the ring, join fields named at both line ends. Geometry and the radial
 * layout are IMPORTED from this folder — the numbers are solved there.
 *
 * Deliberately READ-ONLY: topic relationships are built artefacts (the
 * build owns them), and grid links are edited on the grid itself. This
 * canvas answers "what connects to what?", it does not edit the answer.
 *
 * Three identities by colour: measures tables (purple), lookups (ocean),
 * and YOUR TABLES — grids — in amber with a dashed link line, because a
 * user-maintained table joining your data is exactly the thing worth
 * spotting at a glance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Node, Edge, NodeProps,
  Handle, Position,
  EdgeProps, getBezierPath,
  ReactFlowProvider, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { KeyRound, Hash, Loader2, Search, Table2 } from 'lucide-react';
import api from '@/lib/api';
import {
  HEADER_H, ROW_H, FOOTER_H, NODE_W, handleLeft, handleRight, rowCentreY, nodeHeight,
} from './geometry';
import { radialLayout, MAX_NEIGHBOURS } from './focusLayout';

// ---------------------------------------------------------------------------
// Wire types (GET /api/relationships/topics-graph)
// ---------------------------------------------------------------------------
interface TgColumn { name: string; dataType: string | null; role: string | null }
interface TgTable {
  tableName: string;
  displayName: string | null;
  role: string;
  topic: string;
  topicKind: string | null;
  columns: TgColumn[];
  columnCount: number;
}
interface TgRelationship {
  id: number;
  fromTable: string; fromColumn: string;
  toTable: string; toColumn: string;
  type: string;
}
interface TgGridColumn { key: string; name: string; type: string; link?: { table: string; column: string } | null }
interface TgGrid {
  id: number;
  name: string;
  viewName: string;
  kind: string;
  rowCount: number;
  ready: boolean;
  columns: TgGridColumn[];
}
interface TopicsGraph {
  tables: TgTable[];
  relationships: TgRelationship[];
  grids: TgGrid[];
}

// One unified node model so tables and grids share layout + rendering.
interface CanvasNode {
  /** Stable key: the table name / grid view name. */
  key: string;
  label: string;
  subtitle: string;
  kind: 'fact' | 'dim' | 'grid';
  /** Rows this node can show: [name, typeLabel]. */
  fields: Array<{ name: string; typeLabel: string; isMeasure: boolean }>;
  totalFields: number;
}

interface CanvasEdge {
  id: string;
  fromKey: string; fromField: string;
  toKey: string; toField: string;
  kind: 'join' | 'grid-link';
  type: string;
}

const FACT_COLOR = '#6b4e8c';
const DIM_COLOR = '#164e63';
const GRID_COLOR = '#b45309';
const NODE_COLOR: Record<CanvasNode['kind'], string> = {
  fact: FACT_COLOR, dim: DIM_COLOR, grid: GRID_COLOR,
};

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------
interface TNodeData {
  node: CanvasNode;
  isAnchor: boolean;
  shown: CanvasNode['fields'];
  hiddenCount: number;
}

const HANDLE_STYLE: React.CSSProperties = {
  width: 9, height: 9, background: '#ffffff',
  border: '1.5px solid #b8bec5', borderRadius: 9,
};

function TNodeImpl({ data }: NodeProps<TNodeData>) {
  const { node, isAnchor, shown, hiddenCount } = data;
  const hasFooter = hiddenCount > 0;
  const height = nodeHeight(shown.length, hasFooter);
  const color = NODE_COLOR[node.kind];

  return (
    <div style={{ position: 'relative', width: NODE_W, height }}>
      <Handle
        type="source" position={Position.Left} id={handleLeft('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, left: -5, transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source" position={Position.Right} id={handleRight('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, right: -5, transform: 'translateY(-50%)' }}
      />
      {shown.map((_, i) => {
        const top = rowCentreY(i);
        return (
          <span key={i}>
            <Handle
              type="source" position={Position.Left} id={handleLeft(i)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, left: -5, transform: 'translateY(-50%)' }}
            />
            <Handle
              type="source" position={Position.Right} id={handleRight(i)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, right: -5, transform: 'translateY(-50%)' }}
            />
          </span>
        );
      })}

      <div
        className="overflow-hidden rounded-xl bg-raised"
        style={{
          width: NODE_W, height,
          border: node.kind === 'grid' ? `1.5px dashed ${color}` : `1px solid ${isAnchor ? color : '#d0d5da'}`,
          boxShadow: isAnchor
            ? `0 0 0 4px ${color}26, 0 10px 28px rgba(15,26,34,0.14)`
            : '0 1px 3px rgba(15,26,34,0.07)',
        }}
      >
        <div className="relative flex items-start gap-2 pl-4 pr-3" style={{ height: HEADER_H }}>
          <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: color }} aria-hidden />
          <div className="min-w-0 flex-1 pt-[10px]">
            <div className={`truncate leading-tight text-ink ${isAnchor ? 'text-[14px] font-semibold' : 'text-[13px] font-medium'}`}>
              {node.label}
            </div>
            <div className="truncate text-[11px] leading-tight text-muted">{node.subtitle}</div>
          </div>
        </div>

        {shown.map((f, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 border-t border-line/50 pl-4 pr-3 text-[11.5px] text-ink-2"
            style={{ height: ROW_H }}
          >
            {f.isMeasure
              ? <Hash size={11} className="shrink-0 text-muted-2" />
              : <KeyRound size={11} className="shrink-0" style={{ color: '#8891a0' }} />}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-2">{f.typeLabel.slice(0, 7)}</span>
          </div>
        ))}

        {hasFooter && (
          <div
            className="flex w-full items-center border-t border-line/50 pl-4 pr-3 text-[11px] text-muted"
            style={{ height: FOOTER_H }}
          >
            {hiddenCount} more field{hiddenCount === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------
interface TEdgeData { kind: 'join' | 'grid-link'; ends: readonly [string, string] | null }

const END_OFFSET = 15;
const END_SYMBOLS: Record<string, readonly [string, string]> = {
  many_to_one: ['∗', '1'],
  one_to_many: ['1', '∗'],
  one_to_one: ['1', '1'],
  many_to_many: ['∗', '∗'],
  fact_to_dim: ['∗', '1'],
  dim_to_fact: ['1', '∗'],
};

function TEdgeImpl({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data,
}: EdgeProps<TEdgeData>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const isGrid = data?.kind === 'grid-link';
  const color = isGrid ? GRID_COLOR : DIM_COLOR;
  return (
    <>
      <path
        d={path} fill="none" stroke={color} strokeWidth={2.2}
        strokeDasharray={isGrid ? '7 5' : undefined}
        style={{ pointerEvents: 'none' }}
      />
      {data?.ends && (
        <>
          <g pointerEvents="none">
            <circle
              cx={sourceX + (sourcePosition === Position.Left ? -END_OFFSET : END_OFFSET)} cy={sourceY}
              r={7.5} fill="#fffdfa" stroke={color} strokeWidth={1.25}
            />
            <text
              x={sourceX + (sourcePosition === Position.Left ? -END_OFFSET : END_OFFSET)} y={sourceY}
              textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={600} fill={color}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
            >
              {data.ends[0]}
            </text>
          </g>
          <g pointerEvents="none">
            <circle
              cx={targetX + (targetPosition === Position.Left ? -END_OFFSET : END_OFFSET)} cy={targetY}
              r={7.5} fill="#fffdfa" stroke={color} strokeWidth={1.25}
            />
            <text
              x={targetX + (targetPosition === Position.Left ? -END_OFFSET : END_OFFSET)} y={targetY}
              textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={600} fill={color}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
            >
              {data.ends[1]}
            </text>
          </g>
        </>
      )}
    </>
  );
}

const nodeTypes = { tNode: TNodeImpl };
const edgeTypes = { tEdge: TEdgeImpl };

// ---------------------------------------------------------------------------
// Data shaping
// ---------------------------------------------------------------------------

function buildModel(graph: TopicsGraph): { nodes: Map<string, CanvasNode>; edges: CanvasEdge[]; topics: Map<string, string[]>; gridKeys: string[] } {
  const nodes = new Map<string, CanvasNode>();
  const topics = new Map<string, string[]>();

  // Shared dims are stubbed into several schemas, so the same table name can
  // arrive more than once — keep the richest copy (most columns).
  for (const t of graph.tables) {
    const existing = nodes.get(t.tableName);
    const node: CanvasNode = {
      key: t.tableName,
      label: t.displayName || t.tableName,
      subtitle: `${t.topic} · ${t.role === 'fact' ? 'measures' : 'lookup'}`,
      kind: t.role === 'fact' ? 'fact' : 'dim',
      fields: t.columns.map((c) => ({
        name: c.name,
        typeLabel: c.dataType ?? '',
        isMeasure: c.role === 'measure',
      })),
      totalFields: Math.max(t.columnCount, t.columns.length),
    };
    if (!existing || node.fields.length > existing.fields.length) nodes.set(t.tableName, node);
    if (!topics.has(t.topic)) topics.set(t.topic, []);
    if (!topics.get(t.topic)!.includes(t.tableName)) topics.get(t.topic)!.push(t.tableName);
  }

  const gridKeys: string[] = [];
  for (const g of graph.grids) {
    nodes.set(g.viewName, {
      key: g.viewName,
      label: g.name,
      subtitle: `your table · ${g.ready ? `${g.rowCount.toLocaleString('en-GB')} rows` : 'being prepared'}`,
      kind: 'grid',
      fields: g.columns.map((c) => ({ name: c.key, typeLabel: c.type, isMeasure: c.type === 'number' })),
      totalFields: g.columns.length,
    });
    gridKeys.push(g.viewName);
  }

  const edges: CanvasEdge[] = [];
  for (const r of graph.relationships) {
    if (!nodes.has(r.fromTable) || !nodes.has(r.toTable)) continue;
    edges.push({
      id: `rel-${r.id}`,
      fromKey: r.fromTable, fromField: r.fromColumn,
      toKey: r.toTable, toField: r.toColumn,
      kind: 'join', type: r.type,
    });
  }
  for (const g of graph.grids) {
    for (const c of g.columns) {
      if (!c.link) continue;
      if (!nodes.has(c.link.table)) continue; // target renamed away — the grid editor says so
      edges.push({
        id: `grid-${g.id}-${c.key}`,
        fromKey: g.viewName, fromField: c.key,
        toKey: c.link.table, toField: c.link.column,
        kind: 'grid-link', type: 'many_to_one',
      });
    }
  }

  return { nodes, edges, topics, gridKeys };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
function TopicsCanvasInner() {
  const [graph, setGraph] = useState<TopicsGraph | null>(null);
  const [error, setError] = useState('');
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/relationships/topics-graph');
        setGraph((res.data?.data ?? null) as TopicsGraph);
      } catch {
        setError('Could not load your topics.');
      }
    })();
  }, []);

  const model = useMemo(() => (graph ? buildModel(graph) : null), [graph]);

  // Default anchor: the most-connected table — the picture's natural subject.
  useEffect(() => {
    if (!model || anchorKey !== null) return;
    const counts = new Map<string, number>();
    for (const e of model.edges) {
      counts.set(e.fromKey, (counts.get(e.fromKey) ?? 0) + 1);
      counts.set(e.toKey, (counts.get(e.toKey) ?? 0) + 1);
    }
    const best = [...model.nodes.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
    if (best) setAnchorKey(best);
  }, [model, anchorKey]);

  const { nodes, edges, leftOut } = useMemo(() => {
    if (!model || !anchorKey || !model.nodes.has(anchorKey)) {
      return { nodes: [] as Node[], edges: [] as Edge[], leftOut: 0 };
    }

    // Neighbourhood: only edges touching the anchor are drawn (§2.4 — a
    // neighbour's own relationships are not this view's subject).
    const touching = model.edges.filter((e) => e.fromKey === anchorKey || e.toKey === anchorKey);
    const neighbourCount = new Map<string, number>();
    for (const e of touching) {
      const other = e.fromKey === anchorKey ? e.toKey : e.fromKey;
      neighbourCount.set(other, (neighbourCount.get(other) ?? 0) + 1);
    }
    const ranked = [...neighbourCount.keys()].sort(
      (a, b) => (neighbourCount.get(b) ?? 0) - (neighbourCount.get(a) ?? 0),
    );
    const ring = ranked.slice(0, MAX_NEIGHBOURS);
    const ringSet = new Set(ring);
    const drawn = touching.filter((e) => {
      const other = e.fromKey === anchorKey ? e.toKey : e.fromKey;
      return ringSet.has(other);
    });

    // Join surface per node: the fields drawn edges land on.
    const surface = new Map<string, Set<string>>();
    const addField = (key: string, field: string) => {
      if (!surface.has(key)) surface.set(key, new Set());
      surface.get(key)!.add(field);
    };
    for (const e of drawn) {
      addField(e.fromKey, e.fromField);
      addField(e.toKey, e.toField);
    }

    const visible = [anchorKey, ...ring];
    const shownOf = (key: string) => {
      const n = model.nodes.get(key)!;
      const names = surface.get(key);
      if (!names || names.size === 0) return [];
      return n.fields.filter((f) => names.has(f.name));
    };

    const keyToIdx = new Map(visible.map((k, i) => [k, i]));
    const heightOf = (idx: number) => {
      const key = visible[idx];
      const n = model.nodes.get(key)!;
      const shown = shownOf(key);
      return nodeHeight(shown.length, n.totalFields > shown.length);
    };
    const { positions } = radialLayout(0, ring.map((_, i) => i + 1), heightOf);

    const rfNodes: Node[] = visible.map((key, idx) => {
      const n = model.nodes.get(key)!;
      const shown = shownOf(key);
      return {
        id: key,
        type: 'tNode',
        position: positions.get(idx) ?? { x: 0, y: 0 },
        data: {
          node: n,
          isAnchor: key === anchorKey,
          shown,
          hiddenCount: Math.max(0, n.totalFields - shown.length),
        } satisfies TNodeData,
      };
    });

    const centreX = (key: string) => (positions.get(keyToIdx.get(key) ?? 0)?.x ?? 0) + NODE_W / 2;
    const rfEdges: Edge[] = drawn.map((e) => {
      const fromShown = shownOf(e.fromKey);
      const toShown = shownOf(e.toKey);
      const fromIdx = fromShown.findIndex((f) => f.name === e.fromField);
      const toIdx = toShown.findIndex((f) => f.name === e.toField);
      const fromOnLeft = centreX(e.fromKey) < centreX(e.toKey);
      return {
        id: e.id,
        source: e.fromKey,
        sourceHandle: fromOnLeft ? handleRight(fromIdx >= 0 ? fromIdx : 'table') : handleLeft(fromIdx >= 0 ? fromIdx : 'table'),
        target: e.toKey,
        targetHandle: fromOnLeft ? handleLeft(toIdx >= 0 ? toIdx : 'table') : handleRight(toIdx >= 0 ? toIdx : 'table'),
        type: 'tEdge',
        data: {
          kind: e.kind,
          ends: e.kind === 'join' ? (END_SYMBOLS[e.type] ?? (['∗', '1'] as const)) : null,
        } satisfies TEdgeData,
      };
    });

    return { nodes: rfNodes, edges: rfEdges, leftOut: ranked.length - ring.length };
  }, [model, anchorKey]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setAnchorKey(node.id);
  }, []);

  if (error) {
    return <div className="flex h-full items-center justify-center text-[13px] text-err">{error}</div>;
  }
  if (!model) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden /> Loading…
      </div>
    );
  }
  if (model.nodes.size === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
        No topics built yet — create your topics on Build first.
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (key: string) => {
    if (q === '') return true;
    const n = model.nodes.get(key);
    return !!n && (n.label.toLowerCase().includes(q) || key.toLowerCase().includes(q));
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar: pick what the picture is about ── */}
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="border-b border-line p-2.5">
          <div className="flex items-center gap-1.5 rounded-[8px] border border-line bg-bg px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a table…"
              className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-muted-2 focus:outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {[...model.topics.entries()].map(([topic, keys]) => {
            const shown = keys.filter(matches);
            if (shown.length === 0) return null;
            return (
              <div key={topic} className="mb-2">
                <p className="px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-2">{topic}</p>
                {shown.map((key) => {
                  const n = model.nodes.get(key)!;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setAnchorKey(key)}
                      className={`flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] ${
                        anchorKey === key ? 'bg-ocean-softer text-ocean' : 'text-ink-2 hover:bg-softer'
                      }`}
                    >
                      <span
                        className="h-[8px] w-[8px] shrink-0 rounded-[2px]"
                        style={{ background: NODE_COLOR[n.kind] }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {model.gridKeys.filter(matches).length > 0 && (
            <div className="mb-2">
              <p className="px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-2">Your tables</p>
              {model.gridKeys.filter(matches).map((key) => {
                const n = model.nodes.get(key)!;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setAnchorKey(key)}
                    className={`flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] ${
                      anchorKey === key ? 'bg-ocean-softer text-ocean' : 'text-ink-2 hover:bg-softer'
                    }`}
                  >
                    <Table2 className="h-3 w-3 shrink-0" style={{ color: GRID_COLOR }} strokeWidth={2} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="border-t border-line px-3 py-2 text-[10.5px] leading-[1.5] text-muted-2">
          Solid lines are built joins; <span style={{ color: GRID_COLOR }}>dashed amber</span> lines are your
          tables joining in.{leftOut > 0 && ` ${leftOut} more connection${leftOut === 1 ? '' : 's'} not on the ring — pick them from the list.`}
        </div>
      </aside>

      {/* ── Canvas ── */}
      <div className="min-w-0 flex-1">
        <ReactFlow
          key={anchorKey ?? 'none'}
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.25}
          maxZoom={1}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          panOnScroll
          zoomOnScroll={false}
        >
          <Background color="#d0d5da" gap={20} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function TopicsCanvas() {
  return (
    <ReactFlowProvider>
      <TopicsCanvasInner />
    </ReactFlowProvider>
  );
}

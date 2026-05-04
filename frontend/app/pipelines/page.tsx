'use client';

/**
 * /pipelines — refresh definitions for the whole tenant.
 *
 * A pipeline = a NAMED scope on the (sources → products) dependency graph
 * + zero or more TRIGGERS. Built-in pipelines (auto-derived from the
 * graph, never stored) cover the common cases. Custom pipelines let users
 * pick exactly which sources + products they want and add triggers.
 *
 * Layout:
 *   ┌────────────────────────┬─────────────────────────────────────────┐
 *   │ LEFT — pipeline list   │ RIGHT — DAG + run controls              │
 *   │  Built-in (3 + per-    │  Header: name, run, triggers            │
 *   │   source + per-product)│  Canvas: ReactFlow LR (sources → prods) │
 *   │  Custom (user-created) │  Bottom: run history                    │
 *   │  + New pipeline        │                                          │
 *   └────────────────────────┴─────────────────────────────────────────┘
 *
 * Run mechanics: clicking "Run" enqueues a 'mode: pipeline' job on the
 * existing bus-matrix BullMQ queue and attaches via the existing
 * /bus-matrix/:jobId/stream SSE endpoint. We display live progress in
 * a slide-over toast — no page-level interruption needed.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background, Controls,
  useNodesState, useEdgesState,
  NodeProps, Handle, Position,
  ReactFlowProvider,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import {
  Play, Plus, Trash2, X, Database, Boxes, Calendar,
  CheckCircle2, AlertCircle, Loader2, Clock, Pencil,
  ChevronDown, ChevronUp, MinusSquare, SquareDashed,
} from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { OBSERVATORY } from '@/lib/observatory';
import RequireRole from '@/components/RequireRole';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { getToken } from '@/lib/auth';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

// ─── Types ──────────────────────────────────────────────────────────────────

type PipelineScope =
  | { type: 'all' }
  | { type: 'sync-all' }
  | { type: 'transform-all' }
  | { type: 'from-source'; sourceId: number }
  | { type: 'sync-source'; sourceId: number }
  | { type: 'product'; productId: number; includeUpstreamSync?: boolean; includeDownstream?: boolean }
  | { type: 'rebuild-product'; productId: number }
  | { type: 'custom'; sourceIds: number[]; productIds: number[]; includeUpstream?: boolean; includeDownstream?: boolean; skipSourceSync?: boolean };

type PipelineTrigger =
  | { kind: 'cron'; cron: string; tz?: string }
  | { kind: 'on_pipeline_complete'; pipelineId: number }
  | { kind: 'on_source_sync_succeeded'; sourceId: number };

interface BuiltinPipeline {
  id: string;          // 'builtin:all' | 'builtin:from-source:5' | …
  name: string;
  description: string;
  group: 'global' | 'source' | 'product';
  scope: PipelineScope;
  sourceCount: number;
  productCount: number;
}

interface CustomPipeline {
  id: number;
  stableId: string;    // 'custom:17'
  name: string;
  description: string | null;
  scope: PipelineScope;
  triggers: PipelineTrigger[];
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type Pipeline = (BuiltinPipeline & { kind: 'builtin' }) | (CustomPipeline & { kind: 'custom' });

interface DagSource {
  id: number; name: string; type: string; connectorType: string | null;
  lastSyncedAt: string | null; lastSyncStatus: string | null;
}
interface DagProduct {
  id: number; name: string; status: string;
  lastRunAt: string | null; connectionId: number | null;
}
interface DagEdge {
  source: { kind: 'connection' | 'product'; id: number };
  target: { kind: 'product'; id: number };
}
interface Dag { sources: DagSource[]; products: DagProduct[]; edges: DagEdge[] }

interface RunRow {
  id: number;
  pipeline_id: number | null;
  status: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  triggered_by: string | null;
  job_id: string | null;
  node_results: { sources: Array<{ sourceId: number; status: string; error?: string }>;
                  products: Array<{ productId: number; productName: string; allOk: boolean; failedTables: number; totalTables: number }> } | null;
  error_message: string | null;
}

// ─── Layout helpers ─────────────────────────────────────────────────────────

const NODE_W = 220;
const NODE_H = 64;

function layoutDag(dag: Dag, scope: { sourceIds: Set<number>; productIds: Set<number> }) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 80, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const s of dag.sources) g.setNode(`c:${s.id}`, { width: NODE_W, height: NODE_H });
  for (const p of dag.products) g.setNode(`p:${p.id}`, { width: NODE_W, height: NODE_H });
  for (const e of dag.edges) {
    g.setEdge(
      `${e.source.kind === 'connection' ? 'c' : 'p'}:${e.source.id}`,
      `p:${e.target.id}`,
    );
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const s of dag.sources) {
    const n = g.node(`c:${s.id}`);
    if (n) positions.set(`c:${s.id}`, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
  }
  for (const p of dag.products) {
    const n = g.node(`p:${p.id}`);
    if (n) positions.set(`p:${p.id}`, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
  }
  return positions;
}

// ─── Custom node components ─────────────────────────────────────────────────

interface NodeData {
  label: string;
  kind: 'connection' | 'product';
  inScope: boolean;
  /**
   * Live status from the active pipeline run, if any. When set the node
   * shows its run state (queued / running / ok / failed / skipped) on top
   * of the static in-scope colouring — including a pulsing ring while
   * running and ✓ / ✗ overlays once it finishes.
   */
  liveStatus?: NodeRunStatus;
  meta: { connectorType?: string | null; status?: string; lastAt?: string | null };
}

function GraphNode({ data }: NodeProps<NodeData>) {
  const Icon = data.kind === 'connection' ? Database : Boxes;
  const accent = data.kind === 'connection' ? OBSERVATORY.ocean : OBSERVATORY.ai;

  // Live status takes visual precedence — a node currently running pulses,
  // a completed one shows its outcome icon, etc. Static "out of scope" is
  // dimmer than out-of-run because the user actively chose to exclude it.
  const live = data.liveStatus;
  const baseBorder = data.inScope ? accent : OBSERVATORY.line;
  const liveStyle: { border: string; ring?: string; statusIcon: React.ReactNode | null; opacity: number } = (() => {
    if (!live) return { border: baseBorder, statusIcon: null, opacity: data.inScope ? 1 : 0.5 };
    switch (live) {
      case 'running':
        return { border: OBSERVATORY.ocean, ring: OBSERVATORY.oceanSoft, statusIcon: <Loader2 className="w-3 h-3 animate-spin" style={{ color: OBSERVATORY.ocean }} />, opacity: 1 };
      case 'ok':
        return { border: OBSERVATORY.ok, statusIcon: <CheckCircle2 className="w-3 h-3" style={{ color: OBSERVATORY.ok }} />, opacity: 1 };
      case 'failed':
        return { border: OBSERVATORY.err, statusIcon: <AlertCircle className="w-3 h-3" style={{ color: OBSERVATORY.err }} />, opacity: 1 };
      case 'skipped':
        return { border: OBSERVATORY.muted2, statusIcon: <MinusSquare className="w-3 h-3" style={{ color: OBSERVATORY.muted2 }} />, opacity: 0.85 };
      case 'queued':
        return { border: accent, statusIcon: <Clock className="w-3 h-3" style={{ color: OBSERVATORY.muted }} />, opacity: 1 };
      default:
        return { border: baseBorder, statusIcon: null, opacity: data.inScope ? 1 : 0.5 };
    }
  })();

  return (
    <div
      className={cn(
        'rounded-md border-2 px-3 py-2 transition-all relative',
        live === 'running' && 'pipeline-node-running',
      )}
      style={{
        width: NODE_W, height: NODE_H,
        background: data.inScope ? OBSERVATORY.raised : OBSERVATORY.softer,
        borderColor: liveStyle.border,
        opacity: liveStyle.opacity,
        boxShadow: liveStyle.ring ? `0 0 0 4px ${liveStyle.ring}` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: OBSERVATORY.line, width: 6, height: 6, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: OBSERVATORY.line, width: 6, height: 6, border: 'none' }} />
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: data.inScope ? accent : OBSERVATORY.muted2 }} />
        <span className="text-[12px] font-medium truncate flex-1" style={{ color: OBSERVATORY.ink }}>{data.label}</span>
        {liveStyle.statusIcon && <span className="shrink-0">{liveStyle.statusIcon}</span>}
      </div>
      <div className="text-[10px] mt-1 truncate" style={{ color: OBSERVATORY.muted }}>
        {data.kind === 'connection'
          ? (data.meta.connectorType ?? data.meta.status ?? 'source')
          : (data.meta.status ?? 'product')}
        {data.meta.lastAt && ` · ${formatRelative(data.meta.lastAt)}`}
      </div>
    </div>
  );
}

const nodeTypes = { graph: GraphNode };

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PipelinesPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <ReactFlowProvider>
        <PipelinesInner />
      </ReactFlowProvider>
    </RequireRole>
  );
}

function PipelinesInner() {
  const toast = useToast();
  const [dag, setDag] = useState<Dag | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [showCustomEditor, setShowCustomEditor] = useState<{ mode: 'create' } | { mode: 'edit'; id: number } | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunRow[]>([]);
  const [activeStream, setActiveStream] = useState<{ jobId: string; pipelineRunId: number; pipelineName: string } | null>(null);
  // Live per-node statuses surfaced from the dock's SSE consumer; canvas
  // overlays these on top of the static "in scope / out of scope" colouring
  // so users can SEE the pipeline progress on the graph itself.
  const [liveNodes, setLiveNodes] = useState<Map<string, NodeRunState>>(new Map());
  // Right-pane tab — Canvas (the default "configure + run") vs Runs (the
  // history / audit surface). Splitting these prevents the active-run dock,
  // canvas, and recent-runs strip from competing for the same vertical
  // real estate. When a run starts we keep the user on Canvas (so they see
  // the live animation) but they can switch to Runs to drill into past
  // pipeline_runs at any time.
  const [pipelineTab, setPipelineTab] = useState<'canvas' | 'runs'>('canvas');
  // CRITICAL: these callbacks must have stable references because the dock
  // lists them in its SSE useEffect dependency array. Inline arrow functions
  // here would create a new reference on every parent render → the SSE
  // connection would tear down and reopen, and BullMQ would replay the
  // entire job log from the start. We saw this in production as a "stuck
  // run" with the same events repeating in the output panel.
  const onDockDismiss = useCallback(() => {
    setActiveStream(null);
    setLiveNodes(new Map());
    void reloadRuns();
    void reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onDockCompleted = useCallback(() => {
    void reloadRuns();
    void reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try {
      const [dagRes, listRes] = await Promise.all([
        api.get('/pipelines/dag'),
        api.get('/pipelines/list'),
      ]);
      const _dag = dagRes.data.data as Dag;
      const list = listRes.data.data as { builtin: BuiltinPipeline[]; custom: CustomPipeline[] };
      const all: Pipeline[] = [
        ...list.builtin.map((b) => ({ ...b, kind: 'builtin' as const })),
        ...list.custom.map((c) => ({ ...c, kind: 'custom' as const })),
      ];
      setDag(_dag);
      setPipelines(all);
      if (!selectedId && all.length > 0) {
        const first = all[0];
        const firstId = first.kind === 'builtin' ? first.id : (first as CustomPipeline & { kind: 'custom' }).stableId;
        setSelectedId(firstId);
      }
    } catch (err) {
      toast.error('Failed to load pipelines');
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [selectedId, toast]);

  const reloadRuns = useCallback(async () => {
    try {
      const res = await api.get('/pipelines/runs?limit=15');
      setRecentRuns(res.data.data ?? []);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { reload(); reloadRuns(); }, [reload, reloadRuns]);

  const selected = useMemo(
    () => pipelines.find((p) => (p.kind === 'builtin' ? p.id : p.stableId) === selectedId) ?? null,
    [pipelines, selectedId],
  );

  // Resolve selected pipeline's scope to highlight nodes on the canvas.
  // For builtins we don't have the resolved set client-side, so we approximate
  // from the scope shape. (Server has the canonical resolver — we send the
  // run request there for the actual scope.)
  const scopeHint = useMemo(() => {
    const sourceIds = new Set<number>();
    const productIds = new Set<number>();
    if (!selected || !dag) return { sourceIds, productIds };
    const s = selected.scope;
    switch (s.type) {
      case 'all':
        dag.sources.forEach((x) => sourceIds.add(x.id));
        dag.products.forEach((x) => productIds.add(x.id));
        break;
      case 'sync-all':
        dag.sources.forEach((x) => sourceIds.add(x.id));
        break;
      case 'transform-all':
        dag.products.forEach((x) => productIds.add(x.id));
        break;
      case 'sync-source':
        sourceIds.add(s.sourceId);
        break;
      case 'from-source': {
        sourceIds.add(s.sourceId);
        // Approximate downstream by walking edges
        const visited = new Set<string>();
        const queue: string[] = [`c:${s.sourceId}`];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          for (const e of dag.edges) {
            const fromKey = `${e.source.kind === 'connection' ? 'c' : 'p'}:${e.source.id}`;
            if (fromKey === cur) {
              const targetKey = `p:${e.target.id}`;
              productIds.add(e.target.id);
              queue.push(targetKey);
            }
          }
        }
        break;
      }
      case 'product':
        productIds.add(s.productId);
        if (s.includeUpstreamSync !== false) {
          // walk upstream to find source connections
          const visited = new Set<string>();
          const queue: string[] = [`p:${s.productId}`];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const e of dag.edges) {
              const targetKey = `p:${e.target.id}`;
              if (targetKey === cur) {
                if (e.source.kind === 'connection') sourceIds.add(e.source.id);
                else { productIds.add(e.source.id); queue.push(`p:${e.source.id}`); }
              }
            }
          }
        }
        if (s.includeDownstream) {
          const visited = new Set<string>();
          const queue: string[] = [`p:${s.productId}`];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const e of dag.edges) {
              const fromKey = `${e.source.kind === 'connection' ? 'c' : 'p'}:${e.source.id}`;
              if (fromKey === cur) {
                productIds.add(e.target.id);
                queue.push(`p:${e.target.id}`);
              }
            }
          }
        }
        break;
      case 'rebuild-product':
        productIds.add(s.productId);
        break;
      case 'custom':
        s.sourceIds.forEach((id) => sourceIds.add(id));
        s.productIds.forEach((id) => productIds.add(id));
        // Note: includeUpstream/Downstream expansion is computed server-side at
        // run time. The hint here just shows what the user explicitly picked.
        break;
    }
    return { sourceIds, productIds };
  }, [selected, dag]);

  // ── ReactFlow nodes/edges ──
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!dag) return;
    const positions = layoutDag(dag, scopeHint);
    const nodes: Node<NodeData>[] = [
      ...dag.sources.map((s) => ({
        id: `c:${s.id}`,
        type: 'graph',
        position: positions.get(`c:${s.id}`) ?? { x: 0, y: 0 },
        data: {
          label: s.name, kind: 'connection' as const,
          inScope: scopeHint.sourceIds.has(s.id),
          liveStatus: liveNodes.get(`c:${s.id}`)?.status,
          meta: { connectorType: s.connectorType, lastAt: s.lastSyncedAt, status: s.lastSyncStatus ?? undefined },
        },
        draggable: false,
      })),
      ...dag.products.map((p) => ({
        id: `p:${p.id}`,
        type: 'graph',
        position: positions.get(`p:${p.id}`) ?? { x: 0, y: 0 },
        data: {
          label: p.name, kind: 'product' as const,
          inScope: scopeHint.productIds.has(p.id),
          liveStatus: liveNodes.get(`p:${p.id}`)?.status,
          meta: { status: p.status, lastAt: p.lastRunAt },
        },
        draggable: false,
      })),
    ];
    setRfNodes(nodes);
    setRfEdges(
      dag.edges.map((e, i) => {
        const fromKey = `${e.source.kind === 'connection' ? 'c' : 'p'}:${e.source.id}`;
        const toKey = `p:${e.target.id}`;
        const inScope = (e.source.kind === 'connection'
          ? scopeHint.sourceIds.has(e.source.id)
          : scopeHint.productIds.has(e.source.id))
          && scopeHint.productIds.has(e.target.id);
        // Animate edges between any pair where AT LEAST one endpoint is
        // currently running — gives the canvas an obvious "data is
        // flowing" feel during a refresh without us having to track
        // edge-level state.
        const fromStatus = liveNodes.get(fromKey)?.status;
        const toStatus = liveNodes.get(toKey)?.status;
        const fromLive = fromStatus === 'running' || fromStatus === 'ok';
        const toLive = toStatus === 'running';
        const animated = fromLive && (toLive || toStatus === 'queued');
        const stroke = animated
          ? OBSERVATORY.ocean
          : inScope ? OBSERVATORY.ocean : OBSERVATORY.line;
        return {
          id: `e-${i}`,
          source: fromKey, target: toKey,
          type: 'smoothstep',
          animated,
          style: {
            stroke,
            strokeWidth: animated ? 2 : (inScope ? 1.5 : 1),
          },
        };
      }),
    );
  }, [dag, scopeHint, liveNodes, setRfNodes, setRfEdges]);

  // ── Run a pipeline ──
  const runPipeline = useCallback(async (pipelineId: string, pipelineName: string) => {
    setRunning(pipelineId);
    try {
      const res = await api.post('/pipelines/run-pipeline', { pipelineId });
      const { jobId, pipelineRunId } = res.data.data;
      toast.success(`Started "${pipelineName}"`);
      setActiveStream({ jobId: String(jobId), pipelineRunId, pipelineName });
      reloadRuns();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error ?? (err as Error).message;
      toast.error(`Failed to start: ${msg}`);
    } finally {
      setRunning(null);
    }
  }, [toast, reloadRuns]);

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Top bar */}
      <div className="px-6 py-3 border-b border-line bg-raised flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Pipelines</p>
          <h1 className="font-display text-[20px] text-ink leading-tight tracking-[-0.01em]">
            Refresh schedules and runs
          </h1>
        </div>
        <button
          onClick={() => { setShowCustomEditor({ mode: 'create' }); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
          New pipeline
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT — pipeline list */}
        <PipelineList
          pipelines={pipelines}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onEditCustom={(id) => setShowCustomEditor({ mode: 'edit', id })}
          onDelete={async (id) => {
            if (!confirm('Delete this pipeline? Runs in progress will continue.')) return;
            try {
              await api.delete(`/pipelines/saved/${id}`);
              toast.success('Pipeline deleted');
              await reload();
            } catch { toast.error('Delete failed'); }
          }}
          loading={loading}
        />

        {/* RIGHT — DAG canvas + controls */}
        <div className="flex-1 flex flex-col min-w-0">
          {selected ? (
            <>
              <PipelineHeader
                pipeline={selected}
                running={running === (selected.kind === 'builtin' ? selected.id : selected.stableId)}
                activeTab={pipelineTab}
                onTabChange={setPipelineTab}
                runActive={!!activeStream}
                onRun={() => runPipeline(
                  selected.kind === 'builtin' ? selected.id : selected.stableId,
                  selected.name,
                )}
                onEdit={selected.kind === 'custom' ? () => setShowCustomEditor({ mode: 'edit', id: (selected as CustomPipeline).id }) : undefined}
              />
              {pipelineTab === 'canvas' ? (
                <>
                  <div className="flex-1 relative" style={{ background: OBSERVATORY.bg }}>
                    <ReactFlow
                      nodes={rfNodes}
                      edges={rfEdges}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      nodeTypes={nodeTypes}
                      fitView
                      fitViewOptions={{ padding: 0.2 }}
                      minZoom={0.4}
                      maxZoom={1.5}
                      proOptions={{ hideAttribution: true }}
                      nodesDraggable={false}
                      nodesConnectable={false}
                    >
                      <Background color={OBSERVATORY.line} gap={20} size={1} />
                      <Controls showInteractive={false} />
                    </ReactFlow>
                    {/* Legend */}
                    <div className="absolute top-3 right-3 bg-raised border border-line rounded-md px-3 py-2 text-[10px] font-mono uppercase tracking-[0.08em] flex items-center gap-3 shadow-sm">
                      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm border-2" style={{ borderColor: OBSERVATORY.ocean }} /> Source in scope</span>
                      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm border-2" style={{ borderColor: OBSERVATORY.ai }} /> Product in scope</span>
                      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: OBSERVATORY.softer, border: `1px solid ${OBSERVATORY.line}` }} /> Out of scope</span>
                    </div>
                  </div>
                  {/*
                    Active run dock — ADF-style, slides up from below the
                    canvas while a run is in progress. Per-node status +
                    cumulative log, collapsible to a one-line strip.
                  */}
                  {activeStream && (
                    <RunActivityDock
                      jobId={activeStream.jobId}
                      pipelineRunId={activeStream.pipelineRunId}
                      pipelineName={activeStream.pipelineName}
                      scopeHint={scopeHint}
                      dag={dag}
                      onLiveNodesChange={setLiveNodes}
                      onDismiss={onDockDismiss}
                      onCompleted={onDockCompleted}
                    />
                  )}
                </>
              ) : (
                <RunsList
                  runs={recentRuns}
                  pipelineId={selected.kind === 'custom' ? (selected as CustomPipeline).id : null}
                  dag={dag}
                  activeJobId={activeStream?.jobId ?? null}
                  onJumpToCanvas={() => setPipelineTab('canvas')}
                />
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Select a pipeline'}
            </div>
          )}
        </div>
      </div>

      {/* Custom pipeline editor (modal) */}
      {showCustomEditor && dag && (
        <CustomPipelineEditor
          dag={dag}
          existing={showCustomEditor.mode === 'edit'
            ? (pipelines.find((p) => p.kind === 'custom' && (p as CustomPipeline).id === showCustomEditor.id) as CustomPipeline | undefined)
            : undefined}
          onClose={() => setShowCustomEditor(null)}
          onSaved={async () => { setShowCustomEditor(null); await reload(); }}
        />
      )}

    </div>
  );
}

// ─── Left rail ──────────────────────────────────────────────────────────────

function PipelineList({
  pipelines, selectedId, onSelect, onEditCustom, onDelete, loading,
}: {
  pipelines: Pipeline[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEditCustom: (id: number) => void;
  onDelete: (id: number) => void;
  loading: boolean;
}) {
  const groups = useMemo(() => {
    // Built-ins are now a single "Refresh everything"; per-source and
    // per-product variants were stripped to reduce decision fatigue.
    // Anything more specific is a custom pipeline (drag/click on canvas).
    const builtinGlobal = pipelines.filter((p) => p.kind === 'builtin');
    const custom = pipelines.filter((p) => p.kind === 'custom');
    return { builtinGlobal, custom };
  }, [pipelines]);

  if (loading) {
    return (
      <div className="w-[320px] shrink-0 border-r border-line bg-soft flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="w-[320px] shrink-0 border-r border-line bg-soft overflow-y-auto">
      <Section title="Built-in" eyebrow="default">
        {groups.builtinGlobal.map((p) => {
          const id = p.id;
          return (
            <ListItem key={id}
              id={id}
              name={p.name}
              sub={p.description}
              selected={selectedId === id}
              onSelect={onSelect}
              counts={p.kind === 'builtin' ? `${p.sourceCount}s · ${p.productCount}p` : undefined} />
          );
        })}
      </Section>
      <Section title="Custom" eyebrow={`${groups.custom.length}`}>
        {groups.custom.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-muted italic">
            No custom pipelines yet. Click <span className="font-medium">+ New pipeline</span>.
          </div>
        )}
        {groups.custom.map((p) => {
          const cp = p as CustomPipeline & { kind: 'custom' };
          return (
            <div key={cp.stableId} className="group">
              <ListItem
                id={cp.stableId}
                name={cp.name}
                sub={cp.description ?? `${cp.scope.type} · ${cp.triggers.length} trigger${cp.triggers.length === 1 ? '' : 's'}`}
                selected={selectedId === cp.stableId}
                onSelect={onSelect}
                counts={cp.lastStatus ?? undefined}
                actions={
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); onEditCustom(cp.id); }}
                      className="p-1 rounded hover:bg-soft text-muted-2 hover:text-ink-2"
                      title="Edit"
                    ><Pencil className="w-3 h-3" /></button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(cp.id); }}
                      className="p-1 rounded hover:bg-err-soft text-muted-2 hover:text-err"
                      title="Delete"
                    ><Trash2 className="w-3 h-3" /></button>
                  </>
                } />
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function Section({ title, eyebrow, children }: { title: string; eyebrow?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1.5">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{title}</p>
        {eyebrow && <span className="text-[10px] text-muted-2">{eyebrow}</span>}
      </div>
      {children}
    </div>
  );
}

function ListItem({
  id, name, sub, selected, onSelect, counts, actions,
}: {
  id: string; name: string; sub?: string | null;
  selected: boolean; onSelect: (id: string) => void;
  counts?: string; actions?: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onSelect(id)}
      className={cn(
        'w-full text-left px-3 py-2 border-l-2 transition-colors flex items-start gap-2 hover:bg-softer',
        selected ? 'bg-ocean-softer border-ocean' : 'border-transparent',
      )}
    >
      <div className="flex-1 min-w-0">
        <p className={cn('text-[13px] truncate', selected ? 'text-ocean font-medium' : 'text-ink')}>
          {name}
        </p>
        {sub && (
          <p className="text-[11px] text-muted truncate mt-0.5">{sub}</p>
        )}
      </div>
      {counts && <span className="text-[10px] font-mono text-muted-2 shrink-0 mt-0.5">{counts}</span>}
      {actions && <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0 -mt-0.5">{actions}</div>}
    </button>
  );
}

// ─── Right header ───────────────────────────────────────────────────────────

function PipelineHeader({
  pipeline, running, activeTab, onTabChange, runActive, onRun, onEdit,
}: {
  pipeline: Pipeline;
  running: boolean;
  activeTab: 'canvas' | 'runs';
  onTabChange: (t: 'canvas' | 'runs') => void;
  runActive: boolean;
  onRun: () => void;
  onEdit?: () => void;
}) {
  const triggers = pipeline.kind === 'custom' ? (pipeline as CustomPipeline & { kind: 'custom' }).triggers : [];
  return (
    <div className="border-b border-line bg-raised">
      {/* Top row: name, run controls */}
      <div className="px-6 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[18px] tracking-[-0.01em] text-ink truncate">{pipeline.name}</h2>
            {pipeline.kind === 'builtin' ? (
              <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 bg-softer border border-line px-1.5 py-0.5 rounded">built-in</span>
            ) : (
              <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-ai bg-ai-soft border border-line px-1.5 py-0.5 rounded">custom</span>
            )}
          </div>
          <p className="text-[12px] text-muted mt-0.5">
            {pipeline.kind === 'builtin' ? pipeline.description : (pipeline as CustomPipeline & { kind: 'custom' }).description ?? scopeSummary(pipeline.scope)}
          </p>
          {triggers.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {triggers.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.08em] bg-softer border border-line rounded">
                  {triggerSummary(t)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onEdit && (
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-ink-2 border border-line rounded-md hover:bg-softer transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          )}
          <button
            onClick={onRun}
            disabled={running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Run now
          </button>
        </div>
      </div>

      {/* Tab strip — keeps "configure + watch" separate from "audit" */}
      <div className="px-6 -mt-1 flex items-end gap-0">
        {(['canvas', 'runs'] as const).map((tab) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={cn(
                'inline-flex items-center gap-2 px-3 py-2 text-[12px] font-medium border-b-2 -mb-[1px] transition-colors',
                active
                  ? 'border-ocean text-ocean'
                  : 'border-transparent text-muted hover:text-ink-2',
              )}
            >
              {tab === 'canvas' ? 'Canvas' : 'Runs'}
              {/* Pulse the Runs tab while a run is active so users notice
                 it even if they're focused on the canvas. */}
              {tab === 'runs' && runActive && (
                <span className="relative flex w-1.5 h-1.5">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-ocean opacity-75 animate-ping" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-ocean" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function scopeSummary(s: PipelineScope): string {
  switch (s.type) {
    case 'all':              return 'Sync every source, transform every product';
    case 'sync-all':         return 'Sync every source';
    case 'transform-all':    return 'Transform every product (no sync)';
    case 'sync-source':      return `Sync source #${s.sourceId}`;
    case 'from-source':      return `Sync source #${s.sourceId} + dependents`;
    case 'product':          return `Refresh product #${s.productId}`;
    case 'rebuild-product':  return `Rebuild product #${s.productId} (no sync)`;
    case 'custom':           return `${s.sourceIds.length} source${s.sourceIds.length === 1 ? '' : 's'}, ${s.productIds.length} product${s.productIds.length === 1 ? '' : 's'}`;
  }
}

function triggerSummary(t: PipelineTrigger): React.ReactNode {
  switch (t.kind) {
    case 'cron':                       return <><Calendar className="w-3 h-3" /> {t.cron} {t.tz ?? ''}</>;
    case 'on_pipeline_complete':       return <>after pipeline #{t.pipelineId}</>;
    case 'on_source_sync_succeeded':   return <>on source #{t.sourceId} sync</>;
  }
}

// ─── RunsList tab — replaces the old RunHistory strip with a real audit surface
//
// Filterable table of every run for the selected pipeline (or every tenant
// run when a built-in is selected). Each row expands inline to show the
// per-node node_results JSON the orchestrator persists at run completion,
// plus the BullMQ job id for cross-referencing logs. The currently-active
// run (if any) shows at the top with a live "running" pill.

type RunStatusFilter = 'all' | 'succeeded' | 'partial' | 'failed' | 'running';

function RunsList({
  runs, pipelineId, dag, activeJobId, onJumpToCanvas,
}: {
  runs: RunRow[];
  pipelineId: number | null;
  dag: Dag | null;
  activeJobId: string | null;
  onJumpToCanvas: () => void;
}) {
  const [filter, setFilter] = useState<RunStatusFilter>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const scoped = useMemo(
    () => pipelineId == null ? runs : runs.filter((r) => r.pipeline_id === pipelineId),
    [runs, pipelineId],
  );
  const filtered = useMemo(() => {
    if (filter === 'all') return scoped;
    if (filter === 'running') return scoped.filter((r) => r.status === 'running' || r.status === 'queued');
    return scoped.filter((r) => r.status === filter);
  }, [scoped, filter]);

  const counts = useMemo(() => {
    const c = { all: scoped.length, succeeded: 0, partial: 0, failed: 0, running: 0 };
    for (const r of scoped) {
      if (r.status === 'succeeded') c.succeeded++;
      else if (r.status === 'partial') c.partial++;
      else if (r.status === 'failed') c.failed++;
      else if (r.status === 'running' || r.status === 'queued') c.running++;
    }
    return c;
  }, [scoped]);

  if (scoped.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6 py-16 text-muted">
        <Clock className="w-6 h-6" strokeWidth={1.5} />
        <p className="text-[13px] text-ink-2">No runs yet</p>
        <p className="text-[12px] text-muted">
          Switch to <button onClick={onJumpToCanvas} className="underline text-ocean hover:text-ocean-hover">Canvas</button> and click <span className="font-medium">Run now</span> to start one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter chips */}
      <div className="px-6 py-3 border-b border-line bg-raised flex items-center gap-1.5 flex-wrap">
        {([
          { id: 'all',       label: 'All',       n: counts.all },
          { id: 'running',   label: 'Running',   n: counts.running },
          { id: 'succeeded', label: 'Succeeded', n: counts.succeeded },
          { id: 'partial',   label: 'Partial',   n: counts.partial },
          { id: 'failed',    label: 'Failed',    n: counts.failed },
        ] as { id: RunStatusFilter; label: string; n: number }[]).map((c) => (
          <button
            key={c.id}
            onClick={() => setFilter(c.id)}
            disabled={c.n === 0 && c.id !== 'all'}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-medium rounded border transition-colors',
              filter === c.id
                ? 'bg-ocean text-white border-ocean'
                : c.n === 0
                  ? 'bg-soft text-muted-2 border-line cursor-default opacity-50'
                  : 'bg-raised text-ink-2 border-line hover:bg-softer',
            )}
          >
            {c.label}
            <span className={cn(
              'text-[10px] font-mono tabular-nums',
              filter === c.id ? 'text-white/80' : 'text-muted-2',
            )}>{c.n}</span>
          </button>
        ))}
      </div>

      {/* Run table */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-6 py-10 text-[12px] text-muted text-center">
            No runs match this filter.
          </div>
        ) : (
          <div className="divide-y divide-line">
            {filtered.map((r) => (
              <RunsListRow
                key={r.id}
                run={r}
                dag={dag}
                isActive={activeJobId != null && r.job_id === activeJobId}
                expanded={expandedId === r.id}
                onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunsListRow({
  run, dag, isActive, expanded, onToggle,
}: {
  run: RunRow;
  dag: Dag | null;
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = run.status === 'succeeded' ? CheckCircle2
    : run.status === 'partial' || run.status === 'failed' ? AlertCircle
    : run.status === 'running' || run.status === 'queued' ? Loader2 : Clock;
  const color = run.status === 'succeeded' ? OBSERVATORY.ok
    : run.status === 'partial' ? OBSERVATORY.warn
    : run.status === 'failed' ? OBSERVATORY.err
    : run.status === 'running' || run.status === 'queued' ? OBSERVATORY.ocean
    : OBSERVATORY.muted;
  const sources = run.node_results?.sources ?? [];
  const products = run.node_results?.products ?? [];
  const duration = run.completed_at && run.started_at
    ? Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)
    : null;

  // Resolve names from the DAG so the expansion shows "Exact Online" not "5"
  const sourceNameById = useMemo(
    () => new Map((dag?.sources ?? []).map((s) => [s.id, s.name])),
    [dag],
  );

  return (
    <div className={cn(isActive && 'bg-ocean-softer/40')}>
      <button
        onClick={onToggle}
        className="w-full px-6 py-2.5 flex items-center gap-3 hover:bg-softer text-left transition-colors"
      >
        <ChevronDown
          className={cn(
            'w-3 h-3 text-muted-2 shrink-0 transition-transform',
            !expanded && '-rotate-90',
          )}
        />
        <Icon
          className={cn('w-3.5 h-3.5 shrink-0', (run.status === 'running' || run.status === 'queued') && 'animate-spin')}
          style={{ color }}
        />
        <span className="font-mono text-[12px] text-ink shrink-0">#{run.id}</span>
        {isActive && (
          <span className="text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded bg-ocean text-white">live</span>
        )}
        <span className="text-[12px] text-ink-2 truncate flex-1">
          {run.triggered_by ?? '—'}
        </span>
        <span className="text-[11px] font-mono uppercase tracking-[0.08em] shrink-0" style={{ color }}>
          {run.status}
        </span>
        {(sources.length > 0 || products.length > 0) && (
          <span className="text-[11px] font-mono text-muted-2 shrink-0 hidden sm:inline">
            {sources.length}s · {products.length}p
          </span>
        )}
        {duration != null && (
          <span className="text-[11px] font-mono text-muted-2 tabular-nums shrink-0">
            {duration < 60 ? `${duration}s` : `${Math.round(duration / 60)}m`}
          </span>
        )}
        <span className="text-[11px] font-mono text-muted-2 tabular-nums shrink-0 w-24 text-right">
          {formatRelative(run.queued_at)}
        </span>
      </button>
      {expanded && (
        <div className="px-6 pb-3 bg-softer/30 border-t border-line/60">
          {run.error_message && (
            <div className="mt-2 mx-6 px-2 py-1.5 rounded text-[11.5px] font-mono" style={{ background: OBSERVATORY.errSoft, color: OBSERVATORY.err }}>
              {run.error_message}
            </div>
          )}
          <div className="mt-2 mx-6 grid grid-cols-2 gap-x-8 gap-y-3">
            {/* Sources */}
            <div>
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
                Sources ({sources.length})
              </p>
              {sources.length === 0 ? (
                <p className="text-[11.5px] text-muted italic">None</p>
              ) : (
                <div className="space-y-0.5">
                  {sources.map((s) => {
                    const name = sourceNameById.get(s.sourceId) ?? `#${s.sourceId}`;
                    const c = s.status === 'succeeded' ? OBSERVATORY.ok
                      : s.status === 'failed' ? OBSERVATORY.err
                      : OBSERVATORY.muted2;
                    const SrcIcon = s.status === 'succeeded' ? CheckCircle2
                      : s.status === 'failed' ? AlertCircle
                      : MinusSquare;
                    return (
                      <div key={s.sourceId} className="flex items-center gap-2 text-[11.5px] py-0.5">
                        <SrcIcon className="w-3 h-3 shrink-0" style={{ color: c }} />
                        <Database className="w-3 h-3 shrink-0" style={{ color: OBSERVATORY.ocean }} />
                        <span className="text-ink-2 flex-1 truncate">{name}</span>
                        <span className="font-mono uppercase tracking-[0.08em] text-[10px]" style={{ color: c }}>{s.status}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {/* Products */}
            <div>
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
                Products ({products.length})
              </p>
              {products.length === 0 ? (
                <p className="text-[11.5px] text-muted italic">None</p>
              ) : (
                <div className="space-y-0.5">
                  {products.map((p) => {
                    const c = p.allOk ? OBSERVATORY.ok
                      : p.failedTables > 0 ? OBSERVATORY.err
                      : OBSERVATORY.muted2;
                    const PIcon = p.allOk ? CheckCircle2 : AlertCircle;
                    return (
                      <div key={p.productId} className="flex items-center gap-2 text-[11.5px] py-0.5">
                        <PIcon className="w-3 h-3 shrink-0" style={{ color: c }} />
                        <Boxes className="w-3 h-3 shrink-0" style={{ color: OBSERVATORY.ai }} />
                        <span className="text-ink-2 flex-1 truncate">{p.productName}</span>
                        <span className="text-[10.5px] font-mono text-muted-2">
                          {p.totalTables - p.failedTables}/{p.totalTables}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          {run.job_id && (
            <p className="mt-3 mx-6 text-[10px] font-mono tracking-[0.06em] text-muted-2">
              job {run.job_id} · queued {formatRelative(run.queued_at)}
              {run.started_at && ` · started ${formatRelative(run.started_at)}`}
              {run.completed_at && ` · finished ${formatRelative(run.completed_at)}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Custom pipeline editor (modal) ─────────────────────────────────────────

/**
 * Canvas-based custom pipeline editor.
 *
 * Full-screen modal with the same DAG as the main page. Click any node to
 * include it AND all its upstream dependencies — implicit policy because
 * "refresh a fact without its dim or its source" is never what users want.
 * Click again to remove it (and any nodes that are now orphaned in the
 * selection).
 *
 * No checkboxes, no toggles, no expansion options. The graph is the UI.
 */
function CustomPipelineEditor({
  dag, existing, onClose, onSaved,
}: {
  dag: Dag;
  existing?: CustomPipeline;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [pickedSources, setPickedSources] = useState<Set<number>>(
    new Set(existing?.scope.type === 'custom' ? existing.scope.sourceIds : []),
  );
  const [pickedProducts, setPickedProducts] = useState<Set<number>>(
    new Set(existing?.scope.type === 'custom' ? existing.scope.productIds : []),
  );
  const [triggers, setTriggers] = useState<PipelineTrigger[]>(existing?.triggers ?? []);
  const [saving, setSaving] = useState(false);

  // ── Upstream graph helpers ────────────────────────────────────────────
  // For a given product, walk every incoming edge to collect the set of
  // upstream products + source connections it depends on. This is the
  // "include all upstream dependencies" policy applied at click time.
  const upstreamFor = useCallback((target: { kind: 'product'; id: number }): { sourceIds: Set<number>; productIds: Set<number> } => {
    const sourceIds = new Set<number>();
    const productIds = new Set<number>([target.id]);
    const visited = new Set<string>();
    const queue: Array<`p:${number}`> = [`p:${target.id}`];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const e of dag.edges) {
        const tgt = `p:${e.target.id}`;
        if (tgt !== cur) continue;
        if (e.source.kind === 'connection') {
          sourceIds.add(e.source.id);
        } else {
          productIds.add(e.source.id);
          queue.push(`p:${e.source.id}` as `p:${number}`);
        }
      }
    }
    return { sourceIds, productIds };
  }, [dag.edges]);

  const isInScope = useCallback((kind: 'connection' | 'product', id: number): boolean => {
    return kind === 'connection' ? pickedSources.has(id) : pickedProducts.has(id);
  }, [pickedSources, pickedProducts]);

  // Click a node:
  //   • If currently in scope, REMOVE it (just that one — leaves upstream
  //     intact in case other in-scope nodes still need it; the resolver
  //     will re-add what's necessary at run time).
  //   • If not in scope, ADD it AND its full upstream chain.
  const onNodeClick = useCallback((kind: 'connection' | 'product', id: number) => {
    if (isInScope(kind, id)) {
      if (kind === 'connection') {
        setPickedSources((s) => { const n = new Set(s); n.delete(id); return n; });
      } else {
        setPickedProducts((s) => { const n = new Set(s); n.delete(id); return n; });
      }
      return;
    }
    if (kind === 'connection') {
      setPickedSources((s) => { const n = new Set(s); n.add(id); return n; });
    } else {
      const upstream = upstreamFor({ kind: 'product', id });
      setPickedSources((s) => {
        const n = new Set(s);
        upstream.sourceIds.forEach((sid) => n.add(sid));
        return n;
      });
      setPickedProducts((s) => {
        const n = new Set(s);
        upstream.productIds.forEach((pid) => n.add(pid));
        return n;
      });
    }
  }, [isInScope, upstreamFor]);

  // ── ReactFlow nodes / edges for the editor canvas ────────────────────
  const [edNodes, setEdNodes, edOnNodesChange] = useNodesState([]);
  const [edEdges, setEdEdges, edOnEdgesChange] = useEdgesState([]);

  useEffect(() => {
    const scopeHint = { sourceIds: pickedSources, productIds: pickedProducts };
    const positions = layoutDag(dag, scopeHint);
    const nodes: Node<NodeData>[] = [
      ...dag.sources.map((s) => ({
        id: `c:${s.id}`,
        type: 'graph',
        position: positions.get(`c:${s.id}`) ?? { x: 0, y: 0 },
        data: {
          label: s.name, kind: 'connection' as const,
          inScope: pickedSources.has(s.id),
          meta: { connectorType: s.connectorType, lastAt: s.lastSyncedAt, status: s.lastSyncStatus ?? undefined },
        },
        draggable: false,
      })),
      ...dag.products.map((p) => ({
        id: `p:${p.id}`,
        type: 'graph',
        position: positions.get(`p:${p.id}`) ?? { x: 0, y: 0 },
        data: {
          label: p.name, kind: 'product' as const,
          inScope: pickedProducts.has(p.id),
          meta: { status: p.status, lastAt: p.lastRunAt },
        },
        draggable: false,
      })),
    ];
    setEdNodes(nodes);
    setEdEdges(
      dag.edges.map((e, i) => {
        const fromKey = `${e.source.kind === 'connection' ? 'c' : 'p'}:${e.source.id}`;
        const toKey = `p:${e.target.id}`;
        const inScope = (e.source.kind === 'connection'
          ? pickedSources.has(e.source.id)
          : pickedProducts.has(e.source.id))
          && pickedProducts.has(e.target.id);
        return {
          id: `e-${i}`,
          source: fromKey, target: toKey,
          type: 'smoothstep',
          style: {
            stroke: inScope ? OBSERVATORY.ocean : OBSERVATORY.line,
            strokeWidth: inScope ? 1.5 : 1,
            strokeDasharray: inScope ? undefined : '4 4',
          },
        };
      }),
    );
  }, [dag, pickedSources, pickedProducts, setEdNodes, setEdEdges]);

  // ── Save ─────────────────────────────────────────────────────────────
  const save = async () => {
    if (!name.trim()) { toast.error('Pipeline needs a name'); return; }
    if (pickedSources.size === 0 && pickedProducts.size === 0) {
      toast.error('Click at least one node on the canvas to include it');
      return;
    }
    setSaving(true);
    try {
      // includeUpstream + skipSourceSync are now resolver-side implicit
      // ("always sync sources for in-scope products"); we just send the
      // user's explicit picks. includeDownstream stays opt-in (false).
      const scope: PipelineScope = {
        type: 'custom',
        sourceIds: Array.from(pickedSources),
        productIds: Array.from(pickedProducts),
        includeUpstream: true,
        includeDownstream: false,
        skipSourceSync: false,
      };
      if (existing) {
        await api.put(`/pipelines/saved/${existing.id}`, {
          name: name.trim(), description: description.trim() || null, scope, triggers,
        });
        toast.success('Pipeline updated');
      } else {
        await api.post('/pipelines/saved', {
          name: name.trim(), description: description.trim() || null, scope, triggers,
        });
        toast.success('Pipeline created');
      }
      onSaved();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error ?? (err as Error).message;
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 bg-ink/60 flex flex-col" onClick={onClose}>
      <div className="flex-1 flex flex-col bg-bg" onClick={(e) => e.stopPropagation()}>
        {/* ── Top bar: name + save / cancel ───────────────────────────── */}
        <div className="border-b border-line bg-raised px-6 py-3 flex items-center gap-3 shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">
              {existing ? 'Edit pipeline' : 'New pipeline'}
            </p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pipeline name (e.g. EO daily refresh)"
              className="w-full bg-transparent border-none outline-none font-display text-[20px] tracking-[-0.01em] text-ink focus:ring-0 placeholder:text-muted-2"
              autoFocus
            />
          </div>
          <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-muted-2 shrink-0">
            {pickedSources.size} source{pickedSources.size === 1 ? '' : 's'}
            {' · '}
            {pickedProducts.size} product{pickedProducts.size === 1 ? '' : 's'}
          </span>
          <button onClick={onClose} className="px-3 py-1.5 text-[12px] text-ink-2 border border-line rounded-md hover:bg-softer">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {existing ? 'Save changes' : 'Create pipeline'}
          </button>
        </div>

        {/* ── Canvas — clickable nodes, no scrolling ──────────────────── */}
        <div className="flex-1 relative" style={{ background: OBSERVATORY.bg }}>
          <ReactFlow
            nodes={edNodes}
            edges={edEdges}
            onNodesChange={edOnNodesChange}
            onEdgesChange={edOnEdgesChange}
            onNodeClick={(_e, node) => {
              const data = node.data as NodeData;
              const id = Number(node.id.split(':')[1]);
              onNodeClick(data.kind, id);
            }}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.4}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
          >
            <Background color={OBSERVATORY.line} gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>

          {/* Hint card — only visible while empty */}
          {pickedSources.size === 0 && pickedProducts.size === 0 && (
            <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-raised border border-line rounded-md px-4 py-2.5 shadow-md pointer-events-none">
              <p className="text-[12.5px] text-ink">
                Click a <span className="text-ai font-medium">data product</span> to include it (and everything it needs upstream),
                or click a <span className="text-ocean font-medium">source</span> directly.
              </p>
            </div>
          )}

          {/* Legend bottom-right */}
          <div className="absolute bottom-3 right-3 bg-raised border border-line rounded-md px-3 py-2 text-[10px] font-mono uppercase tracking-[0.08em] flex items-center gap-3 shadow-sm">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm border-2" style={{ borderColor: OBSERVATORY.ocean }} /> source in scope</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm border-2" style={{ borderColor: OBSERVATORY.ai }} /> product in scope</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: OBSERVATORY.softer, border: `1px solid ${OBSERVATORY.line}` }} /> click to add</span>
          </div>
        </div>

        {/* ── Bottom strip: description + triggers ────────────────────── */}
        <div className="border-t border-line bg-raised px-6 py-3 shrink-0 max-h-[40%] overflow-y-auto">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Description (optional)</p>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this pipeline do?"
                rows={2}
                className="w-full bg-soft border border-line rounded-md px-3 py-2 text-[12.5px] focus:outline-none focus:border-ocean resize-none"
              />
            </div>
            <div>
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Triggers</p>
              {triggers.length === 0 && (
                <p className="text-[12px] text-muted italic mb-2">Manual run only. Add a trigger below to run automatically.</p>
              )}
              {triggers.map((t, i) => (
                <div key={i} className="flex items-center gap-2 mb-1.5 px-2 py-1.5 bg-soft border border-line rounded">
                  <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted">
                    {t.kind === 'cron' ? 'cron' : t.kind === 'on_pipeline_complete' ? 'after pipeline' : 'after sync'}
                  </span>
                  {t.kind === 'cron' && (
                    <>
                      <input
                        type="text" value={t.cron}
                        onChange={(e) => {
                          const next = [...triggers];
                          next[i] = { ...t, cron: e.target.value };
                          setTriggers(next);
                        }}
                        placeholder="0 2 * * *"
                        className="flex-1 bg-raised border border-line rounded px-2 py-1 text-[12px] font-mono"
                      />
                      <input
                        type="text" value={t.tz ?? ''}
                        onChange={(e) => {
                          const next = [...triggers];
                          next[i] = { ...t, tz: e.target.value || undefined };
                          setTriggers(next);
                        }}
                        placeholder="UTC"
                        className="w-24 bg-raised border border-line rounded px-2 py-1 text-[12px] font-mono"
                      />
                    </>
                  )}
                  {t.kind === 'on_source_sync_succeeded' && (
                    <select
                      value={t.sourceId}
                      onChange={(e) => {
                        const next = [...triggers];
                        next[i] = { ...t, sourceId: Number(e.target.value) };
                        setTriggers(next);
                      }}
                      className="flex-1 bg-raised border border-line rounded px-2 py-1 text-[12px]"
                    >
                      <option value="">Pick a source…</option>
                      {dag.sources.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                    </select>
                  )}
                  <button
                    onClick={() => setTriggers(triggers.filter((_, idx) => idx !== i))}
                    className="p-1 rounded hover:bg-err-soft text-muted-2 hover:text-err"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-1.5 mt-1">
                <button
                  onClick={() => setTriggers([...triggers, { kind: 'cron', cron: '0 2 * * *', tz: 'UTC' }])}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-ink-2 border border-line rounded hover:bg-softer"
                ><Plus className="w-3 h-3" /> Cron</button>
                {dag.sources.length > 0 && (
                  <button
                    onClick={() => setTriggers([...triggers, { kind: 'on_source_sync_succeeded', sourceId: dag.sources[0].id }])}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-ink-2 border border-line rounded hover:bg-softer"
                  ><Plus className="w-3 h-3" /> When a source syncs</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Active run dock (ADF-style) ────────────────────────────────────────────
//
// Sits between the DAG canvas and the Recent-runs list. Two halves:
//   • LEFT  — node status table: each source + product in scope, with a
//             status pill (queued / running / ✓ ok / ✗ failed) that updates
//             from the SSE stream as events arrive.
//   • RIGHT — chronological log (terminal-style). Per-failed-table errors
//             render in red so you can read the actual SQL/transformation
//             failure inline.
// Collapsible to a single-line strip showing pipeline name + status counts;
// dismissible after the run completes.

type NodeRunStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped' | 'idle';

interface NodeRunState {
  key: string;             // 'c:5' | 'p:17'
  kind: 'connection' | 'product';
  id: number;
  name: string;
  status: NodeRunStatus;
  detail?: string;         // e.g. "3 of 5 tables ok" or error message
  errors?: string[];       // per-table failures (products only)
  /** Sources only: the source_sync_runs.id assigned by triggerSync, so the
   * dock can fetch live per-entity progress when the row is expanded. */
  syncRunId?: number;
}

function RunActivityDock({
  jobId, pipelineRunId: _runId, pipelineName, scopeHint, dag, onDismiss, onCompleted, onLiveNodesChange,
}: {
  jobId: string;
  pipelineRunId: number;
  pipelineName: string;
  scopeHint: { sourceIds: Set<number>; productIds: Set<number> };
  dag: Dag | null;
  onDismiss: () => void;
  onCompleted: () => void;
  /** Lifted up so the canvas above can animate per-node status from the
   * same SSE stream. The dock remains the single SSE consumer; canvas
   * just paints whatever it gets. */
  onLiveNodesChange?: (nodes: Map<string, NodeRunState>) => void;
}) {
  const [log, setLog] = useState<Array<{ kind: 'phase' | 'log' | 'error' | 'done'; text: string }>>([]);
  const [nodes, setNodes] = useState<Map<string, NodeRunState>>(new Map());
  const [done, setDone] = useState(false);
  const [allOk, setAllOk] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Seed node table from the scope hint so users see queued nodes IMMEDIATELY
  // (before the first SSE event arrives).
  useEffect(() => {
    if (!dag) return;
    // Mirror the orchestrator's disambiguation rule: when two products in
    // scope share a name (e.g. "Sales" from EO + "Sales" from wholesale_erp),
    // suffix with the source connection name so log + dock match.
    const productsInScope = Array.from(scopeHint.productIds)
      .map((id) => dag.products.find((p) => p.id === id))
      .filter((p): p is DagProduct => !!p);
    const nameCount = new Map<string, number>();
    for (const p of productsInScope) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
    const sourceNameById = new Map(dag.sources.map((s) => [s.id, s.name]));
    const productDisplayName = (p: DagProduct): string => {
      if ((nameCount.get(p.name) ?? 0) > 1 && p.connectionId != null) {
        const src = sourceNameById.get(p.connectionId);
        if (src) return `${p.name} (${src})`;
      }
      return p.name;
    };

    const seed = new Map<string, NodeRunState>();
    Array.from(scopeHint.sourceIds).forEach((id) => {
      const s = dag.sources.find((x) => x.id === id);
      if (!s) return;
      seed.set(`c:${id}`, { key: `c:${id}`, kind: 'connection', id, name: s.name, status: 'queued' });
    });
    productsInScope.forEach((p) => {
      seed.set(`p:${p.id}`, { key: `p:${p.id}`, kind: 'product', id: p.id, name: productDisplayName(p), status: 'queued' });
    });
    setNodes(seed);
    // Reset log when a new run starts
    setLog([]);
    setDone(false);
    setAllOk(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Match a "Source sync queued / OK / failed" line back to a connection
  // node by name, so the per-node status pill updates as the orchestrator
  // emits its log lines. Best-effort — falls back to the cumulative log
  // for anything we can't pin to a node.
  const updateNodeByName = useCallback((name: string, kind: 'connection' | 'product', patch: Partial<NodeRunState>) => {
    setNodes((prev) => {
      const entries = Array.from(prev.entries());
      for (const [k, v] of entries) {
        if (v.kind === kind && v.name === name) {
          const next = new Map(prev);
          next.set(k, { ...v, ...patch });
          return next;
        }
      }
      return prev;
    });
  }, []);

  // SSE attach. Using a ref for `onCompleted` so we can safely omit it from
  // the effect's dependency array — otherwise an unstable parent callback
  // would tear this down + reopen on every render, and BullMQ would replay
  // the entire job log from the start (= the "stuck" symptom we shipped a
  // fix for).
  const onCompletedRef = React.useRef(onCompleted);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (!cancelled) {
          const { done: d, value } = await reader.read();
          if (value) buf += dec.decode(value, { stream: !d });
          const lines = buf.split('\n');
          buf = d ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
              const t = ev.type as string;
              if (t === 'phase') {
                setLog((l) => [...l, { kind: 'phase', text: ev.text as string }]);
              } else if (t === 'log') {
                const text = ev.text as string;
                setLog((l) => [...l, { kind: 'log', text }]);
                // Try to pin source-sync log lines to their source node.
                // Format: "  <name>: queueing sync…" / "  <name>: sync OK"
                //         / "  <name>: skipped (...)"
                const m = text.match(/^\s+(.+?): (queueing sync|sync OK|skipped.*)/);
                if (m) {
                  const name = m[1];
                  const status: NodeRunStatus =
                    /queueing/.test(m[2]) ? 'running' :
                    /sync OK/.test(m[2]) ? 'ok' :
                    /skipped/.test(m[2]) ? 'skipped' : 'queued';
                  updateNodeByName(name, 'connection', { status, detail: m[2] });
                }
                // Product start: "  Running "<name>"…"
                const pm = text.match(/^\s+Running "(.+?)"…/);
                if (pm) {
                  updateNodeByName(pm[1], 'product', { status: 'running' });
                }
              } else if (t === 'source_run') {
                // Pin the source_sync_runs.id to the matching source node so
                // expand → /api/connections/:id/sync-runs/:syncRunId can
                // show live per-entity row_counts.
                const sourceId = ev.sourceConnectionId as number | undefined;
                const syncRunId = ev.syncRunId as number | undefined;
                if (sourceId != null && syncRunId != null) {
                  setNodes((prev) => {
                    const k = `c:${sourceId}`;
                    const cur = prev.get(k);
                    if (!cur) return prev;
                    const next = new Map(prev);
                    next.set(k, { ...cur, syncRunId });
                    return next;
                  });
                }
              } else if (t === 'product') {
                const status = (ev.status === 'ok' ? 'ok' :
                                ev.status === 'partial' ? 'failed' :
                                'failed') as NodeRunStatus;
                updateNodeByName(ev.productName as string, 'product', {
                  status,
                  detail: ev.text as string,
                });
                setLog((l) => [...l, { kind: 'log', text: `  "${ev.productName}": ${ev.text}` }]);
              } else if (t === 'error_detail') {
                const productName = ev.productName as string | undefined;
                const tbl = ev.tableName as string;
                const errMsg = ev.error as string;
                setLog((l) => [...l, { kind: 'error', text: `    ✗ ${tbl}: ${errMsg}` }]);
                if (productName) {
                  setNodes((prev) => {
                    const entries = Array.from(prev.entries());
                    for (const [k, v] of entries) {
                      if (v.kind === 'product' && v.name === productName) {
                        const next = new Map(prev);
                        next.set(k, { ...v, errors: [...(v.errors ?? []), `${tbl}: ${errMsg}`] });
                        return next;
                      }
                    }
                    return prev;
                  });
                }
              } else if (t === 'done') {
                setLog((l) => [...l, { kind: 'done', text: ev.text as string }]);
              } else if (t === 'completed') {
                setDone(true);
                const ok = (ev.result as { allOk?: boolean })?.allOk;
                setAllOk(typeof ok === 'boolean' ? ok : null);
                // Mark any still-running/queued nodes as idle so the table
                // doesn't keep spinning forever.
                setNodes((prev) => {
                  const next = new Map(prev);
                  Array.from(prev.entries()).forEach(([k, v]) => {
                    if (v.status === 'running' || v.status === 'queued') {
                      next.set(k, { ...v, status: ok === false ? 'failed' : 'idle' });
                    }
                  });
                  return next;
                });
                onCompletedRef.current();
              } else if (t === 'failed') {
                setDone(true); setAllOk(false);
                setLog((l) => [...l, { kind: 'error', text: `Error: ${ev.error}` }]);
                onCompletedRef.current();
              }
            } catch { /* skip malformed */ }
          }
          if (d) break;
        }
      } catch { /* aborted */ }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, updateNodeByName]);

  const counts = useMemo(() => {
    let ok = 0, failed = 0, running = 0, queued = 0, skipped = 0;
    Array.from(nodes.values()).forEach((n) => {
      if (n.status === 'ok') ok++;
      else if (n.status === 'failed') failed++;
      else if (n.status === 'running') running++;
      else if (n.status === 'skipped') skipped++;
      else if (n.status === 'queued') queued++;
    });
    return { ok, failed, running, queued, skipped, total: nodes.size };
  }, [nodes]);

  // Mirror node status changes back up to the page so the canvas can
  // paint live. Single SSE consumer (this dock), single source of truth
  // (the `nodes` Map), parent just observes.
  useEffect(() => {
    onLiveNodesChange?.(nodes);
  }, [nodes, onLiveNodesChange]);

  // Auto-scroll log to bottom
  const logRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const orderedNodes = useMemo(
    () => Array.from(nodes.values()).sort((a, b) => {
      // Sources before products, then by name
      if (a.kind !== b.kind) return a.kind === 'connection' ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    [nodes],
  );

  return (
    <div className="border-t border-line bg-raised">
      {/* Header bar */}
      <div className="px-6 py-2 flex items-center gap-3 border-b border-line">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-0.5 rounded hover:bg-soft text-muted-2 hover:text-ink-2"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {done
          ? (allOk
              ? <CheckCircle2 className="w-4 h-4" style={{ color: OBSERVATORY.ok }} />
              : <AlertCircle className="w-4 h-4" style={{ color: OBSERVATORY.err }} />)
          : <Loader2 className="w-4 h-4 animate-spin" style={{ color: OBSERVATORY.ocean }} />}
        <span className="text-[12.5px] font-medium text-ink truncate flex-1">{pipelineName}</span>
        <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted">
          {done
            ? (allOk ? 'completed' : 'completed with errors')
            : counts.running > 0 ? 'running'
            : 'queued'}
        </span>
        <span className="flex items-center gap-2 text-[11px] font-mono">
          {counts.ok > 0       && <span style={{ color: OBSERVATORY.ok }}>{counts.ok} ok</span>}
          {counts.running > 0  && <span style={{ color: OBSERVATORY.ocean }}>{counts.running} running</span>}
          {counts.queued > 0   && <span className="text-muted-2">{counts.queued} queued</span>}
          {counts.skipped > 0  && <span className="text-muted-2">{counts.skipped} skipped</span>}
          {counts.failed > 0   && <span style={{ color: OBSERVATORY.err }}>{counts.failed} failed</span>}
        </span>
        {!done && (
          <CancelRunButton jobId={jobId} />
        )}
        {done && (
          <button
            onClick={onDismiss}
            className="p-0.5 rounded hover:bg-soft text-muted-2 hover:text-ink-2"
            aria-label="Dismiss"
            title="Hide this panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="grid grid-cols-2" style={{ height: 240 }}>
          {/* Node status table */}
          <div className="border-r border-line overflow-y-auto">
            <div className="sticky top-0 bg-raised border-b border-line px-3 py-1.5 flex items-center gap-2">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">Activity</p>
            </div>
            {orderedNodes.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-muted italic">No nodes in scope.</div>
            ) : (
              <div>
                {orderedNodes.map((n) => <NodeStatusRow key={n.key} node={n} />)}
              </div>
            )}
          </div>

          {/* Cumulative log */}
          <div className="overflow-y-auto bg-ink" ref={logRef}>
            <div className="sticky top-0 bg-ink border-b border-white/10 px-3 py-1.5">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-white/50">Output</p>
            </div>
            <div className="px-3 py-2 font-mono text-[11.5px] leading-relaxed">
              {log.length === 0 && <div className="text-white/40 italic">Waiting for output…</div>}
              {log.map((entry, i) => (
                <div key={i} className={cn(
                  entry.kind === 'error'  ? 'text-err' :
                  entry.kind === 'done'   ? 'text-ok' :
                  entry.kind === 'phase'  ? 'text-white/90 font-medium' :
                  entry.text.startsWith('  ') ? 'text-white/55' : 'text-white/80',
                )}>
                  {entry.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeStatusRow({ node }: { node: NodeRunState }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = node.kind === 'connection' ? Database : Boxes;

  const statusVisual: Record<NodeRunStatus, { icon: React.ReactNode; color: string; label: string }> = {
    queued:  { icon: <Clock className="w-3 h-3" />,                              color: OBSERVATORY.muted2, label: 'queued' },
    running: { icon: <Loader2 className="w-3 h-3 animate-spin" />,               color: OBSERVATORY.ocean,  label: 'running' },
    ok:      { icon: <CheckCircle2 className="w-3 h-3" />,                       color: OBSERVATORY.ok,     label: 'ok' },
    failed:  { icon: <AlertCircle className="w-3 h-3" />,                        color: OBSERVATORY.err,    label: 'failed' },
    skipped: { icon: <MinusSquare className="w-3 h-3" />,                        color: OBSERVATORY.muted2, label: 'skipped' },
    idle:    { icon: <SquareDashed className="w-3 h-3" />,                       color: OBSERVATORY.muted2, label: 'idle' },
  };
  const s = statusVisual[node.status];
  const hasErrors = (node.errors?.length ?? 0) > 0;
  // Whether there's anything useful to show on expand. Sources without a
  // syncRunId (skipped, queued before triggerSync returned) only have the
  // top-line status — leave them non-expandable to avoid the affordance.
  const expandable = (node.kind === 'connection' && node.syncRunId != null)
    || node.kind === 'product'
    || hasErrors;

  return (
    <div className="border-b border-line/60">
      <button
        onClick={() => expandable && setExpanded(!expanded)}
        disabled={!expandable}
        className={cn(
          'w-full px-3 py-1.5 flex items-center gap-2 text-left',
          expandable ? 'hover:bg-softer cursor-pointer' : 'cursor-default',
        )}
      >
        {expandable
          ? <ChevronDown className={cn('w-3 h-3 text-muted-2 transition-transform shrink-0', !expanded && '-rotate-90')} />
          : <span className="w-3 h-3 shrink-0" />}
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: node.kind === 'connection' ? OBSERVATORY.ocean : OBSERVATORY.ai }} />
        <span className="text-[12.5px] text-ink truncate flex-1">{node.name}</span>
        {node.detail && (
          <span className="text-[10.5px] text-muted-2 truncate max-w-[40%] hidden sm:inline">{node.detail}</span>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.08em] shrink-0" style={{ color: s.color }}>
          {s.icon}
          {s.label}
        </span>
        {hasErrors && (
          <span className="text-[10px] font-mono uppercase tracking-[0.08em]" style={{ color: OBSERVATORY.err }}>
            {node.errors!.length} ✗
          </span>
        )}
      </button>
      {expanded && expandable && (
        <div className="border-t border-line/60 bg-softer/40">
          {node.kind === 'connection' && node.syncRunId != null && (
            <SourceSyncDetail syncRunId={node.syncRunId} sourceId={node.id} live={node.status === 'running' || node.status === 'queued'} />
          )}
          {node.kind === 'product' && (
            <ProductRunDetail productId={node.id} live={node.status === 'running' || node.status === 'queued'} errors={node.errors ?? []} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Live per-entity detail for a running source sync. Polls
 * `GET /api/connections/:id/sync-runs/:syncRunId` every 3s while the sync
 * is in flight and shows row_counts as they update — so users SEE the
 * sync isn't stuck.
 *
 * Also surfaces a "stuck" warning if status hasn't changed AND row_counts
 * hasn't moved for 60+ seconds. That's the cheapest way to give users a
 * way out of the 30-min orchestrator timeout when the sync-worker
 * container app is unreachable.
 */
function SourceSyncDetail({ syncRunId, sourceId, live }: { syncRunId: number; sourceId: number; live: boolean }) {
  const [run, setRun] = useState<{
    status: string;
    queued_at: string;
    started_at: string | null;
    completed_at: string | null;
    row_counts: Record<string, number> | null;
    warnings: unknown;
    error_message: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // For stuck detection: track last time we saw a status / row_counts change
  const lastChangeRef = React.useRef<number>(Date.now());
  const lastSnapshotRef = React.useRef<string>('');
  const [stuckWarning, setStuckWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get(`/connections/${sourceId}/sync-runs/${syncRunId}`);
        if (cancelled) return;
        const data = res.data?.data ?? null;
        setRun(data);
        // Stuck detection — same status + same row_counts for 60s while live.
        const snapshot = JSON.stringify({ s: data?.status, c: data?.row_counts });
        if (snapshot !== lastSnapshotRef.current) {
          lastSnapshotRef.current = snapshot;
          lastChangeRef.current = Date.now();
          setStuckWarning(false);
        } else if (live && Date.now() - lastChangeRef.current > 60_000) {
          setStuckWarning(true);
        }
      } catch { /* swallow — keep last-known-good */ } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    if (live) {
      const t = setInterval(tick, 3_000);
      return () => { cancelled = true; clearInterval(t); };
    }
    return () => { cancelled = true; };
  }, [syncRunId, sourceId, live]);

  if (loading) {
    return <div className="px-4 py-2 text-[11px] text-muted">Loading sync detail…</div>;
  }
  if (!run) {
    return <div className="px-4 py-2 text-[11px] text-muted italic">No sync run found.</div>;
  }
  const rowCounts = run.row_counts ?? {};
  const entries = Object.entries(rowCounts);
  return (
    <div className="px-4 py-2 space-y-1.5">
      <div className="flex items-center gap-3 text-[11px]">
        <span className="font-mono text-muted">run #{syncRunId}</span>
        <span className="font-mono uppercase tracking-[0.08em]" style={{
          color: run.status === 'succeeded' ? OBSERVATORY.ok
            : run.status === 'failed' ? OBSERVATORY.err
            : run.status === 'cancelled' ? OBSERVATORY.muted
            : OBSERVATORY.ocean,
        }}>{run.status}</span>
        {run.started_at && <span className="text-muted-2">started {formatRelative(run.started_at)}</span>}
        {run.completed_at && <span className="text-muted-2">finished {formatRelative(run.completed_at)}</span>}
      </div>
      {stuckWarning && (
        <div className="px-2 py-1.5 rounded text-[11px]" style={{ background: OBSERVATORY.warnSoft, color: OBSERVATORY.warn }}>
          ⚠ No progress in 60+ seconds. The sync worker may not be running. You can cancel the run from the dock header and check the source connection.
        </div>
      )}
      {run.error_message && (
        <div className="px-2 py-1 rounded text-[11px] font-mono" style={{ background: OBSERVATORY.errSoft, color: OBSERVATORY.err }}>
          {run.error_message}
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-[11px] text-muted italic">No entities synced yet — waiting for the worker to start.</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          {entries.map(([entity, count]) => (
            <div key={entity} className="flex items-center justify-between text-[11px]">
              <span className="font-mono text-ink-2 truncate">{entity}</span>
              <span className="font-mono tabular-nums text-muted-2">{count.toLocaleString('en-GB')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Cancel-running-pipeline button. Hits the existing
 * /api/products/bus-matrix/:jobId/cancel endpoint (which works for the
 * `pipeline` mode too — same queue). Optimistic: shows "Cancelling…"
 * until the orchestrator's cancellation check fires and the SSE stream
 * emits a `failed` event.
 */
function CancelRunButton({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  return (
    <button
      onClick={async () => {
        if (cancelling) return;
        setCancelling(true);
        try {
          await api.post(`/products/bus-matrix/${jobId}/cancel`);
          toast.info('Cancellation requested — the run will stop at the next checkpoint.');
        } catch (err) {
          const ax = err as { response?: { data?: { error?: string } }; message?: string };
          toast.error(ax?.response?.data?.error ?? ax?.message ?? 'Cancel failed');
          setCancelling(false);
        }
      }}
      disabled={cancelling}
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-err border border-err/40 rounded hover:bg-err-soft disabled:opacity-50 transition-colors"
      title="Stop this pipeline run"
    >
      {cancelling ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </button>
  );
}

/**
 * Per-table progress for a running product transformation. Polls
 * `GET /api/pipelines` (legacy product DAG endpoint) which already
 * returns table-level transformation_status + last_run_error.
 */
function ProductRunDetail({ productId, live, errors }: { productId: number; live: boolean; errors: string[] }) {
  type Tbl = {
    id: number; product_id: number | null; table_name: string;
    table_role: string | null; transformation_status: string | null;
    last_run_at: string | null; last_run_error: string | null;
    row_count: number | null;
  };
  const [tables, setTables] = useState<Tbl[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get('/pipelines');
        if (cancelled) return;
        const all = ((res.data?.data?.tables ?? []) as Tbl[]).filter((t) => t.product_id === productId);
        setTables(all);
      } catch { /* swallow */ } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    if (live) {
      const t = setInterval(tick, 3_000);
      return () => { cancelled = true; clearInterval(t); };
    }
    return () => { cancelled = true; };
  }, [productId, live]);

  if (loading) {
    return <div className="px-4 py-2 text-[11px] text-muted">Loading table detail…</div>;
  }
  if (tables.length === 0 && errors.length === 0) {
    return <div className="px-4 py-2 text-[11px] text-muted italic">No tables defined for this product.</div>;
  }
  return (
    <div className="px-4 py-2 space-y-0.5">
      {tables.map((t) => {
        const status = (t.transformation_status ?? 'idle').toLowerCase();
        const color = status === 'success' ? OBSERVATORY.ok
          : status === 'running' ? OBSERVATORY.ocean
          : status === 'error' ? OBSERVATORY.err
          : OBSERVATORY.muted2;
        const Icon = status === 'success' ? CheckCircle2
          : status === 'running' ? Loader2
          : status === 'error' ? AlertCircle
          : Clock;
        return (
          <div key={t.id} className="flex items-center gap-2 text-[11px] py-0.5">
            <Icon className={cn('w-3 h-3 shrink-0', status === 'running' && 'animate-spin')} style={{ color }} />
            <span className="font-mono text-ink-2 flex-1 truncate">{t.table_name}</span>
            {t.row_count != null && (
              <span className="font-mono tabular-nums text-muted-2">{t.row_count.toLocaleString('en-GB')}</span>
            )}
            <span className="font-mono uppercase tracking-[0.08em] text-[10px]" style={{ color }}>{status}</span>
          </div>
        );
      })}
      {errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {errors.map((err, i) => (
            <div key={i} className="px-2 py-1 text-[11px] font-mono rounded" style={{ background: OBSERVATORY.errSoft, color: OBSERVATORY.ink2 }}>
              {err}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


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
  meta: { connectorType?: string | null; status?: string; lastAt?: string | null };
}

function GraphNode({ data }: NodeProps<NodeData>) {
  const Icon = data.kind === 'connection' ? Database : Boxes;
  return (
    <div
      className="rounded-md border-2 px-3 py-2 transition-all"
      style={{
        width: NODE_W, height: NODE_H,
        background: data.inScope ? OBSERVATORY.raised : OBSERVATORY.softer,
        borderColor: data.inScope
          ? (data.kind === 'connection' ? OBSERVATORY.ocean : OBSERVATORY.ai)
          : OBSERVATORY.line,
        opacity: data.inScope ? 1 : 0.5,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: OBSERVATORY.line, width: 6, height: 6, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: OBSERVATORY.line, width: 6, height: 6, border: 'none' }} />
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: data.inScope ? (data.kind === 'connection' ? OBSERVATORY.ocean : OBSERVATORY.ai) : OBSERVATORY.muted2 }} />
        <span className="text-[12px] font-medium truncate" style={{ color: OBSERVATORY.ink }}>{data.label}</span>
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
        const live = (e.source.kind === 'connection'
          ? scopeHint.sourceIds.has(e.source.id)
          : scopeHint.productIds.has(e.source.id))
          && scopeHint.productIds.has(e.target.id);
        return {
          id: `e-${i}`,
          source: fromKey, target: toKey,
          type: 'smoothstep',
          style: {
            stroke: live ? OBSERVATORY.ocean : OBSERVATORY.line,
            strokeWidth: live ? 1.5 : 1,
          },
        };
      }),
    );
  }, [dag, scopeHint, setRfNodes, setRfEdges]);

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
                onRun={() => runPipeline(
                  selected.kind === 'builtin' ? selected.id : selected.stableId,
                  selected.name,
                )}
                onEdit={selected.kind === 'custom' ? () => setShowCustomEditor({ mode: 'edit', id: (selected as CustomPipeline).id }) : undefined}
              />
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
                Active run dock — ADF-style. Sits BETWEEN the DAG canvas and
                Recent runs so the user never loses sight of either while a
                run is in progress. Per-node status + cumulative log,
                collapsible to a one-line strip.
              */}
              {activeStream && (
                <RunActivityDock
                  jobId={activeStream.jobId}
                  pipelineRunId={activeStream.pipelineRunId}
                  pipelineName={activeStream.pipelineName}
                  scopeHint={scopeHint}
                  dag={dag}
                  onDismiss={() => { setActiveStream(null); reloadRuns(); reload(); }}
                  onCompleted={() => { reloadRuns(); reload(); }}
                />
              )}
              <RunHistory
                runs={recentRuns}
                pipelineId={selected.kind === 'custom' ? (selected as CustomPipeline).id : null}
              />
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
    const builtinGlobal = pipelines.filter((p) => p.kind === 'builtin' && (p as BuiltinPipeline & { kind: 'builtin' }).group === 'global');
    const builtinSource = pipelines.filter((p) => p.kind === 'builtin' && (p as BuiltinPipeline & { kind: 'builtin' }).group === 'source');
    const builtinProduct = pipelines.filter((p) => p.kind === 'builtin' && (p as BuiltinPipeline & { kind: 'builtin' }).group === 'product');
    const custom = pipelines.filter((p) => p.kind === 'custom');
    return { builtinGlobal, builtinSource, builtinProduct, custom };
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
      <Section title="Built-in" eyebrow="global">
        {groups.builtinGlobal.map((p) => (
          <ListItem key={p.kind === 'builtin' ? p.id : p.stableId}
            id={p.kind === 'builtin' ? p.id : p.stableId}
            name={p.name}
            sub={p.description}
            selected={selectedId === (p.kind === 'builtin' ? p.id : p.stableId)}
            onSelect={onSelect}
            counts={p.kind === 'builtin' ? `${p.sourceCount}s · ${p.productCount}p` : undefined} />
        ))}
      </Section>
      {groups.builtinSource.length > 0 && (
        <Section title="By source">
          {groups.builtinSource.map((p) => (
            <ListItem key={p.kind === 'builtin' ? p.id : p.stableId}
              id={p.kind === 'builtin' ? p.id : p.stableId}
              name={p.name}
              sub={p.description}
              selected={selectedId === (p.kind === 'builtin' ? p.id : p.stableId)}
              onSelect={onSelect}
              counts={p.kind === 'builtin' ? `${p.sourceCount}s · ${p.productCount}p` : undefined} />
          ))}
        </Section>
      )}
      {groups.builtinProduct.length > 0 && (
        <Section title="By product">
          {groups.builtinProduct.map((p) => (
            <ListItem key={p.kind === 'builtin' ? p.id : p.stableId}
              id={p.kind === 'builtin' ? p.id : p.stableId}
              name={p.name}
              sub={p.description}
              selected={selectedId === (p.kind === 'builtin' ? p.id : p.stableId)}
              onSelect={onSelect}
              counts={p.kind === 'builtin' ? `${p.sourceCount}s · ${p.productCount}p` : undefined} />
          ))}
        </Section>
      )}
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
  pipeline, running, onRun, onEdit,
}: {
  pipeline: Pipeline;
  running: boolean;
  onRun: () => void;
  onEdit?: () => void;
}) {
  const triggers = pipeline.kind === 'custom' ? (pipeline as CustomPipeline & { kind: 'custom' }).triggers : [];
  return (
    <div className="border-b border-line bg-raised px-6 py-3 flex items-center gap-3">
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

// ─── Run history ────────────────────────────────────────────────────────────

function RunHistory({ runs, pipelineId }: { runs: RunRow[]; pipelineId: number | null }) {
  const filtered = pipelineId == null
    ? runs                                       // built-in selected → all recent runs
    : runs.filter((r) => r.pipeline_id === pipelineId);

  if (filtered.length === 0) {
    return (
      <div className="border-t border-line bg-raised px-6 py-3 text-[11px] text-muted">
        No runs yet.
      </div>
    );
  }
  return (
    <div className="border-t border-line bg-raised">
      <div className="px-6 py-2 flex items-baseline gap-2">
        <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">Recent runs</p>
      </div>
      <div className="px-6 pb-3 max-h-40 overflow-y-auto">
        {filtered.slice(0, 10).map((r) => {
          const Icon = r.status === 'succeeded' ? CheckCircle2
            : r.status === 'partial' || r.status === 'failed' ? AlertCircle
            : r.status === 'running' || r.status === 'queued' ? Loader2 : Clock;
          const color = r.status === 'succeeded' ? OBSERVATORY.ok
            : r.status === 'partial' ? OBSERVATORY.warn
            : r.status === 'failed' ? OBSERVATORY.err
            : OBSERVATORY.muted;
          return (
            <div key={r.id} className="flex items-center gap-2 py-1 text-[11.5px]">
              <Icon className={`w-3 h-3 ${r.status === 'running' || r.status === 'queued' ? 'animate-spin' : ''}`} style={{ color }} />
              <span className="font-mono text-ink-2">#{r.id}</span>
              <span className="text-muted-2">{r.triggered_by ?? '—'}</span>
              <span className="text-muted">·</span>
              <span style={{ color }}>{r.status}</span>
              {r.node_results && (
                <span className="text-muted ml-1">
                  {r.node_results.products?.length ?? 0}p
                  {r.node_results.sources?.length ? ` · ${r.node_results.sources.length}s` : ''}
                </span>
              )}
              <span className="ml-auto font-mono text-muted-2 text-[10px]">
                {formatRelative(r.queued_at)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Custom pipeline editor (modal) ─────────────────────────────────────────

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
  const [includeUpstream, setIncludeUpstream] = useState(existing?.scope.type === 'custom' ? !!existing.scope.includeUpstream : false);
  const [includeDownstream, setIncludeDownstream] = useState(existing?.scope.type === 'custom' ? !!existing.scope.includeDownstream : true);
  const [skipSourceSync, setSkipSourceSync] = useState(existing?.scope.type === 'custom' ? !!existing.scope.skipSourceSync : false);
  const [triggers, setTriggers] = useState<PipelineTrigger[]>(existing?.triggers ?? []);
  const [saving, setSaving] = useState(false);

  const toggleSource = (id: number) => {
    setPickedSources((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const toggleProduct = (id: number) => {
    setPickedProducts((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Pipeline needs a name'); return; }
    if (pickedSources.size === 0 && pickedProducts.size === 0) { toast.error('Pick at least one source or product'); return; }
    setSaving(true);
    try {
      const scope: PipelineScope = {
        type: 'custom',
        sourceIds: Array.from(pickedSources),
        productIds: Array.from(pickedProducts),
        includeUpstream, includeDownstream, skipSourceSync,
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
    <div className="fixed inset-0 z-30 bg-ink/40 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-raised border border-line rounded-lg shadow-xl w-full max-w-3xl max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-3 flex items-center justify-between">
          <h2 className="font-display text-[18px] text-ink">
            {existing ? 'Edit pipeline' : 'New pipeline'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-soft"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Name + description */}
          <div className="space-y-2">
            <label className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted block">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. EO daily refresh"
              className="w-full bg-soft border border-line rounded-md px-3 py-2 text-[13px] focus:outline-none focus:border-ocean"
            />
            <label className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted block mt-3">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — what does this pipeline do?"
              rows={2}
              className="w-full bg-soft border border-line rounded-md px-3 py-2 text-[13px] focus:outline-none focus:border-ocean"
            />
          </div>

          {/* Sources picker */}
          <div>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Sources</p>
            {dag.sources.length === 0 ? (
              <p className="text-[12px] text-muted italic">No sources connected yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {dag.sources.map((s) => (
                  <label key={s.id} className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded border cursor-pointer transition-colors',
                    pickedSources.has(s.id) ? 'bg-ocean-softer border-ocean' : 'bg-soft border-line hover:bg-softer',
                  )}>
                    <input
                      type="checkbox"
                      checked={pickedSources.has(s.id)}
                      onChange={() => toggleSource(s.id)}
                      className="w-3 h-3 accent-ocean"
                    />
                    <Database className="w-3 h-3 text-ocean shrink-0" />
                    <span className="text-[12.5px] text-ink truncate">{s.name}</span>
                    {s.connectorType && (
                      <span className="text-[10px] font-mono text-muted-2 ml-auto">{s.connectorType}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Products picker */}
          <div>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Products</p>
            {dag.products.length === 0 ? (
              <p className="text-[12px] text-muted italic">No products yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {dag.products.map((p) => (
                  <label key={p.id} className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded border cursor-pointer transition-colors',
                    pickedProducts.has(p.id) ? 'bg-ai-soft border-ai' : 'bg-soft border-line hover:bg-softer',
                  )}>
                    <input
                      type="checkbox"
                      checked={pickedProducts.has(p.id)}
                      onChange={() => toggleProduct(p.id)}
                      className="w-3 h-3 accent-ai"
                    />
                    <Boxes className="w-3 h-3 text-ai shrink-0" />
                    <span className="text-[12.5px] text-ink truncate">{p.name}</span>
                    <span className="text-[10px] font-mono text-muted-2 ml-auto">{p.status}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Expansion options */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Auto-expand</p>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
              <input type="checkbox" checked={includeUpstream} onChange={(e) => setIncludeUpstream(e.target.checked)} className="w-3 h-3 accent-ocean" />
              Include upstream products (run dependencies of picked products)
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
              <input type="checkbox" checked={includeDownstream} onChange={(e) => setIncludeDownstream(e.target.checked)} className="w-3 h-3 accent-ocean" />
              Include downstream products (run products that consume picked ones)
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
              <input type="checkbox" checked={skipSourceSync} onChange={(e) => setSkipSourceSync(e.target.checked)} className="w-3 h-3 accent-ocean" />
              Skip source sync (just run transformations on existing data)
            </label>
          </div>

          {/* Triggers */}
          <div>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Triggers</p>
            {triggers.length === 0 && (
              <p className="text-[12px] text-muted italic mb-2">Manual run only. Add a trigger below to run automatically.</p>
            )}
            {triggers.map((t, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5 px-2 py-1.5 bg-soft border border-line rounded">
                <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted">{t.kind === 'cron' ? 'cron' : t.kind === 'on_pipeline_complete' ? 'after pipeline' : 'after sync'}</span>
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
                      className="w-32 bg-raised border border-line rounded px-2 py-1 text-[12px] font-mono"
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
              ><Plus className="w-3 h-3" /> Cron schedule</button>
              {dag.sources.length > 0 && (
                <button
                  onClick={() => setTriggers([...triggers, { kind: 'on_source_sync_succeeded', sourceId: dag.sources[0].id }])}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-ink-2 border border-line rounded hover:bg-softer"
                ><Plus className="w-3 h-3" /> When a source finishes syncing</button>
              )}
            </div>
            <p className="text-[10.5px] text-muted-2 mt-2">
              Cron firing + sync-chained triggers will activate in the next release. Manual run works today.
            </p>
          </div>
        </div>

        <div className="border-t border-line px-5 py-3 flex justify-end gap-2">
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
}

function RunActivityDock({
  jobId, pipelineRunId: _runId, pipelineName, scopeHint, dag, onDismiss, onCompleted,
}: {
  jobId: string;
  pipelineRunId: number;
  pipelineName: string;
  scopeHint: { sourceIds: Set<number>; productIds: Set<number> };
  dag: Dag | null;
  onDismiss: () => void;
  onCompleted: () => void;
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

  // SSE attach
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
                onCompleted();
              } else if (t === 'failed') {
                setDone(true); setAllOk(false);
                setLog((l) => [...l, { kind: 'error', text: `Error: ${ev.error}` }]);
                onCompleted();
              }
            } catch { /* skip malformed */ }
          }
          if (d) break;
        }
      } catch { /* aborted */ }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [jobId, updateNodeByName, onCompleted]);

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
  const [showErrors, setShowErrors] = useState(false);
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

  return (
    <div className="border-b border-line/60">
      <div className="px-3 py-1.5 flex items-center gap-2">
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
          <button
            onClick={() => setShowErrors(!showErrors)}
            className="text-[10px] font-mono uppercase tracking-[0.08em]"
            style={{ color: OBSERVATORY.err }}
          >
            {showErrors ? 'hide' : `${node.errors!.length} ✗`}
          </button>
        )}
      </div>
      {showErrors && hasErrors && (
        <div className="px-3 pb-2 space-y-1">
          {node.errors!.map((err, i) => (
            <div key={i} className="px-2 py-1 text-[11px] font-mono rounded" style={{ background: OBSERVATORY.errSoft, color: OBSERVATORY.ink2 }}>
              {err}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * Pipelines — orchestrated DAG view of every data product.
 *
 * - Top-level DAG: products as nodes, dependencies as edges.
 * - Status colors: success (green), running (blue/pulse), error (red),
 *   stale (amber), never_run (grey).
 * - Click a product → side panel: tables grouped by role, upstream/downstream,
 *   schedule editor, per-product run button.
 * - Toolbar: "Run all" / "Run stale" trigger /api/pipelines/run.
 * - Polls every 4 s while any product is running.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls,
  useNodesState, useEdgesState,
  NodeProps, Handle, Position,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import { Play, RefreshCw, Calendar, AlertCircle, CheckCircle2, Clock, X, Database, ArrowRight } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { OBSERVATORY } from '@/lib/observatory';
import SchedulePanel from '@/components/SchedulePanel';
import RequireRole from '@/components/RequireRole';
import { formatRelative } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ProductStatus = 'success' | 'running' | 'error' | 'stale' | 'never_run';

interface Product {
  id: number;
  name: string;
  status: ProductStatus;
  last_run_at: string | null;
  connection_id: number | null;
  table_counts: { total: number; success: number; running: number; error: number; draft: number };
  schedule: { cron_expression: string; timezone: string | null; enabled: boolean } | null;
}

interface ProductEdge { source: number; target: number }
interface PipelineTable {
  id: number;
  product_id: number | null;
  star_schema_id: number;
  table_name: string;
  display_name: string | null;
  table_role: string | null;
  dag_order: number | null;
  transformation_status: string | null;
  last_run_at: string | null;
  last_run_error: string | null;
  row_count: number | null;
}
interface TableEdge { source: number; target: number; relationship_type: string }

interface PipelineData {
  products: Product[];
  productEdges: ProductEdge[];
  tables: PipelineTable[];
  tableEdges: TableEdge[];
}

// ---------------------------------------------------------------------------
// Stuck-run detection — a worker may die mid-run and leave product_tables
// rows pinned to transformation_status='running'. Anything still "running"
// with no last_run_at, or last_run_at older than this threshold, is treated
// as orphaned. We surface it as "stuck" rather than continuing the live
// shimmer + polling loop.
// ---------------------------------------------------------------------------
const STUCK_AFTER_MS = 5 * 60 * 1000; // 5 minutes

function isTableStuck(t: PipelineTable, isPendingProduct: boolean): boolean {
  if (isPendingProduct) return false; // we just optimistically marked it; trust the user
  if ((t.transformation_status ?? '').toLowerCase() !== 'running') return false;
  if (!t.last_run_at) return true;
  const age = Date.now() - new Date(t.last_run_at).getTime();
  return age > STUCK_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Status palette (Observatory)
// ---------------------------------------------------------------------------
const STATUS_STYLES: Record<ProductStatus, { bg: string; border: string; text: string; dot: string; label: string }> = {
  success:   { bg: OBSERVATORY.okSoft,   border: OBSERVATORY.ok,    text: OBSERVATORY.ok,    dot: OBSERVATORY.ok,    label: 'Up to date' },
  running:   { bg: OBSERVATORY.oceanSoft,border: OBSERVATORY.ocean, text: OBSERVATORY.ocean, dot: OBSERVATORY.ocean, label: 'Running' },
  error:     { bg: OBSERVATORY.errSoft,  border: OBSERVATORY.err,   text: OBSERVATORY.err,   dot: OBSERVATORY.err,   label: 'Failed' },
  stale:     { bg: OBSERVATORY.warnSoft, border: OBSERVATORY.warn,  text: OBSERVATORY.warn,  dot: OBSERVATORY.warn,  label: 'Stale' },
  never_run: { bg: OBSERVATORY.softer,   border: OBSERVATORY.line,  text: OBSERVATORY.muted, dot: OBSERVATORY.muted2,label: 'Never run' },
};

// ---------------------------------------------------------------------------
// ReactFlow custom node — product card with inline table list
// ---------------------------------------------------------------------------
const NODE_W = 280;
const HEADER_H = 36;
const STATUS_ROW_H = 26;
const GROUP_LABEL_H = 18;
const TABLE_ROW_H = 22;
const FOOTER_H = 30;
const PADDING_Y = 14;

interface NodeData {
  product: Product;
  tables: PipelineTable[];
  selected: boolean;
  running: boolean;
  refreshOrder: number | null; // 1-indexed position in current run
  isPendingProduct: boolean;   // user just clicked Run on this product
  onClick: (id: number) => void;
  onRun: (id: number) => void;
}

function nodeHeight(tables: PipelineTable[]) {
  const dims = tables.filter((t) => t.table_role === 'dimension').length;
  const facts = tables.filter((t) => t.table_role === 'fact').length;
  const others = tables.filter((t) => t.table_role !== 'dimension' && t.table_role !== 'fact').length;
  let h = HEADER_H + STATUS_ROW_H + PADDING_Y + FOOTER_H;
  if (dims > 0)   h += GROUP_LABEL_H + dims * TABLE_ROW_H;
  if (facts > 0)  h += GROUP_LABEL_H + facts * TABLE_ROW_H;
  if (others > 0) h += GROUP_LABEL_H + others * TABLE_ROW_H;
  if (tables.length === 0) h += 22; // "no tables" placeholder
  return h;
}

function ProductNode({ data }: NodeProps<NodeData>) {
  const { product, tables, selected, running, refreshOrder, isPendingProduct } = data;
  const s = STATUS_STYLES[product.status];
  const dims = tables.filter((t) => t.table_role === 'dimension').sort((a, b) => (a.dag_order ?? 0) - (b.dag_order ?? 0));
  const facts = tables.filter((t) => t.table_role === 'fact').sort((a, b) => (a.dag_order ?? 0) - (b.dag_order ?? 0));
  const others = tables.filter((t) => t.table_role !== 'dimension' && t.table_role !== 'fact');

  // A product is genuinely running only if it has live (non-stuck) running tables
  // OR the user just clicked Run on it (pending). Otherwise, "running" is just a
  // stale flag from an orphaned worker — don't pulse the card.
  const tablesDone = tables.filter((t) => (t.transformation_status ?? '').toLowerCase() === 'success').length;
  const tablesRunningRaw = tables.filter((t) => (t.transformation_status ?? '').toLowerCase() === 'running');
  const tablesRunningLive = tablesRunningRaw.filter((t) => !isTableStuck(t, isPendingProduct));
  const tablesStuck = tablesRunningRaw.length - tablesRunningLive.length;
  const isRunning = product.status === 'running' && (tablesRunningLive.length > 0 || isPendingProduct);
  const progressPct = tables.length > 0 ? Math.round((tablesDone / tables.length) * 100) : 0;

  return (
    <div
      onClick={() => data.onClick(product.id)}
      className={`cursor-pointer rounded-md transition-shadow group relative overflow-hidden ${isRunning ? 'pipeline-card-running' : ''}`}
      style={{
        width: NODE_W,
        background: OBSERVATORY.raised,
        border: `1.5px solid ${selected ? OBSERVATORY.ocean : s.border}`,
        boxShadow: !isRunning && selected
          ? `0 0 0 3px ${OBSERVATORY.oceanSoft}, 0 4px 12px rgba(15,26,34,0.06)`
          : !isRunning ? '0 1px 2px rgba(15,26,34,0.04)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: OBSERVATORY.line, width: 7, height: 7, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: OBSERVATORY.line, width: 7, height: 7, border: 'none' }} />

      {/* Running progress strip across the top of the card */}
      {isRunning && (
        <div
          className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: OBSERVATORY.oceanSofter }}
        >
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${progressPct}%`, background: OBSERVATORY.ocean }}
          />
        </div>
      )}

      {/* Header */}
      <div
        className="px-3 flex items-center gap-2 border-b"
        style={{ borderColor: OBSERVATORY.softer, height: HEADER_H }}
      >
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${product.status === 'running' ? 'animate-pulse' : ''}`}
          style={{ background: s.dot }}
        />
        <span className="text-[13px] font-medium truncate flex-1" style={{ color: OBSERVATORY.ink }}>
          {product.name}
        </span>
        {refreshOrder != null && (
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: OBSERVATORY.oceanSoft, color: OBSERVATORY.ocean }}
            title="Position in refresh order"
          >
            #{refreshOrder}
          </span>
        )}
        {product.schedule?.enabled && (
          <Calendar size={12} style={{ color: OBSERVATORY.muted2 }} />
        )}
        <button
          onClick={(e) => { e.stopPropagation(); data.onRun(product.id); }}
          disabled={running}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-soft disabled:opacity-50"
          title="Refresh this product (and upstream)"
        >
          {running ? <Spinner /> : <Play size={11} style={{ color: OBSERVATORY.ocean }} />}
        </button>
      </div>

      {/* Status row */}
      <div
        className="px-3 flex items-center gap-1.5"
        style={{ height: STATUS_ROW_H }}
      >
        <span
          className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ background: s.bg, color: s.text }}
        >
          {s.label}
        </span>
        {isRunning ? (
          <span className="text-[10px] font-mono tabular-nums" style={{ color: OBSERVATORY.ocean }}>
            {tablesDone}/{tables.length} done{tablesRunningLive.length > 0 && ` · ${tablesRunningLive.length} live`}
          </span>
        ) : tablesStuck > 0 ? (
          <span className="text-[10px] font-mono" style={{ color: OBSERVATORY.warn }} title="Worker likely died mid-run. Click Run to retry.">
            {tablesStuck} stuck
          </span>
        ) : (
          <span className="text-[10px]" style={{ color: OBSERVATORY.muted }}>
            {tables.length} {tables.length === 1 ? 'table' : 'tables'}
          </span>
        )}
      </div>

      {/* Tables list */}
      <div className="px-2 pb-1">
        {tables.length === 0 && (
          <div className="text-[10px] italic px-1 py-1" style={{ color: OBSERVATORY.muted2 }}>
            No tables defined
          </div>
        )}
        {dims.length > 0 && <NodeTableGroup label="Dimensions" tables={dims} step={1} isPendingProduct={isPendingProduct} />}
        {facts.length > 0 && <NodeTableGroup label="Facts" tables={facts} step={2} isPendingProduct={isPendingProduct} />}
        {others.length > 0 && <NodeTableGroup label="Other" tables={others} step={3} isPendingProduct={isPendingProduct} />}
      </div>

      {/* Footer */}
      <div
        className="px-3 flex items-center justify-between border-t text-[10px]"
        style={{ borderColor: OBSERVATORY.softer, color: OBSERVATORY.muted, height: FOOTER_H }}
      >
        <span>
          {product.last_run_at ? `last run ${formatRelative(product.last_run_at)}` : 'not yet run'}
        </span>
        {product.schedule?.enabled && product.schedule.cron_expression && (
          <span className="font-mono" title={`${product.schedule.cron_expression} ${product.schedule.timezone ?? ''}`}>
            scheduled
          </span>
        )}
      </div>
    </div>
  );
}

function NodeTableGroup({ label, tables, step, isPendingProduct }: { label: string; tables: PipelineTable[]; step: number; isPendingProduct: boolean }) {
  return (
    <div className="mt-1">
      <div
        className="flex items-center gap-1 px-1"
        style={{ height: GROUP_LABEL_H, color: OBSERVATORY.muted2 }}
      >
        <span className="font-mono text-[9px]">[{step}]</span>
        <span className="text-[9px] uppercase tracking-wider">{label}</span>
      </div>
      {tables.map((t) => <NodeTableRow key={t.id} table={t} isPendingProduct={isPendingProduct} />)}
    </div>
  );
}

function NodeTableRow({ table, isPendingProduct }: { table: PipelineTable; isPendingProduct: boolean }) {
  const status = (table.transformation_status ?? 'draft').toLowerCase();
  const stuck = isTableStuck(table, isPendingProduct);
  const isLive = status === 'running' && !stuck;
  const isError = status === 'error';

  const cfg =
    status === 'success' ? { color: OBSERVATORY.ok,    pulse: false } :
    isLive               ? { color: OBSERVATORY.ocean, pulse: true } :
    stuck                ? { color: OBSERVATORY.warn,  pulse: false } :
    isError              ? { color: OBSERVATORY.err,   pulse: false } :
                           { color: OBSERVATORY.muted2,pulse: false };

  return (
    <div
      className={`flex items-center gap-1.5 px-1 rounded ${isLive ? 'pipeline-row-running' : ''}`}
      style={{
        height: TABLE_ROW_H,
        background: isError ? 'rgba(196, 60, 60, 0.06)' : undefined,
      }}
      title={isError && table.last_run_error ? table.last_run_error : stuck ? 'Stuck — worker likely died. Run again to retry.' : table.table_name}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.pulse ? 'animate-pulse' : ''}`}
        style={{ background: cfg.color }}
      />
      <span
        className="text-[11px] font-mono truncate flex-1"
        style={{
          color: isLive ? OBSERVATORY.ocean : isError ? OBSERVATORY.err : stuck ? OBSERVATORY.warn : OBSERVATORY.ink2,
          fontWeight: isLive || isError ? 500 : 400,
        }}
      >
        {table.table_name}
      </span>
      {isLive && (
        <span className="text-[9px] uppercase tracking-wider font-mono" style={{ color: OBSERVATORY.ocean }}>
          live
        </span>
      )}
      {stuck && (
        <span className="text-[9px] uppercase tracking-wider font-mono" style={{ color: OBSERVATORY.warn }}>
          stuck
        </span>
      )}
      {isError && (
        <AlertCircle size={10} style={{ color: OBSERVATORY.err }} />
      )}
      {!isLive && !stuck && !isError && table.row_count != null && table.row_count > 0 && (
        <span
          className="text-[9px] tabular-nums"
          style={{ color: OBSERVATORY.muted2 }}
        >
          {formatRowCount(table.row_count)}
        </span>
      )}
    </div>
  );
}

function formatRowCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const nodeTypes = { product: ProductNode };

// ---------------------------------------------------------------------------
// Dagre layout — height varies per product based on table count
// ---------------------------------------------------------------------------
function layout(
  products: Product[],
  edges: ProductEdge[],
  tablesByProduct: Map<number, PipelineTable[]>,
) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 100, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const heights = new Map<number, number>();
  for (const p of products) {
    const h = nodeHeight(tablesByProduct.get(p.id) ?? []);
    heights.set(p.id, h);
    g.setNode(String(p.id), { width: NODE_W, height: h });
  }
  for (const e of edges) g.setEdge(String(e.source), String(e.target));
  dagre.layout(g);
  const positions = new Map<number, { x: number; y: number }>();
  for (const p of products) {
    const n = g.node(String(p.id));
    if (n) {
      const h = heights.get(p.id) ?? 100;
      positions.set(p.id, { x: n.x - NODE_W / 2, y: n.y - h / 2 });
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
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
  const [rawData, setRawData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [running, setRunning] = useState<{ all: boolean; stale: boolean; product: number | null }>({ all: false, stale: false, product: null });
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Optimistic run state: when the user clicks Run, we capture each product's
  // last_run_at at click time. Until the backend reports a NEWER last_run_at
  // (run finished) OR transitions the product into 'running' (run started),
  // we display the product as running locally so the UI feels instant.
  // Maps productId → previous last_run_at (null if never run).
  const [pendingRuns, setPendingRuns] = useState<Map<number, string | null>>(new Map());

  const onNodeClick = useCallback((id: number) => setSelectedId(id), []);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const res = await api.get('/pipelines');
      setRawData(res.data.data as PipelineData);
    } catch {
      toast.error('Failed to load pipelines');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile pendingRuns with raw data: drop products that the backend has
  // already moved past their pre-run state (status === running OR last_run_at
  // bumped OR status === error post-trigger).
  useEffect(() => {
    if (!rawData || pendingRuns.size === 0) return;
    const next = new Map(pendingRuns);
    let changed = false;
    pendingRuns.forEach((prevRunAt, pid) => {
      const p = rawData.products.find((x) => x.id === pid);
      if (!p) { next.delete(pid); changed = true; return; }
      // Backend caught up if it now shows running, or if last_run_at bumped, or status flipped to error AFTER our trigger.
      if (p.status === 'running') { next.delete(pid); changed = true; return; }
      if (p.last_run_at !== prevRunAt) { next.delete(pid); changed = true; return; }
    });
    if (changed) setPendingRuns(next);
  }, [rawData, pendingRuns]);

  // Hard safety: clear any pending entries that have lingered > 30s without
  // the backend catching up (worker stuck, Redis down, etc.).
  useEffect(() => {
    if (pendingRuns.size === 0) return;
    const t = setTimeout(() => setPendingRuns(new Map()), 30000);
    return () => clearTimeout(t);
  }, [pendingRuns]);

  // Apply optimistic state on top of raw data. Pending products are forced to
  // 'running'; their tables flip to 'running' too so the per-row shimmer fires.
  const data = useMemo<PipelineData | null>(() => {
    if (!rawData) return null;
    if (pendingRuns.size === 0) return rawData;
    const pending = pendingRuns;
    return {
      ...rawData,
      products: rawData.products.map((p) =>
        pending.has(p.id) && p.status !== 'running'
          ? { ...p, status: 'running' as ProductStatus,
              table_counts: { ...p.table_counts, running: Math.max(p.table_counts.running, 1) } }
          : p,
      ),
      tables: rawData.tables.map((t) => {
        if (t.product_id != null && pending.has(t.product_id)) {
          const cur = (t.transformation_status ?? '').toLowerCase();
          if (cur !== 'running' && cur !== 'success') {
            return { ...t, transformation_status: 'running' };
          }
        }
        return t;
      }),
    };
  }, [rawData, pendingRuns]);

  // Poll fast when running OR when pending — pending means the backend hasn't
  // confirmed yet and we want to catch the transition quickly. Stuck-only
  // running products (worker died, status pinned to 'running') do NOT count —
  // otherwise we'd poll forever waiting for a worker that's never coming back.
  const anyRunning = useMemo(() => {
    if (pendingRuns.size > 0) return true;
    if (!data) return false;
    return data.products.some((p) => {
      if (p.status !== 'running') return false;
      const ptables = data.tables.filter((t) => t.product_id === p.id);
      const isPending = pendingRuns.has(p.id);
      return ptables.some(
        (t) => (t.transformation_status ?? '').toLowerCase() === 'running' && !isTableStuck(t, isPending),
      );
    });
  }, [data, pendingRuns]);
  useEffect(() => {
    if (!anyRunning) return;
    // 800 ms while there are unconfirmed pending runs; 1.8 s once confirmed running.
    const interval = pendingRuns.size > 0 ? 800 : 1800;
    pollRef.current = setTimeout(() => load(true), interval);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [anyRunning, data, pendingRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build ReactFlow nodes/edges
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  // Refresh-order indicator: when products are running, number them by topo
  // position so users can see "this one runs first, that one after".
  const refreshOrderMap = useMemo(() => {
    if (!data) return new Map<number, number>();
    const runningIds = new Set(data.products.filter((p) => p.status === 'running').map((p) => p.id));
    if (runningIds.size === 0) return new Map<number, number>();
    // Topo sort just the running set's ancestors-then-self order via productEdges.
    const inDeg = new Map<number, number>();
    const adj = new Map<number, number[]>();
    runningIds.forEach((id) => { inDeg.set(id, 0); adj.set(id, []); });
    for (const e of data.productEdges) {
      if (runningIds.has(e.source) && runningIds.has(e.target)) {
        adj.get(e.source)!.push(e.target);
        inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
      }
    }
    const ready = Array.from(runningIds).filter((id) => (inDeg.get(id) ?? 0) === 0);
    const order: number[] = [];
    while (ready.length > 0) {
      const next = ready.shift()!;
      order.push(next);
      for (const child of adj.get(next) ?? []) {
        const d = (inDeg.get(child) ?? 0) - 1;
        inDeg.set(child, d);
        if (d === 0) ready.push(child);
      }
    }
    runningIds.forEach((id) => { if (!order.includes(id)) order.push(id); });
    const m = new Map<number, number>();
    order.forEach((id, i) => m.set(id, i + 1));
    return m;
  }, [data]);

  const tablesByProduct = useMemo(() => {
    const m = new Map<number, PipelineTable[]>();
    if (!data) return m;
    for (const t of data.tables) {
      if (t.product_id == null) continue;
      const arr = m.get(t.product_id) ?? [];
      arr.push(t);
      m.set(t.product_id, arr);
    }
    return m;
  }, [data]);

  const onRunOne = useCallback(
    (id: number) => { runScope({ productIds: [id] }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!data) return;
    const positions = layout(data.products, data.productEdges, tablesByProduct);
    setRfNodes(
      data.products.map((p) => ({
        id: String(p.id),
        type: 'product',
        position: positions.get(p.id) ?? { x: 0, y: 0 },
        data: {
          product: p,
          tables: tablesByProduct.get(p.id) ?? [],
          selected: selectedId === p.id,
          running: running.product === p.id,
          refreshOrder: refreshOrderMap.get(p.id) ?? null,
          isPendingProduct: pendingRuns.has(p.id),
          onClick: onNodeClick,
          onRun: onRunOne,
        } as NodeData,
        draggable: false,
      })),
    );
    setRfEdges(
      data.productEdges.map((e, i) => {
        const sourceRunning = data.products.some((p) => p.id === e.source && p.status === 'running');
        const targetRunning = data.products.some((p) => p.id === e.target && p.status === 'running');
        const live = sourceRunning || targetRunning;
        return {
          id: `e-${e.source}-${e.target}-${i}`,
          source: String(e.source),
          target: String(e.target),
          type: 'smoothstep',
          animated: live,
          style: {
            stroke: live ? OBSERVATORY.ocean : OBSERVATORY.lineStrong,
            strokeWidth: live ? 2 : 1.5,
          },
        };
      }),
    );
  }, [data, selectedId, running.product, refreshOrderMap, tablesByProduct, pendingRuns, onNodeClick, onRunOne, setRfNodes, setRfEdges]);

  async function runScope(scope: 'all' | 'stale' | { productIds: number[] }) {
    const key = scope === 'all' ? 'all' : scope === 'stale' ? 'stale' : 'product';
    setRunning((r) => ({ ...r, [key]: scope === 'all' || scope === 'stale' ? true : (scope.productIds[0] ?? null) }));
    try {
      const res = await api.post('/pipelines/run', { scope });
      const order: number[] = res.data.data?.order ?? [];
      if (order.length === 0) {
        toast.info('Nothing to run');
      } else {
        toast.success(`Enqueued ${order.length} product${order.length === 1 ? '' : 's'}`);
        // Optimistically mark each enqueued product as running until the backend confirms.
        // Capture the pre-run last_run_at so we can detect when the backend catches up.
        setPendingRuns((prev) => {
          const next = new Map(prev);
          for (const pid of order) {
            const p = rawData?.products.find((x) => x.id === pid);
            next.set(pid, p?.last_run_at ?? null);
          }
          return next;
        });
      }
      await load(true);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      toast.error(msg ?? 'Failed to start pipeline run');
    } finally {
      setRunning({ all: false, stale: false, product: null });
    }
  }

  const selectedProduct = useMemo(
    () => data?.products.find((p) => p.id === selectedId) ?? null,
    [data, selectedId],
  );

  const counts = useMemo(() => {
    if (!data) return { total: 0, success: 0, running: 0, stale: 0, error: 0, never: 0 };
    return data.products.reduce((acc, p) => {
      acc.total++;
      if (p.status === 'success')   acc.success++;
      if (p.status === 'running')   acc.running++;
      if (p.status === 'stale')     acc.stale++;
      if (p.status === 'error')     acc.error++;
      if (p.status === 'never_run') acc.never++;
      return acc;
    }, { total: 0, success: 0, running: 0, stale: 0, error: 0, never: 0 });
  }, [data]);

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Toolbar */}
      <div className="px-6 py-4 border-b border-line bg-raised flex items-center gap-4 relative">
        {/* Global running progress strip */}
        {anyRunning && <GlobalRunStrip data={data!} />}

        <div className="flex-1">
          <h1 className="font-serif text-[22px] leading-tight text-ink flex items-center gap-2">
            Pipelines
            {anyRunning && (
              <span
                className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: OBSERVATORY.oceanSoft, color: OBSERVATORY.ocean }}
              >
                <span
                  className="pipeline-live-dot inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: OBSERVATORY.ocean }}
                />
                Live
              </span>
            )}
          </h1>
          <p className="text-xs text-muted mt-0.5">
            Refresh data products in dependency order — dimensions before facts, upstream before downstream.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <PipelineCounts counts={counts} />

          <button
            onClick={() => load()}
            className="px-2.5 py-1.5 text-xs rounded-md border border-line bg-raised text-ink-2 hover:bg-soft transition-colors flex items-center gap-1.5"
            title="Reload"
          >
            <RefreshCw size={12} />
          </button>

          <button
            onClick={() => runScope('stale')}
            disabled={running.stale || running.all || counts.stale + counts.error + counts.never === 0}
            className="px-3 py-1.5 text-xs rounded-md border border-line bg-raised text-ink-2 hover:bg-soft transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {running.stale ? <Spinner /> : <RefreshCw size={12} />}
            Run stale
          </button>

          <button
            onClick={() => runScope('all')}
            disabled={running.all || running.stale || counts.total === 0}
            className="px-3 py-1.5 text-xs rounded-md bg-ocean text-white hover:bg-ocean-hover transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {running.all ? <Spinner light /> : <Play size={12} />}
            Run all
          </button>
        </div>
      </div>

      {/* Live activity strip — concrete per-product / per-table breakdown */}
      {anyRunning && data && (
        <LiveActivityStrip
          data={data}
          tablesByProduct={tablesByProduct}
          refreshOrderMap={refreshOrderMap}
          pendingIds={pendingRuns}
        />
      )}

      {/* Failure / stuck summary — surfaces WHICH tables failed and WHY */}
      {data && (
        <FailureSummary
          data={data}
          pendingIds={pendingRuns}
          onJumpToProduct={(id) => setSelectedId(id)}
          onRetryProduct={(id) => runScope({ productIds: [id] })}
        />
      )}

      {/* Content: DAG + side panel */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative" style={{ background: OBSERVATORY.bg }}>
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
              Loading pipeline graph…
            </div>
          ) : !data || data.products.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center max-w-sm">
                <Database size={28} className="mx-auto mb-3 text-muted2" />
                <p className="text-sm text-ink-2 mb-1">No data products yet</p>
                <p className="text-xs text-muted">
                  Create a data product first — it will appear here once defined.
                </p>
              </div>
            </div>
          ) : (
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
              elementsSelectable={false}
            >
              <Background color={OBSERVATORY.line} gap={20} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        {selectedProduct && data && (
          <SidePanel
            product={selectedProduct}
            allProducts={data.products}
            tables={data.tables.filter((t) => t.product_id === selectedProduct.id)}
            productEdges={data.productEdges}
            onClose={() => setSelectedId(null)}
            onRun={() => runScope({ productIds: [selectedProduct.id] })}
            running={running.product === selectedProduct.id}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global run strip — shows progress under the toolbar while anything runs
// ---------------------------------------------------------------------------
function GlobalRunStrip({ data }: { data: PipelineData }) {
  const totalTables = data.tables.length;
  const doneTables = data.tables.filter(
    (t) => (t.transformation_status ?? '').toLowerCase() === 'success',
  ).length;
  const runningTables = data.tables.filter(
    (t) => (t.transformation_status ?? '').toLowerCase() === 'running',
  ).length;
  const pct = totalTables > 0 ? (doneTables / totalTables) * 100 : 0;
  return (
    <div
      className="absolute left-0 right-0 bottom-0 h-[3px] overflow-hidden"
      style={{ background: OBSERVATORY.oceanSofter }}
      title={`${doneTables} of ${totalTables} tables done · ${runningTables} running now`}
    >
      <div
        className="h-full transition-all duration-500"
        style={{ width: `${pct}%`, background: OBSERVATORY.ocean }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failure summary — collapsible banner showing every failed or stuck table
// across all products with the actual error message. Answers "what failed
// and why?" without needing to open the side panel for each product.
// ---------------------------------------------------------------------------
function FailureSummary({
  data, pendingIds, onJumpToProduct, onRetryProduct,
}: {
  data: PipelineData;
  pendingIds: Map<number, string | null>;
  onJumpToProduct: (id: number) => void;
  onRetryProduct: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const productById = useMemo(() => new Map(data.products.map((p) => [p.id, p])), [data.products]);

  // Group failed + stuck tables by product
  const failuresByProduct = useMemo(() => {
    const m = new Map<number, { failed: PipelineTable[]; stuck: PipelineTable[] }>();
    for (const t of data.tables) {
      if (t.product_id == null) continue;
      const status = (t.transformation_status ?? '').toLowerCase();
      const isPending = pendingIds.has(t.product_id);
      const stuck = isTableStuck(t, isPending);
      if (status === 'error' || stuck) {
        const entry = m.get(t.product_id) ?? { failed: [], stuck: [] };
        if (stuck) entry.stuck.push(t);
        else entry.failed.push(t);
        m.set(t.product_id, entry);
      }
    }
    return m;
  }, [data.tables, pendingIds]);

  if (failuresByProduct.size === 0) return null;

  const totalFailed = Array.from(failuresByProduct.values()).reduce((sum, x) => sum + x.failed.length, 0);
  const totalStuck = Array.from(failuresByProduct.values()).reduce((sum, x) => sum + x.stuck.length, 0);

  return (
    <div
      className="border-b"
      style={{ background: OBSERVATORY.errSoft, borderColor: 'rgba(196, 60, 60, 0.2)' }}
    >
      {/* Header row — click to expand/collapse */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-2.5 flex items-center gap-3 text-left hover:bg-black/[0.02] transition-colors"
      >
        <AlertCircle size={14} style={{ color: OBSERVATORY.err }} />
        <span className="text-[13px] font-medium" style={{ color: OBSERVATORY.err }}>
          {totalFailed > 0 && `${totalFailed} table${totalFailed === 1 ? '' : 's'} failed`}
          {totalFailed > 0 && totalStuck > 0 && ' · '}
          {totalStuck > 0 && (
            <span style={{ color: OBSERVATORY.warn }}>
              {totalStuck} stuck
            </span>
          )}
        </span>
        <span className="text-[11px]" style={{ color: OBSERVATORY.muted }}>
          across {failuresByProduct.size} product{failuresByProduct.size === 1 ? '' : 's'}
        </span>
        <span className="ml-auto text-[10px] font-mono uppercase tracking-wider" style={{ color: OBSERVATORY.muted2 }}>
          {expanded ? 'hide' : 'show details'}
        </span>
      </button>

      {/* Expanded list */}
      {expanded && (
        <div className="px-6 pb-3 space-y-2">
          {Array.from(failuresByProduct.entries()).map(([pid, entry]) => {
            const product = productById.get(pid);
            if (!product) return null;
            return (
              <div
                key={pid}
                className="rounded-md border bg-white p-2.5"
                style={{ borderColor: 'rgba(196, 60, 60, 0.2)' }}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: OBSERVATORY.err }}
                  />
                  <button
                    onClick={() => onJumpToProduct(pid)}
                    className="text-[12px] font-medium hover:underline"
                    style={{ color: OBSERVATORY.ink }}
                  >
                    {product.name}
                  </button>
                  <span className="text-[10px]" style={{ color: OBSERVATORY.muted }}>
                    {entry.failed.length > 0 && `${entry.failed.length} failed`}
                    {entry.failed.length > 0 && entry.stuck.length > 0 && ' · '}
                    {entry.stuck.length > 0 && (
                      <span style={{ color: OBSERVATORY.warn }}>{entry.stuck.length} stuck</span>
                    )}
                  </span>
                  <button
                    onClick={() => onRetryProduct(pid)}
                    className="ml-auto px-2 py-0.5 text-[10px] rounded border flex items-center gap-1 hover:bg-soft"
                    style={{ borderColor: OBSERVATORY.line, color: OBSERVATORY.ocean }}
                    title="Retry this product (and upstream)"
                  >
                    <Play size={9} /> Retry
                  </button>
                </div>

                {entry.failed.map((t) => (
                  <div
                    key={t.id}
                    className="pl-3.5 py-1 border-l-2 mt-1"
                    style={{ borderColor: OBSERVATORY.err }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px]" style={{ color: OBSERVATORY.err }}>
                        {t.table_name}
                      </span>
                      {t.last_run_at && (
                        <span className="text-[10px]" style={{ color: OBSERVATORY.muted2 }}>
                          {formatRelative(t.last_run_at)}
                        </span>
                      )}
                    </div>
                    {t.last_run_error ? (
                      <div className="mt-0.5 text-[11px] font-mono whitespace-pre-wrap break-words" style={{ color: OBSERVATORY.ink2 }}>
                        {t.last_run_error}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-[11px] italic" style={{ color: OBSERVATORY.muted }}>
                        (no error message recorded)
                      </div>
                    )}
                  </div>
                ))}

                {entry.stuck.map((t) => (
                  <div
                    key={t.id}
                    className="pl-3.5 py-1 border-l-2 mt-1"
                    style={{ borderColor: OBSERVATORY.warn }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px]" style={{ color: OBSERVATORY.warn }}>
                        {t.table_name}
                      </span>
                      <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: OBSERVATORY.warn }}>
                        stuck
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px]" style={{ color: OBSERVATORY.ink2 }}>
                      Pinned to <span className="font-mono">running</span>
                      {t.last_run_at && <> since {formatRelative(t.last_run_at)}</>}
                      {' '}— worker likely died mid-run. Click Retry to re-run.
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live activity strip — full-width "what's happening right now" panel.
// Lists each running/pending product, shows its progress (X/Y tables), and
// the table currently being transformed.
// ---------------------------------------------------------------------------
function LiveActivityStrip({
  data, tablesByProduct, refreshOrderMap, pendingIds,
}: {
  data: PipelineData;
  tablesByProduct: Map<number, PipelineTable[]>;
  refreshOrderMap: Map<number, number>;
  pendingIds: Map<number, string | null>;
}) {
  const runningProducts = data.products
    .filter((p) => p.status === 'running')
    .sort((a, b) => (refreshOrderMap.get(a.id) ?? 999) - (refreshOrderMap.get(b.id) ?? 999));
  if (runningProducts.length === 0) return null;

  return (
    <div
      className="px-6 py-2.5 border-b flex items-center gap-3 overflow-x-auto"
      style={{ background: OBSERVATORY.oceanSofter, borderColor: OBSERVATORY.oceanSoft }}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className="pipeline-live-dot inline-block w-2 h-2 rounded-full"
          style={{ background: OBSERVATORY.ocean }}
        />
        <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: OBSERVATORY.ocean }}>
          Live · {runningProducts.length} {runningProducts.length === 1 ? 'product' : 'products'}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {runningProducts.map((p) => {
          const tables = tablesByProduct.get(p.id) ?? [];
          const done = tables.filter((t) => (t.transformation_status ?? '').toLowerCase() === 'success').length;
          const failed = tables.filter((t) => (t.transformation_status ?? '').toLowerCase() === 'error').length;
          const liveTable = tables.find((t) => (t.transformation_status ?? '').toLowerCase() === 'running');
          const pending = pendingIds.has(p.id) && !liveTable && done === 0 && failed === 0;
          const order = refreshOrderMap.get(p.id);
          return (
            <div
              key={p.id}
              className="flex items-center gap-2 px-2.5 py-1 rounded-md border bg-white"
              style={{ borderColor: OBSERVATORY.oceanSoft }}
            >
              {order != null && (
                <span
                  className="font-mono text-[9px] px-1 py-0.5 rounded"
                  style={{ background: OBSERVATORY.oceanSoft, color: OBSERVATORY.ocean }}
                >
                  #{order}
                </span>
              )}
              <span className="text-[12px] font-medium" style={{ color: OBSERVATORY.ink }}>
                {p.name}
              </span>
              <span className="text-[10px] font-mono tabular-nums" style={{ color: OBSERVATORY.muted }}>
                {done}/{tables.length}
              </span>
              {liveTable ? (
                <span className="flex items-center gap-1 text-[10px] font-mono" style={{ color: OBSERVATORY.ocean }}>
                  <span
                    className="pipeline-live-dot inline-block w-1.5 h-1.5 rounded-full"
                    style={{ background: OBSERVATORY.ocean }}
                  />
                  {liveTable.table_name}
                </span>
              ) : pending ? (
                <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: OBSERVATORY.muted2 }}>
                  queued…
                </span>
              ) : failed > 0 ? (
                <span className="text-[10px] font-mono" style={{ color: OBSERVATORY.err }}>
                  {failed} failed
                </span>
              ) : (
                <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: OBSERVATORY.muted2 }}>
                  starting…
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar counts
// ---------------------------------------------------------------------------
function PipelineCounts({ counts }: { counts: { total: number; success: number; running: number; stale: number; error: number; never: number } }) {
  const items: { label: string; value: number; color: string }[] = [
    { label: 'OK',      value: counts.success, color: OBSERVATORY.ok },
    { label: 'Running', value: counts.running, color: OBSERVATORY.ocean },
    { label: 'Stale',   value: counts.stale,   color: OBSERVATORY.warn },
    { label: 'Failed',  value: counts.error,   color: OBSERVATORY.err },
    { label: 'Idle',    value: counts.never,   color: OBSERVATORY.muted },
  ].filter((i) => i.value > 0);

  return (
    <div className="flex items-center gap-3 mr-2 text-[11px] text-muted">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: it.color }} />
          <span className="font-mono tabular-nums" style={{ color: it.color }}>{it.value}</span>
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function SidePanel({
  product, allProducts, tables, productEdges, onClose, onRun, running,
}: {
  product: Product;
  allProducts: Product[];
  tables: PipelineTable[];
  productEdges: ProductEdge[];
  onClose: () => void;
  onRun: () => void;
  running: boolean;
}) {
  const upstreamIds = productEdges.filter((e) => e.target === product.id).map((e) => e.source);
  const downstreamIds = productEdges.filter((e) => e.source === product.id).map((e) => e.target);
  const upstream = allProducts.filter((p) => upstreamIds.includes(p.id));
  const downstream = allProducts.filter((p) => downstreamIds.includes(p.id));

  const dims = tables.filter((t) => t.table_role === 'dimension').sort((a, b) => (a.dag_order ?? 0) - (b.dag_order ?? 0));
  const facts = tables.filter((t) => t.table_role === 'fact').sort((a, b) => (a.dag_order ?? 0) - (b.dag_order ?? 0));
  const others = tables.filter((t) => t.table_role !== 'dimension' && t.table_role !== 'fact');

  const s = STATUS_STYLES[product.status];

  // Re-mount SchedulePanel when product changes
  return (
    <aside className="w-[400px] shrink-0 border-l border-line bg-raised h-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-raised border-b border-line px-4 py-3 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${product.status === 'running' ? 'animate-pulse' : ''}`}
              style={{ background: s.dot }}
            />
            <h2 className="text-sm font-medium text-ink truncate">{product.name}</h2>
          </div>
          <p className="text-[11px] text-muted mt-0.5">
            <span style={{ color: s.text }}>{s.label}</span>
            {' · '}
            {product.last_run_at ? `last run ${formatRelative(product.last_run_at)}` : 'never run'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-soft text-muted2 hover:text-ink"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Run button */}
      <div className="px-4 py-3 border-b border-line">
        <button
          onClick={onRun}
          disabled={running}
          className="w-full px-3 py-2 text-xs rounded-md bg-ocean text-white hover:bg-ocean-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {running ? <Spinner light /> : <Play size={12} />}
          Refresh this product (and upstream)
        </button>
        <p className="text-[10px] text-muted mt-1.5 text-center">
          Runs upstream dependencies first, then dims, then facts.
        </p>
      </div>

      {/* Upstream / downstream */}
      {(upstream.length > 0 || downstream.length > 0) && (
        <div className="px-4 py-3 border-b border-line">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted mb-2">Dependencies</h3>
          {upstream.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] text-muted mb-1">Depends on</p>
              <div className="space-y-1">
                {upstream.map((u) => <DepRow key={u.id} product={u} direction="up" />)}
              </div>
            </div>
          )}
          {downstream.length > 0 && (
            <div>
              <p className="text-[10px] text-muted mb-1">Used by</p>
              <div className="space-y-1">
                {downstream.map((d) => <DepRow key={d.id} product={d} direction="down" />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tables */}
      <div className="px-4 py-3 border-b border-line">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted mb-2">
          Tables ({tables.length})
        </h3>
        {tables.length === 0 && (
          <p className="text-[11px] text-muted">No tables defined.</p>
        )}
        {dims.length > 0 && <TableGroup label="Dimensions" tables={dims} order={1} />}
        {facts.length > 0 && <TableGroup label="Facts"      tables={facts} order={2} />}
        {others.length > 0 && <TableGroup label="Other"     tables={others} order={3} />}
      </div>

      {/* Schedule */}
      <div className="px-4 py-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted mb-2">Schedule</h3>
        <SchedulePanel key={product.id} productId={product.id} />
        <p className="text-[10px] text-muted mt-2">
          Edits also reschedule the BullMQ repeatable job.
        </p>
      </div>
    </aside>
  );
}

function DepRow({ product, direction }: { product: Product; direction: 'up' | 'down' }) {
  const s = STATUS_STYLES[product.status];
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {direction === 'up'
        ? <ArrowRight size={10} className="text-muted2 rotate-180" />
        : <ArrowRight size={10} className="text-muted2" />}
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${product.status === 'running' ? 'animate-pulse' : ''}`}
        style={{ background: s.dot }}
      />
      <span className="text-ink-2 truncate flex-1">{product.name}</span>
      <span className="text-[10px]" style={{ color: s.text }}>{s.label}</span>
    </div>
  );
}

function TableGroup({ label, tables, order }: { label: string; tables: PipelineTable[]; order: number }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="font-mono text-[9px] text-muted2">[{order}]</span>
        <span className="text-[10px] text-muted">{label}</span>
      </div>
      <div className="space-y-0.5">
        {tables.map((t) => <TableRow key={t.id} table={t} />)}
      </div>
    </div>
  );
}

function TableRow({ table }: { table: PipelineTable }) {
  const [showError, setShowError] = useState(false);
  const status = (table.transformation_status ?? 'draft').toLowerCase();
  const cfg =
    status === 'success' ? { color: OBSERVATORY.ok,    icon: <CheckCircle2 size={10} /> } :
    status === 'running' ? { color: OBSERVATORY.ocean, icon: <Spinner /> } :
    status === 'error'   ? { color: OBSERVATORY.err,   icon: <AlertCircle size={10} /> } :
                           { color: OBSERVATORY.muted2,icon: <Clock size={10} /> };

  const hasError = status === 'error' && !!table.last_run_error;

  return (
    <div className="rounded hover:bg-softer">
      <div
        className={`flex items-center gap-2 px-2 py-1 text-[11px] ${hasError ? 'cursor-pointer' : ''}`}
        onClick={() => hasError && setShowError(!showError)}
      >
        <span style={{ color: cfg.color }}>{cfg.icon}</span>
        <span className="text-ink-2 truncate flex-1 font-mono">{table.table_name}</span>
        {table.row_count != null && (
          <span className="text-[10px] tabular-nums text-muted">{table.row_count.toLocaleString()}</span>
        )}
        {hasError && (
          <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: OBSERVATORY.err }}>
            {showError ? 'hide' : 'why?'}
          </span>
        )}
      </div>
      {hasError && showError && (
        <div className="mx-2 mb-1 px-2 py-1.5 rounded text-[11px] font-mono whitespace-pre-wrap break-words" style={{ background: OBSERVATORY.errSoft, color: OBSERVATORY.ink2 }}>
          {table.last_run_error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function Spinner({ light = false }: { light?: boolean }) {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full border-2 border-t-transparent animate-spin"
      style={{ borderColor: light ? 'rgba(255,255,255,0.7)' : OBSERVATORY.ocean, borderTopColor: 'transparent' }}
    />
  );
}

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Nav from '@/components/Nav';
import api from '@/lib/api';
import { getToken } from '@/lib/auth';
import dynamic from 'next/dynamic';
import SchedulePanel from '@/components/SchedulePanel';

const LineageFlow = dynamic(() => import('@/components/products/LineageFlow'), { ssr: false });

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Connection { id: number; name: string; }

interface DataProduct {
  id: number;
  connection_id: number;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  star_schema_count?: number;
}

interface DepEdge { dependent_product_id: number; source_product_id: number; }

interface StarSchema {
  id: number;
  data_product_id: number;
  name: string;
  description: string | null;
  grain: string | null;
  fact_table_type: string;
}

interface QualityCheck {
  id: number;
  product_table_id: number;
  check_type: 'bk_uniqueness' | 'fan_out';
  status: 'pass' | 'fail' | 'skip' | 'error';
  bk_columns: string | string[];
  total_rows: number;
  distinct_bk_rows: number;
  duplicate_count: number;
  sample_duplicates: string | Record<string, unknown>[];
  message: string;
  executed_at: string;
}

interface ProductTable {
  id: number;
  star_schema_id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  transformation_sql: string | null;
  transformation_status: string;
  is_shared_dimension: boolean;
  dag_order: number;
  row_count: number | null;
  last_run_at: string | null;
  last_run_error: string | null;
  load_mode: string;
  quality_checks?: QualityCheck[];
}

interface ProductColumn {
  id: number;
  product_table_id: number;
  column_name: string;
  data_type: string | null;
  display_name: string | null;
  description: string | null;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
  transformation_expression: string | null;
  additivity: string | null;
  scd_type: number;
  lineage?: { source_table_name: string; source_column_name: string; transformation_description: string }[];
}

interface ProductRelationship {
  id: number;
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: string;
}

interface FullDataProduct extends DataProduct {
  star_schemas: (StarSchema & {
    tables: (ProductTable & { columns: ProductColumn[] })[];
    relationships: ProductRelationship[];
  })[];
}

interface SourceTable {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  connection_id: number;
}

interface ProductKpi {
  id: number;
  data_product_id: number;
  name: string;
  description: string | null;
  formula_plain_text: string | null;
  formula_sql: string | null;
  ai_draft: boolean;
  owner_name: string | null;
}

interface DataProductProposal {
  rationale: string;
  shared_dimensions: Array<{ table_name: string; owner_product_name: string }>;
  data_products: Array<{
    name: string;
    description: string;
    build_order: number;
    depends_on: Array<{ source_product_name: string; shared_table_names: string[] }>;
    star_schemas: Array<{
      name: string;
      description: string;
      grain: string;
      tables: Array<{
        table_name: string;
        display_name: string;
        table_role: string;
        is_shared_dimension: boolean;
        source_tables: string[];
        transformation_sql: string;
        columns: Array<{ column_name: string; data_type: string; column_role: string }>;
      }>;
    }>;
  }>;
}

interface SkeletonTable { name: string; role: string; description?: string; }

// ---------------------------------------------------------------------------
// Small reusable components
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: 'bg-slate-300',
    designing: 'bg-blue-400 animate-pulse',
    approved: 'bg-amber-400',
    running: 'bg-blue-500 animate-pulse',
    success: 'bg-emerald-500',
    error: 'bg-red-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${map[status] ?? 'bg-slate-300'}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-500',
    designing: 'bg-blue-100 text-blue-700',
    approved: 'bg-amber-100 text-amber-700',
    running: 'bg-blue-100 text-blue-700',
    success: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
  };
  const label: Record<string, string> = {
    draft: 'Draft', designing: 'Designing…', approved: 'Ready to build',
    running: 'Building…', success: 'Built', error: 'Error',
  };
  return (
    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${colors[status] ?? 'bg-slate-100 text-slate-500'}`}>
      {label[status] ?? status}
    </span>
  );
}

function RolePill({ role, shared }: { role: string; shared?: boolean }) {
  const base = role === 'fact'
    ? 'bg-purple-100 text-purple-700 border-purple-200'
    : role === 'dimension'
      ? shared ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-sky-100 text-sky-700 border-sky-200'
      : 'bg-slate-100 text-slate-600 border-slate-200';
  const label = role === 'fact'
    ? '⚡ Activity'
    : role === 'dimension'
      ? shared ? '⟳ Shared' : '📋 Reference'
      : role;
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${base}`}>
      {label}
    </span>
  );
}

/** Strip dim_/fact_ prefix and convert snake_case → Title Case if no display_name is set */
function friendlyName(tbl: { table_name: string; display_name?: string | null }): string {
  if (tbl.display_name) return tbl.display_name;
  return tbl.table_name
    .replace(/^(fact_|dim_|bridge_|junk_)/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProductsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [depGraph, setDepGraph] = useState<DepEdge[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<FullDataProduct | null>(null);
  const [loading, setLoading] = useState(true);

  // Topic view — full product details + KPIs loaded for the simple card grid
  const [allProductDetails, setAllProductDetails] = useState<Map<number, FullDataProduct>>(new Map());
  const [allProductKpis, setAllProductKpis] = useState<Map<number, ProductKpi[]>>(new Map());
  const [loadingTopics, setLoadingTopics] = useState(false);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createConnId, setCreateConnId] = useState<number | null>(null);
  const [availableSources, setAvailableSources] = useState<SourceTable[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  // Auto-design
  const [showAutoDesign, setShowAutoDesign] = useState(false);
  const [autoDesignConnId, setAutoDesignConnId] = useState<number | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<DataProductProposal | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildResults, setBuildResults] = useState<Array<{ name: string; id: number; status: string }> | null>(null);

  // Design (SSE)
  const [designing, setDesigning] = useState(false);
  const [designPhase, setDesignPhase] = useState('');
  const [designThinking, setDesignThinking] = useState('');
  const [designSqlThinking, setDesignSqlThinking] = useState('');
  const [skeletonTables, setSkeletonTables] = useState<SkeletonTable[]>([]);
  const [showThinking, setShowThinking] = useState(false);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [reasoningFull, setReasoningFull] = useState('');
  const [showReasoning, setShowReasoning] = useState(false);

  // Build / run
  const [runningAll, setRunningAll] = useState(false);
  const [runningTableId, setRunningTableId] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Advanced SQL editor (admin)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [editingSql, setEditingSql] = useState<string | null>(null);
  const [savingSql, setSavingSql] = useState(false);
  const [generatingSql, setGeneratingSql] = useState(false);

  // Lineage view toggle
  const [showLineage, setShowLineage] = useState(false);

  // Simple vs advanced view
  const [showAdvancedView, setShowAdvancedView] = useState(false);

  // Full auto-build (propose + design + build, no user decisions)
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoBuildLog, setAutoBuildLog] = useState<LogEntry[]>([]);
  const [buildElapsed, setBuildElapsed] = useState(0);
  const autoBuildLogRef = useRef<LogEntry[]>([]);
  const autoBuildScrollRef = useRef<HTMLDivElement>(null);
  const reasoningScrollRef = useRef<HTMLDivElement>(null);

  const pushLog = (msg: string, status: LogEntry['status'] = 'info', indent = false, key?: string) => {
    const entry: LogEntry = { id: Date.now() + Math.random(), key, msg, status, indent };
    autoBuildLogRef.current = [...autoBuildLogRef.current, entry];
    setAutoBuildLog([...autoBuildLogRef.current]);
    setTimeout(() => { if (autoBuildScrollRef.current) autoBuildScrollRef.current.scrollTop = autoBuildScrollRef.current.scrollHeight; }, 20);
    return entry.id;
  };

  const updateLastLog = (msg: string, status: LogEntry['status']) => {
    const logs = [...autoBuildLogRef.current];
    if (logs.length > 0) { logs[logs.length - 1] = { ...logs[logs.length - 1], msg, status, sub: undefined }; }
    autoBuildLogRef.current = logs;
    setAutoBuildLog([...logs]);
  };

  // Update a specific log line by its key (for per-topic in-place updates)
  const updateLogByKey = (key: string, msg: string, status: LogEntry['status'], sub?: string) => {
    const logs = autoBuildLogRef.current.map((e) =>
      e.key === key ? { ...e, msg, status, sub: sub ?? e.sub } : e
    );
    autoBuildLogRef.current = logs;
    setAutoBuildLog([...logs]);
  };

  // Run design-stream — resolves on 'done', rejects on error/abort/timeout
  const runDesignStream = (
    productId: number,
    onPhase: (p: string) => void,
    onThinking?: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<void> =>
    new Promise(async (resolve, reject) => {
      try {
        const token = getToken();
        const response = await fetch(`${BACKEND_URL}/api/products/${productId}/design-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal,
        });
        if (!response.ok) {
          reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
          return;
        }
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let ev: Record<string, unknown>;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.type === 'phase') onPhase(ev.text as string);
            if (ev.type === 'thinking') {
              const chunk = ev.text as string;
              if (onThinking) onThinking(chunk);
              setReasoningFull((prev) => prev + chunk);
            }
            if (ev.type === 'done') { resolve(); return; }
            if (ev.type === 'error') { reject(new Error((ev.message as string) ?? 'Design failed')); return; }
          }
          if (done) { resolve(); break; }
        }
      } catch (e) { reject(e); }
    });

  // Stream the propose step — returns the proposal once Claude is done
  const runProposeStream = (connId: number, signal?: AbortSignal): Promise<DataProductProposal> =>
    new Promise(async (resolve, reject) => {
      pushLog('Claude is analysing your source system…', 'running', false, 'propose');
      let thinkingExcerpt = '';
      try {
        const token = getToken();
        const response = await fetch(`${BACKEND_URL}/api/products/propose-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal,
          body: JSON.stringify({ connectionId: connId }),
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let ev: Record<string, unknown>;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.type === 'phase') {
              updateLogByKey('propose', `Claude is analysing your source system — ${ev.text as string}`, 'running');
            }
            if (ev.type === 'thinking') {
              const chunk = ev.text as string;
              setReasoningFull((prev) => prev + chunk);
              // Accumulate first 150 chars of reasoning as a subtitle
              if (thinkingExcerpt.length < 150) {
                thinkingExcerpt = (thinkingExcerpt + chunk).slice(0, 150).replace(/\n/g, ' ');
                updateLogByKey('propose', 'Claude is analysing your source system…', 'running', `"${thinkingExcerpt}…"`);
              }
            }
            if (ev.type === 'done') {
              updateLogByKey('propose', 'Claude is analysing your source system…', 'success');
              resolve(ev.proposal as DataProductProposal);
              return;
            }
            if (ev.type === 'error') { reject(new Error(ev.message as string)); return; }
          }
          if (done) { reject(new Error('Stream ended without result')); break; }
        }
      } catch (e) { reject(e); }
    });

  const handleCancelBuild = () => {
    abortRef.current?.abort();
  };

  const handleFullAutoBuild = async (connId: number) => {
    // Reset state
    setReasoningFull('');
    setShowReasoning(false);
    setAutoBuilding(true);
    autoBuildLogRef.current = [];
    setAutoBuildLog([]);
    setBuildElapsed(0);
    const timerRef = setInterval(() => setBuildElapsed((s) => s + 1), 1000);

    // Create abort controller for cancellation
    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    try {
      // Step 1 — propose with live streaming
      const prop = await runProposeStream(connId, abortCtrl.signal);

      // Fix wave ordering: all foundation topics (no deps) → wave 1, rest → wave 2
      const fixedProp = {
        ...prop,
        data_products: prop.data_products.map((dp) => ({
          ...dp,
          build_order: dp.depends_on.length === 0 ? 1 : 2,
        })),
      };

      updateLogByKey(
        'propose',
        `Planned ${fixedProp.data_products.length} topics · ${fixedProp.shared_dimensions.length} shared reference tables`,
        'success',
      );

      // Show what Claude decided
      if (fixedProp.rationale) {
        pushLog(`💬 ${fixedProp.rationale}`, 'info');
      }

      // Step 2 — create records
      pushLog('Setting up topics in database…', 'running');
      const buildRes = await api.post('/products/build-proposed', { connectionId: connId, proposal: fixedProp });
      const created: Array<{ name: string; id: number }> = buildRes.data.data?.products ?? [];
      updateLastLog(`Created ${created.length} topics`, 'success');
      await loadProducts();
      await loadDepGraph();

      // Step 2.5 — ingest source data so warehouse_path is set before transformations
      pushLog('Ingesting source data into warehouse…', 'running', false, 'ingest');
      const tablesRes = await api.get(`/semantic/tables?connectionId=${connId}`);
      const sourceTableNames = ((tablesRes.data.data ?? []) as { table_name: string }[]).map((t) => t.table_name);
      if (sourceTableNames.length === 0) {
        updateLogByKey('ingest', '✗ No source tables found — cannot continue', 'error');
        throw new Error('No source tables found for this connection');
      }
      try {
        const ingestRes = await api.post('/ingestion/ingest', { connectionId: connId, tables: sourceTableNames });
        const wp = ingestRes.data?.data?.warehouse_path;
        if (!wp) {
          updateLogByKey('ingest', '✗ Ingestion completed but warehouse path not set', 'error');
          throw new Error('Ingestion did not return a warehouse path — check ETL logs');
        }
        updateLogByKey('ingest', `Ingested ${sourceTableNames.length} source tables`, 'success');
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : 'Ingestion failed');
        // Check specifically for ETL not running
        const isEtlDown = msg.includes('ETL service is not running') || msg.includes('ECONNREFUSED');
        updateLogByKey('ingest', `✗ ${isEtlDown ? 'ETL service is not running — start Docker first' : msg.slice(0, 100)}`, 'error');
        throw new Error(isEtlDown
          ? 'ETL service is not running. Start it with: docker compose up -d'
          : `Ingestion failed: ${msg.slice(0, 100)}`);
      }

      // Step 2.6 — refresh source column metadata so Claude designs against real column names
      pushLog('Refreshing source metadata…', 'running', false, 'introspect');
      try {
        await api.post(`/connections/${connId}/introspect`);
        updateLogByKey('introspect', 'Source column metadata up to date', 'success');
      } catch {
        updateLogByKey('introspect', '⚠ Could not refresh metadata — using existing', 'info');
        // Non-fatal: existing source_columns may still be fine
      }

      // Step 3 — group by build_order → waves
      const byOrder = new Map<number, Array<{ name: string; id: number }>>();
      for (const meta of created) {
        const order = fixedProp.data_products.find((p) => p.name === meta.name)?.build_order ?? 99;
        const group = byOrder.get(order) ?? [];
        group.push(meta);
        byOrder.set(order, group);
      }
      const waves = [...byOrder.entries()].sort(([a], [b]) => a - b);

      for (const [, wave] of waves) {
        const isFoundationWave = wave.every(
          (m) => (fixedProp.data_products.find((p) => p.name === m.name)?.depends_on?.length ?? 0) === 0
        );
        // Filter out Calendar from visible wave logging (it's infrastructure)
        const visibleWave = wave.filter((m) => m.name !== 'Calendar');
        if (visibleWave.length === 0) {
          // Calendar-only wave — still build it, just don't show a wave header
        } else {
          pushLog(
            `─── ${isFoundationWave ? '🔷 Reference data' : `📊 Analytics data`}${visibleWave.length > 1 ? ` (${visibleWave.length} topics in parallel)` : ''}`,
            'info'
          );
        }

        // ── Design phase: one log line per topic, updated live ────────────────
        for (const meta of wave) {
          const displayName = meta.name === 'Calendar' ? null : cleanTopicName(meta.name);
          if (displayName) {
            pushLog(`  ${displayName}  ·  asking Claude to design…`, 'running', true, `design-${meta.id}`);
          }
        }

        // Accumulate a brief excerpt from Claude's thinking per topic
        const thinkingExcerpts = new Map<number, string>();

        await Promise.all(wave.map((meta) => {
          const key = `design-${meta.id}`;
          const name = cleanTopicName(meta.name);
          const isCalendar = meta.name === 'Calendar';

          const designPromise = runDesignStream(
            meta.id,
            (phase) => {
              if (isCalendar) return; // Silent for Calendar
              const lastPhase = phase
                .replace('Reading', 'Reading source data —')
                .replace('source tables...', 'tables')
                .replace('Designing star schema with AI...', 'Claude is designing the schema…')
                .replace('Saving star schema design...', 'Saving design…')
                .replace('Generating transformation SQL...', 'Generating SQL…')
                .replace('Done!', '✓ Done');
              const excerpt = thinkingExcerpts.get(meta.id);
              updateLogByKey(key, `  ${name}  ·  ${lastPhase}`, 'running', excerpt ? `"${excerpt}"` : undefined);
            },
            (chunk) => {
              // Keep a short rolling excerpt of Claude's reasoning (first 120 chars)
              const current = thinkingExcerpts.get(meta.id) ?? '';
              if (current.length < 120) {
                const next = (current + chunk).slice(0, 120).replace(/\n/g, ' ');
                thinkingExcerpts.set(meta.id, next);
              }
            },
            abortCtrl.signal,
          );

          return designPromise
            .then(() => {
              if (!isCalendar) updateLogByKey(key, `  ${name}  ·  ✓ Schema + SQL ready`, 'success');
            })
            .catch((err: unknown) => {
              if (isCalendar) return; // Calendar failures are silent — it's infrastructure
              const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
              if (!isAbort) {
                const msg = err instanceof Error ? err.message : 'Design failed';
                updateLogByKey(key, `  ${name}  ·  ✗ ${msg}`, 'error');
              }
            });
        }));

        await loadProducts();

        // ── Build phase: one log line per topic, updated on completion ────────
        for (const meta of wave) {
          if (meta.name !== 'Calendar') {
            pushLog(`  ${cleanTopicName(meta.name)}  ·  loading data…`, 'running', true, `build-${meta.id}`);
          }
        }

        await Promise.allSettled(
          wave.map(async (meta) => {
            const key = `build-${meta.id}`;
            const name = cleanTopicName(meta.name);
            const isCalendar = meta.name === 'Calendar';
            try {
              // Check if aborted before building
              if (abortCtrl.signal.aborted) return;
              // Use run-full for initial build to ensure clean overwrite (avoids corrupted incremental parquet)
              const runRes = await api.post(`/products/${meta.id}/run-full`);
              const results: Array<{ row_count?: number; status: string; error?: string }> = runRes.data?.data ?? [];
              const rows = results.reduce((s: number, r) => s + (r.row_count ?? 0), 0);
              const failedTables = results.filter((r) => r.status === 'error');
              if (!isCalendar) {
                if (failedTables.length > 0) {
                  const errDetails = failedTables.map((r) => r.error ?? 'failed').join('; ').slice(0, 120);
                  updateLogByKey(key, `  ${name}  ·  ⚠ ${failedTables.length} table(s) failed`, 'error', `${errDetails}`);
                } else {
                  updateLogByKey(key, `  ${name}  ·  ✓ ${rows.toLocaleString()} rows loaded`, 'success');
                }
              }
            } catch (err: unknown) {
              if (isCalendar) return;
              const msg =
                (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                (err instanceof Error ? err.message : 'Build failed');
              updateLogByKey(key, `  ${name}  ·  ✗ ${msg.slice(0, 100)}`, 'error');
            }
          })
        );

        await loadProducts();
      }

      if (!abortCtrl.signal.aborted) {
        // Check if any topics had errors
        const hasErrors = autoBuildLogRef.current.some((l) => l.status === 'error');
        if (hasErrors) {
          const errorCount = autoBuildLogRef.current.filter((l) => l.status === 'error').length;
          pushLog(`⚠ Finished with ${errorCount} error(s). Some topics may need attention.`, 'error');
        } else {
          pushLog('✓ All done! Your data is ready to query.', 'success');
        }
        await loadDepGraph();
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
      if (isAbort) {
        pushLog('⛔ Build cancelled.', 'error');
      } else {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : 'Unknown error');
        pushLog(`✗ Failed: ${msg}`, 'error');
      }
    }

    clearInterval(timerRef);
    abortRef.current = null;
    setAutoBuilding(false);
  };

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadProducts = useCallback(async () => {
    setLoading(false); // unlock the UI immediately; don't block on this request
    try {
      const res = await api.get('/products');
      setProducts(res.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadDepGraph = useCallback(async () => {
    try {
      const res = await api.get('/products/dependency-graph');
      setDepGraph(res.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const res = await api.get('/connections');
      setConnections(res.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadFullProduct = useCallback(async (id: number) => {
    try {
      const res = await api.get(`/products/${id}`);
      setSelectedProduct(res.data.data ?? null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadProducts();
    loadDepGraph();
    loadConnections();
  }, [loadProducts, loadDepGraph, loadConnections]);

  // Auto-select connection when there is only one
  useEffect(() => {
    if (connections.length === 1) setAutoDesignConnId(connections[0].id);
  }, [connections]);

  // Auto-scroll reasoning drawer to bottom whenever new text arrives
  useEffect(() => {
    if (showReasoning && reasoningScrollRef.current) {
      reasoningScrollRef.current.scrollTop = reasoningScrollRef.current.scrollHeight;
    }
  }, [reasoningFull, showReasoning]);

  // Load full product details + KPIs for the topic card grid
  const loadAllTopics = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    setLoadingTopics(true);
    try {
      const pairs = await Promise.all(ids.map(async (id) => {
        const [pRes, kRes] = await Promise.all([
          api.get(`/products/${id}`),
          api.get(`/products/${id}/kpis`),
        ]);
        return { product: pRes.data.data as FullDataProduct, kpis: (kRes.data.data ?? []) as ProductKpi[] };
      }));
      const detailMap = new Map<number, FullDataProduct>();
      const kpiMap = new Map<number, ProductKpi[]>();
      pairs.forEach(({ product, kpis }) => { if (product) { detailMap.set(product.id, product); kpiMap.set(product.id, kpis); } });
      setAllProductDetails(detailMap);
      setAllProductKpis(kpiMap);
    } catch { /* ignore */ }
    setLoadingTopics(false);
  }, []);

  useEffect(() => {
    if (products.length > 0 && !showAdvancedView) loadAllTopics(products.map((p) => p.id));
  }, [products, showAdvancedView, loadAllTopics]);

  // Rebuild all existing products in dependency order (foundations first)
  const handleRebuildAll = async () => {
    setAutoBuilding(true);
    autoBuildLogRef.current = [];
    setAutoBuildLog([]);
    try {
      pushLog('Rebuilding your data warehouse…', 'running');
      await loadProducts();
      await loadDepGraph();
      const fIds = new Set(depGraph.map((d) => d.source_product_id));
      const sorted = [...products].sort((a, b) => {
        if (fIds.has(a.id) && !fIds.has(b.id)) return -1;
        if (!fIds.has(a.id) && fIds.has(b.id)) return 1;
        return 0;
      });
      for (const p of sorted) {
        if (p.name === 'Calendar') continue; // infrastructure — built silently
        pushLog(`${fIds.has(p.id) ? '🔷' : '📊'} ${cleanTopicName(p.name)}`, 'info');
        pushLog('  Building tables…', 'running', true);
        try {
          const res = await api.post(`/products/${p.id}/run`);
          const results: Array<{ row_count?: number; status: string; error?: string }> = res.data?.data ?? [];
          const rows = results.reduce((s, r) => s + (r.row_count ?? 0), 0);
          const failed = results.filter((r) => r.status === 'error');
          if (failed.length > 0) {
            const errMsg = failed.map((r) => r.error ?? 'failed').join('; ').slice(0, 100);
            updateLastLog(`  ⚠ ${failed.length} table(s) failed: ${errMsg}`, 'error');
          } else {
            updateLastLog(`  Built — ${rows.toLocaleString()} rows`, 'success');
          }
        } catch (err: unknown) {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (err instanceof Error ? err.message : 'Build failed');
          updateLastLog(`  ✗ ${msg.slice(0, 100)}`, 'error');
        }
      }
      pushLog('✓ Rebuild complete.', 'success');
      await loadProducts();
    } catch (err: unknown) {
      pushLog(`Failed: ${(err instanceof Error ? err.message : 'Unknown error')}`, 'error');
    }
    setAutoBuilding(false);
  };

  const handleSingleTopicBuild = async (connId: number, description: string) => {
    setReasoningFull('');
    setShowReasoning(false);
    setAutoBuilding(true);
    autoBuildLogRef.current = [];
    setAutoBuildLog([]);
    setBuildElapsed(0);
    const timerRef = setInterval(() => setBuildElapsed((s) => s + 1), 1000);

    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    try {
      pushLog(`Asking Claude to design "${description.slice(0, 60)}${description.length > 60 ? '…' : ''}"…`, 'running', false, 'single-propose');

      const res = await api.post('/products/propose-single', { connectionId: connId, description });
      const proposal: DataProductProposal = res.data.data;

      if (!proposal?.data_products?.length) {
        throw new Error('Claude could not design a product for that description.');
      }

      updateLogByKey('single-propose', `Planned: ${proposal.data_products[0].name}`, 'success');
      if (proposal.rationale) pushLog(`💬 ${proposal.rationale}`, 'info');

      // Build via existing pipeline
      const buildRes = await api.post('/products/build-proposed', { connectionId: connId, proposal });
      const created: Array<{ name: string; id: number }> = buildRes.data.data?.products ?? [];
      if (!created.length) throw new Error('No products were created.');

      await loadProducts();
      await loadDepGraph();

      const meta = created[0];
      const key = `design-${meta.id}`;
      pushLog(`  ${cleanTopicName(meta.name)}  ·  asking Claude to design…`, 'running', true, key);

      await runDesignStream(
        meta.id,
        (phase) => {
          const lastPhase = phase
            .replace('Designing star schema with AI...', 'Claude is designing the schema…')
            .replace('Generating transformation SQL...', 'Generating SQL…')
            .replace('Done!', '✓ Done');
          updateLogByKey(key, `  ${cleanTopicName(meta.name)}  ·  ${lastPhase}`, 'running');
        },
        (chunk) => setReasoningFull((prev) => prev + chunk),
        abortCtrl.signal,
      );

      updateLogByKey(key, `  ${cleanTopicName(meta.name)}  ·  ✓ Schema + SQL ready`, 'success');
      await loadProducts();

      const buildKey = `build-${meta.id}`;
      pushLog(`  ${cleanTopicName(meta.name)}  ·  loading data…`, 'running', true, buildKey);

      const runRes = await api.post(`/products/${meta.id}/run`);
      const results: Array<{ row_count?: number; status: string; error?: string }> = runRes.data?.data ?? [];
      const rows = results.reduce((s: number, r) => s + (r.row_count ?? 0), 0);
      const failed = results.filter((r) => r.status === 'error');
      if (failed.length > 0) {
        const errMsg = failed.map((r) => r.error ?? 'failed').join('; ').slice(0, 120);
        updateLogByKey(buildKey, `  ${cleanTopicName(meta.name)}  ·  ⚠ ${failed.length} table(s) failed`, 'error', errMsg);
      } else {
        updateLogByKey(buildKey, `  ${cleanTopicName(meta.name)}  ·  ✓ ${rows.toLocaleString()} rows loaded`, 'success');
      }

      pushLog('✓ Done! Your new topic is ready.', 'success');
      await loadProducts();
      await loadAllTopics(created.map((c) => c.id));
      await loadDepGraph();
    } catch (err: unknown) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
      if (isAbort) {
        pushLog('⛔ Cancelled.', 'error');
      } else {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : 'Unknown error');
        pushLog(`✗ Failed: ${msg}`, 'error');
      }
    }

    clearInterval(timerRef);
    abortRef.current = null;
    setAutoBuilding(false);
  };

  // ---------------------------------------------------------------------------
  // Derived: classify products as Foundations vs Domain
  // Foundation = appears as a source (dependency) for another product
  // ---------------------------------------------------------------------------

  const foundationIds = new Set(depGraph.map((d) => d.source_product_id));
  const foundations = products.filter((p) => foundationIds.has(p.id));
  const domainProducts = products.filter((p) => !foundationIds.has(p.id));

  // Dependencies for selected product
  const selectedDeps = selectedProduct
    ? depGraph
        .filter((d) => d.dependent_product_id === selectedProduct.id)
        .map((d) => ({
          edge: d,
          product: products.find((p) => p.id === d.source_product_id),
        }))
    : [];
  const allDepsReady = selectedDeps.every((d) => ['approved', 'success'].includes(d.product?.status ?? ''));

  // ---------------------------------------------------------------------------
  // Auto-design
  // ---------------------------------------------------------------------------

  const handlePropose = async () => {
    if (!autoDesignConnId) return;
    setProposing(true); setProposal(null); setProposeError(null); setBuildResults(null);
    try {
      const res = await api.post('/products/propose', { connectionId: autoDesignConnId });
      setProposal(res.data.data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Something went wrong. Please try again.';
      setProposeError(msg);
    }
    setProposing(false);
  };

  const handleBuildProposed = async () => {
    if (!proposal || !autoDesignConnId) return;
    setBuilding(true);
    try {
      const res = await api.post('/products/build-proposed', { connectionId: autoDesignConnId, proposal });
      setBuildResults(res.data.data?.products ?? []);
      await loadProducts();
      await loadDepGraph();
    } catch { /* ignore */ }
    setBuilding(false);
  };

  // ---------------------------------------------------------------------------
  // Create data product manually
  // ---------------------------------------------------------------------------

  const handleConnectionSelect = async (connId: number) => {
    setCreateConnId(connId); setSelectedSources(new Set());
    try {
      const res = await api.get(`/semantic/tables?connectionId=${connId}`);
      setAvailableSources(res.data.data ?? []);
    } catch { setAvailableSources([]); }
  };

  const handleCreate = async () => {
    if (!createName.trim() || !createConnId || selectedSources.size === 0) return;
    setCreating(true);
    try {
      const sourceTables = availableSources
        .filter((s) => selectedSources.has(s.id))
        .map((s) => ({ sourceTableId: s.id, tableName: s.table_name }));
      await api.post('/products', { name: createName, description: createDesc, connectionId: createConnId, sourceTables });
      setShowCreate(false); setCreateName(''); setCreateDesc(''); setCreateConnId(null); setSelectedSources(new Set());
      await loadProducts(); await loadDepGraph();
    } catch { /* ignore */ }
    setCreating(false);
  };

  // ---------------------------------------------------------------------------
  // AI Design (SSE streaming)
  // ---------------------------------------------------------------------------

  const handleDesign = async (productId: number) => {
    setDesigning(true); setDesignPhase('Connecting…'); setDesignThinking('');
    setDesignSqlThinking(''); setSkeletonTables([]); setShowThinking(false);
    try {
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/products/${productId}/design-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }
          const type = event.type as string;
          if (type === 'phase') setDesignPhase(event.text as string);
          else if (type === 'thinking') {
            setDesignThinking((p) => p + (event.text as string));
            setTimeout(() => { if (thinkingRef.current) thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight; }, 10);
          } else if (type === 'sql_thinking') {
            setDesignSqlThinking((p) => p + (event.text as string));
          } else if (type === 'table_saved') {
            setSkeletonTables((p) => [...p, event.table as SkeletonTable]);
          } else if (type === 'design_complete') {
            setDesignPhase('Star schema designed — generating SQL…');
          } else if (type === 'sql_complete') {
            setDesignPhase('Done! Schema designed and SQL generated.');
          } else if (type === 'sql_error') {
            setDesignPhase('Design complete. SQL generation failed — use Advanced to retry.');
          } else if (type === 'error') {
            setDesignPhase(`Error: ${event.message as string}`);
          } else if (type === 'done') {
            await loadProducts(); await loadFullProduct(productId); await loadDepGraph();
          }
        }
        if (done) break;
      }
    } catch { setDesignPhase('Design failed. Please try again.'); }
    setTimeout(() => setDesigning(false), 3000);
  };

  // ---------------------------------------------------------------------------
  // Build / run
  // ---------------------------------------------------------------------------

  const handleRunAll = async (productId: number, fullRefresh = false) => {
    setRunningAll(true); setRunError(null);
    try {
      const endpoint = fullRefresh ? `/products/${productId}/run-full` : `/products/${productId}/run`;
      const res = await api.post(endpoint);
      const results = res.data?.data;
      if (Array.isArray(results)) {
        const failed = results.filter((r: { status: string }) => r.status === 'error');
        if (failed.length > 0) setRunError(`${failed.length} table(s) failed.`);
      }
      await loadFullProduct(productId);
    } catch (err: unknown) {
      setRunError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Build failed');
    }
    setRunningAll(false);
  };

  const handleRunTable = async (tableId: number) => {
    setRunningTableId(tableId); setRunError(null);
    try {
      await api.post(`/products/tables/${tableId}/run`);
      if (selectedProduct) await loadFullProduct(selectedProduct.id);
    } catch (err: unknown) {
      setRunError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed');
    }
    setRunningTableId(null);
  };

  const handleApproveTable = async (tableId: number) => {
    try {
      await api.put(`/products/tables/${tableId}/approve`);
      if (selectedProduct) await loadFullProduct(selectedProduct.id);
    } catch { /* ignore */ }
  };

  const handleGenerateSql = async (productId: number) => {
    setGeneratingSql(true);
    try {
      await api.post(`/products/${productId}/generate-sql`);
      await loadFullProduct(productId);
    } catch { /* ignore */ }
    setGeneratingSql(false);
  };

  const handleSaveSql = async (tableId: number, sql: string) => {
    setSavingSql(true);
    try {
      await api.put(`/products/tables/${tableId}`, { transformation_sql: sql });
      setEditingSql(null);
      if (selectedProduct) await loadFullProduct(selectedProduct.id);
    } catch { /* ignore */ }
    setSavingSql(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this data product and all its schemas?')) return;
    try {
      await api.delete(`/products/${id}`);
      if (selectedProduct?.id === id) setSelectedProduct(null);
      await loadProducts(); await loadDepGraph();
    } catch { /* ignore */ }
  };

  const handleSelectProduct = (p: DataProduct) => {
    if (selectedProduct?.id === p.id) { setSelectedProduct(null); return; }
    setShowAdvanced(false); setSelectedTableId(null); setEditingSql(null); setRunError(null);
    loadFullProduct(p.id);
  };

  // ---------------------------------------------------------------------------
  // Derived helpers for selected product
  // ---------------------------------------------------------------------------

  const allTables = selectedProduct?.star_schemas.flatMap((s) => s.tables) ?? [];
  const hasSql = allTables.some((t) => t.transformation_sql);
  const isBuilt = ['success', 'approved'].includes(selectedProduct?.status ?? '') && hasSql;
  const totalRows = allTables.reduce((sum, t) => sum + (t.row_count ?? 0), 0);
  const builtTables = allTables.filter((t) => t.transformation_status === 'success').length;
  const selectedTable = allTables.find((t) => t.id === selectedTableId) ?? null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Derived warehouse stats (for the simple hero) — exclude infrastructure (Calendar)
  const hasErrors = products.some((p) => p.status === 'error' && p.name !== 'Calendar');
  // Keep terminal visible after any completed build (success OR error) — never hide the log
  const buildDone = autoBuildLog.length > 0 && !autoBuilding;
  const buildSuccess = autoBuildLog.some((l) => l.msg.startsWith('✓ All done') || l.msg.startsWith('✓ Rebuild'));

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav />

      {/* ── SIMPLE VIEW (default) ──────────────────────────────────────────── */}
      {!showAdvancedView && (
        <div className={`px-6 py-8 ${products.length > 0 && !autoBuilding && !buildDone ? 'max-w-5xl mx-auto' : 'flex flex-col items-center justify-center min-h-[calc(100vh-56px)]'}`}>
          <div className={products.length > 0 && !autoBuilding && !buildDone ? 'w-full' : 'w-full max-w-lg'}>

            {/* Building — live log */}
            {(autoBuilding || buildDone) ? (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {autoBuilding
                      ? <><div className="w-4 h-4 rounded-full border-2 border-violet-500 border-t-transparent animate-spin flex-shrink-0" /><span className="font-semibold text-slate-800">Building your data warehouse…</span></>
                      : buildSuccess
                        ? <><span className="text-emerald-500 text-lg">✓</span><span className="font-semibold text-slate-800">Your data warehouse is ready</span></>
                        : <><span className="text-red-500 text-lg">✗</span><span className="font-semibold text-slate-800">Build failed — see log below</span></>
                    }
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {(autoBuilding || buildDone) && (
                      <span className="text-xs text-slate-400 font-mono">
                        {Math.floor(buildElapsed / 60) > 0 ? `${Math.floor(buildElapsed / 60)}m ` : ''}{buildElapsed % 60}s
                      </span>
                    )}
                    {autoBuilding && (
                      <button
                        onClick={handleCancelBuild}
                        className="text-xs px-3 py-1.5 text-red-400 border border-red-300 rounded-lg hover:bg-red-50 font-medium"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
                <div
                  ref={autoBuildScrollRef}
                  className="bg-slate-900 font-mono text-xs p-5 max-h-[28rem] overflow-y-auto space-y-1"
                >
                  {autoBuildLog.map((entry) => (
                    <div key={entry.id} className={entry.indent ? 'pl-3' : ''}>
                      <div className="flex items-start gap-2">
                        <span className="flex-shrink-0 mt-px w-3 text-center">
                          {entry.status === 'running' && <span className="inline-block w-2.5 h-2.5 border border-violet-400 border-t-transparent rounded-full animate-spin" />}
                          {entry.status === 'success' && <span className="text-emerald-400">✓</span>}
                          {entry.status === 'error'   && <span className="text-red-400">✗</span>}
                          {entry.status === 'info'    && <span className="text-slate-600">·</span>}
                        </span>
                        <span className={
                          entry.status === 'success' ? 'text-emerald-400' :
                          entry.status === 'error'   ? 'text-red-400' :
                          entry.status === 'running' ? 'text-violet-300' :
                          entry.msg.startsWith('─') ? 'text-amber-300 font-bold' :
                          entry.msg.startsWith('💬') ? 'text-slate-400 italic' :
                          'text-slate-400'
                        }>{entry.msg}</span>
                      </div>
                      {entry.sub && (
                        <div className="pl-5 mt-0.5">
                          <span className={`text-[10px] italic line-clamp-2 ${entry.status === 'error' ? 'text-red-500' : 'text-slate-600'}`}>{entry.sub}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {/* AI Reasoning drawer */}
                {reasoningFull && (
                  <div className="border-t border-slate-700 bg-slate-950">
                    <button
                      onClick={() => setShowReasoning((v) => !v)}
                      className="w-full px-5 py-2.5 text-left flex items-center gap-2 hover:bg-slate-900 transition-colors"
                    >
                      <span className="text-[10px] text-emerald-600">{showReasoning ? '▾' : '▸'}</span>
                      <span className="text-xs text-emerald-600 font-mono font-semibold">AI reasoning</span>
                      <span className="text-[10px] text-slate-600 ml-auto font-mono">{(reasoningFull.length / 1000).toFixed(1)}K chars</span>
                    </button>
                    {showReasoning && (
                      <div ref={reasoningScrollRef} className="px-5 pb-4 max-h-64 overflow-y-auto">
                        <pre className="text-[11px] text-emerald-400 font-mono leading-relaxed whitespace-pre-wrap">{reasoningFull}</pre>
                      </div>
                    )}
                  </div>
                )}
                {buildDone && !autoBuilding && (
                  <div className="px-6 py-4 flex gap-3">
                    {buildSuccess ? (
                      <a
                        href="/query"
                        className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 text-center"
                      >
                        Start asking questions →
                      </a>
                    ) : (
                      <button
                        onClick={() => {
                          autoBuildLogRef.current = [];
                          setAutoBuildLog([]);
                          const connId = autoDesignConnId ?? (connections.length === 1 ? connections[0].id : null);
                          if (connId) handleFullAutoBuild(connId);
                        }}
                        className="flex-1 py-2.5 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 text-center"
                      >
                        ↺ Try again
                      </button>
                    )}
                    <button
                      onClick={() => setShowAdvancedView(true)}
                      className="px-4 py-2.5 text-sm text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50"
                    >
                      View details
                    </button>
                  </div>
                )}
              </div>

            /* Warehouse exists — show topic cards */
            ) : products.length > 0 ? (
              <TopicsView
                domainProducts={domainProducts}
                foundationProducts={foundations}
                allDetails={allProductDetails}
                allKpis={allProductKpis}
                loading={loadingTopics}
                hasErrors={hasErrors}
                connections={connections}
                builtConnectionIds={new Set(products.map((p) => p.connection_id))}
                onRebuildAll={handleRebuildAll}
                onShowAdvanced={() => setShowAdvancedView(true)}
                onRebuildTopic={async (productId) => {
                  await api.post(`/products/${productId}/run`);
                  await loadProducts();
                  await loadAllTopics([productId]);
                }}
                onRequestTopic={(connId, description) => {
                  handleSingleTopicBuild(connId, description);
                }}
                onAddSource={(connId) => {
                  handleFullAutoBuild(connId);
                }}
              />

            /* No products yet */
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-8 py-10 text-center border-b border-slate-100">
                  <div className="w-16 h-16 bg-violet-100 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-5">
                    🏗️
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 mb-2">Prepare your data</h2>
                  <p className="text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
                    Claude will analyse your source system, design a clean analytics model, and build it — automatically.
                  </p>
                </div>

                <div className="px-6 py-5 space-y-3">
                  {/* Connection picker — only shown when multiple connections */}
                  {connections.length > 1 && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1.5">Source system</label>
                      <select
                        value={autoDesignConnId ?? ''}
                        onChange={(e) => setAutoDesignConnId(Number(e.target.value))}
                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                      >
                        <option value="">Select a connection…</option>
                        {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}

                  {connections.length === 0 && !loading && (
                    <div className="text-center py-2">
                      <p className="text-sm text-slate-400 mb-3">No data sources connected yet.</p>
                      <a href="/setup" className="text-sm text-blue-600 hover:underline font-medium">Connect a source →</a>
                    </div>
                  )}

                  {connections.length > 0 && (
                    <button
                      onClick={() => {
                        // Use autoDesignConnId if set; fall back to the only connection when there's just one
                        const connId = autoDesignConnId ?? (connections.length === 1 ? connections[0].id : null);
                        if (connId) handleFullAutoBuild(connId);
                      }}
                      disabled={connections.length > 1 && !autoDesignConnId}
                      className="w-full py-3.5 bg-violet-600 text-white font-bold text-base rounded-xl hover:bg-violet-700 disabled:opacity-40 transition-colors"
                    >
                      ⚡ Prepare my data
                    </button>
                  )}

                  <button
                    onClick={() => setShowAdvancedView(true)}
                    className="w-full py-2 text-xs text-slate-400 hover:text-slate-600"
                  >
                    Advanced — manage products manually
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ADVANCED VIEW ──────────────────────────────────────────────────── */}
      {showAdvancedView && (
      <div className="flex h-[calc(100vh-56px)]">
        {/* ── Sidebar ─────────────────────────────────────────────────────── */}
        <aside className="w-64 border-r border-slate-200 bg-white flex flex-col flex-shrink-0">
          {/* Buttons */}
          <div className="p-3 border-b border-slate-100 space-y-1.5">
            <button
              onClick={() => setShowAdvancedView(false)}
              className="w-full text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 px-1 py-0.5"
            >
              ← Back to overview
            </button>
            <div className="flex gap-1.5">
              <button
                onClick={() => { setShowAutoDesign(true); setProposal(null); setBuildResults(null); }}
                className="flex-1 text-xs bg-violet-600 text-white px-2 py-1.5 rounded-lg hover:bg-violet-700 font-medium"
              >
                ✦ Auto-design
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="text-xs bg-slate-800 text-white px-2 py-1.5 rounded-lg hover:bg-slate-900 font-medium"
              >
                + New
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && <p className="p-4 text-xs text-slate-400">Loading…</p>}

            {/* Foundations section */}
            {foundations.length > 0 && (
              <div>
                <div className="px-3 pt-4 pb-1.5 flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-amber-600">Foundations</span>
                  <span className="text-[10px] text-slate-400">shared dims</span>
                </div>
                {foundations.map((p) => (
                  <SidebarItem
                    key={p.id}
                    product={p}
                    selected={selectedProduct?.id === p.id}
                    onClick={() => handleSelectProduct(p)}
                    icon="🔷"
                  />
                ))}
              </div>
            )}

            {/* Domain products section */}
            <div>
              <div className="px-3 pt-4 pb-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  {foundations.length > 0 ? 'Domain Products' : 'Data Products'}
                </span>
              </div>
              {domainProducts.map((p) => {
                const myDeps = depGraph.filter((d) => d.dependent_product_id === p.id);
                const depsReady = myDeps.every((d) => ['approved', 'success'].includes(products.find((q) => q.id === d.source_product_id)?.status ?? ''));
                return (
                  <SidebarItem
                    key={p.id}
                    product={p}
                    selected={selectedProduct?.id === p.id}
                    onClick={() => handleSelectProduct(p)}
                    icon="📊"
                    warning={myDeps.length > 0 && !depsReady ? 'Foundations not ready' : undefined}
                  />
                );
              })}

              {!loading && products.length === 0 && (
                <p className="px-4 py-6 text-xs text-slate-400 text-center">
                  No data products yet.<br />Use Auto-design or + New.
                </p>
              )}
            </div>
          </div>
        </aside>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          {!selectedProduct && !designing ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center text-3xl mb-4">📦</div>
              <h2 className="text-lg font-semibold text-slate-700">Select a data product</h2>
              <p className="text-sm text-slate-400 mt-1 max-w-sm">
                Select a topic to see its activity tables, reference data, and build status.
              </p>
              <button
                onClick={() => { setShowAutoDesign(true); setProposal(null); setBuildResults(null); }}
                className="mt-6 px-5 py-2.5 bg-violet-600 text-white text-sm rounded-xl font-medium hover:bg-violet-700"
              >
                ✦ Auto-design from source system
              </button>
            </div>
          ) : selectedProduct && (
            <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">

              {/* ── 1. OVERVIEW CARD ─────────────────────────────────────── */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <h1 className="text-xl font-bold text-slate-900 truncate">{selectedProduct.name}</h1>
                      <StatusBadge status={selectedProduct.status} />
                      {foundationIds.has(selectedProduct.id) && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          Foundation
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500">
                      {selectedProduct.description || 'No description — edit to add one'}
                    </p>
                    {isBuilt && (
                      <div className="flex gap-4 mt-3 text-xs text-slate-400">
                        <span>{builtTables}/{allTables.length} tables built</span>
                        {totalRows > 0 && <span>{totalRows.toLocaleString()} total rows</span>}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 flex-shrink-0 items-end">
                    {/* Primary action */}
                    {(selectedProduct.status === 'draft' || selectedProduct.status === 'designing') && !designing && (
                      <button
                        onClick={() => handleDesign(selectedProduct.id)}
                        disabled={designing}
                        className="px-4 py-2 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-700 font-medium flex items-center gap-2"
                      >
                        <span>✨</span> AI Design
                      </button>
                    )}
                    {selectedProduct.status === 'approved' && hasSql && (
                      <button
                        onClick={() => handleRunAll(selectedProduct.id)}
                        disabled={runningAll || !allDepsReady}
                        className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 font-medium disabled:opacity-40 flex items-center gap-2"
                        title={!allDepsReady ? 'Build foundation products first' : undefined}
                      >
                        {runningAll
                          ? <><span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Building…</>
                          : '▶ Build'}
                      </button>
                    )}
                    {selectedProduct.status === 'success' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleRunAll(selectedProduct.id)}
                          disabled={runningAll}
                          className="px-3 py-1.5 bg-emerald-600 text-white text-xs rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {runningAll ? 'Rebuilding…' : '↺ Rebuild'}
                        </button>
                        <button
                          onClick={() => handleRunAll(selectedProduct.id, true)}
                          disabled={runningAll}
                          className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                        >
                          Full Refresh
                        </button>
                      </div>
                    )}
                    {selectedProduct.status === 'error' && (
                      <button
                        onClick={() => handleDesign(selectedProduct.id)}
                        className="px-4 py-2 bg-red-600 text-white text-sm rounded-xl hover:bg-red-700 font-medium"
                      >
                        Retry Design
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(selectedProduct.id)}
                      className="text-xs text-red-500 hover:text-red-700 px-2 py-1"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              {/* ── 2. FOUNDATION DEPENDENCIES ───────────────────────────── */}
              {selectedDeps.length > 0 && (
                <div className={`rounded-2xl border p-5 ${allDepsReady ? 'bg-white border-slate-200' : 'bg-amber-50 border-amber-200'}`}>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                    Requires these foundations first
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {selectedDeps.map(({ product: dep }) => {
                      if (!dep) return null;
                      const ready = ['approved', 'success'].includes(dep.status);
                      return (
                        <div
                          key={dep.id}
                          className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm cursor-pointer transition-colors ${
                            ready
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : 'bg-amber-100 border-amber-300 text-amber-900'
                          }`}
                          onClick={() => handleSelectProduct(dep)}
                          title={ready ? 'Ready' : 'Not built yet — click to open'}
                        >
                          <StatusDot status={dep.status} />
                          <span className="font-medium">{dep.name}</span>
                          {!ready && <span className="text-[10px] text-amber-600 font-semibold">Build first →</span>}
                          {ready && <span className="text-[10px] text-emerald-600">✓</span>}
                        </div>
                      );
                    })}
                  </div>
                  {!allDepsReady && (
                    <p className="mt-3 text-xs text-amber-700">
                      Build the highlighted reference topics first — activity tables need the shared reference data to exist before they can link to it.
                    </p>
                  )}
                </div>
              )}

              {/* ── 3. AI DESIGN PROGRESS ────────────────────────────────── */}
              {designing && (
                <div className="bg-white rounded-2xl border border-blue-200 p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <span className="text-sm font-medium text-blue-700">{designPhase}</span>
                  </div>

                  {(designThinking || designSqlThinking) && (
                    <div className="bg-slate-900 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setShowThinking((v) => !v)}
                        className="w-full px-4 py-2 flex items-center justify-between text-xs text-slate-400 hover:bg-slate-800"
                      >
                        <span>AI reasoning {showThinking ? '(click to collapse)' : '(click to expand)'}</span>
                        <span>{showThinking ? '▲' : '▼'}</span>
                      </button>
                      {showThinking && (
                        <div ref={thinkingRef} className="px-4 pb-3 max-h-48 overflow-y-auto">
                          <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap leading-relaxed">
                            {designSqlThinking || designThinking}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}

                  {skeletonTables.length > 0 && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {skeletonTables.map((tbl, i) => (
                        <div
                          key={i}
                          className={`rounded-xl border-2 p-3 ${tbl.role === 'fact' ? 'border-purple-200 bg-purple-50' : 'border-sky-200 bg-sky-50'}`}
                        >
                          <RolePill role={tbl.role} />
                          <p className="text-sm font-semibold text-slate-800 mt-1.5">
                            {tbl.description || tbl.name
                              .replace(/^(fact_|dim_|bridge_|junk_)/, '')
                              .replace(/_/g, ' ')
                              .replace(/\b\w/g, (c: string) => c.toUpperCase())}
                          </p>
                          {tbl.description && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{tbl.description}</p>}
                        </div>
                      ))}
                      {skeletonTables.length < 3 && Array.from({ length: 3 - skeletonTables.length }).map((_, i) => (
                        <div key={`sk-${i}`} className="rounded-xl border-2 border-dashed border-slate-200 p-3 animate-pulse">
                          <div className="h-4 bg-slate-200 rounded w-16 mb-2" />
                          <div className="h-3 bg-slate-100 rounded w-24" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── 4. STAR SCHEMA (visual + table overview) ─────────────── */}
              {!designing && selectedProduct.star_schemas.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-slate-800">What&apos;s inside</h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {allTables.filter((t) => t.table_role === 'fact').length} activity table(s) ·{' '}
                        {allTables.filter((t) => t.table_role === 'dimension').length} reference table(s)
                        {allTables.some((t) => t.is_shared_dimension) && ' · includes shared reference data'}
                      </p>
                    </div>
                    <button
                      onClick={() => setShowLineage((v) => !v)}
                      className="text-xs text-slate-500 border border-slate-200 rounded-lg px-2.5 py-1 hover:bg-slate-50"
                    >
                      {showLineage ? '← Star diagram' : 'Source lineage →'}
                    </button>
                  </div>

                  {showLineage ? (
                    <div className="h-96">
                      <LineageFlow data={{
                        tables: selectedProduct.star_schemas.flatMap((s) =>
                          s.tables.map((t) => ({
                            id: t.id,
                            table_name: t.table_name,
                            display_name: t.display_name,
                            table_role: t.table_role,
                            columns: (t.columns ?? []).map((c) => ({
                              id: c.id,
                              column_name: c.column_name,
                              data_type: c.data_type,
                              column_role: c.column_role,
                              lineage: c.lineage ?? [],
                            })),
                          }))
                        ),
                      }} />
                    </div>
                  ) : (
                    <div className="p-5 space-y-4">
                      {selectedProduct.star_schemas.map((schema) => (
                        <StarVisual
                          key={schema.id}
                          schema={schema}
                          onClickTable={(id) => { setSelectedTableId(id); setShowAdvanced(true); }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Empty state after design ──────────────────────────────── */}
              {!designing && selectedProduct.star_schemas.length === 0 && (
                <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center">
                  <p className="text-slate-400 text-sm">No schema designed yet.</p>
                  <p className="text-slate-300 text-xs mt-1">Click AI Design above to generate the star schema.</p>
                </div>
              )}

              {/* ── 5. BUILD STATUS ──────────────────────────────────────── */}
              {!designing && hasSql && (
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-slate-800">Build status</h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {builtTables} of {allTables.filter(t => t.transformation_sql).length} tables built
                        {totalRows > 0 && ` · ${totalRows.toLocaleString()} rows`}
                      </p>
                    </div>
                    <button
                      onClick={() => setShowAdvanced((v) => !v)}
                      className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2 py-1"
                    >
                      {showAdvanced ? 'Hide advanced' : '⚙ Advanced SQL'}
                    </button>
                  </div>

                  {runError && (
                    <div className="mx-5 mt-4 flex items-center justify-between bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-sm text-red-700">
                      <span>{runError}</span>
                      <button onClick={() => setRunError(null)} className="ml-3 text-red-400 hover:text-red-600">✕</button>
                    </div>
                  )}

                  {/* Table status rows */}
                  <div className="divide-y divide-slate-50 px-2 py-2">
                    {allTables
                      .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name))
                      .filter((t) => t.transformation_sql || t.is_shared_dimension)
                      .map((tbl) => {
                        const isRunningThis = runningTableId === tbl.id || (runningAll && !!tbl.transformation_sql && !tbl.is_shared_dimension);
                        return (
                          <div key={tbl.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50">
                            <RolePill role={tbl.table_role} shared={tbl.is_shared_dimension} />
                            <span className="text-sm text-slate-700 flex-1">{friendlyName(tbl)}</span>
                            {tbl.row_count !== null && (
                              <span className="text-xs text-slate-400">{tbl.row_count.toLocaleString()} rows</span>
                            )}
                            {tbl.last_run_error && !isRunningThis && (
                              <span className="text-[10px] text-red-500 max-w-[120px] truncate" title={tbl.last_run_error}>
                                {tbl.last_run_error}
                              </span>
                            )}
                            {isRunningThis
                              ? <span className="w-3.5 h-3.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                              : tbl.is_shared_dimension
                                ? <span className="text-[10px] text-amber-600">shared reference</span>
                                : <StatusDot status={tbl.transformation_status} />
                            }
                            {!tbl.is_shared_dimension && !runningAll && tbl.transformation_sql && (
                              <button
                                onClick={() => handleRunTable(tbl.id)}
                                disabled={!!runningTableId}
                                className="text-[10px] px-2 py-1 text-slate-500 border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-40"
                              >
                                Run
                              </button>
                            )}
                          </div>
                        );
                      })}
                  </div>

                  {/* Advanced SQL editor */}
                  {showAdvanced && (
                    <AdvancedSqlEditor
                      tables={allTables}
                      selectedTableId={selectedTableId}
                      editingSql={editingSql}
                      savingSql={savingSql}
                      generatingSql={generatingSql}
                      onSelectTable={(id) => { setSelectedTableId(id); setEditingSql(null); }}
                      onEditSql={setEditingSql}
                      onSaveSql={handleSaveSql}
                      onApprove={handleApproveTable}
                      onGenerateSql={selectedProduct ? () => handleGenerateSql(selectedProduct.id) : undefined}
                      onLoadMode={async (tableId, mode) => {
                        try {
                          await api.patch(`/products/tables/${tableId}/load-mode`, { load_mode: mode });
                          if (selectedProduct) await loadFullProduct(selectedProduct.id);
                        } catch { /* ignore */ }
                      }}
                    />
                  )}

                  {/* Schedule (approved/success products) */}
                  {['approved', 'success'].includes(selectedProduct.status) && (
                    <div className="px-5 pb-5 pt-2">
                      <SchedulePanel productId={selectedProduct.id} />
                    </div>
                  )}
                </div>
              )}

              {/* ── 6. BUSINESS METRICS (KPIs) ───────────────────────────── */}
              {!designing && selectedProduct.star_schemas.length > 0 && (
                <KpisSection product={selectedProduct} onRefresh={() => loadFullProduct(selectedProduct.id)} />
              )}

            </div>
          )}
        </main>
      </div>
      )} {/* end showAdvancedView */}

      {/* ── Auto-design modal ────────────────────────────────────────────── */}
      {showAutoDesign && (
        <AutoDesignModal
          connections={connections}
          connId={autoDesignConnId}
          onConnId={(id) => { setAutoDesignConnId(id); setProposal(null); setBuildResults(null); }}
          proposing={proposing}
          proposal={proposal}
          proposeError={proposeError}
          building={building}
          buildResults={buildResults}
          onPropose={handlePropose}
          onBuild={handleBuildProposed}
          autoBuilding={autoBuilding}
          autoBuildLog={autoBuildLog}
          autoBuildScrollRef={autoBuildScrollRef}
          onFullBuild={handleFullAutoBuild}
          onClose={() => { if (!autoBuilding) setShowAutoDesign(false); }}
        />
      )}

      {/* ── Create modal ─────────────────────────────────────────────────── */}
      {showCreate && (
        <CreateModal
          connections={connections}
          connId={createConnId}
          name={createName}
          desc={createDesc}
          availableSources={availableSources}
          selectedSources={selectedSources}
          creating={creating}
          onConnId={handleConnectionSelect}
          onName={setCreateName}
          onDesc={setCreateDesc}
          onToggleSource={(id) => setSelectedSources((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; })}
          onSelectAll={() => setSelectedSources(new Set(availableSources.map((s) => s.id)))}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StarVisual — clean Kimball star diagram (no ReactFlow, no clutter)
// ---------------------------------------------------------------------------

interface SchemaWithTables {
  id: number;
  name: string;
  grain: string | null;
  fact_table_type: string;
  tables: ProductTable[];
}

function StarVisual({
  schema,
  onClickTable,
}: {
  schema: SchemaWithTables;
  onClickTable: (id: number) => void;
}) {
  const facts = schema.tables.filter((t) => t.table_role === 'fact');
  const dims = schema.tables.filter((t) => t.table_role === 'dimension' || t.table_role === 'junk' || t.table_role === 'bridge');

  // Split dims into two halves so they flank the fact table(s)
  const half = Math.ceil(dims.length / 2);
  const leftDims = dims.slice(0, half);
  const rightDims = dims.slice(half);

  return (
    <div className="select-none">
      {/* Schema grain label */}
      {schema.grain && (
        <p className="text-xs text-slate-400 mb-4 italic">
          <span className="font-semibold text-slate-500">Grain:</span> {schema.grain}
        </p>
      )}

      <div className="flex items-center gap-3">
        {/* Left dimensions */}
        {leftDims.length > 0 && (
          <div className="flex flex-col gap-2 flex-shrink-0" style={{ minWidth: 160 }}>
            {leftDims.map((dim) => (
              <DimChip key={dim.id} table={dim} onClick={() => onClickTable(dim.id)} />
            ))}
          </div>
        )}

        {/* Connectors left → fact */}
        {leftDims.length > 0 && (
          <div className="flex flex-col justify-center flex-shrink-0" style={{ width: 32 }}>
            {leftDims.map((_, i) => (
              <div key={i} className="flex items-center" style={{ height: 36, marginBottom: i < leftDims.length - 1 ? 8 : 0 }}>
                <div className="flex-1 border-t-2 border-dashed border-slate-200" />
                <div className="w-0 h-0 border-t-4 border-b-4 border-l-6 border-transparent border-l-slate-300" style={{ borderLeftWidth: 6 }} />
              </div>
            ))}
          </div>
        )}

        {/* Fact table(s) */}
        <div className="flex flex-col gap-2 flex-1">
          {facts.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
              No activity data designed yet
            </div>
          ) : (
            facts.map((fact) => (
              <button
                key={fact.id}
                onClick={() => onClickTable(fact.id)}
                className="w-full text-left rounded-xl bg-gradient-to-br from-purple-600 to-purple-700 text-white p-4 hover:from-purple-700 hover:to-purple-800 transition-colors shadow-sm"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">⚡ Activity</span>
                  <StatusDot status={fact.transformation_status} />
                </div>
                <p className="font-semibold text-base leading-tight">{fact.display_name || fact.table_name}</p>
                {fact.description && (
                  <p className="text-xs opacity-70 mt-1.5 leading-relaxed line-clamp-2">{fact.description}</p>
                )}
                {fact.row_count !== null && (
                  <p className="text-xs opacity-50 mt-2">{fact.row_count.toLocaleString()} rows</p>
                )}
              </button>
            ))
          )}
        </div>

        {/* Connectors fact → right */}
        {rightDims.length > 0 && (
          <div className="flex flex-col justify-center flex-shrink-0" style={{ width: 32 }}>
            {rightDims.map((_, i) => (
              <div key={i} className="flex items-center" style={{ height: 36, marginBottom: i < rightDims.length - 1 ? 8 : 0 }}>
                <div className="w-0 h-0 border-t-4 border-b-4 border-r-6 border-transparent border-r-slate-300" style={{ borderRightWidth: 6 }} />
                <div className="flex-1 border-t-2 border-dashed border-slate-200" />
              </div>
            ))}
          </div>
        )}

        {/* Right dimensions */}
        {rightDims.length > 0 && (
          <div className="flex flex-col gap-2 flex-shrink-0" style={{ minWidth: 160 }}>
            {rightDims.map((dim) => (
              <DimChip key={dim.id} table={dim} onClick={() => onClickTable(dim.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-5 pt-4 border-t border-slate-100">
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <span className="w-3 h-3 rounded bg-purple-600" />
          ⚡ Activity (transactions &amp; events)
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <span className="w-3 h-3 rounded bg-sky-200 border border-sky-300" />
          📋 Reference (descriptive data)
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <span className="w-3 h-3 rounded bg-amber-200 border border-amber-300" />
          ⟳ Shared reference
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 ml-auto">
          <StatusDot status="success" /> Built
          <StatusDot status="draft" /> Not built
          <StatusDot status="error" /> Error
        </div>
      </div>
    </div>
  );
}

function DimChip({ table, onClick }: { table: ProductTable; onClick: () => void }) {
  const isShared = table.is_shared_dimension;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border-2 px-3 py-2 transition-colors group ${
        isShared
          ? 'bg-amber-50 border-amber-200 hover:border-amber-400'
          : 'bg-sky-50 border-sky-200 hover:border-sky-400'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isShared && <span className="text-amber-500 text-xs flex-shrink-0" title="Shared reference data">⟳</span>}
          <span className={`text-xs font-medium truncate ${isShared ? 'text-amber-800' : 'text-sky-800'}`}>
            {friendlyName(table)}
          </span>
        </div>
        <StatusDot status={isShared ? 'success' : table.transformation_status} />
      </div>
      {isShared && (
        <p className="text-[9px] text-amber-500 mt-0.5">⟳ shared reference data</p>
      )}
      {table.row_count !== null && !isShared && (
        <p className="text-[9px] text-slate-400 mt-0.5">{table.row_count.toLocaleString()} rows</p>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sidebar item
// ---------------------------------------------------------------------------

function SidebarItem({
  product, selected, onClick, icon, warning,
}: {
  product: DataProduct;
  selected: boolean;
  onClick: () => void;
  icon: string;
  warning?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-slate-50 transition-colors ${selected ? 'bg-blue-50 border-r-2 border-blue-500' : ''}`}
    >
      <span className="text-base leading-none flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${selected ? 'text-blue-700' : 'text-slate-800'}`}>{product.name}</p>
        {warning && <p className="text-[10px] text-amber-600 truncate">{warning}</p>}
      </div>
      <StatusDot status={product.status} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Advanced SQL editor (admin tool, hidden by default)
// ---------------------------------------------------------------------------

function AdvancedSqlEditor({
  tables, selectedTableId, editingSql, savingSql, generatingSql,
  onSelectTable, onEditSql, onSaveSql, onApprove, onGenerateSql, onLoadMode,
}: {
  tables: ProductTable[];
  selectedTableId: number | null;
  editingSql: string | null;
  savingSql: boolean;
  generatingSql: boolean;
  onSelectTable: (id: number) => void;
  onEditSql: (sql: string) => void;
  onSaveSql: (tableId: number, sql: string) => void;
  onApprove: (tableId: number) => void;
  onGenerateSql?: () => void;
  onLoadMode: (tableId: number, mode: string) => void;
}) {
  const selected = tables.find((t) => t.id === selectedTableId) ?? null;

  return (
    <div className="border-t border-slate-100 bg-slate-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">SQL Editor</p>
        {onGenerateSql && (
          <button
            onClick={onGenerateSql}
            disabled={generatingSql}
            className="text-xs px-2 py-1 bg-amber-100 text-amber-700 rounded hover:bg-amber-200 disabled:opacity-50"
          >
            {generatingSql ? 'Generating…' : '↺ Regenerate SQL'}
          </button>
        )}
      </div>

      <div className="flex gap-3">
        {/* Table selector */}
        <div className="w-44 flex-shrink-0 space-y-1">
          {tables.map((tbl) => (
            <button
              key={tbl.id}
              onClick={() => onSelectTable(tbl.id)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 transition-colors ${
                selectedTableId === tbl.id ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-600'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                tbl.transformation_status === 'success' ? 'bg-emerald-500' :
                tbl.transformation_status === 'error' ? 'bg-red-500' :
                tbl.transformation_status === 'approved' ? 'bg-amber-400' : 'bg-slate-300'
              }`} />
              <span className="truncate font-mono">{tbl.table_name}</span>
            </button>
          ))}
        </div>

        {/* SQL panel */}
        {selected ? (
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <span className="text-xs text-slate-500 font-mono">{selected.table_name}</span>
                <select
                  value={selected.load_mode ?? 'full'}
                  onChange={(e) => onLoadMode(selected.id, e.target.value)}
                  className="text-xs border border-slate-200 rounded px-1.5 py-0.5 bg-white text-slate-500"
                >
                  <option value="full">Full refresh</option>
                  <option value="incremental">Incremental</option>
                </select>
              </div>
              <div className="flex gap-1.5">
                {selected.transformation_status === 'draft' && (
                  <button
                    onClick={() => onApprove(selected.id)}
                    className="text-xs px-2.5 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700"
                  >
                    Approve
                  </button>
                )}
                {editingSql !== null ? (
                  <>
                    <button
                      onClick={() => onSaveSql(selected.id, editingSql)}
                      disabled={savingSql}
                      className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      {savingSql ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => onEditSql(selected.transformation_sql ?? '')} className="text-xs px-2 py-1 text-slate-500 border border-slate-200 rounded hover:bg-slate-100">
                      Cancel
                    </button>
                  </>
                ) : selected.transformation_sql ? (
                  <button onClick={() => onEditSql(selected.transformation_sql!)} className="text-xs px-2 py-1 text-slate-600 border border-slate-200 rounded hover:bg-slate-100">
                    Edit SQL
                  </button>
                ) : null}
              </div>
            </div>

            {selected.is_shared_dimension ? (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-700">
                ⟳ This is shared reference data owned by another topic. Its SQL is managed there.
              </div>
            ) : editingSql !== null ? (
              <textarea
                value={editingSql}
                onChange={(e) => onEditSql(e.target.value)}
                className="w-full h-48 font-mono text-xs border border-slate-300 rounded-lg p-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            ) : selected.transformation_sql ? (
              <pre className="text-xs font-mono bg-slate-900 text-emerald-400 rounded-lg p-3 overflow-auto max-h-48 leading-relaxed">
                {selected.transformation_sql}
              </pre>
            ) : (
              <div className="bg-white border border-dashed border-slate-300 rounded-lg p-4 text-center text-xs text-slate-400">
                No SQL generated yet
              </div>
            )}

            {selected.last_run_error && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-600 font-mono">
                {selected.last_run_error}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
            Select a table to view its SQL
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs section
// ---------------------------------------------------------------------------

function KpisSection({ product, onRefresh }: { product: FullDataProduct; onRefresh: () => void }) {
  const [kpis, setKpis] = useState<ProductKpi[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingKpi, setEditingKpi] = useState<ProductKpi | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPlainText, setFormPlainText] = useState('');
  const [formSql, setFormSql] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const res = await api.get(`/products/${product.id}/kpis`); setKpis(res.data.data ?? []); } catch { /* ignore */ }
    setLoading(false);
  }, [product.id]);

  useEffect(() => { load(); }, [load]);

  const reset = () => { setFormName(''); setFormDesc(''); setFormPlainText(''); setFormSql(''); setEditingKpi(null); setShowAdd(false); };

  const openEdit = (k: ProductKpi) => {
    setEditingKpi(k); setFormName(k.name); setFormDesc(k.description ?? '');
    setFormPlainText(k.formula_plain_text ?? ''); setFormSql(k.formula_sql ?? ''); setShowAdd(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      if (editingKpi) {
        await api.put(`/products/kpis/${editingKpi.id}`, { name: formName, description: formDesc || null, formula_plain_text: formPlainText || null, formula_sql: formSql || null, ai_draft: false });
      } else {
        await api.post(`/products/${product.id}/kpis`, { name: formName, description: formDesc || undefined, formulaPlainText: formPlainText || undefined, formulaSql: formSql || undefined });
      }
      reset(); await load(); onRefresh();
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this metric?')) return;
    try { await api.delete(`/products/kpis/${id}`); await load(); onRefresh(); } catch { /* ignore */ }
  };

  const handleApprove = async (k: ProductKpi) => {
    try { await api.put(`/products/kpis/${k.id}`, { ai_draft: false }); await load(); } catch { /* ignore */ }
  };

  const tableNames = product.star_schemas.flatMap((s) => s.tables.map((t) => t.table_name));

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-800">Business Metrics</h2>
          <p className="text-xs text-slate-400 mt-0.5">KPIs and measures for this data product</p>
        </div>
        <button
          onClick={() => { reset(); setShowAdd(true); }}
          className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
        >
          + Add metric
        </button>
      </div>

      {loading && <p className="p-5 text-xs text-slate-400">Loading metrics…</p>}

      {!loading && kpis.length === 0 && (
        <div className="p-8 text-center">
          <p className="text-slate-400 text-sm">No metrics defined yet.</p>
          <p className="text-xs text-slate-300 mt-1">Metrics proposed by AI during design will appear here automatically.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
        {kpis.map((kpi) => (
          <div key={kpi.id} className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-slate-800 text-sm">{kpi.name}</h3>
                {kpi.ai_draft && (
                  <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">AI Draft</span>
                )}
              </div>
              <div className="flex gap-1">
                {kpi.ai_draft && (
                  <button onClick={() => handleApprove(kpi)} className="text-[10px] px-2 py-1 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200">Approve</button>
                )}
                <button onClick={() => openEdit(kpi)} className="text-[10px] px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200">Edit</button>
                <button onClick={() => handleDelete(kpi.id)} className="text-[10px] px-2 py-1 bg-red-50 text-red-500 rounded hover:bg-red-100">✕</button>
              </div>
            </div>
            {kpi.description && <p className="text-xs text-slate-500 mb-2">{kpi.description}</p>}
            {kpi.formula_plain_text && (
              <p className="text-xs text-slate-600 bg-slate-50 rounded px-2 py-1.5 mb-1">{kpi.formula_plain_text}</p>
            )}
            {kpi.formula_sql && (
              <pre className="text-[10px] font-mono bg-slate-900 text-emerald-400 rounded px-2 py-1.5 overflow-x-auto">{kpi.formula_sql}</pre>
            )}
          </div>
        ))}
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <h3 className="text-base font-bold text-slate-900 mb-4">{editingKpi ? 'Edit metric' : 'New metric'}</h3>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Name</label>
            <input value={formName} onChange={(e) => setFormName(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3" placeholder="e.g. Gross Margin, Revenue per Customer" />
            <label className="block text-xs font-semibold text-slate-600 mb-1">Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3" rows={2} placeholder="What does this metric measure?" />
            <label className="block text-xs font-semibold text-slate-600 mb-1">Business definition (plain English)</label>
            <input value={formPlainText} onChange={(e) => setFormPlainText(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3" placeholder="e.g. Revenue minus cost of goods sold" />
            <label className="block text-xs font-semibold text-slate-600 mb-1">SQL formula</label>
            <textarea value={formSql} onChange={(e) => setFormSql(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono mb-3" rows={3} placeholder="e.g. SUM(f.revenue) - SUM(f.cogs)" />
            <p className="text-[10px] text-slate-400 mb-4">Available tables: {tableNames.join(', ')}</p>
            <div className="flex justify-end gap-2">
              <button onClick={reset} className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleSave} disabled={!formName.trim() || saving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving…' : editingKpi ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-design modal
// ---------------------------------------------------------------------------

interface LogEntry { id: number; key?: string; msg: string; sub?: string; status: 'info' | 'success' | 'error' | 'running'; indent: boolean; }

function AutoDesignModal({
  connections, connId, onConnId, proposing, proposal, proposeError, building, buildResults,
  onPropose, onBuild, autoBuilding, autoBuildLog, autoBuildScrollRef, onFullBuild, onClose,
}: {
  connections: Connection[];
  connId: number | null;
  onConnId: (id: number) => void;
  proposing: boolean;
  proposal: DataProductProposal | null;
  proposeError: string | null;
  building: boolean;
  buildResults: Array<{ name: string; id: number; status: string }> | null;
  onPropose: () => void;
  onBuild: () => void;
  autoBuilding: boolean;
  autoBuildLog: LogEntry[];
  autoBuildScrollRef: React.RefObject<HTMLDivElement>;
  onFullBuild: (connId: number) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'choose' | 'auto' | 'review'>('choose');
  const busy = autoBuilding || proposing || building;
  const done = autoBuildLog.some((l) => l.msg.startsWith('✓ All done'));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            {mode !== 'choose' && !busy && (
              <button onClick={() => setMode('choose')} className="text-slate-400 hover:text-slate-600 text-sm">←</button>
            )}
            <div>
              <h3 className="text-lg font-bold text-slate-900">✦ Build your data warehouse</h3>
              <p className="text-sm text-slate-400 mt-0.5">
                {mode === 'choose' && 'Claude designs and builds everything from your source system.'}
                {mode === 'auto' && (autoBuilding ? 'Building your warehouse — this takes a few minutes…' : done ? 'Your data warehouse is ready.' : 'Full auto-build')}
                {mode === 'review' && 'Review the proposal before building.'}
              </p>
            </div>
          </div>
          {!busy && <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">×</button>}
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">

          {/* Connection selector — always visible */}
          {(mode === 'choose' || (mode !== 'auto' || !autoBuilding)) && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Source system</label>
              <select
                value={connId ?? ''}
                onChange={(e) => onConnId(Number(e.target.value))}
                disabled={busy}
                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 disabled:opacity-60"
              >
                <option value="">Select a connection…</option>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {/* ── MODE: CHOOSE ─────────────────────────────────────────────── */}
          {mode === 'choose' && (
            <div className="space-y-3 pt-1">
              {/* Full auto-build — primary */}
              <button
                disabled={!connId}
                onClick={() => { setMode('auto'); onFullBuild(connId!); }}
                className="w-full text-left rounded-2xl border-2 border-violet-300 bg-violet-50 hover:border-violet-500 hover:bg-violet-100 disabled:opacity-40 disabled:pointer-events-none transition-colors p-5 group"
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center text-xl flex-shrink-0 group-hover:scale-105 transition-transform">
                    ⚡
                  </div>
                  <div>
                    <p className="font-bold text-slate-900 text-base">Build everything automatically</p>
                    <p className="text-sm text-slate-500 mt-1">
                      Claude designs all data products, generates transformation SQL, and builds the warehouse — in the right order, automatically. No decisions needed.
                    </p>
                    <p className="text-xs text-violet-600 font-medium mt-2">Recommended · takes ~5–10 minutes</p>
                  </div>
                </div>
              </button>

              {/* Review first — secondary */}
              <button
                disabled={!connId}
                onClick={() => { setMode('review'); onPropose(); }}
                className="w-full text-left rounded-2xl border-2 border-slate-200 bg-white hover:border-slate-300 disabled:opacity-40 disabled:pointer-events-none transition-colors p-5"
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center text-xl flex-shrink-0">
                    🔍
                  </div>
                  <div>
                    <p className="font-bold text-slate-800 text-base">Review proposal first</p>
                    <p className="text-sm text-slate-400 mt-1">
                      See exactly what Claude will build — topics, reference tables, activity tables — before committing. Good for advanced users.
                    </p>
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* ── MODE: AUTO-BUILD ─────────────────────────────────────────── */}
          {mode === 'auto' && (
            <div>
              <div
                ref={autoBuildScrollRef}
                className="bg-slate-900 rounded-2xl p-4 font-mono text-xs space-y-1.5 max-h-96 overflow-y-auto"
              >
                {autoBuildLog.length === 0 && (
                  <span className="text-slate-500">Initialising…</span>
                )}
                {autoBuildLog.map((entry) => (
                  <div key={entry.id} className={`flex items-start gap-2 ${entry.indent ? 'pl-4' : ''}`}>
                    <span className="flex-shrink-0 mt-px">
                      {entry.status === 'running' && <span className="inline-block w-3 h-3 border border-violet-400 border-t-transparent rounded-full animate-spin" />}
                      {entry.status === 'success' && <span className="text-emerald-400">✓</span>}
                      {entry.status === 'error' && <span className="text-red-400">✗</span>}
                      {entry.status === 'info' && <span className="text-slate-500">·</span>}
                    </span>
                    <span className={
                      entry.status === 'success' ? 'text-emerald-400' :
                      entry.status === 'error' ? 'text-red-400' :
                      entry.status === 'running' ? 'text-violet-300' :
                      entry.msg.startsWith('🔷') || entry.msg.startsWith('📊') ? 'text-amber-300 font-bold' :
                      'text-slate-300'
                    }>
                      {entry.msg}
                    </span>
                  </div>
                ))}
                {autoBuilding && (
                  <div className="flex items-center gap-2 text-slate-500 pt-1">
                    <span className="inline-block w-3 h-3 border border-slate-500 border-t-transparent rounded-full animate-spin" />
                    <span>Working…</span>
                  </div>
                )}
              </div>

              {done && (
                <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-700 font-medium text-center">
                  Your data warehouse is ready. Go to <strong>Ask</strong> to start querying it.
                </div>
              )}
            </div>
          )}

          {/* ── MODE: REVIEW ─────────────────────────────────────────────── */}
          {mode === 'review' && (
            <div className="space-y-4">
              {proposing && (
                <div className="flex items-center gap-3 py-4 text-slate-500 text-sm">
                  <span className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                  Claude is analysing your source schema…
                </div>
              )}

              {proposeError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{proposeError}</div>
              )}

              {proposal && !buildResults && (
                <div className="space-y-4">
                  <div className="bg-violet-50 border border-violet-100 rounded-xl p-4 text-sm text-slate-600 italic">{proposal.rationale}</div>

                  {proposal.shared_dimensions.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-amber-600 mb-2">⟳ Shared reference data (built once, used everywhere)</p>
                      <div className="flex flex-wrap gap-2">
                        {proposal.shared_dimensions.map((sd) => {
                          const friendly = sd.table_name
                            .replace(/^(dim_|fact_)/, '')
                            .replace(/_/g, ' ')
                            .replace(/\b\w/g, (c) => c.toUpperCase());
                          return (
                            <span key={sd.table_name} className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-full px-3 py-1">
                              {friendly} <span className="text-amber-500">↔ {sd.owner_product_name}</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{proposal.data_products.length} topics</p>
                    {[...proposal.data_products].sort((a, b) => a.build_order - b.build_order).map((dp) => {
                      const allTbls = dp.star_schemas.flatMap((ss) => ss.tables);
                      return (
                        <div key={dp.name} className="border border-slate-200 rounded-xl p-4">
                          <div className="flex items-start gap-3">
                            <span className="text-[10px] bg-slate-100 text-slate-500 rounded px-1.5 py-0.5 font-mono flex-shrink-0 mt-0.5">#{dp.build_order}</span>
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-slate-900 text-sm">{dp.name}</p>
                              <p className="text-xs text-slate-500">{dp.description}</p>
                              {dp.depends_on.length > 0 && (
                                <p className="text-xs text-violet-600 mt-1">Uses reference data from: {dp.depends_on.map((d) => d.source_product_name).join(', ')}</p>
                              )}
                            </div>
                            <div className="flex gap-1 flex-shrink-0">
                              <span className="text-[10px] bg-purple-100 text-purple-700 rounded px-2 py-0.5">⚡ {allTbls.filter((t) => t.table_role === 'fact').length} activity</span>
                              <span className="text-[10px] bg-sky-100 text-sky-700 rounded px-2 py-0.5">📋 {allTbls.filter((t) => t.table_role === 'dimension').length} reference</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {buildResults && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-emerald-700">✓ {buildResults.length} products created as drafts</p>
                  {buildResults.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-sm">
                      <span className="text-emerald-500">✓</span>
                      <span className="font-medium text-slate-800">{r.name}</span>
                    </div>
                  ))}
                  <p className="text-xs text-slate-500 pt-1">Products created. Select each in the sidebar and click <strong>AI Design</strong> to generate SQL, foundations first.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex justify-between items-center flex-shrink-0">
          <button
            onClick={onClose}
            disabled={autoBuilding}
            className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40"
          >
            {done ? 'Close' : 'Cancel'}
          </button>

          {mode === 'review' && proposal && !buildResults && (
            <button
              onClick={onBuild}
              disabled={building}
              className="px-5 py-2 bg-violet-600 text-white text-sm rounded-xl hover:bg-violet-700 disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {building && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {building ? 'Creating…' : `Create ${proposal.data_products.length} products`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

function CreateModal({
  connections, connId, name, desc, availableSources, selectedSources, creating,
  onConnId, onName, onDesc, onToggleSource, onSelectAll, onCreate, onClose,
}: {
  connections: Connection[];
  connId: number | null;
  name: string;
  desc: string;
  availableSources: SourceTable[];
  selectedSources: Set<number>;
  creating: boolean;
  onConnId: (id: number) => void;
  onName: (v: string) => void;
  onDesc: (v: string) => void;
  onToggleSource: (id: number) => void;
  onSelectAll: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto">
        <h3 className="text-base font-bold text-slate-900 mb-4">New data product</h3>
        <label className="block text-xs font-semibold text-slate-600 mb-1">Name</label>
        <input value={name} onChange={(e) => onName(e.target.value)} className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm mb-3" placeholder="e.g. Sales, Finance, HR" />
        <label className="block text-xs font-semibold text-slate-600 mb-1">Description</label>
        <textarea value={desc} onChange={(e) => onDesc(e.target.value)} className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm mb-3" rows={2} placeholder="What business domain does this cover?" />
        <label className="block text-xs font-semibold text-slate-600 mb-1">Source connection</label>
        <select value={connId ?? ''} onChange={(e) => onConnId(Number(e.target.value))} className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm mb-3">
          <option value="">Select a connection…</option>
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {connId && (
          <>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-600">Source tables</label>
              <button onClick={onSelectAll} className="text-xs text-blue-600 hover:underline">Select all</button>
            </div>
            <div className="border border-slate-200 rounded-xl max-h-44 overflow-y-auto">
              {availableSources.map((s) => (
                <label key={s.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                  <input type="checkbox" checked={selectedSources.has(s.id)} onChange={() => onToggleSource(s.id)} className="rounded border-slate-300" />
                  <span className="text-sm text-slate-700 font-mono">{s.table_name}</span>
                </label>
              ))}
              {availableSources.length === 0 && <p className="p-3 text-xs text-slate-400">No tables found</p>}
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50">Cancel</button>
          <button
            onClick={onCreate}
            disabled={!name.trim() || !connId || selectedSources.size === 0 || creating}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topic cards — "What can I ask about?" simple view
// ---------------------------------------------------------------------------

function productIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('sales') || n.includes('revenue') || n.includes('order')) return '💰';
  if (n.includes('customer') || n.includes('client') || n.includes('crm')) return '👥';
  if (n.includes('product') || n.includes('article') || n.includes('item') || n.includes('catalogue')) return '📦';
  if (n.includes('supplier') || n.includes('vendor') || n.includes('purchas')) return '🏭';
  if (n.includes('hr') || n.includes('employee') || n.includes('staff') || n.includes('payroll') || n.includes('people')) return '🧑‍💼';
  if (n.includes('finance') || n.includes('accounting') || n.includes('budget') || n.includes('cost')) return '📊';
  if (n.includes('inventory') || n.includes('stock') || n.includes('warehouse') || n.includes('logistic')) return '🏪';
  if (n.includes('market') || n.includes('campaign') || n.includes('lead')) return '📣';
  if (n.includes('delivery') || n.includes('ship') || n.includes('transport')) return '🚚';
  if (n.includes('project') || n.includes('task') || n.includes('time') || n.includes('hour')) return '📋';
  return '📈';
}

function cleanTopicName(name: string): string {
  return name
    .replace(/\s+(Analytics|360|Domain|Product|Data Product|Kimball)$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// TopicSqlModal — shows transformation SQL for all tables in a product
// ---------------------------------------------------------------------------
function TopicSqlModal({
  detail,
  onClose,
}: {
  detail: FullDataProduct;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  const allTables = detail.star_schemas.flatMap((s) => s.tables);

  const handleCopy = (tableId: number, sql: string) => {
    try {
      navigator.clipboard.writeText(sql);
    } catch {
      const el = document.createElement('textarea');
      el.value = sql;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(tableId);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="font-bold text-slate-900">Transformation SQL</h2>
            <p className="text-xs text-slate-400 mt-0.5">{allTables.length} table{allTables.length !== 1 ? 's' : ''} · DuckDB</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>
        <div className="overflow-y-auto flex-1">
          {allTables.map((tbl) => (
            <div key={tbl.id} className="border-b border-slate-100 last:border-0">
              <div className="px-6 py-3 flex items-center gap-3 bg-slate-50">
                <RolePill role={tbl.table_role} shared={tbl.is_shared_dimension} />
                <span className="font-mono text-sm font-semibold text-slate-700">{tbl.table_name}</span>
                {tbl.transformation_sql && (
                  <button
                    onClick={() => handleCopy(tbl.id, tbl.transformation_sql!)}
                    className="ml-auto text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2 py-0.5"
                  >
                    {copied === tbl.id ? '✓ Copied' : 'Copy'}
                  </button>
                )}
              </div>
              {tbl.transformation_sql ? (
                <pre className="px-6 py-4 text-[11px] font-mono text-slate-600 overflow-x-auto leading-relaxed bg-white whitespace-pre-wrap">{tbl.transformation_sql}</pre>
              ) : tbl.is_shared_dimension ? (
                <p className="px-6 py-4 text-xs text-amber-600 italic">Shared reference table — SQL lives in the owning topic.</p>
              ) : (
                <p className="px-6 py-4 text-xs text-slate-400 italic">No SQL generated yet.</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopicSlideOver — right-side panel showing full product details on card click
// ---------------------------------------------------------------------------
function TopicSlideOver({
  product,
  detail,
  kpis,
  onClose,
  onRebuild,
}: {
  product: DataProduct;
  detail: FullDataProduct | undefined;
  kpis: ProductKpi[];
  onClose: () => void;
  onRebuild: (productId: number) => void;
}) {
  const [expandedSql, setExpandedSql] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const name = cleanTopicName(product.name);
  const allTables = detail?.star_schemas.flatMap((s) => s.tables) ?? [];

  const handleCopy = (tableId: number, sql: string) => {
    try {
      navigator.clipboard.writeText(sql);
    } catch {
      const el = document.createElement('textarea');
      el.value = sql;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(tableId);
    setTimeout(() => setCopied(null), 1500);
  };

  const toggleSql = (tableId: number) => {
    setExpandedSql((prev) => {
      const next = new Set(prev);
      next.has(tableId) ? next.delete(tableId) : next.add(tableId);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative w-[480px] max-w-full bg-white shadow-2xl flex flex-col overflow-hidden animate-slide-in-right">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-start gap-4 flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-xl flex-shrink-0">
            {productIcon(product.name)}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-slate-900 text-lg leading-tight">{name}</h2>
            {product.description && (
              <p className="text-sm text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{product.description}</p>
            )}
            <div className="mt-2">
              <StatusBadge status={product.status} />
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none flex-shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Tables section */}
          {allTables.length > 0 && (
            <div className="px-6 py-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Tables</p>
              <div className="space-y-2">
                {allTables
                  .sort((a, b) => a.dag_order - b.dag_order)
                  .map((tbl) => (
                  <div key={tbl.id} className="rounded-xl border border-slate-100 overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50">
                      <RolePill role={tbl.table_role} shared={tbl.is_shared_dimension} />
                      <span className="font-mono text-xs text-slate-700 flex-1 truncate">{tbl.table_name}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {tbl.row_count !== null && (
                          <span className="text-[10px] text-slate-400">{tbl.row_count.toLocaleString()} rows</span>
                        )}
                        <StatusDot status={tbl.transformation_status} />
                        {tbl.transformation_sql && (
                          <button
                            onClick={() => toggleSql(tbl.id)}
                            className="text-[10px] text-slate-500 hover:text-slate-700 border border-slate-200 rounded px-1.5 py-0.5 font-mono"
                          >
                            {expandedSql.has(tbl.id) ? 'hide' : 'SQL'}
                          </button>
                        )}
                      </div>
                    </div>
                    {tbl.last_run_error && (
                      <div className="px-4 py-1.5 bg-red-50 text-[10px] text-red-600 truncate">{tbl.last_run_error}</div>
                    )}
                    {expandedSql.has(tbl.id) && tbl.transformation_sql && (
                      <div className="relative">
                        <pre className="px-4 py-3 text-[10px] font-mono text-slate-600 overflow-x-auto bg-white leading-relaxed whitespace-pre-wrap max-h-48">{tbl.transformation_sql}</pre>
                        <button
                          onClick={() => handleCopy(tbl.id, tbl.transformation_sql!)}
                          className="absolute top-2 right-2 text-[10px] text-slate-400 hover:text-slate-600 bg-white border border-slate-200 rounded px-1.5 py-0.5"
                        >
                          {copied === tbl.id ? '✓' : 'Copy'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loading state */}
          {!detail && (
            <div className="px-6 py-8 text-center">
              <div className="w-5 h-5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-slate-400">Loading details…</p>
            </div>
          )}

          {/* KPIs section */}
          {kpis.length > 0 && (
            <div className="px-6 py-4 border-t border-slate-100">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">What you can ask</p>
              <ul className="space-y-1.5">
                {kpis.map((k) => (
                  <li key={k.id} className="flex items-start gap-2 text-sm text-slate-600">
                    <span className="text-slate-300 mt-0.5 flex-shrink-0">›</span>
                    <span>{k.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-slate-100 flex gap-3 flex-shrink-0">
          <a
            href="/query"
            className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 text-center"
          >
            Ask questions →
          </a>
          <button
            onClick={() => onRebuild(product.id)}
            className="px-4 py-2.5 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50"
          >
            ↺ Rebuild
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RequestTopicModal — free-text prompt to request a single new data product
// ---------------------------------------------------------------------------
function RequestTopicModal({
  connections,
  defaultConnId,
  onClose,
  onRequest,
}: {
  connections: Connection[];
  defaultConnId: number | null;
  onClose: () => void;
  onRequest: (connId: number, description: string) => void;
}) {
  const [connId, setConnId] = useState<number | null>(defaultConnId ?? (connections.length === 1 ? connections[0].id : null));
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!connId || !description.trim()) return;
    setLoading(true);
    onRequest(connId, description.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100">
          <h2 className="font-bold text-slate-900 text-lg">Request a new topic</h2>
          <p className="text-sm text-slate-400 mt-1">Describe the business area you want to analyse. Claude will design and build it.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {connections.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Source system</label>
              <select
                value={connId ?? ''}
                onChange={(e) => setConnId(Number(e.target.value))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
              >
                <option value="">Select a connection…</option>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">What do you want to analyse?</label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. customer complaints and resolution times, or supplier delivery performance, or employee overtime by department…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-400 leading-relaxed"
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!connId || !description.trim() || loading}
            className="flex-1 py-2.5 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Starting…' : 'Let Claude design it →'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TopicCard({
  product,
  detail,
  kpis,
  onClick,
}: {
  product: DataProduct;
  detail: FullDataProduct | undefined;
  kpis: ProductKpi[];
  onClick: () => void;
}) {
  const [showSql, setShowSql] = useState(false);
  const icon = productIcon(product.name);
  const name = cleanTopicName(product.name);
  const isBuilt = product.status === 'success';
  const isError = product.status === 'error';

  const factRows = detail
    ? detail.star_schemas
        .flatMap((s) => s.tables)
        .filter((t) => t.table_role === 'fact')
        .reduce((sum, t) => sum + (t.row_count ?? 0), 0)
    : 0;

  const visibleKpis = kpis.slice(0, 5);

  return (
    <>
      <div
        onClick={onClick}
        className={`bg-white rounded-2xl border shadow-sm overflow-hidden flex flex-col transition-shadow hover:shadow-md cursor-pointer ${
          isError ? 'border-red-200' : 'border-slate-200'
        } ${!isBuilt && !isError ? 'opacity-70' : ''}`}
      >
        {/* Card header */}
        <div className="px-5 py-5 flex items-start gap-4 border-b border-slate-100">
          <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-2xl flex-shrink-0">
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-slate-900 text-base leading-tight">{name}</h3>
              {isError && (
                <span className="text-[10px] font-semibold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">needs attention</span>
              )}
              {!isBuilt && !isError && (
                <span className="text-[10px] font-semibold bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full">not built yet</span>
              )}
            </div>
            {product.description && (
              <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">{product.description}</p>
            )}
            {isBuilt && factRows > 0 && (
              <p className="text-xs text-slate-400 mt-1.5">{factRows.toLocaleString()} records</p>
            )}
          </div>
        </div>

        {/* KPI hints */}
        <div className="px-5 py-4 flex-1">
          {visibleKpis.length > 0 ? (
            <>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">What you can ask</p>
              <ul className="space-y-1.5">
                {visibleKpis.map((k) => (
                  <li key={k.id} className="flex items-start gap-2 text-xs text-slate-600">
                    <span className="text-slate-300 mt-0.5 flex-shrink-0">›</span>
                    <span className="line-clamp-1">{k.name}</span>
                  </li>
                ))}
                {kpis.length > 5 && (
                  <li className="text-[10px] text-slate-400 pl-4">+{kpis.length - 5} more metrics</li>
                )}
              </ul>
            </>
          ) : isBuilt ? (
            <p className="text-xs text-slate-400 italic">No metrics defined yet — add some in the details view.</p>
          ) : (
            <p className="text-xs text-slate-400 italic">Build this topic to unlock analytics.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
          {isBuilt ? (
            <a
              href="/query"
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              Ask questions <span aria-hidden>→</span>
            </a>
          ) : (
            <span className="text-xs text-slate-400">
              {product.status === 'draft'
                ? 'Not yet designed'
                : product.status === 'approved'
                ? 'Ready to build'
                : product.status}
            </span>
          )}
          <div className="flex items-center gap-2">
            {detail && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowSql(true); }}
                className="text-[10px] font-mono text-slate-500 hover:text-slate-700 border border-slate-200 rounded px-2 py-0.5"
              >
                {'<>'} SQL
              </button>
            )}
            <span className="text-[10px] text-slate-300">
              {detail
                ? `${detail.star_schemas.flatMap((s) => s.tables).length} tables`
                : '…'}
            </span>
          </div>
        </div>
      </div>

      {showSql && detail && (
        <TopicSqlModal detail={detail} onClose={() => setShowSql(false)} />
      )}
    </>
  );
}

function TopicsView({
  domainProducts,
  foundationProducts,
  allDetails,
  allKpis,
  loading,
  hasErrors,
  connections,
  builtConnectionIds,
  onRebuildAll,
  onShowAdvanced,
  onRebuildTopic,
  onRequestTopic,
  onAddSource,
}: {
  domainProducts: DataProduct[];
  foundationProducts: DataProduct[];
  allDetails: Map<number, FullDataProduct>;
  allKpis: Map<number, ProductKpi[]>;
  loading: boolean;
  hasErrors: boolean;
  connections: Connection[];
  builtConnectionIds: Set<number>;
  onRebuildAll: () => void;
  onShowAdvanced: () => void;
  onRebuildTopic: (productId: number) => void;
  onRequestTopic: (connId: number, description: string) => void;
  onAddSource: (connId: number) => void;
}) {
  // Hide the Calendar topic (pure dim_date infrastructure — not a user-facing topic)
  const isCalendar = (p: DataProduct) => p.name === 'Calendar';
  const visibleDomainProducts = domainProducts.filter((p) => !isCalendar(p));
  const visibleFoundationProducts = foundationProducts.filter((p) => !isCalendar(p));
  const allProducts = [...visibleDomainProducts, ...visibleFoundationProducts];
  const builtCount = allProducts.filter((p) => p.status === 'success').length;

  // Slide-over state
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  const [showRequestTopic, setShowRequestTopic] = useState(false);

  // Unbuilt connections (connections that have no products yet)
  const unbuiltConnections = connections.filter((c) => !builtConnectionIds.has(c.id));
  const [showAddSourcePicker, setShowAddSourcePicker] = useState(false);

  const selectedTopicProduct = selectedTopicId != null ? allProducts.find((p) => p.id === selectedTopicId) ?? null : null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            {hasErrors ? 'Some topics need attention' : 'What would you like to explore?'}
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {builtCount} of {allProducts.length} topic{allProducts.length !== 1 ? 's' : ''} ready to query
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowRequestTopic(true)}
            className="text-sm bg-violet-600 text-white font-semibold rounded-xl px-3 py-2 hover:bg-violet-700 flex items-center gap-1.5"
          >
            ＋ Request a topic
          </button>
          {unbuiltConnections.length > 0 && (
            unbuiltConnections.length === 1 ? (
              <button
                onClick={() => onAddSource(unbuiltConnections[0].id)}
                className="text-sm text-slate-600 border border-slate-200 rounded-xl px-3 py-2 hover:bg-slate-50 flex items-center gap-1.5"
              >
                + {unbuiltConnections[0].name}
              </button>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setShowAddSourcePicker((v) => !v)}
                  className="text-sm text-slate-600 border border-slate-200 rounded-xl px-3 py-2 hover:bg-slate-50"
                >
                  + Add source ▾
                </button>
                {showAddSourcePicker && (
                  <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-10 min-w-[180px]">
                    {unbuiltConnections.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => { setShowAddSourcePicker(false); onAddSource(c.id); }}
                        className="w-full text-left px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 first:rounded-t-xl last:rounded-b-xl"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
          <button
            onClick={onRebuildAll}
            className="text-sm text-slate-600 border border-slate-200 rounded-xl px-3 py-2 hover:bg-slate-50 flex items-center gap-1.5"
          >
            ↺ Rebuild
          </button>
          <button
            onClick={onShowAdvanced}
            className="text-sm text-slate-600 border border-slate-200 rounded-xl px-3 py-2 hover:bg-slate-50"
          >
            Details →
          </button>
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {allProducts.map((p) => (
            <div key={p.id} className="bg-white rounded-2xl border border-slate-200 h-56 animate-pulse" />
          ))}
        </div>
      )}

      {/* Domain product cards */}
      {!loading && visibleDomainProducts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleDomainProducts.map((p) => (
            <TopicCard
              key={p.id}
              product={p}
              detail={allDetails.get(p.id)}
              kpis={allKpis.get(p.id) ?? []}
              onClick={() => setSelectedTopicId(p.id)}
            />
          ))}
        </div>
      )}

      {/* Foundation / reference data chips (excluding Calendar) */}
      {!loading && visibleFoundationProducts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mr-1">Reference data</span>
          {visibleFoundationProducts.map((p) => (
            <span
              key={p.id}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border ${
                p.status === 'success'
                  ? 'bg-amber-50 border-amber-200 text-amber-700'
                  : 'bg-slate-100 border-slate-200 text-slate-500'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.status === 'success' ? 'bg-amber-400' : 'bg-slate-300'}`} />
              {cleanTopicName(p.name)}
            </span>
          ))}
          <span className="text-[10px] text-slate-300 ml-1">Shared dimensions used across topics</span>
        </div>
      )}

      {/* CTA */}
      {!loading && builtCount > 0 && (
        <div className="pt-1">
          <a
            href="/query"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors"
          >
            Start asking questions →
          </a>
        </div>
      )}

      {/* Slide-over panel */}
      {selectedTopicProduct && (
        <TopicSlideOver
          product={selectedTopicProduct}
          detail={allDetails.get(selectedTopicProduct.id)}
          kpis={allKpis.get(selectedTopicProduct.id) ?? []}
          onClose={() => setSelectedTopicId(null)}
          onRebuild={(id) => { onRebuildTopic(id); setSelectedTopicId(null); }}
        />
      )}

      {/* Request topic modal */}
      {showRequestTopic && (
        <RequestTopicModal
          connections={connections}
          defaultConnId={connections.length === 1 ? connections[0].id : null}
          onClose={() => setShowRequestTopic(false)}
          onRequest={(connId, desc) => { onRequestTopic(connId, desc); setShowRequestTopic(false); }}
        />
      )}
    </div>
  );
}

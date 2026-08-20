'use client';

/**
 * <SourceRootPanel> — connection-level catalog view.
 *
 * Mirrors the structure of <ProductRootPanel> so the user gets the same kind
 * of detail surface when they click a data source as when they click a data
 * product. Tabs:
 *   • Overview      — what's in this source: table/row counts, last sync,
 *                     pending AI drafts, and which products consume it
 *   • Tables        — list of source tables (expand for columns)
 *   • Data flow     — products that consume this source, with quick stats
 *   • Quality       — per-table quality scores; click to drill into <QualityPanel>
 *   • SQL           — sample SELECT-* queries for each table (read-only,
 *                     for analyst/admin reference)
 *
 * The old "Schema diagram" tab (RelationshipsDiagramView + list + review
 * queue, backed by the 2k-line RelationshipCanvas) was RETIRED on 2026-08-18:
 * relationships have exactly one editing surface — /relationships ("How it
 * fits together") — and a second editor here is how the two drift apart.
 * The tab bar links there instead.
 *
 * KPIs are intentionally omitted — KPI definitions are a product-layer
 * concept (they live on `product_kpis`), so showing them here would be
 * redundant.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  AlertTriangle, Boxes, ChevronRight, ChevronDown, Code as CodeIcon,
  Database, FileText, Loader2, Network, Play,
  Search, ShieldCheck, Sparkles, Workflow, X,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { useRole, canCurate } from '@/lib/role';
import { useSchema, type RelationshipRow } from '@/components/catalog/useSchema';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import { formatRelative } from '@/lib/dates';

const QualityPanel = dynamic(() => import('@/components/QualityPanel'), { ssr: false });

// ── Types we fetch on mount ────────────────────────────────────────────────

interface ConnectionRow {
  id: number;
  name: string;
  type: string;                 // 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'duckdb'
  connector_type: string | null; // 'exactonline' | ... | null for direct DB
  domains?: string[] | string | null;
  selected_entities?: string[] | null;
  last_synced_at?: string | null;
  last_sync_status?: string | null;
  profiling_status?: string | null;
  profiling_message?: string | null;
  created_at?: string | null;
}

interface ProductByTable {
  id: number;
  name: string;
  status: string;
}

interface QualityTableRow {
  id: number;
  connection_id: number;
  table_name: string;
  display_name: string;
  layer: 'source' | 'product';
  product_name: string | null;
  product_table_id: number | null;
  table_role: string | null;
  profiled_at: string | null;
  overall_score: number | null;
  row_count: number | null;
}

type DetailTab = 'overview' | 'tables' | 'lineage' | 'quality' | 'sql';

// ── Component ───────────────────────────────────────────────────────────────

interface Props {
  connectionId: number;
}

export default function SourceRootPanel({ connectionId }: Props) {
  const role = useRole();
  const curator = canCurate(role);
  const schema = useSchema(connectionId);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [conn, setConn] = useState<ConnectionRow | null>(null);
  const [connLoading, setConnLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setConnLoading(true);
    api.get('/connections')
      .then((r) => {
        if (cancelled) return;
        const rows = (r.data?.data ?? []) as ConnectionRow[];
        const found = rows.find((c) => c.id === connectionId) ?? null;
        setConn(found);
      })
      .catch(() => { if (!cancelled) setConn(null); })
      .finally(() => { if (!cancelled) setConnLoading(false); });
    return () => { cancelled = true; };
  }, [connectionId]);

  const draftCount = useMemo(
    () => schema.relationships.filter((r) => r.ai_draft).length,
    [schema.relationships],
  );
  const draftTableCount = useMemo(
    () => schema.tables.filter((t) => t.ai_draft).length,
    [schema.tables],
  );
  const totalColumns = useMemo(
    () => Object.values(schema.columnsByTable).reduce((s, arr) => s + arr.length, 0),
    [schema.columnsByTable],
  );

  if (schema.loading || connLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
        <p className="text-[12px]">Loading source…</p>
      </div>
    );
  }

  if (schema.error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-3">
        <AlertTriangle className="w-6 h-6 text-warn" strokeWidth={1.5} />
        <p className="text-[13px] text-ink-2">Could not load schema for this connection.</p>
        <p className="text-[11.5px] font-mono text-muted max-w-md">{schema.error}</p>
        <button
          onClick={() => schema.reload()}
          className="mt-2 text-[12px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  const name = conn?.name ?? `Connection ${connectionId}`;
  const sourceLabel = sourceTypeLabel(conn);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-line bg-raised px-6 py-4 shrink-0">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-ocean-softer flex items-center justify-center shrink-0 text-ocean">
            <Database className="w-6 h-6" strokeWidth={1.5} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-[22px] tracking-[-0.01em] text-ink truncate">{name}</h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-[0.08em] bg-softer text-muted border border-line">
                {sourceLabel}
              </span>
              {conn?.last_sync_status && (
                <SyncStatusPill status={conn.last_sync_status} />
              )}
            </div>
            <p className="text-[11px] text-muted mt-1">
              {schema.tables.length} table{schema.tables.length === 1 ? '' : 's'}
              {totalColumns > 0 ? ` · ${totalColumns.toLocaleString('en-GB')} columns` : ''}
              {schema.relationships.length > 0
                ? ` · ${schema.relationships.length} relationship${schema.relationships.length === 1 ? '' : 's'}`
                : ''}
              {conn?.last_synced_at
                ? ` · last synced ${formatRelative(conn.last_synced_at)}`
                : ''}
            </p>
            {(draftCount > 0 || draftTableCount > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draftTableCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-warn bg-warn-soft border border-line px-2 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-warn" />
                    {draftTableCount} table draft{draftTableCount === 1 ? '' : 's'} pending review
                  </span>
                )}
                {draftCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-warn bg-warn-soft border border-line px-2 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-warn" />
                    {draftCount} relationship draft{draftCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Synced-but-unanalysed strip: tables were registered in the catalog
          straight after the first sync (structural pass, no AI), so the user
          can browse structure — but descriptions and inferred relationships
          only arrive when an admin runs Analyse on the source. */}
      {conn?.profiling_status === 'structural' && (
        <div className="border-b border-line bg-warn-soft px-6 py-2.5 shrink-0 flex items-center gap-2.5 flex-wrap">
          <Sparkles className="w-3.5 h-3.5 text-warn shrink-0" strokeWidth={1.5} />
          <p className="text-[12.5px] text-ink-2 leading-snug">
            Tables are loaded, but this source hasn&apos;t been analysed yet — column descriptions and
            suggested relationships are added when Analyse runs.
          </p>
          {curator && (
            <Link
              href={`/sources?connectionId=${connectionId}`}
              className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors"
            >
              Analyse on Sources →
            </Link>
          )}
        </div>
      )}

      {schema.tables.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
          <p className="text-[13.5px] text-ink-2">This connection has no tables yet.</p>
          <p className="text-[12px] text-muted mt-1.5 max-w-md">
            Profile the connection from the <span className="font-medium">Sources</span> page to populate the schema.
          </p>
        </div>
      ) : (
        <>
          {/* ── Tabs ─────────────────────────────────────────────────────── */}
          {/* Schema diagram + SQL are curator surfaces (FK arrows, "Add
              relationship" CTAs, paste-ready SELECT snippets). Viewers
              never need them; admins/analysts keep full access. */}
          <div className="border-b border-line bg-raised px-6 shrink-0 overflow-x-auto">
            <nav className="flex gap-0">
              <TabBtn active={tab === 'overview'}  onClick={() => setTab('overview')}  icon={<FileText className="w-3.5 h-3.5" />}>Overview</TabBtn>
              <TabBtn active={tab === 'tables'}    onClick={() => setTab('tables')}    icon={<Boxes className="w-3.5 h-3.5" />}>Tables</TabBtn>
              {curator && (
                // Relationships have ONE editing surface. This is a door, not a tab.
                <Link
                  href="/relationships"
                  className="flex items-center gap-1.5 px-3.5 py-2.5 text-[12px] font-mono uppercase tracking-[0.06em] text-muted hover:text-ocean transition-colors whitespace-nowrap"
                >
                  <Network className="w-3.5 h-3.5" />
                  Relations ↗
                </Link>
              )}
              <TabBtn active={tab === 'lineage'}   onClick={() => setTab('lineage')}   icon={<Workflow className="w-3.5 h-3.5" />}>Data flow</TabBtn>
              <TabBtn active={tab === 'quality'}   onClick={() => setTab('quality')}   icon={<ShieldCheck className="w-3.5 h-3.5" />}>Quality</TabBtn>
              {curator && (
                <TabBtn active={tab === 'sql'} onClick={() => setTab('sql')} icon={<CodeIcon className="w-3.5 h-3.5" />}>SQL</TabBtn>
              )}
            </nav>
          </div>

          {/* ── Tab body ─────────────────────────────────────────────────── */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {tab === 'overview' && (
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                <OverviewSection
                  connection={conn}
                  tables={schema.tables}
                  relationships={schema.relationships}
                  totalColumns={totalColumns}
                  draftTableCount={draftTableCount}
                  draftCount={draftCount}
                  onJumpToTab={setTab}
                />
              </div>
            )}
            {tab === 'tables' && (
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                <TablesSection
                  tables={schema.tables}
                  columnsByTable={schema.columnsByTable}
                />
              </div>
            )}
            {tab === 'lineage' && (
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                <LineageSection
                  connectionId={connectionId}
                  tables={schema.tables}
                />
              </div>
            )}
            {tab === 'quality' && (
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                <QualitySection connectionId={connectionId} />
              </div>
            )}
            {tab === 'sql' && (
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                <SqlSection
                  connection={conn}
                  tables={schema.tables}
                  columnsByTable={schema.columnsByTable}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Header helpers ─────────────────────────────────────────────────────────

function sourceTypeLabel(conn: ConnectionRow | null): string {
  if (!conn) return '—';
  if (conn.connector_type) return conn.connector_type.toUpperCase();
  return (conn.type ?? 'unknown').toUpperCase();
}

function SyncStatusPill({ status }: { status: string }) {
  const cls =
    status === 'succeeded' ? 'bg-ok-soft text-ok'
    : status === 'failed' ? 'bg-err-soft text-err'
    : status === 'cancelled' ? 'bg-softer text-muted'
    : status === 'running' ? 'bg-ocean-softer text-ocean'
    : 'bg-warn-soft text-warn';
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-[0.08em] border border-line',
      cls,
    )}>
      {status}
    </span>
  );
}

// ─── Tab button ─────────────────────────────────────────────────────────────

function TabBtn({
  active, onClick, icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-medium border-b-2 transition-colors whitespace-nowrap',
        active ? 'border-ocean text-ocean' : 'border-transparent text-muted hover:text-ink-2',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────────

function OverviewSection({
  connection, tables, relationships, totalColumns, draftTableCount, draftCount, onJumpToTab,
}: {
  connection: ConnectionRow | null;
  tables: SourceTable[];
  relationships: RelationshipRow[];
  totalColumns: number;
  draftTableCount: number;
  draftCount: number;
  onJumpToTab: (t: DetailTab) => void;
}) {
  const [products, setProducts] = useState<Array<ProductByTable & { source_table_id: number; source_table_label: string }>>([]);
  const [productsLoading, setProductsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setProductsLoading(true);
    Promise.all(
      tables.map((t) =>
        api.get(`/products/by-source-table/${t.id}`)
          .then((r) => ({ table: t, rows: (r.data?.data ?? []) as ProductByTable[] }))
          .catch(() => ({ table: t, rows: [] as ProductByTable[] })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const flat: Array<ProductByTable & { source_table_id: number; source_table_label: string }> = [];
      for (const { table: t, rows } of results) {
        for (const r of rows) {
          flat.push({ ...r, source_table_id: t.id, source_table_label: t.display_name || t.table_name });
        }
      }
      setProducts(flat);
    }).finally(() => { if (!cancelled) setProductsLoading(false); });
    return () => { cancelled = true; };
  }, [tables]);

  // Unique product list (a product is shown once even if it consumes multiple
  // tables from this source).
  const uniqueProducts = useMemo(() => {
    const seen = new Map<number, ProductByTable & { tables: string[] }>();
    for (const p of products) {
      const ex = seen.get(p.id);
      if (ex) ex.tables.push(p.source_table_label);
      else seen.set(p.id, { id: p.id, name: p.name, status: p.status, tables: [p.source_table_label] });
    }
    return Array.from(seen.values());
  }, [products]);

  const topTables = useMemo(
    () => [...tables]
      .sort((a, b) => (a.display_name || a.table_name).localeCompare(b.display_name || b.table_name))
      .slice(0, 8),
    [tables],
  );

  return (
    <div className="space-y-5 max-w-3xl">
      <Card title="What this source contains">
        {connection?.profiling_message
          ? <p className="text-[13.5px] text-ink-2 leading-relaxed">{connection.profiling_message}</p>
          : <p className="text-[13px] text-muted italic">
              {connection?.connector_type
                ? `Synced from ${connection.connector_type}. Ingested data is materialised into the warehouse and queried from there.`
                : 'Direct database attachment — queries are executed against the source.'}
            </p>
        }
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Tables"        value={tables.length} />
        <Stat label="Columns"       value={totalColumns} />
        <Stat label="Relationships" value={relationships.length} />
        <Stat label="Used in"       value={uniqueProducts.length} suffix="product(s)" />
      </div>

      {(draftTableCount > 0 || draftCount > 0) && (
        <Card title="AI drafts pending review">
          <p className="text-[13px] text-ink-2 leading-relaxed mb-2">
            Some definitions and relationships are still flagged as AI drafts. Review them so analysts can trust the catalog.
          </p>
          <div className="flex flex-wrap gap-2">
            {draftTableCount > 0 && (
              <button
                onClick={() => onJumpToTab('tables')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-medium text-warn bg-warn-soft border border-line rounded hover:bg-warn/10 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-warn" />
                {draftTableCount} table{draftTableCount === 1 ? '' : 's'}
              </button>
            )}
            {draftCount > 0 && (
              // Relationship drafts are reviewed on the canvas — the catalog
              // no longer carries its own relationship editor.
              <Link
                href="/relationships"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-medium text-warn bg-warn-soft border border-line rounded hover:bg-warn/10 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-warn" />
                {draftCount} relationship{draftCount === 1 ? '' : 's'} — review in Relations ↗
              </Link>
            )}
          </div>
        </Card>
      )}

      {topTables.length > 0 && (
        <Card title={`Tables (showing ${topTables.length} of ${tables.length})`}>
          <ul className="space-y-1">
            {topTables.map((t) => (
              <li key={t.id} className="text-[13px] text-ink-2 flex items-start gap-2">
                <Boxes className="w-3.5 h-3.5 text-muted-2 mt-0.5 shrink-0" strokeWidth={1.5} />
                <span className="flex-1 min-w-0">
                  <span className="font-medium text-ink">{t.display_name || t.table_name}</span>
                  {t.description && <span className="text-muted ml-1.5 truncate">— {t.description}</span>}
                </span>
              </li>
            ))}
            {tables.length > topTables.length && (
              <li className="text-[12px] text-muted">
                + {tables.length - topTables.length} more in the Tables tab
              </li>
            )}
          </ul>
        </Card>
      )}

      <Card title="Used in — data products">
        {productsLoading ? (
          <p className="text-[12px] text-muted">Looking up downstream products…</p>
        ) : uniqueProducts.length === 0 ? (
          <p className="text-[13px] text-muted italic">
            No data products consume this source yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {uniqueProducts.map((p) => (
              <li key={p.id} className="text-[13px] text-ink-2 flex items-start gap-2">
                <Workflow className="w-3.5 h-3.5 text-ocean mt-0.5 shrink-0" strokeWidth={1.5} />
                <span>
                  <span className="font-medium text-ink">{p.name}</span>
                  <span className="ml-1.5 text-[11px] font-mono uppercase tracking-[0.08em] text-muted-2">
                    {p.status}
                  </span>
                  <span className="text-muted ml-1.5">— uses {p.tables.length} table{p.tables.length === 1 ? '' : 's'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Tip">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Use the <span className="font-medium">Schema diagram</span> tab to see how tables relate to each other —
          most accurate analysis depends on having the right joins defined.
          Use the <span className="font-medium">Quality</span> tab to spot tables that need profiling.
        </p>
      </Card>
    </div>
  );
}

// ─── Tables tab ─────────────────────────────────────────────────────────────

function TablesSection({
  tables, columnsByTable,
}: {
  tables: SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
}) {
  const role = useRole();
  const curator = canCurate(role);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) =>
      (t.display_name ?? '').toLowerCase().includes(q) ||
      (t.table_name ?? '').toLowerCase().includes(q) ||
      (t.description ?? '').toLowerCase().includes(q),
    );
  }, [tables, search]);

  const sorted = useMemo(
    () => [...filtered].sort(
      (a, b) => (a.display_name || a.table_name).localeCompare(b.display_name || b.table_name),
    ),
    [filtered],
  );

  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-2" strokeWidth={2} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tables…"
          className="w-full bg-raised border border-line rounded-md pl-8 pr-7 py-1.5 text-[12.5px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-ocean-soft focus:ring-1 focus:ring-ocean-soft"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 hover:text-ink-2"
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="text-[13px] text-muted italic">No matching tables.</p>
      ) : (
        <div className="bg-raised border border-line rounded-md divide-y divide-line">
          {sorted.map((t) => {
            const open = expandedId === t.id;
            const cols = columnsByTable[t.id] ?? [];
            return (
              <div key={t.id}>
                <button
                  onClick={() => setExpandedId(open ? null : t.id)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-softer/40 transition-colors"
                >
                  <ChevronRight className={cn('w-3.5 h-3.5 text-muted-2 transition-transform', open && 'rotate-90')} strokeWidth={2} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[13.5px] font-medium text-ink">{t.display_name || t.table_name}</span>
                    {/* snake_case raw name only for curators — viewers see
                        the display name only. */}
                    {curator && t.display_name && t.display_name !== t.table_name && (
                      <span className="text-[11px] font-mono text-muted-2 ml-2">{t.table_name}</span>
                    )}
                    {t.description && <span className="text-[12px] text-muted ml-2">{t.description}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-mono text-muted-2 tabular-nums">
                      {cols.length} col{cols.length === 1 ? '' : 's'}
                    </span>
                    {curator && t.ai_draft && (
                      <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-warn bg-warn-soft border border-line px-1.5 py-0.5 rounded">
                        draft
                      </span>
                    )}
                  </div>
                </button>
                {open && (
                  <div className="px-4 pb-4 bg-softer/30">
                    <div className="bg-raised border border-line rounded-md overflow-hidden">
                      <div className="px-3 py-2 border-b border-line bg-softer/40">
                        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
                          Columns ({cols.length})
                        </p>
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        {cols.length === 0 ? (
                          <p className="px-3 py-2 text-[12px] text-muted italic">No columns recorded.</p>
                        ) : cols.map((c) => (
                          <div key={c.id} className="px-3 py-1.5 flex items-center gap-2 text-[12px] hover:bg-softer/60 border-b border-line last:border-0">
                            <span className="font-mono text-ink truncate max-w-[40%]">{c.column_name}</span>
                            <span className="text-muted-2 text-[11px] font-mono">{c.data_type}</span>
                            {(c.is_dimension || c.is_measure) && (
                              <span className={cn(
                                'text-[9px] font-mono uppercase tracking-[0.08em] px-1 rounded',
                                c.is_measure ? 'bg-ok-soft text-ok' : 'bg-softer text-muted',
                              )}>
                                {c.is_measure ? 'measure' : 'dim'}
                              </span>
                            )}
                            {c.description && <span className="text-muted ml-auto truncate max-w-[40%]">{c.description}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Data flow tab ──────────────────────────────────────────────────────────
//
// Source-side lineage is the inverse of the product-side lineage view: instead
// of "where did this product table come from", we want "which product tables
// consume each of my source tables". A simple grouped list is more honest than
// trying to render a fan-out diagram for tens of tables.

function LineageSection({
  connectionId: _connectionId, tables,
}: {
  connectionId: number;
  tables: SourceTable[];
}) {
  const [byTable, setByTable] = useState<Record<number, ProductByTable[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      tables.map((t) =>
        api.get(`/products/by-source-table/${t.id}`)
          .then((r) => [t.id, (r.data?.data ?? []) as ProductByTable[]] as const)
          .catch(() => [t.id, [] as ProductByTable[]] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<number, ProductByTable[]> = {};
      for (const [id, rows] of entries) map[id] = rows;
      setByTable(map);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tables]);

  const consumed = useMemo(
    () => tables.filter((t) => (byTable[t.id] ?? []).length > 0),
    [tables, byTable],
  );

  const unused = useMemo(
    () => tables.filter((t) => (byTable[t.id] ?? []).length === 0),
    [tables, byTable],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
      </div>
    );
  }

  if (tables.length === 0) {
    return <p className="text-[13px] text-muted italic">No tables to show lineage for yet.</p>;
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <Card title={`Tables consumed by data products (${consumed.length} of ${tables.length})`}>
        {consumed.length === 0 ? (
          <p className="text-[13px] text-muted italic">
            No source table from this connection is consumed by a data product yet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {consumed.map((t) => {
              const rows = byTable[t.id] ?? [];
              return (
                <li key={t.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Boxes className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
                    <span className="text-[13px] font-medium text-ink">
                      {t.display_name || t.table_name}
                    </span>
                    {t.display_name && t.display_name !== t.table_name && (
                      <span className="text-[11px] font-mono text-muted-2">{t.table_name}</span>
                    )}
                  </div>
                  <ul className="pl-5 flex flex-wrap gap-1.5">
                    {rows.map((p) => (
                      <li key={p.id}>
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-ocean-softer text-ocean text-[11.5px] font-medium border border-line">
                          <Workflow className="w-3 h-3" strokeWidth={1.75} />
                          {p.name}
                          <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 ml-0.5">
                            {p.status}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {unused.length > 0 && (
        <Card title={`Unused source tables (${unused.length})`}>
          <p className="text-[12px] text-muted mb-2">
            These tables exist in the source but aren&rsquo;t referenced by any data product yet.
            That&rsquo;s normal early on — but in steady state, unused tables are candidates for archival or
            deselection from sync.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unused.slice(0, 24).map((t) => (
              <span key={t.id} className="inline-flex items-center px-2 py-0.5 rounded bg-softer text-ink-2 text-[11.5px] font-mono border border-line">
                {t.display_name || t.table_name}
              </span>
            ))}
            {unused.length > 24 && (
              <span className="text-[11px] text-muted">+ {unused.length - 24} more</span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Quality tab ────────────────────────────────────────────────────────────

function QualitySection({ connectionId }: { connectionId: number }) {
  const [rows, setRows] = useState<QualityTableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<QualityTableRow | null>(null);
  const [profiling, setProfiling] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/quality/tables?connectionId=${connectionId}`);
      const all = (res.data?.data ?? []) as QualityTableRow[];
      setRows(all.filter((r) => r.layer === 'source'));
    } catch { /* noop */ } finally { setLoading(false); }
  }, [connectionId]);

  useEffect(() => { load(); }, [load]);

  const profileAll = useCallback(async () => {
    setProfiling({ done: 0, total: rows.length });
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      try { await api.post(`/quality/${t.connection_id}/${encodeURIComponent(t.table_name)}/profile`); }
      catch { /* continue */ }
      setProfiling({ done: i + 1, total: rows.length });
    }
    setProfiling(null);
    await load();
  }, [rows, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
      </div>
    );
  }

  if (selected) {
    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="mb-3 text-[11px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink-2 transition-colors"
        >
          ← Back to overview
        </button>
        <QualityPanel
          connId={selected.connection_id}
          tableName={selected.table_name}
          displayName={selected.display_name ?? undefined}
        />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="bg-raised border border-line rounded-lg p-12 text-center">
        <p className="text-[13px] text-ink-3">
          No source tables are recorded for this connection.
        </p>
      </div>
    );
  }

  const profiled = rows.filter((r) => r.overall_score !== null);
  const avgScore = profiled.length > 0
    ? Math.round((profiled.reduce((s, r) => s + (r.overall_score ?? 0), 0) / profiled.length) * 100)
    : 0;
  const ringColor = avgScore >= 90 ? 'var(--ok)' : avgScore >= 70 ? 'var(--warn)' : 'var(--err)';

  const sorted = [...rows].sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2));

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between bg-raised border border-line rounded-lg p-5">
        <div className="flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-full border-2 flex items-center justify-center"
            style={{ borderColor: ringColor }}
          >
            <span className="font-display text-[18px] tabular-nums text-ink">
              {profiled.length === 0 ? '—' : avgScore}
            </span>
          </div>
          <div>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">Overall score</p>
            <p className="text-[13px] text-ink-2">
              {profiled.length} of {rows.length} table{rows.length === 1 ? '' : 's'} profiled
            </p>
          </div>
        </div>
        {profiling ? (
          <div className="flex items-center gap-2 text-[11px] text-ocean">
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
            Profiling {profiling.done}/{profiling.total}…
          </div>
        ) : (
          <button
            onClick={profileAll}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium text-ocean hover:bg-ocean-softer transition-colors"
          >
            <Play className="w-2.5 h-2.5" strokeWidth={2} fill="currentColor" />
            Profile all
          </button>
        )}
      </div>

      <div className="bg-raised border border-line rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Table</th>
              <th className="text-center px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Score</th>
              <th className="text-right px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Rows</th>
              <th className="text-right px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Last profiled</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSelected(t)}
                className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer"
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <ScoreDot score={t.overall_score} />
                    <span className="text-[13px] font-medium text-ink">{t.display_name || t.table_name}</span>
                    {t.display_name && t.display_name !== t.table_name && (
                      <span className="text-[11px] font-mono text-muted-2">{t.table_name}</span>
                    )}
                  </div>
                </td>
                <td className="px-5 py-3 text-center"><ScoreCell score={t.overall_score} /></td>
                <td className="px-5 py-3 text-right text-[12px] text-ink-3 tabular-nums">
                  {t.row_count != null ? t.row_count.toLocaleString('en-GB') : '—'}
                </td>
                <td className="px-5 py-3 text-right text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2">
                  {t.profiled_at ? new Date(t.profiled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScoreCell({ score }: { score: number | null }) {
  if (score === null) return <span className="text-[11px] text-muted-2">—</span>;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-ok-soft text-ok' : pct >= 70 ? 'bg-warn-soft text-warn' : 'bg-err-soft text-err';
  return <span className={`text-[12px] font-mono tracking-[0.04em] tabular-nums px-2 py-0.5 rounded border border-line ${cls}`}>{pct}%</span>;
}

function ScoreDot({ score }: { score: number | null }) {
  if (score === null) return <span className="w-2 h-2 rounded-full bg-line inline-block" />;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-ok' : pct >= 70 ? 'bg-warn' : 'bg-err';
  return <span className={`w-2 h-2 rounded-full ${cls} inline-block`} />;
}

// ─── SQL tab ────────────────────────────────────────────────────────────────
//
// Source connections don't have transformation SQL the way data products do —
// the data is loaded raw from the source. So the most useful thing we can show
// is a starter SELECT for each table (paste-into-/query-friendly), plus a
// reminder of how the tables are addressed in NL→SQL.

function SqlSection({
  connection, tables, columnsByTable,
}: {
  connection: ConnectionRow | null;
  tables: SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) =>
      (t.display_name ?? '').toLowerCase().includes(q) ||
      (t.table_name ?? '').toLowerCase().includes(q),
    );
  }, [tables, search]);

  if (tables.length === 0) {
    return <p className="text-[13px] text-muted italic">No tables in this connection yet.</p>;
  }

  return (
    <div className="space-y-3 max-w-3xl">
      <Card title="How to query this source">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          {connection?.connector_type
            ? <>Synced data is materialised as Parquet in the warehouse. Ask questions in
                <span className="font-medium"> Ask AI</span> and the platform routes the query to DuckDB
                automatically. Below are starter queries for each table for analyst reference.</>
            : <>This connection is queried directly. Below are starter queries for each table — analysts
                can paste them into the SQL panel of <span className="font-medium">Ask AI</span> for a quick
                sample.</>
          }
        </p>
      </Card>

      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-2" strokeWidth={2} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tables…"
          className="w-full bg-raised border border-line rounded-md pl-8 pr-7 py-1.5 text-[12.5px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-ocean-soft focus:ring-1 focus:ring-ocean-soft"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 hover:text-ink-2"
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-[13px] text-muted italic">No matching tables.</p>
      ) : filtered.map((t) => {
        const isOpen = open.has(t.id);
        const cols = columnsByTable[t.id] ?? [];
        const colList = cols.length > 0
          ? cols.slice(0, 10).map((c) => c.column_name).join(', ') + (cols.length > 10 ? ',\n  …' : '')
          : '*';
        const sql = `SELECT\n  ${colList}\nFROM ${t.table_name}\nLIMIT 100;`;
        return (
          <div key={t.id} className="bg-raised border border-line rounded-md overflow-hidden">
            <button
              onClick={() => setOpen((s) => {
                const n = new Set(s);
                n.has(t.id) ? n.delete(t.id) : n.add(t.id);
                return n;
              })}
              className="w-full text-left px-4 py-2.5 flex items-center gap-2 hover:bg-softer/40 transition-colors"
            >
              {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-muted-2" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-2" />}
              <span className="text-[13px] font-medium text-ink">{t.display_name || t.table_name}</span>
              {t.display_name && t.display_name !== t.table_name && (
                <span className="text-[11px] font-mono text-muted-2">{t.table_name}</span>
              )}
              <span className="ml-auto text-[10px] font-mono text-muted-2 tabular-nums">{cols.length} col{cols.length === 1 ? '' : 's'}</span>
            </button>
            {isOpen && (
              <pre className="border-t border-line bg-softer/30 px-3 py-2.5 text-[11.5px] font-mono text-ink-2 overflow-x-auto whitespace-pre">
                {sql}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Card / Stat helpers (mirror ProductRootPanel for visual consistency) ───

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-raised border border-line rounded-md overflow-hidden">
      <header className="px-4 py-2 border-b border-line bg-softer/40">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{title}</p>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="bg-raised border border-line rounded-md px-3.5 py-2.5">
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{label}</p>
      <p className="font-display text-[22px] tabular-nums text-ink leading-tight mt-0.5">
        {value.toLocaleString('en-GB')}
        {suffix && <span className="text-[11px] font-mono text-muted ml-1.5 tracking-[0.08em] uppercase">{suffix}</span>}
      </p>
    </div>
  );
}

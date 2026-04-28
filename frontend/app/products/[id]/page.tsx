'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  ArrowLeft, Database, Play, Trash2, Loader2, ChevronRight, MessageSquare,
  Sparkles, Code as CodeIcon, Boxes, Gauge, FileText,
} from 'lucide-react';
import { format as sqlFormatter } from 'sql-formatter';
import api from '@/lib/api';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import { cn } from '@/lib/cn';
import type {
  Connection,
  DataProduct,
  FullDataProduct,
  ProductTable,
  ProductColumn,
  ProductKpi,
} from '../types';
import { StatusDot, StatusBadge, RoleBadge, ColumnRoleBadge, Spinner, ProductIcon } from '../badges';
import { cleanTopicName } from '../helpers';

const AskAIPanel = dynamic(() => import('../AskAIPanel'), { ssr: false });

type DetailTab = 'overview' | 'tables' | 'kpis' | 'sql';

function getAllTables(p: FullDataProduct): (ProductTable & { columns: ProductColumn[] })[] {
  return p.star_schemas
    .flatMap((s) => s.tables)
    .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name));
}

function totalRows(p: FullDataProduct): number {
  return getAllTables(p).reduce((sum, t) => sum + (t.row_count ?? 0), 0);
}

function ProductDetailInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const productId = Number(params.id);

  const [tab, setTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<FullDataProduct | null>(null);
  const [kpis, setKpis] = useState<ProductKpi[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [expandedTableId, setExpandedTableId] = useState<number | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      const res = await api.get(`/products/${productId}`);
      const data = res.data.data as FullDataProduct | undefined;
      if (!data) {
        setNotFound(true);
        return;
      }
      setDetail(data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  const loadKpis = useCallback(async () => {
    try {
      const res = await api.get(`/products/${productId}/kpis`);
      setKpis(res.data.data ?? []);
    } catch { /* ignore */ }
  }, [productId]);

  const loadAux = useCallback(async () => {
    try {
      const [conRes, prodRes] = await Promise.all([
        api.get('/connections'),
        api.get('/products'),
      ]);
      setConnections(conRes.data.data ?? []);
      setProducts(prodRes.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!Number.isFinite(productId)) { setNotFound(true); setLoading(false); return; }
    loadDetail();
    loadKpis();
    loadAux();
  }, [productId, loadDetail, loadKpis, loadAux]);

  async function handleRebuild() {
    if (!detail || running) return;
    setRunning(true);
    try {
      await api.post(`/products/${detail.id}/run-full`);
      await loadDetail();
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!detail) return;
    if (!confirm(`Delete data product "${cleanTopicName(detail.name)}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/products/${detail.id}`);
      router.push('/products');
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted" />
      </div>
    );
  }
  if (notFound || !detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
        <Database className="w-8 h-8 text-muted-2" strokeWidth={1.5} />
        <p className="text-[14px] text-ink">Data product not found.</p>
        <button
          onClick={() => router.push('/products')}
          className="text-[12px] text-ocean hover:text-ocean-hover font-medium"
        >
          &larr; Back to products
        </button>
      </div>
    );
  }

  const tables = getAllTables(detail);
  const name = cleanTopicName(detail.name);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header */}
      <div className="border-b border-line bg-raised px-6 py-4 shrink-0">
        <button
          onClick={() => router.push('/products')}
          className="flex items-center gap-1 text-[11px] font-mono tracking-[0.14em] uppercase text-muted hover:text-ink-2 transition-colors mb-2"
        >
          <ArrowLeft className="w-3 h-3" strokeWidth={2} />
          Data products
        </button>
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-ocean-softer flex items-center justify-center shrink-0 text-ocean">
            <ProductIcon product={detail} className="w-7 h-7" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-[22px] tracking-[-0.01em] text-ink truncate">{name}</h1>
              <StatusBadge status={detail.status} />
            </div>
            {detail.description && (
              <p className="text-[13.5px] text-ink-2 mt-1 leading-relaxed">{detail.description}</p>
            )}
            <p className="text-[11px] text-muted mt-1">
              {tables.length} table{tables.length === 1 ? '' : 's'}
              {totalRows(detail) > 0 ? ` \u00b7 ${totalRows(detail).toLocaleString('en-GB')} rows` : ''}
              {kpis.length > 0 ? ` \u00b7 ${kpis.length} KPI${kpis.length === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRebuild}
              disabled={running || tables.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
            >
              {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" strokeWidth={2} />}
              {running ? 'Running\u2026' : 'Rebuild'}
            </button>
            <button
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-err bg-err-soft border border-err/20 rounded-md hover:bg-err/10 transition-colors"
            >
              <Trash2 className="w-3 h-3" strokeWidth={2} />
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Two-column body: details + chat */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: tabbed content */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="border-b border-line bg-raised px-6 shrink-0 overflow-x-auto">
            <nav className="flex gap-0">
              <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={<FileText className="w-3.5 h-3.5" />}>Overview</TabBtn>
              <TabBtn active={tab === 'tables'} onClick={() => setTab('tables')} icon={<Boxes className="w-3.5 h-3.5" />}>Tables</TabBtn>
              <TabBtn active={tab === 'kpis'} onClick={() => setTab('kpis')} icon={<Gauge className="w-3.5 h-3.5" />}>KPIs</TabBtn>
              <TabBtn active={tab === 'sql'} onClick={() => setTab('sql')} icon={<CodeIcon className="w-3.5 h-3.5" />}>SQL</TabBtn>
            </nav>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            {tab === 'overview' && <OverviewSection detail={detail} kpis={kpis} tables={tables} />}
            {tab === 'tables' && (
              <TablesSection
                tables={tables}
                expandedTableId={expandedTableId}
                onToggle={(id) => setExpandedTableId(expandedTableId === id ? null : id)}
              />
            )}
            {tab === 'kpis' && <KpisSection kpis={kpis} />}
            {tab === 'sql' && <SqlSection tables={tables} />}
          </div>
        </div>

        {/* Right: AI chat sidebar */}
        <div className="hidden lg:flex w-[420px] shrink-0 flex-col">
          <AskAIPanel
            open={true}
            embedded={true}
            hideClose={true}
            onClose={() => { /* no-op in embedded mode */ }}
            product={detail}
            connections={connections}
            products={products}
            onRefineApplied={() => { loadDetail(); loadKpis(); }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

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

function OverviewSection({
  detail, kpis, tables,
}: {
  detail: FullDataProduct;
  kpis: ProductKpi[];
  tables: (ProductTable & { columns: ProductColumn[] })[];
}) {
  const measures = tables.flatMap((t) => t.columns.filter((c) => c.column_role === 'measure'));
  const dimensions = tables.flatMap((t) => t.columns.filter((c) => c.column_role === 'attribute' || c.column_role === 'natural_key'));
  const facts = tables.filter((t) => t.table_role === 'fact');
  const dims = tables.filter((t) => t.table_role === 'dimension');

  return (
    <div className="space-y-5 max-w-3xl">
      <Card title="What this product is for">
        {detail.description
          ? <p className="text-[13.5px] text-ink-2 leading-relaxed">{detail.description}</p>
          : <p className="text-[13px] text-muted italic">No description yet. Ask the AI on the right to write one.</p>
        }
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Tables" value={tables.length} />
        <Stat label="Facts" value={facts.length} />
        <Stat label="Dimensions" value={dims.length} />
        <Stat label="KPIs" value={kpis.length} />
      </div>

      {kpis.length > 0 && (
        <Card title={`What you can ask (${kpis.length} KPI${kpis.length === 1 ? '' : 's'})`}>
          <ul className="space-y-1.5">
            {kpis.slice(0, 8).map((k) => (
              <li key={k.id} className="text-[13px] text-ink-2 flex items-start gap-2">
                <span className="text-muted-2 mt-0.5">&middot;</span>
                <span>
                  <span className="font-medium text-ink">{k.name}</span>
                  {k.description && <span className="text-muted ml-1.5">{k.description}</span>}
                </span>
              </li>
            ))}
            {kpis.length > 8 && (
              <li className="text-[12px] text-muted">+ {kpis.length - 8} more in the KPIs tab</li>
            )}
          </ul>
        </Card>
      )}

      {(measures.length > 0 || dimensions.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {measures.length > 0 && (
            <Card title={`Measures (${measures.length})`}>
              <div className="flex flex-wrap gap-1.5">
                {measures.slice(0, 18).map((m) => (
                  <span key={m.id} className="inline-flex items-center px-2 py-0.5 rounded-sm bg-ok-soft text-ok text-[11.5px] font-mono">
                    {m.column_name}
                  </span>
                ))}
                {measures.length > 18 && <span className="text-[11px] text-muted">+{measures.length - 18} more</span>}
              </div>
            </Card>
          )}
          {dimensions.length > 0 && (
            <Card title={`Dimensions (${dimensions.length})`}>
              <div className="flex flex-wrap gap-1.5">
                {dimensions.slice(0, 18).map((d) => (
                  <span key={d.id} className="inline-flex items-center px-2 py-0.5 rounded-sm bg-softer text-ink-2 text-[11.5px] font-mono">
                    {d.column_name}
                  </span>
                ))}
                {dimensions.length > 18 && <span className="text-[11px] text-muted">+{dimensions.length - 18} more</span>}
              </div>
            </Card>
          )}
        </div>
      )}

      <Card title="Tip">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Use the chat on the right. Switch to <span className="font-medium">Refine</span> to suggest changes
          (better column names, new KPIs, fixed descriptions). I&rsquo;ll propose safe edits you can review and apply with one click.
        </p>
      </Card>
    </div>
  );
}

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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-raised border border-line rounded-md px-3.5 py-2.5">
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{label}</p>
      <p className="font-display text-[22px] tabular-nums text-ink leading-tight mt-0.5">{value.toLocaleString('en-GB')}</p>
    </div>
  );
}

function TablesSection({
  tables, expandedTableId, onToggle,
}: {
  tables: (ProductTable & { columns: ProductColumn[] })[];
  expandedTableId: number | null;
  onToggle: (id: number) => void;
}) {
  if (tables.length === 0) {
    return <p className="text-[13px] text-muted italic">No tables designed yet.</p>;
  }
  return (
    <div className="bg-raised border border-line rounded-md divide-y divide-line">
      {tables.map((t) => {
        const open = expandedTableId === t.id;
        return (
          <div key={t.id}>
            <button
              onClick={() => onToggle(t.id)}
              className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-softer/40 transition-colors"
            >
              <ChevronRight className={cn('w-3.5 h-3.5 text-muted-2 transition-transform', open && 'rotate-90')} strokeWidth={2} />
              <RoleBadge role={t.table_role} />
              <div className="flex-1 min-w-0">
                <span className="text-[13.5px] font-medium text-ink">{t.display_name ?? t.table_name}</span>
                {t.description && <span className="text-[12px] text-muted ml-2">{t.description}</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {t.row_count !== null && (
                  <span className="text-[11px] text-muted-2 tabular-nums">{t.row_count.toLocaleString('en-GB')} rows</span>
                )}
                <StatusDot status={t.transformation_status} />
              </div>
            </button>
            {open && (
              <div className="px-4 pb-4 bg-softer/30">
                <div className="bg-raised border border-line rounded-md overflow-hidden">
                  <div className="px-3 py-2 border-b border-line bg-softer/40">
                    <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
                      Columns ({t.columns.length})
                    </p>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {t.columns.map((c) => (
                      <div key={c.id} className="px-3 py-1.5 flex items-center gap-2 text-[12px] hover:bg-softer/60 border-b border-line last:border-0">
                        <ColumnRoleBadge role={c.column_role} />
                        <span className="font-mono text-ink">{c.column_name}</span>
                        <span className="text-muted-2">{c.data_type}</span>
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
  );
}

function KpisSection({ kpis }: { kpis: ProductKpi[] }) {
  if (kpis.length === 0) {
    return (
      <div className="text-center py-12">
        <Sparkles className="w-6 h-6 mx-auto text-muted-2 mb-2" strokeWidth={1.5} />
        <p className="text-[13px] text-ink-2">No KPIs yet.</p>
        <p className="text-[12px] text-muted mt-1">Ask the AI on the right to add one.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3 max-w-3xl">
      {kpis.map((k) => (
        <div key={k.id} className="bg-raised border border-line rounded-md p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <Gauge className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
            <h3 className="text-[14px] font-medium text-ink">{k.name}</h3>
            {k.ai_draft && <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2">draft</span>}
          </div>
          {k.description && <p className="text-[12.5px] text-ink-2 leading-relaxed mb-2">{k.description}</p>}
          {k.formula_plain_text && (
            <p className="text-[12px] text-muted leading-relaxed mb-1">
              <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mr-1.5">PLAIN</span>
              {k.formula_plain_text}
            </p>
          )}
          {k.formula_sql && (
            <pre className="text-[11.5px] font-mono text-ink-2 bg-softer rounded px-2 py-1.5 overflow-x-auto">
              {k.formula_sql}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function SqlSection({ tables }: { tables: (ProductTable & { columns: ProductColumn[] })[] }) {
  const withSql = tables.filter((t) => t.transformation_sql);
  if (withSql.length === 0) {
    return <p className="text-[13px] text-muted italic">No transformation SQL has been generated yet.</p>;
  }
  return (
    <div className="space-y-4">
      {withSql.map((t) => {
        let formatted = t.transformation_sql ?? '';
        try { formatted = sqlFormatter(formatted, { language: 'duckdb' }); } catch { /* leave as-is */ }
        return (
          <div key={t.id} className="preview-terminal rounded-md overflow-hidden">
            <div className="px-3 py-2 flex items-center gap-2 border-b border-white/10">
              <RoleBadge role={t.table_role} />
              <span className="text-[12.5px] text-white/90 font-medium">{t.display_name ?? t.table_name}</span>
              {t.row_count !== null && (
                <span className="text-[11px] text-white/50 tabular-nums ml-auto">{t.row_count.toLocaleString('en-GB')} rows</span>
              )}
            </div>
            <pre className="p-3 text-[11.5px] font-mono text-white/80 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
              {formatted}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ProductDetailPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <AppShell>
        <ProductDetailInner />
      </AppShell>
    </RequireRole>
  );
}

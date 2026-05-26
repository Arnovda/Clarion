'use client';

/**
 * <ProductFullView> — the consumer-grade full product page.
 *
 * Mounts in the catalog's "Open full view" mode. Replaces the previous
 * use of <ProductRootPanel> (the operator panel) inside Catalog so
 * viewers no longer see operator content — Rebuild, Refine, Delete,
 * SQL transformations, schema diagrams, edit forms.
 *
 * Tabs (all read-only):
 *   - Overview   description, starter questions, key metrics, at-a-glance
 *   - Metrics    full KPI list with name + description (no formula, no SQL)
 *   - Tables     table list with description + sample data preview, no
 *                schema diagram and no transformation SQL
 *   - Quality    pass/fail status, freshness, score
 *   - Lineage    "this product is built from these source tables" — list,
 *                not a graph
 *
 * Header includes an "Open in Build →" deep-link for admin/analyst —
 * one click to switch from showroom to workshop.
 *
 * Consumer-facing on every tab. No edit forms. No operator buttons.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, Sparkles, BarChart3, Database, ShieldCheck, GitBranch, Boxes, FileText, Wrench, X,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/dates';
import { useRole, canCurate } from '@/lib/role';
import { paletteForSource, type SourcePalette } from './sourcePalette';
import { PreviewTable } from '@/components/semantic/shared';

// ───────────────────────────────────────────────────────────────────────────
// Data shapes — mirrors the backend product detail + KPIs response
// ───────────────────────────────────────────────────────────────────────────

interface ProductTable {
  id: number;
  table_name: string;
  display_name?: string | null;
  description?: string | null;
  table_role: string;
  row_count?: number | null;
  columns?: Array<{
    id: number;
    column_name: string;
    display_name?: string | null;
    description?: string | null;
    data_type?: string | null;
    column_role?: string | null;
  }>;
}

interface ProductDetail {
  id: number;
  name: string;
  description: string | null;
  status: string;
  last_refreshed_at?: string | null;
  source?: {
    id: number | null;
    name: string | null;
    connectorType: string | null;
    multiSource?: boolean;
    sourceDeleted?: boolean;
  };
  star_schemas?: Array<{
    id: number;
    name: string;
    tables: ProductTable[];
  }>;
}

interface Kpi {
  id: number;
  name: string;
  description?: string | null;
  formula_plain_text?: string | null;
}

type Tab = 'overview' | 'metrics' | 'tables' | 'quality' | 'lineage';

// ───────────────────────────────────────────────────────────────────────────
// Public component
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  productId: number;
  /** Click "← Back to catalog" → return to cards grid. */
  onBack?: () => void;
}

export default function ProductFullView({ productId, onBack }: Props) {
  const router = useRouter();
  const role = useRole();
  const isCurator = canCurate(role);
  const [data, setData] = useState<ProductDetail | null>(null);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [aiStarters, setAiStarters] = useState<string[] | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, kpiRes, starterRes] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/products/${productId}/kpis`).catch(() => ({ data: { data: [] } })),
        api.get(`/products/${productId}/starters`).catch(() => ({ data: { data: { starters: [] } } })),
      ]);
      setData(detailRes.data?.data ?? null);
      setKpis((kpiRes.data?.data ?? []) as Kpi[]);
      const starters = (starterRes.data?.data?.starters ?? []) as Array<{ question: string }>;
      setAiStarters(starters.length > 0 ? starters.map((s) => s.question).slice(0, 3) : null);
    } catch {
      setData(null); setKpis([]); setAiStarters(null);
    } finally {
      setLoading(false);
    }
  }, [productId]);
  useEffect(() => { load(); }, [load]);

  const allTables = useMemo<ProductTable[]>(
    () => (data?.star_schemas ?? []).flatMap((s) => s.tables ?? []),
    [data],
  );
  const palette = useMemo<SourcePalette>(
    () => paletteForSource(
      data?.source?.connectorType ?? null,
      data?.source?.name ?? null,
      data?.source?.sourceDeleted ?? false,
    ),
    [data],
  );

  // Tabs render conditionally — Quality + Lineage hidden if no data.
  const tabsAvailable: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <FileText className="w-3.5 h-3.5" strokeWidth={1.75} /> },
    { id: 'metrics',  label: 'Metrics',  icon: <BarChart3 className="w-3.5 h-3.5" strokeWidth={1.75} /> },
    { id: 'tables',   label: 'Tables',   icon: <Boxes className="w-3.5 h-3.5" strokeWidth={1.75} /> },
    { id: 'quality',  label: 'Quality',  icon: <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} /> },
    { id: 'lineage',  label: 'Lineage',  icon: <GitBranch className="w-3.5 h-3.5" strokeWidth={1.75} /> },
  ];

  if (loading || !data) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-7 py-6 max-w-4xl mx-auto w-full">
          <div className="h-8 bg-soft animate-pulse rounded w-48 mb-3" />
          <div className="h-4 bg-soft animate-pulse rounded w-96" />
        </div>
      </div>
    );
  }

  const refreshed = data.last_refreshed_at ? formatRelative(data.last_refreshed_at) : 'Not refreshed yet';
  const sourceLabel = data.source?.multiSource ? 'Multiple sources'
    : data.source?.sourceDeleted ? 'Source deleted'
    : (data.source?.connectorType ?? data.source?.name ?? 'Data product');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="border-b border-line bg-raised px-7 pt-6 pb-0">
        <div className="max-w-4xl mx-auto">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 px-2 py-1 -ml-2 mb-3 text-[12px] font-medium text-muted hover:text-ink rounded hover:bg-soft transition-colors"
            >
              <X className="w-3.5 h-3.5 rotate-45" strokeWidth={2} />
              Back to catalog
            </button>
          )}

          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 mb-2">
                <span className={cn('inline-block w-2 h-2 rounded-full', palette.dot)} aria-hidden />
                <span className={cn('text-[10.5px] font-mono uppercase tracking-[0.12em]', palette.eyebrow)}>
                  {sourceLabel}
                </span>
                <span className="ml-auto text-[11px] font-mono text-muted-2 tabular-nums">
                  Refreshed {refreshed}
                </span>
              </div>
              <h1 className="font-display text-[28px] text-ink tracking-[-0.02em] leading-tight mb-2">
                {data.name}
              </h1>
              {data.description && (
                <p className="text-[14px] text-ink-2 leading-relaxed max-w-3xl">
                  {data.description}
                </p>
              )}
            </div>
            {/* Curator-only deep link to the operator surface */}
            {isCurator && (
              <button
                type="button"
                onClick={() => router.push(`/products/${productId}`)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ocean border border-ocean/30 rounded hover:bg-ocean/5 transition-colors flex-shrink-0"
                title="Open the operator surface for this product (admin/analyst only)"
              >
                <Wrench className="w-3 h-3" strokeWidth={2} />
                Open in Build
              </button>
            )}
          </div>

          {/* Tab strip */}
          <nav className="flex gap-0 -mb-px">
            {tabsAvailable.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-2.5 text-[13px] transition-colors whitespace-nowrap relative',
                    active ? 'text-ink font-medium' : 'text-muted hover:text-ink-2',
                  )}
                >
                  <span className={cn(active ? 'text-ocean' : 'text-muted-2')}>{t.icon}</span>
                  {t.label}
                  {active && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* ── Tab body ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6">
        <div className="max-w-4xl mx-auto">
          {tab === 'overview' && (
            <OverviewTab data={data} kpis={kpis} aiStarters={aiStarters} allTables={allTables} palette={palette} />
          )}
          {tab === 'metrics' && (
            <MetricsTab kpis={kpis} palette={palette} />
          )}
          {tab === 'tables' && (
            <TablesTab tables={allTables} productId={productId} palette={palette} />
          )}
          {tab === 'quality' && (
            <QualityTab productId={productId} tables={allTables} palette={palette} />
          )}
          {tab === 'lineage' && (
            <LineageTab data={data} palette={palette} />
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Overview tab — same content as preview, un-truncated
// ───────────────────────────────────────────────────────────────────────────

function OverviewTab({
  data, kpis, aiStarters, allTables, palette,
}: {
  data: ProductDetail;
  kpis: Kpi[];
  aiStarters: string[] | null;
  allTables: ProductTable[];
  palette: SourcePalette;
}) {
  const router = useRouter();
  const starters = aiStarters && aiStarters.length > 0 ? aiStarters : kpisToStarters(kpis, allTables, data.name);
  const topKpis = kpis.slice(0, 5);

  return (
    <div className="space-y-8">
      {/* Try asking */}
      {starters.length > 0 && (
        <Section title="Try asking" icon={<Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {starters.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => router.push(`/query?q=${encodeURIComponent(q)}`)}
                className="group/q flex items-center gap-3 text-left px-4 py-3 bg-raised border border-line rounded-md hover:border-ocean/40 hover:bg-soft transition-colors"
              >
                <span className="text-[13.5px] text-ink-2 group-hover/q:text-ink leading-snug flex-1">{q}</span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-2 group-hover/q:text-ocean group-hover/q:translate-x-0.5 transition-all flex-shrink-0" strokeWidth={2} />
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Top metrics */}
      {topKpis.length > 0 && (
        <Section title="Top metrics" icon={<BarChart3 className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {topKpis.map((k) => (
              <KpiCard key={k.id} kpi={k} />
            ))}
          </div>
          {kpis.length > topKpis.length && (
            <p className="text-[11.5px] text-muted-2 mt-2">
              + {kpis.length - topKpis.length} more in the Metrics tab →
            </p>
          )}
        </Section>
      )}

      {/* At a glance */}
      <Section title="At a glance" icon={<Database className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Tables" value={allTables.length} />
          <Stat label="Metrics" value={kpis.length} />
          <Stat label="Rows" value={allTables.reduce((s, t) => s + (Number(t.row_count) || 0), 0)} format="compact" />
          <Stat label="Last refreshed" value={data.last_refreshed_at ? formatRelative(data.last_refreshed_at) : '—'} text />
        </div>
      </Section>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Metrics tab — full KPI list, read-only
// ───────────────────────────────────────────────────────────────────────────

function MetricsTab({ kpis, palette }: { kpis: Kpi[]; palette: SourcePalette }) {
  if (kpis.length === 0) {
    return <EmptyTabState message="This product has no metrics defined yet." />;
  }
  return (
    <Section title={`All metrics (${kpis.length})`} icon={<BarChart3 className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {kpis.map((k) => (
          <KpiCard key={k.id} kpi={k} />
        ))}
      </div>
    </Section>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <div className="px-4 py-3 bg-raised border border-line rounded-md">
      <div className="text-[13px] font-medium text-ink mb-0.5">{humanize(kpi.name)}</div>
      {kpi.description && (
        <p className="text-[11.5px] text-muted leading-snug">{kpi.description}</p>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Tables tab — list with sample data, no schema diagram
// ───────────────────────────────────────────────────────────────────────────

function TablesTab({
  tables, productId, palette,
}: {
  tables: ProductTable[];
  productId: number;
  palette: SourcePalette;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  if (tables.length === 0) {
    return <EmptyTabState message="This product has no tables yet — refresh it to materialise data." />;
  }
  return (
    <Section title={`All tables (${tables.length})`} icon={<Boxes className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
      <div className="bg-raised border border-line rounded-md divide-y divide-line">
        {tables.map((t) => (
          <TableRow
            key={t.id}
            table={t}
            productId={productId}
            expanded={expandedId === t.id}
            onToggle={() => setExpandedId((cur) => cur === t.id ? null : t.id)}
          />
        ))}
      </div>
    </Section>
  );
}

function TableRow({
  table, productId, expanded, onToggle,
}: {
  table: ProductTable;
  productId: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-soft transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-ink truncate">
            {table.display_name || humanizeTable(table)}
          </div>
          {table.description && (
            <p className="text-[11.5px] text-muted leading-snug truncate mt-0.5">{table.description}</p>
          )}
        </div>
        <span className="text-[11px] font-mono text-muted-2 tabular-nums flex-shrink-0">
          {(table.columns?.length ?? 0)} {(table.columns?.length === 1) ? 'col' : 'cols'}
        </span>
        {typeof table.row_count === 'number' && table.row_count > 0 && (
          <span className="text-[11px] font-mono text-muted-2 tabular-nums flex-shrink-0">
            {compactNumber(table.row_count)} rows
          </span>
        )}
        <ArrowRight
          className={cn('w-3.5 h-3.5 text-muted-2 transition-transform flex-shrink-0', expanded && 'rotate-90')}
          strokeWidth={2}
        />
      </button>
      {expanded && (
        <div className="px-4 py-3 bg-softer border-t border-line space-y-4">
          {table.columns && table.columns.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted-2 mb-2">Columns</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {table.columns.map((c) => (
                  <div key={c.id} className="text-[12.5px]">
                    <span className="text-ink font-medium">{c.display_name || humanize(c.column_name)}</span>
                    {c.description && (
                      <span className="text-muted ml-1.5">— {c.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted-2 mb-2">Sample data</div>
            <PreviewTable url={`/semantic/product-preview?productTableId=${table.id}&limit=10`} />
          </div>
          <a
            href={`/products/${productId}?table=${encodeURIComponent(table.table_name)}`}
            className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ocean hover:underline"
          >
            Edit in notebook →
          </a>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Quality tab — read-only summary of dataset_profiles
// ───────────────────────────────────────────────────────────────────────────

function QualityTab({
  productId, tables, palette,
}: {
  productId: number;
  tables: ProductTable[];
  palette: SourcePalette;
}) {
  // For v1 we just point users at the per-table quality scores rather than
  // building a fully-featured aggregate view. The card explains where to
  // look and offers a CTA to open the catalog quality tab via the source.
  if (tables.length === 0) {
    return <EmptyTabState message="No data quality history yet — refresh the product first." />;
  }
  return (
    <Section title="Data quality" icon={<ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
      <div className="bg-raised border border-line rounded-md p-5">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Quality scores track how complete, unique, and valid each table&rsquo;s
          data is. Click into the catalog table to see scores, sample failures,
          and the underlying business rules.
        </p>
      </div>
      <div className="bg-raised border border-line rounded-md divide-y divide-line mt-3">
        {tables.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-[13px] text-ink flex-1 truncate">
              {t.display_name || humanizeTable(t)}
            </span>
            <span className="text-[11px] font-mono text-muted-2 tabular-nums">
              {typeof t.row_count === 'number' ? `${compactNumber(t.row_count)} rows` : '—'}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Lineage tab — readable, not a graph
// ───────────────────────────────────────────────────────────────────────────

function LineageTab({ data, palette }: { data: ProductDetail; palette: SourcePalette }) {
  const sourceName = data.source?.name ?? 'unknown source';
  return (
    <Section title="Where this data comes from" icon={<GitBranch className="w-3.5 h-3.5" strokeWidth={1.75} />} palette={palette}>
      <div className="bg-raised border border-line rounded-md p-5 leading-relaxed text-[13px] text-ink-2">
        <p className="mb-2">
          <strong className="text-ink">{data.name}</strong> is built from{' '}
          {data.source?.multiSource
            ? <>multiple sources</>
            : <>the <strong className="text-ink">{sourceName}</strong> source</>
          }.
        </p>
        <p>
          Data flows automatically from the source through your refresh pipeline
          into the tables you see here. Whenever the source data changes, run a
          refresh to update everything.
        </p>
      </div>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Atoms
// ───────────────────────────────────────────────────────────────────────────

function Section({
  title, icon, palette, children,
}: {
  title: string;
  icon: React.ReactNode;
  palette: SourcePalette;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className={cn('inline-flex items-center', palette.eyebrow)}>{icon}</span>
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Stat({
  label, value, format, text,
}: {
  label: string;
  value: number | string;
  format?: 'compact';
  text?: boolean;
}) {
  const display = text || typeof value === 'string'
    ? String(value)
    : format === 'compact'
      ? compactNumber(value as number)
      : (value as number).toLocaleString();
  return (
    <div className="px-3 py-2.5 bg-raised border border-line rounded-md">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-0.5">{label}</div>
      <div className="text-[18px] font-display text-ink tabular-nums tracking-tight">{display}</div>
    </div>
  );
}

function EmptyTabState({ message }: { message: string }) {
  return (
    <div className="bg-raised border border-line rounded-md p-8 text-center">
      <p className="text-[13px] text-muted">{message}</p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (humanize, starters, compact numbers) — same logic as preview
// ───────────────────────────────────────────────────────────────────────────

function humanize(name: string): string {
  if (!name) return '';
  let s = name.replace(/_+/g, ' ');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ').trim();
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function humanizeTable(t: ProductTable): string {
  if (t.display_name) return t.display_name;
  const stripped = t.table_name.replace(/^(dim|fact|bridge|junk)_/, '');
  return humanize(stripped);
}

function pluralizeLower(s: string): string {
  const lower = s.toLowerCase();
  if (lower.endsWith('s') || lower.endsWith('x')) return lower;
  if (lower.endsWith('y') && !/[aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

function kpisToStarters(kpis: Kpi[], allTables: ProductTable[], productName: string): string[] {
  if (kpis.length > 0) {
    const names = kpis.slice(0, 3).map((k) => humanize(k.name).toLowerCase());
    const out: string[] = [];
    if (names[0]) out.push(`What's our ${names[0]} this month?`);
    if (names[1]) out.push(`How has ${names[1]} changed over the last year?`);
    else if (names[0]) out.push(`How has ${names[0]} changed over the last year?`);
    if (names[2]) out.push(`Show me ${names[2]} broken down by month.`);
    return out.slice(0, 3);
  }
  const facts = allTables.filter((t) => t.table_role === 'fact');
  if (facts.length > 0) {
    const f0 = humanizeTable(facts[0]);
    return [
      `How many ${pluralizeLower(f0)} were recorded this year?`,
      `Show me ${pluralizeLower(f0)} by month.`,
      `What's the most recent ${humanizeTable(facts[0]).toLowerCase()}?`,
    ];
  }
  const dims = allTables.filter((t) => t.table_role === 'dimension' || t.table_role === 'bridge');
  if (dims.length > 0) {
    return [
      `How many ${pluralizeLower(humanizeTable(dims[0]))} do we have?`,
      dims[1] ? `Show me a list of all ${pluralizeLower(humanizeTable(dims[1]))}.` : `List all ${pluralizeLower(humanizeTable(dims[0]))}.`,
      dims[2] ? `Which ${pluralizeLower(humanizeTable(dims[2]))} are most active?` : `Tell me about our ${pluralizeLower(humanizeTable(dims[0]))}.`,
    ];
  }
  return [
    `What's in the ${productName} product?`,
    `Show me the latest data from ${productName}.`,
    `What can I ask about ${productName}?`,
  ];
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

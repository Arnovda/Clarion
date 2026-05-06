'use client';

/**
 * <ProductPreviewPanel> — clean, focused product detail for the cards UX.
 *
 * Replaces the noisy 6-tab full panel as the default first-click view
 * of a data product. Shows only what a business user actually needs to
 * decide "is this what I'm looking for?" and "what can I ask?":
 *
 *   - Title, description, source tint, freshness
 *   - 3 starter questions (chips, deep-link to /query)
 *   - Top 5 metrics (name + description; no formula, no SQL)
 *   - At-a-glance counts (tables, dimensions, rows)
 *   - "See full details →" button → expands inline to ProductRootPanel
 *     with all the existing tabs intact (admin/analyst can still get to
 *     schema diagrams, SQL, history, etc.)
 *
 * The preview uses no AI tokens; starter questions are templated from
 * the product's KPI list. If a product has no KPIs we fall back to
 * generic questions ("Show me the latest data") so the chips never
 * disappear entirely.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Sparkles, BarChart3, Database, ChevronRight, X } from 'lucide-react';
import api from '@/lib/api';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import ProductRootPanel from '@/components/products/ProductRootPanel';
import { paletteForSource, type SourcePalette } from './sourcePalette';

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
  tables?: Array<{
    id: number;
    table_role: string;
    row_count?: number | null;
  }>;
  columns?: Array<{
    id: number;
    column_role?: string | null;
  }>;
  kpis?: Array<{
    id: number;
    name: string;
    description?: string | null;
  }>;
}

interface Props {
  productId: number;
  /** Hint from the parent so we can render header instantly while the
   *  full detail loads — avoids the layout flash. */
  hint?: {
    name: string;
    description: string | null;
    status: string;
    source: {
      id: number | null;
      name: string | null;
      connectorType: string | null;
      multiSource?: boolean;
      sourceDeleted?: boolean;
    };
    last_refreshed_at: string | null;
  };
  onProductDeleted?: () => void;
  onClose?: () => void;
}

export default function ProductPreviewPanel({ productId, hint, onProductDeleted, onClose }: Props) {
  const router = useRouter();
  const [data, setData] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFull, setShowFull] = useState(false);

  // Reset full-mode flag whenever the selected product changes — new
  // selection always opens in preview, never carries over the previous
  // product's expanded state.
  useEffect(() => { setShowFull(false); }, [productId]);

  // Load full product detail. This is a heavier endpoint than what we
  // strictly need for the preview, but it's the same call the full panel
  // would make anyway — so when the user clicks "See full details" the
  // ProductRootPanel mounts with the cache already warm.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/products/${productId}`);
      setData(res.data.data ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [productId]);
  useEffect(() => { load(); }, [load]);

  // Derive the visual palette + readable freshness from whichever data
  // source is freshest — hint comes from the card click and is instant;
  // data comes from the API and is canonical.
  const sourceMeta = data?.source ?? hint?.source;
  const palette = useMemo<SourcePalette>(
    () => paletteForSource(
      sourceMeta?.connectorType ?? null,
      sourceMeta?.name ?? null,
      sourceMeta?.sourceDeleted ?? false,
    ),
    [sourceMeta],
  );
  const refreshed = (data?.last_refreshed_at ?? hint?.last_refreshed_at)
    ? formatRelative((data?.last_refreshed_at ?? hint?.last_refreshed_at) as string)
    : 'Not refreshed yet';

  const name        = data?.name        ?? hint?.name        ?? '…';
  const description = data?.description ?? hint?.description ?? '';
  const status      = data?.status      ?? hint?.status      ?? '';

  // Stats — only shown once we have the canonical detail.
  const stats = useMemo(() => {
    if (!data) return null;
    const tables = data.tables ?? [];
    const cols = data.columns ?? [];
    const factCount = tables.filter((t) => t.table_role === 'fact').length;
    const dimCount = cols.filter((c) => c.column_role === 'dimension' || c.column_role === 'attribute').length;
    const rowCount = tables.reduce((s, t) => s + (Number(t.row_count) || 0), 0);
    return {
      tableCount: tables.length,
      factCount,
      dimensionCount: dimCount,
      rowCount,
      kpiCount: data.kpis?.length ?? 0,
    };
  }, [data]);

  const starters = useMemo(() => buildStarters(data), [data]);
  const topKpis = (data?.kpis ?? []).slice(0, 5);

  // Full-detail mode: punt to the existing ProductRootPanel. Same
  // selection, same component, same role-gated affordances. Adding a
  // "back to summary" header so the user can return to the preview.
  if (showFull) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-2 px-5 py-2.5 bg-softer border-b border-line flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowFull(false)}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11.5px] font-medium text-muted hover:text-ink rounded hover:bg-soft transition-colors"
            title="Back to summary"
          >
            <ChevronRight className="w-3.5 h-3.5 rotate-180" strokeWidth={2} />
            Back to summary
          </button>
          <span className="text-[11px] font-mono text-muted-2 tracking-[0.08em] uppercase ml-auto">Full detail</span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-soft text-muted hover:text-ink transition-colors"
              title="Close"
            >
              <X className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <ProductRootPanel
            key={`pr-${productId}`}
            productId={productId}
            onDeleted={onProductDeleted}
            showBackButton={false}
            embedAskAI={false}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Close button on the preview panel — sits over the card-grid view */}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded hover:bg-soft text-muted hover:text-ink transition-colors"
          title="Close"
        >
          <X className="w-4 h-4" strokeWidth={2} />
        </button>
      )}

      <div className="px-7 py-6 max-w-2xl mx-auto">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <div className="flex items-center gap-2.5 mb-3">
            <span className={cn('inline-block w-2 h-2 rounded-full', palette.dot)} aria-hidden />
            <span className={cn('text-[10.5px] font-mono uppercase tracking-[0.12em]', palette.eyebrow)}>
              {sourceMeta?.multiSource ? 'Multiple sources'
                : sourceMeta?.sourceDeleted ? 'Source deleted'
                : (sourceMeta?.connectorType ?? sourceMeta?.name ?? 'Data product')}
            </span>
            {status && !['approved', 'success'].includes(status) && (
              <span className="px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.08em] rounded border border-warn/30 bg-warn-soft text-warn">
                {status}
              </span>
            )}
            <span className="ml-auto text-[11px] font-mono text-muted-2 tabular-nums">
              {refreshed}
            </span>
          </div>

          <h1 className="font-display text-[28px] text-ink tracking-[-0.02em] leading-tight mb-2">
            {name}
          </h1>
          {description && (
            <p className="text-[14px] text-ink-2 leading-relaxed">
              {description}
            </p>
          )}
        </div>

        {/* ── Try asking — starter questions ─────────────────────────────── */}
        <Section
          title="Try asking"
          icon={<Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />}
          palette={palette}
        >
          <div className="space-y-2">
            {starters.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => router.push(`/query?q=${encodeURIComponent(q)}`)}
                className={cn(
                  'group/q flex items-center gap-3 w-full text-left px-4 py-3 bg-raised border border-line rounded-md',
                  'hover:border-ocean/40 hover:bg-soft transition-colors',
                )}
              >
                <span className="text-[13.5px] text-ink-2 group-hover/q:text-ink leading-snug flex-1">
                  {q}
                </span>
                <ArrowRight
                  className="w-3.5 h-3.5 text-muted-2 group-hover/q:text-ocean group-hover/q:translate-x-0.5 transition-all flex-shrink-0"
                  strokeWidth={2}
                />
              </button>
            ))}
          </div>
        </Section>

        {/* ── Key metrics ────────────────────────────────────────────────── */}
        {topKpis.length > 0 && (
          <Section
            title="Key metrics"
            icon={<BarChart3 className="w-3.5 h-3.5" strokeWidth={1.75} />}
            count={data?.kpis?.length}
            palette={palette}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {topKpis.map((k) => (
                <div
                  key={k.id}
                  className="px-4 py-3 bg-raised border border-line rounded-md"
                >
                  <div className="text-[13px] font-medium text-ink mb-0.5">
                    {humanize(k.name)}
                  </div>
                  {k.description && (
                    <p className="text-[11.5px] text-muted leading-snug line-clamp-2">
                      {k.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {(data?.kpis?.length ?? 0) > topKpis.length && (
              <p className="text-[11.5px] text-muted-2 mt-2">
                and {(data?.kpis?.length ?? 0) - topKpis.length} more →
              </p>
            )}
          </Section>
        )}

        {/* ── At a glance — quick stats ──────────────────────────────────── */}
        {stats && (
          <Section
            title="At a glance"
            icon={<Database className="w-3.5 h-3.5" strokeWidth={1.75} />}
            palette={palette}
          >
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Tables" value={stats.tableCount} />
              <Stat label="Dimensions" value={stats.dimensionCount} />
              <Stat label="Metrics" value={stats.kpiCount} />
              <Stat label="Rows" value={stats.rowCount} format="compact" />
            </div>
          </Section>
        )}

        {/* ── See full details ───────────────────────────────────────────── */}
        <div className="mt-8 pt-6 border-t border-line">
          <button
            type="button"
            onClick={() => setShowFull(true)}
            disabled={loading}
            className="group/full inline-flex items-center gap-2 text-[13px] font-medium text-ocean hover:text-ocean-hover transition-colors disabled:opacity-50"
          >
            See full details
            <ArrowRight className="w-3.5 h-3.5 group-hover/full:translate-x-0.5 transition-transform" strokeWidth={2} />
          </button>
          <p className="text-[11.5px] text-muted-2 mt-1">
            Schema diagram, transformation SQL, quality history, and admin tools.
          </p>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Section + Stat primitives
// ───────────────────────────────────────────────────────────────────────────

function Section({
  title, icon, count, palette, children,
}: {
  title: string;
  icon?: React.ReactNode;
  count?: number;
  palette: SourcePalette;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="flex items-baseline gap-2 mb-3">
        <span className={cn('inline-flex items-center', palette.eyebrow)}>{icon}</span>
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium">
          {title}
        </h2>
        {typeof count === 'number' && count > 0 && (
          <span className="text-[10.5px] font-mono text-muted-2 tabular-nums">
            ({count})
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, format }: { label: string; value: number; format?: 'compact' }) {
  const display = format === 'compact'
    ? compactNumber(value)
    : value.toLocaleString();
  return (
    <div className="px-3 py-2.5 bg-raised border border-line rounded-md">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-0.5">{label}</div>
      <div className="text-[18px] font-display text-ink tabular-nums tracking-tight">{display}</div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Starter-question generation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a small, plain-English set of starter questions from the product's
 * KPI list. No AI call — uses the KPI display names directly. Falls back
 * to product-name-based generics when no KPIs exist so the section never
 * appears empty.
 */
function buildStarters(data: ProductDetail | null): string[] {
  if (!data) return [];
  const kpis = (data.kpis ?? []).slice(0, 3);
  if (kpis.length >= 2) {
    const k1 = humanize(kpis[0].name).toLowerCase();
    const k2 = kpis[1] ? humanize(kpis[1].name).toLowerCase() : k1;
    const k3 = kpis[2] ? humanize(kpis[2].name).toLowerCase() : k1;
    return [
      `What's our ${k1} this month?`,
      `How has ${k2} changed over the last year?`,
      `Show me ${k3} broken down by month.`,
    ];
  }
  if (kpis.length === 1) {
    const k = humanize(kpis[0].name).toLowerCase();
    return [
      `What's our ${k} this month?`,
      `How has ${k} changed over the last year?`,
      `Show me ${k} broken down by month.`,
    ];
  }
  // No KPIs yet — fall back to generic discovery questions referencing the
  // product name. Better than an empty section.
  const product = data.name.toLowerCase();
  return [
    `What does the ${product} data show this month?`,
    `Give me a summary of recent ${product} activity.`,
    `What are the most important trends in ${product}?`,
  ];
}

/**
 * Convert a SQL/identifier-style name (CamelCase, snake_case) into a
 * plain-English phrase. "CreditLineSales" → "Credit Line Sales";
 * "credit_line_sales" → "Credit Line Sales".
 */
function humanize(name: string): string {
  if (!name) return '';
  // snake_case → spaces
  let s = name.replace(/_+/g, ' ');
  // Insert space before uppercase letters that follow a lowercase one
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Insert space inside ALL-CAPS runs followed by a lower (e.g. ABCFooBar → ABC Foo Bar)
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  // Collapse runs of whitespace, trim
  s = s.replace(/\s+/g, ' ').trim();
  // Title-case the first letter of each word
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000)   return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

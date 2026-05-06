'use client';

/**
 * <BuildDashboard> — the workshop overview that lives at /products.
 *
 * This is the operator surface — distinct from /catalog (consumer
 * discovery). Where Catalog is a card showroom built around "what can I
 * ask?", Build is a command center built around "what needs my
 * attention as a data owner?".
 *
 * Composition:
 *   - <StatusOverviewTiles>  — 4 tiles: Total / OK / Stale / Error
 *   - <AISuggestionsPanel>   — proactive co-pilot prompts
 *   - <ProductsList>         — table view with status, source, refresh
 *   - <RecentActivityFeed>   — pipeline runs + notifications
 *
 * Data fetched once via GET /api/build/dashboard (single round-trip,
 * tenant-scoped via RLS, cached server-side).
 *
 * Click a row → opens that product's full ProductRootPanel via
 * /products/[id]. Refresh inline via the per-row action menu.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Sparkles, Loader2,
  ChevronRight, Boxes, RefreshCw,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/dates';

// ───────────────────────────────────────────────────────────────────────────
// Types — mirror backend /api/build/dashboard
// ───────────────────────────────────────────────────────────────────────────

export type DerivedStatus = 'ok' | 'stale' | 'error' | 'designing';

export interface DashboardProduct {
  id: number;
  name: string;
  description: string | null;
  status: string;
  derivedStatus: DerivedStatus;
  lastRefreshedAt: string | null;
  tableCount: number;
  kpiCount: number;
  failedTableCount: number;
  source: { id: number | null; name: string | null; connectorType: string | null };
}

export interface DashboardSuggestion {
  id: string;
  kind: 'drift' | 'failed' | 'unbuilt' | 'kpi';
  severity: 'info' | 'warning' | 'error';
  productId: number | null;
  productName: string | null;
  text: string;
  action?: { label: string; href?: string; method?: string; endpoint?: string };
}

export interface DashboardActivity {
  id: string;
  at: string;
  kind: 'refresh' | 'design' | 'suggestion' | 'alert';
  productId: number | null;
  productName: string | null;
  status: string;
  message: string;
}

export interface DashboardData {
  products: DashboardProduct[];
  statusCounts: { total: number; ok: number; stale: number; error: number; designing: number };
  suggestions: DashboardSuggestion[];
  recentActivity: DashboardActivity[];
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  /** Optional: launch the design wizard from outside (top-bar + Design new). */
  onDesignNew?: () => void;
  /** Optional: launch a per-product refresh (parent owns the SSE terminal). */
  onRefreshProduct?: (productId: number, productName: string, syncSource: boolean) => void;
}

export default function BuildDashboard({ onDesignNew, onRefreshProduct }: Props) {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/build/dashboard');
      setData(res.data?.data ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openProduct = useCallback((id: number) => {
    router.push(`/products/${id}`);
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted py-12 px-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading workshop…
      </div>
    );
  }
  if (!data) {
    return <div className="px-6 py-12 text-[13px] text-muted">Could not load dashboard.</div>;
  }

  return (
    <div className="space-y-6">
      <StatusOverviewTiles counts={data.statusCounts} />
      {data.suggestions.length > 0 && (
        <AISuggestionsPanel
          suggestions={data.suggestions}
          onAction={(s) => {
            if (s.action?.href) router.push(s.action.href);
            else if (s.action?.endpoint && onRefreshProduct && s.productId && s.productName) {
              onRefreshProduct(s.productId, s.productName, true);
            }
          }}
        />
      )}
      <ProductsList
        products={data.products}
        onOpen={openProduct}
        onRefresh={onRefreshProduct ? (id, name) => onRefreshProduct(id, name, true) : undefined}
        onDesignNew={onDesignNew}
      />
      <RecentActivityFeed activity={data.recentActivity} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Status overview tiles
// ───────────────────────────────────────────────────────────────────────────

function StatusOverviewTiles({ counts }: { counts: DashboardData['statusCounts'] }) {
  return (
    <section>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatusTile label="Total" value={counts.total} tone="neutral" icon={<Boxes className="w-3.5 h-3.5" strokeWidth={1.75} />} />
        <StatusTile label="Healthy" value={counts.ok} tone="ok" icon={<CheckCircle2 className="w-3.5 h-3.5" strokeWidth={1.75} />} />
        <StatusTile label="Stale" value={counts.stale} tone="warn" icon={<Clock className="w-3.5 h-3.5" strokeWidth={1.75} />} />
        <StatusTile label="Errors" value={counts.error} tone="err" icon={<AlertTriangle className="w-3.5 h-3.5" strokeWidth={1.75} />} />
      </div>
    </section>
  );
}

function StatusTile({
  label, value, tone, icon,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'ok' | 'warn' | 'err';
  icon: React.ReactNode;
}) {
  const toneClass = tone === 'ok' ? 'text-emerald-700'
    : tone === 'warn' ? 'text-amber-700'
    : tone === 'err'  ? 'text-rose-700'
    : 'text-muted-2';
  return (
    <div className="bg-raised border border-line rounded-md px-4 py-3">
      <div className={cn('flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.12em]', toneClass)}>
        {icon}
        {label}
      </div>
      <div className="text-[26px] font-display text-ink tabular-nums tracking-[-0.02em] mt-1">
        {value}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 2. AI suggestions panel
// ───────────────────────────────────────────────────────────────────────────

function AISuggestionsPanel({
  suggestions, onAction,
}: {
  suggestions: DashboardSuggestion[];
  onAction: (s: DashboardSuggestion) => void;
}) {
  return (
    <section className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line bg-softer flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium">
          AI suggestions
        </h2>
        <span className="text-[10.5px] font-mono text-muted-2 tabular-nums ml-auto">
          {suggestions.length}
        </span>
      </header>
      <div className="divide-y divide-line">
        {suggestions.slice(0, 5).map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-5 py-3">
            <SuggestionDot severity={s.severity} />
            <span className="text-[13px] text-ink flex-1 leading-snug">
              {s.text}
            </span>
            {s.action && (
              <button
                type="button"
                onClick={() => onAction(s)}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-medium text-ocean border border-ocean/30 rounded hover:bg-ocean/5 transition-colors"
              >
                {s.action.label}
                <ChevronRight className="w-3 h-3" strokeWidth={2} />
              </button>
            )}
          </div>
        ))}
      </div>
      {suggestions.length > 5 && (
        <div className="px-5 py-2 bg-softer border-t border-line text-[11.5px] text-muted-2">
          + {suggestions.length - 5} more suggestions
        </div>
      )}
    </section>
  );
}

function SuggestionDot({ severity }: { severity: 'info' | 'warning' | 'error' }) {
  const tone = severity === 'error' ? 'bg-rose-500'
    : severity === 'warning' ? 'bg-amber-500'
    : 'bg-ocean';
  return <span className={cn('inline-block w-2 h-2 rounded-full flex-shrink-0', tone)} aria-hidden />;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Products list — the workshop table
// ───────────────────────────────────────────────────────────────────────────

function ProductsList({
  products, onOpen, onRefresh, onDesignNew,
}: {
  products: DashboardProduct[];
  onOpen: (id: number) => void;
  onRefresh?: (id: number, name: string) => void;
  onDesignNew?: () => void;
}) {
  return (
    <section className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line flex items-center gap-2">
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium">
          Data products
        </h2>
        <span className="text-[10.5px] font-mono text-muted-2 tabular-nums">
          {products.length}
        </span>
        {onDesignNew && (
          <button
            type="button"
            onClick={onDesignNew}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium text-ocean border border-ocean/30 rounded hover:bg-ocean/5 transition-colors"
          >
            <Sparkles className="w-3 h-3" strokeWidth={2} />
            Design new
          </button>
        )}
      </header>

      {products.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-[13px] text-muted mb-2">No data products yet.</p>
          {onDesignNew && (
            <button
              type="button"
              onClick={onDesignNew}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
              Design your first product
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-line">
          {products.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              onOpen={() => onOpen(p.id)}
              onRefresh={onRefresh ? () => onRefresh(p.id, p.name) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProductRow({
  product, onOpen, onRefresh,
}: {
  product: DashboardProduct;
  onOpen: () => void;
  onRefresh?: () => void;
}) {
  return (
    <div className="group flex items-center gap-4 px-5 py-3 hover:bg-soft transition-colors">
      <StatusPill status={product.derivedStatus} />
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 text-left min-w-0"
      >
        <div className="text-[13.5px] font-medium text-ink group-hover:text-ocean transition-colors truncate">
          {product.name}
        </div>
        <div className="text-[11px] text-muted-2 truncate">
          {product.source.name ?? '—'}
          <span className="mx-1.5 text-muted-2/40">·</span>
          {product.tableCount} {product.tableCount === 1 ? 'table' : 'tables'}
          <span className="mx-1.5 text-muted-2/40">·</span>
          {product.kpiCount} {product.kpiCount === 1 ? 'metric' : 'metrics'}
        </div>
      </button>
      <div className="text-[11px] font-mono text-muted-2 tabular-nums hidden sm:block">
        {product.lastRefreshedAt ? formatRelative(product.lastRefreshedAt) : 'never'}
      </div>
      {onRefresh && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
          className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-soft text-muted-2 hover:text-ink transition-all"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      )}
      <ChevronRight className="w-4 h-4 text-muted-2 group-hover:text-ocean transition-colors flex-shrink-0" strokeWidth={2} />
    </div>
  );
}

function StatusPill({ status }: { status: DerivedStatus }) {
  const map: Record<DerivedStatus, { label: string; bg: string; text: string }> = {
    ok:        { label: 'OK',       bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
    stale:     { label: 'Stale',    bg: 'bg-amber-50 border-amber-200',     text: 'text-amber-700' },
    error:     { label: 'Error',    bg: 'bg-rose-50 border-rose-200',       text: 'text-rose-700' },
    designing: { label: 'Designing', bg: 'bg-ocean-softer border-ocean/30', text: 'text-ocean' },
  };
  const m = map[status];
  return (
    <span className={cn('flex-shrink-0 inline-flex items-center px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-[0.08em] rounded border', m.bg, m.text)}>
      {m.label}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Recent activity feed
// ───────────────────────────────────────────────────────────────────────────

function RecentActivityFeed({ activity }: { activity: DashboardActivity[] }) {
  if (activity.length === 0) return null;
  return (
    <section className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-muted-2" strokeWidth={1.75} />
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium">
          Recent activity
        </h2>
      </header>
      <div className="divide-y divide-line">
        {activity.slice(0, 10).map((a) => (
          <div key={a.id} className="flex items-center gap-3 px-5 py-2.5">
            <ActivityDot status={a.status} />
            <span className="text-[13px] text-ink flex-1 truncate">
              {a.message}
            </span>
            <span className="text-[11px] font-mono text-muted-2 tabular-nums flex-shrink-0">
              {formatRelative(a.at)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityDot({ status }: { status: string }) {
  const tone = status === 'succeeded' ? 'bg-emerald-500'
    : status === 'failed' || status === 'partial' ? 'bg-rose-500'
    : status === 'running' || status === 'queued' ? 'bg-ocean'
    : 'bg-neutral-400';
  return <span className={cn('inline-block w-2 h-2 rounded-full flex-shrink-0', tone)} aria-hidden />;
}

'use client';

/**
 * <ProductCardGrid> — the discovery surface for /catalog.
 *
 * Replaces the tree-as-default with a card grid: each data product is a
 * polished card showing what a business user actually wants — name,
 * plain-English description, freshness, metric count. Click → opens
 * detail in the existing panel (which the parent page mounts elsewhere).
 *
 * Design choices:
 *   - Plain-English label only. No snake_case names, no IDs.
 *   - The source connection name is shown as a tiny eyebrow at the top of
 *     the card (small, muted) — gives context for multi-source setups
 *     without dominating the visual.
 *   - "Source deleted" / "Multi-source" rendered as quiet pills, not
 *     loud warnings.
 *   - Freshness shown as relative time ("2h ago", "yesterday"). If a
 *     product has never been refreshed, "Not refreshed yet".
 *   - No status badges (draft / approved) on viewer cards — those are
 *     curator concerns. Admins still see them as a faint top-right pill.
 *   - Hover lifts the card and tints the title; click navigates.
 *   - Empty state has a clear CTA for admins to design their first
 *     product, and a friendlier "ask your admin" message for viewers.
 *
 * The grid is responsive: 1 column on mobile, 2 at md, 3 at lg.
 */

import { useMemo } from 'react';
import { Plus, Database, AlertCircle } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';

export interface ProductCardData {
  id: number;
  name: string;
  description: string | null;
  status: string;
  table_count: number;
  kpi_count: number;
  last_refreshed_at: string | null;
  source: {
    id: number | null;
    name: string | null;
    connectorType: string | null;
    multiSource: boolean;
    sourceDeleted: boolean;
    otherSources?: Array<{ id: number; name: string }>;
  };
}

interface ProductCardGridProps {
  products: ProductCardData[];
  search: string;
  selectedId: number | null;
  onSelect: (productId: number) => void;
  onCreate?: () => void;        // admin-only "design your first product" CTA
  isAdmin?: boolean;
  loading?: boolean;
  /** Show admin-only signals (status pills, etc.) when true. */
  showCuratorSignals?: boolean;
}

export default function ProductCardGrid({
  products,
  search,
  selectedId,
  onSelect,
  onCreate,
  isAdmin,
  loading,
  showCuratorSignals,
}: ProductCardGridProps) {
  // Client-side substring filter — fast, no round-trip. Match against
  // name + description + source name so a search for "exact" finds the
  // EO products, "revenue" finds Sales, etc.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => {
      const haystack = [
        p.name,
        p.description ?? '',
        p.source.name ?? '',
        p.source.connectorType ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [products, search]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[180px] bg-raised border border-line rounded-lg animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <EmptyState onCreate={onCreate} isAdmin={isAdmin} />
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="font-display text-[18px] text-ink mb-1">No matches</p>
        <p className="text-[13px] text-muted">
          Nothing here matches &ldquo;{search}&rdquo;. Try a different word.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filtered.map((p) => (
        <ProductCard
          key={p.id}
          product={p}
          selected={selectedId === p.id}
          onSelect={() => onSelect(p.id)}
          showCuratorSignals={showCuratorSignals}
        />
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// One card
// ───────────────────────────────────────────────────────────────────────────

function ProductCard({
  product, selected, onSelect, showCuratorSignals,
}: {
  product: ProductCardData;
  selected: boolean;
  onSelect: () => void;
  showCuratorSignals?: boolean;
}) {
  const refreshed = product.last_refreshed_at
    ? formatRelative(product.last_refreshed_at)
    : 'Not refreshed yet';

  // Source eyebrow — only shown when there's something useful to say.
  // For multi-source products we display "Multiple sources" rather than
  // listing them; the detail panel has the full list.
  const sourceLabel = product.source.sourceDeleted
    ? 'Source deleted'
    : product.source.multiSource
      ? 'Multiple sources'
      : product.source.name;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative text-left bg-raised border rounded-lg p-5 transition-all',
        'hover:shadow-md hover:-translate-y-0.5',
        selected
          ? 'border-ocean ring-2 ring-ocean/20'
          : 'border-line hover:border-ocean/40',
      )}
    >
      {/* Top eyebrow: source name + status (curator-only). Kept small + muted
          so it never dominates the title. */}
      <div className="flex items-start justify-between gap-2 mb-2">
        {sourceLabel ? (
          <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 truncate">
            <Database className="w-3 h-3 flex-shrink-0" strokeWidth={1.75} />
            <span className="truncate">{sourceLabel}</span>
          </div>
        ) : <span />}
        {showCuratorSignals && product.status && product.status !== 'success' && (
          <StatusPill status={product.status} />
        )}
      </div>

      {/* Title + description — the visual centre of the card. */}
      <h3 className={cn(
        'font-display text-[18px] tracking-[-0.01em] leading-tight mb-1.5 transition-colors',
        selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
      )}>
        {product.name}
      </h3>
      {product.description ? (
        <p className="text-[13px] text-ink-2 leading-relaxed line-clamp-2 mb-4">
          {product.description}
        </p>
      ) : (
        <p className="text-[13px] text-muted italic mb-4">
          No description yet.
        </p>
      )}

      {/* Footer stats — small, mono, scannable. */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-2 tabular-nums pt-3 border-t border-line">
        <span>
          {product.kpi_count} {product.kpi_count === 1 ? 'metric' : 'metrics'}
        </span>
        <span className="text-muted-2/40">·</span>
        <span>
          {product.table_count} {product.table_count === 1 ? 'table' : 'tables'}
        </span>
        <span className="ml-auto">
          {refreshed}
        </span>
      </div>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Status pill (curator-only)
// ───────────────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const colour = status === 'draft' ? 'bg-warn-soft text-warn border-warn/30'
              : status === 'error'  ? 'bg-err-soft text-err border-err/30'
              : 'bg-soft text-muted-2 border-line';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn('px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.08em] rounded border', colour)}>
      {label}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Empty state
// ───────────────────────────────────────────────────────────────────────────

function EmptyState({ onCreate, isAdmin }: { onCreate?: () => void; isAdmin?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto">
      <div className="w-12 h-12 rounded-full bg-ocean-softer flex items-center justify-center mb-4">
        <Database className="w-5 h-5 text-ocean" strokeWidth={1.5} />
      </div>
      <h2 className="font-display text-[20px] text-ink tracking-[-0.01em] mb-2">
        No data products yet
      </h2>
      {isAdmin ? (
        <>
          <p className="text-[13px] text-ink-2 leading-relaxed mb-6">
            Data products are curated, business-friendly views of your data —
            ready for everyone to query and build dashboards on. Design your
            first one from a connected source.
          </p>
          {onCreate && (
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2} />
              Design your first product
            </button>
          )}
        </>
      ) : (
        <p className="text-[13px] text-ink-2 leading-relaxed flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-muted-2 flex-shrink-0 mt-0.5" strokeWidth={1.75} />
          <span>
            An admin needs to design data products before you can browse the
            catalog. Once they&rsquo;re published they&rsquo;ll appear here.
          </span>
        </p>
      )}
    </div>
  );
}

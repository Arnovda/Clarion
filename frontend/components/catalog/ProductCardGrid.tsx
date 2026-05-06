'use client';

/**
 * <ProductCardGrid> — the discovery surface for /catalog.
 *
 * Cards are GROUPED BY SOURCE CONNECTION with a colored section header per
 * group. Each connector type gets a deterministic color from the palette
 * below (ExactOnline → emerald, Postgres → indigo, etc.) so the same
 * source is always tinted the same way across the app — visual continuity,
 * not random theming.
 *
 * Color is used sparingly: a thin left-edge bar on the card + a matching
 * dot in the section header. The card body itself stays neutral so the
 * data leads, not the chrome. "Tasteful color" — Atlassian / Linear
 * vintage, not Google Drive folder colors.
 *
 * Visual hierarchy:
 *   - Section header (display serif, large) — anchors the user in
 *     "what source am I looking at?"
 *   - Cards — title, description, footer stats. No redundant source
 *     eyebrow (the section header already says it).
 *
 * Special groups:
 *   - "Multi-source" products (touch >1 connection) get their own group
 *     at the bottom with a neutral indigo accent.
 *   - "Source deleted" products group at the very bottom with a muted
 *     warning tint so admins can spot them.
 *
 * Status pills only render for off-normal states (draft, error, pending).
 * Products in "approved" or "success" state — the steady state for most
 * deployments — get no pill, since they're the default.
 */

import { useMemo } from 'react';
import { Plus, Database, AlertCircle } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { paletteForSource, type SourcePalette } from './sourcePalette';

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
  onCreate?: () => void;
  isAdmin?: boolean;
  loading?: boolean;
  showCuratorSignals?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Grouping
// ───────────────────────────────────────────────────────────────────────────

interface ProductGroup {
  key: string;                    // unique group identity ('source-1', 'multi', 'deleted', 'unassigned')
  title: string;                  // human-friendly section header label
  subtitle?: string;              // optional small secondary line
  connectorType: string | null;   // for palette lookup
  sourceName: string | null;      // for palette fallback
  sourceDeleted: boolean;
  products: ProductCardData[];
  sortKey: number;                // 0 = normal source, 1 = multi-source, 2 = source deleted, 3 = unassigned
}

function groupProducts(products: ProductCardData[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();

  for (const p of products) {
    let key: string;
    let title: string;
    let connectorType: string | null = null;
    let sourceName: string | null = null;
    let sourceDeleted = false;
    let sortKey = 0;

    if (p.source.multiSource) {
      key = '__multi__';
      title = 'Multi-source';
      sortKey = 1;
    } else if (p.source.sourceDeleted) {
      key = '__deleted__';
      title = 'Source deleted';
      sourceDeleted = true;
      sortKey = 2;
    } else if (p.source.id == null) {
      key = '__unassigned__';
      title = 'Unassigned';
      sortKey = 3;
    } else {
      key = `source-${p.source.id}`;
      title = p.source.name ?? 'Unknown source';
      connectorType = p.source.connectorType;
      sourceName = p.source.name;
    }

    let g = groups.get(key);
    if (!g) {
      g = { key, title, connectorType, sourceName, sourceDeleted, products: [], sortKey };
      groups.set(key, g);
    }
    g.products.push(p);
  }

  // Sort: normal sources alphabetically by title; then multi/deleted/unassigned at the end
  return Array.from(groups.values()).sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.title.localeCompare(b.title);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Public component
// ───────────────────────────────────────────────────────────────────────────

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
  // Substring filter against name + description + source name. Match is
  // applied BEFORE grouping so a search that matches one source's products
  // collapses the other source's section entirely (clean visual feedback).
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

  const groups = useMemo(() => groupProducts(filtered), [filtered]);

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
    return <EmptyState onCreate={onCreate} isAdmin={isAdmin} />;
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
    <div className="space-y-10">
      {groups.map((group) => {
        const palette = paletteForSource(group.connectorType, group.sourceName, group.sourceDeleted);
        return (
          <section key={group.key}>
            <SectionHeader group={group} palette={palette} />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.products.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  selected={selectedId === p.id}
                  onSelect={() => onSelect(p.id)}
                  showCuratorSignals={showCuratorSignals}
                  palette={palette}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Section header — colored dot + title + count
// ───────────────────────────────────────────────────────────────────────────

function SectionHeader({ group, palette }: { group: ProductGroup; palette: SourcePalette }) {
  const count = group.products.length;
  return (
    <div className="flex items-baseline justify-between mb-4 pb-2.5 border-b border-line">
      <div className="flex items-center gap-3">
        <span className={cn('inline-block w-2.5 h-2.5 rounded-full', palette.dot)} aria-hidden />
        <h2 className="font-display text-[20px] text-ink tracking-[-0.01em]">
          {group.title}
        </h2>
        {group.connectorType && (
          <span className={cn('text-[10px] font-mono uppercase tracking-[0.12em]', palette.eyebrow)}>
            {group.connectorType}
          </span>
        )}
      </div>
      <span className="text-[11.5px] font-mono text-muted-2 tabular-nums">
        {count} {count === 1 ? 'product' : 'products'}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// One card — colored left edge + clean body
// ───────────────────────────────────────────────────────────────────────────

function ProductCard({
  product, selected, onSelect, showCuratorSignals, palette,
}: {
  product: ProductCardData;
  selected: boolean;
  onSelect: () => void;
  showCuratorSignals?: boolean;
  palette: SourcePalette;
}) {
  const refreshed = product.last_refreshed_at
    ? formatRelative(product.last_refreshed_at)
    : 'Not refreshed yet';

  // Status pill: only render for off-normal states. "approved" and
  // "success" are the steady state — no pill needed. "draft", "error",
  // "pending" deserve attention.
  const showStatus = showCuratorSignals
    && product.status
    && !['approved', 'success'].includes(product.status);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative text-left bg-raised border rounded-lg overflow-hidden',
        'transition-all duration-150',
        'hover:shadow-md hover:-translate-y-0.5',
        selected
          ? 'border-ocean ring-2 ring-ocean/20'
          : 'border-line hover:border-ocean/40',
      )}
    >
      {/* Colored left edge — the source's accent. 3px wide, full-height,
          subtle but consistent. Strongest signal of "which source does
          this product come from?" without any text. */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-1', palette.edge)} aria-hidden />

      <div className="pl-5 pr-5 py-5">
        {/* Status pill — top-right, curator-only, off-normal-only.
            Pure cosmetic when steady-state. */}
        {showStatus && (
          <div className="absolute top-3 right-3">
            <StatusPill status={product.status} />
          </div>
        )}

        {/* Title. Display serif, slightly larger than v1 for visual weight. */}
        <h3 className={cn(
          'font-display text-[19px] tracking-[-0.01em] leading-tight mb-1.5 transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          {product.name}
        </h3>

        {/* Description — line-clamped to 2 lines so cards align to a grid. */}
        {product.description ? (
          <p className="text-[13px] text-ink-2 leading-relaxed line-clamp-2 mb-4 min-h-[2.5em]">
            {product.description}
          </p>
        ) : (
          <p className="text-[13px] text-muted italic mb-4 min-h-[2.5em]">
            No description yet.
          </p>
        )}

        {/* Footer stats — small mono, scannable. Refreshed time on the
            right anchors the "is this current?" question. */}
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-2 tabular-nums pt-3 border-t border-line">
          <span className={cn('font-medium', product.kpi_count > 0 && palette.eyebrow)}>
            {product.kpi_count} {product.kpi_count === 1 ? 'metric' : 'metrics'}
          </span>
          <span className="text-muted-2/40">·</span>
          <span>
            {product.table_count} {product.table_count === 1 ? 'table' : 'tables'}
          </span>
          <span className="ml-auto">{refreshed}</span>
        </div>
      </div>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Status pill (curator-only)
// ───────────────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const colour = status === 'draft'   ? 'bg-warn-soft text-warn border-warn/30'
              : status === 'error'    ? 'bg-err-soft text-err border-err/30'
              : status === 'pending'  ? 'bg-amber-50 text-amber-700 border-amber-200'
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

'use client';

/**
 * <CatalogSplitView> — the two-column /catalog layout.
 *
 * Per-source bands stacked vertically. Each band is a rounded card with
 * a colored top accent (palette.edge) + tinted header bar. Inside:
 *
 *   ┌─ Source name  · EXACTONLINE   1 analytic · 5 reference · • 2h ago ─┐
 *   │  ANALYTICS — WHAT YOU CAN ANALYSE   REFERENCE DATA — WHAT YOU CAN ANALYSE IT BY  │
 *   │  ┌─────────────┐                  ┌──────────┐ ┌──────────┐ ┌────────┐  │
 *   │  │ Sales       │                  │ Customer │ │ Item     │ │ Date   │  │
 *   │  │  [stats]    │                  └──────────┘ └──────────┘ └────────┘  │
 *   │  └─────────────┘                  ┌──────────┐ ┌──────────┐             │
 *   │                                    │ Journal │ │ ...      │             │
 *   │                                    └──────────┘ └──────────┘             │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * The band collapses to just the header on chevron click.
 *
 * Search filters BOTH columns simultaneously. An empty source band
 * (after filtering) collapses cleanly so the user isn't staring at
 * empty rows.
 */

import { useMemo, useState } from 'react';
import { Plus, ChevronUp, Database, Tag, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRelativeShort } from '@/lib/dates';
import { paletteForSource, type SourcePalette } from './sourcePalette';
import { iconForAnalytics, iconForReference } from './entityIcons';
import AnalyticsCard, { type AnalyticsCardData } from './AnalyticsCard';
import ReferenceCard, { type ReferenceCardData } from './ReferenceCard';

export interface SourceBlockData {
  connectionId: number | null;
  name: string;
  connectorType: string | null;
  sourceDeleted: boolean;
  analytics: AnalyticsCardData[];
  reference: ReferenceCardData[];
}

interface Props {
  sources: SourceBlockData[];
  search: string;
  /** 'grid' = rich cards (default); 'list' = compact rows (dScribe-style). */
  layout?: 'grid' | 'list';
  selectedAnalyticsId: number | null;
  selectedReferenceTableId: number | null;
  onSelectAnalytics: (productId: number) => void;
  onSelectReference: (tableId: number) => void;
  onCreate?: () => void;
  isAdmin?: boolean;
  loading?: boolean;
  showCuratorSignals?: boolean;
}

function matchSearch(needle: string, hay: string | null | undefined): boolean {
  if (!needle) return true;
  if (!hay) return false;
  return hay.toLowerCase().includes(needle.toLowerCase());
}

/** Latest refresh timestamp across all entities in a source block. */
function latestRefresh(block: SourceBlockData): string | null {
  let latest: string | null = null;
  const consider = (ts: string | null) => {
    if (!ts) return;
    if (!latest || ts > latest) latest = ts;
  };
  block.analytics.forEach((a) => consider(a.lastRefreshedAt));
  block.reference.forEach((r) => consider(r.lastRefreshedAt));
  return latest;
}

export default function CatalogSplitView({
  sources, search, layout = 'grid', selectedAnalyticsId, selectedReferenceTableId,
  onSelectAnalytics, onSelectReference, onCreate, isAdmin, loading,
  showCuratorSignals,
}: Props) {
  // Apply search to both columns. A source band with nothing in either
  // column after filtering is hidden entirely — keeps the screen clean.
  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return sources;
    return sources
      .map((s) => ({
        ...s,
        analytics: s.analytics.filter(
          (a) => matchSearch(q, a.name) || matchSearch(q, a.description),
        ),
        reference: s.reference.filter(
          (r) => matchSearch(q, r.name) || matchSearch(q, r.description),
        ),
      }))
      .filter((s) => s.analytics.length > 0 || s.reference.length > 0);
  }, [sources, search]);

  if (loading) {
    return (
      <div className="space-y-6">
        {[0, 1].map((i) => (
          <div key={i} className="border border-line rounded-2xl overflow-hidden bg-raised">
            <div className="h-12 bg-softer/60 border-b border-line" />
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 p-6">
              <div className="h-40 bg-softer/40 rounded-lg animate-pulse" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="h-28 bg-softer/40 rounded-md animate-pulse" />
                <div className="h-28 bg-softer/40 rounded-md animate-pulse" />
                <div className="h-28 bg-softer/40 rounded-md animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="border border-line rounded-2xl p-12 text-center bg-raised">
        <p className="text-[14px] text-muted">
          {search.trim()
            ? `No products or reference entities match "${search}".`
            : 'No data products yet.'}
        </p>
        {!search.trim() && isAdmin && onCreate && (
          <button
            onClick={onCreate}
            className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-ocean hover:underline"
          >
            <Plus className="w-3.5 h-3.5" /> Design your first product
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {filtered.map((s) => {
        const palette = paletteForSource(s.connectorType, s.name, s.sourceDeleted);
        return (
          <SourceBand
            key={`${s.connectionId ?? 'x'}-${s.name}`}
            block={s}
            palette={palette}
            layout={layout}
            selectedAnalyticsId={selectedAnalyticsId}
            selectedReferenceTableId={selectedReferenceTableId}
            onSelectAnalytics={onSelectAnalytics}
            onSelectReference={onSelectReference}
            showCuratorSignals={showCuratorSignals}
            isAdmin={isAdmin}
            onCreate={onCreate}
          />
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// One source band: header + two columns. Collapsible.
// ───────────────────────────────────────────────────────────────────────────

function SourceBand({
  block, palette, layout = 'grid',
  selectedAnalyticsId, selectedReferenceTableId,
  onSelectAnalytics, onSelectReference,
  showCuratorSignals, isAdmin, onCreate,
}: {
  block: SourceBlockData;
  palette: SourcePalette;
  layout?: 'grid' | 'list';
  selectedAnalyticsId: number | null;
  selectedReferenceTableId: number | null;
  onSelectAnalytics: (id: number) => void;
  onSelectReference: (id: number) => void;
  showCuratorSignals?: boolean;
  isAdmin?: boolean;
  onCreate?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const refreshedAt = latestRefresh(block);
  const refreshedLabel = refreshedAt ? formatRelativeShort(refreshedAt) : null;

  return (
    <section
      className={cn(
        'border border-line rounded-2xl overflow-hidden bg-raised',
        // Subtle colored top edge — wraps over the header. ~3px tall, palette-tinted.
        'shadow-sm',
      )}
    >
      {/* Colored top accent strip. */}
      <div className={cn('h-1', palette.edge)} aria-hidden />

      {/* Header — clickable to collapse/expand. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className={cn(
          'w-full px-6 py-4 flex items-center gap-3 text-left transition-colors',
          // Calm white header — colour identity comes from the top accent strip
          // + the dot, not a heavy tinted fill.
          'bg-raised hover:bg-softer/40',
        )}
        aria-expanded={!collapsed}
      >
        <span className={cn(
          'flex items-center justify-center w-9 h-9 rounded-xl shrink-0 border',
          palette.tintStrong, palette.ring, palette.eyebrow,
        )} aria-hidden>
          <Database className="w-[18px] h-[18px]" strokeWidth={1.75} />
        </span>
        <h2 className="font-display text-[22px] tracking-[-0.01em] text-ink">
          {block.name}
        </h2>
        {block.connectorType && !block.sourceDeleted && (
          <span className={cn(
            'text-[10px] uppercase font-mono tracking-[0.14em] px-2 py-0.5 rounded border',
            palette.eyebrow,
            'border-current/30 bg-raised/60',
          )}>
            {block.connectorType}
          </span>
        )}
        {block.sourceDeleted && (
          <span className="text-[10px] uppercase font-mono tracking-[0.1em] text-muted-2">
            source deleted
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-[12px] font-mono text-muted-2 tabular-nums">
          <span className={cn(palette.eyebrow, 'font-medium')}>
            {block.analytics.length} {block.analytics.length === 1 ? 'analytic' : 'analytics'}
          </span>
          <span className="text-muted-2/40">·</span>
          <span>{block.reference.length} reference</span>
          {refreshedLabel && (
            <>
              <span className="text-muted-2/40">·</span>
              <span className="inline-flex items-center gap-1.5">
                <span className={cn('w-1.5 h-1.5 rounded-full', palette.dot)} aria-hidden />
                {refreshedLabel}
              </span>
            </>
          )}
          <ChevronUp
            className={cn(
              'w-4 h-4 text-muted-2 transition-transform duration-200 ml-1',
              collapsed && 'rotate-180',
            )}
            strokeWidth={2}
          />
        </span>
      </button>

      {!collapsed && layout === 'list' && (
        <div className="px-4 py-3 space-y-1">
          {block.analytics.length === 0 && block.reference.length === 0 ? (
            <p className="text-[12px] text-muted italic px-2 py-2">Nothing here yet.</p>
          ) : (
            <>
              {block.analytics.map((a) => (
                <EntityRow
                  key={`a-${a.productId}`}
                  kind="analytic"
                  name={a.name}
                  description={a.description}
                  meta={`${a.metricCount} ${a.metricCount === 1 ? 'metric' : 'metrics'}`}
                  palette={palette}
                  selected={selectedAnalyticsId === a.productId}
                  onSelect={() => onSelectAnalytics(a.productId)}
                />
              ))}
              {block.reference.map((r) => (
                <EntityRow
                  key={`r-${r.tableId}`}
                  kind="reference"
                  name={r.name}
                  description={r.description}
                  meta={r.rowCount != null ? `${formatCount(r.rowCount)} records` : null}
                  palette={palette}
                  selected={selectedReferenceTableId === r.tableId}
                  onSelect={() => onSelectReference(r.tableId)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {!collapsed && layout !== 'list' && (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 p-6">
          {/* Left: Analytics */}
          <div>
            <ColumnHeader
              icon={Database}
              palette={palette}
              title="Analytics"
              subtitle="What you can analyse"
            />
            {block.analytics.length === 0 ? (
              <EmptyAnalytics
                isAdmin={isAdmin}
                onCreate={onCreate}
                connectionName={block.name}
              />
            ) : (
              <div className="space-y-3">
                {block.analytics.map((a) => (
                  <AnalyticsCard
                    key={a.productId}
                    data={a}
                    selected={selectedAnalyticsId === a.productId}
                    onSelect={() => onSelectAnalytics(a.productId)}
                    palette={palette}
                    showCuratorSignals={showCuratorSignals}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Right: Reference data — 3 columns on wide screens. */}
          <div>
            <ColumnHeader
              icon={Tag}
              palette={palette}
              title="Reference data"
              subtitle="What you can analyse it by"
            />
            {block.reference.length === 0 ? (
              <p className="text-[12px] text-muted italic px-1">
                No reference entities for this source yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {block.reference.map((r) => (
                  <ReferenceCard
                    key={r.tableId}
                    data={r}
                    selected={selectedReferenceTableId === r.tableId}
                    onSelect={() => onSelectReference(r.tableId)}
                    palette={palette}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Compact list row (list layout). One line per dataset: type icon + name +
 * truncated meaning + a quiet meta on the right. The calm, scannable
 * dScribe-style alternative to the rich card grid.
 */
function EntityRow({
  kind, name, description, meta, palette, selected, onSelect,
}: {
  kind: 'analytic' | 'reference';
  name: string;
  description: string | null;
  meta: string | null;
  palette: SourcePalette;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = kind === 'analytic' ? iconForAnalytics(name) : iconForReference(name);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors',
        selected ? 'border-ocean bg-ocean/5' : 'border-transparent hover:bg-softer',
      )}
    >
      <Icon className={cn('w-3.5 h-3.5 shrink-0', palette.eyebrow)} strokeWidth={2} />
      <span className={cn(
        'text-[13.5px] font-medium shrink-0 max-w-[40%] truncate',
        selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
      )}>
        {name}
      </span>
      <span className="text-[12.5px] text-muted truncate flex-1 min-w-0">
        {description || 'No description yet.'}
      </span>
      {meta && (
        <span className="text-[11px] font-mono text-muted-2 tabular-nums shrink-0">{meta}</span>
      )}
    </button>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toLocaleString('en-GB');
}

/**
 * Section header — tinted glyph + `LABEL — SUBTITLE`. The little coloured
 * icon gives each column a tiny anchor so the Analytics/Reference split reads
 * at a glance, while staying in the Observatory mono-eyebrow register.
 */
function ColumnHeader({
  icon: Icon, palette, title, subtitle,
}: { icon: LucideIcon; palette: SourcePalette; title: string; subtitle: string }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <span className={cn(
        'flex items-center justify-center w-5 h-5 rounded-md shrink-0',
        palette.tintBg, palette.eyebrow,
      )}>
        <Icon className="w-3 h-3" strokeWidth={2} />
      </span>
      <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
        {title}
      </span>
      <span className="text-muted-2/50 text-[10.5px]">—</span>
      <span className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-muted-2">
        {subtitle}
      </span>
    </div>
  );
}

function EmptyAnalytics({
  isAdmin, onCreate, connectionName,
}: { isAdmin?: boolean; onCreate?: () => void; connectionName: string }) {
  if (!isAdmin || !onCreate) {
    return (
      <p className="text-[12px] text-muted italic px-1">
        No analytics products from {connectionName} yet.
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onCreate}
      className={cn(
        'w-full border border-dashed border-line rounded-lg px-4 py-6 text-center',
        'text-[13px] text-muted hover:text-ocean hover:border-ocean/50 transition-colors',
      )}
    >
      <Plus className="w-4 h-4 mx-auto mb-1.5" strokeWidth={2} />
      Design an analytics product from {connectionName}
    </button>
  );
}

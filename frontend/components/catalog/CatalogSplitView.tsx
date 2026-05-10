'use client';

/**
 * <CatalogSplitView> — the new two-column /catalog layout.
 *
 * Per-source bands stacked vertically. Each band has a colored header
 * (palette tied to the source's connector type) and two columns:
 *
 *   ┌─ Source name ─────────────────────────────────────────┐
 *   │  Analytics              │  Reference data             │
 *   │  ┌─────────────┐        │  ┌──────────┐ ┌──────────┐  │
 *   │  │ Sales       │        │  │ Customer │ │ Item     │  │
 *   │  └─────────────┘        │  └──────────┘ └──────────┘  │
 *   └────────────────────────────────────────────────────────┘
 *
 * Why this layout (not a global Analytics/Reference tab toggle):
 *   - User explicitly wants source-isolated mental model — no cross-
 *     source dim conformance today.
 *   - Two columns let users see "what to analyse" and "what to slice
 *     by" within the same source at a glance.
 *   - Asymmetric column widths (40 / 60) reflect typical density —
 *     2-3 analytics products vs 5-10 dimensions per source.
 *
 * Search filters BOTH columns simultaneously. An empty source band
 * (after filtering) collapses cleanly so the user isn't staring at
 * empty rows. A source with zero analytics still renders the analytics
 * column header with an empty-state nudge so the asymmetry stays
 * visible.
 *
 * On <1100px wide the columns stack — analytics on top.
 */

import { useMemo } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { paletteForSource, type SourcePalette } from './sourcePalette';
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

export default function CatalogSplitView({
  sources, search, selectedAnalyticsId, selectedReferenceTableId,
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
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="border border-line rounded-lg overflow-hidden bg-raised">
            <div className="h-10 bg-softer/60 border-b border-line" />
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 p-5">
              <div className="space-y-3">
                <div className="h-32 bg-softer/40 rounded animate-pulse" />
              </div>
              <div className="space-y-2">
                <div className="h-14 bg-softer/40 rounded animate-pulse" />
                <div className="h-14 bg-softer/40 rounded animate-pulse" />
                <div className="h-14 bg-softer/40 rounded animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="border border-line rounded-lg p-12 text-center bg-raised">
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
    <div className="space-y-5">
      {filtered.map((s) => {
        const palette = paletteForSource(s.connectorType, s.name, s.sourceDeleted);
        return (
          <SourceBand
            key={`${s.connectionId ?? 'x'}-${s.name}`}
            block={s}
            palette={palette}
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
// One source band: header + two columns
// ───────────────────────────────────────────────────────────────────────────

function SourceBand({
  block, palette,
  selectedAnalyticsId, selectedReferenceTableId,
  onSelectAnalytics, onSelectReference,
  showCuratorSignals, isAdmin, onCreate,
}: {
  block: SourceBlockData;
  palette: SourcePalette;
  selectedAnalyticsId: number | null;
  selectedReferenceTableId: number | null;
  onSelectAnalytics: (id: number) => void;
  onSelectReference: (id: number) => void;
  showCuratorSignals?: boolean;
  isAdmin?: boolean;
  onCreate?: () => void;
}) {
  return (
    <section className="border border-line rounded-lg overflow-hidden bg-raised">
      {/* Source header — palette dot + connector type eyebrow + counts. */}
      <header className={cn('px-5 py-3 border-b border-line flex items-center gap-3', palette.tintBg)}>
        <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', palette.dot)} aria-hidden />
        <h2 className="font-display text-[18px] tracking-[-0.01em] text-ink">
          {block.name}
        </h2>
        {block.connectorType && !block.sourceDeleted && (
          <span className={cn('text-[10px] uppercase font-mono tracking-[0.1em]', palette.eyebrow)}>
            {block.connectorType}
          </span>
        )}
        {block.sourceDeleted && (
          <span className="text-[10px] uppercase font-mono tracking-[0.1em] text-muted-2">
            source deleted
          </span>
        )}
        <span className="ml-auto text-[11px] font-mono text-muted-2 tabular-nums">
          {block.analytics.length} {block.analytics.length === 1 ? 'analytic' : 'analytics'}
          <span className="text-muted-2/40 mx-1.5">·</span>
          {block.reference.length} reference
        </span>
      </header>

      {/* Two columns. 40 / 60 split — reference data tends to be denser. */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 p-5">
        {/* Left: Analytics */}
        <div>
          <ColumnHeader title="Analytics" subtitle="What you can analyse" />
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

        {/* Right: Reference data */}
        <div>
          <ColumnHeader title="Reference data" subtitle="What you can analyse it by" />
          {block.reference.length === 0 ? (
            <p className="text-[12px] text-muted italic px-1">
              No reference entities for this source yet.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
    </section>
  );
}

function ColumnHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <p className="text-[10px] font-mono tracking-[0.16em] uppercase text-muted">
        {title}
      </p>
      {subtitle && (
        <p className="text-[11px] text-muted-2 mt-0.5">{subtitle}</p>
      )}
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

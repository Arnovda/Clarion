'use client';

/**
 * The freshness detail slide-over — the "Details" door on Home's operational
 * line. Extracted unchanged from the old /home page when that page was
 * rebuilt as the standing brief; it is still the right surface for "show me
 * every source and subject with its timestamp before I decide what to
 * refresh", it just no longer hangs off a sub-score tile.
 */

import { useEffect } from 'react';
import { Clock, Database, Boxes, RefreshCw, X } from 'lucide-react';
import { OBSERVATORY } from '@/lib/observatory';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { HomeSummary } from './types';

export function FreshnessDetail({
  sources, products, onClose, onJumpToPipelines,
}: {
  sources: HomeSummary['freshness']['allSources'];
  products: HomeSummary['freshness']['allProducts'];
  onClose: () => void;
  onJumpToPipelines: () => void;
}) {
  // Stale first within each kind, then by oldest refresh
  const orderRows = <T extends { isStale: boolean; lastSyncedAt?: string | null; lastRefreshedAt?: string | null }>(rows: T[]): T[] => {
    return [...rows].sort((a, b) => {
      if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
      const aAt = (a.lastSyncedAt ?? a.lastRefreshedAt) ?? '';
      const bAt = (b.lastSyncedAt ?? b.lastRefreshedAt) ?? '';
      return aAt.localeCompare(bAt);
    });
  };
  const orderedSources = orderRows(sources);
  const orderedProducts = orderRows(products);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sourceCount = sources.length;
  const productCount = products.length;
  const staleSourceCount = sources.filter((s) => s.isStale).length;
  const staleProductCount = products.filter((p) => p.isStale).length;

  return (
    <div className="fixed inset-0 z-40 bg-ink/40 flex items-stretch justify-end" onClick={onClose}>
      <div
        className="bg-raised w-full max-w-[560px] h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-raised border-b border-line px-5 py-3 flex items-start gap-2">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" style={{ color: OBSERVATORY.ocean }} strokeWidth={1.75} />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Freshness</p>
            <h2 className="font-display text-[18px] tracking-[-0.01em] text-ink">
              When was each thing last refreshed?
            </h2>
            <p className="text-[11.5px] text-muted-2 mt-0.5">
              {staleSourceCount + staleProductCount > 0
                ? `${staleSourceCount + staleProductCount} item${staleSourceCount + staleProductCount === 1 ? '' : 's'} not refreshed in the last 24 hours.`
                : 'Everything has been refreshed in the last 24 hours.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-soft text-muted-2 hover:text-ink-2"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-6">
          {/* Sources */}
          <section>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">
              Sources <span className="text-muted-2 normal-case ml-1">{sourceCount} total · {staleSourceCount} stale</span>
            </p>
            {sourceCount === 0 ? (
              <p className="text-[12px] text-muted italic">No sources connected yet.</p>
            ) : (
              <ul className="divide-y divide-line border border-line rounded-md overflow-hidden">
                {orderedSources.map((s) => (
                  <FreshnessRow
                    key={`s-${s.id}`}
                    name={s.name}
                    kind="source"
                    sub={s.connectorType ?? 'source'}
                    lastAt={s.lastSyncedAt}
                    isStale={s.isStale}
                    extra={s.lastSyncStatus}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Products */}
          <section>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">
              Datasets <span className="text-muted-2 normal-case ml-1">{productCount} total · {staleProductCount} stale</span>
            </p>
            {productCount === 0 ? (
              <p className="text-[12px] text-muted italic">No datasets yet.</p>
            ) : (
              <ul className="divide-y divide-line border border-line rounded-md overflow-hidden">
                {orderedProducts.map((p) => (
                  <FreshnessRow
                    key={`p-${p.id}`}
                    name={p.name}
                    kind="product"
                    sub={p.status}
                    lastAt={p.lastRefreshedAt}
                    isStale={p.isStale}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Action */}
          <button
            onClick={onJumpToPipelines}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
            Open Refresh
          </button>
          <p className="text-[10.5px] text-muted-2 text-center -mt-2">
            Pick the scope (everything / one source / one dataset) and click <span className="font-medium">Run now</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

function FreshnessRow({
  name, kind, sub, lastAt, isStale, extra,
}: {
  name: string;
  kind: 'source' | 'product';
  sub: string;
  lastAt: string | null;
  isStale: boolean;
  extra?: string | null;
}) {
  const Icon = kind === 'source' ? Database : Boxes;
  const accent = kind === 'source' ? OBSERVATORY.ocean : OBSERVATORY.ai;
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2 mb-0.5">
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} strokeWidth={1.75} />
        <span className="text-[12.5px] font-medium text-ink truncate">{name}</span>
        <span className={cn(
          'text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-line',
          kind === 'source' ? 'text-ocean bg-ocean-softer' : 'text-ai bg-ai-soft',
        )}>
          {sub}
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-mono shrink-0"
          style={{ color: isStale ? OBSERVATORY.warn : OBSERVATORY.muted2 }}
        >
          <Clock className="w-3 h-3" strokeWidth={1.5} />
          {lastAt ? formatRelative(lastAt) : 'never refreshed'}
          {isStale && lastAt && <span className="font-medium">· stale</span>}
        </span>
      </div>
      {extra && (
        <p className="text-[11px] text-muted-2 ml-6">{extra}</p>
      )}
    </li>
  );
}

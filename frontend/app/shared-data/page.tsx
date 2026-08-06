'use client';

/**
 * /shared-data — the conformed lookups, in one place.
 *
 * These used to be modelled as a "Core dimensions" data product, which put
 * them in the same list as Finance and Sales and invited the question "what
 * do I ask Core dimensions?" — nothing. They are not a subject area; they
 * are the lenses every subject area is sliced by. Accounts, Date, GL
 * accounts, Items, Journals and Payment conditions live HERE and nowhere
 * else, which is what makes a topic's "Shared lookups" pills read-only.
 *
 * Analyst+ (Studio). Reads the existing catalog-by-source endpoint, which
 * already unfolds reference-kind products into one card per lookup table
 * with its reverse-lineage ("used in").
 */

import { useEffect, useState } from 'react';
import { Library, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import RequireRole from '@/components/RequireRole';
import { formatRelativeLong } from '@/lib/dates';
import { iconForReference } from '@/components/catalog/entityIcons';

interface ReferenceCard {
  productId: number;
  tableId: number;
  name: string;
  description: string | null;
  rowCount: number | null;
  lastRefreshedAt: string | null;
  usedIn: Array<{ productId: number; name: string }>;
}

interface SourceBlock {
  connectionId: number | null;
  name: string;
  sourceDeleted: boolean;
  reference: ReferenceCard[];
}

export default function SharedDataPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <SharedData />
    </RequireRole>
  );
}

function SharedData() {
  const [blocks, setBlocks] = useState<SourceBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/products/catalog/by-source')
      .then((res) => {
        if (cancelled) return;
        const sources = (res.data?.data?.sources ?? []) as SourceBlock[];
        setBlocks(sources.filter((s) => s.reference.length > 0));
      })
      .catch(() => { if (!cancelled) setError('Could not load shared data.'); });
    return () => { cancelled = true; };
  }, []);

  const total = blocks?.reduce((n, b) => n + b.reference.length, 0) ?? 0;

  return (
    <div className="flex-1 overflow-y-auto px-10 pb-10 pt-10">
      <div className="mx-auto max-w-[880px]">
        <header className="mb-8 flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-ocean-softer text-ocean">
            <Library className="h-[22px] w-[22px]" strokeWidth={1.6} aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-ink">Shared data</h1>
            <p className="mt-1 max-w-[560px] text-[14.5px] leading-[1.6] text-ink-3 [text-wrap:pretty]">
              The lookups every topic is sliced by. Edit one here and every topic that
              uses it follows — which is why a topic can only read them.
            </p>
          </div>
        </header>

        {error && <p className="text-[13px] text-err">{error}</p>}

        {!blocks && !error && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
            Loading…
          </div>
        )}

        {blocks && total === 0 && (
          <p className="text-[13.5px] text-muted">
            No shared lookups yet. They appear here once a topic is designed with
            conformed dimensions.
          </p>
        )}

        {blocks?.map((block) => (
          <section key={block.connectionId ?? block.name} className="mb-10">
            {blocks.length > 1 && (
              <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
                {block.name}
              </h2>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {block.reference.map((card) => {
                const Glyph = iconForReference(card.name);
                return (
                  <a
                    key={card.tableId}
                    href={`/products/${card.productId}?table=${encodeURIComponent(card.name)}`}
                    className="group flex flex-col gap-2 rounded-[10px] border border-line bg-raised px-5 py-4 transition-colors duration-1 ease-observatory hover:border-ocean"
                  >
                    <div className="flex items-center gap-2.5">
                      <Glyph className="h-4 w-4 shrink-0 text-ocean" strokeWidth={1.6} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink group-hover:text-ocean">
                        {card.name}
                      </span>
                      {card.rowCount != null && (
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-2">
                          {card.rowCount.toLocaleString('en-GB')}
                        </span>
                      )}
                    </div>
                    {card.description && (
                      <p className="line-clamp-2 text-[12.5px] leading-[1.5] text-muted">{card.description}</p>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[11.5px] text-muted-2">
                      {card.usedIn.length > 0 ? (
                        <span>Used by {card.usedIn.map((u) => u.name).join(', ')}</span>
                      ) : (
                        <span>Not used by any topic yet</span>
                      )}
                      {card.lastRefreshedAt && <span>· refreshed {formatRelativeLong(card.lastRefreshedAt)}</span>}
                    </div>
                  </a>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

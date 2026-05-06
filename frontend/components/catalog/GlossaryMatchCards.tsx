'use client';

/**
 * <GlossaryMatchCards> — glossary term matches that surface ABOVE the
 * product grid when the user searches.
 *
 * Atlan / Hex / Lightdash all do this: typing "revenue" returns the
 * glossary TERM first (the canonical business definition), then the
 * matching products / tables. The term card teaches the user what the
 * org means by "revenue" before they pick which product to query.
 *
 * Hidden when search is empty — the section only matters during active
 * search. Each term card shows: name, plain-English meaning (truncated),
 * tag chips. Click opens /glossary with the term highlighted.
 */

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface GlossaryEntry {
  id: number;
  term: string;
  meaning: string;
  examples?: string | null;
  tags?: string[] | null;
}

interface Props {
  entries: GlossaryEntry[];
  search: string;
  onTermClick?: (term: GlossaryEntry) => void;
}

export default function GlossaryMatchCards({ entries, search, onTermClick }: Props) {
  const router = useRouter();
  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return entries.filter((e) => {
      const haystack = [
        e.term,
        e.meaning,
        e.examples ?? '',
        ...(e.tags ?? []),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    }).slice(0, 6); // cap to keep the section quiet — full list is at /glossary
  }, [entries, search]);

  if (matched.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2.5 mb-3">
        <BookOpen className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium">
          Glossary
        </h2>
        <span className="text-[10.5px] font-mono text-muted-2 tabular-nums">
          ({matched.length} {matched.length === 1 ? 'match' : 'matches'})
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {matched.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onTermClick?.(e) ?? router.push(`/glossary?term=${encodeURIComponent(e.term)}`)}
            className={cn(
              'group/term text-left bg-raised border border-line rounded-md px-4 py-3',
              'hover:border-ocean/40 hover:shadow-sm transition-all',
            )}
          >
            <div className="flex items-start gap-2 mb-1">
              <span className="text-[13.5px] font-medium text-ink group-hover/term:text-ocean transition-colors">
                {e.term}
              </span>
              <ArrowRight className="w-3 h-3 text-muted-2 group-hover/term:text-ocean group-hover/term:translate-x-0.5 transition-all flex-shrink-0 mt-1" strokeWidth={2} />
            </div>
            <p className="text-[12px] text-muted leading-snug line-clamp-2">
              {e.meaning}
            </p>
            {e.tags && e.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 mt-2">
                {e.tags.slice(0, 4).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 bg-soft border border-line px-1.5 py-0.5 rounded"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

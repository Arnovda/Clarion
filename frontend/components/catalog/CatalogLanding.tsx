'use client';

/**
 * <CatalogLanding> — the catalog with nothing selected: what needs you.
 *
 * Three sentences with a door each (suggestions waiting, sources not yet
 * analysed, tables below the quality bar), then the health overview that
 * used to be the Trust tab. Deliberately not a dashboard: a person lands
 * here to pick something on the left, and the counts are there so they know
 * whether anything is waiting before they do.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox, Plug, ShieldCheck } from 'lucide-react';
import api from '@/lib/api';
import QualityOverview from '@/components/quality/QualityOverview';

interface Counts {
  suggestions: number | null;
  unanalysed: number | null;
  belowBar: number | null;
}

export default function CatalogLanding({ curator }: { curator: boolean }) {
  const [counts, setCounts] = useState<Counts>({ suggestions: null, unanalysed: null, belowBar: null });

  useEffect(() => {
    if (!curator) return;
    let cancelled = false;
    (async () => {
      const next: Counts = { suggestions: null, unanalysed: null, belowBar: null };
      try {
        const r = await api.get('/semantic/pending-approvals');
        next.suggestions = (r.data?.data ?? []).length;
      } catch { /* the line simply does not render */ }
      try {
        const r = await api.get('/connections');
        const conns = (r.data?.data ?? []) as Array<{ profiling_status?: string | null }>;
        next.unanalysed = conns.filter((c) => !c.profiling_status || c.profiling_status === 'pending' || c.profiling_status === 'structural' || c.profiling_status === 'failed').length;
      } catch { /* ignore */ }
      try {
        const r = await api.get('/quality/tables');
        const tables = (r.data?.data ?? []) as Array<{ overall_score: number | null }>;
        next.belowBar = tables.filter((t) => t.overall_score != null && t.overall_score < 0.7).length;
      } catch { /* ignore */ }
      if (!cancelled) setCounts(next);
    })();
    return () => { cancelled = true; };
  }, [curator]);

  const lines: Array<{ key: string; icon: React.ReactNode; text: React.ReactNode; href: string; cta: string }> = [];
  if (counts.suggestions != null && counts.suggestions > 0) {
    lines.push({
      key: 'suggestions',
      icon: <Inbox className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />,
      text: <>{counts.suggestions} {counts.suggestions === 1 ? 'suggestion is' : 'suggestions are'} waiting for a yes or no.</>,
      href: '/review',
      cta: 'Review them',
    });
  }
  if (counts.unanalysed != null && counts.unanalysed > 0) {
    lines.push({
      key: 'unanalysed',
      icon: <Plug className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />,
      text: <>{counts.unanalysed} {counts.unanalysed === 1 ? 'source has' : 'sources have'} not been analysed yet.</>,
      href: '/sources',
      cta: 'Open Sources',
    });
  }
  if (counts.belowBar != null && counts.belowBar > 0) {
    lines.push({
      key: 'quality',
      icon: <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />,
      text: <>{counts.belowBar} {counts.belowBar === 1 ? 'table scores' : 'tables score'} below 70% on quality.</>,
      href: '#health',
      cta: 'See which',
    });
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <header>
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-1">Catalog</p>
          <h1 className="font-display text-[26px] text-ink leading-tight tracking-[-0.02em]">
            {curator ? 'Review, check the health, adapt.' : 'Find and understand your data.'}
          </h1>
          <p className="text-[13px] text-muted mt-1.5 leading-relaxed max-w-xl">
            Pick a subject, a table or a source on the left.
            {curator ? ' Every table shows what one row is, where it comes from and the SQL that builds it — edit it here, or ask the assistant to.' : ' Every table shows what it holds and what its fields mean.'}
          </p>
        </header>

        {curator && lines.length > 0 && (
          <section className="bg-raised border border-line rounded-lg divide-y divide-line">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-ink-2">
                <span className="text-muted-2">{l.icon}</span>
                <span className="flex-1 min-w-0">{l.text}</span>
                <Link href={l.href} className="shrink-0 text-[12px] font-medium text-ocean hover:text-ocean-hover transition-colors">
                  {l.cta} →
                </Link>
              </div>
            ))}
          </section>
        )}

        {curator && counts.suggestions === 0 && counts.unanalysed === 0 && (counts.belowBar ?? 0) === 0 && (
          <p className="text-[13px] text-muted">Nothing is waiting on you.</p>
        )}

        <section id="health">
          <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-3">Health</p>
          <QualityOverview compact />
        </section>
      </div>
    </div>
  );
}

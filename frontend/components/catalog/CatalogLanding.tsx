'use client';

/**
 * <CatalogLanding> — the catalog with nothing selected: what needs you.
 *
 * Sentences with a door each (suggestions waiting, sources not yet analysed,
 * tables below the quality bar), then — since the Build page was folded in
 * on 2026-09-26 — the subject work that is workspace-wide rather than about
 * one thing on the left: a source with data but no subjects yet (its plan
 * and one button), keys that still need upgrading, and subjects hidden from
 * the Subjects page. Then the health overview that used to be the Trust tab.
 * Deliberately not a dashboard: a person lands here to pick something on the
 * left, and the lines are there so they know whether anything is waiting.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, EyeOff, Inbox, Plug, ShieldCheck, Sparkles } from 'lucide-react';
import api from '@/lib/api';
import QualityOverview from '@/components/quality/QualityOverview';
import { cleanTopicName } from '@/components/products/helpers';
import { KeysPanel, PlanPanel, useSubjectBuilds, type SourceOverview } from './subjectBuilds';

interface Counts {
  suggestions: number | null;
  unanalysed: number | null;
  belowBar: number | null;
}

export default function CatalogLanding({ curator }: { curator: boolean }) {
  const builds = useSubjectBuilds();
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

        {curator && <SubjectWork />}

        {curator && counts.suggestions === 0 && counts.unanalysed === 0 && (counts.belowBar ?? 0) === 0 && !subjectWorkWaiting(builds?.overview?.sources) && (
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

// ─── Subject work: what used to be the Build page ──────────────────────────

/** A source with data that has no subjects yet. */
function waitingForSubjects(src: SourceOverview): boolean {
  return src.products.length === 0 && src.tableCount > 0;
}

function keysNeedWork(src: SourceOverview): boolean {
  return src.products.length > 0 && !!src.keys && (src.keys.toUpgrade > 0 || src.keys.rebuildInstead > 0);
}

function subjectWorkWaiting(sources: SourceOverview[] | undefined): boolean {
  return (sources ?? []).some((s) => waitingForSubjects(s) || keysNeedWork(s) || s.products.some((p) => p.hidden));
}

function SubjectWork() {
  const b = useSubjectBuilds();
  const [openPlan, setOpenPlan] = useState<number | null>(null);
  if (!b?.overview) return null;
  const sources = b.overview.sources;
  const unbuilt = sources.filter(waitingForSubjects).filter((s) => !(b.run && b.run.connectionId === s.id && !b.run.done));
  const keyed = sources.filter(keysNeedWork);
  const hidden = [...sources.flatMap((s) => s.products), ...b.overview.unassignedProducts].filter((p) => p.hidden);
  if (unbuilt.length === 0 && keyed.length === 0 && hidden.length === 0) return null;

  return (
    <section className="space-y-3">
      <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">Subjects</p>

      {unbuilt.map((src) => (
        <div key={src.id} className="bg-raised border border-line rounded-lg">
          <button
            type="button"
            onClick={() => setOpenPlan((id) => (id === src.id ? null : src.id))}
            aria-expanded={openPlan === src.id}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-[13px] text-ink-2"
          >
            <Sparkles className="w-3.5 h-3.5 text-muted-2 shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="flex-1 min-w-0">
              {src.name} has data but no subjects yet
              {src.plan ? <> — {src.plan.topics.filter((t) => t.kind === 'analytics').length} ready to create.</> : '.'}
              {src.profilingStatus !== 'done' && <span className="text-muted"> Analyse it first for richer descriptions.</span>}
            </span>
            <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-medium text-ocean">
              {openPlan === src.id ? 'Hide the plan' : 'See the plan'}
              {openPlan === src.id
                ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
                : <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />}
            </span>
          </button>
          {openPlan === src.id && (
            <div className="border-t border-line p-3">
              <PlanPanel
                src={src}
                intent={b.intent[src.id] ?? ''}
                onIntent={(v) => b.setIntent(src.id, v)}
                onBuild={() => { setOpenPlan(null); void b.startBuild(src.id); }}
                disabled={b.building}
              />
            </div>
          )}
        </div>
      ))}

      {keyed.map((src) => (
        <KeysPanel
          key={src.id}
          sourceName={src.name}
          keys={src.keys!}
          disabled={b.building}
          onUpgrade={() => void b.startKeyUpgrade(src.id)}
        />
      ))}

      {hidden.length > 0 && (
        <div className="bg-raised border border-line rounded-lg px-4 py-2.5 text-[13px] text-ink-2">
          <div className="flex items-start gap-3">
            <EyeOff className="w-3.5 h-3.5 mt-[3px] text-muted-2 shrink-0" strokeWidth={1.75} aria-hidden />
            <div className="flex-1 min-w-0">
              <p>
                Hidden from the Subjects page — still built, still in this tree:
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {hidden.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 rounded border border-line bg-softer pl-2 pr-1 py-0.5 text-[12px]">
                    {cleanTopicName(p.name)}
                    <button
                      type="button"
                      onClick={() => void b.setHidden(p.id, false)}
                      className="rounded px-1.5 py-px text-[11.5px] font-medium text-ocean hover:bg-ocean-softer"
                    >
                      Show
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

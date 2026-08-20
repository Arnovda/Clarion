'use client';

/**
 * /subjects — the Subjects hub, Option A of the 2026-08-20 navigation
 * decision (owner picked it from three mocked directions).
 *
 * One "Subjects" entry under Uncover replaces the per-topic rail rows: the
 * rail was the right call at two or three template topics, but the AI
 * designer produces six-plus and a rail that grows with the model's output
 * always eventually scrolls. This page is where every subject lives —
 * with the descriptions and freshness a rail row could never carry.
 *
 * Viewer-readable on purpose: subjects are the viewer's entire world.
 * Vocabulary rule applies in full — business words only; the words
 * fact/dimension/star schema/data product must not appear on this screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Layers, Library, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import { formatRelativeLong } from '@/lib/dates';
import { iconForAnalytics } from '@/components/catalog/entityIcons';
import { cleanTopicName } from '@/app/products/helpers';

interface Subject {
  id: number;
  name: string;
  description: string | null;
  lastRefreshedAt: string | null;
  /** 0 = built but every table is empty ("waiting for data"); null = not built. */
  rowsTotal: number | null;
}

export default function SubjectsPage() {
  const router = useRouter();
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const role = getTokenPayload()?.role ?? 'viewer';

  useEffect(() => {
    let cancelled = false;
    api.get('/products')
      .then((res) => {
        if (cancelled) return;
        const rows = (res.data.data ?? []) as Array<{
          id: number; name: string; description: string | null;
          kind?: string; hidden?: boolean;
          last_refreshed_at?: string | null; rows_total?: string | number | null;
        }>;
        setSubjects(
          rows
            // Same filter the rail rows used: reference products are the
            // shared lookups (they get their own band below), and hidden is
            // the Build page's show/hide toggle doing its job.
            .filter((p) => (p.kind ?? 'analytics') === 'analytics' && p.hidden !== true)
            .map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              lastRefreshedAt: p.last_refreshed_at ?? null,
              rowsTotal: p.rows_total === null || p.rows_total === undefined ? null : Number(p.rows_total),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      })
      .catch(() => { if (!cancelled) setError('Could not load your subjects.'); });
    return () => { cancelled = true; };
  }, []);

  const ask = useCallback(() => {
    const q = question.trim();
    router.push(q ? `/query?q=${encodeURIComponent(q)}&autoSubmit=1` : '/query');
  }, [question, router]);

  return (
    <div className="flex-1 overflow-y-auto px-10 pb-10 pt-10">
      <div className="mx-auto max-w-[880px]">
        <header className="mb-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">Uncover</p>
          <h1 className="mt-1.5 font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-ink">Subjects</h1>
          <p className="mt-1.5 max-w-[560px] text-[14px] leading-[1.6] text-ink-3 [text-wrap:pretty]">
            Everything your team can ask about, in one place.
          </p>
        </header>

        <div className="mb-5 flex h-[44px] items-center gap-2.5 rounded-[10px] border border-line bg-raised pl-3.5 pr-1.5 shadow-1">
          <MessageSquare className="h-[15px] w-[15px] shrink-0 text-muted-2" strokeWidth={1.7} aria-hidden />
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
            placeholder="Ask anything, or jump to a subject…"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-muted-2 focus:outline-none"
          />
          <button
            type="button"
            onClick={ask}
            className="shrink-0 rounded-[8px] bg-ocean px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
          >
            Ask
          </button>
        </div>

        {error && <p className="text-[13px] text-err">{error}</p>}

        {!subjects && !error && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden /> Loading…
          </div>
        )}

        {subjects && subjects.length === 0 && (
          <div className="rounded-[10px] border border-line bg-raised px-6 py-8 text-center">
            <Layers className="mx-auto mb-3 h-7 w-7 text-muted-2" strokeWidth={1.5} aria-hidden />
            <p className="text-[14px] text-ink-2">No subjects yet.</p>
            {role === 'admin' || role === 'analyst' ? (
              <a href="/build" className="mt-3 inline-flex items-center gap-1.5 rounded-[8px] bg-ocean px-4 py-2 text-[13px] font-medium text-white hover:opacity-90">
                <Sparkles className="h-4 w-4" strokeWidth={1.8} aria-hidden />
                Create your topics
              </a>
            ) : (
              <p className="mt-1 text-[13px] text-muted">Your team is still setting things up.</p>
            )}
          </div>
        )}

        {subjects && subjects.length > 0 && (
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {subjects.map((s) => <SubjectCard key={s.id} subject={s} />)}
          </div>
        )}

        <a
          href="/shared-data"
          className="group mt-5 flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-3.5 transition-colors duration-1 ease-observatory hover:border-ocean"
        >
          <Library className="h-[17px] w-[17px] shrink-0 text-ocean" strokeWidth={1.6} aria-hidden />
          <span className="shrink-0 text-[13.5px] font-medium text-ink group-hover:text-ocean">Shared data</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
            The lookups every subject slices by — your customers, items, accounts and terms.
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
        </a>
      </div>
    </div>
  );
}

function SubjectCard({ subject }: { subject: Subject }) {
  const Glyph = iconForAnalytics(subject.name);
  const name = cleanTopicName(subject.name);
  // Same honesty rule as the Build page rows: a built subject whose tables
  // all hold zero rows is "waiting for data", not "refreshed just now".
  const waiting = subject.lastRefreshedAt !== null && subject.rowsTotal === 0;
  const fresh = !subject.lastRefreshedAt
    ? 'getting ready'
    : waiting
      ? 'waiting for data from your source'
      : `refreshed ${formatRelativeLong(subject.lastRefreshedAt)}`;
  const dot = !subject.lastRefreshedAt || waiting ? 'bg-warn' : 'bg-ok';

  return (
    <a
      href={`/topics/${subject.id}`}
      className="group flex flex-col gap-2.5 rounded-[10px] border border-line bg-raised p-4 shadow-1 transition-colors duration-1 ease-observatory hover:border-ocean"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] bg-ocean-softer text-ocean">
          <Glyph className="h-[17px] w-[17px]" strokeWidth={1.6} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink group-hover:text-ocean">{name}</span>
      </div>
      {subject.description && (
        <p className="line-clamp-2 min-h-[36px] text-[12px] leading-[1.55] text-ink-3">{subject.description}</p>
      )}
      <div className="flex items-center gap-2">
        <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-2">{fresh}</span>
        <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-ocean">
          Ask <ArrowRight className="h-3 w-3" strokeWidth={2} aria-hidden />
        </span>
      </div>
    </a>
  );
}

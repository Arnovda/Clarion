'use client';

/**
 * /definitions — the one place a definition lives.
 *
 * Three kinds, one pane: a TERM says what a word means (and points at the
 * column, table or metric that carries it), a METRIC says how a number is
 * computed, a VERIFIED ANSWER is a question your team has checked. They are
 * documented ONCE here and read by the AI on every question; none of them is
 * executed from this page. Terms are edited here (the glossary editor, with
 * its link picker); metrics are edited on their subject, verified answers
 * from the answer card — this pane shows them side by side so "what do we
 * mean by revenue?" has one door (2026-09-22, the catalog-is-the-workspace
 * revision; the glossary used to be a facet of the catalog).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Loader2, Sparkles } from 'lucide-react';
import RequireRole from '@/components/RequireRole';
import GlossaryPanel from '@/components/semantic/GlossaryPanel';
import { canCurate, useRole } from '@/lib/role';
import { formatRelative } from '@/lib/dates';
import api from '@/lib/api';
import { cn } from '@/lib/cn';

interface Metric {
  id: number;
  name: string;
  description: string | null;
  question_text: string | null;
  formula_plain_text: string | null;
  ai_draft: boolean;
  updated_at: string | null;
  product: { id: number; name: string; hidden: boolean };
}

interface VerifiedAnswer {
  id: number;
  question: string;
  connection_id: number | null;
  connection_name: string | null;
  data_layer: string | null;
  verified_at: string | null;
  verified_by_name: string | null;
  times_used: number;
}

interface Definitions {
  metrics: Metric[];
  verifiedAnswers: VerifiedAnswer[];
}

const SECTIONS = [
  { id: 'terms',    label: 'Terms' },
  { id: 'metrics',  label: 'Metrics' },
  { id: 'verified', label: 'Verified answers' },
] as const;

function DefinitionsInner() {
  const role = useRole();
  const curator = canCurate(role);
  const [data, setData] = useState<Definitions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/definitions')
      .then((r) => { if (!cancelled) setData({ metrics: r.data?.data?.metrics ?? [], verifiedAnswers: r.data?.data?.verifiedAnswers ?? [] }); })
      .catch(() => { if (!cancelled) setError('The metrics and verified answers could not be loaded.'); });
    return () => { cancelled = true; };
  }, []);

  const groups = groupMetrics(data?.metrics ?? []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-1">Studio</p>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <h1 className="font-display text-[28px] text-ink leading-tight tracking-[-0.02em]">Definitions</h1>
            <nav className="flex items-center gap-1" aria-label="Sections">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="px-2.5 py-1 text-[12px] font-medium text-muted hover:text-ink rounded hover:bg-soft transition-colors"
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </div>
          <p className="text-[12.5px] text-muted mt-1.5 leading-relaxed max-w-2xl">
            Documented once, read by the AI on every question. A term says what a word means,
            a metric says how a number is computed, a verified answer is a question your team has checked.
          </p>
        </header>

        <section id="terms" className="mb-10 scroll-mt-6">
          <SectionHeading label="Terms" hint="Your team's words, and where each one lives in the data." />
          <GlossaryPanel canEdit={curator} hideHeading />
        </section>

        <section id="metrics" className="mb-10 scroll-mt-6">
          <SectionHeading label="Metrics" hint="How a number is computed, per subject. Edited on the subject." />
          {error && <p className="text-[12.5px] text-err">{error}</p>}
          {!data && !error && <Loader2 className="w-4 h-4 animate-spin text-muted" />}
          {data && groups.length === 0 && (
            <p className="text-[12.5px] text-muted">
              No metrics yet. Build a subject and its metrics appear here.
            </p>
          )}
          <div className="space-y-6">
            {groups.map((g) => (
              <div key={g.product.id}>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <Link
                      href={`/catalog?productId=${g.product.id}`}
                      className="text-[13px] font-medium text-ink hover:text-ocean truncate"
                    >
                      {g.product.name}
                    </Link>
                    {g.product.hidden && (
                      <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-muted-2">hidden</span>
                    )}
                  </div>
                  {curator && (
                    <Link
                      href={`/topics/${g.product.id}?manage=1`}
                      className="inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ocean shrink-0"
                    >
                      Edit in the subject <ArrowUpRight className="w-3 h-3" strokeWidth={2} />
                    </Link>
                  )}
                </div>
                <ul className="divide-y divide-line rounded-lg border border-line bg-raised overflow-hidden">
                  {g.metrics.map((m) => (
                    <li key={m.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-ink leading-snug">{m.name}</p>
                          {m.question_text && (
                            <p className="font-display italic text-[13.5px] text-ink-2 mt-0.5 leading-snug">{m.question_text}</p>
                          )}
                          {m.description && (
                            <p className="text-[12.5px] text-muted mt-1 leading-relaxed">{m.description}</p>
                          )}
                          {m.formula_plain_text && (
                            <p className="text-[11.5px] font-mono text-ink-2 mt-1.5 leading-relaxed break-words">{m.formula_plain_text}</p>
                          )}
                        </div>
                        {m.ai_draft && (
                          <span
                            className="inline-flex items-center gap-1 shrink-0 text-[10.5px] font-mono uppercase tracking-[0.1em] text-warn"
                            title="Proposed by the AI and not yet confirmed by a person"
                          >
                            <Sparkles className="w-3 h-3" strokeWidth={2} /> AI draft
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section id="verified" className="mb-10 scroll-mt-6">
          <SectionHeading label="Verified answers" hint="Questions a person checked; the next asker gets the same answer." />
          {data && data.verifiedAnswers.length === 0 && (
            <p className="text-[12.5px] text-muted">
              None yet. Save a question from an answer card and verify it, and it appears here.
            </p>
          )}
          {data && data.verifiedAnswers.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line bg-raised overflow-hidden">
              {data.verifiedAnswers.map((a) => (
                <li key={a.id} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink leading-snug">{a.question}</p>
                    <p className="text-[11.5px] text-muted mt-1">
                      {[
                        a.connection_name ? `From ${a.connection_name}` : null,
                        a.verified_at ? `verified ${formatRelative(a.verified_at)}${a.verified_by_name ? ` by ${a.verified_by_name}` : ''}` : null,
                        a.times_used > 0 ? `used ${a.times_used} ${a.times_used === 1 ? 'time' : 'times'}` : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Link
                    href={askHref(a)}
                    className={cn(
                      'inline-flex items-center gap-1 shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-md border border-line',
                      'text-ink-2 hover:text-ink hover:bg-soft transition-colors',
                    )}
                  >
                    Ask it <ArrowUpRight className="w-3 h-3" strokeWidth={2} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionHeading({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="mb-3">
      <h2 className="font-display text-[19px] text-ink leading-tight">{label}</h2>
      <p className="text-[12px] text-muted mt-0.5">{hint}</p>
    </div>
  );
}

function groupMetrics(metrics: Metric[]): Array<{ product: Metric['product']; metrics: Metric[] }> {
  const byProduct = new Map<number, { product: Metric['product']; metrics: Metric[] }>();
  for (const m of metrics) {
    const g = byProduct.get(m.product.id) ?? { product: m.product, metrics: [] };
    g.metrics.push(m);
    byProduct.set(m.product.id, g);
  }
  // Visible subjects first, then by name; a hidden subject's metrics still
  // count as definitions, they just sort last.
  return [...byProduct.values()].sort((a, b) =>
    Number(a.product.hidden) - Number(b.product.hidden) || a.product.name.localeCompare(b.product.name));
}

/** A verified answer runs against its own connection, so the link carries it
 *  (Ask AI resolves the connection from the URL first — see lib/askLink.ts). */
function askHref(a: VerifiedAnswer): string {
  const params = new URLSearchParams({ q: a.question, autoSubmit: '1' });
  if (a.connection_id != null) params.set('connectionId', String(a.connection_id));
  return `/query?${params.toString()}`;
}

export default function DefinitionsPage() {
  return (
    <RequireRole roles={['admin', 'analyst', 'viewer']}>
      <DefinitionsInner />
    </RequireRole>
  );
}

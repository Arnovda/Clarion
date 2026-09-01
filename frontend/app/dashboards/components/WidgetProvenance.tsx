'use client';

/**
 * <WidgetProvenance> — answers "where does this number come from?" for a
 * single dashboard widget. The trust layer that turns a slick AI demo
 * into a tool a CFO will actually bet a board meeting on.
 *
 * Distinct from the existing widget actions:
 *   • "Explain" (Lightbulb)   = what does this CHART tell me (output-focused)
 *   • "Investigate" (Search)   = WHY did the number move (causal)
 *   • Provenance (Info, NEW)   = WHERE does this number come from (audit)
 *
 * Surfaces:
 *   1. Plain-English description of the SQL (Haiku-rendered) so the user
 *      can verify the math without reading SQL.
 *   2. Every source / product table the SQL touches, with last refresh
 *      time + description. "Stale data → wrong answer" is the most common
 *      trust failure; this answers it before the user has to ask.
 *   3. Raw SQL, collapsible, monospace — for analyst+/admin who want to
 *      audit the actual query.
 *   4. "Ask a follow-up" deep-link that prefills the chat with the
 *      relevant context, so the trust panel ends with action, not dead-end.
 */

import { useEffect, useState } from 'react';
import { formatSql } from '@/lib/formatSql';
import { useRouter } from 'next/navigation';
import {
  X, Database, Boxes, Clock, Sparkles, ChevronRight, Loader2, AlertCircle,
  HelpCircle,
} from 'lucide-react';
import api from '@/lib/api';
import { OBSERVATORY } from '@/lib/observatory';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { WidgetSpec } from '../types';

interface TableMeta {
  name: string;
  kind: 'product' | 'source' | 'unknown';
  description: string | null;
  lastRefreshedAt: string | null;
  productName?: string | null;
  sourceName?: string | null;
}

interface WidgetContext {
  plainEnglish: string | null;
  tablesUsed: TableMeta[];
  sql: string;
  dataLayer: 'product' | 'source';
}

interface Props {
  widget: WidgetSpec;
  dataLayer: 'product' | 'source';
  isAdminOrAnalyst: boolean;
  onClose: () => void;
}

export default function WidgetProvenance({ widget, dataLayer, isAdminOrAnalyst, onClose }: Props) {
  const router = useRouter();
  const [ctx, setCtx] = useState<WidgetContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.post('/dashboards/widget-context', {
          title: widget.title,
          sql: widget.sql,
          dataLayer,
        });
        if (cancelled) return;
        setCtx(res.data?.data as WidgetContext);
      } catch (err) {
        if (cancelled) return;
        setError((err as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error ?? 'Failed to load provenance');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [widget.sql, widget.title, dataLayer]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // "Ask a follow-up" — open the chat pre-loaded with this widget's context.
  // The /query page can read these params and seed the prompt input.
  const askFollowUp = () => {
    const params = new URLSearchParams({
      contextWidget: widget.title,
      seedQuestion: `About "${widget.title}": `,
    });
    router.push(`/query?${params.toString()}`);
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/40 flex items-stretch justify-end"
      onClick={onClose}
    >
      <div
        className="bg-raised w-full max-w-[560px] h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-raised border-b border-line px-5 py-3 flex items-start gap-2">
          <HelpCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: OBSERVATORY.ocean }} strokeWidth={1.75} />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">How was this computed?</p>
            <h2 className="font-display text-[18px] tracking-[-0.01em] text-ink truncate">
              {widget.title}
            </h2>
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
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="px-5 py-6 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 text-err" strokeWidth={1.75} />
            <div>
              <p className="text-[13px] text-ink">Could not load provenance.</p>
              <p className="text-[11.5px] text-muted mt-0.5 font-mono">{error}</p>
            </div>
          </div>
        ) : ctx ? (
          <div className="px-5 py-5 space-y-6">
            {/* Plain English */}
            <section>
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-1.5">In plain English</p>
              {ctx.plainEnglish ? (
                <p className="text-[13.5px] text-ink leading-relaxed">{ctx.plainEnglish}</p>
              ) : (
                <p className="text-[13px] text-muted italic">Could not generate a plain-English summary.</p>
              )}
            </section>

            {/* Tables */}
            <section>
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">
                Where the data lives
                {ctx.tablesUsed.length > 0 && (
                  <span className="ml-2 text-[10px] tracking-[0.06em] text-muted-2 normal-case">
                    {ctx.tablesUsed.length} table{ctx.tablesUsed.length === 1 ? '' : 's'} referenced
                  </span>
                )}
              </p>
              {ctx.tablesUsed.length === 0 ? (
                <p className="text-[12.5px] text-muted italic">No table references parsed from the SQL.</p>
              ) : (
                <ul className="divide-y divide-line border border-line rounded-md overflow-hidden">
                  {ctx.tablesUsed.map((t) => (
                    <li key={t.name} className="px-3 py-2.5">
                      <div className="flex items-center gap-2 mb-0.5">
                        {t.kind === 'product' ? (
                          <Boxes className="w-3.5 h-3.5 shrink-0" style={{ color: OBSERVATORY.ai }} strokeWidth={1.75} />
                        ) : t.kind === 'source' ? (
                          <Database className="w-3.5 h-3.5 shrink-0" style={{ color: OBSERVATORY.ocean }} strokeWidth={1.75} />
                        ) : (
                          <Database className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.75} />
                        )}
                        {/* Product-layer tables link into the Data Catalog —
                            the trust affordance the owner asked for: doubt
                            born here resolves on the table's own page. */}
                        {t.kind === 'product' ? (
                          <a
                            href={`/catalog?table=${encodeURIComponent(t.name)}`}
                            className="text-[12.5px] font-medium text-ink truncate hover:text-ocean hover:underline"
                            title="View this table in the Data Catalog"
                          >
                            {t.name}
                          </a>
                        ) : (
                          <span className="text-[12.5px] font-medium text-ink truncate">{t.name}</span>
                        )}
                        <span className={cn(
                          'text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-line ml-1',
                          t.kind === 'product' && 'text-ai bg-ai-soft',
                          t.kind === 'source' && 'text-ocean bg-ocean-softer',
                          t.kind === 'unknown' && 'text-muted-2 bg-softer',
                        )}>
                          {t.kind === 'product'
                            ? `dataset${t.productName ? ` · ${t.productName}` : ''}`
                            : t.kind === 'source'
                              ? `source${t.sourceName ? ` · ${t.sourceName}` : ''}`
                              : 'unknown'}
                        </span>
                        <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-mono text-muted-2 shrink-0">
                          <Clock className="w-3 h-3" strokeWidth={1.5} />
                          {t.lastRefreshedAt
                            ? `refreshed ${formatRelative(t.lastRefreshedAt)}`
                            : 'never refreshed'}
                        </span>
                      </div>
                      {t.description && (
                        <p className="text-[11.5px] text-muted-2 leading-relaxed mt-0.5">
                          {t.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* SQL — collapsible, admin/analyst only by convention but we
               hide it from viewers for less noise */}
            {isAdminOrAnalyst && (
              <section>
                <button
                  onClick={() => setShowSql(!showSql)}
                  className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted hover:text-ink-2 inline-flex items-center gap-1 mb-2"
                >
                  <ChevronRight className={cn('w-3 h-3 transition-transform', showSql && 'rotate-90')} />
                  Underlying SQL
                </button>
                {showSql && (
                  // `whitespace-pre` + horizontal scroll, NOT pre-wrap: once
                  // the query is indented, wrapping a long line re-flows it
                  // under the wrong indent level and undoes the formatting.
                  // A widget's SQL arrives as one long line — see formatSql.
                  <pre className="text-[11.5px] font-mono bg-ink text-white/85 rounded-md px-3 py-2.5 overflow-x-auto whitespace-pre leading-relaxed">
                    {formatSql(ctx.sql)}
                  </pre>
                )}
              </section>
            )}

            {/* Action */}
            <section className="pt-1">
              <button
                onClick={askFollowUp}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
                Ask a follow-up question about this
              </button>
              <p className="text-[10.5px] text-muted-2 text-center mt-1.5">
                Opens Ask AI with this widget&rsquo;s context loaded.
              </p>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

'use client';

/**
 * <GlossaryLinkPicker> — "this term is …" picker for a glossary entry.
 *
 * A term's link is its ADDRESS in the data: a column, a whole table, or a
 * KPI of a topic. The picker is one searchable list grouped by topic and
 * table (the shape the Your-tables link picker taught: a built topic easily
 * carries 60+ columns, and an unsearchable flat list makes the feature feel
 * like a chore). KPIs sit in their own group at the top, because a term like
 * "outstanding receivables" is more often a KPI than a column.
 *
 * Picking calls `onPick` and closes; the parent renders the chosen links as
 * chips and sends them with the entry. Nothing is saved from here.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Link2, Search } from 'lucide-react';
import type { GlossaryLink, GlossaryLinkTargets } from './types';
import { glossaryLinkKey } from './types';

export default function GlossaryLinkPicker({
  targets, onPick, exclude,
}: {
  /** null = still loading. */
  targets: GlossaryLinkTargets | null;
  onPick: (link: GlossaryLink) => void;
  /** Links already on the entry — hidden from the list so nothing is picked twice. */
  exclude: GlossaryLink[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const taken = useMemo(() => new Set(exclude.map(glossaryLinkKey)), [exclude]);
  const q = query.trim().toLowerCase();

  const kpis = useMemo(() => {
    if (!targets) return [];
    return targets.kpis.filter((k) => {
      if (taken.has(glossaryLinkKey({ kind: 'kpi', kpi: k.name }))) return false;
      if (q === '') return true;
      return `${k.topic} ${k.name} ${k.description ?? ''}`.toLowerCase().includes(q);
    });
  }, [targets, q, taken]);

  const tables = useMemo(() => {
    if (!targets) return [];
    return targets.tables
      .map((t) => {
        const tableText = `${t.topic} ${t.displayName ?? ''} ${t.tableName}`.toLowerCase();
        const tableMatches = q === '' || tableText.includes(q);
        const columns = t.columns.filter((c) => {
          if (taken.has(glossaryLinkKey({ kind: 'column', table: t.tableName, column: c.name }))) return false;
          if (q === '') return true;
          return tableMatches || c.name.toLowerCase().includes(q) || (c.displayName ?? '').toLowerCase().includes(q);
        });
        const wholeTable = !taken.has(glossaryLinkKey({ kind: 'table', table: t.tableName })) && tableMatches;
        return { ...t, columns, wholeTable };
      })
      .filter((t) => t.columns.length > 0 || t.wholeTable);
  }, [targets, q, taken]);

  const pick = (link: GlossaryLink) => { onPick(link); setOpen(false); };
  const rowCls = 'flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] font-normal normal-case tracking-normal text-ink-2 hover:bg-softer';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-[8px] border border-dashed border-line-strong bg-bg px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:border-ocean hover:text-ocean focus:border-ocean focus:outline-none"
      >
        <Link2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
        <span>Link to a column, table or KPI</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-50 mt-1 w-[360px] max-w-[90vw] overflow-hidden rounded-[10px] border border-line bg-raised shadow-2">
            <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
                placeholder="Search topics, tables, columns, KPIs…"
                className="w-full bg-transparent text-[12.5px] font-normal normal-case tracking-normal text-ink placeholder:text-muted-2 focus:outline-none"
              />
            </div>
            <div className="max-h-[300px] overflow-y-auto p-1">
              {targets === null ? (
                <p className="px-2.5 py-2 text-[12px] text-muted-2">Loading your topics…</p>
              ) : kpis.length === 0 && tables.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] text-muted-2">
                  {q ? 'Nothing matches.' : 'No topics built yet — a term can be linked once a topic exists.'}
                </p>
              ) : (
                <>
                  {kpis.length > 0 && (
                    <div className="mb-1">
                      <p className="px-2.5 pb-0.5 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-2">KPIs</p>
                      {kpis.map((k) => (
                        <button key={`${k.topic}:${k.name}`} type="button" onClick={() => pick({ kind: 'kpi', kpi: k.name })} className={rowCls}>
                          <span className="min-w-0 flex-1 truncate">{k.name}</span>
                          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-2">{k.topic}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {tables.map((t) => (
                    <div key={t.tableName} className="mb-1">
                      <p className="px-2.5 pb-0.5 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-2">
                        {t.topic} · {t.displayName ?? t.tableName}
                      </p>
                      {t.wholeTable && (
                        <button type="button" onClick={() => pick({ kind: 'table', table: t.tableName })} className={`${rowCls} italic text-ink-3`}>
                          <span className="min-w-0 flex-1 truncate">The whole table</span>
                        </button>
                      )}
                      {t.columns.map((c) => (
                        <button key={c.name} type="button" onClick={() => pick({ kind: 'column', table: t.tableName, column: c.name })} className={rowCls}>
                          <span className="min-w-0 flex-1 truncate">{c.displayName ?? c.name}</span>
                          {c.role === 'measure' && (
                            <span className="shrink-0 rounded bg-ok-soft px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ok">measure</span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One line of plain language for a link, resolved or not. */
export function describeGlossaryLink(l: { kind: string; table?: string; column?: string; kpi?: string; topic?: string | null; label?: string | null; resolved?: boolean }): string {
  if (l.kind === 'kpi') return `${l.topic ? `${l.topic} · ` : ''}KPI ${l.label ?? l.kpi}`;
  if (l.kind === 'table') return `${l.topic ? `${l.topic} · ` : ''}${l.label ?? l.table}`;
  return `${l.topic ? `${l.topic} · ` : ''}${l.table} › ${l.label ?? l.column}`;
}

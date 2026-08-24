'use client';

/**
 * <LinkPicker> — searchable picker for "this column contains …".
 *
 * Replaces the native <select> the moment a real tenant met it: a built
 * topic easily carries 60+ linkable columns, and an unsearchable flat list
 * makes the killer feature feel like a chore. A text box filters across
 * topic, table and column names at once; matches stay grouped under their
 * table so "Code" on Accounts and "Code" on Items never blur together.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { GridColumnLink, LinkableTable } from './types';

export function linkLabel(linkable: LinkableTable[] | null, link: GridColumnLink | null): string | null {
  if (!link) return null;
  const t = linkable?.find((x) => x.tableName === link.table);
  const c = t?.columns.find((x) => x.name === link.column);
  if (!t) return `${link.table} · ${link.column}`;
  return `${t.displayName ?? t.tableName} · ${c?.displayName ?? link.column}`;
}

export default function LinkPicker({
  linkable, value, onChange,
  restrictToTable = null,
  clearLabel = 'Nothing specific — free text',
  compact = false,
}: {
  linkable: LinkableTable[] | null;
  value: GridColumnLink | null;
  onChange: (link: GridColumnLink | null) => void;
  /** Second-field pickers restrict to the first field's table. */
  restrictToTable?: string | null;
  clearLabel?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      // Focus after the dropdown paints.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const groups = useMemo(() => {
    if (!linkable) return [];
    const q = query.trim().toLowerCase();
    const pool = restrictToTable
      ? linkable.filter((t) => t.tableName === restrictToTable)
      : linkable;
    return pool
      .map((t) => {
        const tableText = `${t.topic} ${t.displayName ?? ''} ${t.tableName}`.toLowerCase();
        const cols = t.columns.filter((c) => {
          if (q === '') return true;
          return (
            tableText.includes(q) ||
            c.name.toLowerCase().includes(q) ||
            (c.displayName ?? '').toLowerCase().includes(q)
          );
        });
        return { ...t, columns: cols };
      })
      .filter((t) => t.columns.length > 0);
  }, [linkable, query, restrictToTable]);

  const label = linkLabel(linkable, value) ?? clearLabel;
  const textSize = compact ? 'text-[12px]' : 'text-[13px]';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 rounded-[8px] border border-line bg-bg px-2.5 ${compact ? 'py-1.5' : 'py-2'} text-left ${textSize} font-normal normal-case tracking-normal ${value ? 'text-ink' : 'text-muted-2'} focus:border-ocean focus:outline-none`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-[10px] border border-line bg-raised shadow-2">
            <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
                placeholder="Search columns…"
                className="w-full bg-transparent text-[12.5px] font-normal normal-case tracking-normal text-ink placeholder:text-muted-2 focus:outline-none"
              />
            </div>
            <div className="max-h-[260px] overflow-y-auto p-1">
              {query === '' && !restrictToTable && (
                <button
                  type="button"
                  onClick={() => { onChange(null); setOpen(false); }}
                  className={`flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] font-normal normal-case tracking-normal ${value === null ? 'text-ocean' : 'text-ink-3 hover:bg-softer'}`}
                >
                  {value === null && <Check className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />}
                  <span className={value === null ? '' : 'pl-5'}>{clearLabel}</span>
                </button>
              )}
              {linkable === null ? (
                <p className="px-2.5 py-2 text-[12px] font-normal normal-case tracking-normal text-muted-2">Loading your data…</p>
              ) : groups.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] font-normal normal-case tracking-normal text-muted-2">
                  {query ? 'Nothing matches.' : 'No topics built yet.'}
                </p>
              ) : (
                groups.map((t) => (
                  <div key={t.tableName} className="mb-1">
                    <p className="px-2.5 pb-0.5 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-2">
                      {t.topic} · {t.displayName ?? t.tableName}
                    </p>
                    {t.columns.map((c) => {
                      const selected = value?.table === t.tableName && value?.column === c.name;
                      return (
                        <button
                          key={c.name}
                          type="button"
                          onClick={() => { onChange({ table: t.tableName, column: c.name }); setOpen(false); }}
                          className={`flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] font-normal normal-case tracking-normal ${selected ? 'bg-ocean-softer text-ocean' : 'text-ink-2 hover:bg-softer'}`}
                        >
                          {selected && <Check className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />}
                          <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'pl-5'}`}>{c.displayName ?? c.name}</span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

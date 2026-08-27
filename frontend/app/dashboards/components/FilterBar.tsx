'use client';

import { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { humanizeTableName } from '@/lib/humanize';
import type { FilterSpec } from '../types';

interface FilterBarProps {
  filters: FilterSpec[];
  filterValues: Record<string, string>;
  filterOptions: Record<string, string[]>;
  onFilterChange: (key: string, value: string) => void;
  loading?: boolean;
}

/** Shared Observatory input/select styling for the filter bar. */
const INPUT_CLASS =
  'text-[12px] px-2.5 py-1.5 rounded-md border border-line bg-raised text-ink-2 ' +
  'focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 ' +
  'disabled:opacity-50 transition-colors';

const SELECT_CHEVRON_BG =
  "appearance-none pr-7 " +
  "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22%236b7680%22%3E%3Cpath%20d%3D%22M10%2014l-5-5h10l-5%205z%22%2F%3E%3C%2Fsvg%3E')] " +
  'bg-[length:16px] bg-[right_6px_center] bg-no-repeat';

/**
 * Date input that maintains a LOCAL draft and only commits to the
 * parent (firing a filter change → query) on blur or Enter.
 *
 * Why this exists: native <input type="date"> fires `onChange` for
 * every intermediate value the user touches in the picker. A user
 * who wanders through Jan → Feb → Mar → Apr to find the right month
 * triggers four query refreshes. Committing only on blur means the
 * query fires once, on the final value the user actually settled on.
 *
 * Visual hint: when the draft differs from the committed value, the
 * border tints `ocean` to signal "unapplied change — click away or
 * press Enter to apply." Matches the editor convention of dirty-state
 * indication.
 */
function CommitOnBlurDateInput({
  value,
  onCommit,
  disabled,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Keep draft in sync when the committed value changes externally
  // (e.g. dashboard load, programmatic reset). Without this the
  // input would show stale local state after a refresh.
  const lastCommittedRef = useRef(value);
  useEffect(() => {
    if (value !== lastCommittedRef.current) {
      setDraft(value);
      lastCommittedRef.current = value;
    }
  }, [value]);

  const dirty = draft !== value;

  const commit = () => {
    if (draft === value) return;
    lastCommittedRef.current = draft;
    onCommit(draft);
  };

  return (
    <input
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur(); // fires onBlur which commits
        } else if (e.key === 'Escape') {
          // Revert draft to committed value without firing a query.
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      disabled={disabled}
      className={`${className ?? ''} ${dirty ? 'border-ocean ring-1 ring-ocean/30' : ''}`}
      title={dirty ? 'Press Enter or click away to apply' : undefined}
    />
  );
}

/**
 * Per-filter provenance popover — answers "where do these options come from?"
 * without leaving the dashboard. Entirely deterministic: it renders the
 * filter spec's table/column and the option values ALREADY loaded for the
 * dropdown. No AI call, no extra fetch. This is the trust affordance for the
 * moment a user distrusts a filter value (e.g. an Item Group list with one
 * suspicious entry): the answer is the source column and the full value list,
 * two clicks from the doubt.
 */
function FilterProvenance({ filter, options }: { filter: FilterSpec; options: string[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!filter.table || !filter.column) return null;
  const shown = options.slice(0, 12);
  const more = options.length - shown.length;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`p-0.5 rounded transition-colors ${open ? 'text-ocean' : 'text-muted-2 hover:text-ink-2'}`}
        title="Where do these values come from?"
        aria-expanded={open}
      >
        <HelpCircle className="w-3.5 h-3.5" strokeWidth={1.5} />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-50 w-72 bg-raised border border-line rounded-lg shadow-2 p-4">
          <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-ocean mb-2">
            Where these values come from
          </p>
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            <span className="font-medium">{humanizeTableName(filter.table)}</span>
            {' — field '}
            <code className="text-[11px] font-mono bg-softer border border-line rounded px-1 py-0.5">
              {filter.column}
            </code>
          </p>
          {filter.type === 'select' ? (
            <>
              <p className="text-[11px] text-muted mt-2">
                {options.length === 0
                  ? 'No values loaded yet.'
                  : `${options.length} distinct value${options.length === 1 ? '' : 's'} found in your data:`}
              </p>
              {shown.length > 0 && (
                <ul className="mt-1.5 max-h-40 overflow-y-auto space-y-0.5">
                  {shown.map((o) => (
                    <li key={o} className="text-[12px] text-ink-2 truncate">· {o}</li>
                  ))}
                  {more > 0 && <li className="text-[11px] text-muted-2">+{more} more</li>}
                </ul>
              )}
              {options.length === 1 && (
                <p className="text-[11px] text-muted mt-2 leading-relaxed">
                  Only one value exists — if you expected more, check the table below or ask AI about it.
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] text-muted mt-2 leading-relaxed">
              Every widget on this dashboard is filtered on this date field.
            </p>
          )}
          <a
            href={`/catalog?table=${encodeURIComponent(filter.table)}`}
            className="mt-3 inline-flex items-center gap-1 text-[11.5px] font-medium text-ocean hover:underline"
          >
            View {humanizeTableName(filter.table)} in the Data Catalog →
          </a>
        </div>
      )}
    </div>
  );
}

export function FilterBar({
  filters,
  filterValues,
  filterOptions,
  onFilterChange,
  loading,
}: FilterBarProps) {
  if (!filters.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-4 px-6 py-3 border-b border-line bg-raised shrink-0">
      {filters.map((f) => {
        if (f.type === 'date_range') {
          const fromKey = `${f.id}_from`;
          const toKey = `${f.id}_to`;
          return (
            <div key={f.id} className="flex items-center gap-2">
              <label className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted whitespace-nowrap">
                {f.label}
              </label>
              <CommitOnBlurDateInput
                value={filterValues[fromKey] ?? ''}
                onCommit={(v) => onFilterChange(fromKey, v)}
                disabled={loading}
                className={INPUT_CLASS}
              />
              <span className="text-[11px] text-muted-2">to</span>
              <CommitOnBlurDateInput
                value={filterValues[toKey] ?? ''}
                onCommit={(v) => onFilterChange(toKey, v)}
                disabled={loading}
                className={INPUT_CLASS}
              />
              <FilterProvenance filter={f} options={[]} />
            </div>
          );
        }

        // Select filter
        const opts = filterOptions[f.id] ?? [];
        return (
          <div key={f.id} className="flex items-center gap-2">
            <label className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted whitespace-nowrap">
              {f.label}
            </label>
            <select
              value={filterValues[f.id] ?? 'all'}
              onChange={(e) => onFilterChange(f.id, e.target.value)}
              disabled={loading}
              className={`${INPUT_CLASS} ${SELECT_CHEVRON_BG}`}
            >
              <option value="all">{f.allLabel ?? 'All'}</option>
              {opts.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <FilterProvenance filter={f} options={opts} />
          </div>
        );
      })}
    </div>
  );
}

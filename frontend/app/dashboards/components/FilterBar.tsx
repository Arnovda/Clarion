'use client';

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
              <input
                type="date"
                value={filterValues[fromKey] ?? ''}
                onChange={(e) => onFilterChange(fromKey, e.target.value)}
                disabled={loading}
                className={INPUT_CLASS}
              />
              <span className="text-[11px] text-muted-2">to</span>
              <input
                type="date"
                value={filterValues[toKey] ?? ''}
                onChange={(e) => onFilterChange(toKey, e.target.value)}
                disabled={loading}
                className={INPUT_CLASS}
              />
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
          </div>
        );
      })}
    </div>
  );
}

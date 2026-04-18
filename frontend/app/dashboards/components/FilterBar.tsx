'use client';

import type { FilterSpec } from '../types';

interface FilterBarProps {
  filters: FilterSpec[];
  filterValues: Record<string, string>;
  filterOptions: Record<string, string[]>;
  onFilterChange: (key: string, value: string) => void;
  loading?: boolean;
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
    <div className="filter-bar sticky top-0 z-20 flex flex-wrap items-center gap-3 px-4 py-3 mb-4 rounded-xl">
      {filters.map((f) => {
        if (f.type === 'date_range') {
          const fromKey = `${f.id}_from`;
          const toKey = `${f.id}_to`;
          return (
            <div key={f.id} className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-500 whitespace-nowrap">
                {f.label}
              </label>
              <input
                type="date"
                value={filterValues[fromKey] ?? ''}
                onChange={(e) => onFilterChange(fromKey, e.target.value)}
                disabled={loading}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200/60
                  bg-white/70 text-slate-700
                  shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400
                  disabled:opacity-50 transition-all"
              />
              <span className="text-xs text-slate-400">to</span>
              <input
                type="date"
                value={filterValues[toKey] ?? ''}
                onChange={(e) => onFilterChange(toKey, e.target.value)}
                disabled={loading}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200/60
                  bg-white/70 text-slate-700
                  shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400
                  disabled:opacity-50 transition-all"
              />
            </div>
          );
        }

        // Select filter
        const opts = filterOptions[f.id] ?? [];
        return (
          <div key={f.id} className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-500 whitespace-nowrap">
              {f.label}
            </label>
            <select
              value={filterValues[f.id] ?? 'all'}
              onChange={(e) => onFilterChange(f.id, e.target.value)}
              disabled={loading}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200/60
                bg-white/70 text-slate-700
                shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400
                disabled:opacity-50 transition-all appearance-none pr-7
                bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22%2394a3b8%22%3E%3Cpath%20d%3D%22M10%2014l-5-5h10l-5%205z%22%2F%3E%3C%2Fsvg%3E')]
                bg-[length:16px] bg-[right_4px_center] bg-no-repeat"
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

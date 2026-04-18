'use client';

interface DashboardHeaderProps {
  title: string;
  description: string;
  isUnsaved: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saving: boolean;
  darkMode: boolean;
  onToggleDark: () => void;
}

export function DashboardHeader({
  title,
  description,
  isUnsaved,
  onSave,
  onDiscard,
  saving,
  darkMode,
  onToggleDark,
}: DashboardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-slate-900 truncate">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-slate-500 truncate mt-0.5">
            {description}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Dark mode toggle */}
        <button
          onClick={onToggleDark}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-black/5 transition-colors"
          title={darkMode ? 'Light mode' : 'Dark mode'}
        >
          {darkMode ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
        </button>

        {/* Discard button */}
        {isUnsaved && (
          <button
            onClick={onDiscard}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium rounded-lg text-slate-600
              hover:bg-slate-100/80 transition-colors
              disabled:opacity-50"
          >
            Discard
          </button>
        )}

        {/* Save button */}
        <button
          onClick={onSave}
          disabled={saving}
          className={`px-4 py-1.5 text-xs font-semibold rounded-lg text-white transition-all
            disabled:opacity-50
            ${isUnsaved
              ? 'bg-indigo-600 hover:bg-indigo-700 shadow-md shadow-indigo-500/25 animate-pulse'
              : 'bg-indigo-600 hover:bg-indigo-700 shadow-sm'
            }`}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

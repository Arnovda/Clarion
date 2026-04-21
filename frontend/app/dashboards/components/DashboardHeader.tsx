'use client';

import { Sun, Moon } from 'lucide-react';

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
        <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em] truncate">
          {title}
        </h2>
        {description && (
          <p className="text-[12px] text-ink-3 truncate mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {/* Dark mode toggle */}
        <button
          onClick={onToggleDark}
          className="w-8 h-8 flex items-center justify-center rounded-md border border-line text-ink-3 hover:bg-softer hover:text-ink-2 hover:border-line-strong transition-colors"
          title={darkMode ? 'Light mode' : 'Dark mode'}
        >
          {darkMode ? (
            <Sun className="w-4 h-4" strokeWidth={1.5} />
          ) : (
            <Moon className="w-4 h-4" strokeWidth={1.5} />
          )}
        </button>

        {/* Discard button */}
        {isUnsaved && (
          <button
            onClick={onDiscard}
            disabled={saving}
            className="px-3 py-1.5 text-[12px] rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors disabled:opacity-50"
          >
            Discard
          </button>
        )}

        {/* Save button */}
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 text-[12px] font-medium rounded-md text-white bg-ocean hover:bg-ocean-hover transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

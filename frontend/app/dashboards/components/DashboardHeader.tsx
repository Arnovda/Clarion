'use client';

import { Sun, Moon, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';

interface DashboardHeaderProps {
  title: string;
  description: string;
  isUnsaved: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saving: boolean;
  darkMode: boolean;
  onToggleDark: () => void;
  /** Fast-mode toggle — when defined, renders the beta toggle next to
   *  the dark-mode button. Persisted per-user in localStorage by the
   *  parent. Omitted when WASM isn't supported in this browser so the
   *  user never sees an affordance they can't use. */
  fastMode?: boolean;
  onToggleFastMode?: () => void;
  /** Status line shown when fast mode is on — "loading…", "12.4 MB in
   *  browser", or an error if the cube load failed. */
  fastModeStatus?: 'idle' | 'loading' | 'ready' | 'failed';
  fastModeMessage?: string | null;
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
  fastMode,
  onToggleFastMode,
  fastModeStatus,
  fastModeMessage,
}: DashboardHeaderProps) {
  const fastModeAvailable = fastMode !== undefined && onToggleFastMode !== undefined;

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
        {/* Fast-mode status line — only visible when the toggle is ON
            so off-by-default users never see this chrome. Surfaces
            cube-load progress + the in-browser size so the user knows
            what just happened when they flipped the switch. */}
        {fastModeAvailable && fastMode && fastModeMessage && (
          <p className={cn(
            'text-[11px] font-mono tracking-[0.04em] uppercase mt-1.5',
            fastModeStatus === 'failed' ? 'text-warn'
              : fastModeStatus === 'ready' ? 'text-ok'
              : 'text-muted-2',
          )}>
            {fastModeMessage}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {/* Fast mode (beta) — the DuckDB-WASM toggle. Surfaced only when
            the browser supports WASM; absent otherwise so users never
            see an affordance that won't work for them. */}
        {fastModeAvailable && (
          <button
            onClick={onToggleFastMode}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md border text-[11px] font-mono uppercase tracking-[0.08em] transition-colors',
              fastMode
                ? 'border-ocean bg-ocean-softer text-ocean'
                : 'border-line text-muted hover:text-ink-2 hover:bg-softer',
            )}
            title={fastMode ? 'Disable fast mode' : 'Run queries in-browser (beta)'}
          >
            <Zap className="w-3.5 h-3.5" strokeWidth={fastMode ? 2 : 1.5} />
            Fast
            <span className={cn(
              'ml-0.5 px-1 py-0.5 text-[9px] tracking-wider rounded',
              fastMode ? 'bg-ocean text-white' : 'bg-softer text-muted-2 border border-line',
            )}>
              BETA
            </span>
          </button>
        )}

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

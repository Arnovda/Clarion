'use client';

import { useState } from 'react';
import { Lightbulb, RefreshCw, X } from 'lucide-react';

interface InsightsStripProps {
  insights: string[];
  onDismiss: () => void;
  /** Re-run the AI summary on the CURRENT data — an explicit user action.
   *  Opening a dashboard never calls the AI; this button is how the summary
   *  updates after the data (or the dashboard) changed. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function InsightsStrip({ insights, onDismiss, onRefresh, refreshing }: InsightsStripProps) {
  const [expanded, setExpanded] = useState(true);

  if (!insights.length) return null;

  return (
    <div className="rounded-lg border border-line bg-raised mb-5 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-line">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-3.5 h-3.5 text-ocean" strokeWidth={2} />
          <span className="text-[11px] font-mono tracking-[0.1em] uppercase text-ocean">
            3 things to notice
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="p-1 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors disabled:opacity-50"
              title="Update the summary from the current data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors text-[11px] font-mono"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
          <button
            onClick={onDismiss}
            className="p-1 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-5 py-3 flex flex-col gap-2.5">
          {insights.map((insight, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="mt-0.5 w-5 h-5 rounded-full bg-ocean-softer text-ocean text-[10px] font-mono flex items-center justify-center shrink-0">
                {i + 1}
              </span>
              <p className="text-[13px] text-ink-2 leading-relaxed">{insight}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InsightsStripSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-raised mb-5 px-5 py-4 flex items-center gap-3">
      <Lightbulb className="w-3.5 h-3.5 text-muted-2 animate-pulse" strokeWidth={2} />
      <span className="text-[11px] font-mono text-muted-2 animate-pulse">
        Analysing dashboard…
      </span>
    </div>
  );
}

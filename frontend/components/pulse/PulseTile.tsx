'use client';

/**
 * <PulseTile> — one watched metric, rendered with real data.
 *
 * Three branches:
 *   - `ok`                  big number + delta + sparkline + (optional)
 *                           AI bullet + action links
 *   - `no_observations_yet` "first reading is being taken" placeholder —
 *                           no comparisons yet (configured today)
 *   - `snapshot_failed`     explicit error state with refresh CTA — the
 *                           opposite of today's silent failure
 *
 * Layout is one wide tile per metric. With multiple metrics the parent
 * (<PulsePanel>) stacks them in a grid.
 *
 * Visual leans on existing Observatory tokens — ocean for positive,
 * warn for warnings, err for failures. The sparkline is recharts
 * (already a dependency). No extra packages.
 */

import { useMemo } from 'react';
import {
  LineChart, Line, ResponsiveContainer, Tooltip,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, ArrowRight, Loader2,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/cn';

// ───────────────────────────────────────────────────────────────────────────
// Types — mirror backend shape (PulseTileState in pulseStateService.ts)
// ───────────────────────────────────────────────────────────────────────────

type Status = 'ok' | 'no_observations_yet' | 'snapshot_failed';

export interface PulseTileDelta {
  value: number;
  label: string;
  period: string;
  deltaAbs: number | null;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
}

export interface PulseTileBrief {
  briefDate: string;
  headline: string;
  context: string;
  tone: 'warn' | 'positive' | 'neutral';
}

export interface PulseTileState {
  id: number;
  label: string;
  productName: string | null;
  kind: 'metric' | 'slice' | 'theme';
  sensitivity: 'low' | 'medium' | 'high';
  frequency: 'daily' | 'weekly';
  currentValue: number | null;
  currentValueLabel: string | null;
  asOf: string | null;
  prior: PulseTileDelta | null;
  priorWeek: PulseTileDelta | null;
  sparkline: Array<{ date: string; value: number | null }>;
  latestBriefBullet: PulseTileBrief | null;
  status: Status;
  errorMessage: string | null;
  consecutiveFailures: number;
  lastErrorAt: string | null;
  links: { productId: number | null; kpiId: number | null };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function deltaColor(direction: 'up' | 'down' | 'flat'): string {
  if (direction === 'up') return 'text-ok';
  if (direction === 'down') return 'text-err';
  return 'text-muted-2';
}

function DeltaIcon({ direction, className }: { direction: 'up' | 'down' | 'flat'; className?: string }) {
  if (direction === 'up') return <TrendingUp className={className} strokeWidth={2} />;
  if (direction === 'down') return <TrendingDown className={className} strokeWidth={2} />;
  return <Minus className={className} strokeWidth={2} />;
}

function formatPct(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '';
  const abs = Math.abs(p * 100);
  const sign = p > 0 ? '+' : p < 0 ? '−' : '';
  return `${sign}${abs.toFixed(1)}%`;
}

function relDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `${diff} days ago`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

// ───────────────────────────────────────────────────────────────────────────
// Tile
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  state: PulseTileState;
  onOpenProduct?: (productId: number) => void;
  onInvestigate?: (state: PulseTileState) => void;
  onEdit?: (entryId: number) => void;
}

export default function PulseTile({ state, onOpenProduct, onInvestigate, onEdit }: Props) {
  if (state.status === 'snapshot_failed') {
    return <FailedTile state={state} onOpenProduct={onOpenProduct} onEdit={onEdit} />;
  }
  if (state.status === 'no_observations_yet') {
    return <FirstDayTile state={state} onEdit={onEdit} />;
  }
  return (
    <OkTile state={state} onOpenProduct={onOpenProduct} onInvestigate={onInvestigate} onEdit={onEdit} />
  );
}

// ───────────────────────────────────────────────────────────────────────────
// OK state — value + comparisons + sparkline + (optional) AI line
// ───────────────────────────────────────────────────────────────────────────

function OkTile({ state, onOpenProduct, onInvestigate, onEdit }: Props) {
  // Sparkline data: filter nulls for the chart (recharts handles gaps with
  // connectNulls=false but visual is cleaner without them).
  const sparkData = useMemo(
    () => state.sparkline.map((p) => ({ date: p.date, value: p.value ?? null })),
    [state.sparkline],
  );
  const sparkHasData = sparkData.some((p) => p.value != null);

  // Pick the more attention-grabbing comparison for the badge: if
  // priorWeek shows a bigger move, surface that next to "yesterday."
  const primaryDelta = state.prior;
  const secondaryDelta = state.priorWeek;

  return (
    <article className="relative bg-raised border border-line rounded-lg overflow-hidden group hover:border-ocean/30 transition-colors">
      <div className="px-5 py-4">
        {/* Top row: name + product · sensitivity pill */}
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-[16px] text-ink tracking-[-0.005em] truncate">
              {state.label}
            </h3>
            {state.productName && (
              <p className="text-[11px] text-muted-2 font-mono tracking-wide uppercase mt-0.5">
                {state.productName}
              </p>
            )}
          </div>
          <SensitivityPill sensitivity={state.sensitivity} frequency={state.frequency} />
        </div>

        {/* Value + delta block */}
        <div className="flex items-end gap-6 mb-3">
          <div className="min-w-0">
            <p className="font-display text-[32px] tabular-nums text-ink leading-none">
              {state.currentValueLabel ?? '—'}
            </p>
            <p className="text-[11px] text-muted-2 mt-1">
              {state.asOf ? `as of ${relDate(state.asOf)}` : 'no value'}
            </p>
          </div>
          {primaryDelta && (
            <div className="flex flex-col items-start gap-0.5">
              <span className={cn(
                'inline-flex items-center gap-1 text-[13px] font-medium tabular-nums',
                deltaColor(primaryDelta.direction),
              )}>
                <DeltaIcon direction={primaryDelta.direction} className="w-3.5 h-3.5" />
                {formatPct(primaryDelta.deltaPct)}
              </span>
              <span className="text-[10.5px] text-muted-2">
                vs {primaryDelta.label} {primaryDelta.period}
              </span>
            </div>
          )}
          {secondaryDelta && (
            <div className="flex flex-col items-start gap-0.5">
              <span className={cn(
                'inline-flex items-center gap-1 text-[12px] tabular-nums',
                deltaColor(secondaryDelta.direction),
              )}>
                <DeltaIcon direction={secondaryDelta.direction} className="w-3 h-3" />
                {formatPct(secondaryDelta.deltaPct)}
              </span>
              <span className="text-[10.5px] text-muted-2">vs {secondaryDelta.period}</span>
            </div>
          )}
        </div>

        {/* Sparkline */}
        {sparkHasData && (
          <div className="h-[44px] w-full mb-3 -ml-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="var(--ocean, #0E6BA8)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface-raised, #fff)',
                    border: '1px solid rgba(127,138,152,0.2)',
                    fontSize: 11,
                    borderRadius: 4,
                  }}
                  labelFormatter={(v: unknown) => String(v)}
                  formatter={(value: unknown) =>
                    typeof value === 'number' ? value.toLocaleString('en-GB') : String(value)
                  }
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* AI context line — only when noteworthy (warn or positive tone).
            Neutral / calm bullets are quieter, less visual noise. */}
        {state.latestBriefBullet && state.latestBriefBullet.tone !== 'neutral' && (
          <BriefBubble bullet={state.latestBriefBullet} />
        )}

        {/* Footer actions */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line/70 text-[11px]">
          {state.consecutiveFailures > 0 && (
            <span className="inline-flex items-center gap-1 text-warn" title={state.errorMessage ?? undefined}>
              <AlertTriangle className="w-3 h-3" strokeWidth={2} />
              Stale ({state.consecutiveFailures} {state.consecutiveFailures === 1 ? 'failed try' : 'consecutive failed tries'})
            </span>
          )}
          <div className="ml-auto inline-flex items-center gap-3">
            {state.links.productId && onOpenProduct && (
              <button
                type="button"
                onClick={() => onOpenProduct(state.links.productId!)}
                className="inline-flex items-center gap-1 text-ocean hover:underline"
              >
                Open {state.productName ?? 'product'}
                <ArrowRight className="w-3 h-3" strokeWidth={2} />
              </button>
            )}
            {onInvestigate && (
              <button
                type="button"
                onClick={() => onInvestigate(state)}
                className="text-muted hover:text-ink"
              >
                Investigate
              </button>
            )}
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(state.id)}
                className="text-muted-2 hover:text-ink"
              >
                Edit
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// First-day state — placeholder while we wait for tomorrow's snapshot
// ───────────────────────────────────────────────────────────────────────────

function FirstDayTile({ state, onEdit }: Props) {
  return (
    <article className="relative bg-raised border border-line rounded-lg overflow-hidden">
      <div className="px-5 py-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-[16px] text-ink tracking-[-0.005em] truncate">
              {state.label}
            </h3>
            {state.productName && (
              <p className="text-[11px] text-muted-2 font-mono tracking-wide uppercase mt-0.5">
                {state.productName}
              </p>
            )}
          </div>
          <SensitivityPill sensitivity={state.sensitivity} frequency={state.frequency} />
        </div>

        <div className="flex items-center gap-3 px-4 py-6 bg-softer/50 border border-dashed border-line rounded-md">
          <Loader2 className="w-4 h-4 text-muted-2 animate-pulse" strokeWidth={2} />
          <div>
            <p className="text-[13px] text-ink">First reading hasn&rsquo;t run yet.</p>
            <p className="text-[11px] text-muted-2 mt-0.5">
              Snapshots run daily at 06:00 UTC. You&rsquo;ll see a value here once the first one lands —
              comparisons start the day after.
            </p>
          </div>
        </div>

        {onEdit && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line/70 text-[11px] text-muted-2">
            <button
              type="button"
              onClick={() => onEdit(state.id)}
              className="ml-auto hover:text-ink"
            >
              Edit
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Failed state — explicit, with action
// ───────────────────────────────────────────────────────────────────────────

function FailedTile({ state, onOpenProduct, onEdit }: Props) {
  return (
    <article className="relative bg-raised border border-warn/30 rounded-lg overflow-hidden">
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-warn" aria-hidden />
      <div className="pl-5 pr-5 py-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-[16px] text-ink tracking-[-0.005em] truncate">
              {state.label}
            </h3>
            {state.productName && (
              <p className="text-[11px] text-muted-2 font-mono tracking-wide uppercase mt-0.5">
                {state.productName}
              </p>
            )}
          </div>
          <SensitivityPill sensitivity={state.sensitivity} frequency={state.frequency} />
        </div>

        <div className="flex items-start gap-3 px-4 py-3 bg-warn-soft/40 border border-warn/30 rounded-md">
          <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" strokeWidth={2} />
          <div className="min-w-0">
            <p className="text-[13px] text-ink">
              Couldn&rsquo;t compute this metric.
              {state.consecutiveFailures > 1 && (
                <span className="text-muted-2"> &nbsp;{state.consecutiveFailures} consecutive failed attempts.</span>
              )}
            </p>
            <p className="text-[11px] text-muted-2 mt-1">
              {state.errorMessage
                ? <span className="font-mono break-words">{state.errorMessage}</span>
                : 'No error message captured.'}
              {state.lastErrorAt && (
                <span className="ml-2 text-muted-2/80">· last try {relDate(state.lastErrorAt)}</span>
              )}
            </p>
            <p className="text-[11px] text-muted-2 mt-2">
              The underlying product probably needs a refresh, or the KPI&rsquo;s formula references
              a table that&rsquo;s currently broken.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-line/70 text-[11px]">
          {state.productName && state.links.productId && onOpenProduct && (
            <button
              type="button"
              onClick={() => onOpenProduct(state.links.productId!)}
              className="inline-flex items-center gap-1 text-ocean hover:underline"
            >
              Open {state.productName}
              <ArrowRight className="w-3 h-3" strokeWidth={2} />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(state.id)}
              className="ml-auto text-muted-2 hover:text-ink"
            >
              Edit
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────────────

function SensitivityPill({
  sensitivity, frequency,
}: { sensitivity: 'low' | 'medium' | 'high'; frequency: 'daily' | 'weekly' }) {
  const label = sensitivity === 'high' ? 'Sensitive'
              : sensitivity === 'low' ? 'Quiet'
              : 'Normal';
  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className={cn(
        'inline-flex items-center px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider rounded border',
        sensitivity === 'high'
          ? 'border-rose-200 text-rose-700 bg-rose-50'
          : sensitivity === 'low'
            ? 'border-line text-muted-2 bg-softer'
            : 'border-line text-muted bg-softer',
      )}>
        {label}
      </span>
      <span className="inline-flex items-center px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider rounded border border-line text-muted-2 bg-softer">
        {frequency}
      </span>
    </div>
  );
}

function BriefBubble({ bullet }: { bullet: PulseTileBrief }) {
  const accent = bullet.tone === 'warn'
    ? 'border-warn/30 bg-warn-soft/30'
    : bullet.tone === 'positive'
      ? 'border-ok/30 bg-ok-soft/30'
      : 'border-line bg-softer/50';
  return (
    <div className={cn('px-3 py-2 border rounded-md', accent)}>
      <div className="flex items-start gap-2">
        <Activity className="w-3 h-3 mt-0.5 text-muted-2 shrink-0" strokeWidth={2} />
        <div className="min-w-0">
          <p className="text-[12.5px] text-ink leading-snug font-medium">{bullet.headline}</p>
          {bullet.context && (
            <p className="text-[11.5px] text-ink-2 leading-snug mt-0.5">{bullet.context}</p>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import type { WidgetExecutionProps } from '../types';
import { AnimatedNumber } from './AnimatedNumber';
import { Sparkline } from './Sparkline';
import { PALETTE } from '../utils/chart-theme';
import { formatValue } from '../utils/format';
import { WidgetSkeleton, WidgetError } from './WidgetSkeletons';

export function KpiCard({ spec, data, onDrillDetail, onContextMenu }: WidgetExecutionProps) {
  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;

  const row = data.rows[0] ?? {};
  const val = row.value;
  const numVal = typeof val === 'number' ? val : Number(val);
  const delta =
    row.delta !== undefined && row.delta !== null ? Number(row.delta) : null;
  const deltaLabel = row.delta_label ? String(row.delta_label) : 'vs prior period';
  const isPositive = delta !== null && delta > 0;
  const isNegative = delta !== null && delta < 0;

  // Parse trend sparkline data if present
  let trendData: number[] | null = null;
  if (row.trend) {
    try {
      const parsed =
        typeof row.trend === 'string' ? JSON.parse(row.trend) : row.trend;
      if (Array.isArray(parsed) && parsed.length > 1) {
        trendData = parsed.map(Number).filter((n) => !isNaN(n));
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Sparkline accent follows delta direction (neutral ocean when unknown)
  const accentColor = isPositive
    ? PALETTE.positive.solid
    : isNegative
      ? PALETTE.negative.solid
      : PALETTE.series[0].solid;

  // Right-click on the card surfaces the same drill / copy menu as
  // any chart. We use the KPI's headline value as the "clicked value"
  // so "Show source rows" reaches the underlying detail SQL.
  const headlineValue = !isNaN(numVal) ? String(numVal) : String(val ?? '');

  return (
    <div
      onContextMenu={onContextMenu ? (e) => {
        e.preventDefault();
        onContextMenu(e, headlineValue);
      } : undefined}
    >
      {/* Title */}
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">
        {spec.title}
      </p>

      {/* Big number — the hero element */}
      <div className="flex items-end gap-3">
        <div className="font-display text-[36px] leading-none font-medium text-ink tracking-[-0.02em] tabular-nums">
          {!isNaN(numVal) ? (
            <AnimatedNumber value={numVal} format={spec.format} />
          ) : (
            formatValue(val, spec.format)
          )}
        </div>

        {/* Sparkline next to the number */}
        {trendData && trendData.length > 1 && (
          <div className="mb-1.5 opacity-90">
            <Sparkline data={trendData} color={accentColor} width={80} height={28} />
          </div>
        )}
      </div>

      {/* Drill-to-detail link */}
      {onDrillDetail && spec.drillDownSql && (
        <button
          onClick={onDrillDetail}
          className="mt-2 text-[10px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors"
        >
          View detail →
        </button>
      )}

      {/* Delta + comparison label */}
      <div className="mt-3 flex items-center gap-2">
        {delta !== null ? (
          <>
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-mono tracking-[0.06em] uppercase px-2 py-0.5 rounded border ${
                isPositive
                  ? 'bg-ok-soft text-ok border-line'
                  : isNegative
                    ? 'bg-err-soft text-err border-line'
                    : 'bg-softer text-muted border-line'
              }`}
            >
              {isPositive ? (
                <TrendingUp className="w-3 h-3" strokeWidth={2.5} />
              ) : isNegative ? (
                <TrendingDown className="w-3 h-3" strokeWidth={2.5} />
              ) : (
                <span className="text-[10px]">—</span>
              )}
              {Math.abs(delta).toFixed(1)}%
            </span>
            <span className="text-[11px] text-muted">{deltaLabel}</span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: accentColor }}
            />
            Current period
          </span>
        )}
      </div>
    </div>
  );
}

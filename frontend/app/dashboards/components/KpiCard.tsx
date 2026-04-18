'use client';

import type { WidgetExecutionProps } from '../types';
import { AnimatedNumber } from './AnimatedNumber';
import { Sparkline } from './Sparkline';
import { PALETTE } from '../utils/chart-theme';
import { formatValue } from '../utils/format';
import { WidgetSkeleton, WidgetError } from './WidgetSkeletons';

export function KpiCard({ spec, data }: WidgetExecutionProps) {
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

  // Background tint class based on delta
  const tintClass = isPositive
    ? 'kpi-positive'
    : isNegative
      ? 'kpi-negative'
      : 'kpi-neutral';

  // Sparkline and accent color based on delta
  const accentColor = isPositive
    ? PALETTE.positive.solid
    : isNegative
      ? PALETTE.negative.solid
      : PALETTE.series[0].solid;

  return (
    <div className={`${tintClass} -m-5 p-5 relative overflow-hidden`}>
      {/* Decorative background circle */}
      <div
        className="absolute -right-6 -top-6 w-28 h-28 rounded-full opacity-[0.04]"
        style={{ background: accentColor }}
      />

      {/* Title */}
      <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-2 font-semibold">
        {spec.title}
      </p>

      {/* Big number — the hero element */}
      <div className="flex items-end gap-3">
        <div className="text-[2.25rem] leading-none font-extrabold text-slate-900 tracking-tight tabular-nums">
          {!isNaN(numVal) ? (
            <AnimatedNumber value={numVal} format={spec.format} />
          ) : (
            formatValue(val, spec.format)
          )}
        </div>

        {/* Sparkline next to the number */}
        {trendData && trendData.length > 1 && (
          <div className="mb-1.5 opacity-80">
            <Sparkline data={trendData} color={accentColor} width={80} height={28} />
          </div>
        )}
      </div>

      {/* Delta badge — prominent pill */}
      <div className="mt-3 flex items-center gap-2">
        {delta !== null ? (
          <>
            <span
              className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${
                isPositive
                  ? 'bg-emerald-500/15 text-emerald-700'
                  : isNegative
                    ? 'bg-red-500/15 text-red-600'
                    : 'bg-slate-200/60 text-slate-500'
              }`}
            >
              {isPositive ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M6 2l4 5H2l4-5z" />
                </svg>
              ) : isNegative ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M6 10L2 5h8l-4 5z" />
                </svg>
              ) : (
                <span className="text-[10px]">—</span>
              )}
              {Math.abs(delta).toFixed(1)}%
            </span>
            <span className="text-[11px] text-slate-400 font-medium">{deltaLabel}</span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: accentColor }}
              />
              Current period
            </span>
          </>
        )}
      </div>
    </div>
  );
}

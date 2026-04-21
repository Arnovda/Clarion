'use client';

import { shimmerClass } from '../utils/motion';

/** KPI-style skeleton: three shimmer lines */
export function WidgetSkeleton() {
  return (
    <div className="space-y-3">
      <div className={`${shimmerClass} h-3 w-1/3`} />
      <div className={`${shimmerClass} h-10 w-2/3`} />
      <div className={`${shimmerClass} h-3 w-1/2`} />
    </div>
  );
}

/** Chart-style skeleton: animated shimmer bars that resemble a bar chart */
export function ChartSkeleton({ height = 200 }: { height?: number }) {
  const bars = [65, 40, 80, 55, 90, 35, 70, 50];
  return (
    <div className="flex items-end gap-2 px-2" style={{ height }}>
      {bars.map((h, i) => (
        <div
          key={i}
          className={`flex-1 ${shimmerClass} rounded-t-md`}
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

/** Error display for a widget */
export function WidgetError({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 py-4 px-2">
      <svg className="w-4 h-4 text-err shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-[12px] text-err">{msg}</p>
    </div>
  );
}

/** Empty state when a widget has no data */
export function EmptyWidget() {
  return (
    <div className="flex flex-col items-center justify-center py-8 gap-2">
      <svg className="w-6 h-6 text-muted-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
      </svg>
      <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2">No data available</p>
    </div>
  );
}

'use client';

import { formatValue } from '../utils/format';
import { PALETTE } from '../utils/chart-theme';

interface PremiumTooltipProps {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; dataKey?: string }[];
  label?: string;
  format?: string;
}

export function PremiumTooltip({ active, payload, label, format }: PremiumTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className="bg-raised border border-line rounded-md shadow-2 px-3 py-2.5 text-[12px]">
      {label && (
        <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-1.5">
          {label}
        </p>
      )}
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: p.color ?? PALETTE.series[0].solid }}
            />
            <span className="text-ink-3">
              {p.name ?? p.dataKey ?? ''}
            </span>
            <span className="ml-auto font-medium text-ink tabular-nums">
              {formatValue(p.value, format)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

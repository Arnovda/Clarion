'use client';

import { formatValue } from '../utils/format';

interface PremiumTooltipProps {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; dataKey?: string }[];
  label?: string;
  format?: string;
}

export function PremiumTooltip({ active, payload, label, format }: PremiumTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div
      className="bg-white/95 backdrop-blur-xl rounded-xl
        shadow-2xl border border-white/60
        px-4 py-3 text-xs
        animate-in fade-in duration-150"
    >
      {label && (
        <p className="font-semibold text-slate-700 mb-2 text-[13px]">
          {label}
        </p>
      )}
      <div className="space-y-1.5">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: p.color ?? '#6366F1' }}
            />
            <span className="text-slate-500">
              {p.name ?? p.dataKey ?? ''}
            </span>
            <span className="ml-auto font-semibold text-slate-800 tabular-nums">
              {formatValue(p.value, format)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

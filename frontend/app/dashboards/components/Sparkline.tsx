'use client';

import { PALETTE } from '../utils/chart-theme';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fillColor?: string;
  showDot?: boolean;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  color = PALETTE.series[0].solid,
  fillColor,
  showDot = true,
}: SparklineProps) {
  if (!data.length) return null;

  const fill = fillColor ?? color;
  const gradientId = `spark-fill-${color.replace('#', '')}`;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const padX = 4;
  const padY = 4;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  // Map data to points
  const points = data.map((v, i) => ({
    x: padX + (i / Math.max(data.length - 1, 1)) * plotW,
    y: padY + plotH - ((v - min) / range) * plotH,
  }));

  // Build smooth path using quadratic bezier curves
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    d += ` Q ${cpx} ${prev.y}, ${(cpx + curr.x) / 2} ${(prev.y + curr.y) / 2}`;
    if (i === points.length - 1) {
      d += ` T ${curr.x} ${curr.y}`;
    }
  }

  // Area path: close at bottom
  const areaD =
    d +
    ` L ${points[points.length - 1].x} ${height - padY}` +
    ` L ${points[0].x} ${height - padY} Z`;

  const last = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity={0.25} />
          <stop offset="100%" stopColor={fill} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Gradient fill area */}
      <path d={areaD} fill={`url(#${gradientId})`} />

      {/* Line */}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Last-point dot */}
      {showDot && last && (
        <>
          <circle cx={last.x} cy={last.y} r={3} fill={color} />
          <circle cx={last.x} cy={last.y} r={5} fill={color} opacity={0.2} />
        </>
      )}
    </svg>
  );
}

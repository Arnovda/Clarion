'use client';

/**
 * The one sparkline on Home, shared by the movement cards and the board.
 *
 * Deliberately NOT `app/dashboards/components/Sparkline` — that one takes a
 * bare `number[]` and is themed from the dashboards chart palette, while a
 * pulse series is `{date, value|null}` with real gaps in it (a snapshot that
 * failed, a weekend on a weekday metric). Rendering a gap as zero would
 * invent a drop that never happened, so this one breaks the line instead.
 *
 * Single series, so no legend and no categorical palette: the colour carries
 * direction only, and every caller pairs it with an arrow glyph and a worded
 * delta, so meaning is never colour-alone.
 */

import { OBSERVATORY } from '@/lib/observatory';

export interface SparkPoint {
  date: string;
  value: number | null;
}

export function Sparkline({
  points, width = 92, height = 30, tone = 'neutral', ariaLabel,
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
  tone?: 'neutral' | 'up' | 'down';
  ariaLabel: string;
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  // One point cannot show a shape, and zero points cannot show anything.
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padY = 4;
  const plotH = height - padY * 2;
  const stepX = points.length > 1 ? (width - 4) / (points.length - 1) : 0;

  const stroke =
    tone === 'up' ? OBSERVATORY.err
    : tone === 'down' ? OBSERVATORY.err
    : OBSERVATORY.ocean;

  // Build one path per unbroken run, so a missing reading leaves a gap
  // rather than a straight line through data we do not have.
  const runs: string[] = [];
  let current: string[] = [];
  let lastPt: { x: number; y: number } | null = null;
  points.forEach((p, i) => {
    if (p.value == null || !Number.isFinite(p.value)) {
      if (current.length > 1) runs.push(current.join(' '));
      current = [];
      return;
    }
    const x = 2 + i * stepX;
    const y = padY + plotH - ((p.value - min) / range) * plotH;
    current.push(`${current.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    lastPt = { x, y };
  });
  if (current.length > 1) runs.push(current.join(' '));
  if (runs.length === 0) return null;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      {runs.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {lastPt && <circle cx={(lastPt as { x: number; y: number }).x} cy={(lastPt as { x: number; y: number }).y} r={2.4} fill={stroke} />}
    </svg>
  );
}

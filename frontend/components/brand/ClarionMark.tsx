'use client';

/**
 * The Clarion mark — the brand, and the AI assistant showing what it is doing.
 *
 * One geometry (lib/clarionMark.ts), five states. A state is ALWAYS carried by
 * colour AND motion, never colour alone, so it survives 16px, dark mode and
 * colour-blind readers:
 *   idle        at rest, no motion at all
 *   working     outer ring rotates, blue→violet gradient
 *   checking    ring pulses outward, light blue — "double-checking", calm
 *   done        centre settles in violet, then static
 *   uncertain   amber creeps along ring-a from the amber satellite — "take with care"
 *
 * Rules held here so no call site can break them:
 * - below 20px the separate small construction is drawn, never a scaled master;
 * - glow only at 32px and up;
 * - leaving `working` decelerates from the CURRENT angle back to upright —
 *   the mark never jumps orientation;
 * - prefers-reduced-motion: no rotation, pulse, settle or arc animation —
 *   state changes are a colour crossfade only (CSS in globals.css + the check
 *   below for the rotation, which runs through the Web Animations API).
 *
 * Use the mark only where the ASSISTANT is the actor (it answers, works,
 * checks, doubts) or where Clarion itself is named. Small "drafted by AI"
 * labels under 16px keep a text badge: the mark is not permitted below 16px.
 */

import { useEffect, useId, useRef } from 'react';
import { markGeometry, variantForSize } from '@/lib/clarionMark';

export type ClarionMarkState = 'idle' | 'working' | 'checking' | 'done' | 'uncertain';

/** The mark's own colours. Deliberately literal: they are the mark, not UI tokens. */
const PALETTE = {
  light: {
    base: '#0F2A44',
    violet: '#7C3AED',
    cyan: '#38BDF8',
    blue: '#3B82F6',
    checkLight: '#7DD3FC',
    amber: '#D97706',
  },
  dark: {
    base: '#F1F5F9',
    violet: '#A78BFA',
    cyan: '#38BDF8',
    blue: '#60A5FA',
    checkLight: '#7DD3FC',
    amber: '#F59E0B',
  },
} as const;

interface Props {
  /** Rendered size in CSS px (square). Minimum 16. */
  size?: number;
  state?: ClarionMarkState;
  /**
   * `brand` = the mark's colours. `mono` = everything in currentColor (motion
   * still carries the state) — for navigation icons and quiet empty states.
   */
  tone?: 'brand' | 'mono';
  /** Draw for a dark background. */
  onDark?: boolean;
  /** Accessible name; omitted = decorative (aria-hidden). */
  title?: string;
  className?: string;
}

export function ClarionMark({
  size = 20,
  state = 'idle',
  tone = 'brand',
  onDark = false,
  title,
  className,
}: Props) {
  const px = Math.max(16, size);
  const g = markGeometry(variantForSize(px));
  const p = onDark ? PALETTE.dark : PALETTE.light;
  const mono = tone === 'mono';
  const gradId = `cm-grad-${useId().replace(/:/g, '')}`;
  const rotRef = useRef<SVGGElement>(null);

  // Rotation (working) runs through the Web Animations API so that leaving
  // `working` can decelerate from wherever the ring happens to be.
  useEffect(() => {
    if (state !== 'working') return;
    const el = rotRef.current;
    if (!el || typeof el.animate !== 'function') return;
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    // Accelerate over 400ms (ease-in covers ~40°), then turn at 1800ms/rev.
    const ramp = el.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(40deg)' }],
      { duration: 400, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    let spin: Animation | null = null;
    ramp.onfinish = () => {
      spin = el.animate(
        [{ transform: 'rotate(40deg)' }, { transform: 'rotate(400deg)' }],
        { duration: 1800, iterations: Infinity, easing: 'linear' },
      );
    };

    return () => {
      const angle = currentAngle(el);
      ramp.onfinish = null;
      ramp.cancel();
      spin?.cancel();
      // Settle to upright from the current angle — never a jump.
      el.animate(
        [{ transform: `rotate(${angle}deg)` }, { transform: 'rotate(360deg)' }],
        { duration: 300, easing: 'cubic-bezier(0, 0, 0.2, 1)' },
      );
    };
  }, [state]);

  const colour = (brand: string) => (mono ? 'currentColor' : brand);
  const outerStroke =
    state === 'working' && !mono ? `url(#${gradId})` : undefined;

  const segColour = (id: string): string => {
    if (mono) return 'currentColor';
    if (state === 'checking') return id === 'ring-b' ? p.checkLight : p.cyan;
    return p.base;
  };
  const satColour = mono
    ? 'currentColor'
    : state === 'checking'
      ? p.checkLight
      : state === 'uncertain'
        ? p.amber
        : p.violet;
  const centreColour = colour(state === 'done' ? p.violet : p.base);

  // Glow is for large renders only: below 32px it blurs into a smudge.
  const glow = px >= 32 && !mono
    ? state === 'working'
      ? `drop-shadow(0 0 5px ${hexA(p.violet, 0.14)})`
      : state === 'checking'
        ? `drop-shadow(0 0 4px ${hexA(p.cyan, 0.10)})`
        : undefined
    : undefined;

  const ringA = g.segments[0];

  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${g.view} ${g.view}`}
      fill="none"
      className={['clarion-mark', `cm-${state}`, px >= 32 ? 'cm-large' : '', className ?? ''].join(' ').trim()}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ overflow: 'visible' }}
    >
      {title && <title>{title}</title>}
      {state === 'working' && !mono && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2={g.view} y2={g.view} gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={p.cyan} />
            <stop offset="48%" stopColor={p.blue} />
            <stop offset="100%" stopColor={p.violet} />
          </linearGradient>
        </defs>
      )}

      {/* outer-assembly: the only part that rotates (working) or pulses (checking) */}
      <g ref={rotRef} className="cm-rotate" style={{ filter: glow }}>
        <g className="cm-outer">
          {g.segments.map((s) => (
            <path
              key={s.id}
              className={`cm-part ${s.id}`}
              d={s.d}
              stroke={outerStroke ?? segColour(s.id)}
              strokeWidth={g.stroke}
              strokeLinecap="round"
            />
          ))}
          {state === 'uncertain' && !mono && (
            // The amber emphasis grows from the satellite end of ring-a.
            <path
              className="cm-part cm-amber"
              d={ringA.d}
              pathLength={ringA.span}
              stroke={p.amber}
              strokeWidth={g.stroke}
              strokeLinecap="round"
            />
          )}
          <circle
            className="cm-part satellite"
            cx={g.sat.cx}
            cy={g.sat.cy}
            r={g.satR}
            fill={outerStroke ?? satColour}
          />
        </g>
      </g>

      <circle className="cm-part centre" cx={g.c} cy={g.c} r={g.centreR} fill={centreColour} />
    </svg>
  );
}

/** The element's current rotation in degrees, 0–360. */
function currentAngle(el: Element): number {
  const t = getComputedStyle(el).transform;
  const m = /matrix\(([^,]+),\s*([^,]+)/.exec(t);
  if (!m) return 0;
  const deg = (Math.atan2(parseFloat(m[2]), parseFloat(m[1])) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The lockup: mark + wordmark in Cormorant Garamond 600. The wordmark's
 * size follows the mark (spec: gap 0.28H, the serif sized so its caps sit
 * at about two thirds of the mark's height).
 */
export function ClarionLockup({
  size = 24,
  onDark = false,
  className,
}: {
  size?: number;
  onDark?: boolean;
  className?: string;
}) {
  return (
    <span
      className={['inline-flex items-center', className ?? ''].join(' ').trim()}
      style={{ gap: Math.round(size * 0.28) }}
    >
      <ClarionMark size={size} onDark={onDark} />
      <span
        className="font-brand font-semibold leading-none"
        style={{
          fontSize: Math.round(size * 1.05),
          letterSpacing: '-0.025em',
          color: onDark ? PALETTE.dark.base : PALETTE.light.base,
          // Optical correction: the serif's box sits high against the mark.
          transform: `translateY(${(size * 0.02).toFixed(2)}px)`,
        }}
      >
        Clarion
      </span>
    </span>
  );
}

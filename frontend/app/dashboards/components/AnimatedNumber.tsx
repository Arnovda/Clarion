'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { animate, useMotionValue, useReducedMotion, useTransform, motion } from 'framer-motion';
import { formatValue } from '../utils/format';
import { NUMBER_ROLL_SECONDS } from '../utils/motion';

/** useLayoutEffect that doesn't warn during Next's server prerender. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface AnimatedNumberProps {
  value: number;
  format?: 'currency' | 'number' | 'percentage';
  className?: string;
  /** Seconds the roll takes. Defaults to NUMBER_ROLL_SECONDS. */
  duration?: number;
}

/**
 * A KPI number that rolls to its value.
 *
 * Driven by a fixed-duration tween, not a spring. The spring this replaced was
 * OVERDAMPED (stiffness 100 against damping 30 — a damping ratio of 1.5), and
 * an overdamped spring never really arrives: it closes the remaining distance
 * asymptotically, so the roll looked finished while the last digits were still
 * ticking over for seconds afterwards. `duration` is now the actual elapsed
 * time, and it is honoured — it used to be accepted and thrown away, which is
 * why turning the speed down had no effect.
 */
export function AnimatedNumber({
  value,
  format,
  className = '',
  duration = NUMBER_ROLL_SECONDS,
}: AnimatedNumberProps) {
  const motionVal = useMotionValue(0);
  const display = useTransform(motionVal, (v) => formatValue(v, format));
  const ref = useRef<HTMLSpanElement>(null);
  const prevValue = useRef(0);
  const reduceMotion = useReducedMotion();

  // Layout effect, not effect: React has just re-rendered this span's children
  // to the NEW number, so without writing the old one back before the browser
  // paints, every change flashes the final value for a frame and then jumps
  // back to roll up to it. Doing this after paint would BE the flash.
  useIsoLayoutEffect(() => {
    const from = prevValue.current;
    prevValue.current = value;
    const paint = (v: number) => {
      if (ref.current) ref.current.textContent = formatValue(v, format);
    };

    // Someone who asked their OS for less motion gets the number, not a show.
    if (reduceMotion || from === value) {
      motionVal.set(value);
      paint(value);
      return;
    }

    motionVal.set(from);
    paint(from);
    const controls = animate(motionVal, value, {
      // easeOut: most of the distance is covered early, so the number reads as
      // "it moved, and here is where it landed" rather than a slow reveal.
      duration,
      ease: [0.22, 1, 0.36, 1],
    });
    return () => controls.stop();
  }, [value, format, motionVal, duration, reduceMotion]);

  // Write the formatted string straight to the DOM — re-rendering React on
  // every animation frame to paint one text node would be the expensive way.
  useEffect(() => {
    const unsub = display.on('change', (v) => {
      if (ref.current) ref.current.textContent = v;
    });
    return unsub;
  }, [display]);

  return (
    <motion.span ref={ref} className={`tabular-nums ${className}`}>
      {formatValue(value, format)}
    </motion.span>
  );
}

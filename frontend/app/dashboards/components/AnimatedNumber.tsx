'use client';

import { useEffect, useRef } from 'react';
import { useMotionValue, useSpring, useTransform, motion } from 'framer-motion';
import { formatValue } from '../utils/format';

interface AnimatedNumberProps {
  value: number;
  format?: 'currency' | 'number' | 'percentage';
  className?: string;
  duration?: number;
}

export function AnimatedNumber({
  value,
  format,
  className = '',
  duration: _duration,
}: AnimatedNumberProps) {
  const motionVal = useMotionValue(0);
  const spring = useSpring(motionVal, { stiffness: 100, damping: 30 });
  const display = useTransform(spring, (v) => formatValue(v, format));
  const ref = useRef<HTMLSpanElement>(null);
  const prevValue = useRef(0);

  useEffect(() => {
    motionVal.set(prevValue.current);
    // Small delay to ensure we animate from current to new
    const raf = requestAnimationFrame(() => {
      motionVal.set(value);
    });
    prevValue.current = value;
    return () => cancelAnimationFrame(raf);
  }, [value, motionVal]);

  // Subscribe to the transformed display string and update the DOM directly
  useEffect(() => {
    const unsub = display.on('change', (v) => {
      if (ref.current) ref.current.textContent = v;
    });
    return unsub;
  }, [display]);

  return (
    <motion.span
      ref={ref}
      className={`tabular-nums ${className}`}
    >
      {formatValue(value, format)}
    </motion.span>
  );
}

// ─── motion.ts ───────────────────────────────────────────────────────────────
// Framer Motion animation presets for the Clarion premium dashboard.
// Import these variants and springs instead of defining them inline.

import { Variants } from 'framer-motion';

// ─── Widget Grid Entrance ─────────────────────────────────────────────────────

/**
 * Parent container variant — staggers children on mount.
 * Apply to the grid wrapper element.
 */
export const containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.06, delayChildren: 0.1 },
  },
};

/**
 * Individual widget card entrance.
 * Apply to each widget card element.
 */
export const widgetVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  },
};

// ─── KPI Number Spring ────────────────────────────────────────────────────────

/**
 * Spring config for animating KPI number count-up with framer-motion's
 * useSpring / motion.div. Feels weighty and authoritative.
 */
export const numberSpring = {
  type: 'spring' as const,
  stiffness: 80,
  damping: 20,
};

// ─── Page-Level Fade ──────────────────────────────────────────────────────────

/**
 * Page-level fade for AnimatePresence wrapping route transitions.
 */
export const pageFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.3 } },
  exit:    { opacity: 0, transition: { duration: 0.2 } },
};

// ─── Slide Up ─────────────────────────────────────────────────────────────────

/**
 * Slide up from below — for panels, drawers, and modals.
 */
export const slideUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
  },
  exit: {
    opacity: 0,
    y: 8,
    transition: { duration: 0.2 },
  },
};

// ─── Fade In ──────────────────────────────────────────────────────────────────

/**
 * Simple fade-in, no translate — for overlays and tooltips.
 */
export const fadeIn: Variants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.25 } },
  exit:    { opacity: 0, transition: { duration: 0.15 } },
};

// ─── Skeleton / Shimmer ───────────────────────────────────────────────────────

/**
 * Tailwind class string for shimmer skeleton loading states.
 * Uses the @keyframes shimmerSlide defined in globals.css.
 *
 * Usage:
 *   <div className={shimmerClass + ' h-4 w-24 rounded'} />
 */
export const shimmerClass =
  'shimmer rounded';

/**
 * Pulse variant for skeleton placeholders (alternative to CSS shimmer).
 */
export const skeletonPulse: Variants = {
  initial: { opacity: 0.5 },
  animate: {
    opacity: [0.5, 0.8, 0.5],
    transition: { duration: 1.5, repeat: Infinity, ease: 'easeInOut' },
  },
};

/**
 * Observatory design tokens — TypeScript mirror of the CSS variables
 * defined in app/globals.css.
 *
 * Use this in JS-only places (SVG inline styles, canvas, recharts, reactflow
 * nodes) so we have a single source of truth. Tailwind utility classes
 * (`bg-raised`, `text-ocean`, etc.) remain the preferred way for normal HTML.
 *
 * Keep in sync with globals.css :root { ... } block.
 */

export const OBSERVATORY = {
  // Surfaces
  bg:           '#eef0f2',
  surface:      '#f8f9fa',
  raised:       '#ffffff',
  soft:         '#e3e6ea',
  softer:       '#edeff2',
  line:         '#d0d5da',
  lineStrong:   '#b8bec5',

  // Ink
  ink:    '#0f1a22',
  ink2:   '#334049',
  ink3:   '#4a5660',
  muted:  '#6b7680',
  muted2: '#8891a0',

  // Ocean — primary accent
  ocean:        '#164e63',
  oceanHover:   '#103d4f',
  oceanSoft:    '#d0e1e6',
  oceanSofter:  '#e8f0f3',

  // AI accent (warm amber-tan)
  ai:     '#c08a5e',
  aiSoft: '#f1e4d6',

  // Semantic
  ok:       '#3f7a5c',
  okSoft:   '#dbe8e0',
  warn:     '#a06a1c',
  warnSoft: '#f1e4c8',
  err:      '#a43a3a',
  errSoft:  '#f1d7d7',

  // Chart series (also --c1..--c6)
  c1: '#164e63', // ocean
  c2: '#3f7a5c', // ok
  c3: '#a06a1c', // warn
  c4: '#6b4e8c', // plum
  c5: '#8c5a3c', // terracotta
  c6: '#2d6e78', // teal

  // Additional palette tones used by diagrams
  plum: '#6b4e8c',
} as const;

/** Ordered chart series palette (matches Recharts usage). */
export const SERIES = [
  OBSERVATORY.c1,
  OBSERVATORY.c2,
  OBSERVATORY.c3,
  OBSERVATORY.c4,
  OBSERVATORY.c5,
  OBSERVATORY.c6,
];

export type ObservatoryToken = keyof typeof OBSERVATORY;

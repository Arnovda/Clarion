# Tokens and configuration — drop-in

## 1. `app/globals.css` (paste at the top, above `@tailwind` directives)

```css
@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400;1,8..60,500&family=Inter:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');

:root {
  /* Surfaces */
  --bg: #eef0f2;
  --surface: #f8f9fa;
  --surface-raised: #ffffff;
  --soft: #e3e6ea;
  --softer: #edeff2;
  --line: #d0d5da;
  --line-strong: #b8bec5;

  /* Ink */
  --ink: #0f1a22;
  --ink-2: #334049;
  --ink-3: #4a5660;
  --muted: #6b7680;
  --muted-2: #8891a0;

  /* Accent */
  --ocean: #164e63;
  --ocean-hover: #103d4f;
  --ocean-soft: #d0e1e6;
  --ocean-softer: #e8f0f3;

  /* AI */
  --ai: #c08a5e;
  --ai-soft: #f1e4d6;

  /* State */
  --ok: #3f7a5c;  --ok-soft: #dbe8e0;
  --warn: #a06a1c; --warn-soft: #f1e4c8;
  --err: #a43a3a;  --err-soft: #f1d7d7;

  /* Chart */
  --c1: #164e63; --c2: #3f7a5c; --c3: #a06a1c;
  --c4: #6b4e8c; --c5: #8c5a3c; --c6: #2d6e78;

  /* Radii */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;

  /* Elevation */
  --shadow-1: 0 1px 2px rgba(15,26,34,0.04);
  --shadow-2: 0 1px 2px rgba(15,26,34,0.04), 0 4px 12px -4px rgba(15,26,34,0.06);
  --shadow-3: 0 1px 2px rgba(15,26,34,0.04), 0 12px 40px -12px rgba(15,26,34,0.12);

  /* Motion */
  --dur-1: 120ms;
  --dur-2: 240ms;
  --dur-3: 420ms;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);

  /* Fonts */
  --font-display: "Source Serif 4", Georgia, serif;
  --font-sans: Inter, system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, monospace;
}

html, body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-sans);
  font-feature-settings: "ss01", "cv11";
  -webkit-font-smoothing: antialiased;
  line-height: 1.55;
}

/* Focus ring — apply via Tailwind `focus-visible:ring-ocean-soft` or this utility */
.focus-ring:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ocean-soft);
  border-color: var(--ocean);
}
```

## 2. `tailwind.config.ts` (merge into `theme.extend`)

```ts
colors: {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  raised: 'var(--surface-raised)',
  soft: 'var(--soft)',
  softer: 'var(--softer)',
  line: 'var(--line)',
  'line-strong': 'var(--line-strong)',
  ink: {
    DEFAULT: 'var(--ink)',
    2: 'var(--ink-2)',
    3: 'var(--ink-3)',
  },
  muted: {
    DEFAULT: 'var(--muted)',
    2: 'var(--muted-2)',
  },
  ocean: {
    DEFAULT: 'var(--ocean)',
    hover: 'var(--ocean-hover)',
    soft: 'var(--ocean-soft)',
    softer: 'var(--ocean-softer)',
  },
  ai: {
    DEFAULT: 'var(--ai)',
    soft: 'var(--ai-soft)',
  },
  ok:   { DEFAULT: 'var(--ok)',   soft: 'var(--ok-soft)' },
  warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
  err:  { DEFAULT: 'var(--err)',  soft: 'var(--err-soft)' },
  chart: {
    1: 'var(--c1)', 2: 'var(--c2)', 3: 'var(--c3)',
    4: 'var(--c4)', 5: 'var(--c5)', 6: 'var(--c6)',
  },
},
borderRadius: {
  xs: 'var(--radius-xs)',
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  xl: 'var(--radius-xl)',
},
boxShadow: {
  1: 'var(--shadow-1)',
  2: 'var(--shadow-2)',
  3: 'var(--shadow-3)',
},
fontFamily: {
  display: ['var(--font-display)'],
  sans:    ['var(--font-sans)'],
  mono:    ['var(--font-mono)'],
},
transitionTimingFunction: {
  observatory: 'var(--ease)',
},
transitionDuration: {
  1: '120ms',
  2: '240ms',
  3: '420ms',
},
```

## 3. Type scale (use these Tailwind classes consistently)

| Role | Classes |
|---|---|
| Page hero serif | `font-display font-medium text-[52px] leading-[1.05] tracking-[-0.03em]` |
| H1 | `font-display font-medium text-[38px] leading-[1.1] tracking-[-0.025em]` |
| H2 | `font-display font-medium text-[28px] leading-[1.15] tracking-[-0.02em]` |
| H3 | `font-display font-medium text-[20px] leading-[1.25] tracking-[-0.01em]` |
| Body default | `text-[14.5px] leading-[1.55] text-ink-2` |
| Body serif (reports, AI) | `font-display text-[17px] leading-[1.55] text-ink` |
| Mono eyebrow | `font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted` |
| KPI number | `font-display font-medium text-[44px] leading-none tracking-[-0.02em] tabular-nums` |

## 4. Fonts via `next/font` (preferred, avoid FOUT)

If you're not on Google Fonts `@import`, wire via `app/layout.tsx`:

```ts
import { Inter, Source_Serif_4, Geist_Mono } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], weight: ['400','500','600','700'], variable: '--font-sans-override' });
const serif = Source_Serif_4({ subsets: ['latin'], weight: ['400','500','600'], style: ['normal','italic'], variable: '--font-display-override' });
const mono = Geist_Mono({ subsets: ['latin'], weight: ['400','500'], variable: '--font-mono-override' });

// apply `${inter.variable} ${serif.variable} ${mono.variable}` to <body>
// then in globals.css override:
//   --font-sans: var(--font-sans-override), Inter, system-ui, sans-serif;
```

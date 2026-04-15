import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      /* ── Nexus Cobalt palette with warm accents ───────────────── */
      colors: {
        // Surface hierarchy (tonal architecture — no borders, use color shifts)
        surface:                    '#f8f9ff',
        'surface-bright':           '#f8f9ff',
        'surface-dim':              '#ccdbf4',
        'surface-container-lowest': '#ffffff',
        'surface-container-low':    '#eff4ff',
        'surface-container':        '#e6eeff',
        'surface-container-high':   '#dde9ff',
        'surface-container-highest':'#d5e3fd',
        'surface-variant':          '#d5e3fd',

        // Primary — deep navy
        primary:                    '#003358',
        'primary-container':        '#004a7c',
        'on-primary':               '#ffffff',
        'on-primary-container':     '#87baf3',

        // Secondary — teal (used for AI elements)
        secondary:                  '#006781',
        'secondary-container':      '#8fdfff',
        'on-secondary':             '#ffffff',
        'on-secondary-container':   '#00647d',

        // Tertiary — purple (used for AI chat accents)
        tertiary:                   '#1d00a7',
        'tertiary-container':       '#3424cc',
        'on-tertiary':              '#ffffff',
        'on-tertiary-container':    '#b0aeff',

        // Text
        'on-surface':               '#0d1c2f',
        'on-surface-variant':       '#42474f',
        'on-background':            '#0d1c2f',

        // Outlines
        outline:                    '#727780',
        'outline-variant':          '#c1c7d0',

        // Error
        error:                      '#ba1a1a',
        'error-container':          '#ffdad6',
        'on-error':                 '#ffffff',
        'on-error-container':       '#93000a',

        // Inverse (for dark surfaces)
        'inverse-surface':          '#233144',
        'inverse-on-surface':       '#ebf1ff',
        'inverse-primary':          '#9ccaff',

        // Warm accents
        amber:    { 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706' },
        gold:     { 400: '#fbbf24', 500: '#eab308', 600: '#ca8a04' },
        teal:     { 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488' },
        cyan:     { 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2' },

        // Legacy compat (old pages still use these)
        background: '#f8f9ff',
        foreground: '#0d1c2f',
      },

      fontFamily: {
        headline: ['var(--font-manrope)', 'system-ui', 'sans-serif'],
        body:     ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono:     ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },

      fontSize: {
        'display-lg': ['3.5rem',   { lineHeight: '1.1', letterSpacing: '-0.02em' }],
        'display-md': ['2.75rem',  { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        'headline-lg': ['2rem',    { lineHeight: '1.25', letterSpacing: '-0.01em' }],
        'headline-md': ['1.5rem',  { lineHeight: '1.3' }],
        'headline-sm': ['1.25rem', { lineHeight: '1.35' }],
        'title-lg':    ['1.125rem',{ lineHeight: '1.4', fontWeight: '600' }],
        'title-md':    ['1rem',    { lineHeight: '1.5', fontWeight: '600' }],
        'body-lg':     ['1rem',    { lineHeight: '1.6' }],
        'body-md':     ['0.875rem',{ lineHeight: '1.6' }],
        'body-sm':     ['0.8125rem',{ lineHeight: '1.5' }],
        'label-lg':    ['0.875rem',{ lineHeight: '1.4', fontWeight: '500' }],
        'label-md':    ['0.75rem', { lineHeight: '1.4', fontWeight: '500' }],
        'label-sm':    ['0.6875rem',{ lineHeight: '1.3', fontWeight: '500' }],
      },

      borderRadius: {
        'xs':   '0.125rem',
        'sm':   '0.25rem',
        'md':   '0.375rem',
        'lg':   '0.5rem',
        'xl':   '0.75rem',
        '2xl':  '1rem',
        '3xl':  '1.5rem',
        'pill': '9999px',
      },

      boxShadow: {
        'ambient':  '0px 12px 32px rgba(13, 28, 47, 0.06)',
        'ambient-lg': '0px 16px 48px rgba(13, 28, 47, 0.08)',
        'glow-teal': '0 0 16px rgba(6, 183, 212, 0.15)',
        'glow-teal-md': '0 0 24px rgba(6, 183, 212, 0.25)',
        'glow-primary': '0 0 16px rgba(0, 51, 88, 0.1)',
        'glow-green': '0 0 12px rgba(16, 185, 129, 0.35)',
        'glow-amber': '0 0 12px rgba(245, 158, 11, 0.35)',
        'glow-red': '0 0 12px rgba(239, 68, 68, 0.35)',
        'inner-glow': 'inset 0 1px 2px rgba(255,255,255,0.08)',
        'card-glass': '0 8px 32px rgba(0, 51, 88, 0.08), inset 0 1px 0 rgba(255,255,255,0.6)',
      },

      animation: {
        'fadeIn':      'fadeIn 0.4s ease-out',
        'slideIn':     'slideIn 0.3s ease-out',
        'slideUp':     'slideUp 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
        'shimmer':     'shimmer 2s ease-in-out infinite',
        'pulse-teal':  'pulseTeal 2s ease-in-out infinite',
        'pulse-green': 'pulseGreen 2s ease-in-out infinite',
        'pulse-amber': 'pulseAmber 2.5s ease-in-out infinite',
        'spin-slow':   'spin 2s linear infinite',
        'gradient':    'gradientShift 6s ease infinite',
        'float':       'float 3s ease-in-out infinite',
      },

      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%, 100%': { opacity: '0.5' },
          '50%':      { opacity: '1' },
        },
        pulseTeal: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(6, 183, 212, 0.3)' },
          '50%':      { boxShadow: '0 0 0 8px rgba(6, 183, 212, 0)' },
        },
        pulseGreen: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(16, 185, 129, 0.4)' },
          '50%':      { boxShadow: '0 0 0 6px rgba(16, 185, 129, 0)' },
        },
        pulseAmber: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(245, 158, 11, 0.4)' },
          '50%':      { boxShadow: '0 0 0 6px rgba(245, 158, 11, 0)' },
        },
        gradientShift: {
          '0%':   { backgroundPosition: '0% 50%' },
          '50%':  { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%':      { transform: 'translateY(-4px)' },
        },
      },

      spacing: {
        'rail':    '200px',
        'context': '240px',
      },
    },
  },
  plugins: [],
};
export default config;

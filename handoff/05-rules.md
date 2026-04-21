# Hard rules

These are non-negotiable. If a rule conflicts with a pattern you see elsewhere, the rule wins.

## Do

- **Serif for display, Inter for UI, Geist Mono for data/eyebrows.** Nothing else.
- **Numbers are always `font-mono tabular-nums`**, right-aligned in tables.
- **Italic serif is the voice of the product** — hero headlines, AI responses, pull quotes. Use it sparingly and deliberately.
- **Mono is a label, never a body.** Eyebrows, timestamps, metadata, code, numbers.
- **Borders beat shadows.** Reach for `border-line` first; shadows are accents, not structure.
- **Radii stay small.** `rounded-sm` (6) for controls, `rounded-md` (10) for cards, `rounded-lg` (14) for hero surfaces. Never `rounded-xl` or higher outside tokens.
- **Focus rings are ocean**, never the default blue.
- **Empty states get a serif headline and one CTA.** Always.
- **Animations are short.** `duration-1` (120ms) is the default. `duration-3` (420ms) only for page transitions.
- **AI content wears its provenance.** Any AI-generated result shows the `ai` badge and a source count.

## Don't

- **No emoji** in the product UI. If iconography is needed, use lucide-react at 16/20px, `stroke-width={1.5}`, `text-ink-3` or `text-muted`.
- **No gradients** on surfaces, buttons, or text. The observatory glow in login art is the only exception.
- **No new colors.** If a color isn't in tokens, it doesn't exist. Ask before adding.
- **No emojis, drop shadows on type, glassmorphism, or neumorphism.**
- **No rounded cards with a left accent border** as a "callout" pattern. We use eyebrow + serif instead.
- **No centered numeric columns.**
- **No uppercase body copy.** Uppercase is reserved for mono eyebrows.
- **No sentence-case mono.** Mono is always `uppercase tracking-[0.08em]`.
- **No illustration or stock art.** Typography and data are the art.
- **Don't invent components.** If a pattern isn't in `03-component-specs.md`, ask.
- **Don't refactor business logic.** This restyle is presentation-only.
- **Don't add libraries** (charting, UI, animation) without asking. Recharts, Radix, Headless UI, lucide-react are pre-approved only if already installed.
- **Don't touch routing, data fetching, auth, or state management.**

## When in doubt

- Match the reference mock. If the reference mock is silent, ask.
- Prefer less. Density over decoration. A blank space is cheaper than a wrong element.
- Serif italic is powerful — if you're about to use it three times on one screen, use it once.

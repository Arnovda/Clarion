# Kickoff prompt for Claude Code

Paste this as your first message to Claude Code, with the `handoff/` folder attached to the project.

---

You are restyling Clarion, a Next.js 14 + Tailwind app, into a new visual direction called **Observatory**. This is a **presentation-layer change only** — no routing, data, or business logic changes.

Your single source of truth is the `handoff/` folder. Read it end-to-end before writing any code:

1. `handoff/README.md` — the plan
2. `handoff/01-phase-plan.md` — the ordered phases
3. `handoff/02-tokens-and-config.md` — drop-in foundation
4. `handoff/03-component-specs.md` — every component you need
5. `handoff/04-screen-specs.md` — screen-by-screen instructions
6. `handoff/05-rules.md` — hard rules
7. `handoff/06-acceptance.md` — definition of done per phase
8. `handoff/reference/*.html` — open these in a browser to see the target. Study them.

## How you work

- Execute phases **strictly in order**. Do not start Phase N+1 until Phase N is merged.
- At the end of each phase, stop and summarize what changed. Wait for review before continuing.
- If anything is ambiguous, **ask**. Never guess a color, spacing, font, or component behavior that isn't in the docs.
- Do **not** refactor business logic, data fetching, routes, or state management. This is presentation-layer only.
- Do **not** introduce new dependencies without asking. Recharts, Radix, Headless UI, lucide-react are pre-approved if already present.
- Preserve all existing functionality. If a component disappears, users lose a feature — and that is not the goal.

## First task — Phase 0

Read every file in `handoff/`. Then:

1. Add `handoff/02-tokens-and-config.md`'s CSS block to the top of `app/globals.css`.
2. Merge the tailwind extension into the existing `tailwind.config.ts`.
3. Verify fonts load.
4. Swap the site-wide `<body>` class to use `bg-bg text-ink font-sans`.
5. Run `npm run dev`. Verify the app compiles and loads.
6. Screenshot any three pages and confirm the tokens resolve (colors should visibly change).
7. Stop. Summarize what you did. Ask for review before starting Phase 1.

Do not touch any component yet. Phase 0 is foundation only.

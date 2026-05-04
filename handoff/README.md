# Clarion · Observatory restyle — Claude Code handoff

This folder is the **single source of truth** Claude Code should work from. Hand it this entire folder.

## What's in here

| File | Purpose |
|---|---|
| `README.md` | This file — the overall plan and how to run it |
| `00-kickoff-prompt.md` | Paste this into Claude Code first. It briefs the agent. |
| `01-phase-plan.md` | Ordered list of phases. Claude Code works these top-down. |
| `02-tokens-and-config.md` | Drop-in files (globals.css, tailwind.config additions, font imports). |
| `03-component-specs.md` | Every component Claude Code needs to build, with CSS and usage. |
| `04-screen-specs.md` | Screen-by-screen rebuild instructions. One section per route. |
| `05-rules.md` | Do / don't rules. Hard constraints to prevent drift. |
| `06-acceptance.md` | Checklist Claude Code must pass before marking a phase done. |
| `reference/*.html` | The static mocks — open these to see the target. Do not link from code. |

## The deal with Claude Code

Claude Code is good at executing against explicit specs. It is bad at taste decisions.
Everything it needs to make a taste decision about is already made in this folder.
If it ever feels like "improvising," it should stop and ask.

## Order of operations (strict)

1. **Phase 0 — Foundations.** Tokens, fonts, tailwind extension, base layout. No visual feature work yet.
2. **Phase 1 — Primitive components.** Button, Input, Select, Badge, Card, Table, Tabs, Toast, Modal, Skeleton.
3. **Phase 2 — Composite components.** KPI tile, ChartCard, AI response block, JobProgressBanner, NotificationBell, SourceCard, OutlineRail, Cell (notebook).
4. **Phase 3 — App chrome.** Top bar, side rail, command palette, page header pattern.
5. **Phase 4 — Screens, in this order:**
   Login → Empty workspace → Onboarding → Ask → Dashboards → Reports → Notebooks → Semantic → Products → Quality → Sources → Settings/Admin (inherits automatically).
6. **Phase 5 — Polish sweep.** Empty states, loading states, error states, motion pass.
7. **Phase 6 — QA.** Against `06-acceptance.md`.

Do not jump ahead. Each phase compiles and runs before the next one starts.

## How to keep Claude Code on the rails

- After each phase, have it summarize what it changed and ask for a review *before* starting the next.
- If it proposes a component, color, or pattern that is not in these docs, it must ask first.
- If it runs into ambiguity, it stops and asks. No guessing.
- If it wants to refactor existing logic "while it's there," it says no. This restyle touches presentation only.

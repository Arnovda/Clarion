# Phase plan

Each phase has a scope, acceptance criteria, and a hand-back point. Do not skip the hand-back.

---

## Phase 0 · Foundations (no visual feature work)

**Scope**
- Install fonts (Source Serif 4, Inter, Geist Mono) via `next/font` or Google Fonts import at top of `app/globals.css`.
- Paste the token CSS block from `02-tokens-and-config.md` above the `@tailwind` directives in `app/globals.css`.
- Merge the tailwind extension into existing `tailwind.config.ts` (extend, don't replace).
- Set body default: `bg-bg text-ink font-sans antialiased`.
- Add the `.font-feature-settings` for Inter stylistic sets.

**Acceptance**
- App compiles, `npm run dev` works.
- Opening any page shows the new background color `#eef0f2`.
- Inspecting a button in devtools shows Inter applied, not the previous font.
- No functional regressions.

**Hand back.** Screenshot three pages (login, dashboard, any form). Wait for review.

---

## Phase 1 · Primitive components

Build these as React components in `components/ui/` (or wherever your kit lives). Replace existing primitives one-for-one. Keep prop APIs backward compatible where possible.

1. **Button** (variants: `primary`, `secondary`, `ghost`, `danger`; sizes: `sm`, `md`, `lg`)
2. **Input** (text, password, search; with optional label + hint + error)
3. **Select** / dropdown (using existing Radix / Headless if present)
4. **Badge** (`ai`, `ocean`, `ok`, `warn`, `err`, `neu`)
5. **Card** (default, raised, outlined)
6. **Table** (monospaced headers, serif numeric columns)
7. **Tabs** (ocean underline)
8. **Toast** (ocean on success, err on failure)
9. **Modal** (raised card, serif title, mono eyebrow)
10. **Skeleton** (soft shimmering on `--softer`)

See `03-component-specs.md` for exact markup and classes.

**Acceptance**
- Each primitive renders in isolation (Storybook or a `/dev/ui` page).
- Each primitive matches the Tier-1 mock visuals side-by-side.
- All existing usages continue to work (do a repo-wide import-usage scan).

**Hand back.** Show a contact sheet page with every primitive. Wait for review.

---

## Phase 2 · Composite components

1. **KPITile** — serif number, mono label, delta row
2. **ChartCard** — serif title, mono subtitle, Recharts body with `--c1`..`--c6` palette
3. **AIResponseBlock** — serif body, `--ai` left border, mono footer with source pills
4. **JobProgressBanner** — top of page, mono step list, ocean progress
5. **NotificationBell** — dot indicator, dropdown
6. **SourceCard** — connection tile with status
7. **OutlineRail** — right-side table-of-contents (used in Notebook, Report)
8. **NotebookCell** — polymorphic shell (ask, sql, chart, kpi, md, table, filter, python)

**Acceptance**
- Renders against mock data that mirrors real API shapes.
- Handles loading, empty, error states.

**Hand back.** Component catalog page. Wait for review.

---

## Phase 3 · App chrome

- Top bar: wordmark · workspace name · spacer · notifications · user avatar
- Left rail: grouped sections (Workspace, Model, Admin) with active state
- Command palette (if existing): restyle only, same keybinds
- Page header pattern: eyebrow (mono) + serif title + supporting copy + actions

**Acceptance**
- Chrome replaces the current chrome across every authenticated route.
- Active route highlighting works.

---

## Phase 4 · Screens

Rebuild in **this order**. Each screen is a separate PR. Do not bundle.

1. **Login** — see `04-screen-specs.md#login`
2. **Empty workspace** — first-run experience
3. **Onboarding** — 5-step wizard: connect → permissions → profile → first question → invite
4. **Ask** — hero landing + conversation view
5. **Dashboards** — KPI grid + chart grid + briefing layout
6. **Reports** — editorial briefing layout
7. **Notebooks** — list + editor (cells)
8. **Semantic layer** — definition cards, AI vs human authorship
9. **Products** — star-schema canvas
10. **Quality** — trust rings + rule list
11. **Sources** — connection management
12. **Settings / Admin** — inherits automatically, no new design work

**Acceptance (per screen)**
- Matches the corresponding mock in `reference/` at 1440px, 1024px, 768px, 390px.
- All existing data and interactions still work.
- Loading, empty, error states have been styled.

---

## Phase 5 · Polish pass

- Motion audit: transitions use `--dur-1` (120ms) and `--ease`.
- Empty states: every list/grid has a designed empty state.
- Error boundaries: use the Observatory error pattern.
- Focus rings: ocean at `0 0 0 3px var(--ocean-soft)`.
- Print styles for Reports and Notebooks.

---

## Phase 6 · QA

Walk `06-acceptance.md` end-to-end. Any failing item blocks merge.

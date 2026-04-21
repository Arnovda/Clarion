# Acceptance checklist

Run through this list at the end of each phase. Every box must be ticked before merging.

## Phase 0 — Foundations

- [ ] `app/globals.css` contains the full token block above the `@tailwind` directives.
- [ ] `tailwind.config.ts` includes the color, radius, shadow, font, and motion extensions.
- [ ] `Source Serif 4`, `Inter`, `Geist Mono` load without FOUT (check network tab, no layout shift).
- [ ] Body background is `#eef0f2` on every authenticated route.
- [ ] Body default text uses Inter.
- [ ] `npm run build` passes.

## Phase 1 — Primitives

- [ ] Every primitive in `03-component-specs.md#button` through `Skeleton` exists and matches the spec.
- [ ] Existing call sites of old primitives still compile and render correctly.
- [ ] A `/dev/ui` showcase page renders every variant and size of every primitive.
- [ ] Focus rings use `var(--ocean-soft)`.
- [ ] Hover/active/disabled states implemented for Button and Input.

## Phase 2 — Composites

- [ ] KPITile, ChartCard, AIResponseBlock, JobProgressBanner, NotificationBell, SourceCard, OutlineRail, NotebookCell all exist.
- [ ] ChartCard's Recharts use `--c1..--c6`, mono axes, dashed grid.
- [ ] AIResponseBlock has the ai left border, serif body, mono footer, confidence + source pills.
- [ ] Every composite renders loading, empty, and error states.

## Phase 3 — App chrome

- [ ] Top bar replaced. Wordmark, workspace name, notifications, avatar. No dead links.
- [ ] Left rail replaced. Correct section grouping (Workspace / Model / Admin). Active state is ocean background.
- [ ] Command palette (if present) restyled. Hotkeys unchanged.

## Phase 4 — Screens

For each screen in `04-screen-specs.md`:

- [ ] Hero/title uses the serif h-scale specified.
- [ ] Eyebrow uses mono, uppercase, 10.5px.
- [ ] KPI/table numbers are mono tabular-nums, right-aligned.
- [ ] Empty state designed (serif headline + one CTA).
- [ ] Loading state designed (skeleton pattern).
- [ ] Error state uses the error pattern (err border-left + serif copy).
- [ ] Responsive at 1440 / 1024 / 768 / 390.
- [ ] All existing interactions work.

## Phase 5 — Polish

- [ ] All hover transitions use `duration-1` + `ease-observatory`.
- [ ] No `rounded-xl+` on anything outside hero surfaces.
- [ ] No gradients, emojis, drop shadows on text, glassmorphism.
- [ ] Print stylesheet for Reports and Notebooks produces clean pages.
- [ ] Dark mode — if enabled in the app — is deferred to a later pass. Confirm it's off by default.

## Phase 6 — QA

- [ ] Walk every route. Nothing looks un-styled.
- [ ] `npm run build` passes. No TS errors. No console errors in browser.
- [ ] Lighthouse accessibility ≥ 90.
- [ ] Keyboard navigation works end-to-end (tab through login, dashboard, notebook editor).
- [ ] Screen-reader labels present on icon-only buttons.

## Definition of done, overall

You can hand a new user the app, have them connect a source, ask a question, save a dashboard, and export a report — and every screen along that path looks intentional, not improvised.

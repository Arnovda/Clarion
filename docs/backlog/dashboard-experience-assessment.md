# Dashboard Experience — Assessment & Improvement Plan

> Written 2026-08-26. Owner asked three questions about dashboard generation:
> (1) is the creation flow optimal — enough user steering without being
> cumbersome? (2) are the dashboards too generic — how do we get a wow effect,
> maybe even AI-written HTML layouts? (3) is the change flow intuitive, and
> does it actually work? This document answers all three from a full code
> investigation (creation flow, refine flow, rendering layer — every claim
> carries a file:line) crossed with external research on the 2025–26 AI-BI
> landscape (Databricks AI/BI, ThoughtSpot Spotter, Power BI Copilot, Tableau
> Pulse, Omni, Hex, Luzmo, plus the DashChat/VisEval/DashArena research line).
> Companion to `dashboard-architecture-plan.md` (2026-07-13), which stays the
> plan of record for the rendering architecture; this doc is about the
> EXPERIENCE and found several defects that doc predates.

---

## 0. Verdict in three sentences

1. **Creation**: the flow's *shape* is right (one prompt → optional clarifying
   questions → generate) and matches what the industry converged on — but the
   steering is largely theater: answers are detached from their questions, not
   bound to anything in the spec, a hard-coded 1-year date default silently
   overrides the user's chosen time window, and the product offers no help
   knowing *what to ask for* (three hard-coded chips; the tenant's own topics
   and KPI questions are never used).
2. **Wow**: the JSON-DSL architecture is correct and externally validated —
   do NOT switch to AI-written HTML — but the DSL is too poor to express a
   designed page: the prompt hard-codes one identical skeleton for every
   dashboard, the only emphasis primitive (`featured`) is never emitted
   because it's missing from the prompt, and there is no hero, no sections,
   no narrative block, no targets, no semantic color. The genericness is a
   *vocabulary* problem, fixable inside the current architecture.
3. **Change**: the entry point is genuinely good (persistent chat bar with an
   explicit Edit/Ask toggle) — but the plumbing under it has one serious data
   bug (**Save after a refine always creates a duplicate dashboard; the
   original is never updated**), two context-drift bugs (reopened dashboards
   refine against the wrong connection and the wrong product set), a
   layout-clobber path, no undo of any kind, and almost no way to make a
   change without an LLM round-trip. This is the least finished of the three
   flows and contains the bugs to fix first.

---

## 1. Question 1 — the creation flow

### 1.1 What exists (measured)

The mode machine lives in one 2,326-line client component
(`frontend/app/dashboards/page.tsx:135`): `empty → choosing → refining →
creating → viewing`.

- **Empty state**: headline + one-line input + exactly three hard-coded chips
  — `['Sales overview', 'Customer analysis', 'Product performance']`
  (`EmptyDashboardHero.tsx:21`). No tenant data is used.
- **`choosing`**: only *after* the prompt is committed does the user pick the
  data domain and product(s), then faces a two-card fork: "Refine with AI
  first" vs "Generate now" — the skip path is presented as the visually equal,
  faster-sounding option (`page.tsx:1634-1646`).
- **`refining`**: `POST /dashboards/refine` returns 3–4 schema-aware questions
  with suggestion chips. The prompt behind it (`dashboardPrompt.ts:354-374`)
  is good — "specific to both the request AND the available data columns …
  cover time window, categorical focus, metric priority, audience/purpose".
- **`creating`**: one blocking request — Sonnet 16k → execute every widget's
  SQL → one Haiku semantic check per widget → possibly a second Sonnet 16k
  repair. No SSE, no progress, no cancel, no timeout
  (`routes/dashboards.ts:277-326`, `frontend/lib/api.ts:5-7`). The waiting
  screen is a decorative shimmer wireframe with hard-coded bar heights
  (`page.tsx:1758-1802`). Structurally a tens-of-seconds operation
  (€0.10–0.30/generation per `post-demo-improvements.md`).

### 1.2 What the investigation found broken or hollow

| # | Finding | Evidence |
|---|---------|----------|
| C1 | **Refinement answers lose their questions.** The client sends `Object.values(refinementAnswers)`; the server renders them as anonymous `- <answer>` bullets. "Last 30 days" arrives with no indication it answered the time-window question. | `page.tsx:1718`, `dashboards.ts:293-297` |
| C2 | **Answers are not schema-bound — and the time window is silently overridden.** No answer can become a filter, a default value, or a grain. Worse: `buildDefaultFilters` hard-codes every `date_range` filter to exactly one year ago → today, and those values fill the placeholders on first execution. A user who answers "Last 30 days" gets a 1-year dashboard. | `utils/format.ts:88-106` |
| C3 | **No first-class notion of audience, cadence, or time grain.** The refinement prompt is told to ask about audience; the generation prompt and the spec have nowhere to put the answer. "Weekly" has zero support — every prompt example is monthly and the rollup rule pushes monthly. | `dashboardPrompt.ts` passim, `productContext.ts:301-303` |
| C4 | **The product doesn't help the user know what to ask for.** Three generic hard-coded chips, while the tenant's own topics carry curated `question_text` ("Who owes me money right now?") and `product_kpis` — never used as suggestions. | `EmptyDashboardHero.tsx:21` |
| C5 | **`selectedDomains` is dead state** (setter never called, options fetched but never rendered) and the backend discards `domains` anyway. `/generate` also has no Zod schema (the only AI dashboard route without one) and sits under the compute limiter, not the AI limiter. | `page.tsx:161-162`, `dashboards.ts:280`, `index.ts:216` |
| C6 | **On failure the user's refinement work is discarded** — mode drops to `empty`; answers are stranded. No retry-with-answers. | `page.tsx:556-558` |
| C7 | **Broken/missing entry points.** Home and the Command Palette link to `/dashboards?id=N` but the page never reads search params — the deep link silently lands on the empty hero. And nothing anywhere in the product links INTO dashboard creation: Build's finish card, `/subjects`, topic pages, the catalog and the morning brief all point at `/query`. | `home/page.tsx:555`, `CommandPalette.tsx:142`, `build/page.tsx:723` |
| C8 | **Templates are a permanent dead end.** The tab, table and endpoints exist; nothing seeds them and no UI can create one. Every tenant sees an empty tab forever. | `page.tsx:2292-2293`, migration 26 |
| C9 | No preview, no cancel, no elapsed time, no regenerate-differently (temperature 0 is a deliberate, sound choice — but then "try again" needs another lever). | `AIService.ts:1525-1528` |
| C10 | No rename UI (AI writes the title; `PATCH` accepts `title` but nothing calls it), no folder choice at creation. `DashboardHeader.tsx` — which has the rename+save header — is imported nowhere: dead code. | `page.tsx:1813`, `schemas.ts:259-268` |

### 1.3 What the industry does (research summary)

- **Nobody front-loads a questionnaire.** The converged pattern is: one prompt
  box + *generated* suggestion chips from the tenant's real metadata (Genie
  derives example questions from table metadata) + **conditional** clarifying
  questions asked only when intent is ambiguous (Power BI Copilot's 2025
  behavior; nvBench 2.0 made ambiguity resolution a benchmark category).
- **The dominant flow is prompt → visible plan → build with streaming progress
  → land in a fully editable editor** (Databricks dashboard agent shows its
  plan and asks approval; Omni's principle: "the agent shows its work — every
  tile inspectable"). Black-box one-shot generation is out.
- Requirements literature says when you *do* ask, the two questions that
  matter are "who is this for / how often will they look?" and "what would
  you do differently after seeing it?"

**So: the owner's instinct is correct — "generate me a sales dashboard" alone
under-specifies — but the fix is not more questions. It is (a) better
*suggestions* so the user starts from a good prompt, (b) fewer, conditional
questions whose answers are structurally honored, and (c) a visible build so
the user can steer early instead of specifying everything up front.**

### 1.4 Improvement plan — creation

1. **Bind the answers (the load-bearing fix).** Send `{question, answer}`
   pairs to `/generate`, not bare strings. Map the time-window answer to real
   default filter values: add `default` to `FilterSpec` (e.g. `{preset:
   'last_30_days'}`), have the AI emit it, have `buildDefaultFilters` honor it
   and only fall back to 1-year when absent. This single change makes the
   refinement step stop lying.
2. **Generate the suggestion chips from tenant data.** Replace the three
   hard-coded strings with the tenant's topic `question_text` and KPI names
   (the data the topic pages already fetch). Chips carry their product id, so
   clicking one pre-selects the product — collapsing the `choosing` step for
   the common path.
3. **Make refinement conditional, not a fork.** Drop the two-card fork. After
   the prompt: a cheap Haiku call decides whether the request is ambiguous
   (time window unclear? multiple plausible products? metric undefined?). If
   clear → generate immediately, showing one line "Assuming: last 12 months ·
   monthly · Sales topic — change" with inline chips. If ambiguous → ask at
   most 2–3 questions. This is the Power BI pattern and it removes the choice
   the user is least equipped to make ("do I want to refine?").
4. **Add the two questions that matter** to the refinement prompt's priority
   list: "who will look at this, how often?" and "what decision should it
   support?" — and give the generation prompt an `audience` slot that
   modulates the recipe (owner-weekly → fewer, bigger, calmer; analyst →
   denser; see §2).
5. **Stream the build.** The backend has three real phases (design → validate
   → repair) and the Build page already built this muscle (SSE + cards
   materializing). Convert `/generate` to SSE: phase events, then widget-by-
   widget as validation completes, with elapsed time and cancel
   (AbortController). Even without token streaming this turns a 40-second
   black box into a watched build — the industry's "generation theater" is
   part of the wow.
6. **Fix the plumbing**: handle `?id=` on `/dashboards` (two call sites
   already emit it); keep answers on failure and offer retry; Zod-validate
   `/generate` and move it under the AI limiter; delete or wire
   `selectedDomains`; parallelize `loadFilterOptions`.
7. **Entry points**: the topic page and the Build finish card gain "Create a
   dashboard for this topic" (prefilled prompt + product pre-selected). The
   deep-link vocabulary already exists for `/query` — mirror it.
8. **Templates**: seed 1–2 per connector from the star-schema template's KPIs
   (the same source that already powers the Build plan cards), add "Save as
   template" for admins, or hide the tab until either exists. An empty
   permanent tab teaches users to ignore the sidebar.

---

## 2. Question 2 — genericness and the wow effect

### 2.1 Answer the HTML idea first

**Do not let the model write HTML/React layouts.** This was examined
externally and the evidence is one-directional:

- The OpenUI "State of Generative UI" report: constrained spec + renderer
  walking a developer-owned component catalog "is where most production agent
  UIs currently land." Vercel's generative UI streams *developer-defined*
  components; thesys C1 constrains output to a curated component system.
- Measured accuracy: models score >84% on declarative chart formats but
  markedly worse on imperative/freeform code (VisCoder2); whole-dashboard
  freeform generation still shows "persistent rendering, analytical, and
  interaction failures" at the frontier (DashArena 2026).
- Clarion-specific: a spec can be persisted, diffed, validated
  (`validateWidgetColumns`), repaired, and safely refined. Generated HTML can
  be none of those, and is an injection surface in a multi-tenant product.
  This is also the conclusion `dashboard-architecture-plan.md` §1 already
  reached; 2026 evidence strengthened it.

**The correct reading of "I've seen beautiful dashboards and ours are
generic": the DSL isn't too constrained as an *architecture* — it's too poor
as a *vocabulary*. Beautiful dashboards differ from ours in hierarchy,
narrative and semantics, not in being hand-coded.**

### 2.2 Why the output is generic (measured, top causes)

1. **The prompt hard-codes one skeleton for every dashboard**: "Row 1: 4×
   kpi_card — ALWAYS first … Row 2: 2+2 … data_table always last. Total 6–9
   widgets" (`dashboardPrompt.ts:247-271`). Every dashboard is the same page.
2. **The only emphasis primitive is broken**: `featured` (→ taller card) is in
   the JSON schema but appears nowhere in the prompt — the model never emits
   it (`outputSchemas.ts:174` vs zero hits in `dashboardPrompt.ts`). And the
   AI cannot size anything else: `layout` is absent from the schema, and
   `MIN_COLS_12` silently clamps `colSpan` upward, breaking the very
   "rows sum to 12" rule the prompt enforces (`page.tsx:64-79`).
3. **No sections, no text**: no section-header or narrative widget type exists;
   the grid is wall-to-wall charts. Meanwhile the three AI-text surfaces that
   DO exist (insights strip, per-widget Explain, the genuinely good Story
   narrative) are all chrome *around* the grid — dismissible, collapsed, or
   locked in a modal.
4. **No judgment in the numbers**: no targets, thresholds, reference lines,
   conditional color. The one exception (bullet_chart's attainment ramp) is
   hard-coded in the component. Research consensus (Gezora, Tableau Pulse) is
   that this — "does the dashboard say good or bad?" — is the main difference
   between generic and premium, ahead of any styling.
5. **Palette misuse**: `bar_chart` colors every bar a different palette hue
   (encoding nothing) while `vertical_bar_chart` uses one color — the two most
   common widgets look like different products (`ChartWidgets.tsx:85` vs
   `:148`). The pivot heatmap keys off a CSS var that is never defined and
   falls back to an out-of-palette blue. `TYPE_ACCENT` and the three
   `kpi*Tint` tokens are defined and never used. Shadow tokens exist and no
   card uses them.
6. **Comparison is KPI-only**: the prompt's own example promises "2025 vs
   Prior Year" but no chart type can render two periods.
7. **Hardwired personality**: € and nl-BE formatting are baked into the axis
   formatters regardless of `spec.format`; dark mode does not exist (the
   toggle component is dead code).
8. **No quality signal**: the e2e gate proves marks drew; nothing measures
   whether the output is readable or well-designed (the VisEval-style harness
   is Tier 3, unstarted).

### 2.3 Improvement plan — the wow

The recipe, in order of wow-per-effort:

1. **Extend the DSL vocabulary (one migration of the spec, no architecture
   change):**
   - `sections[]`: `{title, widgetIds}` — rendered as quiet mono-eyebrow
     headers, the design-mockups' `.sec-h` pattern ("What moved — current vs
     prior year"). Gives every dashboard a narrative arc.
   - `hero` (or repair `featured` and put it in the prompt): 1–2 oversized
     KPI/chart tiles. Renderer gives a hero KPI the 56px serif number, tinted
     goal state, and a wide sparkline.
   - `narrative` widget type: 2–3 sentences of AI-written insight *in the
     grid*, populated by the same machinery as the insights strip. The lede
     block from mockup A finally becomes reachable.
   - `target` on kpi_card and line/vertical_bar (goal line + attainment
     color). Values can come from a stored KPI, a managed grid
     (budget-vs-actual is an ordinary JOIN since grids shipped — this is gap
     G4's first instance landing where it's most visible), or the prompt.
   - `comparison: 'prior_period'` on line/vertical_bar → the SQL contract
     gains an optional `prev_value` column; renderer draws the muted baseline.
     The "vs last year" promise becomes real.
   - `emphasisColor: 'good'|'bad'|'neutral'|'accent'` — semantic, never raw
     hex. The model states meaning; the design system keeps control of color.
2. **Replace the fixed skeleton with a recipe that has hierarchy**: hero row
   (1–2 big numbers with target state) → narrative strip → one anchor chart
   (8-col, featured) → supporting tiles → detail table. Encode it as prompt
   rules + a renderer that honors spans (fix the `MIN_COLS_12` clamp conflict
   — clamp in the prompt contract, not silently at render). This is the
   bento/hero-first pattern every 2025-26 design reference lands on, and
   DashChat's finding: constrain generation with patterns distilled from good
   dashboards rather than freeing the model.
3. **Upgrade the KPI card to the Tableau Pulse metric-card anatomy** — value,
   Δ vs prior period, goal/threshold state, sparkline, one ranked insight
   sentence, drill affordance. This one component carries most of the premium
   feel, and Clarion has every ingredient already (delta SQL contract,
   Sparkline, drillDownSql, insight machinery).
4. **Calibrate for the audience** (§1.4's `audience` slot): the SMB owner is
   the Mercury persona — fewer, calmer, bigger; density is for the analyst
   persona. Default to ~6 widgets with drill-downs, not 9.
5. **Fix the visual defects** (cheap, high-polish): single-hue ranked bars
   (color only the leader or use one hue), define the missing
   `--color-ocean-rgb` and a real sequential ramp for the heatmap, honor
   `spec.format` on axes (stop forcing €), use `shadow-1` on cards, wire or
   delete `TYPE_ACCENT`/`kpiTint*`/`DashboardHeader`.
6. **Verified badges**: when a widget's SQL comes from a stored KPI formula,
   badge it — "uses your Outstanding receivables definition" (Genie's
   trusted-assets pattern). Trust is part of wow, near-zero cost.
7. **A readability gate, not just a validity gate**: deterministic post-checks
   — label overflow, series-count caps, top-N+other collapsing, axis
   formatting (the "2.025" year bug class). VisEval's core finding is that
   readability fails even when execution passes.
8. **Then** the already-planned Tier-2 remainder (brush/zoom, small multiples,
   dark mode) — real but behind the above in wow-per-effort.
9. **Medium-term, strategic**: the research consensus is that "dashboards feel
   generic" is ultimately answered by the awareness layer — followed metrics
   with Pulse-style cards pushed to the user (Clarion's G1–G3: thresholds,
   delivered brief, exception lists). A beautiful pull-dashboard and a push
   layer are complements, not rivals; this doc deliberately scopes to the
   former.

### 2.4 Explicitly rejected for the wow
- LLM-written HTML/JSX layouts (see §2.1).
- Per-tenant theming/branding engine — one excellent look first.
- More chart types before hierarchy exists — the gap is composition, not
  chart vocabulary.
- Returning to Vega-Lite (settled, `dashboard-architecture-plan.md`).

---

## 3. Question 3 — the change flow

### 3.1 What's good

The entry point is better than most products': a **permanently visible chat
bar** under every open dashboard with an explicit "Edit dashboard / Ask AI"
toggle (`page.tsx:2203-2228`), a deliberate retreat from regex intent-sniffing
(the removal comment at `page.tsx:892-895` is the right call). The refine
prompt fights widget-loss three ways plus a code-level restore net; validation
re-runs scoped to changed widgets. The *intent* architecture is sound.

### 3.2 What's broken (ranked)

| # | Defect | Evidence |
|---|--------|----------|
| R1 | **Save after refine forks the dashboard.** `saveDashboard` always `POST`s a new row — never PATCHes — so refining a saved dashboard and pressing Save creates a duplicate with the same title while the original keeps the old spec. Applies equally to Arrange-mode placements and Fix-with-AI. Nothing hints Save means fork. | `page.tsx:566-592` vs `dashboards.ts:1628-1645` |
| R2 | **Wrong context on reopen.** `openDashboard` ignores the returned `connection_id` (stays at connection #1) and `productIds` are never persisted — a refine on a reopened dashboard builds context and executes SQL against the wrong connection / every product on it. | `page.tsx:596-619`, `dashboards.ts:1545-1551`, `productContext.ts:113-132` |
| R3 | **Refine can clobber the user's arrangement.** `layout` is absent from the refine and validate prompts AND from the structured-output schema (survives only via passthrough), and the view-mode guard is all-or-nothing: one AI-added widget without `layout` discards the entire arrangement. | `dashboardPrompt.ts:399-441`, `outputSchemas.ts:135-179`, `page.tsx:1240` |
| R4 | **No undo of any granularity.** No spec history, no revert-last-edit; Discard nukes the whole session. A bad refine on an unsaved dashboard is unrecoverable. No `beforeunload` guard either. | `page.tsx:1019-1028` |
| R5 | **Stateless, single-turn refine.** No original prompt, no chat history sent — "now split that by region" cannot resolve "that". The UI is a chat; the contract isn't. | `AIService.ts:1455-1508` |
| R6 | **Stale data after refine**: `widgetCacheRef` isn't cleared, so widgets keep showing pre-refine rows behind a pulse dot, and the insights strip keeps describing the old dashboard. | `page.tsx:271-291, 358` |
| R7 | **Whole-spec regeneration per change** with a restore-net whose guard regex is disabled by exactly the words ("remove", "weg") most likely to appear in destructive asks; the repair pass then gets licence over the full spec ("scoped" is true for cost, not blast radius). Silent caps ("keep 4–9 widgets") produce ask-and-nothing-happens. | `AIService.ts:1477-1505`, `dashboards.ts:252-259`, `dashboardPrompt.ts:412` |
| R8 | **The non-AI escape hatch is nearly empty.** No rename (dashboard or widget), no delete/duplicate widget, no change-type, no filter add/remove. Every structural change is an LLM round-trip, which makes R4–R7 unavoidable rather than optional. | `WidgetContextMenu.tsx:109-127` |
| R9 | Feedback is three bouncing dots for a 20–60s operation, then "Dashboard updated" with no diff. Unsaved state hides half the toolbar (Story/PDF/XLSX/Settings) until you save — which forks (R1). | `page.tsx:2185-2193, 1875-1990` |
| R10 | Hygiene: `/refine-spec` is the only dashboard AI route with no Zod validation; zero tests touch the change path (including the pure, trivially-testable restore net). | `dashboards.ts:358-411`, `tests/dashboards.test.ts` |

### 3.3 What the industry does

DashChat's CHI 2026 user study (the best evidence available): users start
with one broad prompt, then **switch to quick-suggestion buttons and direct
manipulation for fine-grained refinement** — pure chat-for-everything is the
wrong model. The validated pattern is mixed-initiative: NL + per-widget quick
actions + direct manipulation + **a version panel with Restore**. Omni's
principle applies too: AI edits land as inspectable, editable tiles, and
everything the UI can do the AI can do. Preview-then-apply with one-click
revert is the emerging norm for AI edits.

### 3.4 Improvement plan — change flow

1. **Fix R1 now**: `saveDashboard` PATCHes when `activeId` exists; "Save as
   copy" becomes the explicit fork. (The PATCH endpoint already accepts
   `spec`.) This is the single highest-impact fix in this entire document.
2. **Fix R2 now**: restore `connectionId` from the row on open; persist
   `product_ids` on the dashboard row (small migration) and restore them.
   Without this, every other refine improvement operates on wrong context.
3. **Preserve layout**: add `layout` to the JSON schema and to both prompts'
   PRESERVE clauses; make the view-mode guard per-widget (place layout-less
   new widgets below the arranged ones) instead of all-or-nothing.
4. **Client-side undo, then versions**: keep a spec snapshot stack in the
   page (revert-last-AI-edit, one click, zero backend) immediately; a
   `dashboard_versions` table (spec + refinement text + timestamp) as the
   durable follow-up. Add `beforeunload` while unsaved.
5. **Say what changed**: the refine response already knows which widgets are
   new/changed (the scoping computation) — render it: "Changed *Revenue
   trend* to a line chart · added *Orders by region*". A diff sentence is
   90% of preview-then-apply at 10% of the cost; full preview-apply can come
   later.
6. **Multi-turn**: persist the original prompt on the dashboard row; send it
   plus the last ~6 chat turns to refine-spec. The chat UI finally becomes a
   chat.
7. **Widget-scoped edits**: per-widget overflow menu with the non-AI basics
   (rename, delete, duplicate, resize, change type where the column contract
   is compatible — bar↔vertical_bar↔line share `label/value`) AND "Ask AI
   about this widget" that routes to a single-widget refine (the fix-widget
   machinery already does exactly this server-side). This shrinks most edits
   from a 16k whole-spec call to a per-widget call — cheaper, faster, and
   structurally incapable of collateral damage. Also: dashboard rename
   (endpoint exists; wire an inline title edit).
8. **Fix R6**: clear the widget cache for changed widgets and regenerate the
   insights strip after a successful refine.
9. **Hygiene**: Zod on `/refine-spec`; unit tests for the restore net, the
   changed-widget scoping, and the guard regex; fix the `\bweg\b` Dutch trap
   while touching it; surface the 4–9 cap as a message instead of silence.

---

## 4. Consolidated defect list (bugs regardless of design direction)

Ranked; each is independently shippable.

1. Save-after-refine forks the dashboard (R1) — `page.tsx:566-592`.
2. Reopened dashboards refine against wrong connection/products (R2).
3. User's chosen time window overridden by hard-coded 1-year default (C2) —
   `utils/format.ts:88-106`.
4. `/dashboards?id=N` deep link (Home, Command Palette) silently no-ops (C7).
5. Refine clobbers Arrange layout via all-or-nothing guard + schema omission
   (R3).
6. Stale widget data + stale insights strip after refine (R6).
7. `featured` in schema but absent from prompt — never emitted (§2.2-2).
8. `MIN_COLS_12` silently overrides AI `colSpan`, producing ragged rows.
9. Axis formatters force `€` regardless of `spec.format`; pivot heatmap CSS
   var undefined → off-palette blue.
10. `/generate` and `/refine-spec` lack Zod validation; `/generate` on the
    wrong rate limiter.
11. Dead code shipping confusion: `DashboardHeader.tsx` (incl. dark-mode
    toggle), `TYPE_ACCENT`, `kpi*Tint`, `selectedDomains` state.
12. Refinement answers/questions lost on generate failure (C6).
13. Restore-net guard disabled by `\bweg\b` etc.; net untested (R7, R10).
14. Templates tab permanently empty for every tenant (C8).
15. `loadFilterOptions` fetches dropdowns sequentially (C5-adjacent).

---

## 5. Suggested sequencing (three releases)

**Release 1 — "Trust the loop" (bug-fix release, no design work).**
Defects 1–6 + 10 + 12 + hygiene tests. Rationale: the change flow is the loop
users hit most after day one, and today it can silently lose work three
different ways. Everything here is small, verifiable, and independent.

**Release 2 — "The dashboard looks designed."** DSL vocabulary (§2.3-1),
hero-first recipe (§2.3-2), Pulse-anatomy KPI card (§2.3-3), visual defect
fixes (§2.3-5), narrative widget from the existing insights machinery,
streamed generation with cancel (§1.4-5), diff sentence after refine
(§3.4-5). This is the wow release; every item rides the existing
architecture.

**Release 3 — "It steers itself."** Conditional clarifying questions +
assumption line (§1.4-3), schema-bound answers with filter defaults (§1.4-1),
generated suggestion chips from topics/KPIs (§1.4-2), per-widget quick
actions + widget-scoped AI edits (§3.4-7), multi-turn refine (§3.4-6),
client-side undo → version history (§3.4-4), verified badges, entry points
from topics/Build, targets from managed grids on hero KPIs (the G4 tie-in),
readability gate + the VisEval-style eval harness so all of this is measured
rather than vibes.

---

## 6. What NOT to do

- **No AI-written HTML/React layouts** — measured worse, unpersistable,
  undiffable, unsafe (§2.1). Widen the DSL instead; never expose the
  renderer.
- **No mandatory creation wizard** — nobody in the market front-loads a
  questionnaire; conditional questions only.
- **No patch-based refine protocol yet** — full-spec-with-guards is
  imperfect but simple; per-widget scoped edits (§3.4-7) remove most of the
  blast radius first. Revisit JSON-patch only if whole-spec refine still
  bites after that.
- **No per-tenant theming engine** — one excellent Observatory look.
- **No new chart types ahead of hierarchy** — composition is the gap.
- **Don't build the awareness layer inside this workstream** — G1–G3 remain
  their own (correctly prioritized) release; this doc scopes to the
  pull-dashboard experience.

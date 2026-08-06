# Handoff: topic-first data experience (Clarion)

## Overview

Today `/products` ("Organized data") serves the admin who builds the warehouse, not the SMB owner who uses it. This handoff replaces that front door with a **topic-first** experience:

- The business user's world is **topics** — Finance, Sales — reachable directly from the nav. There is no "data product" container page any more.
- A topic page answers the four things they came for, in order: what can I ask about, what exactly can I find out, is it current, can I trust it.
- Everything the current UI shows (tables, columns, relationships, star schema, data flow, quality detail, SQL, refresh/deploy/delete, Refine) moves behind **one door**: *Manage this data*, which opens **Manage mode** — the same screen, turned over, for analysts and admins only.

Two screens to build (plus the nav change):

1. **Topic page** — `screens/topic-page.png`
2. **Manage mode** — `screens/manage-mode.png`

## About the design files

The files in `prototype/` are **design references written in HTML** — a working prototype of look and behaviour, not production code to copy. Recreate them in the existing Next.js / React / Tailwind frontend (`frontend/`), using its established patterns: Observatory tokens from `app/globals.css` + `lib/observatory.ts`, Tailwind semantic classes (`bg-raised`, `border-line`, `text-ink`, `text-muted`, `bg-ocean`…), `lucide-react` icons, `components/layout/*` chrome, `lib/api.ts` for data.

- `prototype/Your data.dc.html` — the interactive prototype. Open it in a browser. It contains, top to bottom: turn 3 (the recommended design, interactive — click *Manage this data*, `Esc`/*Done* to exit, *Show SQL* toggles), turn 2 (an earlier full-page vs. drawer comparison for the manage surface), turn 1 (the two topic-placement options). **Build turn 3 (`3a`).** Turns 1 and 2 are context on why.
- `prototype/handoff-capture.html` — the same two screens as flat static markup, easiest to read for exact values.
- `prototype/support.js` — runtime the prototype needs; ignore for implementation.

## Fidelity

**High-fidelity.** Colours, type, spacing and copy are final and all come from the repo's Observatory tokens. Recreate pixel-perfectly with existing components. Placeholder-only: row counts, timestamps, the SQL sample, "2 changes not deployed" and the metric counts — all of that is real data at runtime.

---

## Navigation change (do this first)

`components/layout/IconRail.tsx`.

**Viewer** sees exactly three workspace items plus their topics:

```
Home
Ask AI
Dashboards
YOUR DATA          ← group eyebrow, mono 10px uppercase 0.12em, white/55
  Finance          ← one row per data product of kind 'analytics'
  Sales
```

**Analyst / admin** additionally sees the `STUDIO` disclosure, unchanged except:
- `Data products` is **removed** — topics are in the nav and the workshop is reached from the topic page.
- New item **`Shared data`** (icon `Library`, href `/shared-data`) — the conformed dimensions currently modelled as the "Core dimensions" product. Accounts, Date, GL accounts, Items, Item groups, Journals, Payment conditions live here and nowhere else.
- Remaining Studio items unchanged: Sources, Shared data, Refresh, Suggestions (badge), Notebooks. Settings group unchanged.

Topic rows use the same curated glyph the rest of the app resolves from the product name (`iconForAnalytics` in `components/catalog/entityIcons.ts`): Finance → `Landmark`, Sales → `Receipt`. Rail row styling is unchanged from `IconRail.renderNavLink` (13.5px, `rounded-sm`, `gap-2.5 px-2.5 py-2`, active `bg-white/15 text-white font-medium`, idle `text-[var(--ocean-soft)]`).

Route: `/topics/[productId]` (or reuse `/products/[id]` with the new view — your call). `/products` as a list page is retired; redirect it to the first topic or to `/home`.

---

## Screen 1 — Topic page (`screens/topic-page.png`)

**Purpose.** The business user's home for a subject area: what it covers, what they can ask, whether it is current and trustworthy. No counts of tables, no build status, no warehouse vocabulary anywhere on this screen.

**Route** `/topics/[productId]`. **Chrome** `TopBar` (48px) + `IconRail` (220px), i.e. the existing `ShellLayout`. Page background `--bg #eef0f2`. No page header bar, no tab strip — the content is centred.

**Layout.** Single centred column, `max-width: 720px`, `margin: 0 auto`, padding `60px 40px 40px`, vertical stack `gap: 30px`.

1. **Identity block** — centred, `gap: 10px`
   - Icon tile 44×44, `border-radius: 10px`, background `--ocean-softer #e8f0f3`, glyph `Landmark` 22px `strokeWidth 1.6` in `--ocean #164e63`.
   - Title: product display name. Source Serif 4, 38px, weight 400, `letter-spacing: -0.02em`, `line-height: 1.15`, `--ink`.
   - Description: the product's own `description` (already good copy in the DB — "Accounting analytics: general-ledger detail, open receivables and payables"), lightly humanised. Inter 15px, `--ink-3 #4a5660`, `line-height: 1.6`, `max-width: 520px`, `text-wrap: pretty`.

2. **Ask box** — full width, background `--surface-raised #fff`, `1px solid --line #d0d5da`, `border-radius: 10px`, padding `14px 18px`, flex row `gap: 10px`.
   - `MessageSquare` 16px `--muted-2 #8891a0`; placeholder text "Ask anything about {Topic}…" Inter 15px `--muted-2`; primary button right: `padding 8px 14px`, `bg --ocean`, white, 13px/500, `radius 6px`, hover `--ocean-hover #103d4f`. Label "Ask".
   - Submitting routes to `/query?productId={id}&productName={name}&q={text}` — the existing Ask AI page, scoped to this product.

3. **Try asking** — eyebrow "TRY ASKING", Geist Mono 10px, `letter-spacing 0.14em`, uppercase, `--muted-2`. Then 3–4 question rows, `gap: 8px`:
   - Row: `bg #fff`, `1px solid --line`, `radius 8px`, padding `15px 18px`, flex, text Inter 15.5px `--ink`, trailing `ArrowRight` 15px `--muted-2`.
   - Hover: `border-color: --ocean`, `color: --ocean` (120ms).
   - Click → `/query?productId={id}&q={question}` and **auto-submits** the question.
   - **Content rule:** questions are generated from the product's KPI rows (`GET /products/:id/kpis` — `name` + `description`), rephrased as first-person questions. "Outstanding receivables" → "Who owes me money right now?"; "Invoiced sales revenue" → "How much did I invoice this month?". Store the question phrasing on the KPI (new nullable column `question_text`) rather than deriving it in the client, so it can be edited in Manage mode. Fall back to the KPI name if empty.

4. **Break-down line** — one sentence, centred, Inter 14px `--ink-3`, `line-height 1.6`:
   > Break any of this down by customer, GL account, journal, payment terms or date.
   Each dimension is a link: `color --ink-2 #334049`, `border-bottom: 1px solid --line`; hover `--ocean` on both. Click → Ask AI pre-filled with "… by {dimension}".
   **Source:** the distinct shared dimensions this product joins to, using their **display names** (`display_name`, `is_technical = false`) — never snake_case, never a chip cloud, never row counts. Cap at 6 and end with "or date".

5. **Trust line** — full-width row above a `1px solid --line` top border, padding-top 18px, `justify-content: space-between`.
   - Left: 7px dot `--ok #3f7a5c` + Inter 12.5px `--muted`: "Matches Exact Online as of 6 minutes ago · **see data quality**" (link → the quality detail inside Manage mode; for viewers, a read-only quality summary).
     - Dot tone: `--ok` when the last build succeeded and the source synced < 24h ago; `--warn #a06a1c` when stale; `--err #a43a3a` on failure, with the sentence changing to "Last matched Exact Online 3 days ago — refresh pending".
   - Right (**analyst/admin only**): the mono label "ONLY YOU CAN SEE THIS" (Geist Mono 10px, 0.1em, `--muted-2`) + the **Manage this data** button: `padding 8px 12px`, `1px solid --line`, `radius 6px`, `bg #fff`, Inter 12.5px `--ink-2`, icon `SlidersHorizontal` 13px; hover `border-color --ocean; color --ocean; background --ocean-softer`.

---

## Screen 2 — Manage mode (`screens/manage-mode.png`)

**Purpose.** Everything the admin/analyst needs to inspect and change the topic's data. Same URL, `?manage=1` (so it is linkable and the back button works) — **not** a separate page load.

**Guard:** `RequireRole` analyst+ (`components/RequireRole.tsx`). A viewer hitting `?manage=1` gets redirected to the topic page.

**Structure** (top to bottom inside the main region; TopBar and IconRail stay put, rail unchanged):

### a) Mode bar — 38px, `background --ocean`, text white, padding `0 24px`, flex `gap 12px`
- `SlidersHorizontal` 13px; "MANAGE MODE" Geist Mono 10.5px 0.14em uppercase.
- Explainer, Inter 12.5px `--ocean-soft #d0e1e6`: "Nothing here changes what your team sees until you deploy."
- Right: "Press `Esc`" (kbd: 1px `rgba(255,255,255,.35)`, radius 4, 10.5px mono) and a **Done** button — `bg #fff`, `color --ocean`, 12.5px/500, `padding 5px 12px`, radius 5.
- The bar is the mode signal. It must be present on every tab of manage mode.

### b) Product header — `bg --surface-raised`, `border-bottom 1px --line`, padding `16px 24px 0`
- Left: 30px icon tile (radius 7, `--ocean-softer`, glyph 16px) + title Source Serif 22px `-0.02em` + meta line Inter 12px `--muted`: "3 tables · 5 shared lookups · 1 metric · built 6 minutes ago".
- Right, in order: pending-changes pill (`bg --warn-soft #f1e4c8`, `color --warn`, radius 999, 12px, "2 changes not deployed" — hidden at zero), **Refresh** (outline, `RefreshCw` 13px), **Deploy changes** (solid `--ocean`, 13px/500), overflow `MoreHorizontal` (Delete product, Duplicate, Export).
  - Deploy runs the existing bus-matrix refresh job; show progress inline as a slim ocean progress strip under the mode bar, not the dark terminal. Keep the SSE plumbing from `app/products/page.tsx` (`attachToJob`).
- Tab strip below, `padding 10px 14px` per tab, 13px, active `--ink` 500 with a 2px `--ocean` underline inset 8px, idle `--muted`:
  `Tables · How it fits together · Where it comes from · Metrics · Quality · Activity`
  (= today's Tables, Schema diagram / `StarSchemaFlow`, Data flow / `LineageFlow`, KPIs / `KpiManager`, `QualityTab`, refresh history. Same components, plain-language labels.)

### c) Tables tab — two panes
**Left pane, 320px**, `bg --surface #f8f9fa`, `border-right 1px --line`:
- Section eyebrow "MEASURES — 3", Geist Mono 10px 0.14em `--muted-2`, padding `10px 18px`, bottom border.
- Row per fact table: 8px status dot (`--ok`/`--warn`/`--err` from the last run + quality), name Inter 13.5px, and **a second line saying what it answers** — Inter 12px `--muted`, e.g. `Answers "who owes me money?"` (reuse the same question string the topic page shows), row count right-aligned Geist Mono 10.5px `--muted-2`. Selected row: `bg #fff` + 2px `--ocean` left border. Hover: `bg --softer`.
- Section "SHARED LOOKUPS — 5" with a right-aligned link **Edit in Shared data** (11.5px) → `/shared-data`.
- Shared dimensions render as **read-only pills**, wrapped, `padding 5px 9px`, `1px solid --line`, radius 999, `bg #fff`, 12px `--muted`, count in Geist Mono 10.5px. They are not editable here — that is the whole point of Shared data.

**Right pane** — padding `20px 26px`:
- Table title Source Serif 20px + role badge (existing `RoleBadge`: `Measures` = `bg-ai-soft text-ai`, `Lookup` = `bg-ocean-softer text-ocean`, mono 10px 600, radius 4). Sub-line 12.5px `--muted`: "One row per general-ledger line · rebuilt 6m ago · 8 of 8 checks passing".
- Right: **Preview rows**, **Run** (both outline 12.5px).
- Sub-tabs: `How it's built · Columns {n} · Relationships {n} · Quality`, 12.5px, active with 2px ocean underline.
- **"How it's built" card** — `bg #fff`, `1px --line`, radius 10, padding `20px 22px`, `gap 16px`:
  1. **Plain-language summary first.** Inter 15px `--ink`, `line-height 1.6`: "Every general-ledger line Exact Online has booked, with the deleted ones dropped, joined to the date, the account, the GL account and the journal so you can slice by any of them." Generate this from the transformation (AI-written, stored on the table, editable) — it is the primary explanation; SQL is the appendix.
  2. **Provenance trail**: mono eyebrow "FROM", the physical source relation as a mono chip (`bg --softer`, radius 5, 11.5px), `ArrowRight` 13px `--line-strong`, then one ocean chip per joined dimension (`bg --ocean-softer`, `color --ocean`, 12px, radius 5).
  3. **Actions row** (top border `--softer`): **Show SQL / Hide SQL** (outline, `Code2` 13px), **Ask AI to change it** (outline, `Sparkles` 13px ocean — this is today's Refine chat, renamed to a verb; opens `RefineChat` scoped to this table), and right-aligned reminder 11.5px `--muted-2`: "Business users never see this tab."
  4. **SQL panel, collapsed by default.** `bg --ink #0f1a22`, radius 8. Header row: filename Geist Mono 10px 0.08em uppercase `rgba(255,255,255,.6)`, right "incremental · edit to override" at `.4`. Body `<pre>` Geist Mono 11.5px, `line-height 1.7`, `rgba(255,255,255,.8)`, padding 14. Edit turns it into the existing textarea editor + Save/Cancel.
  - **Hard rule: SQL never renders on the topic page, in Ask AI answers, or anywhere a viewer can reach.**

---

## Interactions & behaviour

**Entering manage mode** — click *Manage this data*. Do not navigate; set `?manage=1` via `router.replace` and cross-fade in place:
- Topic layer: `opacity 1 → 0` over **260ms**, `transform: none → scale(0.985) translateY(-10px)` over **320ms**.
- Manage layer: `opacity 0 → 1` (260ms), `transform: scale(1.015) translateY(12px) → none` (320ms).
- Easing for both: `cubic-bezier(0.22, 1, 0.36, 1)` (the `--ease` token). Layers are absolutely positioned siblings; the exiting layer gets `pointer-events: none`.
- The topic title and its icon tile stay in the same optical region (centre-top → header-left) so the user keeps their place. If you can, run this as a shared-element/FLIP transition on the title; the cross-fade is the acceptable fallback and is what the prototype does.
- Respect `prefers-reduced-motion: reduce` — swap instantly, no transform.

**Leaving** — *Done*, `Esc`, or browser back. Clears `?manage=1` and resets the SQL disclosure.

**Other states**
- Hover on question rows and table rows: 120ms colour/border transition only, no movement.
- Deploy: button → disabled + spinner, pending-changes pill → "Deploying…", inline progress strip; on completion the trust line's timestamp updates.
- Loading: skeletons in the shape of the final rows (`components/ui/Skeleton.tsx`); never a spinner in the middle of an empty topic page.
- Empty topic (no KPIs yet): keep identity + ask box, replace "Try asking" with one line — "No saved questions yet — ask anything above." Admin additionally sees "Draft questions with AI" inside manage mode.

## State

```
manage: boolean           // mirrors ?manage=1
activeTab: 'tables' | 'fits' | 'comes-from' | 'metrics' | 'quality' | 'activity'
selectedTableId: number | null
tableSubTab: 'built' | 'columns' | 'relationships' | 'quality'
sqlOpen: boolean          // resets on exit
editingSql: { tableId, sql } | null
refineOpen: boolean
deployState: 'idle' | 'running' | 'done' | 'error'
```

Data: `GET /products/:id` (tables, columns, relationships), `GET /products/:id/kpis` (questions), `GET /build/dashboard` or the product row (status, last refresh), quality checks per table (already on `ProductTable.quality_checks`). One fetch on mount for the topic page — it needs only name, description, KPI questions, dimension display names, freshness and build status.

## Design tokens (all already in `app/globals.css` / `lib/observatory.ts` — do not invent new ones)

Surfaces `--bg #eef0f2`, `--surface #f8f9fa`, `--surface-raised #ffffff`, `--soft #e3e6ea`, `--softer #edeff2`, `--line #d0d5da`, `--line-strong #b8bec5`.
Ink `--ink #0f1a22`, `--ink-2 #334049`, `--ink-3 #4a5660`, `--muted #6b7680`, `--muted-2 #8891a0`.
Accent (the only one) `--ocean #164e63`, `--ocean-hover #103d4f`, `--ocean-soft #d0e1e6`, `--ocean-softer #e8f0f3`. AI accent `--ai #c08a5e` / `--ai-soft #f1e4d6` is used only by the existing Measures badge.
State `--ok #3f7a5c`, `--warn #a06a1c` / `--warn-soft #f1e4c8`, `--err #a43a3a`.
Radii 4 / 6 / 10 / 14. Shadows `--shadow-1`, `--shadow-2`. Motion `--dur-1 120ms`, `--dur-2 240ms`, `--ease cubic-bezier(0.22,1,0.36,1)`.
Type: display **Source Serif 4** (topic title 38/400, panel titles 20–22/400), sans **Inter** (body 15, UI 12.5–13.5), mono **Geist Mono** (eyebrows 10–10.5 uppercase 0.12–0.14em, counts, SQL).

## Assets

Icons: `lucide-react`, already a dependency — `Home, MessageSquare, LayoutGrid, Landmark, Receipt, Library, Plug, Workflow, Inbox, Code2, SlidersHorizontal, RefreshCw, Sparkles, ArrowRight, ChevronLeft, ChevronDown, MoreHorizontal, Search, Bell`. Sizes 13–22px, `strokeWidth 1.5–1.75`. The prototype loads lucide from a CDN purely so it can run as a single file — use the npm package. No images, no custom SVG beyond the existing Clarion wordmark mark in `TopBar.tsx`.

## Copy used (verbatim)

- Mode bar: "Nothing here changes what your team sees until you deploy."
- Trust: "Matches Exact Online as of {relative time} · see data quality"
- Break-down: "Break any of this down by customer, GL account, journal, payment terms or date."
- Reminder: "Business users never see this tab."
- Buttons: "Ask", "Manage this data", "Done", "Refresh", "Deploy changes", "Preview rows", "Run", "Show SQL", "Ask AI to change it", "Edit in Shared data".
- Questions (Finance): "Who owes me money right now?", "What was my balance at month end?", "How did my costs move this quarter?" · (Sales): "How much did I invoice this month?", "Which customers are buying more?", "Is my order intake keeping up?"

## Explicitly removed — do not carry over

TOTAL / HEALTHY / STALE / ERRORS tiles · "Core dimensions" as a product (becomes Shared data) · the Date dimension as a browsable object · table/record counts on topic surfaces · TABLES / FACTS / DIMENSIONS / KPIS counters · the DIMENSIONS(38) snake_case chip cloud · Grid/List/Structure switcher · "Deploy all" as a first-class verb on the business view · the TIP box about Refine · the words "data product", "fact", "dimension", "star schema", "bus matrix" anywhere a viewer can see them.

## Files

- `screens/topic-page.png`, `screens/manage-mode.png`
- `prototype/Your data.dc.html` (interactive; open in a browser — needs `support.js` next to it)
- `prototype/handoff-capture.html` (flat static markup of both screens)

## Repo files worth reading before you start

`frontend/components/layout/IconRail.tsx`, `TopBar.tsx`, `ShellLayout.tsx` · `frontend/app/globals.css`, `frontend/lib/observatory.ts` · `frontend/app/products/page.tsx`, `frontend/components/build/BuildDashboard.tsx` (what is being replaced) · `frontend/app/products/badges.tsx` (RoleBadge/StatusDot) · `frontend/components/products/StarSchemaFlow.tsx`, `LineageFlow.tsx`, `RefineChat.tsx`, `KpiManager.tsx`, `frontend/app/products/QualityTab.tsx` (reused inside manage mode) · `frontend/components/catalog/entityIcons.ts` (topic glyphs).

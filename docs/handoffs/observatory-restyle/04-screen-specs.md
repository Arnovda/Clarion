# Screen specs

For each screen: **route**, **layout**, **must-have elements**, **states**, **reference**. Study the mock file before starting.

---

## Login

**Route.** `/login`, `/register`
**Reference.** `handoff/reference/phase-4b-tier1-screens.html` → Login

**Layout.** Centered 1280px card, two-column grid `1.1fr 1fr`, rounded-lg, shadow-2.
- Left column: atmospheric SVG (observatory rings + data points) on `#0f1a22`. White wordmark top-left, italic serif pull quote bottom-left, mono compliance line at very bottom (`SOC 2 · EU-HOSTED · AES-256`).
- Right column: 56px 64px padding, centered vertically. Mono eyebrow `SIGN IN`. Serif italic h2 `Welcome back.` Lede `Your workspace is one step away.` Email field. Password field with inline "Forgot?" link. Primary lg button, full width. Below: `New to Clarion? Request an invite →` with ocean link.

**States.**
- `/register` swap: eyebrow `CREATE WORKSPACE`, h2 `<em>Start observing.</em>`, lede names the invite flow. Extra field: "Workspace name". CTA: `Create workspace`.
- Error: under field in err color, mono.
- Loading: CTA label becomes `Signing in…` with spinner.

**Responsive.** Below 900px: stack art above form, art becomes 40vh tall.

---

## Empty workspace

**Route.** `/workspace` (when no sources connected)
**Reference.** Phase 4b → Empty workspace

**Layout.** App chrome top + left rail (all rail items disabled except `Sources · START` with ocean label). Main: full-bleed dot-grid background, centered hero.

**Hero.**
- 72px observatory mark, ocean, with pulsing ring behind.
- Serif h1 (52px): `Let's look inside` (serif italic line 2: `your company.`)
- Serif sub: "Connect a source and Clarion will profile it, learn what every column means, and make it ready for plain-language questions."
- Primary lg CTA `Connect your first source` + secondary `Explore with sample data`.
- Below: 3-step mono eyebrow row `1 CONNECT · 2 PROFILE · 3 ASK` (current step ocean).

**States.** Once any source is connected, never show this screen again — route to `/workspace/ask`.

---

## Onboarding

**Route.** `/onboarding` (modal-less, full-page wizard)
**Reference.** Phase 4b → Onboarding

**Shell.** 920px max-width card centered on `--bg`. Header with wordmark left, 5-segment progress bar, `STEP N / 5` mono right. Body 48/56 padding, min-height 440. Footer: back link left, "skip to workspace" + "Continue →" right.

**Steps.**
1. **Connect** — 3×2 grid of source cards (Postgres, MySQL, Snowflake, BigQuery, Redshift, CSV). Click toggles `.on` state.
2. **Permissions** — what we can/can't access, mono bullet list, explicit consent checkbox.
3. **Profile** — live table scan (copy from the reference). Pulsing ok dot per table. AI confidence badge. "Skip to workspace" emphasized because this takes 2 minutes.
4. **First question** — prefilled suggestion chips: `What's our biggest customer?`, `Revenue by channel last quarter`, `Which products are growing?`. Empty chat input. On send: animate to Ask screen.
5. **Invite team** — email invite form, role picker per row. Skip allowed.

**Behavior.** Each step advances the segment bar. Back is always enabled except step 1. Skip from step 3 onward lands on `/workspace/ask`.

---

## Ask

**Route.** `/workspace/ask`
**Reference.** `handoff/reference/phase-4-prototype.html` → Ask

**Two modes.**
- **Landing (no conversation).** Serif hero title `What do you want to know?`. Large centered input (`textarea`, 2 rows tall, serif italic placeholder). 4 suggestion chips below. Recent questions list, collapsed below.
- **Active conversation.** Input pins to bottom. Messages stack above. User message: right-aligned serif italic, no bubble. AI response: `AIResponseBlock` with inline chart card when relevant. Each AI answer shows confidence badge and source tables in mono footer.

**Must-haves.** Keyboard: Cmd+Enter submits. Streaming tokens fade in. Follow-up suggestions appear as chips under the last AI message.

---

## Dashboards

**Route.** `/workspace/dashboards`, `/workspace/dashboards/[id]`
**Reference.** Phase 4 → Dashboards

**Index page.** Serif h1 `Dashboards`, mono eyebrow. Grid of dashboard cards (title serif, subtitle mono, mini chart preview). "New dashboard" button top-right.

**Detail page.** Top: eyebrow `Q3 BRIEFING`, serif h1, supporting copy. KPI grid (4 tiles). Chart grid (12-column: two 6-wide ChartCards). Top-N table. Largest-delta table. Filter bar (mono) sticky top under chrome.

---

## Reports

**Route.** `/workspace/reports`, `/workspace/reports/[id]`
**Reference.** Phase 4 → Reports

**Layout.** Editorial feel. Max-width 1080, two-column `1fr 240px`. Left: full serif body with embedded KPI rows and ChartCards between sections. Right: `OutlineRail` sticky.

**Body rhythm.**
- Eyebrow (mono) + large italic serif title.
- Byline (mono small caps).
- Drop-cap opening paragraph, serif 17px.
- Pull quotes as italic serif, 22px, with ocean left-border.
- Every H2 resets: mono eyebrow + serif h2.

**States.** Print view (`@media print`) strips chrome/rail, keeps body at 12pt.

---

## Notebooks

**Route.** `/workspace/notebooks`, `/workspace/notebooks/[id]`
**Reference.** Phase 4b → Notebook

**Index.** Simple list of notebook cards: serif title, mono meta (author · cells · last edited). "New notebook" CTA. "From template" secondary.

**Editor.** Three-column grid `220px 1fr 240px`:
- Left: notebook list + templates (from reference).
- Center: notebook main. Crumb (mono) → serif h1 → mono meta row → cells.
- Right: OutlineRail + shared-with panel.

**Cell types.** Every cell from `03-component-specs.md#notebookcell`. Add-cell chip strip between cells on hover, and always at the bottom.

**Execution model.** Jupyter-like. Each cell has independent run button and runtime display. Filter cell tagged `GLOBAL` applies to all cells below unless they opt out.

**Collaboration.** Solo author. Others view or comment. Comment mode opens inline thread on the left gutter.

---

## Semantic layer

**Route.** `/model/semantic`
**Reference.** Phase 4 → Semantic

**Layout.** Left rail: definition list with filter. Main: definition detail. Each definition shows an AI-authored vs human-authored badge (AI = `ai` badge, human = `ocean` badge with person). Definition card: name (mono), serif description, SQL body, usage examples. Edit locks for AI-authored definitions require confirm.

---

## Products (star schema)

**Route.** `/model/products`
**Reference.** Phase 4 → Products

**Layout.** Full-bleed canvas with `--line` dot grid at 28px. Product nodes as cards on the canvas, connected with ocean edges. Pan/zoom. Side panel on select: table columns, relationships, quality score.

---

## Quality

**Route.** `/model/quality`
**Reference.** Phase 4 → Quality

**Layout.** Top row: 3 large trust rings (SVG circle progress). Middle: rule list (mono rule name, status badge, last-run mono timestamp, affected-rows count). Filter bar. Row expand reveals failures.

---

## Sources

**Route.** `/admin/sources`
**Reference.** Phase 4 → Sources

**Layout.** Grid of `SourceCard`s. "Add source" CTA. Click opens detail drawer: config, schedule, last sync log, test connection button.

---

## Settings / Admin

No bespoke design. All admin pages inherit Card + Table + Button + Input. Use the page header pattern (eyebrow + serif h2). Sections become Cards with serif h3 titles. No screen in this group should need one-off styling.

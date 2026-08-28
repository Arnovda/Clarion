# Ask AI — the worksheet layout (owner's build brief + implementation mapping)

**Status: phases 1–4 SHIPPED (2026-08-28, owner go-ahead "Let's go") — step
model + tree persistence + URL routing, one-step canvas, spine with
selection/muting/keyboard nav, branching on ask. Phases 5–8 (assumption
menus + branching on change, re-run/star, collapsing/rename/responsive,
state polish) are the next slice. See CLAUDE.md Current State for the
implementation record.**

Part 1 is the owner's build brief (2026-08-28, delivered as
`clarionworksheetspec.md.pdf` with two mockups), transcribed faithfully.
Part 2 is the implementation mapping against the codebase as of `823c55c`
(Ask AI R1–R3 shipped): what already exists, what is genuinely new, where
the spec is silent and a decision is needed, and the build sequence.

---

## Part 1 — the brief (owner, verbatim in substance)

Replaces the current stacked-chat layout with a persistent **worksheet**:
one canvas that holds the current answer, and a left spine that holds the
history of how you got there.

**The core idea: a question and its answer are not a chat message, they
are a STEP** — a saved snapshot of a question, the assumptions in force,
the result, the SQL, and the data timestamp. Steps form a tree. The canvas
renders one step at a time.

### 1. Layout

```
┌────┬──────────────┬────────────────────────────────────────────┐
│    │  THREAD      │  CANVAS                                    │
│ N  │  (spine)     │  ┌──────────────────────────────────────┐  │
│ A  │              │  │ banner (conditional)                 │  │
│ V  │  ○ Step 1    │  ├──────────────────────────────────────┤  │
│    │  ○ Step 2    │  │ question (serif italic)              │  │
│ 48 │  ● Step 3    │  │ reading: [chip ▾][chip ▾][chip ▾][+ add]│ │
│ px │    ┆ ○ 3a    │  ├──────────────────────────────────────┤  │
│    │  ○ Step 4    │  │ lede number + note                   │  │
│    │              │  │ result rows / chart                  │  │
│    │  ⌄ collapse  │  │ view switcher · show SQL             │  │
│    │              │  ├──────────────────────────────────────┤  │
│    │              │  │ as-of + re-run                       │  │
│    │              │  └──────────────────────────────────────┘  │
│    │              │  ┌──────────────────────────────────────┐  │
│    │              │  │ ask input (sticky bottom)            │  │
│    │              │  └──────────────────────────────────────┘  │
└────┴──────────────┴────────────────────────────────────────────┘
  48       220                    flexible, max 880
```

| Region | Width | Notes |
|---|---|---|
| Nav rail | 48px fixed | icon-only, current nav collapsed to icons; tooltip on hover |
| Thread spine | 220px fixed | collapsible to 0 with a chevron; state persists per user |
| Canvas | 1fr | content capped at 880px, centred in remaining space |

The existing full-width conversation list is removed from this page. It
moves behind an "All conversations" entry that opens a slide-over panel.
**This is the change that buys back the horizontal space — don't skip it.**

Below 1100px the spine collapses by default and is reachable via a toggle.
Below 760px the spine becomes a top-anchored horizontal scroller of step
chips; the canvas takes full width.

### 2. Tokens

Reuse the existing Clarion palette. Nothing new is introduced.

```css
--teal-900: #04342C;   /* dark bar backgrounds */
--teal-600: #0F6E56;   /* primary bar, selected accent, active dot */
--teal-400: #1D9E75;   /* secondary bars, links */
--teal-50:  #E1F5EE;   /* selected row bg, chip fill, banner bg */
```

Typography:
- **Question** — serif italic, 18px/1.3, left-aligned. Not centred. This
  is the single largest change to the page's character.
- Micro-labels (`reading`, `this thread`, timestamps) — mono, 10px,
  `letter-spacing: 0.1em`, lowercase, muted.
- Lede number — 25px, weight 500, `letter-spacing: -0.02em`.
- Body/note — 12.5px/1.55, secondary text colour.
- Row labels — 12px. Row values — mono 11.5px, right-aligned in a fixed
  50px column.

Borders are 0.5px hairlines throughout. Radius 8px on controls, 12px on
the outer canvas card. No shadows.

### 3. Data model

Steps are persisted server-side and belong to a thread. **The tree is
derived from `parentId` — do not store an ordered array.**

```ts
type Step = {
  id: string
  parentId: string | null  // null = root of the thread
  threadId: string
  label: string            // short, auto-generated, user-editable
  question: string         // full text as asked
  assumptions: Assumption[] // as resolved at ask time
  result: Result           // frozen snapshot
  sql: string
  askedAt: string          // ISO
  dataAsOf: string         // ISO — freshness of the warehouse at ask time
  durationMs: number
  starred: boolean
}
type Assumption = {
  id: string
  label: string            // "revenue excl. VAT"
  detail: string           // "line_amount_dc is the standard reporting measure"
  options: { value: string; label: string }[]
  value: string
}
type Result = {
  lede: { value: string; caption: string } | null
  note: string
  rows: { label: string; value: string; pct: number }[]
  columns?: Column[]       // for table view
  view: 'bars' | 'line' | 'pie' | 'table'
}
```

### 4. Behaviour

**4.1 Selecting a step.** Clicking a step in the spine restores its
snapshot to the canvas: question, assumption chips at their stored values,
result, SQL, timestamps. No network call — stored state, not a re-query.
Selecting an ancestor does not delete or hide its descendants; steps after
the selection render muted. Selection is in the URL
(`/ask/:threadId/:stepId`) so a step is linkable and back works.

**4.2 Branching.** Asking, or changing an assumption, while a non-leaf
step is selected creates a new CHILD of the selected step. Never mutates
the selected step, never invalidates its children. The child appears
indented under its parent (dashed rule) and becomes selected. Siblings
ordered by `askedAt`. On a non-leaf step show the banner: *Viewing an
earlier step — asking from here starts a new branch* (teal-50 bg,
teal-900 text, 11.5px). Hide it on leaf steps. Nesting caps at 3 indent
levels; deeper branches keep level-3 indent and get a `↳ from "{parent
label}"` line above the question.

**4.3 Assumptions as controls.** Each assumption is a chip with a
chevron; clicking opens a menu of `options`, `detail` as help text at the
top. Choosing a different value: creates a new child step (per 4.2),
carries the question text unchanged, re-runs with the new assumption set,
auto-labels the step by the diff (e.g. *Same, drafts included*). `+ add`
lists assumptions Clarion detected but resolved silently — how a user
tightens a question without rewriting it.

**4.4 Snapshots and freshness.** Results are frozen at ask time; a
restored step shows what the user saw, not what the warehouse says now.
Footer always shows `answered {relative} · data {relative} old`; if
`dataAsOf` is >24h behind the current warehouse refresh, append `· newer
data available` in the warning colour. **Never silently refresh.**
Re-run ↻ executes the same question + assumptions against current data
and creates a new SIBLING step labelled `{label} (re-run)`.

**4.5 Labels.** Auto-generate from the question: drop leading
interrogatives, cap at 32 chars, no trailing punctuation ("Who are my top
5 customers by total order value?" → "Top 5 by order value").
Double-click to rename inline; Enter commits, Escape cancels, empty
reverts to the auto label.

**4.6 Collapsing.** Above 12 steps, collapse everything except: the first
step, the selected step and its ancestors, the last three steps, and any
starred step. Collapsed runs render as one row: `5 earlier steps` with a
chevron that expands in place. Build this NOW — retrofitting after people
have 40-step threads is much harder.

**4.7 The ask input.** Sticky to the bottom of the canvas column (not the
viewport). Placeholder: leaf → *Ask a follow-up*; non-leaf → *Ask from
here — this will branch*. Submitting scrolls to the top of the new step,
focus on the result region.

### 5. States

- **Loading:** the spine gets the new item immediately (auto-label +
  pulsing dot); the canvas shows the question + inherited chips right
  away with the result region skeletonised. Don't blank the previous
  answer before the new one arrives.
- **Query error:** step stays in the spine with a warning dot; canvas
  says what failed and what to do, SQL in a disclosure. Never a raw
  exception string.
- **Empty result:** "No rows matched. Try widening the date range or
  removing an assumption." Chips shown prominently — usually the cause.
- **Empty thread:** ask input centred with three example questions from
  the workspace's own tables.

### 6. Accessibility

Spine is `nav > ul[role=tree]`, items `role=treeitem` with `aria-level` /
`aria-selected` / `aria-expanded`. Full keyboard support (↑/↓ move, Enter
selects, ←/→ collapse/expand, Home/End). Selecting moves focus to the
canvas heading + polite live region announcement. Chips are `button` with
`aria-haspopup="menu"`; real menus, roving tabindex, Escape closes.
Colour never carries meaning alone. Respect `prefers-reduced-motion`.

### 7. Build order

1. Step data model, tree derivation, persistence, URL routing.
2. Static canvas with one step rendered from real data.
3. Spine with selection, muting, keyboard nav.
4. Branching on ask.
5. Assumption chips as menus, branching on change.
6. Re-run, freshness warnings, star.
7. Collapsing, inline rename, responsive breakpoints.
8. Loading, error, empty states.

**Ship 1–4 before touching 5.** Branching on ask is the piece that proves
the model works; if it feels wrong, the assumption controls will feel
wrong for the same reason.

### 8. Not in scope

- Opening a branch as its own thread (wait for real heavy branching).
- Diffing two steps side by side (a second layout, not a feature of this one).
- Drag-to-reorder steps (order is causal, not editorial).
- Any chart-engine change beyond removing the grey container — bars sit
  on the page background with values printed at the row ends.

---

## Part 2 — implementation mapping (assessment, 2026-08-28)

### Verdict

**This is the structural fix for the pain the R1–R3 releases treated
symptomatically.** "A really long chat and think process" was never a
styling problem — it is what happens when a *session of analysis* is
poured into a *messaging* container. The worksheet names the real unit
(a step = frozen snapshot of question + assumptions + result + SQL +
freshness) and the real shape (a tree, because analysis branches). Almost
everything shipped in R1–R3 becomes the worksheet's substance rather than
waste: meta persistence IS the snapshot, the quieted receipt IS the step
footer, assumption chips ARE the branch trigger, saved/verified questions
and pin-to-dashboard are step actions. Nothing shipped this week fights
this design.

Two specifics in the brief are better than what I would have proposed:
branching on *assumption change* (competitors — Genie, Spotter, Cortex
Analyst — are all linear chats; none has a causal tree), and **frozen
snapshots + explicit re-run** (extends the "never silently refresh"
honesty rule to time itself).

### What already exists (the mapping is clean)

| Spec concept | Exists today as | Gap |
|---|---|---|
| Thread | `conversations` | none — rename in UI only |
| Step | `conversation_messages` + `meta` (migration 82: assumptions, sources, answeredInMs, repairSummary, visualization…) | needs `parent_message_id`, `label`, `starred`, `data_as_of` columns |
| `result.view` | `meta.visualization` hint | view SWITCHER is new (client-only) |
| `dataAsOf` | `resolveAnswerSources` oldest date (computed per answer) | persist it at ask time |
| Step footer | the quieted receipt (`From … · data as of … · Ns`, marks only when exceptional) | near-identical; mockup 2's `✓ checked · 7d old` matches |
| Auto-label | — | pure function, spec gives the rule (cleanForWhy is a cousin) |
| "All conversations" slide-over | `ChatSidebar` (context panel) | becomes a slide-over |
| Loading state | spine item + skeleton ≙ ThinkingBubble timeline content | reposition, don't rebuild |
| Error state | gated ErrorDetail + friendly message | matches spec |
| Palette | Observatory `ocean` tokens | map `--teal-*` → existing ocean ramp (brief says "reuse the existing palette"; the teal hexes are illustrative) |

### The one genuinely NEW backend piece: structured assumptions

Today `assumptions` is `string[]` — sentences the model volunteered.
The worksheet needs `{ id, label, detail, options[], value }` **including
the silently-resolved ones** (for `+ add`). That means the NL→SQL prompts
must emit structured assumptions with alternatives, and — the part that
costs real care — **choosing another option must produce a query that
differs in exactly that assumption.** Two honest ways to do it:

- **(a) Re-generate with a constraint** — same question + "assumption X
  is now VALUE" pinned in the prompt; validate that the other assumptions
  survived unchanged. Simple, uses the existing path, model may drift.
- **(b) The model emits, per option, a SQL patch** at ask time. Precise
  but expensive and fragile.

Recommendation: **(a)**, with the R1 lesson applied (any model-written
field is parsed tolerantly at every consumer; a malformed assumption
degrades to today's plain-sentence chip, never a crash). This is also
where the verified tier hooks in: a verified saved question can store its
assumption set, and an exact match with DIFFERENT chip values is a
near-miss, not a hit.

### Where the spec is silent — proposed answers (queued for owner)

1. **Repair / "double-checking"** → maps cleanly onto the spec's loading
   state: the spine item keeps its pulsing dot through the ~10s hold; if
   revealed provisionally the step carries the `checking` strip; the
   settle updates the SAME step (correction is not a new step — it is the
   step becoming true). `repairSummary` stays in the Details disclosure.
2. **Clarify intent** (model asks which interpretation) → renders in the
   canvas as a question card; the chosen option creates the step. A
   clarification is not itself a step (no result to snapshot).
3. **Investigate + forecast** → step *kinds*. The investigation trail and
   the forecast chart render as the step's result region. Nothing forces
   them into v1 of the canvas — they can keep their current rendering
   inside it.
4. **Roles** — unchanged non-negotiables: `show SQL` control and the SQL
   disclosure exist only for admin/analyst (`canSeeSql`); viewers get the
   same worksheet minus SQL affordances. The spec's error-state SQL
   disclosure is likewise gated.
5. **Step actions** — Save question / Pin to dashboard / feedback /
   export (all R3) live on the canvas step, not in the spine.
6. **Existing conversations** — no rewrite: rows with no
   `parent_message_id` in a legacy thread are chained linearly at read
   time (each assistant message's parent = the previous one). Old
   threads open as a straight spine.
7. **URL** — spec says `/ask/:threadId/:stepId`; the app's route is
   `/query`. Keep `/query?t=<thread>&s=<step>` (App Router page exists,
   deep links already handled there) unless the owner wants the rename.

### Sizing (relative to the releases just shipped)

Phases 1–4 (model, canvas, spine, branch-on-ask) ≈ one R1+R2-scale
slice: one migration (4 columns on `conversation_messages`), light route
work (label PATCH, tree in the GET), and a substantial /query page
rebuild that REUSES MessageBubble's leaf components (charts, KPI, table,
receipt, actions). Phases 5–8 (assumption menus + branching on change,
re-run, collapsing, states) ≈ a second slice, the prompt-contract work
being the risky part — which is exactly why the owner's "ship 1–4 first"
order is right and is adopted as-is.

### What NOT to do (affirming the brief's §8, plus)

- No branch-to-thread, no side-by-side diff, no drag-reorder (per brief).
- Don't rebuild the chart components — restyle their container only.
- Don't store an ordered array or materialised path for the tree —
  `parentId` + `askedAt` derives everything (per brief §3).
- Don't let the worksheet widen SQL visibility or ship numeric
  confidence to viewers — the R1 role model carries over untouched.

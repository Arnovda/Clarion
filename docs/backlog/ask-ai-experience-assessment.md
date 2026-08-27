# Ask AI experience assessment — the answer is the product

**Date:** 2026-08-27 · **Status:** assessment + proposal, awaiting owner review · **Code changed:** none

The owner asked: zoom out on the Ask AI chat and design the optimal end-user
experience — what should the chat have, how should AI reasoning be shown, how
should trust be communicated (assumptions, confidence, self-correction), and
how do we get real "wow" while staying professional. Specific pain named: when
the AI corrects itself, the transcript becomes a very long chat-and-think dump.

**Method.** Three full code investigations (frontend chat surface, backend
query flow, trust/context adjacencies — every claim carries file:line) crossed
with external research on the 2025–26 state of the art (Databricks AI/BI Genie,
ThoughtSpot Spotter 3, Snowflake Cortex Analyst / Intelligence, Amazon Q in
QuickSight, Power BI Copilot, Tableau Pulse, Perplexity, ChatGPT/Claude
reasoning display, NN/g + PAIR trust research). Companion docs:
`dashboard-experience-assessment.md` (the sibling assessment for dashboards)
and `functionality-gap-analysis.md` (G10/G13/G14 verified again here).

---

## §0 The verdict in five sentences

1. **The engine is ahead of the experience.** Clarion already *computes* nearly
   every trust signal the best products in the world *display* — assumptions,
   confidence sub-scores, tables used, streamed reasoning, a self-repair loop,
   per-table freshness, a provenance ladder, column lineage, quality scores —
   and then shows them to the wrong people, at the wrong moments, or not at all.
2. **Trust signals are inverted.** A business user sees a confidence percentage
   and a sub-score breakdown only when Clarion *refuses* (where it reads as
   blame), and nothing at all when Clarion *succeeds* (`MessageBubble.tsx:959`
   vs `:1094`). Best-in-class products do the exact opposite — and none of them
   show a numeric confidence score to business users at all.
3. **Self-correction is presented as an incident, not diligence.** A corrected
   answer produces ~1,500–2,500px of never-collapsing diagnostic transcript,
   the correction is marked by a 10px eyebrow — and the corrected answer is
   never persisted, so a reload shows the *wrong* answer again, and export
   downloads the pre-correction rows.
4. **Answers are dead ends.** No pin-to-dashboard, no saved/scheduled
   questions, no follow-up suggestions, no link from an answer to the catalog
   page of the table it used — and thumbs-down feedback lands in a row the
   admin gaps list can structurally never display.
5. **The fix is mostly presentation and wiring, not new AI.** The single
   biggest unlock is one redesigned answer card + one redesigned progress
   component, fed by data that already exists (`widget-context` endpoint,
   `tables_used`, `product_tables.last_run_at`, `semantic_source`,
   `assumptions[]`).

---

## §1 What exists today (inventory, condensed)

### 1.1 The pipeline (backend)

The chat calls `POST /api/query/think` (SSE, `routes/query.ts:1121`); the
dashboards page calls the non-streaming `POST /api/query` (`query.ts:244`) —
two parallel implementations of the same flow that have already drifted (the
source-layer context builder exists **three times**: `query.ts:429-630`,
`:1269-1370`, `:2036-2071`, each with different quality-hint content). Sibling
endpoints: `/repair` (SSE, `:1583`), `/cross-view` (`:1818`), `/forecast`
(`:2003`), `/starters` (`:2179`).

Per question: layer resolution (`resolveDataLayer`, `:58`) → context build
(product: `services/productContext.ts:113` — tables/columns/relationships/KPI
formulas/rollups/grids/glossary; source: inline, with quality hints and join
paths) → Sonnet with 8k thinking tokens streamed (`AIService.ts:1350-1369`) →
confidence gate (`shouldBlockQuery`, `query.ts:72-89`: overall < 0.70 or any
sub-score < 0.50) → entity pre-flight (source layer only, `:1461-1528`) →
execute → Haiku answer formatting (`ANSWER_FORMAT_SYSTEM`,
`nlToSqlPrompt.ts:322`) → Haiku result sanity check (skipped when confidence
≥ 0.9, `AIService.ts:1266-1278`) → `done` with answer, rows (≤200), sql,
confidence, subScores, assumptions, tablesUsed, visualization hint.

If the sanity check returns a warning, the **frontend** auto-starts the repair
loop (`page.tsx:911-913`): up to 5 Sonnet turns of diagnostic queries
(`query.ts:1583-1812`), streamed as `thinking` / `data_query` / `query_result`
/ `revised_sql` / `revised_answer` / `clarification` events.

### 1.2 The surface (frontend)

`frontend/app/query/` (3,472 LOC). The answer bubble (`MessageBubble.tsx:990`)
carries: brain button toggling the raw thinking text in a 288px speech bubble
(any role); answer prose (`**bold**` only — no markdown lists/links); clarify
chips; forecast chart; KPI tile grid (only for 1-row × 2–6-col shapes); chart +
always-visible data table; assumptions footnote (all roles); warning banner;
confidence/layer/tables-used (admin only); SQL (admin + toggle); 👍👎; "🕵️
Why?"; CSV/Excel. While waiting: `ThinkingBubble` (`thinking.tsx:35`) reveals
thinking at 220ms/word — always truncated mid-stream when the answer lands —
then vanishes. During repair: `ThinkingPanel` (`thinking.tsx:132`) stacks up to
~16 blocks and **never collapses**.

### 1.3 What already exists around the chat, unwired

- `POST /dashboards/widget-context` (`dashboards.ts:2087`) — takes SQL, returns
  per-table kind/description/**lastRefreshedAt**/product/source. Built for
  dashboard provenance; the chat never calls it.
- `WidgetProvenance.tsx:186-193` — the pattern of deep-linking a table name to
  `/catalog?table=` through `humanizeTableName`; the catalog degrades to search
  on a miss (`catalog/page.tsx:250-255`). The chat prints raw
  `tables: fact_receivables` instead (`MessageBubble.tsx:1099`).
- `WidgetProvenance.tsx:97-103` sends the chat `?contextWidget=…` — the chat
  **ignores the param entirely**.
- `/investigate` — a fully built, persisted, 6-step root-cause agent
  (`investigateService.ts`) with **zero nav links** (G10 re-verified). Reachable
  from chat only via an English-only `/^why\b/` classifier that needs a resolved
  productId.
- Morning brief deltas (`GET /api/briefs/today`, no role gate) — exactly the
  shape "what changed since yesterday?" needs; chat has no awareness.
- `semantic_source` provenance ladder (declared/curated/ai/human) and
  `vendor_description` — the strongest "why believe this label" data in the
  product; absent from chat.
- Conversation persistence is real (`conversation_messages` stores answer, SQL,
  tables_used, confidence, reasoning, ≤200 rows) — but `persistMessage`
  (`page.tsx:241-261`) drops `assumptions`, `subScores`, `uncertaintyNotes`,
  `intent/options`, `visualization`, `forecast`, `flagReason`, and the repaired
  answer entirely.

---

## §2 What best-in-class looks like in 2026 (external research)

Full memo with sources in the session artifact; the nine patterns that
separate leaders from merely-functional:

1. **Tiered, human-attributed trust marks — never numeric confidence.** Genie
   marks answers "Trusted" when they route through curator-registered SQL;
   Cortex Analyst has a Verified Query Repository; Power BI has verified
   answers and warns on un-curated models; ThoughtSpot has verified Liveboards
   whose verification visibly decays on edit. **None of them show a business
   user "92%".** Research (Google PAIR, NN/g, miscalibration studies) says
   numeric confidence is unactionable and shifts behaviour even when wrong.
   Certainty is expressed as: badge, clarifying question, or warning.
2. **A plain-language "how I got this" expander on every answer, distinct from
   the SQL.** Genie's Analysis section, Power BI's "show reasoning",
   QuickSight's Explainability: interpretation of the question + data used +
   logical steps, written for non-technical readers. SQL stays behind a
   separate, role-gated affordance.
3. **Restated assumptions the user can edit in place.** QuickSight's
   restatement bar: the interpretation is the correction surface — fix "which
   'sales'? which period?" by clicking a chip, not re-typing the question.
4. **Clarify instead of guess, framed as a feature** — a first-class answer
   type, not an apology.
5. **Progressive, honest, domain-language status during the wait; a collapsed
   one-line receipt after.** Perplexity's Searching→Reading→Writing; ChatGPT's
   "Thought for 12s". Never raw chain of thought, never expanded by default.
   Visible intermediate progress measurably increases willingness to wait.
6. **Self-correction narrated as diligence, compressed into named steps.**
   Spotter 3's whole marketing is "checks its own work"; Snowflake's agent loop
   has a named *Reflect* phase. The repair loop's visible artifact should be a
   short past-tense story ("checked the sign convention on amounts; corrected"),
   expandable for detail — validation as a selling point, not an incident.
7. **A closed feedback→curation loop with a named owner surface.** Genie:
   thumbs land in a Monitor tab; "Add as instruction" promotes a good exchange
   into the trusted set; benchmark suites score accuracy — and Databricks tells
   teams to *publish* the accuracy to users. Feedback that goes nowhere visible
   is decoration.
8. **Answers are destinations:** pin to dashboard from chat (Spotter),
   context-generated follow-up chips (Tableau Pulse, Perplexity), subscribe /
   alert / schedule from an answer (Pulse).
9. **Verification decays and absence signals.** Un-curated ≠ silently identical
   to curated: Power BI warns on un-prepped models; ThoughtSpot re-flags edited
   verified boards.

Underlying all nine: NN/g's finding that chat UIs *structurally discourage*
error-checking — a footer disclaimer plus an inviting input box pushes users
past mistakes, so verification aids must be inline in the answer itself.

---

## §3 Verdicts

### V1 — The trust display is inverted, and numeric confidence is the wrong currency

On success, confidence/layer/tables are admin-only (`MessageBubble.tsx:
1094-1100`). On refusal, everyone gets the percentage, the Schema/Joins/Formula
sub-score pills, and the model's raw uncertainty prose (`:959-966`,
`blockedUserMessage` at `query.ts:102-107`). The 2026-07-15 assessment flagged
this; it is still live. Meanwhile the industry has converged on categorical,
human-attributed marks. Clarion should **stop showing percentages to business
users in both directions** and introduce a three-state trust vocabulary
(§5.4). The numeric machinery stays — as the *input* to the categorical
display and as admin/analyst detail.

### V2 — Self-correction is the best feature presented in the worst way

The repair loop is genuinely differentiating — a real agentic verify-and-fix
pass that competitors market hard ("Spotter checks its own work"). Clarion
buries it: a wall of 💭/🔍/✏️ blocks (viewers see labels announcing SQL they
can't see), the original answer silently mutated in place, a 10px
"CORRECTED AFTER INVESTIGATION" eyebrow, and then — the structural defect —
**nothing is persisted**: `RepairState` is documented "never serialised"
(`types.ts:138`), there is no message-update route, so reload resurrects the
wrong answer with its warning and no marker, and CSV/Excel export reads the
stale pre-correction rows (`conversations.ts:289`). Answering the repair
agent's clarifying question wipes the visible trail and restarts the panel
(`page.tsx:454`). This is the owner's named pain, and it is fixable per §5.3.

### V3 — The reasoning display is the wrong paradigm at every stage

During the wait: a 220ms/word reveal of raw extended thinking that is always
truncated mid-stream (`thinking.tsx:56-72`), phase strings that leak "star
schema" to viewers (`query.ts:1163,1236`), and a spinner that never fires on
the default product path because `isExecuting` only matches the source-layer
strings (`thinking.tsx:74`). After the answer: the thinking vanishes into a
brain-button comic bubble showing **raw chain of thought to every role**.
Industry consensus: narrated/summarized steps in domain language while
waiting; a collapsed one-line receipt after; raw CoT never the UI.

### V4 — Answers are dead ends; feedback is a black hole

No pin, no save, no schedule, no follow-up chips, no catalog links (G13/G14
re-verified — zero hits for any saved-question implementation; the Build chat
prompt even warns users about "saved questions" that don't exist,
`buildChatPrompt.ts:72`). Thumbs-down creates a `definition_gaps` row with
`query_log_id = NULL` (`conversations.ts:250-261`) while the admin gaps list
inner-joins `query_log` (`reports.ts:91-92`) — **every user-reported bad
answer is invisible to the people who could fix it**. Thumbs-up does nothing
at all. The feedback comment column exists but no UI ever collects it.

### V5 — Two roles are wronged and one path is unpoliced

The chat keys everything off `isAdmin` (`page.tsx:133`) and ignores
`lib/role.ts` — **analysts are treated as viewers** (no SQL, no source toggle,
no debug), contradicting the role table and the backend, which ships analysts
error details the UI then hides (`query.ts:1567`). Worse, investigate mode
renders raw SQL + result previews to **every role** including viewers
(`InvestigationView.tsx:139-166`) — a live violation of the "never show raw
SQL to a business user" non-negotiable. And `applyDataPolicies` runs on
exactly one of five query paths (`query.ts:384` — product layer of `POST /`
only): **the chat surface is entirely unpoliced**, and the `policyNotice` the
one path produces is never rendered by any frontend.

### V6 — The substrate has drifted into three parallel pipelines

`POST /` vs `/think` vs `/forecast` re-implement context building with
different content; entity pre-flight exists only on the source layer (so the
disambiguation UI is unreachable on the default path); the NL→SQL cache is
used **only by the dashboard's endpoint, never by the chat**
(`generateSqlStreaming` has no cache branch); forecast routing is a
client-side English keyword scan (`page.tsx:794-801`) where `project` matches
"projects" and the backend's own `isForecastQuestion` is imported and never
called (`query.ts:17`); three different confidence thresholds exist across
sibling endpoints (0.70+subscores / 0.70 flat / 0.50). Every experience
improvement lands three times or drifts — same disease the dashboard
assessment found, same cure: consolidate before decorating.

### V7 — The product is English-only for a Dutch-speaking user base

No prompt instructs the model to answer in the user's language (verified
across every file in `ai/prompts/`) — a Dutch question gets an English answer
as a side effect of an English system prompt. The forecast keywords and the
investigate classifier (`/^why\b/`) are English-only, so *"Waarom daalde de
omzet?"* silently degrades to plain ask mode. One answer bubble renders
`en-GB` KPI tiles above an `nl-BE` chart axis with an `en-US` forecast
tooltip (`MessageBubble.tsx:1306` / `:115` / `:391`). For a Belgian SMB
product, mirroring the user's language in answers is the cheapest wow on the
whole list.

---

## §4 Consolidated defect list

Ranked: correctness/safety first, then trust, then experience. Evidence
inline; items marked ★ are load-bearing for the target experience.

**A. Correctness / safety**
1. ★ Corrected answers never persisted; reload shows the wrong answer, export
   downloads pre-correction rows (`page.tsx:495-509`, no update route in
   `conversations.ts`, export at `conversations.ts:289`).
2. `applyDataPolicies` on 1 of 5 paths; `policyNotice` never rendered
   (`query.ts:384,416`).
3. Investigate mode shows raw SQL + previews to all roles
   (`InvestigationView.tsx:139-166`) — non-negotiable violation.
4. Entity pre-flight builds SQL by string concatenation with quote-doubling
   only, interpolates catalog names unescaped (`query.ts:950,965,988`);
   `SELECT *` ambiguity rows (full records, potentially PII) stream to the
   browser and persist to `conversation_messages` bypassing policies.
5. Full model JSON (SQL + confidence) streamed to every role as `text` deltas
   the frontend discards (`AIService.ts:1369` vs `page.tsx:858-923`);
   `sql_ready` emitted before the block gate (`query.ts:1213,1431`); raw DB
   errors streamed to all roles in repair `thinking` events
   (`query.ts:1755,1775`); `/repair` trusts client-supplied history/SQL/rows
   with no validation (`query.ts:1596-1699`); `/think`,`/repair`,
   `/cross-view`,`/forecast` have no request schemas.
6. ★ Thumbs-down gaps unreachable (NULL `query_log_id` + inner join;
   `conversations.ts:254` vs `reports.ts:91`).
7. Stale-closure bug: toggling "Query source data" doesn't take effect until
   the *second* question (`send` deps omit `useSourceLayer`, `page.tsx:959`).
8. `persistMessage` drops assumptions/subScores/uncertaintyNotes/intent/
   options/visualization/forecast/flagReason — on reload, clarify chips,
   assumptions, chart choice and forecasts silently vanish (`page.tsx:241-261`,
   `conversations.ts:148-198`).

**B. Trust display**
9. ★ Confidence/layer/tables admin-only on success, shown to all on refusal
   (`MessageBubble.tsx:1094` vs `:959`).
10. ★ Raw chain of thought exposed to all roles via the brain bubble
    (`MessageBubble.tsx:1011-1034`).
11. Freshness line is tenant-wide, shows the *newest* date coloured by the
    *worst* source, hides itself when fresh, absent from the empty state
    (`page.tsx:1104-1116`, `freshness.ts:80-92`); the model itself gets no
    freshness in context (verified: no timestamps in `productContext.ts`).
12. Assumptions render as static italics — not clickable, not editable, gone
    after reload (`MessageBubble.tsx:1079-1086`).
13. `LowConfidenceGuide` references navigation labels that no longer exist
    ("Definitions → Tables & Columns") and gives viewers a curator CTA; on the
    product layer it reads absent debug fields and falsely advises "run Setup
    to profile your database" (`MessageBubble.tsx:535-574`, `query.ts:1262`).

**C. Experience**
14. ★ Repair transcript: ~16 never-collapsing blocks, ~1,500–2,500px per
    corrected question; viewers see labels for SQL they can't see; clarify
    resets the trail (`thinking.tsx:132-267`, `page.tsx:454`).
15. ★ Thinking reveal at 220ms/word always truncated; spinner never fires on
    product layer; "star schema" phase strings reach viewers; thinking
    vanishes instead of collapsing (`thinking.tsx:56-107`, `query.ts:1163`).
16. Answer prose renderer supports `**bold**` only — no lists, no links
    (`components.tsx:56`).
17. Single-value answers (1 row × 1 col — the most common shape) render a
    one-cell table with an inert "Table" pill restating the sentence above
    (`isKpiShaped` requires ≥2 cols, `MessageBubble.tsx:1250-1262`).
18. Ambiguity picker hardcodes `customer_id` for every entity type
    (`MessageBubble.tsx:866`); clarify chips post machine-written
    interpretations as fake user messages (`:1058`).
19. Analysts = viewers throughout (`page.tsx:133` vs `lib/role.ts`).
20. Chat never uses the SQL cache; follow-ups disable caching and carry only
    the last 5 messages (`query.ts:157-160,293`); answer formatter runs at
    default temperature (non-deterministic prose for identical rows,
    `AIService.ts:1403`) and never learns the true row count
    (`nlToSqlPrompt.ts:337-343`).
21. Forecast: client-side keyword routing misfires ("project"), no
    conversation history, not persisted (reload degrades to a bar chart),
    `en-US` tooltip (`page.tsx:794-818`, `MessageBubble.tsx:391`).
22. Export filenames collide per conversation; failure = native `alert()`
    (`page.tsx:436-440`). Delete conversation and Clear chat have no
    confirmation (`page.tsx:364,1044`). Sidebar paginates at 30 with no "load
    more" (`conversations.ts:34`). "New conversation" title never refreshes
    client-side (`conversations.ts:200-211`).
23. Dead code: `SourceSelector` never rendered; `availableDomains` write-only;
    `selectedDomains` never set; `contextWidget` param dropped;
    `isForecastQuestion` imported unused; `Message.wasRepaired`'s documented
    guard purpose unimplemented.

---

## §5 The target experience

Design principle, stated once: **the answer is the product**. Everything else
— reasoning, checks, sources, freshness — exists to make one number or one
sentence believable in five seconds and auditable in one click. Layered
disclosure, one component, three depths: glance (everyone), audit (curious
users), forensics (admin/analyst).

### 5.1 The answer card (one redesigned component)

Top to bottom:

1. **The answer, big.** Plain-language sentence(s). For single-value answers,
   a proper KPI treatment (large number + label + period), not a one-cell
   table. Markdown-lite rendering (bold, lists, line breaks). Answered in the
   user's language (§5.7).
2. **The visualization** — current chart/table switcher, kept; table becomes a
   collapsed "Show the N rows" disclosure when a chart is shown (today both
   always render, doubling bubble height).
3. **The interpretation line (the QuickSight pattern), always visible:** one
   compact row of *chips* restating what was actually answered:
   `Period: last 30 days` · `Excluding: cancelled orders` · `Customers =
   dim_customer` · `Amounts in €`. Sourced from the `assumptions[]` the model
   already emits plus a new structured `interpretation` field (period, filters,
   entity bindings) added to the NL→SQL output schema. **Chips are clickable**:
   clicking `Period: last 30 days` offers the other presets and re-asks with
   the correction — the cheapest follow-up is a click, not a re-typed
   question. This is the single highest-leverage trust feature in the design.
4. **The trust line, all roles, categorical — never a percentage:**
   - `✓ Checked against your data` — the validator ran clean, or the repair
     loop ran and converged (see 5.3).
   - `✓ Verified` (later release) — the question matched a curator-blessed
     saved question (§5.6): human-attributed trust, Genie-style.
   - `△ Take with care` — validator warning that repair could not resolve, or
     borderline confidence band.
   Plus **answer-scoped freshness**: `Data as of yesterday 22:14` computed
   from the tables this answer used (the `widget-context` endpoint already
   returns exactly this; the chat has `msg.sql` and `msg.tablesUsed`). Stale
   sources get the amber state *here*, on the answer, instead of a tenant-wide
   banner that colours the newest date by the worst unrelated connection.
5. **"How I got this" — one collapsed expander (replaces brain button, admin
   metadata row, and debug-for-most-purposes):**
   - *Plain-language method*, 2–4 sentences (Genie's "Analysis" pattern): how
     the question was read, which subjects/tables were used, what was joined,
     what was filtered. Written for business users — derived from the
     structured interpretation + a short model summary, **not** the raw
     thinking and **not** the SQL.
   - *Sources*: each table as a humanized name (`lib/humanize.ts`) with its
     freshness and a deep link to `/catalog?table=` — the identical pattern
     `WidgetProvenance.tsx:186` already ships; the trust loop the owner built
     for dashboards, closed for chat.
   - *For analysts/admins only, nested one level deeper*: the SQL (existing
     formatter), confidence + sub-scores, layer badge, and the debug panel.
     Role model switched from `isAdmin` to `lib/role.ts` (`canSeeSql` =
     admin+analyst per the role table).
6. **The action row:** 👍 👎 (with an optional one-line comment — the column
   already exists) · `Pin to dashboard` (§5.6) · `Save question` (§5.6) ·
   CSV/Excel (per-message filenames) · and **2–3 generated follow-up chips**
   (Tableau Pulse pattern): "Break this down by month", "Which invoices make
   up Club Mechelen's balance?", "Why did this increase?" — the third kind
   routing into Investigate. Cheap to generate: one Haiku call over the answer
   + schema, or derived deterministically from the result shape (has date
   column → offer trend; has category → offer breakdown; is aggregate →
   offer drill).

### 5.2 The wait — one progress timeline, honest and in domain language

Replace `ThinkingBubble` with a **step timeline** (Perplexity's model):

```
● Understanding your question
● Looking at Sales and Receivables      ← real table/subject names
● Running the numbers…                  ← spinner state that actually fires
● Double-checking the result            ← the validator/repair, when it runs
```

- Steps are derived from the existing SSE phases (renamed: no "star schema",
  no "query" for viewers — "Reasoning about your question (star schema)…" is
  a vocabulary-rule violation shipping today) plus new structured events.
- Under the active step, **one line of live summarized reasoning** (streamed,
  ~2 lines max, replaced as it goes — not an accumulating 8,000-token dump at
  220ms/word). The full thinking stream stays available live for
  admin/analyst behind the existing SQL-visibility gate.
- When the answer lands, the timeline **collapses to a one-line receipt**:
  `Answered in 9s · checked against your data ▸` — expandable to the step
  list. This is the ChatGPT "Thought for Xs" pattern: a receipt that reasoning
  happened, not the reasoning itself.
- The receipt persists with the message (it *is* §5.1's trust line + "How I
  got this" header), so the transcript stays clean forever.

### 5.3 Self-correction — the wow moment, done right

The repair loop stops being a separate panel and becomes **steps in the same
timeline**, framed as diligence (Spotter/Snowflake "Reflect" pattern):

```
● Double-checking the result
   Noticed the amounts came back negative — that's the sign convention
   on credit entries. Re-checking against the receivables total…
● Corrected ✓
```

- **The answer appears once, correct.** While repair runs, the card shows a
  subtle "still checking…" shimmer state instead of rendering the suspicious
  answer, letting it be read, and then mutating it. (If repair exceeds ~10s,
  show the provisional answer clearly marked `△ Being double-checked…` — never
  an unmarked answer that silently changes under the reader.)
- On completion, the card carries `✓ Checked & corrected` in the trust line;
  "How I got this" gains a *"What I checked"* section listing the 1–3
  diagnostic steps in past-tense plain language (each expandable to SQL for
  analysts). Total visual cost of a corrected answer: **one card + one
  receipt line** — versus ~2,000px today.
- **Persist it**: new `PATCH /conversations/messages/:id` (answer, sql, rows,
  wasRepaired, repair summary) so reload and export show the corrected truth.
  This is defect A1 and it is non-negotiable for trust — a product that shows
  you a corrected number today and the wrong number tomorrow teaches you to
  trust neither.
- The repair agent's clarifying question renders as a normal clarify card in
  the flow (inline input kept — it's the best interaction in the current
  surface) and no longer wipes the visible trail.

### 5.4 Certainty as three states, not a number

For business users (viewer *and* analyst-as-reader):

| State | Shown when | Display |
|---|---|---|
| **Verified** | matched a curator-approved saved question (§5.6) | green mark + "Verified by your team" |
| **Checked** | executed + validator clean / repair converged | quiet `✓ Checked against your data` |
| **Take with care** | unresolved warning, thin data, borderline confidence | amber note stating *why*, in plain words |

Refusals stop showing percentages and sub-score pills to viewers; the blocked
card says what's missing in plain language and — instead of sending viewers
to a curator surface — offers "Ask your admin to add this" (one click →
notification + properly-linked definition gap). Admin/analyst keep the full
numeric detail (confidence, sub-scores, uncertainty notes) inside "How I got
this". The numeric gate machinery is untouched — this is purely display.

### 5.5 One clarification system

Today there are three unrelated mechanisms (model clarify chips, blocked +
guide, repair-inline-input) plus two entity pickers that are dead on the
default path. Target: **every "I need input" moment is the same card** — a
question, chips or an inline input, answered in place (the repair loop's
inline input is the model). Answers to clarifications are recorded as chip
selections on the card, not as machine-written fake user messages. Entity
disambiguation joins the same system, is ported to the product layer (it
currently exists only on the source path nobody defaults to), and drops the
hardcoded `customer_id` suffix for a proper entity binding.

### 5.6 Answers become destinations

- **Pin to dashboard** — the answer already carries `sql` + `visualization
  {type,xKey,yKey,groupBy}`; a `POST /dashboards/:id/widgets` that appends a
  widget to a chosen (or new) dashboard closes G-something the competitors
  all have (Spotter's Pin). One endpoint + one picker.
- **Save a question** — new `saved_questions` (tenant, name, question text,
  approved SQL, owner, verified flag). Saving is user-level; a curator
  approving it makes it **Verified** (§5.4) and future matching questions
  reuse the approved SQL (the Cortex VQR / Genie trusted-asset mechanism —
  Clarion's semantic layer makes this cheap). `product_kpis.question_text`
  rows are the seed corpus.
- **Schedule it** — "email me this every Monday" on a saved question, reusing
  the `email_schedules` machinery (needs a polymorphic target; it is
  dashboard-bound today). This is G14 and the push-world gap G1's chat-side
  door.
- **Feedback becomes a loop**: fix the NULL-join so 👎 lands in the admin
  queue (defect A6); the gaps page gains the exchange (question, SQL, answer)
  and a one-click "fix & verify" that saves a corrected version as a Verified
  saved question — Genie's "Add as instruction", Clarion-shaped. Thumbs-up
  becomes a promotion *candidate* signal for curators.

### 5.7 Speak the user's language

One line in the NL→SQL + formatter prompts: *answer in the language of the
question*. Add Dutch triggers to the forecast keywords and investigate
classifier (`waarom`, `voorspel`, `prognose`, `verwacht`…) — or better,
retire both keyword scans and let the model classify intent server-side (it
already returns `intent`; the scans predate it). Unify number/date locale to
one constant (today: `en-GB` tiles above an `nl-BE` axis with an `en-US`
tooltip in one bubble). Full UI i18n stays G8 — out of scope here; the
*answers* speaking Dutch is 90% of the perceived effect for 1% of the cost.

### 5.8 Proactive openings (the second wow)

The empty state stops being generic: for a returning user, lead with **"Since
yesterday"** — 2–3 delta bullets pulled from `GET /api/briefs/today` (already
built, already narrated, no role gate), each clickable into a question, plus
pulse-aware starters (the user's watched metrics are the best statement of
what they care about; `queryStartersService` header already notes this as the
planned next layer). Answers whose subject matches a pulse entry get one more
action: "Watch this" → creates a pulse entry. This connects the chat to the
push loop the gap analysis says the product needs, with almost no new
backend.

---

## §6 Release sequencing

**Release 1 — "Tell the truth" (foundations; mostly backend + gating).**
The trust layer is worthless while the substrate lies.
- Persist corrected answers (PATCH route + client write-back); persist the
  dropped metadata fields (assumptions, subScores, intent/options,
  visualization, forecast).
- Fix the feedback NULL-join; add the missing `notifyAdmins` calls.
- Policies on all query paths; render `policyNotice`.
- Role model: `lib/role.ts` everywhere in `/query`; analyst = SQL-visible per
  the role table; gate `InvestigationView` SQL (non-negotiable violation).
- Stop streaming `text` deltas / pre-gate `sql_ready` / raw DB errors to
  non-privileged roles; Zod schemas on `/think`,`/repair`,`/forecast`,
  `/cross-view`; parameterize entity pre-flight SQL.
- Fix the `useSourceLayer` stale closure; product-layer phase strings lose
  "star schema"; locale unification; answer formatter gets temperature 0 +
  true row count.

**Release 2 — "The answer card" (the visible redesign; frontend-heavy).**
- New answer card (§5.1): interpretation chips, categorical trust line,
  answer-scoped freshness (wire `widget-context`), "How I got this" with
  humanized source links to `/catalog?table=`, nested analyst detail,
  KPI treatment for single values, collapsed table under charts,
  markdown-lite prose.
- New progress timeline (§5.2) replacing ThinkingBubble; collapsed receipt.
- Repair folded into the timeline as "Double-checking" (§5.3) with the
  shimmer/provisional pattern and the persisted correction.
- One clarification system (§5.5); entity pre-flight ported to product layer.
- Answers in the user's language + Dutch intent triggers (§5.7).
- Follow-up chips (deterministic version).

**Release 3 — "Answers go somewhere" (new capability).**
- Pin to dashboard; saved questions + Verified tier; schedule a saved
  question; feedback → curation queue with "fix & verify".
- Proactive empty state ("Since yesterday" + pulse-aware starters); "Watch
  this" action.
- Investigate: nav link (closes G10), product picker when unresolved, Dutch
  triggers, and vocabulary de-collision with repair ("double-checking" vs
  "investigating why").

**Deliberately later:** server-side intent classification replacing both
keyword scans; consolidating the three context builders + moving the chat
onto the cached path (pairs naturally with the Release 1 backend work if
appetite allows); benchmark suite for NL→SQL accuracy (Genie-style, publish
the number to the tenant).

---

## §7 What NOT to do

- **No raw chain of thought in the UI, for anyone, ever again** — summarized
  steps + receipt; raw thinking is a debugging artifact behind the analyst
  gate at most.
- **No numeric confidence for business users** — in either direction. The
  industry retired it; research says it misleads.
- **Don't delete the repair loop or hide that correction happened** —
  self-checking is the differentiator; compress and celebrate it, never mask
  an answer that changed after the user could have read it.
- **Don't build a wizard or multi-pane "agent workspace"** — the chat column
  is right; wow comes from the answer card, not from more chrome.
- **Don't merge Investigate into the chat repair loop** — different jobs
  (fix a wrong query vs explain a business movement); fix the vocabulary
  collision instead.
- **Don't start full UI i18n here** — answer-language mirroring only; G8
  stays its own project.
- **Don't add an "AI can make mistakes" footer** — per NN/g it does nothing;
  the per-answer trust line is the honest version.
- **Don't auto-fire AI on opening old conversations** — same policy as
  dashboards: opening is free; generation is an act.

## §8 Owner decisions queued

1. **Provisional-answer policy during repair (§5.3):** hold the card in
   "checking…" until repair settles (cleanest, adds seconds of blank) vs show
   the provisional answer marked "being double-checked" (faster, risks the
   number changing on screen). Recommendation: hold up to ~10s, then show
   marked-provisional.
2. **Analyst SQL visibility:** the role table says analyst sees SQL; the chat
   says admin-only. Confirm the role table wins (recommended) — it also
   settles the CLAUDE.md discrepancy noted 2026-08-04.
3. **Verified answers scope for Release 3:** exact-match reuse of approved SQL
   only (safe, recommended first step) vs fuzzy matching to similar questions
   (Cortex-style, more reach, more risk).
4. **Dutch-first:** should answers *default* to Dutch for this tenant, or
   strictly mirror the question's language? Recommendation: mirror.

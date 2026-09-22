# Declarative data engineering — investigation and design

**Date:** 2026-09-22 · **Status:** proposal, mockups attached · **Owner ask:**
*"A declarative view of the data products we have, with the data lineage and
the SQL code that we can adapt if needed (through AI or ourselves). We don't
worry about refreshing, adding columns, the technical details… We just declare
what we want in a clear view where we can work in. And a place where we
logically place our metrics or definitions (like what is an active customer)."*

Settled with the owner before this was written: admin + analyst only (Topics
stays the business front door); the unit of declaration is the **table**,
grouped under its subject, with source tables visible as read-only inputs;
definitions are **documented once and used by the AI** (not executable yet);
everything on the curator side may be merged or retired, and the analysis
notebooks at `/notebooks` stay; the AI edits by **proposing a diff you Keep or
Discard**; deliverable is this doc plus mockups of every affected page
(`docs/handoffs/declarative-workspace/`, artifact "Clarion Declarative
Workspace").

**Revised the same evening, after the owner reviewed the first boards: the
catalog *is* the workspace — there is no separate Model page.** The owner's
words: *"Catalog should be the place to check, to have declaration in our data
engineering and be THE place where we WORK. It should be simple and effective
and have clear responsibilities. You should be able to review, to check the
health, and to adapt yourself or with AI. The AI should be a floating chat."*
Also settled: no *All / Sources / Products* choice and no *Grid / List /
Structure* toggle — one tree on the left with each source under its own mark,
one view on the right; and the glossary leaves the catalog to become its own
pane (Definitions — the owner's instinct, and mine). §3 is the revised target;
§0–§2 are unchanged because the findings did not move.

---

## 0. Verdict

The platform already *is* declarative underneath. A product table is one row
with one `transformation_sql`; the runner materialises it, derives its columns
(`syncProductColumns`), derives its lineage from the SQL
(`lineageDerivation.ts`), orders the DAG, runs the checks and records the
refresh. Nothing the user should have to think about is missing from the
engine. **What is missing is the surface.** The declaration is reachable
through seven doors, none of which is the obvious one, two of which overwrite
each other, and the words on screen (Deploy, Run, Refresh, cells, deploy-all,
run-full) describe the engine's mechanics rather than the user's intent.

Three facts from the code decide the shape of the fix:

1. **Two stores hold the same SQL and only one path keeps them in step.**
   `product_tables.transformation_sql` is the truth the runner builds from.
   `product_table_cells` (the per-table notebook) holds a "deploy cell" whose
   SQL is copied *over* `transformation_sql` on every Deploy
   (`routes/products/cells.ts:441-465`). The Manage-mode SQL editor writes
   `transformation_sql` only (`routes/products/tables.ts:136-149`), so **an
   edit saved in Manage mode and then "deployed" is silently reverted** to the
   older cell. The AI refine path avoids this by also patching the cell
   (`refineService.ts:665-695`); the human path does not. Verified in this
   session by reading both handlers.
2. **A rebuild wipes every human SQL edit.** `snapshotProductEdits`
   (`busMatrixBuilder.ts:447-497`) carries `hidden`, `plain_summary`,
   `question_text` and human-authored KPIs across a rebuild. It does **not**
   carry `transformation_sql`, column descriptions, display names or the
   refine log. A curator who fixed a fact's SQL by hand loses the fix the next
   time anyone presses "Rebuild the topics from this source".
3. **A "definition" can live in four places that do not know about each
   other:** a glossary term (`business_glossary.meaning` + `links`), a product
   KPI (`product_kpis.formula_plain_text/formula_sql/question_text`), a
   verified saved question (`saved_questions`), and the legacy graph KPI
   (`kpi_definitions`, still read by reports and user notebooks). The AI reads
   the first two on the product layer; the topic page shows the second; the
   Ask AI fast path uses the third; nothing shows all of them together.

So the design is not a new engine and not a new AI. It is **two panes**
(the catalog as the workspace, Definitions beside it), **one store per declaration**, **one action** (Save,
which validates and rebuilds), and the retirement of every surface that
duplicated them.

---

## 0a. What shipped — 2026-09-22, the same branch (PR #175, merged as `b22ef2d`, in production via Build & Deploy run #616)

The owner, on the revision-2 boards: *"they are too busy and somewhat wrong
with what's already there … Can you implement what we already can with what's
already there? + the AI chat and the easy lineage view + SQL editor for
declarative data engineering + definitions pane + icons of source systems?"*
So slices 1–3 of §5 were built on the EXISTING components, and none of the
retirements was taken yet. Measured against §3:

**Backend (§3.4) — shipped.**
- Migration 101: `product_tables.declared_by`, `declared_at`.
- `PUT /products/tables/:id/sql` is the ONE write (admin + analyst): guard →
  compile (`DESCRIBE` in a real warehouse session, `services/tableDeclaration.ts`)
  → store once → keep serving (`transformation_status` stays `success` when it
  was; *changed since the last build* is `declared_at > last_run_at`, no status
  flip, so the table never vanishes from Ask AI) → `syncDeployCell`, so Deploy
  can no longer revert a hand edit. A shared stub refuses with "change it on
  the owner". D1, D3 and D4 of §2.3 are closed by this one handler.
- `GET /products/tables/:id/declaration` — the read model: SQL, state,
  columns DERIVED by the compile, `shared_from`, `pending_rebuild`.
- `POST …/sql/preview` (12 rows, nothing stored) and `POST …/sql/propose` —
  the assistant returns a compiled proposal and never writes; Keep is the PUT.
- `POST /products/build-chat` takes `anchorTableId`: the table's columns and
  meaning join the prompt, so Ask on a table is about that table.
- `GET /definitions` unions terms · metrics · verified answers (all roles).
- `GET /catalog/sources` carries `connectorType`, which is the marks.
- `tests/table-declaration.test.ts`: 21, both directions per rule.

**Frontend — shipped, reusing what was there.** ONE tree (`CatalogBrowser`
reworked: subjects first, sources under their connector mark, *Your tables*),
ONE view (the existing panels; nothing selected = what needs you + the health
overview that was the Trust tab), the **SQL tab** on the product-table panel
(the notebook's CodeMirror editor · Format · Preview · *Rebuild now* only when
a saved change waits · Save; the proposal as a diff with Keep / Discard,
`SqlDeclaration.tsx`), the **easy lineage line** on both layers over the
existing lineage endpoint (`LineageSummary.tsx`), the **floating assistant**
(`CatalogAssistant.tsx`, the dashboards' panel pattern: Ask / Change the SQL,
scope chip, Stop), the **Definitions pane** (`/definitions`: the glossary
editor with its link picker, metrics per subject, verified answers with *Ask
it*), `/glossary` and `/health` redirecting, the rail entry, ⌘K, *Open in the
Catalog* on the topic page. Every deep link unchanged (`lib/catalogUrl.ts`,
pinned by test). Render-checked in headless Chromium against a mocked API:
twelve screens, curator and viewer, including propose → diff → Keep end to end.

**Deliberately NOT yet — the retirements of §3.5, i.e. slice 4 and half of
slices 2–3:** the workshop (`/products/[id]`, `product_table_cells`),
RefineChat, AskAIPanel, KpiManager, Manage mode, `/build`, `/review`, the
Topics canvas; `snapshotProductEdits` carrying SQL across a rebuild (D2);
`GET /catalog/attention` (the landing reads the endpoints that exist — the
review list per source table and "what changed" are not there yet); the
source-table drafts as inline Keep / Discard; the new-subject panel inside
the catalog. Each is one deletion PR once the workspace has been used for real
— the boards in `docs/handoffs/declarative-workspace/` stay the design of
record for exactly those parts.

---

## 1. What "declarative" means here

The user states **what**; Clarion owns **how**. Written as a contract, so the
mockups can be checked against it:

| The user declares | Clarion derives and owns |
|---|---|
| A subject (name, what it answers) | its build order, its shared lookups, its freshness |
| A table: its SQL, what one row is (grain), its role, a plain description | its columns and their types, its lineage (from the SQL), its joins (from the FKs), its materialisation, its checks, its refresh history, its dependents |
| A column's meaning (when it differs from the source's) | everything else about the column |
| A definition or metric: name, meaning, the question it answers, optionally a formula | where it appears (topic page, AI context, catalog chips) |

Rules that follow, each of which the current UI breaks somewhere:

- **One declaration, one place.** A table's SQL is edited on exactly one
  screen and stored in exactly one column. The deploy cell goes.
- **Save is the only verb.** No Deploy, Run, Refresh-this, Deploy-all,
  run-full. Saving a declaration validates it (guard + compile against the
  warehouse), stores it, and queues the rebuild of this table and everything
  downstream. The page shows the state (*building… · built 2 min ago · needs
  attention*), never asks the user to trigger the mechanics. A separate
  *Refresh data* for "the source changed, re-run everything" stays on
  `/pipelines`, where it already is.
- **Human declarations are never overwritten by a machine.** A table whose
  SQL a person saved is `declared_by: human` and a rebuild keeps it verbatim
  (it re-derives only what the AI still owns). Today the opposite holds.
- **The AI proposes, never writes.** Every AI edit lands as a diff on the
  declaration; nothing is stored until Keep. The notebook's `CellDiff` is
  already this pattern.
- **Mechanics are visible only as status.** "Rebuilding fact_sales… 40 s",
  "12 columns, 3 of them technical", "checks: 4 of 4 passing". Never as
  buttons.

---

## 2. What exists today (measured)

Three read-only sweeps of the code, every claim `file:line`, the two most
consequential ones re-read by hand.

### 2.1 Click paths from Home (admin, Studio open)

| Job | Shortest working path | Clicks | Trap on the way |
|---|---|---|---|
| **Edit a fact table's SQL** | Subjects → card → *Manage this data* → (table) → *Show SQL* → *Edit* → *Save* → **Run** | 7–8 | Pressing *Deploy changes* instead of *Run* reverts the edit (§0.1). Analysts see the SQL but cannot save. |
| Edit it in the workshop | Subjects → card → Manage → ⋯ → *Open the build workshop* (lands on the dashboard, not this product) → product row → table pill → cell → Save → Deploy | 10 | The workshop has no rail entry and nothing lights up in the rail while you are there. |
| **Edit a shared lookup's SQL** | Manage mode cannot show it at all. Subjects → Shared data → card → catalog full view → *View SQL* is read-only. Editing needs `/products/<owner>?table=`, which nothing on this path links to. | 10+ | *"Edit in Shared data"* in Manage mode leads to a page that cannot edit. |
| **See a table's lineage** | Subjects → card → Manage → *Where it comes from* (→ table chip) | 4–5 | Catalog's product "Lineage" tab is a single sentence, not a graph. |
| **Define a metric** | Subjects → card → Manage → *Metrics* → *Add KPI* → fill → Save | 6 | *Rebuild topics* on `/build` resets metric edits. |
| **Define a term ("active customer")** | Catalog → *Glossary* facet → *Add term* → fill (→ Link picker → pick) → Save | 4–6 | ⌘K "Business glossary" lands on the Browse facet. Terms never appear on the topic page or in Manage mode. |
| **Add a subject** | Build → type in *Ask about your subjects* → *Add* | 3 | Same job from a topic is 6 clicks via the refine chat's escalation. |
| **Add a table to a subject** | Only in the workshop (`/products/:id` → + pill) | 9–10 | Manage mode has no "add table". |

### 2.2 Duplication

- **A product table's SQL is viewable in 5 places** (Manage "Show SQL",
  Catalog SqlViewer, TableNotebook, RefineChat diffs, `GET /products/:id`
  which ships it to *viewers*) **and editable in 2** (Manage textarea →
  `PUT /tables/:id/sql`; notebook cells → Deploy) **plus the AI's** (refine
  approve). Each editor writes a different store.
- **Rebuild/deploy has six verbs**: Manage *Refresh* (queued `refresh-start`),
  workshop *Refresh* (synchronous `run-full`), Manage *Deploy changes* and
  workshop *Deploy all* (`deploy-all`), notebook *Deploy* (per table),
  Manage *Run* (per table), and *Prepare my data* / *Create my topics*
  (`bus-matrix/start`, same job, two names).
- **One product is rendered four ways** — TopicLayer/ManageLayer,
  ProductRootPanel (1,053 lines), ProductFullView (661), ProductPreviewPanel
  (561) — each fetching `/products/:id` and `/kpis` on its own.
- **Seven AI assistants edit the model**: RefineChat (986 lines), AskAIPanel
  (640, whose per-product mode is unreachable), the Build AskPanel, the
  notebook "+ Ask AI" cell, the KPI "AI draft", the catalog description
  dialog, and the analysis NotebookAssistant. RefineChat and AskAIPanel are
  both labelled *Refine*, with different proposal schemas and different role
  gates. `ProductRootPanel` mounts both at once.
- **Two notebook implementations**: `/notebooks` (CodeMirror, Python, diff
  with Keep/Discard) and `TableNotebook` (textarea, no diff).
- **Quality is on six surfaces**; joins/structure on four; columns on seven.

### 2.3 Defects found on the way (independent of the redesign)

| # | Defect | Where |
|---|---|---|
| D1 | Manage-mode SQL Save is reverted by *Deploy changes* (two SQL stores) | `tables.ts:136`, `cells.ts:441` |
| D2 | A rebuild discards hand-edited SQL, column meanings, display names, the refine log, the schedule | `busMatrixBuilder.ts:447-497, 557-571` |
| D3 | No write path validates SQL before storing it; the runner executes stored SQL without `assertSafeReadQuery` | `tables.ts`, `cells.ts:368-420`, `refineService.ts:501`, `transformationRunner.ts:796` |
| D4 | `PUT /sql` sets `transformation_status='draft'`, and the product context filters on `'success'` — so a saved-but-not-rebuilt table **vanishes from Ask AI and dashboards** while its old data is still there | `productContext.ts:161` |
| D5 | `GET /products/:id` ships `transformation_sql` to viewers; the dedicated SQL endpoint is admin-only | `core.ts:126`, `semantic.ts:2193` |
| D6 | Analysts are shown *Deploy all*, *Refresh*, notebook *Deploy* and the catalog SQL viewer; all four APIs are admin-only (403) | `ProductRootPanel.tsx:362,373`, `ProductTableDetailPanel.tsx:531` |
| D7 | The reverse: Manage hides the summary Edit and disables *Preview rows* for analysts "because the API is admin-gated"; both APIs allow analysts | `ManageTables.tsx:361,421` |
| D8 | `data_products.hidden` is not filtered in the AI context | `productContext.ts:161` |
| D9 | ⌘K "Business glossary" → Browse facet; every ⌘K search hit → bare `/catalog`; catalog `?tableId` written, never read; TableDetailPanel "Used in" → `/products?productId=` (ignored) | `CommandPalette.tsx:59,142`, `catalog/page.tsx:265`, `TableDetailPanel.tsx:389` |
| D10 | Dead embedded AskAIPanel + its state in ProductRootPanel; stale copy ("KPIs tab", "AI on the right", "topics in the sidebar") | `ProductRootPanel.tsx:42-139,752,776`, `build/page.tsx:743` |

D1–D4 are the ones the redesign must fix by construction, not by a patch.

---

## 3. The target — the catalog is the workspace

### 3.1 Navigation

Studio becomes: **Sources · Catalog · Definitions · Your tables · Relations ·
Refresh** — six entries, one job each. *Build* folds into the catalog (§3.2, a
source with no subjects). *Suggestions* folds into the catalog too: the review
queue is what the landing shows when nothing is selected, and every draft is a
Keep / Discard on the table it belongs to; the rail badge on Catalog is "what
needs you" (needs attention + to review). The workshop (`/products`,
`/products/[id]`) is retired. *Relations* keeps only its source-layer canvas;
the read-only Topics toggle is retired because the same joins are drawn on the
subject. The Glossary facet becomes **Definitions**, a separate pane: a
definition is not a table, and a page that holds both carries two jobs.

Uncover is unchanged. The topic page is unchanged for viewers; for curators
*Manage this data* becomes **Open in the Catalog →** and deep-links to
`/catalog?subject=<id>`.

### 3.2 Catalog (`/catalog`) — review, check the health, adapt

Three responsibilities, in the owner's words, and everything on the page
serves one of them: **review** what Clarion derived or drafted, **check the
health** of what is built, **adapt** it — yourself, or through the floating
assistant. *(Screens: Main, Catalog-Diff, Catalog-Health, Catalog-Subject,
Catalog-Source, Catalog-SourceTable, Catalog-NewSubject.)*

What goes: the Browse / Trust / Glossary tabs, the All / Sources / Products
chips, the Grid / List / Structure control, the hero and *New product*. There
is one tree and one view.

**Left — the tree (260px).** Everything the tenant has, selectable, in the
order people work on it:

```
SUBJECTS
  ▾ Finance                    ●
      fact_transaction_lines
      fact_receivables         ⚠
      fact_payables            ●
  ▸ Sales                      ●
  ▸ Purchasing                 ◌ building
SHARED DATA
      dim_account · dim_item ⚠ · dim_gl_account · dim_journal · dim_date …
YOUR TABLES
      budget_2026              🔗 linked to Finance
SOURCES                        read-only inputs
  ▾ [E]  Exact Online          7 of 61
         TransactionLines      12 to review · → 2
         Accounts              9 to review · → 1
         …  54 more, not synced · pick them on Sources
  ▸ [odoo] Odoo (staging)      21
  ▸ [xls]  Budget 2026.xlsx    3
+ Add a subject
```

A source is its own catalog node and is identified by its **mark** — the
brand glyph from `lib/connectorIcons.tsx` that the Sources page already
draws — never a generic database icon. Facts purple, lookups ocean, grids
amber (the canvas's existing vocabulary), sources muted. A status glyph per
row, never a count, except on a source (how many of its tables are synced)
and on a source table (how many drafts wait on it, what it feeds). Search at
the top filters every group.

**Right — the view.** Always the declaration of the selected node; nothing
to toggle. Five shapes:

1. **Nothing selected — what needs you** *(Catalog-Health)*. Four tiles
   (built and healthy · need attention · building · to review), then the
   attention list — each row names the table and the cause in one sentence
   and opens it — the review list grouped per source table, and what changed.
   This is the Trust facet and the Suggestions queue in one place, and it is
   the page's answer to "check the health".
2. **A subject table** *(Main)* — as in the first design. Header with the one
   action **Save** (disabled until something changed) and *Preview 12 rows*;
   status line (*built 3 min ago · 12,480 rows · checks 4 of 4 · declared by
   you*); **what one row is** and **description**, editable inline; **SQL —
   the declaration** in a real code editor (the `/notebooks` CodeMirror, not a
   textarea); under it the sentence that replaces every button (*Saving
   validates the SQL against your warehouse, then rebuilds this table and the
   4 tables that read from it. Nothing else to press.*); **columns — derived by
   Clarion**, the meaning editable per column, the glossary chip where a term
   links here, technical columns collapsed. Context column: lineage (inputs
   above, this table, outputs and *used by* below — `/lineage/table` and
   `widget-context`, already built), health (change counts, checks, the
   schedule as a link to Refresh), history.
3. **A subject** *(Catalog-Subject)* — what it answers, its tables as cards
   with status, the star derived from the foreign keys, its metrics with
   *Open in Definitions →*. Actions: *Shown on Subjects* (the hide toggle),
   *Rebuild AI-owned tables…* (§7), more.
4. **A source** *(Catalog-Source)* — the mark, sync state, how many of its
   tables are synced, what it is, and **read this first**: the vendor notes
   from the source package (the `DC`/`FC` rule, credit notes negative,
   journals by `Code`), shown because Clarion reads them before every analysis
   and a curator should see what the model sees. Then the synced tables with
   rows, what each feeds and how many drafts wait on it; the unsynced count
   with a door to Sources. Context: feeds, health (last sync, failed entities,
   rows changed, next sync), relations (laid by the source · settled by the
   data · to review → Relations), history. **Nothing here edits the source**:
   sync, analyse and picking entities stay on Sources, linked from the header.
5. **A source table** *(Catalog-SourceTable)* — the review job made concrete.
   What one row is (the vendor's own words, `vendor_description`), **your
   note** (the editable `description`, kept apart from the vendor's), what it
   feeds, then the columns: the vendor's meaning where it documents one, and
   where it does not, Clarion's draft **inline as a proposal with Keep /
   Discard** — nothing is used until you say yes. *Save* stores your notes and
   meanings (today's `PATCH /semantic/tables|columns/:id`). Context: lineage,
   relations with their measured state, health, history. Sample rows at the
   bottom.

**The assistant** is the floating bottom-right chat the dashboards and
notebooks already have, aimed at the selected node ("About:
fact_transaction_lines"). Ask a question ("what does AmountDC mean?") and it
answers from the vendor docs and the data; ask for a change ("leave out the
year-end close") and it proposes a diff **on the declaration**, rendered in
place with **Keep / Discard**; nothing is stored until Keep, and Keep is Save.
On the landing it answers about all your data; on a source, about what the
source contains. One assistant, one history, one endpoint.

**A source with no subjects** *(Catalog-NewSubject)* is today's `/build` plan
panel inside the catalog: the subjects the template would build, an intent
field, one button *Create my subjects*; the run streams into the same place and
the tree fills in as tables are built. `/build` retires.

### 3.3 Definitions (`/definitions`) — its own pane

*(Screens: Definitions, Definitions-Edit.)* Settled with the owner: the
glossary leaves the catalog. One searchable list, every entry the same card,
grouped by subject with *Everywhere* first:

| Kind | Card shows | Backed by |
|---|---|---|
| **Term** | name · meaning · examples · *In the data:* `fact_sales.net_amount` (topic Finance) | `business_glossary` |
| **Metric** | name · the question it answers · plain definition · formula (collapsed) · *appears on the Finance topic page* | `product_kpis` |
| **Verified answer** | the question · answered from `fact_…` · verified by A. Van Damme on 12 Sep | `saved_questions` where verified |

"Active customer" is a **Term** with a link to `dim_customer.last_invoice_date`
and the sentence *"a customer with at least one invoice in the last 12
months"*. That is exactly what the owner asked for ("documented once, used by
the AI"): the glossary's link mechanism already turns it into a fact the model
is told to use. A metric card has the same anatomy plus the question and an
optional formula; the AI-draft helper stays. Nothing executes here. Each
subject group carries *open in the Catalog →*.

The page carries the rule in its header copy: *These are the words your
team uses. Clarion uses them every time it answers.*

Backend: no new table. `GET /definitions` reads the three stores; the
existing CRUD routes stay; the legacy `kpi_definitions` is listed under a
"Legacy" group until its two readers (reports, notebooks) are moved to
`product_kpis`.

### 3.4 What Clarion owns after Save (the backend half)

Small, and each item closes one of D1–D4:

1. **One store.** `PUT /catalog/tables/:id` replaces `PUT /tables/:id/sql`,
   the cell Deploy and refine-approve's SQL write. It runs
   `assertSafeReadQuery`, compiles the SQL against a warehouse session (the
   refine preview's mechanism), refuses with the DuckDB message on failure,
   stores it with `declared_by = 'human'` (new column on `product_tables`,
   values `human | ai | template`), and enqueues the rebuild of this table
   plus its dependents in DAG order (`refresh-start` scoped to a table set —
   the orchestrator already runs single products). `product_table_cells`
   loses its deploy role (migration: drop `is_deploy_cell`; the cells table
   can go entirely once the workshop is gone).
2. **Status does not hide the table.** A saved declaration that has not
   rebuilt yet keeps `transformation_status='success'` with a new
   `pending_rebuild_at`; the AI context keeps serving the last built data;
   the catalog shows *rebuilding…*. `draft` is reserved for a table that
   never built.
3. **Human declarations survive a rebuild.** `snapshotProductEdits` gains
   `transformation_sql`, `description`, `display_name` and the column
   meanings for every table whose `declared_by = 'human'`; the rebuild
   re-inserts them verbatim instead of the template's or the AI's SQL. A
   rebuild becomes "re-derive what the machine owns", which is what the
   warning should say.
4. **The AI writes nothing.** The refine service returns proposals only;
   Keep calls the same `PUT`. `product_customizations` keeps the log.
5. **Definitions read.** `GET /definitions` (union of the three stores,
   tenant-scoped). `hidden` filtered in `productContext`.
6. **The landing read.** `GET /catalog/attention`: the attention rows
   (`degraded_reason`, the duplicate-key warning from the last refresh, a
   failed `transformation_status`), the review counts per source table
   (`ai_draft` rows), and the recent changes (`audit_events` +
   `product_customizations`). One read, tenant-scoped, nothing new stored.
   Source notes on a source come from the package's `getSourceNotes()`, the
   same call the profiler already makes.

### 3.5 Every affected page — what happens to it

| Page / surface today | Target |
|---|---|
| Catalog chrome: Browse / Trust / Glossary tabs, All / Sources / Products chips, Grid / List / Structure control, hero, *New product* | **Gone.** One tree, one view, one assistant |
| Catalog cards: CatalogSplitView (451), ProductCardGrid (396), AnalyticsCard + ReferenceCard (242), GlossaryMatchCards (102) | **Retired**; there is no cards view |
| Catalog: ProductFullView (661), ProductPreviewPanel (561) | **Retired**; the subject declaration |
| Catalog: ProductTableDetailPanel (1,002), TableDetailPanel (691), SourceRootPanel (1,061), CatalogBrowser (784), EntityDetailPanel (324) | **Rebuilt** as one tree + one declaration with three flavours (subject table · source table · source) |
| Catalog: Trust facet (QualityOverview 222) | The landing board — what needs you |
| Catalog: Glossary facet + GlossaryPanel (475) | **Moved** to `/definitions`; the facet redirects |
| Rail: Studio → Build, Suggestions | **Removed**; both fold into Catalog (badge = what needs you) |
| `/build` (883) + AskPanel (207) | **Retired** into the catalog's source node (plan panel, run panel) |
| `/review` (252) | **Retired**; the landing's *To review* list + Keep / Discard on each source table |
| `/products` workshop (915) + BuildDashboard (479) | **Retired**; the coverage map is the subject view |
| `/products/[id]` + ProductRootPanel (1,053) + TableNotebook (681) + CellOutput (205) | **Retired**; Preview replaces cell execute |
| AskAIPanel (640), RefineChat (986), KpiManager (506), `refine.ts` routes | **Retired**; one floating assistant + Definitions |
| Topic page: *Manage this data* / Manage mode (ManageLayer 453 + ManageTables 670) | Manage mode **retired**; curator link *Open in the Catalog →*; the topic page keeps ask box, try-asking, trust line; Quality and Activity live in the declaration's context column; *Refresh* stays on `/pipelines` |
| `/shared-data` cards | Link into the catalog (`/catalog?table=`) |
| `/relationships` Topics toggle + TopicsCanvas (600) | **Retired**; the subject view draws its joins. Sources canvas stays |
| `/pipelines` | Unchanged (Refresh data, schedules, runs) |
| `/notebooks` | Unchanged (owner's constraint); gains *Save as declaration →* later, not now |
| ⌘K | "Catalog", "Definitions" actions; search hits deep-link to the node |

Net: about 11,000 lines of frontend retired outright and about 3,900 rebuilt
into roughly 2,600 new (tree ≈ 300, the declaration in three flavours ≈ 1,200,
landing ≈ 250, assistant reuse ≈ 300, Definitions ≈ 500).

---

## 4. Why this is the right cut (and what it is not)

- **It is dbt's mental model with the file system removed.** One model = one
  SQL declaration with a description and a grain; lineage and columns are
  derived; you never write a `.yml` because Clarion writes it (that is the
  source-package work of 2026-09-20, applied to the tenant's own tables).
  Curators who know dbt will recognise it in a minute; curators who do not
  will never see the mechanics.
- **It is the same pattern the notebooks already use for AI edits**, so the
  Keep/Discard diff is a reuse, not an invention, and the assistant panel is
  the dashboard's panel with a different target chip.
- **It removes the two-store bug by construction**, not by syncing the two
  stores better.
- **It is not** a canvas-first editor (the owner chose code-first), not an
  executable metrics layer (settled: documented only), not a change to the
  topic page for viewers, and not a change to the engine.

---

## 5. Sequencing

1. **Backend contract first** (§3.4 items 1–3): one `PUT`, validation,
   `declared_by`, the survive-rebuild snapshot, the status rule. Each has a
   red test today (D1 reproduces in one request; D2 in a rebuild round trip).
   This slice alone fixes the silent revert and the wipe.
2. **Catalog rebuilt in place**: the tree (sources by their mark), the
   declaration in its three flavours, the landing, the assistant reusing
   `AssistantPanel` + `CellDiff`; retire the facets, the layer chips, the view
   control, the cards components, the workshop, the notebook cells,
   RefineChat, AskAIPanel and Manage mode's Tables tab. The URL does not
   change, so every existing deep link (`?table=`, `?refTableId=`,
   `?productId=`) keeps landing on the right node.
3. **Definitions page**; move the glossary; retire KpiManager and the Metrics
   tab; ⌘K fixes.
4. **Fold Build and Suggestions into the catalog**; retire `/build`,
   `/review`, the Topics canvas, the remaining Manage tabs; rail change.

Slices 2–4 are each a deletion-heavy PR; the only new code with risk is the
assistant's proposal endpoint, which is the refine service returning instead
of writing.

---

## 6. What not to do

- Do not add an eighth assistant. Merge, then delete.
- Do not make definitions executable in this pass (settled). The link is the
  address; the meaning is the fact.
- Do not keep `product_table_cells` "for later". The analysis notebooks are
  the notebooks.
- Do not put mechanics back as buttons because a rebuild is slow. Show the
  state; let `/pipelines` own scheduling.
- Do not change the topic page for viewers.

## 7. Owner decisions

Settled 2026-09-22, morning: audience, unit, documented-only definitions, cut
freely (notebooks stay), code-first, diff-then-Keep, all affected pages mocked.

Settled 2026-09-22, evening, after the first boards: **the catalog is the
workspace** (no Model page); one tree, no layer chips, no view toggles; a
source is identified by its mark; the glossary becomes the separate
Definitions pane; the assistant is a floating chat.

Open, for after the second review: (a) whether *Rebuild AI-owned tables…*
should exist at all once human declarations survive, or whether "re-derive
the AI-owned tables" is a Refresh option on `/pipelines`; (b) whether the
legacy `kpi_definitions` readers (reports, user notebooks) move to
`product_kpis` in slice 3 or later; (c) whether Suggestions folds into the
catalog in slice 4 (the boards assume it does — the landing's *To review*
list plus Keep / Discard on each source table) or keeps its page a while
longer.

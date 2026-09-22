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

So the design is not a new engine and not a new AI. It is **two pages**
(Model, Definitions), **one store per declaration**, **one action** (Save,
which validates and rebuilds), and the retirement of every surface that
duplicated them.

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

## 3. The target — two pages, one store per declaration

### 3.1 Navigation

Studio becomes: **Sources · Model · Definitions · Your tables · Relations ·
Refresh · Suggestions · Catalog**. *Build* folds into Model (§3.2, empty
state). The workshop (`/products`, `/products/[id]`) is retired. *Relations*
keeps only its source-layer canvas; the read-only Topics toggle is retired
because the same joins are drawn in Model. The Glossary facet of Catalog
becomes a redirect to Definitions.

Uncover is unchanged. The topic page is unchanged for viewers; for curators
*Manage this data* becomes **Edit in Model →** and deep-links to
`/model?subject=<id>`.

### 3.2 Model (`/model`) — the declarative workspace

Three columns, always the same shape. *(Screens: Model-Table, Model-Diff,
Model-Subject, Model-NewSubject.)*

**Left — the tree (260px).** Everything the tenant has, as declarations:

```
SUBJECTS
  ▾ Finance                  built · 3 min ago
      fact_transaction_lines   ⚑ needs attention
      fact_receivables
      fact_payables
  ▸ Sales
  ▸ Purchasing               ◌ building…
SHARED DATA
      dim_account · dim_item · dim_gl_account · dim_journal · dim_date …
SOURCES                        read-only inputs
  ▸ Exact Online (61 tables)
  ▸ Budget 2026.xlsx
+ New subject
```

Facts purple, lookups ocean (the canvas's existing vocabulary), sources muted.
A status glyph per row, never a count. Search at the top filters all three
groups.

**Centre — the declaration (fluid).** For a table:

1. Header: display name, table role chip, subject, status line
   (*built 3 min ago · 12,480 rows · checks 4/4* or *needs attention: source
   column `Country` vanished — Clarion built without it*), and the one action
   **Save** (disabled until something changed).
2. **What one row is** — the grain, one sentence, editable inline.
3. **Description** — plain language, editable inline. This is
   `plain_summary`; the derived provenance sentence is the placeholder.
4. **SQL** — the declaration, in a real code editor (the `/notebooks`
   CodeMirror, not a textarea), full width, syntax-lit. Under it a **Preview**
   button that runs the current text against the warehouse and shows 12 rows
   (this is the refine preview, reused) — the only "run" a curator ever
   presses, and it writes nothing.
5. **Columns — derived by Clarion** — a read-only list of what the SQL
   produces (name, type, role, FK target), with the *meaning* editable per
   column and the glossary chip ("your team calls this…") where a term links
   here. Technical columns collapsed under "+3 technical".

**Right — context (300px).**

1. **Lineage** — inputs above, this table in the middle, outputs below:
   `Exact Online · TransactionLines`, `· GLAccounts` → **fact_transaction_lines**
   → `dim_gl_account (joined)`, then *used by*: 2 dashboards, 6 saved
   questions, 1 grid link. Click any node to move to it. This is
   `/lineage/table` and `widget-context`, already built.
2. **Joins** — the FK targets as a short list (the star, without a canvas).
3. **Health** — last refresh's change counts (the sparkline that exists),
   checks, degraded reason.
4. **History** — who changed this declaration, when (from `audit_events` +
   `product_customizations`).

**The assistant** is the floating bottom-right panel that dashboards and
notebooks already have, aimed at the selected declaration ("Target:
fact_transaction_lines"). Ask "exclude credit notes" → it proposes a diff on
the SQL, rendered in place with **Keep / Discard**; nothing is stored until
Keep, and Keep is just Save. Ask "add a Quotations subject" → the same
assistant proposes a new subject (today's extend flow) as a card with one
*Add* button. Ask "what does `AmountDC` mean?" → it answers from the vendor
docs. One assistant, one history, one endpoint.

**Subject selected** shows the subject's declaration: name, what it answers
(the `question_text`s), its tables as cards with status, a compact star
diagram (the existing `StarSchemaFlow`) and its metrics — with *Open in
Definitions*. Its only actions are *Rename*, *Hide from Subjects* and
*Rebuild this subject* (warned, and per §3.4 no longer destructive).

**Empty state / new subject** is today's `/build` PlanPanel inside Model: for
a source with no subjects, the plan the template would build, an intent
field, and one button *Create my topics*; the run panel streams into the same
place. `/build` therefore retires; its "hide" toggle moves to the subject
header.

### 3.3 Definitions (`/definitions`) — one logical home

*(Screens: Definitions, Definitions-Edit.)* One searchable list, every entry
the same card, grouped by subject with *Everywhere* first:

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
optional formula; the AI-draft helper stays. Nothing executes here.

The page carries the rule in its header copy: *These are the words your
team uses. Clarion uses them every time it answers.*

Backend: no new table. `GET /definitions` reads the three stores; the
existing CRUD routes stay; the legacy `kpi_definitions` is listed under a
"Legacy" group until its two readers (reports, notebooks) are moved to
`product_kpis`.

### 3.4 What Clarion owns after Save (the backend half)

Small, and each item closes one of D1–D4:

1. **One store.** `PUT /model/tables/:id` replaces `PUT /tables/:id/sql`,
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
   the Model page shows *rebuilding…*. `draft` is reserved for a table that
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

### 3.5 Every affected page — what happens to it

| Page / surface today | Target |
|---|---|
| Rail: Studio → Build | **Removed**; the plan panel lives in Model's empty state |
| `/build` (883 lines) + AskPanel | **Retired** into Model (plan panel, run panel, hide toggle, rebuild) |
| `/products` workshop (915) + BuildDashboard (479) | **Retired**; the coverage map is Model's subject view |
| `/products/[id]` + ProductRootPanel (1,053) + TableNotebook (681) + CellOutput (205) | **Retired**; Preview replaces cell execute |
| AskAIPanel (640), RefineChat (986), KpiManager (506), `refine.ts` routes | **Retired**; one assistant + Definitions |
| Topic page: *Manage this data* / Manage mode (ManageLayer 453 + ManageTables 670) | Manage mode **retired**; curator link *Edit in Model →*; the topic page keeps ask box, try-asking, trust line. Quality and Activity move to Model's context column; *Refresh* stays on `/pipelines` |
| `/shared-data` cards | Link to Model (`/model?table=`) for curators, catalog for viewers |
| Catalog: ProductFullView, ProductTableDetailPanel | Stay as the read-only understanding surface; the SQL viewer, the description edit form and the "Open in Build / Edit in notebook" links become one *Edit in Model →*; the one-sentence Lineage tab is replaced by the same lineage strip as Model |
| Catalog: Glossary facet + GlossaryPanel | **Moved** to `/definitions`; the facet redirects |
| `/relationships` Topics toggle + TopicsCanvas (600) | **Retired**; Model draws the subject's joins. Sources canvas stays |
| `/pipelines` | Unchanged (Refresh data, schedules, runs) |
| `/notebooks` | Unchanged (owner's constraint); gains *Save as declaration →* later, not now |
| ⌘K | "Model", "Definitions" actions; search hits deep-link to the entity |

Net: about 6,900 lines of frontend retired against roughly 2,000 new
(Model ≈ 1,200 incl. tree/editor/context, Definitions ≈ 500, assistant
reuse ≈ 300).

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
2. **Model page** with tree, declaration, preview, context column; the
   assistant reusing `AssistantPanel` + `CellDiff`; retire the workshop, the
   notebook cells, RefineChat, AskAIPanel, Manage mode's Tables tab.
3. **Definitions page**; move the glossary; retire KpiManager and the Metrics
   tab; ⌘K fixes.
4. **Fold Build into Model's empty state**; retire `/build`, the Topics canvas,
   the remaining Manage tabs; rail change.

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

Settled 2026-09-22: audience, unit, documented-only definitions, cut freely
(notebooks stay), code-first, diff-then-Keep, all affected pages mocked.

Open, for after the mockup review: (a) whether *Rebuild this subject* should
exist at all once human declarations survive, or whether "re-derive the
AI-owned tables" is a Refresh option on `/pipelines`; (b) whether the legacy
`kpi_definitions` readers (reports, user notebooks) move to `product_kpis` in
slice 3 or later.

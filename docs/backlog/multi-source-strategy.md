# Multi-source companies: the cases, what exists, what to build

> **Status:** working document, 2026-08-20. Companion to
> `warehouse-value-for-smb.md` — that document carries the *argument* (why a
> shared model, why names before schemas, why the drawer is the escape hatch,
> §5.8's ten-dimension plan of record). This one is the *operational
> inventory*: the real-world situations a multi-source customer brings, an
> honest audit of what the platform already covers, and the build plan that
> closes the gap, in order of leverage.
>
> The one-sentence promise all of this serves: **connect what has a
> connector, upload what doesn't, and everything answers questions from day
> one — then the shared picture grows by confirmation, not by consulting
> project.**

---

## 1. The cases

Each case below is a situation a real SMB walks in with. For each: the
concrete shape, the question they actually ask, and what makes it hard —
because the hard part is almost never the plumbing, it is the *semantics*.

### C1 — Second ERP after an acquisition (connector exists)

Company A runs Exact Online. It acquires Company B, which runs Odoo. Nobody
is migrating anything this year — B's team keeps working in Odoo.

**They ask:** "What is our combined revenue? Who are our top customers across
both companies? Do we sell to the same customers?"

**What makes it hard:**
- The same real-world customer is `ACC-4471` in Exact and `partner 032` in
  Odoo. No foreign key connects them — only a per-row assertion about the
  real world ("these two records ARE VAN DAMME BVBA").
- The charts of accounts differ. "Revenue" is account class 70 in one and an
  analytic tag in the other.
- Semantics differ in ways that silently corrupt merged numbers: the Odoo
  template needs a credit-note sign-flip (`out_refund → -price_subtotal`);
  Exact's credit notes are natively negative. Merge naively and the total is
  confidently wrong — worse than no total.
- Politically, "whose number is right" is loaded after an acquisition. A
  combined figure nobody can verify against each system's own reports will
  simply not be trusted.

### C2 — A source without a connector

A homegrown app on SQL Server. A niche vertical ERP (garage management,
veterinary practice, brewery software). A SaaS tool whose API nobody will
pay to integrate. The long tail of source systems is effectively infinite;
no vendor wins it by hand-building connectors one at a time.

**They ask:** "Can you also include our production system / member database /
industry package?"

**What makes it hard:**
- Building a full connector per niche system does not scale, and telling the
  customer "we'll add it to the roadmap" loses the deal.
- Direct database access works when the database is reachable — but many of
  these systems are hosted, and the only universal interface they expose is
  an export button.
- An undocumented source has no vendor docs channel: semantics come entirely
  from the AI pipeline, which is exactly where the profiler's
  docs-before-inference ladder bottoms out at its weakest rung.

### C3 — Planning and budgets in Excel

The budget is a spreadsheet a controller maintains. Targets per salesperson
are a spreadsheet. The forecast is a spreadsheet. This is not a transitional
state — for most SMBs it is the permanent home of *plan* data, and it is
half of every question that matters.

**They ask:** "Actual versus budget per month per department." — the single
most-asked management question, and it is unanswerable from any ERP alone.

**What makes it hard:**
- Spreadsheets are hostile tables: merged headers, subtotal rows, a matrix
  layout (months as columns) where the warehouse wants rows, typos in the
  department names that must join against the ERP's cost centres.
- They change shape. Next year's budget file has a new column. A refresh
  pipeline that breaks silently on a re-uploaded file destroys trust in the
  one number management cares most about.
- Versioning matters: "budget v3 final FINAL.xlsx" is a real filename. Which
  version is the warehouse reading? The answer must be visible.

### C4 — Departmental truths in SharePoint and other side tools

A SharePoint list of projects. A Teams-linked list of complaints. The CRM
(HubSpot, Teamleader) holding the pipeline. Hours in a staffing tool. Each
department's "real" data lives beside the ERP, not in it.

**They ask:** "Pipeline versus capacity next quarter." "Complaints per
product line." — questions that span the ERP and exactly these satellites.

**What makes it hard:**
- Same as C3 plus access: SharePoint lists and CRMs have APIs, but each is
  its own connector-sized job. (Mitigation: every one of these tools exports
  CSV/Excel trivially, so the spreadsheet path covers them on day one at the
  cost of manual refresh; a proper connector upgrades the ones that earn it.)
- Identity again: the CRM's companies must match the ERP's customers or
  "pipeline per existing customer" is impossible.

### C5 — Legacy history after a system migration

They moved to a new ERP two years ago. The new system holds two years; the
old one holds ten. The old system is read-only, licence expiring, and nobody
will ever build live integration for it.

**They ask:** "Compare to 2021." Every trend question implicitly needs the
old data.

**What makes it hard:**
- One-shot import, not a sync: the data will never change again, so the cost
  of connecting must be near zero (an export file, not a connector).
- The old and new systems disagree on codes: article numbers were renumbered
  at migration. The mapping usually exists — in a spreadsheet made during
  the migration — and must be usable as first-class input.
- Timeline stitching: `fact_sales` must read as one continuous history with
  a visible seam, not two disjoint topics.

### C6 — Multiple entities / group structure

Three BVs, one owner. Or: each Exact Online *division* is its own connection
by design (`exactonline/schema.ts` — one division per connection). They want
the group picture AND the per-entity picture.

**They ask:** "Total group revenue. And show me per company. And eliminate
what we invoice each other."

**What makes it hard:**
- Entity must be an *axis* of every fact (filterable, groupable), not a
  bolt-on consolidation feature.
- Intercompany eliminations need counterparty→own-entity mapping (a Mapping,
  see §5) — but *statutory* consolidation (FX translation, minority
  interests) is accountant territory the platform should refuse, not
  half-build.
- Group reporting needs each entity's CoA mapped to one group reporting
  line structure — again a Mapping, made by a person, in business language.

### C7 — Same connector twice

Two Exact Online administrations, or Exact + a second Exact after an
acquisition. Deceptively simple — the schemas are identical — but it is the
purest test of the model, because every table name collides and only the
tenant's conformed layer can unify them.

**What makes it hard:** everything from C1 (identity, merged facts) with
none of the excuse of different systems. Also already partially real in
production: the pipeline orchestrator had to learn to disambiguate two
products both called "Sales" from different connections.

### C8 — Master-data identity (cross-cutting)

Not a scenario but the substrate under C1, C4, C6, C7: the same customer /
supplier / product exists in several systems under different keys. Every
cross-source answer stands on resolving this, row by row.

**What makes it hard:**
- Deterministic matching gets far in Belgium/NL (VAT number, KBO/BTW — and
  both existing templates already conform `vat_number` under the same
  column name), but coverage is never 100%: consumers have no VAT number,
  products have no universal key.
- Fuzzy matching without review manufactures false merges — two different
  companies fused into one is the single worst data corruption the platform
  could produce, and it is invisible until someone notices a customer's
  revenue is double.
- Decisions must survive rebuilds. A person who confirmed 300 matches and
  loses them to a re-sync will not do it twice (migration 70's
  snapshot-and-merge exists for exactly this class of problem).

### C9 — Semantic conflicts (cross-cutting)

"Revenue," "margin," "open orders" are computed differently per system and
sometimes per department. Merging without deciding produces numbers that are
wrong in ways only an accountant notices — months later.

**What makes it hard:** the decision is a business decision, so the platform
must surface it as one ("Odoo refunds are subtracted; Exact credit notes are
already negative — combined revenue nets both") rather than bury it in
transformation SQL. The glossary and the topic vocabulary are where such
decisions become visible and owned.

### C10 — Grain and calendar mismatches (cross-cutting)

Budgets are monthly per department; invoices are per line per day. The
staffing tool thinks in weeks. An acquired company may close its books on a
different fiscal calendar.

**What makes it hard:** comparisons need explicit allocation rules (spread
the monthly budget over days? aggregate actuals to months?), and the choice
changes the answer. Whatever rule is applied must be stated on the surface
that shows the comparison — the platform's existing honesty rules ("waiting
for data from your source", provenance trails) extend naturally here.

### Cross-cutting difficulties that are not data problems

- **Trust:** a warehouse that cannot prove its totals against each source
  system's own reports loses every whose-number-is-right argument (which
  acquisitions guarantee will happen). Reconciliation is a feature, not a
  QA step.
- **The consultant trap (the real competitor):** in the Microsoft stack all
  of the above becomes Power Query code a consultant wrote — invisible,
  unowned, gone when the consultant leaves. Clarion's structural answer is
  that every reconciliation decision is *content a business user owns, made
  on a screen, in business language*. Protecting that property is more
  important than any single feature below.
- **Freshness asymmetry:** the ERP syncs nightly; the budget file was
  uploaded in January. Both are fine — as long as every combined answer can
  say which is which. The freshness surfaces exist; they must extend to
  file-based sources.

---

## 2. What the platform already has

An honest audit — built and live, versus planned-on-paper, versus absent.

### Built and live

| Capability | Where | What it gives the multi-source story |
|---|---|---|
| Connector framework with docs-before-inference | `packages/connectors/`, `docs/SOURCE_ONBOARDING.md` | A new connector is a curation job with a playbook and a merge gate, not a research project. Semantic precedence ladder (`declared > curated > ai`) is enforced in the profiler. |
| Two full connectors (Exact Online, Odoo) + deterministic star-schema templates | `exactonline/`, `odoo/` | Both templates independently converged on the same conformed concepts — the measured evidence behind the ten-names plan. `vat_number` is already conformed under the same name in both. |
| Direct database sources (Postgres, MySQL, SQL Server, SQLite) | `backend/src/connectors/`, `/sources` tiles | C2's "reachable database" half works **today** via the legacy path: connect, profile, ingest, model. |
| AI designer grounded in reality | bus-matrix orchestrator | Row-count grounding, confirmed-relationships context, additive extension flow (2026-08-20): the warehouse grows subject by subject without rebuilds. |
| Cross-source **match** edges, measured | `/relationships`, `match-preview`, `crossSourceSession` | Draw a line between two sources; Clarion measures the match rate with normalisation (`BE 0123.456.789` = `be0123456789`); confirmed matches reach the AI as identity assertions (`same_entity_as`), explicitly never as JOINs. The *table-level* half of identity exists. |
| Cross-connection transformation plumbing | `loadDependencyDimensions`, `publishStubFromUpstream`, `data_product_dependencies` | Upstream dims resolve across products regardless of connection. The seam for conformed-across-sources dims is plumbed and in daily use. |
| Provenance, lineage, honesty surfaces | `column_lineage`, derived lineage, `sqlProvenance`, freshness states | "Where does this number come from" is answerable per column — the precondition for trusting any merged number. |
| Quality profiling, refresh history, glossary | `QualityProfiler`, `product_table_refresh_history`, `business_glossary` | The raw material for reconciliation and for making semantic decisions (C9) visible. |
| Multi-tenant isolation hardened | RLS enforced with `databridge_app`, per-tenant containers, ownership gates | The platform can safely hold many customers' merged pictures — the precondition for shipped mappings and (much later) benchmarking. |

### Planned on paper (plan of record, not yet code)

- **The ten fixed dimension names + thin attribute contract** (§5.8 of
  `warehouse-value-for-smb.md`): one 12-line list, prompt rules, template
  renames. Items 1–3 are "worth doing regardless"; none has shipped yet.
- **The second-source mapping flow** (§5.8 item 4): AI proposes in plain
  language how source B feeds the dims that already exist; user confirms;
  confirmed mappings are stored and later shipped per connector.
- **The Mapping primitive** (one mechanism, at least three uses:
  customer↔customer, CoA→reporting line, counterparty→own entity), riding
  migration 70's snapshot-and-merge so human decisions survive rebuilds.

### Absent

- **Nothing reads a spreadsheet.** `xlsxBuilder.ts` writes exports; no code
  path ingests XLSX/CSV as a source. C3, C4 (as fallback), C5's export
  files, and C2's long tail all land on this gap first.
- **No per-row identity crosswalk.** Match edges assert that two *tables*
  describe the same things; nothing stores "Shopify 4471 IS Exact VAN DAMME
  BVBA" × 900 rows, and no inbox exists to review such assertions.
- **The query layer is connection-scoped end to end** (`routes/query.ts`,
  `ConnectorFactory`, product context). A question spanning two sources
  cannot be *expressed*, whatever the model layer does. Documented as the
  largest single item; still true.
- **No entity axis, no group mapping, no eliminations** (C6). Exact is
  one-division-per-connection by design; nothing unifies divisions.
- **No reconciliation feature.** Nothing compares Clarion's totals against a
  source system's own reports and says so on a surface.
- **No SharePoint / CRM / REST connectors**, and no generic REST framework
  to make one cheap.
- The `cross_view_relationships` + ATTACH path is SQLite-only legacy — 
  explicitly do-not-build-on (it reads `cfg.filepath`; impossible for any
  API connector).

---

## 3. What we have to build

Phased by leverage: each phase unlocks named cases, and the order respects
real dependencies. Efforts are relative (S ≈ days, M ≈ 1–2 weeks, L ≈
several weeks of sessions), not promises.

### Phase 1 — Spreadsheet & file connector (L) → C3, C4, C5, C2-tail

Built as an ordinary `SourceConnector` in `packages/connectors`, so
profiling, the docs channel (absent → AI pipeline), quality, lineage, the
designer and the new extension flow all work unchanged. Deliberately *not* a
special upload feature bolted onto the side — the whole point is that a
spreadsheet becomes a source like any other.

What it must handle, in order:
1. **Clean tabular files first** (CSV, one-sheet XLSX with a header row):
   upload → entity per sheet → sync = re-upload. DuckDB reads both natively.
2. **The hostile-table reality** (merged headers, months-as-columns
   matrices, subtotal rows): an AI-assisted *shaping* step that proposes the
   unpivot/cleanup in plain language, the user confirms, and the shaping is
   stored and re-applied on every re-upload. The stored shaping is content
   the user owns — the anti-Power-Query property, applied to files.
3. **Versioning and staleness surfaces**: which file, uploaded when, by
   whom; the existing freshness honesty ("waiting for data") extends to
   "budget file from January".
4. Later: pull from OneDrive/SharePoint by URL so "re-upload" becomes
   automatic. Not in v1 — manual re-upload is acceptable for plan data that
   changes monthly.

Why first: it converts three of the four hard scenarios from roadmap to
"works this quarter", it is the cheapest second source for every
single-source tenant (making cross-source value demonstrable), and every
step of the platform it touches already exists.

### Phase 2 — The ten names + second-source mapping flow (M) → C1, C7

The §5.8 plan of record, executed:
1. Write the 12-line dimension list (half a day — it is already designed).
2. Rename the dims in both templates to match (also fixes the live
   `dim_account` collision — PARTY in EO, GL ACCOUNT in Odoo).
3. Add the naming + role-playing + never-conform-status rules to the
   bus-matrix and extension prompts.
4. **The real build:** when a connection is added to a tenant that already
   has a build, the AI maps the new source *into the dims that exist* —
   proposed in plain language ("Odoo's contacts become part of your
   Customers; matched on VAT number"), confirmed by the user, persisted via
   the same shadow/stub/dependency plumbing the extension flow already uses.
   The extension workflow shipped 2026-08-20 is the architectural template:
   collision guards in code, reuse as stubs, dependencies wired post-persist.

### Phase 3 — Identity layer: deterministic crosswalk + review inbox (L) → C8, then C1/C4/C6/C7 fully

The Mapping primitive, built once:
- A stored two-column correspondence (`entity A row ↔ entity B row`) with
  provenance per row: `verified` (VIES/KBO lookup confirmed), `deterministic`
  (VAT/email/code equality), `confirmed` (a person said yes), `suggested`
  (AI, pending). Only confirmed-or-better rows influence answers.
- **Deterministic before fuzzy, measured before shipped**: run VAT/email
  matching on real tenant data first and measure the residual; AI-suggested
  matches go to an inbox, never straight to the crosswalk. The 2026-08-03
  invented-FK incident is the standing precedent for why.
- Survives rebuilds via snapshot-and-merge (third application of the
  migration-70 pattern).
- The same primitive then serves CoA→reporting-line mapping and
  counterparty→entity mapping (Phase 5) with a different UI on top.

### Phase 4 — Un-scope the query layer (L) → pays off every phase above

Ask AI answers over the tenant's *topics*, not over one connection: product
context assembled across connections, the connection selector demoted from
scope-chooser to filter. Everything before this phase builds the merged
model; nothing reaches the end user until the question path can span it.
Sequenced after 2+3 deliberately — un-scoping first would let the model
join across sources on nothing, and confidently wrong cross-source answers
would poison trust in the whole feature.

### Phase 5 — Entity axis + group reporting lite (M) → C6

- `dim_entity` from the ten-list, stamped on every fact where the source
  knows it (an EO division, an Odoo company).
- Group CoA mapping through the Mapping primitive; a "Group" view that is
  activation (roll up entities through confirmed mappings), not statutory
  consolidation. Eliminations v1 = tag intercompany counterparties via the
  crosswalk and let the group view exclude them, visibly.
- Explicitly refuse FX translation and statutory consolidation — say so in
  the UI rather than half-building it.

### Phase 6 — Reconciliation as a shipped feature (M) → trust, C1/C6 politics

Per source, a small set of anchor figures read from the source's own
reporting endpoint (EO has report APIs; for file sources, the file's own
total row) compared against the warehouse's total, on a visible surface:
"Clarion's 2026 revenue = Exact's P&L, to the cent, checked nightly." Green
ticks with a drill-down when red. This is what wins the whose-number-is-
right argument — and it is a *feature*, demo-able, not internal QA.

### Phase 7 — Connector breadth, the cheap way (ongoing)

- A **generic REST connector kit** (auth recipes, pagination patterns,
  cursor conventions) so a new SaaS connector is configuration plus a
  curated entity list — the playbook already defines the phases; the kit
  removes the boilerplate.
- Promote the legacy DB path into the framework so database sources get the
  docs-channel and conformance treatment.
- Prioritise actual demand: the spreadsheet path (Phase 1) is the honest
  fallback that buys time, and the coverage chat now tells us — tenant by
  tenant — which un-synced, un-connectable data people ask about. That
  demand signal, not a roadmap guess, picks the next connector.

---

## 4. Case × phase map

| Case | Served today | Fully served after |
|---|---|---|
| C1 second ERP (connector exists) | connect + separate topics today | P2 (shared dims) + P3 (identity) + P4 (cross-source questions) |
| C2 no connector — reachable DB | **today** (legacy DB path) | P7 polish |
| C2 no connector — export-only tool | — | P1 (file path), P7 when a connector earns itself |
| C3 Excel planning/budget | — | P1, comparisons need P4; grain rules (C10) ride the shaping step |
| C4 SharePoint/CRM satellites | — | P1 (export fallback) → P7 (native), P3 for identity joins |
| C5 legacy ERP history | — | P1 (one-shot import) + P2 (map into existing dims) |
| C6 multi-entity/group | separate connections today | P5 (+P3 for eliminations) |
| C7 same connector twice | connect today, colliding names | P2 + P3 |
| C8 identity | table-level match edges today | P3 |
| C9 semantic conflicts | glossary + per-topic vocabulary today | P2 makes the decisions explicit at mapping time |
| C10 grain/calendar | — | P1 shaping step + stated-rule surfaces |

## 5. What NOT to build (standing guardrails)

Carried over from `warehouse-value-for-smb.md` §7/§8 and still binding:

- **No statutory consolidation, no FX engine.** Entity axis + mappings,
  refuse the rest explicitly.
- **No fuzzy matching before the deterministic residual is measured** on
  real data, and never without a human inbox. False merges are the worst
  corruption this platform could produce.
- **No per-tenant canonical models.** A model determined per customer
  composes with nothing; activation (hide what doesn't apply) is the
  per-customer part, the names are not.
- **Don't extend the SQLite-only ATTACH path.** It cannot work for API
  connectors; the product-layer seam is the real one.
- **Never let a rebuild eat a human's mapping or match decisions** — every
  new decision store rides snapshot-and-merge from day one.
- **No benchmarking before consent and scale**, even though the multi-tenant
  shared names eventually make it possible.
- **Protect the core property everywhere:** every reconciliation decision is
  visible content a business user owns — the moment one becomes hidden code,
  Clarion is a cheaper Power Query, which is a race to the bottom.

## 6. Decisions needed from the owner

1. **Phase 1 scope:** clean-tables-only v1 (fast, covers CSV exports and
   tidy budgets) versus including the AI shaping step from the start (covers
   the real messy files, costs more). My recommendation: v1 clean tables +
   honest error messages that name the problem ("merged headers — not
   supported yet"), shaping as the fast follow, so something ships and the
   failure mode teaches us which shapes matter.
2. **Confirm the sequencing above** — in particular that query-layer
   un-scoping (P4) waits for identity (P3), accepting that cross-source
   questions stay unanswerable a little longer in exchange for never being
   confidently wrong.
3. **The ten-names execution window** (P2 items 1–3): it renames dims in
   both templates, so existing template-built tenants change on their next
   rebuild — cheapest to do while the tenant count is what it is today.

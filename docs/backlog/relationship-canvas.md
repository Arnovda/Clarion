# The relationship canvas — building AI context by drawing

> Status: **build plan**, agreed 2026-08-11. Clean-sheet surface, cross-source from
> day one, review-first, context-only (no rebuilds).
> Read §1 before designing anything: the four decisions are settled and several
> obvious-looking alternatives are ruled out deliberately.

---

## 1. Settled decisions

| Decision | Choice | Consequence |
|---|---|---|
| Primary job | **Review what Clarion proposed** | The default view is *the work*, not a blank canvas. Authoring is possible but secondary. |
| Scope of v1 | **Cross-source from day one** | Requires un-scoping the graph from `connectionId` to tenant, and a second edge kind. |
| Downstream effect | **Enrich AI context only** | Confirming a relation never triggers a rebuild. Instant, safe, reversible. |
| Relation to existing code | **Clean sheet** | New route and components; the old `RelationshipCanvas` is retired at parity. Geometry constants are lifted, not re-derived. |

**The purpose, stated once:** this pane exists so a human can give the AI context
it cannot infer reliably. Every design decision below serves that. It is not an ERD
editor and it is not the onboarding front door.

---

## 2. The five ideas that make it worth building

### 2.1 Measure the relation — never ask the user to declare cardinality

`table_relationships.relationship_type` is currently free text that a human or the
AI *asserts*. The data is in DuckDB. So when a connection is drawn, Clarion answers
immediately:

```
invoices.customer_id  →  customers.id
97% of values found in target · 1-to-many (avg 3.2, max 47) · 23 orphans
```

**The measurement is the confirmation dialog.** Drop a line, see whether it holds,
confirm or cancel. This is the single biggest difference between a diagramming tool
and a data tool, and it is only possible because the data is already local.

Two hard requirements:

- **The UI must use the same thresholds as the automatic detector** —
  `FK_SAMPLE_SIZE`, `FK_MIN_DISTINCT`, `FK_TARGET_UNIQUENESS`, `FK_MIN_CONTAINMENT`.
  If the canvas says 97% and the detector rejected it, one of them is lying.
- **Containment and cardinality come from the same sample.** Mismatched sets were
  the exact defect measured in production on 2026-08-03 (a 500-row sample compared
  against a whole-column total, systematically rejecting wide keys).

The user may always override the measured type. The override is recorded as human
provenance and wins forever (§2.5).

### 2.2 Two kinds of edge, and they are not the same object

| | **Join** | **Match** |
|---|---|---|
| Where | inside one source | between two sources |
| What it is | a real foreign key | an assertion that two tables describe the same real-world things |
| Verified by | containment — do the values exist in the target | match rate — how many rows found a partner |
| Truth lives | in the column | **per row** — 900 customers means 900 decisions |
| Drawn as | solid line | distinct stroke, labelled with the match rate |
| On drop | measure containment + cardinality | open the match panel: *"812 of 900 matched on VAT number, 88 need review"* |

Collapsing these into one concept is the mistake that makes cross-system look easy
and then wrong. A match edge is the **entry point to per-row matching**, not a join.

### 2.3 Source lanes — the layout answers "where does this come from"

Vertical bands, one per source, tinted with the existing `SourceBadge` palette
(`REGISTRY_COLORS`). Tables sit in their lane; **cross-source edges are the only
ones that cross a band boundary**, so the thing the user came for is the thing that
visually pops. A spreadsheet is a lane like any other.

### 2.4 Never render everything

Sixty Exact Online entities and ~170 relationships is a hairball and no layout
algorithm rescues it. Anchor on a cluster, show one hop, expand on demand.
Collapsed node = name + source dot + row count + relation count; expanded node =
column rows with handles. Only expand what an edge touches or the user opens.

Search-first navigation, not scroll-first — reuse the existing `CommandPalette`
pattern to jump to a table.

### 2.5 Provenance is visible, and human always wins

Line style encodes where a relation came from: **vendor-declared** (from connector
docs) · **AI-suggested** · **human-confirmed**. The review queue then stops being a
list and becomes a canvas filter — *"show me the dashed ones"* is the work list.

Human decisions must survive a re-profile. `confirmed_by_user` already exists
(migration 70) and the profiler already snapshots-and-merges confirmed relationships
before its wipe. **Reuse that mechanism; do not add a second one.**

### 2.6 Show the payoff

The stated goal is AI context, so the loop must close visibly. After confirming:

> *"Ask AI can now answer questions that span Exact Online and your webshop."*
> — with a one-click sample question.

Without this the user is drawing lines on faith, which is how a tool like this ends
up unused.

---

## 3. Interaction model

**Default view — the canvas *is* the queue.** Opening the pane lands on the highest-value
unreviewed cluster, unreviewed edges dashed. Inline chips on each edge: ✓ confirm,
✗ reject. Keyboard-first, because this is repetitive work:

```
J / K    next / previous unreviewed cluster
Y / N    confirm / reject the focused relation
E        expand the focused table's columns
/        search for a table
Esc      back to overview
```

**Drawing.** Drag from a column row to a column row. On drop → measure → popover
with the result and the suggested type → Confirm / Adjust / Cancel. Nothing is
written until the user confirms.

**Inspector.** Selected edge shows: the measurement, provenance, description
(editable, this is what the AI reads), and for match edges the per-row review entry
point.

---

## 4. What has to be built

### 4.0 Shipped — slice 1, the measurement endpoint (2026-08-11)

`POST /api/relationships/measure` (analyst+, behind `computeLimiter`) takes four
ids and answers whether the relationship holds:

```
{ verdict, reason, containment, target, cardinality, orphans, thresholds, elapsedMs }
```

Three decisions worth keeping:

- **`verifyFkCandidate` was extracted to `semantic/fkVerification.ts`.** Importing
  it from `SchemaProfiler` dragged in `ConnectorFactory` → DuckDB's native
  binding, which made the measurement service unloadable in any environment
  where that binding is not built. It only ever needed something with
  `executeQuery`. The profiler re-exports it, so nothing else moved, and there is
  still exactly one implementation of the test.
- **The endpoint never refuses and never throws.** Every failure — a missing
  table, an uncastable type, a warehouse that has not materialised, the budget
  expiring — becomes `verdict: 'unmeasurable'` with a machine-readable `reason`.
  A weak or broken result is reported, not blocked: the source may simply not
  have finished syncing, and the human decides.
- **Its own wall-clock budget** (`RELATIONSHIP_MEASURE_TIMEOUT_MS`, 8s) far below
  DuckDB's 45s query timeout, because this runs under an open popover. When the
  budget wins, the abandoned query gets a rejection sink — otherwise the route's
  `disconnect()` turns it into an unhandled rejection.

`verdict` is `strong` | `weak` | `broken` | `unmeasurable`, and `thresholds` is
echoed so the UI can say "min 85%" without hardcoding a number that lives in the
detector's env.

**Cross-source returns 400 `cross_source_unsupported`** rather than measuring the
wrong thing — that needs two connections' views in one DuckDB session (slice 6).

17 unit tests, no DuckDB required (`tests/relationshipMeasure.test.ts`).

### 4.0b Shipped — slice 3, the tenant-scoped graph (2026-08-11)

`GET /api/relationships/graph` (analyst+). Optional `connectionId`,
`anchorTableId`, `depth` (1–3), `withColumns=1`. Returns sources, tables,
relationships, and the stats the queue-as-canvas needs
(`pendingReview`, `crossSource`, `unresolved`).

**It reads Postgres, not Neo4j — deliberately.** `semanticGraph` matches nodes by
a bare `pgId` with no tenant predicate, so every route using it must gate each id
first. That works when the caller names one entity; it inverts here, where the
request means "everything this tenant has" — gating would mean fetching an
unscoped graph and filtering it against an ownership query, i.e. reading other
tenants' rows in order to discard them. Postgres carries `tenant_id` on all three
tables, and the dual-write contract already lists whole-tenant aggregate reads as
legitimately Postgres-side. Every query filters `tenant_id` **explicitly** rather
than trusting RLS, because `reqDb` can fall back to the pool whose session-level
tenant variable has a documented race.

Three shaping rules, all unit-tested:

- **`isCrossSource` is computed server-side**, so the canvas never joins tables to
  discover which edges cross a lane boundary — the one thing it exists to show.
- **An edge with one endpoint outside the requested scope is dropped**, not
  half-drawn. Same for an unresolved endpoint (`Table.? -> Other.ID`, eight of
  which the 2026-08-03 audit found in one tenant) — dropped from the drawing but
  **counted** in `stats.unresolved`, so a broken catalog is discoverable rather
  than invisible.
- **Truncation is reported.** `MAX_TABLES` caps the payload and sets
  `truncated: true` while `stats.tables` still carries the real total. A silent
  cap reads as "this is your whole graph" when it is not.

`provenance` is derived as human > ai > declared: a confirmed relationship counts
as human even if it began as an AI draft, because confirming is taking ownership —
otherwise the canvas would keep showing work the user already did.

### 4.0c Shipped — slice 4, the canvas (2026-08-11)

`/relationships` (analyst+), in the **Studio** nav group — deliberately the
demoted builder group, because this is a repair and escape-hatch tool, not the
front door.

`components/relationships/`: `geometry.ts` (lifted constants) · `types.ts` ·
`laneLayout.ts` · `TableNode` · `LaneNode` · `RelationEdge` · `MeasurePanel` ·
`GraphCanvas`.

What was built, and why each choice:

- **Source lanes are NODES, not an overlay.** An absolutely-positioned band sits
  in screen space and drifts away from its tables the moment anyone pans or
  zooms. As a node, ReactFlow applies the same viewport transform it applies to
  everything else and the band stays welded to its contents.
- **Not dagre.** Dagre optimises for hierarchy and would interleave tables from
  different sources wherever that shortened an edge — destroying the one property
  the layout exists to provide. `laneLayout` packs each source into its own band,
  most-connected table first, so the hub of a source is visible without scrolling.
- **Nodes are collapsed by default.** Sixty tables showing forty columns each is
  the hairball the design exists to avoid. Columns appear on expand, and only
  then do per-column handles exist to draw from; edges re-anchor from the node to
  the specific column row as nodes open.
- **Provenance is carried by line style**, not a badge — the default view is a
  review queue, so "what has nobody checked?" must be answerable across the whole
  graph at a glance. Human = solid ocean, declared = thin grey, AI = dashed amber.
  A match edge additionally carries a second offset stroke so it can never read
  as a join.
- **Drawing measures before it saves.** Drop a line → `POST /measure` → the
  `MeasurePanel` states the verdict in plain language and the measured shape.
  Nothing is written until "Keep it", so an exploratory drag costs nothing, and
  the measured cardinality becomes the stored `relationship_type` — the graph
  records what the data says rather than what anyone assumed.
- **The panel never blocks.** Weak and broken verdicts keep the Keep button
  enabled, because a half-synced source looks exactly like low containment.
- Thresholds in the copy come from the response, never hardcoded — the UI must
  not state a different number from the one the detector applied.

`next build` green; `/relationships` is 2.69 kB / 100 kB first load because
ReactFlow is dynamically imported and so costs nothing on any other page.

**Not yet:** the keyboard queue model (slice 5), match edges (slice 6), and
cross-source measurement. Confirm/reject on an existing edge is still done from
the old surface.

### 4.0d Shipped — slice 5, the review loop (2026-08-11)

Scope was widened from "keyboard model" to **the whole edge lifecycle**. A review
tool that can create a relationship but not remove a wrong one is not a review
tool, and removing was on the explicit must-have list.

`EdgeInspector` — click any edge (or press `J`) and get:

- **provenance in plain language** — "Confirmed by you" / "From the source" /
  "Suggested by Clarion", each with a sentence saying what that means;
- **the measurement**, with *Check again* to re-run it on demand. The result is
  cached to `table_relationships.measured` (migration 77), so the column is now
  live and a second visit shows the numbers without re-running anything;
- **an editable description**, labelled as *what Clarion reads when answering
  questions* — this is the most direct way a person can teach the AI something it
  could not infer, and it deserved to be said out loud rather than presented as a
  bare text field;
- **Looks right** (confirm) and **Remove** (delete).

Keyboard: `J`/`K` step the pending queue, `Y` confirm, `N` remove, `/` search,
`Esc` deselect. Shortcuts check the event target first so they never fire while
someone is typing a description.

**Confirm closes the loop visibly** — "Ask AI can now answer questions that span
both sources." Without that the user is drawing lines on faith, which is how a
tool like this goes unused.

Backend: `PATCH /semantic/relationships/:id` now accepts `measured`. Persisted to
**Postgres only** — the Neo4j edge carries no measurement, and mirroring a
statistic that changes on every sync would give the two stores a third way to
disagree. An empty PATCH remains a valid confirm; the server already flips
`ai_draft` and stamps `confirmed_by_user`, which is what makes a confirmation
survive a re-profile.

### 4.0e Shipped — slices 6 and 7, cross-source matching (2026-08-11)

`POST /api/relationships/match-preview`. Drawing between two sources now opens a
**match** panel rather than the join panel, because they answer different
questions and asking one with the other's question is the mistake this whole
design exists to avoid.

- **Two sources in one DuckDB session.** `crossSourceSession.buildTwoSourceConnector`
  resolves each table's URI through `listSourceTables` and registers both under
  fixed neutral view names — two sources may each have a table called `Accounts`,
  so their real names cannot be used. `DuckDBConnector.ephemeral`, deliberately:
  a one-off scratch session must not take a key in the pool every other surface
  reuses.
- **Split for the same reason as `fkVerification`.** `matchMeasure` is pure and
  unit-tested; the connector construction lives in `crossSourceSession`, so
  importing the measurement does not drag in DuckDB's native binding.
- **Normalisation is the whole game.** Default `loose` strips non-alphanumerics
  and upper-cases, so `BE 0123.456.789` and `be0123456789` are the same company.
  Comparing raw strings understates the real overlap, and understating it is what
  makes someone conclude their data cannot be joined when it can. `exact` is one
  click away in the panel.
- **The unmatched samples are the point** (this is slice 7's substance). A rate of
  68% is a number; seeing that every miss is formatted differently tells you it is
  a formatting problem you can fix.
- **Stored as `kind='match'`** with `match_keys` and the measurement, never as a
  join.
- **`getMatchAssertions` phrases match edges for the AI as identity assertions** —
  carrying `relationship_type: 'same_entity_as'` and a description that states
  outright that this is not a foreign key and must not be JOINed on. Only
  *confirmed* matches reach the prompt: an unreviewed guess about identity should
  not be shaping answers.

**Two things found and fixed while building:**

- `POST /semantic/relationships` was **admin-only** while PATCH and DELETE were
  admin+analyst — so an analyst on the canvas could measure a link, see that it
  holds, and then be refused when saving it. Widened for parity.
- The confirm message claimed *"Ask AI can now answer questions that span both
  sources."* **That is not true yet** — the query layer is still
  `connectionId`-scoped, so a match cannot be used to answer a cross-source
  question. The copy now says what is actually true: Clarion knows these describe
  the same things. The claim becomes true when the query layer is un-scoped
  (warehouse-value plan §4.2a).

**Not shipped, and it is the honest boundary of slice 7:** the persisted per-row
crosswalk — deciding, storing and re-using "Shopify customer 4471 IS Exact's VAN
DAMME BVBA" for 900 rows. That is the identity layer, and it is a separate and
much larger piece than a panel.

### 4.1 Backend (the actual prerequisites)

1. **Tenant-scoped graph endpoint** — `GET /api/graph?scope=tenant` returning tables
   + columns + relationships across **all** the tenant's connections, with source
   attribution. Everything today is `connectionId`-scoped
   (`routes/semantic.ts`, `SourceRootPanel`). This is the same un-scoping problem as
   the query layer and it is the largest single item here.
   **Gate every id through `denyUnlessOwned` / `ownedIds`** — Neo4j has no tenant
   predicate (see CLAUDE.md's dual-write contract).

2. **Measurement endpoint** — `POST /api/relationships/measure`
   `{ fromTableId, fromColumnId, toTableId, toColumnId }` → containment, target
   distinctness, measured cardinality, orphan count, sample size.
   - Reads via DuckDB over the source parquet.
   - **Cross-source measurement needs views from two connections in one session** —
     `createProductConnector` is connection-scoped today. This is real work, not a
     query.
   - Must reuse the detector's constants (§2.1).
   - Guarded by `assertSafeReadQuery`; the column names are identifiers, so they
     must be validated against the catalog, never interpolated raw.

3. **Migration** — `table_relationships` gains:
   - `kind` — `'join' | 'match'` (default `'join'`, so existing rows are unchanged)
   - `measured` — jsonb: containment, cardinality, orphans, sampled_at
   - `match_keys` — jsonb, for match edges
   Note the table has **no `connection_id`** — scope resolves via `from_table_id`
   (see `db/semanticCacheScope.ts`).

4. **AI context** — `getRelationshipsForContext` must carry match edges too, phrased
   differently from joins: *"Customers in Exact Online and Shopify are the same
   companies, matched on VAT number."* A join instruction and an identity assertion
   must not read the same way in the prompt.

### 4.2 Frontend (clean sheet)

New route `/relationships`, analyst+, tenant-scoped. New components under
`components/relationships/`.

Lifted from the old canvas rather than re-derived (solved geometry, not
architecture): `HEADER_H` / `ROW_H` / `NODE_W` and the `L_<id>` / `R_<id>` handle-ID
scheme — handle alignment against column rows is fiddly and currently correct.

Everything else is new: source-lane layout, collapsed-by-default nodes, the two edge
kinds, the measurement popover, the queue-as-canvas shell, the keyboard model.

Observatory tokens throughout (`lib/observatory.ts`), ReactFlow 11 + dagre already
present.

### 4.3 Retirement

`RelationshipCanvas.tsx` (1,975 lines) and `components/catalog/relationships/*` are
retired **only at parity**, and only once the new surface handles the single-source
review case at least as well. Until then both exist; the old one stays reachable
from the catalog.

---

## 5. Build order

| # | Slice | Why here |
|---|---|---|
| 1 | ~~Measurement endpoint, single-source only~~ **DONE 2026-08-11** | `POST /api/relationships/measure`. Independently useful, testable without any UI, and it is what makes the canvas a data tool. Can be exercised from the existing canvas before any new UI exists. |
| 2 | ~~Migration — `kind`, `measured`, `match_keys`~~ **DONE 2026-08-11** (`20260811000077`) | Small, unblocks both edges. Additive only: `kind` defaults to `'join'` so every existing row keeps its meaning and no backfill is needed. |
| 3 | ~~Tenant-scoped graph endpoint~~ **DONE 2026-08-11** | `GET /api/relationships/graph`. The prerequisite for anything cross-source. |
| 4 | ~~New route + source lanes + collapsed nodes + join edges~~ **DONE 2026-08-11** | `/relationships`, analyst+, in Studio. |
| 5 | ~~Queue-as-canvas + keyboard model~~ **DONE 2026-08-11** — scope widened to the full edge lifecycle (inspect / confirm / remove / edit / re-measure), because a review tool that cannot remove a wrong relationship is not one. | Turns it into the review tool that was chosen as the primary job. |
| 6 | ~~Match edges + cross-source measurement~~ **DONE 2026-08-11** | `POST /match-preview`; two sources in one DuckDB session. |
| 7 | ~~Match panel~~ **PARTIAL 2026-08-11** — the panel and the unmatched samples ship; the persisted per-row crosswalk is the identity layer and stays a separate, larger piece. | The bridge into the identity layer (§2.2 of the warehouse-value plan). |
| 8 | Retire the old canvas | At parity, not before. |

---

## 6. What NOT to do

- **Do not make it the onboarding front door.** It is the escape hatch and the
  repair tool. A new customer must never meet 170 edges on day one.
- **Do not auto-rebuild** on confirm. Decided: context only.
- **Do not render the full graph.** Anchor and expand.
- **Do not let a match edge be stored as a join.** They are different objects with
  different verification and different prompt text.
- **Do not add a second human-edit-survival mechanism.** Migration 70's
  snapshot-and-merge already exists.
- **Do not interpolate column names into measurement SQL.** Validate against the
  catalog first.
- **Do not persist layout positions in v1.** Auto-layout that is good beats manual
  layout that must be maintained.

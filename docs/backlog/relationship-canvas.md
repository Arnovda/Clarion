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
| 1 | Measurement endpoint, single-source only | Independently useful, testable without any UI, and it is what makes the canvas a data tool. Can be exercised from the existing canvas first. |
| 2 | Migration — `kind`, `measured`, `match_keys` | Small, unblocks both edges. |
| 3 | Tenant-scoped graph endpoint | The prerequisite for anything cross-source. |
| 4 | New route + source lanes + collapsed nodes + join edges | The pane, single-source parity. |
| 5 | Queue-as-canvas + keyboard model | Turns it into the review tool that was chosen as the primary job. |
| 6 | Match edges + cross-source measurement | The reason for cross-source-from-day-one. |
| 7 | Match panel → per-row review | The bridge into the identity layer (§2.2 of the warehouse-value plan). |
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

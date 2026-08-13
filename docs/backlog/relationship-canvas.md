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

> **SUPERSEDED 2026-08-13 — see §4.0h.** Lanes were built, shipped, and then
> removed. The property was real (a cross-source edge is the only kind crossing a
> band boundary) but it only pays off in a view that draws the whole graph, and
> §2.4 says never draw the whole graph. The two ideas could not both be right.
> Source identity now rides a 5px colour spine on each node, which works in a
> focused view where there are no bands to cross.

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

### 4.0f Fixed — the first version rendered everything (2026-08-13)

The canvas shipped ignoring its own §2.4. It loaded all 36 tables of a
single-source tenant, and because a lane stacked its tables in ONE column, the
layout was a ~3,300px ribbon one node wide. `fitView` dutifully zoomed out to fit
it, and the result was an illegible strip of scribbles in the middle of an empty
screen. Two causes, both structural rather than cosmetic:

- **A lane was a strip, not a block.** `packLane` now wraps a source into columns
  of at most seven, so a lane stays roughly screen-shaped however many tables it
  holds.
- **The default view was a map, not the work.** Review is now the default mode:
  the canvas shows the focused relationship's two tables plus one hop, with the
  pair opened on their joined columns and everything else dimmed to read as
  context. `Explore` is a deliberate second mode for seeing the whole graph.

Also: the viewport refits when the visible set changes, with `maxZoom: 1` and
`minZoom: 0.25`, so nothing can shrink below reading size to fit — the specific
mechanism that made the first version unusable.

**The lesson worth keeping:** "never render everything" was written down as rule
§2.4, the graph endpoint was built with `anchorTableId` and `depth` to support it,
and the canvas then called it with neither. A constraint that is implemented in
the API but not exercised by the only caller is not implemented.

### 4.0g Explore rebuilt around one anchor (2026-08-13)

The full-graph view was the thing §2.4 was written to prevent, and seeing it
running made that obvious in a way the plan did not. Four changes:

- **No "everything" view.** Explore centres on one table and shows what it
  connects to. Finding a table is a *list* problem — a node-link diagram is a poor
  instrument for orientation and an excellent one for "what does THIS connect
  to?" — so `TableList` handles the finding and the canvas is reserved for the
  answer. Sorted by relationship count: hubs are what someone exploring wants,
  and alphabetical buries them.
- **Expansion resets on mode change.** Two 40-column nodes had leaked in from
  Review's auto-expand; at ~1,200px tall they destroyed the lane packing, which
  assumes roughly uniform node heights.
- **Only edges touching the focus are drawn.** A neighbour's own relationships
  are not this view's subject.
- **Source colour concentrated in the spine.** It stays always-on, but tinting
  the header, the border and every row rule in one hue meant a single-source
  tenant saw "everything is beige" rather than "this is Exact Online".

### 4.0h One table in the middle, its join surface visible (2026-08-13)

The grid was still a grid. Clicking a table in the list changed which nodes were
on screen but nothing said *which one the view was about*, and you still had to
open a table and read forty column rows to find the two fields it actually joins
on. Both are answers the layout should give, not the user's clicking.

**What a person does here is one of exactly two things**, and every decision
below follows from that:

1. *"I care about this table — what does it connect to, and on which fields?"*
2. *"Is this suggested relationship right?"*

Neither is "look at my whole graph". So there is no view that draws it.

- **Explore is a ring: the anchor dead-centre, its neighbours around it**
  (`focusLayout.ts` → `radialLayout`). Centre is not decoration — it is the only
  layout in which the subject of the view needs no label. It also removes edge
  crossings *by construction*: every edge runs from the centre outward, so no two
  can cross. That is worth more than any routing cleverness on a grid. An ellipse
  rather than a circle because screens are wider than they are tall.
- **A table shows the fields it CONNECTS ON, not all of them and not none.** This
  is the change that answers the actual request. Forty columns buries the answer
  to the only question being asked; zero columns makes you click to find it. The
  join surface is both the answer and small — usually two or three rows — so every
  edge terminates on a *named field* at both ends with nothing to open.
  `+N more fields` reveals the rest, which is what drawing a NEW relationship
  needs; that is the one job that legitimately wants the whole list.
- **Review is the pair, side by side** (`pairLayout`), both showing their join
  surface, the focused relationship's two columns lit. Previously review drew one
  hop of context around the pair; the evidence for the decision is the
  measurement in the inspector, not the neighbours, and the neighbours were
  clutter.
- **Handles follow the geometry.** Edge ends were hardcoded right-to-left, so
  every neighbour on the left half of the ring got a line that swept all the way
  around its node. The side is now chosen from the two nodes' x positions.
- **Lanes and `laneLayout.ts` are deleted** — see §2.3. `sourceColors.ts` keeps
  the palette and the stable per-source assignment.
- **Ring capacity is 12**, ranked by how many links a neighbour shares with the
  anchor, then re-sorted so same-source neighbours sit adjacent (a ring that
  alternates sources makes the colour spine useless). When a hub has more, the
  toolbar says *"showing 12 of 31"* rather than pretending the ring is the whole
  answer — the §6 rule against silent truncation.
- **Finishing the queue now says so.** Previously an empty queue silently bounced
  you to Explore; there is now an "everything has been reviewed" card, and the
  bootstrap that opens on the first pending item runs **once** rather than on
  every render, which is what caused the bounce.

`nodeHeight()` is the single expression the layout and the node component both
call. They must agree exactly or edges land off their rows and the ring stops
being centred.

### 4.0i The table list is the work list (2026-08-13)

Owner feedback, and it is the right complaint: *"how do I check or edit per
table? I can't select anything myself."* Review walked a global queue in
whatever order the rows came back in, and the table list existed only in
Explore, where all it did was move the camera. Between the two there was no way
to say **"I want to go over the bank entries"** — which is how a person actually
works through this.

- **The list is present in both modes.** It is how you choose what to work on.
  Without it the canvas decides for you and there is nothing to click.
- **Expanding a table shows its relationships**, each one clickable straight into
  the inspector. Undecided ones sort first and carry a hollow amber dot; decided
  ones a solid dot — the same vocabulary as the edges on the canvas. This is the
  "edit per table" path: you no longer have to reach a relationship by stepping
  through a queue that might never offer it.
- **Picking a table in Review narrows the queue to that table**, and the toolbar
  says so with a one-click *"Review everything"* out. A filter you cannot see is
  a filter you get stuck in.
- **Pending counts sit on the table rows** (amber when non-zero, the plain
  relationship count otherwise), and tables sort pending-first. The list answers
  "where is the work?" before you click anything.
- **Clicking a table means one thing everywhere** — same handler from the list
  and from a node on the canvas.
- The scope is set by clicking, **never derived from the current queue item**.
  Deriving it would let the queue silently narrow itself to whatever it landed
  on, which is the sort of bug that looks like data loss.

### 4.0j Values behind the number, cardinality on the ends (2026-08-13)

Two owner observations, both about things the screen showed without explaining.

**A percentage on its own is not evidence.** The panel led with `FOUND 0%`
above a sentence reading *"it may still be right"*, which is a contradiction to
look at — and neither told you whether the gap was a formatting difference you
can fix, the wrong column entirely, or a genuinely absent parent. All three look
identical as 0%.

- The measurement now returns `examples`: a few source values that found a
  partner, a few that did not, and a few from the target for comparison.
  Rendered side by side, `BE 0123.456` against `be0123456` is a fixable
  difference you can *see*. This is the same reasoning that made the unmatched
  samples the substance of the cross-source match panel (§4.0e), applied to
  joins.
- **Sampling is deliberately NOT in `verifyFkCandidate`.** That runs for every
  candidate of every table during profiling and must not carry a presentation
  cost.
- **It has its own sub-budget** (a third of the total, capped at 2.5s) and its
  own try/catch. The first attempt raced all three queries against one wall
  clock, which meant a slow sample query could return `unmeasurable` for a
  measurement that had already succeeded — the answer lost to the thing meant to
  explain it.
- The panel leads with the verdict in words, then an **overlap bar** reading
  *"2 of 24 values exist in Payment conditions.ID"*. The `too-few-distinct` copy
  split in two: all-matched-but-too-few genuinely is "may still be right";
  none-matched is evidence and now says so.

**Cardinality moved to the line ends.** `N—1` floating between two tables tells
you the shape but not which side it applies to, so you work it out every time.
Each end now carries its own symbol — **1** for one row, **∗** for many — which
is what every ERD tool does, for this reason. The middle badge survives only on
match edges, where it shows the match rate and where a cardinality would be a
lie. A legend in the corner names the two symbols rather than assuming ERD
literacy.

### 4.0k The checks are shown, not just their conclusion (2026-08-13)

Owner, on seeing a measurement: *"I suspect this was done with AI on the fly?
I don't want AI for this, just pre-existing checks and controls with the
explanation. And flag any problems."*

**It was never AI**, and it never has been — `verifyFkCandidate` is three fixed
rules run as SQL against the tenant's own warehouse, with thresholds from the
environment. But the panel printed only the verdict, so from the outside there
was no way to tell a measured rule from a language model's opinion. That is the
defect: *a verdict you cannot audit is one you have to take on faith*, and this
pane exists precisely so nobody has to.

- **The three rules now render as a checklist**, each with what was measured and
  what it had to beat: enough distinct values to judge · the other column
  identifies one row · values found on the other side. Plus one line stating
  outright that these are fixed SQL rules with no AI, and that the same rules
  decide what Clarion suggests in the first place.
- **All three always show**, even though the detector short-circuits at the
  first failure. The single measurement query computes every number anyway, and
  seeing all three is what makes the verdict checkable rather than announced.
- **Thresholds come from the response**, never hardcoded in the UI — they live
  in the detector's environment, and a panel quoting a different number from the
  one applied would be lying about which of the two is wrong.
- **Contradictions are flagged.** A relationship the source system *documents*,
  or one a colleague already *confirmed*, that measures `broken` is the case
  worth interrupting someone for — it is nearly always an unfinished sync rather
  than a wrong link, and saying so turns a number into a next step. Exactly the
  shape of `Documents.FinancialTransactionEntryID → TransactionLines.ID`
  [declared] measuring 0% with 330 unmatched.
- **Robustness fix found while here:** `cardinality` reaches the edge as a CAST
  of a free-text database column, not a validated enum, so a stored value
  outside the four keys yielded `undefined` and indexing it would have thrown
  inside a render — taking the whole canvas down.

### 4.0l Check a whole table at once (2026-08-13)

Owner: *"can you add a run button that does this assertion per table, so I
don't have to check every relationship separately? And show which columns'
values don't match, or don't match at all."*

- **`POST /api/relationships/:id/check`** — measures an existing relationship
  and caches the result on the row. **It exists because measuring is not
  deciding.** The obvious way to store a measurement was
  `PATCH /semantic/relationships/:id { measured }`, but that handler treats any
  patch as a person acting on the relationship: it stamps `confirmed_by_user`
  and clears `ai_draft`. So "check this again" was silently confirming an AI
  suggestion nobody had looked at — and a table-wide sweep would have emptied
  the review queue as a side effect of asking a question. Found while building
  this; the single-relationship path was already doing it.
- **Sampling example values is now optional.** A sweep is a list of pass/fail;
  the values are what you open afterwards, on the one that failed. Skipping
  them removes a third query per link.
- **The run lives in the table list**, on the expanded table, as one line that
  is either the offer, the progress, or the result — never more than one line,
  because it sits directly above the rows it describes.
- **Two at a time**, because DuckDB allows two concurrent queries per tenant;
  more would only queue while making each likelier to hit its own budget and
  come back "could not check". A failed link does not stop the sweep. Results
  land one by one rather than after a single reload, which is what makes a
  thirty-second wait legible. Navigating to another table abandons the run —
  its progress line belongs to that table.
- **Three outcomes, not four verdicts.** `weak`/`broken` blur the distinction
  the owner asked for; the ratio does not. **holds** (green) · **partly match**
  (amber — usually a formatting difference worth fixing) · **no match** (red —
  usually the wrong column or an unfinished sync) · not checked. `holds` still
  requires the whole verdict, not just a high ratio: a link can match 100% and
  still fail because the other column is not an identifier.

### 4.0m Flagging — the third thing you can say (2026-08-13)

Owner, looking at a human-confirmed link measuring 0%: *"I really want to flag
this while I'm investigating the table — is that possible?"* It was not.

A relationship had exactly two states a person could put it in: **confirmed**
or **deleted**. Neither fits the finding that actually turns up — *the data
says this does not hold, but I am not deleting it, the source has probably not
finished syncing.* Deleting throws away a link that is very likely real;
confirming asserts something the data contradicts. So people do neither, and
the finding dies with the panel. (`table_relationships` has no
`approval_status`, which is why §slice-5 made rejection a hard delete.)

- **Migration 78** adds `flagged_at` + `flagged_reason`. A nullable timestamp,
  not a boolean, because *when* it was raised is what tells you whether a sync
  has had time to fix it since. Deliberately **not** `approval_status`: source
  tables and columns carry that with its own draft/approved/flagged vocabulary
  tied to the AI review queue, and a relationship's flag is an observation
  about the DATA, not a step in that queue.
- **`POST /api/relationships/:id/flag`**, and like `/check` it does **not**
  touch `confirmed_by_user` or `ai_draft` — flagging is an observation, not a
  decision that the relationship is real.
- **A flag has teeth.** `getRelationshipsForContext` now excludes flagged
  edges, so a link a person says does not hold stops being handed to the model
  as a joinable key. That is the whole reason to flag rather than leave a note
  somewhere, and the panel says so in as many words. One click puts it back.
  This is the one field where `flagged` is mirrored onto the Neo4j edge — so
  the AI-context read can filter in its own `MATCH` rather than subtracting a
  Postgres query from a graph result. The reason text stays in Postgres only.
- **Findable, or it is decoration.** Flagged links sort to the top of a table's
  list and carry a flag icon; the table row shows a flag count that outranks
  the pending badge; the toolbar carries the tenant-wide total. `stats.flagged`
  counts over **every** row, including ones that are no longer drawable — a
  flag raised on a link whose endpoint later stopped resolving is still a flag
  you are owed an answer on.

### 4.0n Evidence outranks provenance (2026-08-13)

Owner, after sweeping one table: *"Look how many fail just from this one table.
Are these documented relations in the API? They appear to be trustworthy
because of their blue line, but some match for 0 percent."*

**Answered factually first.** None of the failing columns is documented by
Exact Online. `TransactionLines.JournalCode → Journals.Code` **is** curated
(`entities.ts:881`) and measures 100%; `→ Journals.ID` is neither documented
nor curated and measures 0%. Same for
`Documents.FinancialTransactionEntryID → TransactionLines.ID` (0%, 330
unmatched) and the `AccountCode`/`LineNumber → GLClassifications.Code|Name`
family at 76–80%. These are precisely the invented FKs the 2026-08-03 audit
measured — it named those columns and `→ GLClassifications.Name` explicitly.
This tenant was profiled before the detector was rebuilt, so the rows survive;
a re-Analyse would not create most of them today.

**The design defect the owner spotted.** The line encoded only *who asserted
this*, so a human-confirmed link measuring 0% drew as the strongest, most
trustworthy line on the canvas. Who says so and whether the data agrees are
unrelated facts, and only one of them was visible.

- **Colour is now what the DATA says** — neutral (unchecked) · holds · partly ·
  no match — and **dash is who asserted it**, so an unreviewed suggestion still
  reads as provisional without competing for the colour channel. Unchecked
  stays neutral rather than green: not-yet-checked is not the same as fine, and
  that conflation is the whole bug. A flag outranks both.
- **You can find the damage now.** The sidebar gained a *Needs attention*
  filter (flagged, contradicted, or undecided — deliberately not "unchecked",
  which before the first sweep is everything and therefore filters nothing) and
  a **Check all shown** sweep, scoped to whatever the list is currently showing
  so search doubles as scoping. The toolbar reports `N checked · M don't hold`
  at tenant scale, which "169 links" never hinted at.
- **A table's links are grouped by the field they leave from.** One column with
  two targets is the most common defect in this catalog and it is invisible
  when the rows are scattered; adjacent, `JournalCode → Journals.Code` at 100%
  next to `JournalCode → Journals.ID` at 0% needs no explanation. A `N targets`
  marker says it outright.

### 4.0o Reading both columns against each other (2026-08-13)

Owner: *"I'd like to investigate a sample value from the two columns on either
side of the relation — a pop-up in the middle showing both columns, sorted
ascending and scrollable, so people can really set the values against each
other."*

Right, and it is where the investigation currently stops: five sample values
are enough to form a suspicion, not to settle one.

- **`GET /api/relationships/:id/values`** returns up to 300 distinct values per
  side plus the REAL distinct count, so the cap can be stated rather than
  quietly implied. Never cached: values change with every sync, and a stale
  column of data is worse than a slower dialog.
- **Compared and ordered as TEXT**, matching how `verifyFkCandidate` compares
  them. Ordering a numeric key as text gives 1, 10, 100, 2 — visually odd, but
  it is the ordering under which the two columns were judged to match, and
  showing a different one would invite exactly the wrong conclusion.
- **THE WINDOWS HAVE TO COVER THE SAME RANGE — the first version did not, and
  it lied.** Owner caught it: `Payments.TransactionID → TransactionLines.ID`
  measured a true **100%** while the dialog reported *30 on both sides · 458 on
  one side only*. Cause: the first N of each side were fetched independently,
  so with 218 GUIDs on the left (all late in the alphabet) against the first
  300 of 2,589 on the right (all early), the two windows barely overlapped and
  every row read as a mismatch. **Same defect shape as the 2026-08-03 detector
  bug**: a numerator from one sample and a denominator from another. Two fixes,
  both required — `matched` is now an EXISTS against the **whole** parent
  column so the headline always agrees with the check, and the parent side is
  fetched **within the child window's range** so the two columns describe the
  same stretch of the value space. The header says *only the matching stretch*
  rather than "first 300", which would be both wrong and misleading.
- **Paired values survive the cap first** (`ORDER BY (v IN left) DESC, v`).
  Ordering the parent side plainly by value and cutting at 300 drops the tail
  of the range — so a value ticked as *found* sat opposite an empty cell, which
  reads as a contradiction of its own tick. The merge exists to align; a cap
  that breaks the alignment defeats the only thing it is for. Unpaired parent
  keys fill whatever room is left. The header says `showing N that line up with
  the left` rather than implying the list is the column.
- **The tick is the fact; the gap is only alignment.** A row with nothing
  opposite it may simply be past the end of the parent's window, so only a
  LEFT value whose `matched` is false is highlighted. A parent key nobody
  references is normal and is not a finding.
- **THE LISTS ARE MERGED, not shown side by side.** This is the whole design.
  Two independently scrolled columns tell you almost nothing — row 40 on the
  left has no relationship to row 40 on the right. Interleaved, an equal value
  occupies ONE row and a value present on one side only leaves a gap opposite
  it, so **the shape of the mismatch is the shape of the whitespace**. With a
  `BE 0123.456` / `be0123456` formatting difference every row is a gap and the
  two ragged columns say "these never line up" before a character is read.
- A missing value renders as an EMPTY cell, not a dash or a label: the gap is
  the finding, and anything written into it reads as a value.
- Counts above the list (`N on both sides · M on one side only`) and an
  **Only show differences** filter, which is what you want the moment overlap
  is partial rather than zero.
- The merge is a pure function and was dry-run against identical / disjoint /
  partial / empty / formatting-difference / numeric-as-text inputs, asserting
  that neither side loses a value.

### 4.0p Audit of everything else the pane displays (2026-08-13)

After the value-comparison bug, the owner asked for the rest of the pane to be
checked for the same class of defect — **a number computed over one population
and labelled as another** — and for the display to be verified as functionally
correct. Six findings, all fixed. Three are the same class.

**Same class as the bug that prompted this:**

1. **Direction was reversed on incoming links.** `linksFor` rendered every link
   as `ownColumn → other`, so a relationship pointing AT this table read
   `ID → Payments.TransactionID` — a primary key drawn as if it were a foreign
   key pointing away. The arrow now runs the way the relationship does: `→` for
   outgoing, `←` for incoming, own column still first so the list stays aligned.
2. **The `N targets` marker counted incoming links.** A key that three tables
   point at is a primary key doing its job; warning "usually only one of them is
   real" was not noise, it was wrong. Only OUTGOING links can compete.
3. **`relationshipCount` double-counted self-references.** Both endpoints were
   incremented, so `GLClassifications` (which has a `Parent` pointer) advertised
   a total the list under it could never reach.

**Two numbers with different bases shown side by side:**

4. **The inspector never said containment is SAMPLED while orphan rows are the
   WHOLE table.** The draw-time popover has always said so; the panel people
   actually use did not, leaving "218 of 218 values" next to "0 rows with no
   match" with nothing explaining that they count different things.
5. **`matchedDistinct` was rebuilt as `round(containment × sampled)`.**
   Provably correct, but reconstructing a displayed count from a ratio is the
   exact shape of arithmetic that goes quietly wrong. `FkVerdict` now carries
   `matched` through.

**One number that silently meant two different things:**

6. **The table row badge showed pending when non-zero and the total otherwise.**
   A table reading `5` while holding 16 links told you nothing about which 5 it
   meant. The total is now always shown, with anything still waiting on a person
   in front of it.

Also: matches are excluded from a table's `holds / partly / no match` summary —
they are verified by match rate, not containment, so this check never runs on
them and counting them as "not checked" left a number nobody could clear. And
the toolbar now reports `N unusable` when links exist whose columns no longer
resolve, because `relationships` counts only what can be drawn while `flagged`
counts every row — two populations that were sitting next to each other unlabelled.

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

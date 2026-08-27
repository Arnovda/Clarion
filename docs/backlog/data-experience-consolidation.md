# Data Experience Consolidation — One Door Per Thing

> Written 2026-08-27. Owner, after walking the Reference/Item flow live: *"I
> think it's too complicated with too many different ways or panes to look at
> the data... I like the data catalog actually, but I understand that a
> 'manage data' tab is useful too... take a step back, figure out the ideal
> flow for a business user or analyst, analyze the current flow and suggest
> what we must do different to have a coherent data platform."* Method: a
> full code inventory of every product-layer data-inspection surface (all
> claims carry file:line) against the owner's screenshotted journey.
> Companion to `dashboard-experience-assessment.md` (the same discipline
> applied to dashboards) and to the 2026-08-18 IA decision this doc mostly
> *re-asserts* rather than replaces.

---

## 0. Verdict

The owner's instinct is precisely right, and the cause is diagnosable: **the
app has ~15 surfaces built from 6+ distinct components that all show the
same product-layer data**, because five months of sessions each added a
surface without retiring the previous one. The right IA rule was already
decided on 2026-08-18 — *the catalog is the one definition/inspection
surface across both layers; Manage mode is the one per-topic cockpit; the
workshop is structural surgery* — but it was never enforced, and later
additions broke it: Shared-data cards deep-link curators into the workshop,
the catalog's Structure mode renders the workshop component byte-identically,
and the Browse cards grew two more product panels of their own.

**The fix is mostly deletion and rerouting, not construction.** The target is
three surfaces with one page per thing, capabilities layered by role on that
one page — instead of parallel pages each holding a different subset.

---

## 1. The ideal flow (designed from the jobs, not the code)

Two personas, four jobs:

| Job | Who | Ideal experience |
|---|---|---|
| J1 **Discover** — "what data do we have?" | everyone | One home per audience: Subjects (business framing) and the Data Catalog (inventory framing). These already exist and are both good. |
| J2 **Understand & trust** — "what is this table, show me the rows, where does it come from, is it fresh?" | everyone | **One canonical page per product and per table.** Open "Item" → see the rows first, then columns with meanings, used-by, freshness, quality. Two clicks from anywhere, same page from everywhere. |
| J3 **Curate** — rename, describe, approve | analyst+ | The *same* page, with edit affordances that appear for curators. Curation is annotation of the thing you're looking at, not a trip to a different cockpit. |
| J4 **Operate** — SQL, deploy, rebuild, refine | admin (+analyst) | One expert surface, reached only through an explicit "open the workshop" action — never as the landing of a click on content. |

The single principle underneath: **one URL per thing; role changes what the
page can do, never which page you land on.** Progressive disclosure on one
page beats parallel surfaces every time — parallel surfaces are why the
owner's Item journey took two apps' worth of navigation and still needed a
manual detour.

**The owner's Item journey in the target world:** dashboard filter "?" →
*"values come from Item — view the table"* → the Item page in the catalog,
rows on top → done. Or: Subjects → Shared data → Item → same page. Two
clicks either way, same destination both ways.

---

## 2. What exists today (measured)

The full inventory lives in the investigation (15 surfaces catalogued); the
shape of the problem in numbers:

- **The product "overview" exists 4×** (workshop `OverviewSection`, the same
  component re-rendered inside catalog Structure, `ProductPreviewPanel`,
  `ProductFullView` — plus the topic layer as a deliberate 5th with opposite
  vocabulary). Three of them compute "Dimensions" three different ways
  (dimension *tables* vs dimension-role *columns* vs dropped entirely).
- **The "tables of this product" list exists 5×** (workshop Tables tab,
  workshop chips+notebook, ManageTables, ProductFullView Tables,
  ProductPreviewPanel), with **4 different column renderings**, none shared.
- **One reference table has 2 different detail panels** depending on the
  door: clicked in the Structure tree → `ProductTableDetailPanel` (role-aware,
  editable columns, SQL viewer, lineage graph); clicked as a Browse card →
  `ReferenceDetailPanel` (read-only, no SQL, no role logic). Same
  `product_tables` row, two different truths.
- **Quality renders through 5 call sites** (incl. two components literally
  both named `QualityTab`); **lineage renders 3 ways** (graph, list,
  StarSchemaFlow).
- **`Grid | List | Structure` conflates two things**: Grid/List are card
  layouts; Structure swaps the entire page body for the legacy tree + the
  *workshop's own component*.
- **The workshop is the landing page of a content click**: a curator clicking
  a Shared-data card lands on `/products/<id>` — "Operator surface", Deploy
  all / Refine / Delete, SQL-first table view — when their job was *seeing
  their items* (`shared-data/page.tsx:116-125`). A viewer clicking the same
  card gets nothing at all: the card is a `<div>`.

### The owner's actual journey, step by step (as screenshotted)

Subjects → Shared data (nice) → click Item → **the build workshop**, whose
table view leads with `SELECT ROW_NUMBER() OVER (...)` and a Deploy button →
back out → Data Catalog → Structure → Reference → Item → (until yesterday's
fix) "Table not found". Five surfaces, two vocabularies, one dead end, zero
rows of actual item data seen.

### Defects found during the inventory (independent of any redesign)

| # | Defect | Evidence |
|---|---|---|
| D1 | Shared-data → workshop deep link breaks for any table with a `display_name`: the card passes the display name, the workshop matches on `table_name` — lands on Overview with no table selected. | `shared-data/page.tsx:120` vs `ProductRootPanel.tsx:188` |
| D2 | Viewer Shared-data cards are inert `<div>`s — a viewer-readable page whose every card is a dead end. | `shared-data/page.tsx:116` |
| D3 | `?refTableId=` is written to the URL but never read back — sharing/refreshing a reference-table view opens an empty catalog. | `catalog/page.tsx:268` vs `:203-211` |
| D4 | Sample rows 403 on the consumer panels: `/semantic/product-preview` is `requireRole('admin')`, but `ProductFullView` (sold as "consumer-facing on every tab") and `ReferenceDetailPanel`'s Sample tab render it for everyone — analysts get an error string where rows were promised. | `semantic.ts:1945`, `ProductFullView.tsx:448`, `ReferenceDetailPanel.tsx:478` |
| D5 | The workshop Overview "Tip" says "Use the chat on the right" — `embedAskAI` is `false` at every call site; there is never a chat on the right. Shown unconditionally, including inside the catalog. | `ProductRootPanel.tsx:811-816` |
| D6 | `ProductFullView`'s "Edit in notebook →" is not role-gated — viewers are shown a link into an admin/analyst route. | `ProductFullView.tsx:451` |
| D7 | Vocabulary leaks on viewer-reachable surfaces: raw `table_name` fallback on Shared-data/Reference cards, `"N sources · N analytics · N dimensions"` in the catalog hero, raw `surrogate_key`/`foreign_key` chips and join predicates on ReferenceDetailPanel, stat cards literally labelled **Facts**/**Dimensions** wherever `OverviewSection` renders. | catalog.ts:519, catalog/page.tsx:865, ReferenceDetailPanel.tsx:363,446 |
| D8 | Nothing links INTO the understanding surfaces from where doubt is born: dashboards' provenance chips are plain text, a successful Ask-AI answer links nowhere, Build's finish card links only to `/query`, Home links to neither `/catalog` nor `/subjects`. This is exactly why the owner "had to manually navigate to Items". | `WidgetProvenance.tsx:176-190`, `MessageBubble.tsx:1098`, `build/page.tsx:721-729` |
| D9 | Reference products render an orphaned topic page if you type the URL (no `kind` filter on `/products/:id/topic`), but nothing links to it. | `topic.ts:58-84` |
| D10 | Stale claims: `/products/[id]` header advertises "all 6 tabs" (there are two); `ReferenceDetailPanel`'s header promises editing affordances it doesn't have. | `products/[id]/page.tsx:6`, `ReferenceDetailPanel.tsx:20-22` |

---

## 3. The target model — three surfaces, one page per thing

### Surface 1 — **Subjects** (business home) · keep as-is
`/subjects` + the topic layer are clean, vocabulary-correct, and do exactly
one job (activation: "what can I ask?"). Do not merge them into the catalog —
"what can I ask about" and "what data exists" are different questions with
different audiences. The Shared-data *page* also stays: it is the
business-language index of the lookups. Only its click-through changes (below).

### Surface 2 — **Data Catalog** (the one understanding surface) · consolidate into
The owner likes it; the 2026-08-18 decision already names it the one
definition/inspection surface across both layers. Make that true:

- **One product page.** Merge `ProductPreviewPanel` + `ProductFullView` +
  `ProductRootPanel`-in-catalog into a single product page: preview inset on
  card click, expanding in place to the full view. Role-layered: curators
  additionally get inline description/KPI editing and one explicit
  **"Open the build workshop ↗"** button. The workshop's `OverviewSection`
  stops rendering inside the catalog entirely.
- **One table page.** Merge `ReferenceDetailPanel` + `ProductTableDetailPanel`
  into a single table panel used by every door (Browse card, Structure tree,
  deep link). Composition, in order: **Sample rows first** (a business user
  clicking "Item" wants rows, not metadata), then Columns (descriptions
  editable inline for curators), Used-in, Quality, Lineage; SQL stays a
  curator-only collapsed appendix (the ManageTables pattern, already proven).
  Reference tables are a *flavor* of this page (grain/identifier framing),
  not a different component.
- **Sample rows must actually load.** `/semantic/product-preview` is
  admin-only today, which contradicts both consumer panels *and* the fact
  that Ask AI already returns the same rows to every role. Recommendation:
  widen to all roles for product-layer tables (decision queued, §6).
- **Structure becomes a toggle, not a world.** Keep the tree for analysts,
  but as a left-sidebar toggle inside Browse that drives the SAME detail
  panels as the cards. `Grid | List` stays a pure layout choice. The
  `All | Sources | Products` chips move to the tree header where they apply.
- **Trust and Glossary facets stay** — they are consolidation done right
  (they already absorbed `/health` and `/glossary`).
- **One vocabulary.** One shared humanize helper and the existing softened
  `RoleBadge` (Measures/Lookup) everywhere in the catalog; the words *fact*,
  *dimension*, raw `dim_*` fallbacks, and join predicates retreat to the
  workshop. One definition of every stat.

### Surface 3 — **the Workshop** (structural surgery) · reached only on purpose
`/products/[id]` keeps what only it has: table chips + notebook (SQL cells,
Run, Deploy), Deploy all / Refresh / Rebuild / Refine chat, add-table. It
loses its Overview and read-only Tables tabs (the catalog product page is
the overview now) and is reached ONLY via explicit workshop links from
curator contexts — never as the landing of a click on data.

### Rerouting table (the substance of the change)

| Click today | Lands today | Lands in target |
|---|---|---|
| Shared-data card (curator) | **workshop** `/products/<id>?table=<display name>` (broken for display-named tables) | catalog table page, reference flavor |
| Shared-data card (viewer) | nothing | same catalog table page (read-only by role) |
| Structure tree → product | workshop component in a pane | the one product page |
| Structure tree → table | `ProductTableDetailPanel` | the one table page |
| Browse reference card | `ReferenceDetailPanel` | the one table page |
| Dashboard filter "?" | (popover only, since 2026-08-27) | popover + **"View the table →"** link to the catalog table page |
| Ask AI successful answer | no links | "Answered from **Sales** · tables used" → catalog links (curator), topic link (all) |
| Build finish card | `/query` only | + "See your subjects →" `/subjects` |

### What happens to Manage mode (`?manage=1`)

Deliberately **phase 3, not now**. Manage mode and the workshop overlap
heavily (both carry SQL editing + deploy; ManageTables' four sub-tabs
overlap the new table page), and collapsing them is the one genuinely
structural decision here. Recommendation when it comes: Manage mode wins as
the single curator cockpit (topic-scoped, business-framed, already has the
better SQL pattern — collapsed appendix, honest preview) and absorbs the
notebook; `/products` then retires to the bus-matrix/coverage tooling only.
But do not attempt this in the same motion as the read-path consolidation —
the read-path work is deletion with low risk; the cockpit merge moves the
deploy surface and deserves its own slice.

---

## 4. Why this stays coherent (the test)

After consolidation, every question has exactly one answer:

- *"What can I ask?"* → Subjects / topic page.
- *"What is this data? Can I trust it? Show me."* → the Data Catalog's one
  product page / one table page — same page for every role, from every door,
  rows first.
- *"Fix the definition"* → the same page, inline (curator).
- *"Change the structure"* → the workshop, entered knowingly.

And the count of components rendering product-layer data drops from ~15
surfaces / 6 components to **3 surfaces / 3 pages** (product page, table
page, workshop) plus the deliberately-minimal topic layer.

---

## 5. Sequencing

**Release A — "Every door leads somewhere true" (routing + defects, no
redesign).** D1–D10: reroute Shared-data clicks (both roles) to the catalog
table view; read `?refTableId` back; widen the preview endpoint (per §6
decision); delete the stale Tip; gate the notebook link; add the missing
inbound links (filter "?" → table page, provenance chips → links, Build
finish → Subjects, Ask-AI answer → topic/catalog). Small, independent,
high-relief — the owner's exact journey becomes 2 clicks with rows at the
end.

**Release B — "One page per thing" (component merges).** The product-page
merge, the table-page merge, Structure-as-toggle, the vocabulary sweep, one
Quality component. Net-negative diff; the risk is regression in curator
editing, so it rides on the existing panel tests plus new ones for the
merged panels.

**Release C — "One cockpit" (owner decision first).** Manage mode ↔
workshop unification per §3.

---

## 6. Owner decisions queued

1. **Sample-row visibility** — recommendation: all roles for product-layer
   tables (Ask AI already serves viewers the same rows; the role table's
   "never show raw SQL" rule is about SQL, not data). Minimum: analyst+.
2. **Manage ↔ workshop merge direction** (Release C) — recommendation above.
3. **Does Structure survive at all?** Recommendation: yes, as an
   analyst-only tree toggle with shared panels — it's the fastest column-level
   navigation for curators — but if usage stays low after Release B, delete it.

## 7. What NOT to do

- Don't merge Subjects into the Catalog — activation and inspection are
  different jobs for different audiences; the split is earning its keep.
- Don't delete the workshop's capabilities — surgery needs a room; it just
  can't be the room the elevator opens into.
- Don't put SQL or warehouse vocabulary on any all-roles surface to "save a
  click" — the vocabulary rule is load-bearing for the product's audience.
- Don't rename anything again (Subjects/Catalog/Shared data are settled
  vocabulary); this plan moves plumbing, not names.
- Don't build new navigation — the rail is right; the problem is where the
  existing doors lead.

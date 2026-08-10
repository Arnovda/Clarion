# Why an SMB pays for a warehouse — and how Clarion delivers it

> Status: **proposal**. No code changed. Written 2026-08-10.
> Grounded in a read of the current code, not in what the docs claim.
> Read §2 before disagreeing with §4–§6 — several assumptions people carry about
> what Clarion can already do turn out to be false, and two turn out to be
> pleasantly true.

---

## 1. The question

Fabric + Power BI is the right comparison: same buyer, same price ceiling, same
"we already pay Microsoft" gravity. Clarion cannot win on warehouse engineering —
Fabric's is better funded and always will be. So the question is not *what does a
warehouse do*, it is **what does an SMB actually pay a warehouse to do that their
SaaS tools refuse to do**.

Three answers, all of which the buyer can state in one sentence without using a
technical word:

1. **Cross-system questions** — "which customers buy from the webshop but never
   pay on time in the accounting package?" No single tool owns both halves.
2. **Spreadsheets as a real source** — "compare this against my budget." The
   budget lives in Excel, it always has, and it is not going to move.
3. **Multi-entity consolidation** — "show me the group, not three companies."

In Power BI all three are Power Query / dataflow work: a consultant writes merge
steps, fuzzy-match joins and a mapping table hidden inside an M query. It works
until someone renames a column, and then it fails silently and the SMB does not
find out for a month.

**That is the wedge.** Not "we also have a warehouse". The claim is: *the
decisions that make these three work — which customer is the same customer, which
GL account rolls into which reporting line, which companies are the group — are
made by a business user in business language, are stored as first-class data, and
survive a refresh.* In Power BI those decisions are code. In Clarion they should
be content.

---

## 2. What Clarion has today (measured)

### 2.1 Everything is scoped to a connection

The unit of work is `connection_id`, end to end:

| Stage | Where | Scope |
|---|---|---|
| Design | `busMatrixOrchestrator.ts:83–94` | one `connectionId`; loads `source_tables` for it |
| Build | `transformationRunner.ts:426` | source views from `ingested_tables where connection_id = product.connection_id` |
| Query | `ConnectorFactory.ts:165–167` → `tableCatalog.listProductTablesByConnection` | `where dp.connection_id = connectionId` |
| Ask AI | `routes/query.ts:247` | request body carries `connectionId` |

So a question that spans two connections **cannot currently be expressed at the
product layer.** This is the single biggest structural blocker, and it is a
blocker for themes 1 *and* 3.

### 2.2 …but the cross-connection seam already exists, and works

Two things are better than expected:

- `transformationRunner.loadDependencyDimensions` (line 203) resolves upstream
  dimensions **by `dependent_product_id` alone — it never filters by
  connection.** A product on connection B can already consume a conformed
  dimension built on connection A.
- `tableCatalog.publishStubFromUpstream` (line 355) writes the upstream
  `delta_path` into a stub row *belonging to the dependent product*. Because
  `listProductTablesByConnection` does not exclude stubs, that shared dimension
  becomes visible in the dependent connection's DuckDB session at query time.

**Cross-connection joins are therefore already plumbed.** What is missing is not
pipes. It is (a) a design flow that ever proposes such a product, (b) matching
keys that agree across systems, and (c) a query scope that spans connections.

### 2.3 The "cross-source" path in `query.ts` is SQLite-only legacy

`routes/query.ts:640–780` builds a cross-source context from
`cross_view_relationships`, and at line 706 it reads `cfg.filepath` and calls
`path.resolve` on it, then executes via `ATTACH DATABASE`
(`nlToSqlPrompt.ts:384–409`). Exact Online and Odoo connections have no
`filepath`. **This path cannot work for any API connector and must not be built
on.** It is dead weight that looks like a feature.

### 2.4 Spreadsheets: nothing

`grep` for csv/xlsx/excel/upload across `packages/connectors/src` and
`backend/src/routes` returns **only export paths** (`utils/xlsxBuilder.ts` writes
XLSX; it does not read it) and the semantic-dictionary CSV import. There is no
file connector, no upload route, no reader. The 2026-07-15 product assessment
listed "Excel/CSV upload connector" as a missing business feature; it is still
missing.

### 2.5 Multi-entity: one division per connection, no consolidation

- Exact Online: `exactonline/schema.ts:9` — *"single division per connection"*,
  `division` is a required scalar string. Three divisions = three connections =
  three bus matrices = three unrelated sets of products.
- Odoo: multi-company exists *inside* the instance — `dim_company` is in the
  star-schema template (`odoo/starSchemaTemplate.ts:190`) and `company_id` is
  carried on partners and journals. Nothing consolidates across it; it is just a
  dimension.
- No FX rate handling anywhere. No intercompany logic. `grep` for
  `exchange_rate|fx_rate|consolidat` finds only storage-layer consolidation and
  an unrelated Exact Online field.

### 2.6 The one lucky break: VAT number is already conformed

Both star-schema templates already surface the tax ID **under the same column
name**:

- `exactonline/starSchemaTemplate.ts:94` — `dim_account.vat_number` ← `Accounts.VATNumber`
- `odoo/starSchemaTemplate.ts:97` — `dim_partner.vat_number` ← `res_partner.vat`

For a Belgian SMB the VAT number is a near-perfect deterministic join key for
companies. **Cross-system customer matching starts at high accuracy with a
normaliser and zero AI**, which matters a great deal for §4.

---

## 3. The insight: all three features need the same primitive

Look at what each theme's hard part actually is:

| Theme | The hard part | Shape |
|---|---|---|
| Cross-system | Is Exact's *Van Damme BVBA* the same as the webshop's *vandamme@…*? | key ↔ key |
| Spreadsheets | Which GL account rolls into which management P&L line? | key ↔ key |
| Multi-entity | Entity A's chart of accounts ↔ the group's chart of accounts | key ↔ key |
| Multi-entity | Is this counterparty one of our own companies? (intercompany) | key ↔ key |

Every one is a **two-column correspondence, proposed by the machine, decided by a
business user, stored, versioned, and joined at build time.** Build that once and
the hard part of all three features is solved. Build it three times inside three
features and Clarion acquires three subtly different half-versions of it.

Call it a **Mapping**. It is the product's most important new noun, and it is the
thing Power BI makes a consultant write in M.

### 3.1 Mapping — proposed shape

Two tables, mirroring the existing semantic-layer idiom:

```
mappings       id, tenant_id, name, kind, left_ref, right_ref, status, …
mapping_rows   mapping_id, left_key, left_label, right_key, right_label,
               confidence, source, approval_status, decided_by, decided_at
```

- `kind` — `entity_match` (customer ↔ customer) or `value_map` (GL account →
  reporting line). Same table; the review UI differs only in wording.
- `source` — `deterministic` | `ai` | `human` | `file`. A row uploaded as a
  spreadsheet is a mapping with `source='file'` and no review needed.
- Materialised as a product table via `tableCatalog.publishProductTable`, so it
  becomes an ordinary DuckDB view and every downstream surface — Ask AI,
  dashboards, notebooks — gets it for free. **No new query machinery.**
- Reviewed through the existing `approval_status` idiom, but the copy is business
  language: *"Is `Van Damme BVBA` (Exact) the same customer as `Van Damme B.V.B.A.`
  (webshop)?"* → Yes / No / Not sure. Never "entity resolution", never "fuzzy
  match threshold".

### 3.2 Human decisions must survive a rebuild — and this is the third time

Migration 70 already solved exactly this problem for semantic descriptions:
`edited_by_user` / `confirmed_by_user`, snapshotted before the profiler wipe and
merged back after. A mapping has the identical failure mode — a re-sync
re-derives candidates and silently discards a human's "no, those are different
companies". **Reuse that mechanism rather than inventing a second one**; if it is
needed a third time it should become a shared facility, not a third copy.

### 3.3 Measure before you infer — the FK lesson applies verbatim

On 2026-08-03 relationship detection was found to be *inventing* foreign keys —
value-overlap agreement mistaken for evidence, measured only once it hit
production data. Entity matching is the same class of problem with a worse
failure mode: a wrong match silently merges two customers' revenue.

So the order is non-negotiable:

1. Ship **deterministic** matching only (normalised VAT, then email, then IBAN,
   then exact normalised name).
2. **Measure the residual** — how many customers remain unmatched, on real tenant
   data, via a read-only audit control in the `.ops/` idiom (see
   `.ops/relationship-audit`).
3. Only then decide whether AI-proposed fuzzy matching earns its false positives.

Do not skip to step 3 because it demos better.

---

## 4. Theme 1 — Cross-system questions

### 4.1 The unwelcome part first

Clarion has **two connectors, and they are both ERPs.** Almost no SMB runs Exact
Online *and* Odoo. Building sophisticated cross-system machinery now would be
building a bridge between two islands nobody stands on simultaneously.

Cross-system value is gated on **connector breadth**, not on join machinery. The
realistic second systems for a Belgian SMB, roughly in order of how often they
create a question accounting alone cannot answer:

1. **Spreadsheet** (budget, targets, mapping tables) — see §5. This is the
   cheapest second system by an order of magnitude and it is already the source
   of the single most-asked SMB question, *budget vs actual*.
2. Webshop — Shopify / WooCommerce.
3. CRM — Teamleader, HubSpot, Pipedrive.
4. Payroll — SD Worx, Securex, Partena.
5. Banking — CODA / PSD2.

**Recommendation: theme 1's first shipped instance should be theme 2.**
Budget-vs-actual is a cross-system question. It proves the primitive, it needs no
new API connector, and it is demoable to every prospect.

### 4.2 What to build (in order)

**(a) Un-scope the query layer from `connectionId`.** Prerequisite for themes 1
and 3, and the largest single piece of work in this document.

- `ConnectorFactory.createProductConnector` gains a tenant/topic-scoped sibling
  of `listProductTablesByConnection`.
- Name collisions are already handled: `tableSchemas` maps table → product name
  and registers views schema-qualified (`ConnectorFactory.ts:169–177`). When the
  scope spans connections, schema-qualification must become **mandatory** rather
  than best-effort, or two `dim_account`s will collide.
- `routes/query.ts` takes a topic/scope rather than a `connectionId`. Note this
  is already where the product is heading: the front door became
  `/topics/[productId]` on 2026-08-06, but the *question* path is still a
  connection. **The front door and the question path disagree today**, and this
  work resolves that — it is not a new direction.

**(b) Conformed customer via the Mapping.** A `dim_customer` built as a UNION of
per-system customer dimensions plus the mapping, assigning one stable
`customer_key`. Facts resolve through it. Mechanically this is an ordinary
transformation over an ordinary product dependency — §2.2 says the plumbing
already exists.

**(c) Retire, do not extend, the ATTACH path.** `routes/query.ts:640–780` and the
cross-source prompt in `nlToSqlPrompt.ts:384`. Leaving it in place is acceptable;
building on it is not.

### 4.3 Where the user meets it

Inside a **topic**, not on a new page. "Customers" is a topic that happens to
draw on Exact and the webshop; the topic layer keeps its promise of no SQL, no
counts, no warehouse vocabulary. The only new business-language surface is the
mapping review, which belongs in Manage mode alongside the existing review queue.

---

## 5. Theme 2 — Spreadsheets as a first-class source

**This is the highest value-to-effort item in the document and it should be built
first.** It has no dependencies, it is immediately demoable, and it is the
vehicle that themes 1 and 3 need for user-supplied mapping tables.

### 5.1 The key decision: it is a connector, not a special case

Implement `packages/connectors/src/file/` as an ordinary `SourceConnector`. Then
profiling, the docs channel, the bus matrix, star-schema templates, quality,
lineage, scheduling and the whole review queue work **unchanged**. Any design
that makes uploads a parallel path re-implements six subsystems.

- `listEntities` → the sheets/tables found in the file.
- `sync` → read the file, write Parquet through the existing `ParquetWriter` /
  `BlobSasWarehouseWriter` with an **explicit `columns` schema** (the typed-write
  path added for Exact Online on 2026-07-22 — an uploaded sheet is precisely the
  case where types must not be guessed per-sync).
- `describeEntities` → returns the user's own column labels with
  `provenance: 'curated'`. Per the profiler's trusted rung those land
  `approval_status='approved'` and **skip the review queue entirely**. An
  uploaded sheet arrives fully documented, because the person who uploaded it
  just told us what the columns mean. This is strictly better than what any API
  connector can offer.

### 5.2 The real work is the messy file, and it is where AI earns its cost

Users do not upload tidy tables. They upload a title row, a blank row, merged
cells, three sub-tables on one sheet, a totals row at the bottom, and twelve
month columns across the top. Handling this is the difference between "first-class
source" and "CSV import".

An AI **shape pass** at upload proposes, and the user confirms in a preview grid:

- where the header row is and where the data range ends;
- which rows are totals/subtotals to exclude (a totals row silently double-counts
  everything — this is the highest-severity failure mode of the whole feature);
- whether the layout is wide/pivoted and should be unpivoted to long form
  (`Jan|Feb|Mar…` → `month | amount`) — the single most common shape for a budget
  file, and the one users cannot fix themselves;
- column types, and the business key.

Output is a plain-language summary plus at most two or three questions. Same
philosophy as the profiling ladder: propose confidently, ask rarely, never show a
setting.

### 5.3 Refresh — the thing that separates a source from an import

Three modes, in priority order:

1. **Re-upload** — same connection, new file, merged on the business key. The
   existing incremental merge path handles it. Schema drift is already supported
   (`schema_mode='merge'`); a new column should surface as a plain-language
   prompt, *"Your file has a new column* Region*. Add it?"*, not a silent widen.
2. **Linked file — OneDrive / SharePoint.** The SMB being courted here is already
   a Microsoft shop; the budget lives in SharePoint and is edited weekly.
   A linked file that refreshes on a schedule is what makes this a *source*.
   This is also directly competitive: it is the same file Power BI would connect
   to, without the Power Query.
3. Google Sheets — same mechanism, lower priority for this market.

### 5.4 Do not loosen the SQL guard

`sqlGuard.assertNoExternalAccess` deliberately refuses `read_csv` / `read_xlsx` /
path literals in user and AI SQL — that is the control closing the cross-tenant
blob-read vector. **The file connector reads the file in the sync path (connector
→ writer), never through the guarded query path.** Anyone who "fixes" spreadsheet
support by relaxing the guard reopens the vector this platform spent a security
sprint closing. Raw uploads get their own tenant-scoped prefix under the existing
per-tenant container discipline (`warehouseContainer(tenantId)`).

### 5.5 What SMBs will actually upload

In descending order of value:

- **Budget / forecast** — makes every existing dashboard twice as useful overnight.
- **GL account → management P&L line mapping.** Every SMB accountant already
  maintains this in Excel. Supporting it natively is a sleeper wedge: it is the
  bridge between the statutory books and the way the owner thinks about the
  business, and in Power BI it is a merge query nobody maintains.
- Sales targets per rep/region; cost prices; commission rates; headcount plan.

Note the second item is a **Mapping with `source='file'`** — theme 2 delivers
theme 3's chart-of-accounts alignment as a side effect.

---

## 6. Theme 3 — Multi-entity consolidation

### 6.1 Two shapes, and conflating them is the classic mistake

**(a) Several entities, same system** — three Exact Online divisions, or one Odoo
with three companies. The Belgian pattern: operating company + holding + a
property company. Schemas are identical.

**(b) Several entities, different systems** — an acquisition still on its own ERP.

(a) is common and cheap. (b) is rarer and is just theme 1 with extra steps. Build
(a); let (b) fall out of the theme 1 work.

### 6.2 Design for (a): the group is a first-class object, the entity is a dimension

Keep **one connection per division.** It isolates OAuth, rate limits and sync
failures, and Exact Online's config schema is explicitly built that way
(`exactonline/schema.ts:9`). Do not make `division` an array — that trades a
clean failure boundary for a saved row.

Add a tenant-level **Group**: an ordered list of member connections, each with its
legal-entity metadata (display name, VAT number, currency, ownership %).

Then build group products as **ordinary dependent products**:

- each entity keeps its per-entity products exactly as today;
- a group product declares `data_product_dependencies` on the member products and
  `UNION ALL`s their facts, stamping `entity_id`;
- `dim_entity` comes from the Group definition.

The only code change of substance: `loadDependencyDimensions`
(`transformationRunner.ts:203`) filters upstream tables to
`tableRole === 'dimension'` (line 224). Group products need upstream **facts**
too. That is a small, well-scoped change to an existing function — not new
infrastructure. This is the cheapest correct path by a wide margin, and it is
available precisely because §2.2 is true.

### 6.3 Chart-of-accounts alignment is the actual content

Entities rarely share an identical chart of accounts, and when they do somebody
has already diverged one account code. The mapping from each entity's GL account
to a group reporting line is a **Mapping** — proposed deterministically where
codes match, AI-proposed where they nearly match, reviewed by the accountant in
business language, and materialised as a joinable table. Or simply uploaded as a
spreadsheet (§5.5), which is how it exists today in every one of these businesses.

### 6.4 Intercompany — take the 80%, name the boundary

Real statutory consolidation means eliminations, investment-in-subsidiary,
minority interests, and an audit trail an auditor will accept. **Do not build
that.** It is an accounting-grade rabbit hole and it is not what the buyer is
asking for.

What they are asking for is *management* consolidation: group revenue, group
margin, group cash, without the inflation caused by companies invoicing each
other. That is reachable cheaply:

- match each transaction's counterparty VAT number against the member entities'
  own VAT numbers — this falls straight out of the Group definition and the
  normaliser already needed in §3.3;
- flag those rows as intercompany;
- offer one toggle on the topic: **"Exclude internal invoices between our own
  companies."**

That is 80% of the value at roughly 10% of the cost, and it is honest about what
it is. The marketing word "consolidation" must not be allowed to smuggle in the
statutory meaning — if a customer needs auditor-grade consolidation, Clarion
should say no clearly.

### 6.5 Currency: out of scope for v1, deliberately

Multi-currency consolidation needs a rate table (monthly average for P&L, closing
for balance sheet) and a decision per measure about which to apply. Exact Online
already gives division-currency amounts (`*DC`), which covers a single-currency
group completely. Belgian SMB groups are overwhelmingly EUR-only. **Defer until a
real multi-currency customer exists**, then implement the rate table as a
spreadsheet source (§5) rather than a feed.

### 6.6 Where the user meets it

The topic page gains one control: **"Company: All / BVBA X / Holding Y"**. That is
business language and fits the topic layer's constraints as they stand. Everything
else — group definition, CoA mapping, intercompany rules — lives in Manage mode.

---

## 7. Sequencing

| # | Work | Why here | Rough size |
|---|---|---|---|
| 0 | **Spreadsheet connector** (§5.1–5.4), upload + re-upload only | No dependencies. Highest value/effort. Demoable. Produces the vehicle for every mapping table. | L |
| 1 | **Mapping primitive** (§3), deterministic matching only, `source='file'` and `source='deterministic'` | Solves the hard part of all three themes once. | M–L |
| 2 | **Groups + group products** (§6.2), single currency, no intercompany | Reuses the dependency mechanism; smallest change per unit of customer value. | M |
| 3 | **Un-scope the query layer** from `connectionId` (§4.2a) | Unblocks true cross-system questions; also resolves the topic/connection disagreement. | L |
| 4 | **Intercompany flag + exclude toggle** (§6.4) | Falls out of 1 + 2 almost for free. | S |
| 5 | **Linked files** — SharePoint/OneDrive (§5.3) | Turns the upload into a source; directly competitive with Power BI's most common connection. | M |
| 6 | **Conformed customer across systems** (§4.2b) | Only worth it once a real second non-ERP connector exists. | M |
| 7 | Measure match residual, then decide on AI fuzzy matching (§3.3) | Evidence before inference. | S then ? |

Items 0–2 are a coherent release with a one-sentence pitch: *"Upload your budget
and your account mapping, group your companies, and ask questions across all of
it."* That sentence sells against Fabric. "We have a lakehouse" does not.

---

## 8. What NOT to do

- **Do not extend the SQLite `ATTACH` cross-source path** (`routes/query.ts:640–780`,
  `nlToSqlPrompt.ts:384`). It reads `config.filepath`; no API connector has one.
- **Do not build statutory consolidation** (eliminations, minority interests).
  Say no to it explicitly and early.
- **Do not build FX** before a multi-currency customer exists.
- **Do not make cross-system or consolidation a new top-level surface.** Both
  belong inside topics. The 2026-08-06 topic-first work is the right IA; adding
  a "Consolidation" nav item would undo it.
- **Do not relax `sqlGuard` for spreadsheets** (§5.4).
- **Do not ship AI fuzzy entity matching before measuring the deterministic
  residual** (§3.3). The FK-detection incident is the precedent and it cost a
  production measurement to discover.
- **Do not implement uploads as a bespoke path outside the connector framework**
  (§5.1). It would re-implement profiling, docs, quality, scheduling and lineage.

---

## 9. Decisions needed from the owner

1. **Sequencing** — is the spreadsheet-first ordering in §7 accepted, given it
   defers the marquee "cross-system" story behind a file-upload feature?
2. **Connector breadth** — which second non-ERP system is real for the target
   customer (webshop / CRM / payroll / banking)? §4.1 argues cross-system value
   is gated on this, and the answer changes what item 6 is worth.
3. **Consolidation scope** — confirm that *management* consolidation (§6.4) is
   the product, and that statutory consolidation is a documented "no".
4. **Linked files** — is SharePoint/OneDrive support in the first release or the
   second? It is the difference between "import" and "source" in the buyer's mind.
5. **Mapping as a named product concept** — does "Mapping" get a user-visible
   name and a place in Manage mode, or does it stay an implementation detail
   behind per-feature review screens? §3 argues strongly for the former.

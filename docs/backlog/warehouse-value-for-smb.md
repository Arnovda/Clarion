# Why an SMB pays for a warehouse — and what Clarion should become

> Status: **proposal**. No code changed. Written 2026-08-10, reframed the same day.
> **§5.8 IS THE PLAN OF RECORD** — ten fixed dimension names, never versioned,
> never promoted; AI does everything else; anything off the list is the tenant's
> own and may diverge freely. §5.7 is the reasoning that produced it, minus the
> governance machinery §5.8 removes.
>
> Earlier framing, kept for the reasoning trail: **§5.7** — derive the dimensions from the source, but
> standardise their NAMES plus a thin attribute contract, and promote
> human-confirmed AI mappings from tenant-local to shipped. It supersedes §2.1
> (canonical model) and §5.6 (measured conformed set); both are kept because their
> reasoning is what produced §5.7.
> §1–§6 describe the target state and are the substance of this document.
> §5 answers the main architectural alternative. §8 records where today's code
> stands relative to all of it — a starting position, not a constraint.

---

## 1. The reframe: three themes, one problem

Cross-system questions, spreadsheets, and multi-entity consolidation look like
three features. They are three faces of a single fact:

> **An SMB's business does not live in one system, and it never will.**

Accounting in one place, sales in another, payroll in a third, a webshop in a
fourth, and Excel filling every remaining gap. This is not a transitional state to
be cleaned up. It is the permanent condition of every business under 250 people,
and it gets *more* true as SaaS gets cheaper.

Every SaaS tool reports on its own slice and is structurally incapable of doing
more. So the job an SMB is paying a warehouse to do is:

> **Be the one place where the whole business is reconciled into a single, true
> picture — and stay true as systems come and go.**

That is the product. The warehouse is plumbing in service of it.

Fabric sells the plumbing. Power BI can technically do all three themes — as
Power Query merge steps, fuzzy-match joins and mapping tables buried inside an M
query that one consultant wrote and nobody maintains. It works until a column is
renamed, and then it is quietly wrong for a month. **The gap Clarion should attack
is not capability. It is that in the Microsoft stack the reconciliation decisions
are code, and in Clarion they should be content** — made by a business person in
business language, stored as data, versioned, and surviving every refresh and
every source change.

---

## 2. What Clarion should have

Six layers. Each one is a thing that does not exist today, and each one makes the
three themes fall out as consequences rather than features.

### 2.1 A canonical business model that exists before any source

**The single most important idea in this document, and it inverts how Clarion is
built today.**

Today the direction is bottom-up: connect a source → profile it → let AI design a
star schema from what it found → get products that are a *reflection of that
source*. Every tenant gets a bespoke model. Every new connector is a fresh design
problem.

It should be top-down. Clarion should ship an opinionated **canonical model of an
SMB** — roughly ten entities and forty measures:

```
Party (customer / supplier / employee — one concept, roles as attributes)
Product / Service
Entity (legal entity, branch)
Account (GL) + Reporting line
Transaction (invoice, order, payment, journal, movement)
Period / Calendar
Document
Project / Cost centre
```

Sources **map into** it. They do not define it.

Why this changes everything downstream:

- **Cross-system stops being a feature.** Two systems that both map into `Party`
  are joined by construction. There is no "cross-system join" to build, because
  there is no seam.
- **A new connector becomes a mapping job, not a design job.** Connector #7 does
  not need to know anything about connectors #1–6. Onboarding cost per connector
  drops by an order of magnitude, which is what turns connector breadth from a
  strategic bet into a routine activity.
- **AI's role narrows from designer to mapper of the remainder** — and narrow AI
  is reliable AI. The star-schema designer is the most expensive, slowest and
  least predictable call in the platform; mapping a known source into a known
  model is a fraction of the tokens and far easier to verify.
- **Metrics, dashboards and questions outlive the source system.** An SMB
  migrating from Exact Online to Odoo keeps every dashboard. Power BI cannot
  offer that, because a Power BI model is built against a specific source. This
  is both a retention property and a genuinely new sales argument: *your
  reporting survives your ERP*.
- **Multi-entity, consolidation and benchmarking become expressible at all** —
  each needs a shared vocabulary across tenants, which a per-tenant AI-designed
  schema can never provide.

**The known failure mode, and the escape.** Canonical models are where data
platforms go to die. They die by trying to be universal and complete — the MDM
projects of the 2000s. The escape is three rules:

1. **Small and opinionated.** Not "a model of all business". A model of an EU SMB
   doing commerce and accounting. Ten entities, not two hundred.
2. **Spine, not cage.** Anything a source has that doesn't map still lands as a
   source-specific table, queryable exactly as today. The canonical model adds a
   reconciled centre; it never removes reach.
3. **Versioned like code**, shipped with the product, extended by Clarion rather
   than by each tenant.

### 2.1a What the canonical model *is*, concretely

Not an abstraction. Three shipped artefacts, versioned like code, living in the
repo next to the connector registry — **not** per-tenant data.

**(a) The model.** ~12 entities, each with a stated meaning, grain and natural
identity; attributes with types and meaning; relationships between entities; and
measures with their definition and additivity rule.

```
Party            one concept; customer / supplier / employee are ROLES on it
Product          goods and services
Entity           legal entity / branch
Account          GL account  ·  Reporting line   the management P&L structure
Document         invoice, credit note, order, purchase   ·  Document line
Journal entry    ·  Payment
Period           ·  Project / Cost centre   ·  Stock movement   ·  Employee
```

Measures: net revenue, COGS, gross margin, receivables, payables, DSO, DPO, cash
position, order intake, inventory value — each with one definition, shipped.

**(b) A mapping per connector.** How Exact Online's `Accounts` where `IsSales`
becomes a Party in the Customer role; how `SalesInvoiceLines` joined to
`SalesInvoices` becomes Document + Document line at line grain; which column is
net revenue. Shipped, versioned, testable — the same shape as today's
`starSchemaTemplate.ts`, retargeted from a per-connector model to a shared one.

**(c) A generated star schema.** Facts and dimensions emitted deterministically
from (a) + (b). This is what DuckDB queries and what the AI reads.

What it is **not**: not a star schema itself, not a per-tenant artefact, and not
the only thing queryable — everything unmapped still syncs and still answers
questions.

### 2.1b How a user meets it — which is to say, almost never

The business user never sees a model. They see five things, all in their own
language:

1. **Connect → it already works.** Exact is connected, and because the mapping is
   shipped the topics appear with revenue, margin, DSO and top customers already
   correct. Three minutes, zero decisions. *The canonical model is the reason this
   is possible; the user never learns it exists.*

2. **One coverage screen — "what we understand about your business".** A plain
   checklist over a fixed model, not a design exercise:

   ```
   Customers      ✓  from Exact Online
   Suppliers      ✓  from Exact Online
   Products       ✓  from Exact Online
   Sales orders   —  not found · connect a webshop, or hide this
   Budget         —  not found · upload a spreadsheet
   Stock          —  doesn't apply to us
   ```

   This is where "which entities does this customer need?" is actually answered.
   The user's only action is to hide what doesn't apply. **Selection, not design.**

3. **A matching inbox when a second source arrives.** *"Your webshop has customers
   too. We matched 812 of 900 to customers you already have in Exact. 88 need your
   eye."* Reviewed as rows — *Is this the same company? Yes / No / Not sure* — not
   as a canvas. This is the mapping table, and it is per-row because identity is
   per-row (§5.1.2).

4. **Their own vocabulary.** The tenant renames canonical concepts — "clients"
   not "customers", "leveranciers" not "suppliers" — and it flows into every
   question, answer and dashboard. **This is where per-customer variation
   genuinely belongs: the vocabulary varies, the structure does not.**

5. **Extension, one question at a time.** *"Exact has a free field you fill with a
   region code. Treat it as an attribute of your customers?"*

The relationship drawer sits behind Manage mode for analysts, for the jobs in
§5.3. It is never on a normal user's path.

### 2.1c Required core vs optional attributes, and what may be customised

**Not every canonical field is mandatory.** If every attribute were required, a
source lacking one could not be mapped at all. Each entity has:

- a **required core** — what makes the entity meaningful and identifiable. For
  Party: a stable id, a name, at least one role.
- an **optional set** — VAT number, email, address, country, sector, payment terms.
  A source fills what it has; the rest is null, and the coverage screen says so:
  *"Customers ✓ — no VAT numbers found, so matching across systems will be
  weaker."*

That turns "this connector is unsupported" into "this connector covers 8 of 12
customer attributes", which is the difference between a brittle model and a usable
one.

**The coverage screen has three states, not two**, and the middle one is the
commercially interesting one:

| State | Meaning | What it does |
|---|---|---|
| **Filled** | a source maps into it | works |
| **Available, empty** | we could fill this if you connected or uploaded something | *"Budget — upload a spreadsheet"* — this is the growth loop, not just UI |
| **Not applicable** | the user hid it | gone from their world |

**Who does the mapping — a precedence ladder, the same shape the profiler already
uses for descriptions** (vendor docs > curated > AI):

1. **Shipped mapping** for a known connector. Hand-authored, tested, identical for
   every tenant. **No AI at run time.** Per-tenant AI mapping would produce subtly
   different results per tenant, which reintroduces exactly the divergence the
   canonical model exists to remove.
2. **AI** for the remainder — custom fields, unrecognised tables, and entirely
   unknown sources (custom SQL Server, homegrown apps) where no mapping can be
   shipped.
3. **Human confirmation**, asked for only where step 2 ran — never where the
   shipped mapping applies.

**What may be customised per tenant — and the one thing that may not.** Three
different things hide inside the word "customise":

| Kind | Example | Allowed? |
|---|---|---|
| **Vocabulary** | "we call them *clients*", "leveranciers" | **Yes** — encouraged; per-tenant labels over canonical concepts |
| **Mapping & local extension** | "our customer number is in `Code`, not `ID`"; "free field 3 is the region" | **Yes** — the *source* side of the arrow moves, and tenant-only attributes may be added |
| **Definition** | "for us, revenue includes shipping"; "our Customer is really a contract" | **No** |

> **The rule: customise the mapping and the vocabulary freely; never customise the
> definition.**

If a tenant genuinely needs a different meaning, there are two legitimate routes
and redefinition is neither of them: add it **centrally** as its own canonical
measure that everyone can use (*revenue including shipping*), or let them define a
**tenant-local metric alongside** the canonical one, clearly marked as theirs.
Allowing tenants to redefine net revenue kills shipped metrics and benchmarking on
the same day — and it kills them silently, because every dashboard keeps working.

### 2.2 An identity layer that is a real asset

Cross-system joining is really an identity question: *is this the same customer?*
It should be answered once, permanently, and centrally — not per join, per
dashboard, per query.

Clarion should own a **party registry**: a stable, tenant-owned identity for every
customer, supplier, product, employee and legal entity, with a crosswalk to every
system's own key.

The resolution ladder, strongest rung first:

1. **Externally verified identity** — VAT number validated against VIES, company
   number against the national register (KBO/BCE in Belgium, KVK in NL). The
   result is not "two strings that look alike"; it is *a real legal entity*.
2. **Strong internal keys** — email, IBAN, GTIN/EAN for products.
3. **Normalised name + address.**
4. **AI-proposed candidates** — only for the residual, only after the residual has
   been measured.
5. **Human decision** — beats everything above it, permanently, and survives every
   rebuild.

Two things follow that are bigger than the joining itself:

- **Enrichment comes free.** Once a customer is a verified legal entity you also
  have its sector (NACE code), size band, incorporation date, and corporate
  relationships. That powers segmentation, credit risk signals, and the
  benchmarking in §2.5 — none of which the SMB's own systems can produce.
- **It compounds.** The identity graph gets better every month the customer uses
  Clarion, and it is not portable to a competitor. This is a stronger moat than
  semantic descriptions, which is where the platform has been putting its
  differentiation effort.

This is also regional knowledge, which is precisely the kind of thing a global
platform like Fabric will not do for the Benelux.

### 2.3 Excel as a first-class, bidirectional citizen

Excel is not a legacy input to tolerate. **It is the SMB's actual analytics
interface**, and the accountant will not leave it. The platform should meet that
head-on in four ways, not one:

1. **Files in.** Budget, targets, price lists, opening balances, manual
   reclassifications, mapping tables. Uploaded *and* linked (SharePoint /
   OneDrive / Google Sheets) so they refresh on a schedule. A linked budget file
   is the difference between an import and a source.
2. **Managed grids in-product.** For data that is *born* manual and has no file —
   a budget, a target, a GL→reporting-line mapping — the answer is not "go make a
   spreadsheet". It is an editable, Excel-paste-friendly grid inside Clarion,
   writing to the same store as uploaded files. Files are for what already exists;
   grids are for what gets created.
3. **Round trip with identity.** Every export carries stable keys, so when the
   file comes back Clarion knows exactly what changed and what it refers to. This
   is the mechanism that makes "send it to the accountant, get it back" actually
   work rather than produce a second version of the truth.
4. **Excel as a client.** A live-refreshing workbook / add-in is realistically the
   highest-adoption "dashboard" an SMB accountant will ever use. Analyze-in-Excel
   is one of Power BI's most-used features for exactly this reason.

The strategic point: every competitor treats Excel as the thing they are replacing.
The SMB does not want it replaced. **Clarion should be the product that makes the
numbers in Excel trustworthy and refreshable**, rather than the product that asks
people to stop using it.

### 2.4 Entity as an axis of the model from day one

Not a consolidation feature — an axis. `Entity` sits on the canonical model
whether the customer has one company or twelve.

- A single-entity SMB has one member and never sees a control. Zero cost, zero
  complexity.
- Growing into a group is a settings change, not a re-modelling exercise.
- Intercompany elimination becomes a rule over the axis rather than bespoke logic.
- Entity-scoped permissions come free — the bookkeeper for one company sees only
  that company.

Bolting this on later is what forces schema migrations and re-modelling, which is
why it belongs in the model from the start even though most early customers won't
use it.

**And the broader read: "multi-entity" is not only legal entities.** It is also
branches, franchises — and, most importantly, **an accounting firm's client
portfolio.** A Belgian accountant with 80 SMB clients is the highest-leverage buyer
this product has, and to them "multi-entity" means "80 businesses I need to see
across, with one login and a consistent P&L structure".

That reframes the theme from a feature into a **channel strategy**. Accountants are
the distribution channel for SMB financial software in the Benelux; they decide
what their clients run. Serving them needs a tier *above* the tenant — portfolio
views, cross-client benchmarking, a shared reporting structure applied to every
client, per-client billing, optional white-labelling. **That tier has to be
designed into the permission model early**; retrofitting a level above the tenant
is painful and touches every RLS policy in the database.

### 2.5 A metric library, and then benchmarking

If the model is canonical, metric definitions can be **shipped by Clarion** rather
than derived per tenant: net revenue, gross margin, DSO, DPO, working capital,
runway, customer concentration — each with the accounting-correct definition, in
Dutch, French and English.

- Day-one value with no blank slate to fill in.
- Consistency: two customers get the same definition of gross margin, which today
  they demonstrably would not.
- It is a content asset that improves without engineering.

And then the thing only a multi-tenant platform with a canonical model can do:
**anonymous peer benchmarking.** *"Your DSO is 47 days; the median for wholesale
businesses your size is 38."* SMB owners want this badly and cannot get it
anywhere — their accountant has the data but not the tooling, and Fabric
structurally cannot do it because every customer's model is their own.

It requires the canonical model (comparable measures), the identity layer (sector
and size from the company register), and consent. It is plausibly the strongest
long-run differentiator in this entire document, and it is only reachable *through*
§2.1 and §2.2 — which is a good reason to sequence them first.

### 2.6 Reconciliation as a shipped feature

Cross-system joins and consolidation both introduce a failure mode the SMB cannot
detect: **numbers that look plausible and are wrong.** A double-counted
intercompany invoice, a totals row imported from a spreadsheet, a customer merged
with the wrong customer.

So the platform should prove itself, continuously and visibly:

- warehouse revenue reconciles to the source system's own revenue report;
- mapped GL accounts sum to the trial balance;
- receivables reconcile to the aged-debtor listing;
- intercompany balances net to zero across the group;
- a flagged, quantified answer when they do not.

An SMB will not audit this and should not have to. **A warehouse that reconciles
itself back to the source systems is worth paying for. One that does not is a
liability**, and it is the single most credible answer to "why not just use Power
BI" — because Power BI will happily show a wrong consolidated number forever, and
never mention it.

---

## 3. What the three themes become

Once §2 exists, the themes stop being projects:

| Theme | What it becomes |
|---|---|
| **Cross-system questions** | A consequence of the canonical model + identity layer. There is no join to build. The work moves to connector breadth, which is now cheap. |
| **Spreadsheets** | One more mapper into the model — plus grids, round-trip and Excel-as-client, which are what make it first-class rather than an import. |
| **Multi-entity** | An axis that was always there. Consolidation is a rule set over it; the accountant portfolio is a tier above it. |

That is the test of whether the architecture is right: the named features should
become boring.

---

## 4. How the build direction changes

Today: **source → profile → AI designs a model → products.**
Target: **model → sources map into it → products are generated.**

The honest objection is that this looks like a rewrite of a live platform. It is
not, and the reason is that **the convergence has already started by accident**:

- The connector star-schema templates are already per-connector deterministic
  models — the muscle for "declare a model, instantiate it" is built, tested and
  shipping. The generalisation is to point templates at a *shared* target instead
  of a per-connector one.
- Both templates independently arrived at the same conformed shapes: a customer
  dimension carrying `vat_number` under the same column name in both. Two
  connectors converged on the same model without being asked to.

So the move is: **unify deliberately what is already converging.** Extract the
common target from the two existing templates, make it the canonical model, and
have each connector declare its mapping into it. AI keeps the remainder. Existing
per-connector products keep working throughout; the canonical layer is added
alongside, not swapped in.

That is an incremental path with a real destination, which is the only kind worth
committing to.

---

## 5. The alternative: derive the model from a relationship graph

The obvious alternative to *shipping* a model is to **discover** one. Give the user
a relationship canvas spanning every table and column of every connected source,
let them draw (with AI proposing) how it all fits together, and generate the
Kimball model from that graph. Each new source is then: plug it in, connect its
lines to what is already there, fill in the definitions, extend the model.

It deserves a serious answer, because it is right about several things:

- it avoids the universal-model death trap §2.1 warns about — nobody has to decide
  in advance what "Customer" means for every business;
- it fits the machinery already built — `RelationshipCanvas`, Neo4j,
  `table_relationships`, the AI review queue, vendor-declared relationships;
- it respects the real heterogeneity of SMBs, including custom Odoo modules,
  homegrown systems and industry oddities;
- it is incremental in exactly the way a small team wants.

### 5.1 Where it breaks as the *primary* path

**1. A relationship graph is not a model.** Knowing that
`SalesInvoices.InvoiceTo → Accounts.ID` tells you how to *join*. It does not tell
you that `Accounts` is a customer (in Exact Online the same table is customer,
supplier and prospect, separated by flags), that `AmountDC` is net revenue and
that credit notes are already negative, what the grain of a fact is, or which
measures are additive. Kimball modelling is maybe 10% "what joins to what" and 90%
"what does this mean, what is the grain, what may be summed". The graph gives the
10% and the hard part is untouched.

**2. The cross-system relationship is precisely the one that cannot be drawn.**
Inside one source, a relationship is a foreign key: structural, verifiable,
measurable by containment. Across two systems there is no foreign key — Shopify
has no column pointing at Exact Online's `Accounts.ID`. What connects them is an
*identity assertion about the real world*: "these two rows are the same company."
That is a **per-row** fact, not a per-column one, and it is fuzzy and it changes.
Drawing a line from `shopify.customers.email` to `exact.Accounts.Email` is not a
relationship, it is a matching rule — and it will be silently right about 60% of
the time. So the drawer solves the intra-source problem, which vendor docs and
declared FKs already largely solve, and leaves the inter-source problem — the
actual reason cross-system is hard — exactly where it was. **An identity layer
(§2.2) is required under either architecture.**

**3. Somebody has to draw it, and that somebody is a data modeller.** Sixty Exact
Online entities produce ~170 relationships. Confirming them is a data-modelling
exercise in a vendor's data model. The SMB owner cannot do it and the accountant
will not. "AI proposes, human confirms" is what the platform already does — and
the 2026-08-03 production audit measured that AI-proposed graph at 8 unresolved
endpoints, 10 pointing at a non-key, and 14 multi-target out of 170. A business
user confirming 170 propositions of which roughly a fifth are subtly wrong, in a
domain they do not know, is the *opposite* of minimal technical involvement.

**4. It does not compose across tenants.** If every tenant derives their own
model, there is no shared vocabulary — so metric definitions cannot be shipped,
benchmarking (§2.5) is impossible, support is bespoke forever, and a new connector
helps one customer at a time instead of all of them.

**5. The platform stops accumulating.** Under a shipped model, improving the Exact
Online mapping improves every customer on the next release. Under a per-tenant
drawn graph, each customer's model is frozen at whatever they drew, and improving
it means redoing it per tenant, by hand, forever.

**6. Clarion has already run this experiment.** The connector star-schema
templates exist *because* AI-designing a model from profiled schema plus
relationships produced worse results than a hand-authored model. The bus-matrix
flow now prefers the template and the AI designer is officially the fallback. That
is not a hypothesis about the drawer-first approach — it is the measured outcome
of it, in this repository.

### 5.2 The reframe that dissolves the tension

The objection to §2.1 is really: *why should Clarion pre-determine which entities
the customer needs?*

It doesn't. **A canonical model does not decide what the customer needs. It
decides what Clarion *knows about*.** Exact Online has 60 entities; a good
canonical model covers perhaps 12 of them deeply. The other 48 still sync, still
land as source tables, still appear in the catalog, and are still queryable —
spine, not cage (§2.1, rule 3). Nothing is taken away. What is added is a
reconciled centre that Clarion can ship metrics, benchmarks and cross-system joins
against.

And note which parts of an SMB are actually variable. Is a customer a customer?
Is an invoice an invoice with a date, a party, lines, amounts and VAT? Is a GL
account a GL account — in Belgium, *legislated* via the standardised chart of
accounts? These are the same for every SMB on earth. What varies is which system
holds which piece, what the business calls things, their reporting structure, and
their custom fields.

**The entities are near-universal; the mapping and the vocabulary are what vary.**
Drawer-first inverts that — it treats the entities as the variable thing to be
discovered per customer, and therefore re-derives the same Customer concept five
hundred times.

### 5.3 Synthesis — the drawer is the input, not the output

The two ideas are not competitors once they are put in the right order:

| Layer | What it is | Who does it |
|---|---|---|
| 0 — **Source graph** | Tables, columns and true FK relationships *within* each source | Vendor docs + declared FKs + profiling; **the drawer repairs and extends it** |
| 1 — **Mapping** | "Exact `Accounts` where `IsSales` → canonical Customer" | Shipped by Clarion per connector; AI-assisted + drawer for unknown sources and custom fields |
| 2 — **Canonical model** | Small, opinionated, versioned | Clarion |
| 3 — **Star schema** | Facts, dimensions, grain, additivity | Generated from layer 2, deterministically |

So the relationship drawer is not deleted — it is **positioned**, and it has three
jobs it is genuinely the best tool for:

1. **Sources Clarion has never seen** — a custom SQL Server database, a homegrown
   system, an industry vertical tool. No mapping can be shipped, so drawer + AI
   *is* the path. This is the long tail, and it must be supported.
2. **Custom fields and custom modules** on a known source — the Odoo instance
   with `x_` fields, the Exact division with a bespoke free-field convention.
3. **Repair** — fixing a wrong AI inference, confirming an uncertain one.

And there is a fourth use that is arguably the most valuable of all: **the drawer
as Clarion's own internal authoring tool for layer 1.** If mapping a new connector
into the canonical model is a visual exercise rather than a TypeScript exercise,
connector onboarding stops being an engineering task and becomes a modelling task
a non-engineer can do — and the result ships to every tenant at once. That turns
the user's instinct into leverage instead of per-tenant labour.

### 5.4 What the customer experiences, which is the real test

*Drawer-first:* connect Exact → we found 60 tables and 400 columns → here are 170
suggested relationships, please confirm each → now choose which are facts and
which are dimensions → now declare the grain. The customer leaves. This is a
sharper version of the onboarding problem the 2026-07-15 assessment already
found.

*Model-first:* connect Exact → "Found your customers, invoices, suppliers and
general ledger. Here is your revenue, margin, DSO and top customers." Three
minutes, zero decisions. Then, if something is missing or odd, open the drawer.

The drawer is the escape hatch and the repair tool. It must be excellent. It must
not be the front door.

### 5.5 The refined proposal: understand first, then *activate* — not *determine*

The strongest version of the drawer-first argument is not "derive the model from
the graph". It is a sequence:

1. understand each source system — its relations and its definitions;
2. to combine sources, draw the links between them, with a mapping table where
   there is no key;
3. **then** determine the canonical model — which entities does *this customer*
   need;
4. build the data model from both the canonical model and the source
   relations/definitions, and point the AI at that.

**Steps 1, 2 and 4 are right and are already what this document proposes.** You
cannot map Exact into a canonical Customer without first knowing that `Accounts`
with `IsSales` is the customer — understanding the source is a *prerequisite* to
mapping, which is why layer 0 sits below layer 1 in §5.3. Step 2 is the identity
layer (§2.2), and "a mapping table in between" is exactly right, because between
two systems there is no key to draw. Step 4 is right too: the canonical model
alone cannot emit SQL. Generating the star schema needs the source graph (which
tables join, at what grain, with the vendor's own column semantics) *and* the
canonical target. The AI then reads both — canonical concepts for meaning and
metrics, source detail for everything the model doesn't cover.

**Step 3 is where it breaks, and it is one word.** If the canonical model is
*determined per customer, after inspecting their sources*, it is not canonical —
it is a per-tenant model with a better name, and every property that justified it
disappears: shipped metric definitions, benchmarking, dashboards surviving an ERP
migration, one connector mapping reused by all tenants, improve-once-benefit-
everyone. "Canonical" means *the same for everyone*. A per-customer canonical
model is a contradiction in terms.

**But the concern underneath step 3 is legitimate**, and it has a precise answer.
The concern is: *not every customer needs every entity — a services firm has no
stock, a retailer has no projects.* True. The answer is **activation, not
determination**:

- the model defines Party, Document, Stock, Project **identically for everyone**;
- for a given tenant, only the parts something maps into are activated and shown;
- a services firm simply never sees Stock — not because their model differs, but
  because nothing feeds it.

*Which entities does this customer see* is a per-customer question. *What is a
Customer* is not. Compare the Belgian standardised chart of accounts: every
company uses the same account 700 for revenue, and a company without inventory
just doesn't use the 30–39 range. Nobody determines a bespoke chart per company;
they use the parts that apply. That is exactly the relation between the canonical
model and a tenant's activated subset. It is also why Odoo scales — it ships
`res.partner` and `account.move` and lets you install modules, rather than asking
each customer what a partner should be.

**Two further readings of step 3 that are correct, and worth separating out:**

- *"What we learn from real customers should shape the model."* Yes —
  emphatically. The model should be built from what the connectors already agree
  on, and grow as new sources reveal gaps. That is a **product development loop**,
  run centrally and versioned. It is not a per-tenant loop.
- *"Verticals differ — construction needs Project, staffing needs Placement."*
  Yes — and the answer is **modules**, again as Odoo does. When thirty
  construction customers need Project, it is added once and all thirty get it,
  plus the thirty-first for free. Thirty tenants each designing their own Project
  produces thirty incompatible Projects and zero leverage.

So the corrected sequence, which is the architecture of §5.3:

> understand the source → map it into a shipped canonical model (mapping table
> where identity has no key) → **activate** the parts this customer's data
> supports → generate the star schema from the canonical model *plus* the source
> graph → point the AI at both.

### 5.6 The rigidity objection — and the smaller bet that answers it

Three worries, all legitimate: **(a)** a fixed model forces bad fits; **(b)**
Clarion has to maintain it forever; **(c)** customers become dependent on us for
their own modelling. Taken seriously, they shrink the proposal — correctly.

**(a) Rigidity is real, but only at the periphery.** An invoice is an invoice; a
GL account in Belgium is legislated; a party with a VAT number is a party with a
VAT number. There is no forcing there — the fit is genuine, and it covers most of
what an SMB analytics product ever needs. The forcing starts further out:
manufacturing BOMs, construction work-in-progress, staffing placements,
subscription MRR, project time-and-materials. **So coverage is the wrong goal.**
A small high-confidence core plus AI-per-source for everything else is the right
goal — and everything unmapped still syncs, still lands as source tables, still
answers questions. Nobody is ever blocked; they just don't get the shipped
guarantees on that part.

**(b) The maintenance burden already exists, and this reduces it.**
`exactonline/starSchemaTemplate.ts` (6 dims, 6 facts, 25 relationships) and
`odoo/starSchemaTemplate.ts` (9 dims, 6 facts, 33 relationships) are already
hand-authored per-connector models, maintained by us, chosen *because* the AI
designer was worse. Today connector #3 costs a whole template including its own
conformed-dimension design; with a shared target it costs a mapping. The genuinely
new cost is **governance of the shared model** — versioning it, and migrating
tenants when it changes without breaking their dashboards. That is real and should
not be waved away.

**(c) "Dependent on us" is a choice between dependencies, not a way to avoid
one.** The alternatives are: dependent on our shipped model (fast and correct,
but you wait for us at the edges); dependent on AI inference (autonomous, but
non-deterministic and wrong silently — the 2026-08-03 FK audit is what that looks
like); or dependent on the customer's own modelling skill, which for an SMB means
dependent on a consultant, i.e. the Power BI failure mode.

The mitigation is not to avoid shipping a model. It is to make the **escape hatch
genuinely self-service**, so no customer ever *has* to wait for us:

- map an unmapped source field into a canonical attribute themselves;
- add a tenant-local entity or dimension the model doesn't have;
- extend a canonical entity with their own attributes;
- use the drawer for a source we have never seen.

Accelerated where we have done the work, autonomous where we have not. **This
raises the drawer's importance above what §5.3 gave it** — it is not only repair
and long-tail, it is the guarantee that the model can never become a ceiling.

#### The counter-proposal: teach the AI each source's intricacies instead

*"Give the AI deep per-source knowledge — that Exact has one `Accounts` table with
`IsSales`/`IsSupplier` flags — so it can behave correctly and derive the common
dimensions itself."*

This is right, and **it is already built**: `exactonline/docs.ts` carries 2,613
vendor-documented columns, and `getKnownRelationships` carries the FK catalog. The
AI already has the intricacies.

But notice what that knowledge does and does not do. It tells the AI how to read
*that source*. It does not create a vocabulary shared *across sources* or *across
tenants* — so if tenant A's inference calls it Customer and tenant B's splits it
differently, there is no concept to hang a shipped metric or a benchmark on, and
the same source profiled twice can yield different models. That is not a rigidity
problem, it is a **consistency** problem, and consistency is exactly what metrics,
matching and benchmarking need.

The two positions are closer than they look. *"Exact `Accounts` where `IsSales` →
Party in the Customer role"* **is** the encoding of that intricacy — written down
once instead of re-inferred per tenant. So the real question is one axis only:

> **Is the source knowledge re-derived by AI per tenant, or written down once and
> shipped?**

Written down: deterministic, consistent, testable, improves for everyone, cheap at
run time — but somebody writes it and it can be incomplete.
Re-derived: adapts to each instance automatically, no maintenance — but
non-deterministic, inconsistent between tenants, expensive, and wrong silently.

The answer is the ladder Clarion already uses for descriptions
(`docs > curated > ai`), one level up: **written down for the stable core,
AI-derived for the periphery.**

#### The smaller bet: conformed dimensions, not a canonical model

Given (a)–(c), the first commitment should be much smaller than §2.1 implies:
conformed **dimensions** only, with **facts left entirely alone** to the existing
per-connector templates and the AI.

**And the starter set should be measured, not argued.** Both worries — missing a
dimension that is genuinely common, and squeezing in one that isn't — are the same
failure: guessing the boundary. Two hand-authored templates already exist, written
independently by people who knew the sources. Where they *agree* is evidence.

Diffing them (`exactonline/starSchemaTemplate.ts` vs `odoo/starSchemaTemplate.ts`):

| Concept | Exact Online | Odoo | Verdict |
|---|---|---|---|
| Party | `dim_account` | `dim_partner` | **both — conform** |
| Product | `dim_item` | `dim_product` | **both — conform** |
| Product group | `dim_item_group` | `dim_product_category` | **both — conform** |
| GL account | `dim_gl_account` | `dim_account` | **both — conform** |
| Journal | `dim_journal` | `dim_journal` | **both — conform** |
| Payment terms | `dim_payment_condition` | `dim_payment_term` | **both — conform** |
| Legal entity | — (one division per connection) | `dim_company` | one — but a known requirement (§2.4) |
| Currency | — | `dim_currency` | one — not yet evidence |
| Unit of measure | — | `dim_uom` | one — not yet evidence |
| Date | infrastructure (`dim_date`, always allowed) | same | already conformed |

So the evidenced set is **six**, not the five guessed earlier — and the guess was
wrong in *both* directions: it named Period (already handled as infrastructure)
and Entity (a design decision, not convergence), while missing Product group,
Journal and Payment terms, which both connectors independently have. That is the
owner's worry (a) materialising inside a single paragraph, and it is the argument
for measuring rather than designing.

**A concrete bug this also surfaces:** `dim_account` means *party* in the Exact
template and *GL account* in the Odoo one. The same table name, two different
concepts. The moment a query spans both connectors those collide — which is an
independent, immediate reason to conform names.

**The inclusion rule, so the boundary is not relitigated every time:** a dimension
enters the conformed set only when (i) **two or more connectors independently have
it**, (ii) it has a stable identity attribute, and (iii) people filter, group or
match on it across systems. Everything else waits. That rule prevents squeezing;
the demand signal below prevents missing.

**Make "not conformed" a visible, measured state — not a defect.** When a source
has a dimension outside the set, it still syncs, still lands, still answers
questions, and Clarion says so plainly: *"Exact also has Cost centres — we don't
share these across systems yet."* Then **count how often that line appears across
tenants**. That is a demand signal telling you exactly what to conform next, from
evidence rather than argument. After the first release you never have to guess
again.

**Make it reversible.** A conformed dimension that does not hold up is demoted
back to per-connector. Designing for removal is what keeps the bet cheap.

**Why facts still stay out, concretely.** Four of the six facts also converge by
*name* — but not by *semantics*. Odoo's invoice-line fact needs
`CASE WHEN move_type IN ('out_refund','in_refund') THEN -price_subtotal`, while the
Exact template's own comment records that credit notes are natively negative "so
unlike the Odoo template no sign-flip". Same concept, opposite handling. Names
converging is not semantics converging, and facts are where that gap does damage.

Why this is the right size:

- **Facts are where rigidity hurts** — grain, additivity, business meaning, vertical
  variation all live there. Dimensions are where sharing pays: they are what you
  join on, match on, filter by and benchmark across.
- It delivers what the three themes need: cross-system joins get a target,
  identity gets something to resolve *into*, metrics get something to hang on,
  the entity axis exists.
- It is five artefacts, not a model of a business. Small enough to write, to
  version, and to abandon if the thesis fails.
- It is Kimball's own answer to this exact tension, and it is deliberately *less*
  than a canonical model.
- Both existing templates have already converged on most of it — `dim_account` and
  `dim_partner` both carry `vat_number` under the same name (§8). The work is
  extraction, not invention.

If conformed dimensions prove out, extending toward the fuller model in §2.1 is a
later, evidence-based decision. If they do not, very little was spent.

### 5.7 ADOPTED DESIGN — derive the dimensions, standardise the names

**This supersedes §2.1 and §5.6 as the plan of record.** §2.1 remains the
described destination; §5.6's measurement is still needed, but its output changes
from "pick a canonical set" to "pick the standard names and the thin contract".

The design:

> Do **not** ship a canonical model. Let the **first source derive** the dimensions
> and facts — using the connector's existing star-schema template, or AI where
> there is none. But **standardise the dimension names** to Kimball conventions:
> everyone has a customer, a product, a GL account, so they are always
> `dim_customer`, `dim_product`, `dim_gl_account`. When a second source arrives,
> AI works out how it flows into the **dimensions that already exist**, using the
> source's relationships and definitions, with the user confirming.

Why this is better than a shipped canonical model:

- **No up-front commitment.** Nothing has to be designed before the product ships.
- **Unanticipated dimensions come free.** If Exact has cost centres,
  `dim_cost_centre` simply exists — no waiting for us to add it to a model. This
  was the strongest objection to §2.1 and this design answers it structurally.
- **The model reflects what sources actually have**, not what we guessed they
  have.
- **AI is used where it is genuinely good**: mapping a new thing onto an existing,
  known thing — far easier and more verifiable than designing a schema from
  scratch, which is the task it was measurably bad at.
- The naming standard alone fixes a live defect: `dim_account` currently means
  *party* in the Exact template and *GL account* in the Odoo one (§5.6).

It needs three additions to actually work.

#### (1) Standardise a thin attribute contract, not only the name

A standard name with free-form contents is a promise the platform cannot keep. If
tenant A's `dim_customer` comes from Exact (`account_code`, `vat_number`,
`is_supplier`) and tenant B's comes from Shopify (`email`, `total_spent`), then a
shipped metric or a dashboard reading `dim_customer.country` works for one and
fails silently for the other. The **name creates an expectation that queries, the
AI and shipped metrics will rely on.**

The fix is small — per standardised dimension, fix only:

- the **identity column** (`customer_key`), and
- the **match attributes** used to resolve the same entity across systems
  (`vat_number`, `email`).

Three to five columns. Everything else stays whatever the source has, free-form
and source-derived. That is not a canonical model; it is the minimum that makes
the shared name mean something.

#### (2) A source-priority rule, so connection order doesn't decide the model

If tenant A connects Shopify first and tenant B connects Exact first, their
`dim_customer` are shaped differently — and when A later adds Exact, the richer
accounting master data gets squeezed into a webshop-shaped dimension. That is
rigidity introduced *by accident*, which is worse than rigidity by design.

Rule: **when present, the accounting/ERP source establishes the shape of master-data
dimensions.** It is the most complete and most authoritative source for parties,
products and accounts, and any accountant would say the same. Other sources
conform to it.

#### (3) Promote confirmed mappings from tenant-local to shipped — the load-bearing one

The first time Shopify is mapped into `dim_customer`, AI proposes it and a human
confirms it. **Do not throw that away.** Store it, and reuse it for the next
tenant that connects Shopify.

Once that happens, this design and §2.1 converge — because a cached, human-confirmed
mapping *is* a shipped connector mapping. The difference is that it was
**discovered from real data rather than authored in advance**, which is strictly
better: it is evidence-based, it costs nothing up front, and it is right by
construction for the sources customers actually run.

That single move is what turns per-tenant AI inference (which diverges, and cannot
support shipped metrics or benchmarking) into a compounding platform asset. Without
it, every tenant re-derives the same mapping slightly differently and the platform
never accumulates.

The precedence ladder becomes, per connector: **confirmed shipped mapping →
AI proposal → user confirmation → promote back to shipped.** A loop, not a
one-way street.

#### What does not change

- **The identity layer is still required** (§2.2). No naming convention and no AI
  mapping can tell you that Shopify customer 4471 is Exact's VAN DAMME BVBA. That
  is a per-row assertion about the real world and stays per-row.
- **Facts stay per-connector** (§5.6) — names converging is not semantics
  converging.
- **"Not conformed" stays visible and counted** (§5.6) — still the demand signal.

#### What Clarion specifies, and what AI does — the dividing line

> **Clarion standardises the cheapest things with the highest leverage: names.
> AI does everything expensive and variable: meaning, structure, mapping.**

**What Clarion writes down — one file, ~40 lines, no model:**

```
dim_customer      identity customer_key   match vat_number, email   label customer_name
dim_supplier      identity supplier_key   match vat_number, email   label supplier_name
dim_product       identity product_key    match product_code        label product_name
dim_product_group identity group_key      match group_code          label group_name
dim_gl_account    identity account_key    match account_code        label account_name
dim_journal       identity journal_key    match journal_code        label journal_name
dim_payment_term  identity term_key       match term_code           label term_name
dim_employee      identity employee_key   match email               label employee_name
dim_entity        identity entity_key     match vat_number          label entity_name
dim_date          platform infrastructure — already exists
```

That is the whole of the up-front specification. It says *"when a source has
customers, the table is called `dim_customer`, and if the source has a VAT number
it goes in a column called `vat_number`."* It does **not** say what a customer is,
which attributes one has, or how many there should be.

Plus two one-line rules: the **ERP wins** for master-data shape (§5.7.2), and
**confirmed mappings get promoted** (§5.7.3).

**What AI does, per source:**

- read the source's tables, columns, relationships and vendor docs;
- decide which source table feeds which standard dimension (*"Exact `Accounts`
  where `IsSales` is the customer dimension"*);
- fill the contract columns (`VATNumber → vat_number`, `Email → email`);
- **bring every other source column along unchanged** — `City`, `CreditLine`,
  `Status`, whatever exists;
- propose it in plain language; the user confirms;
- the confirmed mapping is stored and reused for every later tenant on that
  connector.

**Why Clarion must specify even the names.** If AI names things per tenant, one
gets `dim_customer` and another `dim_client` — and then nothing written against
the model works anywhere: not a shipped dashboard, not a support answer, not the
AI's own prompt, not the matching code looking for a VAT number. Names are the one
thing that must be identical everywhere **and** the cheapest thing to fix. A name
constrains nothing about contents, so it costs no flexibility at all.

**How the list grows — from evidence, not a design meeting.** When AI finds
something with no existing home (Shopify's sales channel, say) it creates
`dim_sales_channel` with no contract columns, and that is **counted**. When twenty
tenants have a sales-channel dimension, it earns a line in the file. The list is
never guessed — it is the record of what turned out to recur.

#### Does the file explode as connectors are added?

The obvious worry: 40 lines for two ERPs, so 500 lines at fifteen connectors —
at which point it *is* a canonical model, arrived at by the back door. It doesn't
work out that way, for four reasons.

**1. The file grows with SHARED concepts, not with sources — and shared concepts
saturate.** The inclusion rule is "≥2 connectors independently have it". Most of
what a new source brings is unique to it and therefore never enters the file:

| New source | Feeds existing standard | Genuinely new shared entry |
|---|---|---|
| Shopify | customer, product, product group | *sales channel* — only once a **second** webshop connector exists |
| HubSpot | customer (companies), employee (owner) | *pipeline stage* — only once a second CRM exists |
| SD Worx | employee, entity, GL account | *pay component* — only once a second payroll exists |
| CODA/PSD2 | supplier, customer, GL account | *bank account* |
| Spreadsheet | whatever the user says it is | none |

Each connector adds roughly **one to three** entries, not ten — and the big ones
(customer, product, GL account, employee, entity) are hit by almost every source,
so they are declared once and never again. Realistically: ~6 entries at two
connectors, ~15–20 at ten. Call it 80 lines. The curve flattens.

**2. Tier the entries — the expensive part is already closed.** Not all standard
dimensions need a contract:

- **Tier 1 — matching dimensions** (customer, supplier, product, employee,
  entity). These carry the `identity` + `match` columns because they are what
  identity is resolved on across systems. **This set is essentially complete
  already** — the things SMBs match across systems are parties, products and
  people, and there is no sixth category coming.
- **Tier 2 — name-only dimensions** (journal, payment term, sales channel, cost
  centre, pipeline stage, pay component). Nobody matches a journal across systems.
  These need consistency of *name* and nothing else — **one word each.**

So the part that costs thought stops growing almost immediately; the part that
grows costs a word.

**3. The cost per entry is constant and tiny.** Adding `dim_sales_channel` means
writing its name and, if Tier 1, three column names. It does **not** require
deciding what a sales channel *is*, what attributes it has, or how it relates to
anything else. That is the whole difference from a canonical model, where each new
entity costs a design discussion. Here even 80 lines is still a naming registry,
not a model.

**4. Entries can be removed.** Anything that stops earning its place is demoted
back to source-specific.

#### The real cost is renaming, not the file — and it has a cheap mitigation

The genuine expense arrives when a concept is *promoted* after tenants already
have it: twenty tenants hold an AI-named `dim_shop_channel` and it becomes
`dim_sales_channel`. Renaming breaks their dashboards.

Two mitigations, both cheap and both worth doing from day one:

- **Constrain the naming pattern even where the name is not specified.** Require
  AI to name every dimension `dim_<singular_snake_case_business_noun>` in English.
  Ad-hoc names then land close to whatever the standard would be, and promotion is
  usually a trivial rename rather than a redesign.
- **Keep an alias list.** A promoted dimension answers to its old name for a
  deprecation window, so nothing breaks the day the file changes.

#### Governance: counted, not debated

Unmatched dimensions are already counted (§5.6). Promotion is then mechanical:
review the counter when onboarding a connector, promote anything over the
threshold, bump the file's version, let tenants pick it up on their next build.
No design meeting — the counter decides.

And if the file *does* eventually reach fifty rich entries, that is not a failure:
it is evidence that a canonical model was the right idea after all — arrived at
from what customers actually run rather than from guessing. **The design is
self-correcting in both directions.**

#### The one thing deferred

Benchmarking (§2.5) needs comparable **measures**, and measures live on facts,
which stay per-connector under this design. So benchmarking moves further out. It
is deferred, not lost: measure conformance can be added later on the same
promote-what-is-confirmed mechanism, once there is evidence about which measures
actually recur.

### 5.8 FINAL — the minimal version (this is the plan of record)

Supersedes the governance machinery in §5.7. The owner ruled out versioned
entries, promotion of names, aliases and deprecation windows. Removing them makes
the design **simpler**, not weaker — because the contract columns already do the
work promotion was there to do.

#### The whole thing

**1. One list. Written once. It does not change.**

```
dim_customer       key customer_key    match vat_number, email    name customer_name
dim_supplier       key supplier_key    match vat_number, email    name supplier_name
dim_product        key product_key     match product_code         name product_name
dim_product_group  key group_key                                  name group_name
dim_gl_account     key account_key     match account_code         name account_name
dim_journal        key journal_key     match journal_code         name journal_name
dim_payment_term   key term_key                                   name term_name
dim_employee       key employee_key    match email                name employee_name
dim_entity         key entity_key      match vat_number           name entity_name
dim_date           already exists as platform infrastructure
```

Ten lines. These are the concepts nearly every business system has, so the list is
written from what is already known rather than discovered over time. **There is no
version number and nothing is ever promoted into it.**

**2. Two sentences of guidance in the AI prompt** — not systems, not features:

- *"If a source has customers, the table is `dim_customer` and the VAT number goes
  in `vat_number`."*
- *"For anything not on the list, name it `dim_<singular_english_noun>`."*

**3. Anything not on the list is the tenant's own.** AI names it, it builds, it
works, it is queryable. `dim_sales_channel` in one tenant and `dim_channel` in
another **does not matter**, because Clarion ships nothing that reads them.
Divergence only matters for things Clarion ships against, and Clarion only ships
against the ten. No counting, no threshold, no promotion.

**4. AI re-derives the mapping per tenant, and that is fine.** Because the ten
names and their key/match columns are fixed, the *output shape* is pinned no matter
how many times AI runs. Tenant A's and tenant B's `dim_customer` both have
`customer_key` and `vat_number`; they may differ in which extra source columns come
along, and that difference harms nothing.

> **This is why mapping promotion is not needed.** §5.7 called it load-bearing on
> the assumption that consistency had to come from caching the mapping. It comes
> from the contract instead. Caching a confirmed mapping is then a pure cost
> optimisation — do it later if AI spend becomes annoying, as a cache, not as
> architecture.

#### Where a customer could be blocked waiting for Clarion — nowhere

- Source has customers, no shipped mapping → **AI maps it.** Not blocked.
- Source has something unusual → **AI names and builds it.** Not blocked.
- AI got it wrong → **user corrects it in the UI.** Not blocked.
- The list itself → **never changes**, so there is nothing to wait for.

That is the "no dependency on us" property, and it holds because the only thing
Clarion owns is ten names that were fixed on day one.

#### What is explicitly NOT built

Versioned model entries · promotion of names into the list · alias and deprecation
windows · unmatched-dimension counters as a feature · a canonical model · conformed
facts or measures · per-tenant model governance of any kind.

#### What actually has to be built

| # | Work | Size |
|---|---|---|
| 1 | Write the ten-line list | half a day |
| 2 | Rename dimensions in the two existing templates to match it — also fixes the live `dim_account` collision | half a day |
| 3 | Add the two naming sentences to the star-schema / bus-matrix prompts | small |
| 4 | **New:** an AI step that maps a *second* source into the dimensions that already exist, proposed in plain language, user confirms | the real build |
| 5 | Identity layer — matching rows across systems (§2.2) | separate, larger |

Items 1–3 are days and are worth doing regardless of everything else in this
document, because they fix a real name collision and cost nothing. Item 4 is the
feature. Item 5 is what makes cross-system actually answer questions.

---

## 6. Sequencing

| # | Work | Why here |
|---|---|---|
| 0 | **Standard dimension names + thin attribute contract + entity axis** (§5.7). Derive dims from the source as today; fix the NAMES (`dim_customer`, `dim_product`, `dim_gl_account`, …) and 3–5 contract columns per dim (identity + match keys). **Facts stay per-connector.** | No up-front model to design, unanticipated dims come free, and it fixes the live `dim_account` name collision. The entity axis must land here or it becomes a migration later. |
| 0b | **Mapping promotion loop** (§5.7 addition 3) — store every human-confirmed AI mapping and reuse it for the next tenant on that connector. | The load-bearing piece: without it every tenant re-derives the same mapping differently and the platform never accumulates. |
| 1 | **Identity layer.** Party registry + crosswalk; deterministic and externally-verified rungs only; human decisions sticky and rebuild-proof. | Every connector and every theme needs it. Compounding asset. |
| 2 | **Spreadsheet layer.** Files in (upload + linked), managed grids, round-trip keys. | The cheapest second system, and the vehicle for every mapping table the other themes need. Budget vs actual is itself a cross-system question. |
| 3 | **Metric library** shipped with the model, trilingual. | Day-one value; no engineering per tenant; prerequisite for benchmarking. |
| 4 | **Groups + management consolidation** over the entity axis, with intercompany flagging. | Falls out of 0 + 1 cheaply once the axis exists. |
| 5 | **Reconciliation checks** as a visible, shipped feature. | Must land with consolidation, not after — this is where wrong numbers first become invisible. |
| 6 | **Connector breadth**, now a routine mapping exercise: webshop, CRM, payroll, banking. | This is when cross-system questions become real for actual customers. |
| 7 | **Accountant portfolio tier** (design the permission model early, build when a firm signs). | Channel strategy; touches RLS everywhere, so decide the shape before 4. |
| 8 | **Benchmarking**, opt-in, k-anonymous, sector- and size-keyed. | Needs 0–3 plus tenant scale. Strongest long-run moat. |

The pitch after 0–4 is one sentence: *"Connect your systems and your
spreadsheets, and Clarion gives you one true picture of your whole business —
across companies, and it survives you changing ERP."* That sells against Fabric.
"We have a lakehouse too" does not.

---

## 7. What kills this, and the mitigations

- **The canonical model tries to be universal.** The classic death. Mitigate with
  §2.1's three rules: small, opinionated, passthrough-always-available. If it
  needs a committee, it is already too big.
- **Identity resolution merges two real customers.** A wrong match silently merges
  revenue and no one notices. Mitigate: verified-external and deterministic rungs
  ship first; the AI rung ships only after the residual is *measured* on real
  tenant data. The 2026-08-03 invented-foreign-key incident is the precedent for
  what inference does when nobody measures it.
- **Human decisions get overwritten by a rebuild.** Already a known failure class
  in this codebase, already solved once for semantic edits. The mapping and
  identity layers need the same snapshot-and-merge treatment, and it should become
  a shared facility rather than a third copy.
- **Benchmarking gets built before consent and anonymity are designed.** Opt-in,
  aggregate-only, minimum cohort sizes, never raw values. Getting this wrong once
  is unrecoverable reputationally in the accountant channel.
- **The accountant tier is retrofitted.** Adding a level above the tenant after
  the fact touches every isolation policy in the database. Design the shape now
  even if it ships late.
- **Rebuild framing.** If §4 is communicated as "we're rewriting the modelling
  layer", it will not survive contact with a roadmap. It is an extraction of what
  two connectors already agree on, added alongside what exists.

---

## 8. Appendix — the starting position

Where today's code sits relative to §2. Useful for estimating, not for scoping
ambition.

**Everything is scoped to `connection_id`** — design (`busMatrixOrchestrator.ts:83`),
build (`transformationRunner.ts:426`), query (`ConnectorFactory.ts:165` →
`listProductTablesByConnection`), Ask AI (`routes/query.ts:247`). A
cross-connection question cannot currently be expressed at the product layer. Note
the front door became a *topic* on 2026-08-06 while the question path stayed a
*connection* — the canonical model resolves that disagreement rather than papering
over it.

**The cross-connection plumbing already works.** `loadDependencyDimensions`
(`transformationRunner.ts:203`) resolves upstream dimensions by
`dependent_product_id` alone and never filters by connection;
`publishStubFromUpstream` writes the upstream URI onto a row owned by the
*dependent* product, making it visible in that connection's DuckDB session. Pipes
exist; keys and scope do not.

**`vat_number` is already conformed across both templates**
(`exactonline/starSchemaTemplate.ts:94` ← `Accounts.VATNumber`;
`odoo/starSchemaTemplate.ts:97` ← `res_partner.vat`). This is the accidental
convergence §4 is built on, and it means the identity layer's strongest rung works
on day one.

**The `cross_view_relationships` + `ATTACH` path is SQLite-only legacy**
(`routes/query.ts:706` reads `cfg.filepath`; `nlToSqlPrompt.ts:384`). It cannot
work for any API connector. Retire it; do not build on it.

**Spreadsheets: nothing.** `utils/xlsxBuilder.ts` writes XLSX; nothing reads any
tabular file. Open since the 2026-07-15 assessment.

**Multi-entity: nothing.** Exact Online is one division per connection by design
(`exactonline/schema.ts:9`); Odoo's `dim_company` is a dimension, not a
consolidation. No FX, no intercompany, no group concept.

**Two connectors, both ERPs.** Under the current source-first architecture each
new connector is an expensive design problem, which is exactly the constraint
§2.1 removes.

**Security note for the spreadsheet work:** `sqlGuard.assertNoExternalAccess`
deliberately refuses `read_csv` / `read_xlsx` / path literals in user and AI SQL.
Files must be read in the sync path, never by relaxing that guard — it closes the
cross-tenant blob-read vector.

---

## 9. Decisions needed from the owner

1. **The direction flip (§2.1, §4).** Is Clarion a platform that models each
   customer's sources, or one that ships a model of an SMB that sources map into?
   Everything else in this document follows from that answer.
2. **The accountant channel (§2.4).** Is the buyer the SMB, the accounting firm,
   or the firm on behalf of the SMB? It changes the permission model, the pricing
   model, and whether a portfolio tier is a v1 concern.
3. **Benchmarking (§2.5).** Worth building toward as a differentiator, or out of
   scope on privacy grounds? It shapes how much the canonical model needs to be
   comparable across tenants.
4. **Excel ambition (§2.3).** Files-in only, or the full round trip including
   grids and Excel-as-client? The latter is a materially different product
   surface and arguably the highest-adoption one.
5. **Reconciliation (§2.6).** Shipped feature and marketing claim, or internal
   quality check? Making it visible is a commitment to being caught when wrong.

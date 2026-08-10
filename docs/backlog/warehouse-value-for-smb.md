# Why an SMB pays for a warehouse — and what Clarion should become

> Status: **proposal**. No code changed. Written 2026-08-10, reframed the same day.
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

---

## 6. Sequencing

| # | Work | Why here |
|---|---|---|
| 0 | **Canonical model spine + entity axis.** Extract from the two existing templates; ship as a versioned package; connectors declare mappings into it. | Everything else is cheaper after it and more expensive before it. The entity axis must land here or it is a migration later. |
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

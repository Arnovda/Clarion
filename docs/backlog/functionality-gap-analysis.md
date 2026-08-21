# Functionality gap analysis — what a day of using Clarion is missing

**Date:** 2026-08-21 · **Revised same day (v1.1)** after owner feedback: *"you're
too focused on the accounting aspect — Exact Online and Odoo are the main
connectors right now, but HR, operations, timesheets, ERP, … will be onboarded
too. The Excel part I agree with totally."* This revision de-accounts the
analysis: the gaps are restated as domain-agnostic primitives, with
finance-flavoured examples marked as *first instances* (they're first only
because the live connectors are finance-shaped), and one gap the finance lens
underweighted is promoted — **G16, cross-domain questions** — because it is the
payoff of exactly the roadmap the owner describes.

**Status:** analysis, no code changed · **Companion to:**
`warehouse-value-for-smb.md` (the strategic argument), `multi-source-strategy.md`
(the source-side build plan), the 2026-07-15 product assessment (the launch-killer
audit). This doc asks a different question than all three: *walk through the day,
week and month of each person who uses Clarion — where does the product go silent?*

**Method:** a full inventory of the live feature surface (every route, every
backend service, verified against the code on 2026-08-21 — not against CLAUDE.md,
which turned out to understate what exists), crossed with external research:
what SMB owners actually check daily, what the adjacent categories ship
(accounting analytics: Fathom, Syft; push-BI: Tableau Pulse, ThoughtSpot
Spotter; all-in-one SMB data: Peliqan, Weld), BI-adoption failure data, and the
Belgian market context (Peppol B2B e-invoicing mandatory since 2026-01-01).

---

## 0. The one-sentence verdict

**Clarion is a strong *pull* product — you go to it, ask, and look — whose
primary user lives in a *push* world: their day starts on a phone, in an inbox,
with the question "is the business on track?", and Clarion is not there.** The
push skeleton is 80% built (pulse watchlists, a daily morning brief with AI
narration, dashboard email schedules) but the brief never leaves the app, no
metric has a user-set threshold, and nothing renders on a phone. The second
structural absence, restated domain-agnostically: **Clarion describes what
happened but never tells anyone what to *do* — no exception lists, no forward
view, no targets to be ahead of or behind.** And as soon as a second *domain*
source lands (HR, timesheets, operations), a third absence becomes the
headline: **the questions that justify multi-domain onboarding — spanning two
sources — cannot be asked**, because the query layer is still
connection-scoped (G16). Everything else in this doc is smaller than these.

---

## 1. Who uses this, and what their day actually looks like

Three personas, matched to the three roles. What the owner checks daily
*depends on the business*: a product/trade business watches cash, sales pace
and receivables; a services firm watches utilization, billability and
pipeline; an ops-heavy business watches orders, late deliveries and stock.
The *shape* is constant even though the metrics aren't: **two to four
headline numbers plus the day's exceptions, ideally pushed, in sixty
seconds** ("you should know within sixty seconds of opening your laptop
whether you're on track"). For finance specifically, the practitioner
literature is unanimous that cash-flow problems — not lack of revenue — are
the most-cited SMB killer, which is why cash examples recur below; but the
primitives must not be built finance-only.

**The owner / manager (viewer).**
- *Daily, ~8am, often on a phone:* is the business on track — the headline
  numbers for *their* kind of business; did anything weird happen yesterday?
  The answer should arrive, not be fetched.
- *Weekly:* the chase lists — who owes money, whose timesheets are missing,
  which orders are late, what stock is low; how are margins/utilization.
- *Monthly:* how did we do against what we planned; what do outside
  stakeholders (bank, board, investors) see.
- *Ad hoc:* "how much did customer X buy last year?", "how many hours did we
  spend on project Y?" — mid-phone-call.

**The office power user / analyst.**
- *Daily:* answer the owner's ad-hoc questions; keep an eye on data freshness.
- *Weekly:* maintain dashboards, pull operational lists into Excel for
  follow-up (dunning, ordering, planning), share numbers with colleagues who
  will never log in.
- *Monthly:* prepare the management figures; reconcile "why does the
  dashboard say X when the source system says Y".

**The admin / consultant (and, when the source is accounting, the
accountant).**
- *Setup:* connect sources, curate semantics, build topics — well covered today.
- *Monthly:* report packs per stakeholder or per client.
- *Structurally:* consultants and accountants serve a **portfolio** of SMBs
  and want one screen across clients — the tier argument already made in
  `warehouse-value-for-smb.md` §2.4. (The accountant is *a* channel, not *the*
  channel — IT consultants and fractional-ops people occupy the same seat for
  non-finance sources.)

The pattern that matters: **the owner's loop is daily and push-shaped; the
analyst's loop is weekly and Excel-shaped; the consultant's loop is monthly
and report-pack-shaped.** Clarion currently serves all three only in their
*ad hoc, seated-at-a-desktop* moments. And the owner's most valuable
questions — the reason to onboard more than one system — are the ones that
*span* domains: revenue per FTE, labour cost against project margin, overtime
against sales peaks, absence against delivery delays.

---

## 2. What already exists and is genuinely strong

Worth stating precisely, because the inventory found the product is *ahead* of
its own documentation. The 2026-07-15 assessment's missing-features list is
partly stale:

- **Ask AI** is deep: streaming thinking, agentic repair loop, follow-up
  context with layer pinning, entity disambiguation, **forecasting**
  (`forecastEngine.ts` — linear regression + moving averages with confidence
  bands), personalised starters, thumbs feedback, CSV/XLSX export.
- **A full "why?" investigation agent** exists (`/investigate`, investigations
  service, SSE, persisted runs, follow-ups) — multi-step root-cause analysis,
  the exact "agentic BI" capability the 2026 analyst category is being built
  around. **It is orphaned: no link from the rail or palette reaches it** (it
  is reachable inline in Ask AI and as a dashboard slide-over).
- **Dashboards** have generation + refine + self-heal, filters, cross-filter,
  drill-to-detail, cube/pivot, templates, favorites, folders, auto-refresh,
  AI narration ("Story" → PDF), insights strip, widget provenance, and
  **scheduled email reports with AI executive summaries**.
- **Proactive skeleton:** pulse watchlists (metric/slice/theme, sensitivity,
  frequency) + a **daily AI-narrated morning brief** with 14-day history + an
  in-app notification. `morning_briefs.emailed_at` exists in the schema;
  the service header says "email delivery is a separate phase".
- **Governance is unusually complete for the segment:** row-filter and
  column-mask **data policies** per user/role (`policyEngine.ts`, applied
  inside the AI query pipeline — the "hide salaries from viewers" problem
  most SMB tools can't solve without Power BI Premium; note this becomes
  *load-bearing*, not nice-to-have, the day an HR source lands), tenant-wide
  audit log UI, per-entity change history, MFA/passkeys, GDPR erasure,
  retention.
- **Trust machinery:** quality profiling with scores/rules/failed-record
  drill-through, column-level lineage, glossary feeding prompts, review queue,
  relationship canvas with measured evidence.
- **Domain-neutral core:** the semantic layer, topics/subjects, the AI
  designer, the ten-name conformed-dim list (which already anticipates
  `dim_employee`, `dim_department`, `dim_location`) and the build flow are all
  domain-agnostic by construction. The *machinery* generalises; only the
  shipped *content* (templates, KPIs) is finance-flavoured today.

The engine and the governance are not the gap. The gap is where the product
meets the *rhythm* of its users' days — and, next, the *breadth* of their
business.

---

## 3. The gaps, ranked by how often they hurt

G-numbers G1–G15 are stable from v1.0 (they're referenced elsewhere); G16 is
new in v1.1 and deliberately placed at the head of Tier 2 despite its number.

### Tier 1 — the daily loop (hurts every day, mostly the owner)

**G1. Metrics never reach out: no user thresholds, no delivered brief, no
digest.** *Domain-agnostic by nature.*
There is no "tell me when X crosses Y" anywhere — receivables over 60 days,
open tickets, unbilled hours, stock cover: none of them can raise a hand.
Pulse sensitivity is a hard-coded delta bucket; quality alerts fire on
*data-quality* scores, not business values. The morning brief — the product's
best daily artefact — renders only on `/home` and in the bell, so it is seen
only by people who already opened the app; adoption research is brutal about
that assumption (<30% of licensed users open dashboards weekly). Tableau
Pulse, ThoughtSpot Spotter and the SMB accounting-analytics leaders all ship
metric-threshold alerts delivered to email/Slack/mobile as a core loop.
*Why cheap relative to impact:* the watchlist, the daily snapshot job, the
narration, the email transport (ACS/SMTP) and even the `emailed_at` column all
exist. This is wiring, not architecture: (a) email the brief; (b) add an
optional threshold to a pulse entry; (c) let a threshold crossing send
immediately rather than waiting for the morning run.

**G2. No phone. No responsive shell, no PWA, no push.** *Domain-agnostic.*
The 8am check happens on a phone; the rail is a fixed-width desktop chrome,
there is no manifest, no service worker, no mobile layout for Home/topics/
dashboards. This blocks G1's payoff too — an alert that links to an unusable
page teaches the user to ignore alerts. Scope it honestly: not a native app —
a responsive pass over the four surfaces an owner actually opens from a
notification (Home, the brief, a topic page, a dashboard) plus a PWA manifest.

**G3. Clarion describes; it never says what to *do*. No exception lists, no
forward view.** *(v1.1 reframe — was "cash-forward view + AR workflow".)*
Every domain's weekly loop runs on the same primitive: a **list of items that
need action because a condition holds** — invoices overdue, timesheets
missing, shifts unfilled, stock below cover, deliveries late — plus a simple
**forward projection** of the metric the owner steers by (cash for a trade
business; capacity vs booked hours for a services firm). Clarion has neither
as a product concept: everything is aggregates about the past. The generic
build is small: an "exception list" surface driven by a metric + condition +
entity grain (reusing the drill-to-detail machinery), and the existing
forecast engine pointed at a steering metric per topic. **First instance:
AR aging buckets + a "worth chasing today" list + a projected cash line** —
not because Clarion is an accounting product, but because
`fact_receivables`/`fact_payables` with due dates already exist in the live
templates and cash is the daily steering metric for the current connector
base. The HR/timesheet instance (missing timesheets, unbilled hours) ships
the day that connector does, on the same primitive. Deliberately NOT
driver-based financial modelling — that is Fathom's whole product; Clarion
needs the operational view, not the CFO tool.

### Tier 2 — the multi-domain promise and the monthly loop

**G16 *(new in v1.1)*. The questions that justify multi-domain onboarding
cannot be asked.**
The owner's plan — HR, operations, timesheets, more ERPs — has one payoff:
questions that span systems. Revenue per FTE. Labour cost vs project margin.
Overtime vs sales peaks. Absence vs delivery delays. Today the query layer is
**connection-scoped end to end** (design, build, query, Ask AI — the
measured facts in CLAUDE.md and `multi-source-strategy.md` §"still binds"),
so the flagship question of a two-domain tenant is *inexpressible*, even
though the cross-connection seam is already plumbed at the warehouse layer
and `dim_employee`/`dim_department` are already on the conformed-dim list.
This is P3/P4 of the multi-source plan (identity/Mapping primitive, then
un-scoping the query layer) — nothing new to design, but the *priority
argument changes*: under a finance-only lens P4 could wait for a second ERP;
under the owner's actual roadmap it gates the value of every next connector.
The moment the first HR or timesheet source lands, P3/P4 stop being
platform work and become the product.

**G4. No targets on anything — the product can't say "against plan".**
*Domain-agnostic by design requirement.*
There is no target entity at all: no table, no CRUD, no UI; the only trace is
the `bullet_chart` widget whose target must be hand-written into SQL by the
AI. "How did we do?" is only answerable against last year, never against what
the owner *decided* — and that's equally true for a sales target, a
utilization target, a delivery-SLA target or a budget line. Build it as a
small generic entity hanging off KPIs/metrics (metric, period, scope, value)
editable in the UI and joined into dashboard + Ask AI context — **not** as a
finance "budget" feature. Budget *import* (the finance instance, rows per GL
account per month) is the next gap's job.

**G5. Spreadsheets still can't enter the platform** — owner-confirmed, and
confirming from the demand side that P1 of `multi-source-strategy.md` (the
spreadsheet connector) is the right first build. Budgets and targets live in
Excel; so do the satellite lists every department keeps (C1–C10 in that
doc: price lists, shift plans, project budgets, HR rosters). Until a
spreadsheet can be a source, G4 has thin data and the "single reconciled
picture" claim has a visible hole the customer meets in week one — in any
domain, not just finance.

**G6. Reports can't leave the tenant: no share links, no server-side PDF, no
report pack.** *Domain-agnostic.*
The monthly output of the consultant persona is a *document sent to someone
who will never log in* — the bank, the board, the client, the works council.
Today: PDF export is client-side (html2canvas of whatever screen you're on),
sharing is tenant-internal only (`is_shared` within the team; zero
external-link, token or embed machinery). Email schedules render data tables,
not a branded pack. Minimum: a read-only share link (tokened, revocable,
optionally expiring) for a dashboard; a server-rendered PDF of dashboard +
narration ("Story" already writes the narrative).

**G7. Excel round-trip is one-way.**
Exports exist (CSV/XLSX, BOM-correct) — good. But the analyst's weekly loop
re-exports the same file every Monday. A *refreshable* connection (the
`warehouse-value-for-smb.md` §2.3 Excel-as-client argument) or even a
"re-run this export on schedule, mail it to me" option turns a chore into a
subscription. Lower priority than G4–G6; the strategy doc already owns the
full version.

### Tier 3 — adoption and market (hurts at the top of the funnel)

**G8. English-only UI in a Dutch/French market.**
The product's entire thesis is "your business, in your language" — vocabulary
rules, business words, no warehouse jargon — and then every word of chrome is
English. No i18n framework, `lang="en"` hardcoded, `en-GB` formatting (a
Belgian owner reads "1.234,56 €", not "€1,234.56"). NL first, FR second.
(Open question for the owner: does AI output — briefs, answers, narration —
also need to be NL? Probably yes, and that's a prompt-level change, so the
i18n pass should decide both together.)

**G9. The first fifteen minutes are still the weakest surface.**
Re-confirming the 2026-07-15 P0 that hasn't moved: `/onboarding` is an unwired
mock advertising connectors that don't exist (Snowflake, BigQuery, CSV);
register lands on `/sources`; the real funnel is a series of technical
decisions. The Build front door (2026-08-18) fixed the *middle* of the funnel;
the entry is still raw. Cheapest first step: delete or rewrite the mock so it
routes through the real flow (Sources → sync → Build) with the real
connectors, and honest copy about what comes next.

**G10. Built-but-buried features — free wins.**
- `/investigate` is a flagship-grade differentiator with zero inbound links.
  Put it in the rail (Uncover), or surface "Investigate this" more
  aggressively from answers and widgets.
- `/gaps` (definition gaps with hit tracking) is orphaned; it's the curator's
  feedback loop and belongs as a facet of the review/suggestions surface.
- Morning-brief email (see G1) — the column already exists.

**G11. Connector breadth is the strategy — and each new *domain* brings a
content obligation, not just a transport.** *(v1.1 reframe.)*
The owner's roadmap (HR, operations, timesheets, more ERPs) is the growth
axis, and the platform machinery for it exists (SourceConnector framework,
docs-before-inference, AI designer, conformed dims). Two things the finance
lens hid:
- *Per-domain content:* today's star-schema templates, KPI libraries, pulse
  suggestions and dashboard templates are finance-flavoured because the two
  connectors are. Each new domain needs its equivalent (utilization,
  billability, absence rate, overtime for HR/time; OTIF, stock turns, order
  backlog for ops) — the `SOURCE_ONBOARDING.md` playbook already mandates
  templates per connector; extend the same discipline to KPIs and pulse
  suggestions so a new domain lands *opinionated*, not blank.
- *Freshness expectations shift:* ops metrics are intra-day in a way monthly
  accounting never is ("orders in today", "late right now"). The
  pipeline/trigger machinery supports frequent syncs; the cost model and
  default cadences should be revisited per domain rather than inherited from
  the accounting connectors.
- *Peppol (demoted from v1.0's headline to one candidate spike):* since
  2026-01-01 every Belgian B2B invoice is structured UBL on the Peppol
  network — a potential universal invoice stream independent of ERP choice,
  and a reconciliation hook. Worth a timeboxed research spike alongside — not
  ahead of — the domain connectors the owner already plans.

**G12. The portfolio tier — consultants and accountants both sit in it.**
Already argued in `warehouse-value-for-smb.md` §2.4; the category evidence
(Syft, Fathom are *sold* through multi-client portfolio management) is
finance-specific, but the seat is generic: whoever runs data for several
SMBs wants one screen across them. Not urgent while single-tenant gaps above
exist — but every tier-2 build (report packs, targets) should be designed
*aware* that a cross-client tier will sit above it, per the §7 warning about
retrofitting.

### Tier 4 — collaboration and retention (hurts quietly)

**G13. Numbers can't be discussed where they live.** No comments or
annotations on dashboards, widgets or metrics — the "why is April so low?"
conversation happens in email, invisible to the next person who asks. A
lightweight comment thread on a widget (and on a morning-brief bullet) keeps
the discussion attached to the number. Low build cost, high retention value —
this is what makes a tool the *place where the business talks about numbers*.

**G14. Questions can be starred but not kept or scheduled.** A starred
conversation is not a saved question: there's no named, re-runnable,
parameterised question, and no "send me this answer every Monday". Scheduled
questions are also the natural bridge from Ask AI to G1's alerting ("ask this
daily; tell me only if the answer changes materially").

**G15. Benchmarking** — already planned (strategy doc §2.5), gated on
conformed dimensions + consent; Syft ships industry benchmarks today. Nothing
new to add except: G4's targets are the *internal* benchmark and should come
first; peer benchmarking is the later, harder, moat-ier version.

---

## 4. What NOT to build (same discipline as the strategy docs)

- **Not a practice-management tool** (Karbon's category): no task workflows,
  client portals with e-signatures, or job tracking. The portfolio tier is a
  *reporting* tier. Same rule for the future HR domain: no leave-request
  workflows, no scheduling tool — Clarion reports on the systems that do that.
- **Not driver-based financial modelling / three-way forecasting** — that is
  Fathom's whole product and a different buyer. Clarion's forward view stays
  the operational steering view (G3).
- **Not reverse ETL / data activation** (Weld's category). The Mapping
  primitive and Excel round-trip cover the SMB-shaped version of this need.
- **Not public embeds / an embedding platform.** Tokened read-only share
  links (G6) are the SMB-sized version; iframe embedding is a different
  product with a different security surface.
- **No fourth role or custom-role builder yet.** The policy engine already
  covers data-level restriction; role proliferation before the portfolio
  tier's requirements are known would be guessed design. (But when the HR
  connector is scoped, revisit *default* policies — salary columns should be
  masked by default, not by admin diligence.)

---

## 5. Suggested order (if the owner agrees with the ranking)

1. **Close the push loop** (G1 + the email half of G10): brief → inbox,
   thresholds on pulse entries, immediate threshold alerts. Small, all
   plumbing exists, fully domain-agnostic.
2. **Mobile-respectable pass** (G2) over Home/brief/topic/dashboard + PWA
   manifest, so the push loop lands somewhere usable.
3. **Exception lists + forward view as a generic primitive** (G3), first
   instance AR aging/chase list + cash line — on tables that already exist.
4. **Spreadsheet connector** (G5 — already P1 in the multi-source plan,
   owner-confirmed) then **generic targets** (G4) on top of it.
5. **Share links + server-side PDF report pack** (G6).
6. **NL i18n** (G8) — schedule alongside, not after, the above; retrofitting
   copy extraction only gets more expensive.
7. Quick wins anytime: rail entry for `/investigate`, fold `/gaps` into
   review, fix/replace the onboarding mock (G9, G10).
8. **When the first non-finance connector is scoped** (HR / timesheets /
   ops): pull multi-source P3/P4 forward with it (G16 — identity + query
   un-scoping), ship the domain's template/KPI/pulse content with the
   connector (G11), and revisit default policies for sensitive columns.
   Peppol stays a timeboxed research spike, not a priority.

Items 1–3 together are one coherent release: *"Clarion comes to you."* That is
also the honest answer to the adoption statistics — an SMB tool that requires
opening a laptop to deliver its value will lose to inertia, however good the
engine underneath is. Item 8 is the release that makes the multi-domain
roadmap pay: *"one picture of the whole business"* only becomes literally
true when a question can span two systems.

---

## 6. Corrections to the record (found while auditing)

- The 2026-07-15 assessment's "missing business features" list is partly
  resolved and should not be re-litigated: data policies (row filter + column
  mask) **exist** with UI; audit log UI **exists** (two of them); forecasting
  **exists** in Ask AI; weekly-digest-shaped machinery (pulse + brief)
  **exists** minus delivery; metric alerts remain genuinely missing (the
  `pulseService.ts` promise is still unmet in the threshold sense).
- CLAUDE.md's role table says analysts cannot view definition gaps; the
  `/gaps` surface is orphaned anyway — resolve both together when G10 lands.
- v1.0 of this doc framed G3 as a cash/AR feature, G11 around Peppol, and the
  portfolio tier as accountant-specific. v1.1 (this version) restates all
  three domain-agnostically per the owner's direction; the finance instances
  remain valid as *first* instances because the live connector base is
  finance-shaped.

## 7. External sources consulted

- SMB BI adoption failure data (dashboard-open rates, spreadsheet fallback):
  sranalytics.io BI-dashboard research; Myriade "1 in 5 SMBs use AI for BI".
- Owner daily-metrics literature: CapForge, John Galt Finance ("8 KPIs every
  owner needs daily"), CoreCPAs, ONEBIT — unanimous on cash / revenue pace /
  AR aging as the daily three *for finance-anchored businesses*.
- Category feature baselines: fathomhq.com/features (alerts, three-way
  forecasting, consolidation, benchmarks); Syft Analytics feature summaries
  (portfolio management, cash-flow scenarios, white-label reports, industry
  benchmarks, automated alerts); Peliqan/Weld (all-in-one SMB data platforms,
  spreadsheet sync, connector breadth as the growth axis).
- Push-first BI: Tableau Pulse docs (threshold alerts, email/Slack digests,
  mobile notifications); ThoughtSpot Spotter positioning (AI anomaly
  monitoring).
- Agentic-BI trend base: Gartner via OvalEdge/Tellius 2026 roundups (~40% of
  enterprise apps integrating task-specific agents by end-2026).
- Belgium Peppol mandate: EY Belgium, originstamp, efsta, peppolvalidator —
  B2B structured e-invoicing mandatory 2026-01-01, phased penalties.
- Excel-export demand: Power BI community/practitioner writing on
  export-to-Excel as the dominant business-user request.

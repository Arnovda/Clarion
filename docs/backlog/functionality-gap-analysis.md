# Functionality gap analysis — what a day of using Clarion is missing

**Date:** 2026-08-21 · **Status:** analysis, no code changed · **Companion to:**
`warehouse-value-for-smb.md` (the strategic argument), `multi-source-strategy.md`
(the source-side build plan), the 2026-07-15 product assessment (the launch-killer
audit). This doc asks a different question than all three: *walk through the day,
week and month of each person who uses Clarion — where does the product go silent?*

**Method:** a full inventory of the live feature surface (every route, every
backend service, verified against the code on 2026-08-21 — not against CLAUDE.md,
which turned out to understate what exists), crossed with external research:
what SMB owners actually check daily, what the accounting-analytics category
(Fathom, Syft) ships, what the AI-BI category (Tableau Pulse, ThoughtSpot
Spotter) has made table stakes, and the Belgian market context (Peppol B2B
e-invoicing mandatory since 2026-01-01).

---

## 0. The one-sentence verdict

**Clarion is a strong *pull* product — you go to it, ask, and look — whose
primary user lives in a *push* world: their day starts on a phone, in an inbox,
with the question "am I on track?", and Clarion is not there.** The push
skeleton is 80% built (pulse watchlists, a daily morning brief with AI
narration, dashboard email schedules) but the brief never leaves the app, no
metric has a user-set threshold, and nothing renders on a phone. The second
structural absence: Clarion is entirely **backward-looking** while the SMB
owner's number-one daily concern — cash, receivables, what's coming — is a
**forward** view. Everything else in this doc is smaller than these two.

---

## 1. Who uses this, and what their day actually looks like

Three personas, matched to the three roles. The research base for the owner's
day: SMB-finance practitioner literature converges hard on the same list —
*cash position, revenue pace, AR aging* checked daily ("you should know within
sixty seconds of opening your laptop whether you're on track"), margins and
overdue invoices weekly, plan-vs-actual monthly. Cash-flow problems, not lack
of revenue, are the most-cited SMB killer.

**The owner / manager (viewer).**
- *Daily, ~8am, often on a phone:* is cash OK, are sales on pace, did anything
  weird happen yesterday? Sixty seconds, ideally without opening anything —
  the answer should arrive.
- *Weekly:* who owes me money and who do we chase today; how are margins.
- *Monthly:* how did we do against what we planned; what does the bank/board see.
- *Ad hoc:* "how much did customer X buy from us last year?" mid-phone-call.

**The office power user / analyst.**
- *Daily:* answer the owner's ad-hoc questions; keep an eye on data freshness.
- *Weekly:* maintain dashboards, pull lists into Excel for operational follow-up
  (dunning, ordering), share numbers with colleagues who will never log in.
- *Monthly:* prepare the management figures; reconcile "why does the dashboard
  say X when Exact says Y".

**The admin / consultant / accountant.**
- *Setup:* connect sources, curate semantics, build topics — well covered today.
- *Monthly:* close support, management report packs per client.
- *Structurally:* serves a **portfolio** of SMBs and wants one screen across
  clients — the channel argument already made in `warehouse-value-for-smb.md`
  §2.4; Syft and Fathom both lead their positioning with exactly this.

The pattern that matters: **the owner's loop is daily and push-shaped; the
analyst's loop is weekly and Excel-shaped; the accountant's loop is monthly and
report-pack-shaped.** Clarion currently serves all three only in their *ad hoc,
seated-at-a-desktop* moments.

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
  most SMB tools can't solve without Power BI Premium), tenant-wide audit log
  UI, per-entity change history, MFA/passkeys, GDPR erasure, retention.
- **Trust machinery:** quality profiling with scores/rules/failed-record
  drill-through, column-level lineage, glossary feeding prompts, review queue,
  relationship canvas with measured evidence.

The engine and the governance are not the gap. The gap is where the product
meets the *rhythm* of its users' days.

---

## 3. The gaps, ranked by how often they hurt

### Tier 1 — the daily loop (hurts every day, mostly the owner)

**G1. Metrics never reach out: no user thresholds, no delivered brief, no
digest.**
There is no "tell me when revenue drops below X / receivables over 60 days
exceed Y" anywhere — pulse sensitivity is a hard-coded delta bucket, quality
alerts fire on *data-quality* scores, not business values. The morning brief —
the product's best daily artefact — renders only on `/home` and in the bell,
so it is seen only by people who already opened the app; adoption research is
brutal about that assumption (<30% of licensed users open dashboards weekly).
Meanwhile Tableau Pulse, ThoughtSpot Spotter and both SMB accounting-analytics
leaders (Fathom, Syft) all ship metric-threshold alerts delivered to
email/Slack/mobile as a core loop, with digest frequency per user.
*Why cheap relative to impact:* the watchlist, the daily snapshot job, the
narration, the email transport (ACS/SMTP) and even the `emailed_at` column all
exist. This is wiring, not architecture: (a) email the brief; (b) add an
optional threshold to a pulse entry; (c) let a threshold crossing send
immediately rather than waiting for the morning run.

**G2. No phone. No responsive shell, no PWA, no push.**
The 8am check happens on a phone; the rail is a fixed-width desktop chrome,
there is no manifest, no service worker, no mobile layout for Home/topics/
dashboards. This blocks G1's payoff too — an alert that links to an unusable
page teaches the user to ignore alerts. Scope it honestly: not a native app —
a responsive pass over the four surfaces an owner actually opens from a
notification (Home, the brief, a topic page, a dashboard) plus a PWA manifest.

**G3. The money is backward-looking: no cash-forward view, no AR workflow.**
Everything Clarion shows answers "what happened". The owner's daily question
is "what's coming": cash position, expected in/out, who is late. The category
leaders lead with exactly this (Fathom: three-way forecasts, cash-flow
waterfalls; Syft: cash-flow forecasting with scenarios) — and Clarion already
holds the raw material: `fact_receivables` / `fact_payables` with due dates in
the EO template, bank entries, a working forecast engine. What's missing is a
*surface*: an AR aging view with the standard buckets (current / 30 / 60 /
90+), a "worth chasing today" list (which is also the analyst's #1 weekly
Excel export), and a simple projected cash line (receivables in − payables
out, by week). Deliberately NOT statutory forecasting or driver-based
modelling — that is Fathom's whole product; Clarion needs the daily view, not
the CFO tool.

### Tier 2 — the monthly loop (hurts every month; analyst + accountant)

**G4. No targets, budgets or goals — the product can't say "against plan".**
There is no target entity at all: no table, no CRUD, no UI; the only trace is
the `bullet_chart` widget whose target must be hand-written into SQL by the
AI. "How did we do?" is only answerable against last year, never against what
the owner *decided*. Every management-reporting tool in the category treats
budget-vs-actual as the monthly artefact. Two halves: (a) a small
`targets` entity (metric, period, value, scope) editable in the UI and joined
into dashboards/Ask AI context; (b) budget *import* — which is the next gap.

**G5. Spreadsheets still can't enter the platform** — confirming, from the
demand side, that P1 of `multi-source-strategy.md` (the spreadsheet
connector) is the right first build. Budgets live in Excel. So do the
satellite lists (C1–C10 in that doc). Until a spreadsheet can be a source,
G4 has no data and the "single reconciled picture" claim has a visible hole
the customer meets in week one.

**G6. Reports can't leave the tenant: no share links, no server-side PDF, no
report pack.**
The monthly output of the accountant persona is a *document sent to someone
who will never log in* — the bank, the board, the client. Today: PDF export is
client-side (html2canvas of whatever screen you're on), sharing is
tenant-internal only (`is_shared` within the team; zero external-link, token
or embed machinery). Email schedules render data tables, not the branded
monthly pack Syft/Fathom made the category standard. Minimum: a read-only
share link (tokened, revocable, optionally expiring) for a dashboard; a
server-rendered PDF of dashboard + narration ("Story" already writes the
narrative). The accountant tier (G12) multiplies this gap's value later.

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
This is also the cheapest *category* differentiator against the US tools.
(Open question for the owner: does AI output — briefs, answers, narration —
also need to be NL? Probably yes, and that's a prompt-level change, so the
i18n pass should decide both together.)

**G9. The first fifteen minutes are still the weakest surface.**
Re-confirming the 2026-07-15 P0 that hasn't moved: `/onboarding` is an unwired
mock advertising connectors that don't exist (Snowflake, BigQuery, CSV);
register lands on `/sources`; the real funnel is a series of technical
decisions. The Build front door (2026-08-18) fixed the *middle* of the funnel;
the entry is still raw. Cheapest first step: delete or rewrite the mock so it
routes through the real flow (Sources → sync → Build) with the two real
connectors, and honest copy about what comes next.

**G10. Built-but-buried features — free wins.**
- `/investigate` is a flagship-grade differentiator with zero inbound links.
  Put it in the rail (Uncover), or surface "Investigate this" more
  aggressively from answers and widgets.
- `/gaps` (definition gaps with hit tracking) is orphaned; it's the curator's
  feedback loop and belongs as a facet of the review/suggestions surface.
- Morning-brief email (see G1) — the column already exists.

**G11. Two connectors, and a market event that changes the priority list:
Peppol.**
Since 2026-01-01 every Belgian B2B invoice is a structured UBL document on the
Peppol network (phased penalties from Q2). Strategically this means every
Belgian SMB now *has* a machine-readable invoice stream regardless of which
ERP they run. A Peppol/UBL connector (or at minimum UBL-file ingestion via the
G5 spreadsheet/file connector) is: (a) a universal second source that doesn't
depend on per-vendor API work (the exact bottleneck named in
`multi-source-strategy.md` P7); (b) a reconciliation feature ("invoices on the
network vs invoices in your books") — which `warehouse-value-for-smb.md` §2.6
already argues is a paying feature; (c) a timely marketing hook. Worth a
research spike before committing — access routes to Peppol data (via access
point providers) need validating.

**G12. The accountant portfolio tier — the channel is designed but not
started.** Already argued in `warehouse-value-for-smb.md` §2.4; external
evidence says the whole SMB-analytics category (Syft, Fathom) is *sold*
through this persona ("multi-client portfolio management" is their headline,
not a feature). Not urgent while single-tenant gaps above exist — but every
tier-2 build (report packs, targets) should be designed *aware* that a
cross-client tier will sit above it, per the §7 warning about retrofitting.

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
  client portals with e-signatures, or job tracking. The accountant tier is a
  *reporting* tier.
- **Not driver-based financial modelling / three-way forecasting** — that is
  Fathom's whole product and a different buyer. Clarion's forward view stays
  the operational cash/AR view (G3).
- **Not reverse ETL / data activation** (Weld's category). The Mapping
  primitive and Excel round-trip cover the SMB-shaped version of this need.
- **Not public embeds / an embedding platform.** Tokened read-only share
  links (G6) are the SMB-sized version; iframe embedding is a different
  product with a different security surface.
- **No fourth role or custom-role builder yet.** The policy engine already
  covers data-level restriction; role proliferation before the accountant
  tier's requirements are known would be guessed design.

---

## 5. Suggested order (if the owner agrees with the ranking)

1. **Close the push loop** (G1 + the email half of G10): brief → inbox,
   thresholds on pulse entries, immediate threshold alerts. Small, all
   plumbing exists.
2. **Mobile-respectable pass** (G2) over Home/brief/topic/dashboard + PWA
   manifest, so the push loop lands somewhere usable.
3. **AR aging + chase list + simple cash-forward line** (G3) — the owner-side
   payoff, built on tables that already exist.
4. **Spreadsheet connector** (G5 — already P1 in the multi-source plan) then
   **targets + budget-vs-actual** (G4) on top of it.
5. **Share links + server-side PDF report pack** (G6).
6. **NL i18n** (G8) — schedule alongside, not after, the above; retrofitting
   copy extraction only gets more expensive.
7. Quick wins anytime: rail entry for `/investigate`, fold `/gaps` into
   review, fix/replace the onboarding mock (G9, G10).
8. **Peppol research spike** (G11) — timeboxed, before connector P7 work.

Items 1–3 together are one coherent release: *"Clarion comes to you."* That is
also the honest answer to the adoption statistics — an SMB tool that requires
opening a laptop to deliver its value will lose to inertia, however good the
engine underneath is.

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

## 7. External sources consulted

- SMB BI adoption failure data (dashboard-open rates, spreadsheet fallback):
  sranalytics.io BI-dashboard research; Myriade "1 in 5 SMBs use AI for BI".
- Owner daily-metrics literature: CapForge, John Galt Finance ("8 KPIs every
  owner needs daily"), CoreCPAs, ONEBIT — unanimous on cash / revenue pace /
  AR aging as the daily three.
- Category feature baselines: fathomhq.com/features (alerts, three-way
  forecasting, consolidation, benchmarks); Syft Analytics feature summaries
  (portfolio management, cash-flow scenarios, white-label reports, industry
  benchmarks, automated alerts).
- Push-first BI: Tableau Pulse docs (threshold alerts, email/Slack digests,
  mobile notifications); ThoughtSpot Spotter positioning (AI anomaly
  monitoring).
- Agentic-BI trend base: Gartner via OvalEdge/Tellius 2026 roundups (~40% of
  enterprise apps integrating task-specific agents by end-2026).
- Belgium Peppol mandate: EY Belgium, originstamp, efsta, peppolvalidator —
  B2B structured e-invoicing mandatory 2026-01-01, phased penalties.
- Excel-export demand: Power BI community/practitioner writing on
  export-to-Excel as the dominant business-user request.

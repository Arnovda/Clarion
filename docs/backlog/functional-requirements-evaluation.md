# Functional requirements evaluation — the promise, the requirements it implies, and what the code actually does

**Date:** 2026-09-06 · **Tree audited:** `f18adc9` (branch `claude/clarion-requirements-evaluation-af09tf`, wave C complete) · **Method:** the promise was taken from Clarion's own words (the product overview, the app blueprint, the draft terms, the sign-in screen); the requirements were derived from that promise and from the three personas' daily loops; every requirement was then checked against the code by six parallel investigations, each claim carrying `file:line`, and the load-bearing claims were re-verified by hand. Where an investigator's claim did not survive re-verification it is not in this document (one such claim is recorded in §8).

This document does not replace `market-readiness-assessment-v2.md` (the platform around the product: isolation, ops, legal — its waves A, B and C are done) or `functionality-gap-analysis.md` (2026-08-21, the daily-loop gaps). It sits above both: it asks whether the **product** does what Clarion **says** it does, requirement by requirement, on the code as it stands today — three weeks and a hundred commits after the gap analysis.

---

## 0. Verdict in five sentences

**Clarion's engine is real and, on its core path, better than the promise: a plain-language question on the product layer runs through a verified fast path, streaming generation, a safety gate, a compile-error self-heal, data policies, per-answer freshness and a plain-English answer — with two model calls and a categorical trust mark a viewer can read.** Around that path, the product overview makes **seventeen promises, of which six are true, six are half-true and five are not true in the code** — cross-source questions, KPI threshold alerts, actuals-versus-budget, one-click board packs and white-label do not exist, and "under five seconds" has never been measured. **The first fifteen minutes are the weakest part**: a new customer must register their own OAuth application with Exact Online or Microsoft before step three of the wizard, is landed on an empty catalog after saving, must tick entities from an empty list, and needs nine to ten discrete actions across three manual navigations to reach a first answer. **The audits also found seven defects in shipped behaviour** — the most visible being that Home has shown "No dashboards yet" to every tenant since the viewer home shipped, because it queries a column the dashboards table does not have. **The right move is not a new wave of features: it is (a) make the promise and the product agree, in both directions, (b) fix the seven defects and the role table, and (c) build the four things that turn a good pull product into one that arrives — thresholds, delivered briefs, share links, and a phone-usable Home — before touching multi-source, which is the largest and least urgent of the unmet promises.**

---

## 1. The goal, and the promise as Clarion states it

### 1.1 The goal in one sentence

From `docs/APP_BLUEPRINT.md §1`: *connect your business systems, let AI describe and model the data, then ask questions and build reports in plain language — correcting meaning by talking to the AI, never by writing SQL.* The spine is **Connect → Understand → Ask → Trust**, and the default persona is *a non-technical business data-owner who is in charge of their data through business knowledge; everything technical is available but never in their way.*

`PROJECT_PLAN.md` narrows the market: **production-ready SaaS for companies with 20–200 employees**; the overview widens it to 10–500. The three personas (`functionality-gap-analysis.md §1`): the **owner** whose loop is daily and push-shaped, the **analyst** whose loop is weekly and Excel-shaped, the **admin/consultant** whose loop is monthly and report-pack-shaped.

### 1.2 The promise, as written in `clarion-overview.html`

This file is the product's own pitch. Each line below is a claim it makes, numbered so §4 can grade it.

| # | The promise (paraphrased from the overview) |
|---|---|
| P1 | Any business user types a question **in Dutch or English** and gets a clear, accurate answer **with a chart, in under five seconds, no training required** |
| P2 | Describe a dashboard in a sentence; it is designed and rendered **in under 30 seconds** with filters, drill-down, date ranges and KPI cards; **saved, shared and exported** |
| P3 | Any dashboard scheduled as an HTML email — daily, weekly, monthly — **with an AI-written executive summary** |
| P4 | **Continuous quality monitoring** with alerts carrying plain-language business context |
| P5 | Click any metric for the rows behind it; click **Investigate** for a root-cause explanation in seconds |
| P6 | A star-schema warehouse designed by AI and materialised for speed |
| P7 | **Multi-source questions** — connect accounting, CRM and operations and ask questions that **span all of them**, joined through a knowledge graph |
| P8 | Three roles; column masking and row filtering per user |
| P9 | **Setup under an hour**; the data team reviews and approves definitions **in about 20 minutes**; sources: PostgreSQL, MySQL, SQL Server, SQLite, Exact Online "and more" |
| P10 | **Threshold alerts**: *"Notify me when any product's stock coverage drops below 2 weeks"* → an email the moment it is crossed |
| P11 | **Actuals vs budget**; *"which of my reps is underperforming vs target"* |
| P12 | Monday-morning CFO email with a weekly summary; **board packs generated in one click** |
| P13 | Ranked customer table **with a trend sparkline per row**, the sharpest decliners identified, drill to invoices |
| P14 | **Cash-flow forecasting** |
| P15 | Never expose SQL to a business user; queries under 70 % confidence blocked and logged |
| P16 | **Multi-tenant / white-label** |
| P17 | **"Data stays in your environment"** (in the comparison table) |

Two more promises live elsewhere and bind just as much: the sign-in screen's *EU-hosted · AES-256 · GDPR erasure built in* (`frontend/components/layout/AuthLayout.tsx:126`), and the draft terms' *"you and your team explore that data through dashboards, reports and questions asked in plain language"* (`frontend/lib/legal/terms.ts:24-28`).

### 1.3 What "blow users out of the water" has to mean

For this market the bar is not feature count — Power BI has more features than any SMB will use. The bar, taken from the personas and the competitive doc, is four experiences:

1. **Time-to-first-true-answer on my own data measured in minutes, not a project.** The overview says an hour.
2. **The answer is right, says how sure it is in words, and tells me when it is not.** This is the trust layer, and it is where Clarion is genuinely ahead.
3. **The product comes to me.** The owner's day starts on a phone with "are we on track" — a brief, a threshold, an exception list. The overview promises exactly this (P3, P10, P12).
4. **It gets better because I use it.** Corrections, verified questions and glossary terms compound into a semantic layer that no competitor has for this customer.

Everything in §3 is graded against those four, not against a generic BI checklist.

---

## 2. Scale of what exists today (measured)

| | |
|---|---|
| Backend routes / services / migrations | 53 route files · 71 services · 96 migrations |
| Backend LOC (non-test) / frontend LOC | 83.7 k / 72.9 k |
| Frontend pages | 47 (`page.tsx`), of which 3 orphaned and 4 redirect stubs (§3.H5) |
| Connectors (registry) | Exact Online, Odoo, Excel, SharePoint (+ shared spreadsheet core); direct DB via the legacy path: Postgres, MySQL, SQL Server, SQLite |
| AI prompts | 26 |
| Tests | 62 backend suites + 11 colocated · 5 frontend files · 5 e2e specs |

---

## 3. Requirements and their status

Status vocabulary: **BUILT** (does what the requirement says) · **PARTIAL** (exists with a material gap) · **ABSENT** (nothing) · **BROKEN** (exists and behaves wrongly). Evidence is `file:line` on the audited tree.

### A. Connect — get data in, in an hour

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| A1 | Breadth: the systems an SMB actually runs | PARTIAL | Registry `packages/connectors/src/index.ts:88-91` (excel, exactonline, odoo, sharepoint); legacy `backend/src/connectors/ConnectorFactory.ts:104` (sqlite, postgres, mysql, sqlserver) | **No CSV upload, no Google Sheets** — both are `available:false` tiles with `formFields: []` and no backing code (`frontend/app/sources/page.tsx:182-199`); `.xls`/`.xlsb`/password-protected refused (`excel/ExcelConnector.ts:251-255`); netsuite/quickbooks are commented-out stubs (`index.ts:92-94`) |
| A2 | A customer connects Exact Online / Microsoft by signing in, not by registering an app | **ABSENT** | `preAuthFields: ['clientId','clientSecret',…]` (`exactonline/oauth.ts:159`, `sharepoint/oauth.ts:232`); schema copy says "from **your** ExactOnline app registration" (`exactonline/schema.ts:22,28`); no platform client id in `backend/src` or `.env.example` | **The largest onboarding cliff in the product.** Every tenant must create their own OAuth app in Exact's developer portal or Entra — days of customer-side work before step 3 of the wizard. P9's "under an hour" is not reachable through this door |
| A3 | A guided first run: connect → sync → analyse → build → ask, without the user knowing the order | PARTIAL | Per-card hints `sources/page.tsx:861-874`; build page points back to `/sources` (`build/page.tsx:393-394`); finish card → `/query?q=…&autoSubmit=1` (`build/page.tsx:756-759`) | Every hop is a manual click **and** a manual navigation. The wizard saves and pushes to `/catalog` (`add-source/page.tsx:367`) — guaranteed empty because nothing has synced; the one thing to do next (Sync now) lives back on `/sources`. `/onboarding` (606 lines, fake tables, simulated scan) is linked from nowhere (`onboarding/page.tsx:14-15`) |
| A4 | Sensible defaults when choosing what to sync | ABSENT | `add-source/page.tsx:122` starts with an empty `Set`; save blocked until ≥1 ticked (`:350`, `:1153`) | No recommended set although every connector ships categories; only a per-category Select all (`:1067`) |
| A5 | Sync: manual, scheduled, full re-sync, honest partial status, failure notice, staleness watch | PARTIAL | Manual `connections.ts:322-356`; cron `connectionSyncSchedules.ts:88`; full re-sync `:335`; partial `SyncOrchestrator.ts:548-574`; failure notify `:755-770`; freshness sweep `jobs/freshnessMonitor.ts:83-123` | Cron is a raw five-field text box (`sources/page.tsx:1057-1132`); **direct-DB sources cannot be scheduled at all** (`connectionSyncSchedules.ts:117-119`) and, because the freshness monitor iterates schedules (`freshnessMonitor.ts:86`), can never be reported stale |
| A6 | Lifecycle: edit, re-authorise, delete (with cleanup), cap | BUILT | Edit `connections.ts:429,497`; re-auth `:552` + button `sources/page.tsx:1699`; delete cascades and resolves warehouse URIs before the FK cascade (`connections.ts:1031-1140`, worth keeping as the reference pattern); cap `tenantLimits.ts:102-111` | Delete confirms nothing about what will be destroyed |
| A7 | Direct-database sources get the same treatment as API sources | PARTIAL | Both reach `SchemaProfiler` (quality `:492-500`) | Two connector frameworks. Direct DB gets no entity selection, no sync runs, no schedule, no cancellation, no vendor docs; legacy connectors introspect **foreign keys only** (`PostgresConnector.ts:158`) — the business key is a name-shape guess (`BaseConnector.ts:217-241`) even though the real primary key is one query away |
| A8 | Try it before connecting (sample dataset) | ABSENT | "Try sample" pre-opens the SQLite form (`sources/page.tsx:2404-2407`) | No hosted sample tenant; a prospect cannot see an answer before doing A2 |
| A9 | Auto-catalog after first sync | BUILT | Structural (free) profile on first sync (`SyncOrchestrator.ts:970-1019`), AI Analyse behind a click | Schema drift only notifies (`:1116-1124`) |

**Time to first answer, measured on the shortest connector (Excel):** register → tile → upload → test → tick entities → save → *(land on empty catalog)* → back to Sources → Sync now → go to Ask → pick source, type, submit. **Nine to ten actions, three of them navigations the product should perform itself.**

### B. Understand — AI describes and models, a human confirms in twenty minutes

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| B1 | AI definitions with vendor documentation first; human edits survive a re-analyse | BUILT | Precedence `SchemaProfiler.ts:795-822`; snapshot-and-merge `:846-912` | Snapshot is best-effort — a failed read silently re-profiles without preservation (`:915-917`) |
| B2 | A review queue ("Suggestions") the curator can clear in twenty minutes | BUILT | `routes/semantic.ts:2077`; `app/review/page.tsx:32`; rail entry with badge `IconRail.tsx:126` | Source layer only — no product-layer drafts; relationship reject is a hard DELETE (`review/page.tsx:69-77`) |
| B3 | One catalog where any role can read what a thing means and see sample rows | PARTIAL | `catalog/page.tsx:944` allows all three roles; product samples any role (`semantic.ts:1953`) | **Source-table sample rows call an admin-only endpoint** (`semantic.ts:1032`, used at `TableDetailPanel.tsx:404`) → analysts and viewers get a 403 as UX; the rail hides `/catalog` from viewers (`IconRail.tsx:115`) so they reach it only by deep link or ⌘K |
| B4 | Subjects speak the business's language: questions and plain summaries written by AI, editable by talking | PARTIAL | Topic layer `topics/[productId]/page.tsx:52-55`; `question_text` fallback `routes/products/topic.ts:106-110` | **Nothing AI-writes `question_text` or `plain_summary`** — both are hand-typed (`products/kpis.ts:177`, `products/tables.ts:54-58`), so the topic page usually shows raw KPI names (`topic.ts:108 derived:true`). The blueprint's *"Ask AI to change it"* (§6.2, wave 4) does not exist |
| B5 | Build: plan from a template, create, extend by one subject, warned rebuild, hide/show | PARTIAL | Template first `busMatrixOrchestrator.ts:247-260`; extend `build.ts:337`; warning `build/page.tsx:498-521` | **Rebuild destroys product-level human edits**: retire-and-replace deletes `data_products` and cascades tables/KPIs (`busMatrixBuilder.ts:441-447`) with no snapshot. The profiler preserves curation; the builder does not — two halves of one promise built to opposite standards |
| B6 | Relationships: measured, flagged, source-laid vs manual, cross-source matches | BUILT | Measure `relationships.ts:162`; flag `:489`; match-preview `:269`; provenance `components/relationships/provenance.ts` | AI context excludes only **flagged** edges (`semanticGraph.ts:486`); unconfirmed AI drafts still reach the model — the confirmed-only flip is still owed |
| B7 | Glossary injected into every prompt | BUILT | CRUD `semantic.ts:955-1017`; injected `nlToSqlPrompt.ts:64`, `nlToSqlPromptDuckDB.ts:39` | Glossary terms are not surfaced in Ask AI's own UI |
| B8 | Quality: profile, rules, alerts with business context | BUILT | `quality.ts:967,655`; AI context `:448/489/546` | Score thresholds are hard-coded constants (`quality.ts:425-484`); rule writes admin-only while evaluation is analyst-allowed (`:931` vs `:1128`) |
| B9 | Your own tables (grids) for mappings and budgets, joinable in answers | PARTIAL | `managedGrids.ts:148,263,314,370`; registered in every product session (`ConnectorFactory.ts:166-167`) | **No viewer read** (every route analyst+, `managedGrids.ts:135`); **notebooks cannot see grids** (`notebooks.ts:58-63` registers product tables only) — a budget cannot be joined to actuals in Python |
| B10 | Lineage: where a number comes from, column by column | PARTIAL | Derived at build `lineageDerivation.ts:31-70`; endpoint `lineage.ts:70`; graph `LineageGraph.tsx:110` | No product→product hop (`lineage.ts:190-235` resolves upstream names against `source_tables` only) |
| B11 | Freshness visible wherever a number is | PARTIAL | Topic "last refreshed" `build.ts:118`; viewer home line `ViewerHome.tsx:40-44`; per-answer `query.ts:293-349` | No shell-wide stale banner; direct-DB sources never stale (A5) |
| B12 | Multi-source: a second system maps onto the dims the first created; a question can span both (P7) | **ABSENT** | Query scope is one `connectionId` (`schemas.ts:279-291`, `query.ts:391,1290`); the only cross path is SQLite-only `ATTACH` on the ghost `POST /query` (`query.ts:806-925`) reading `cross_view_relationships` that **no live UI can create** (`IntegrationsPanel.tsx` imported nowhere); canvas `kind='match'` edges reach only re-suggest (`matchAssertions.ts:85`), never query context; no crosswalk/party entity; **the ten-name conformed-dimension list from `warehouse-value-for-smb.md §5.8` is implemented nowhere** | The one promise in P7 that is structurally untrue. Two competing, disconnected cross-source models exist |

### C. Ask — the conversational core

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| C1 | Plain-language question → answer + chart + explanation | BUILT | `/think` `query.ts:1549-1576`; chart shape `chartShape.ts:210` | `POST /query` (used by the dashboard chat) never returns a visualisation (`query.ts:557-574`) |
| C2 | Follow-ups, and a worksheet where a question is a step in a tree | BUILT | `loadStepAncestorHistory` `query.ts:248-273`; `StepSpine.tsx:54-208`; migration `20260828000084` | History disables the cache (`query.ts:437`); collapse state session-local |
| C3 | Trust in words, refusal under 0.70 with a gap logged, a verified-by-your-team tier, "data as of", assumptions as controls (P15) | BUILT on `/think` | Trust line `MessageBubble.tsx:1210-1240`; gate `shouldBlockQuery` `query.ts:98-115`; verified `savedQuestions.ts:48-70` + `query.ts:1327-1395`; sources `:293-349`; chips `AssumptionChips.tsx:42-70` | Verified lookup, sources and self-heal exist **only on `/think`** (C11); `ConfidenceBadge` renders a raw `%` and is safe only because every call site gates it (`components.tsx:104-113`) |
| C4 | Self-correction: repair on a suspicious result, self-heal on a compile error, retry on overload, a Stop that stops | BUILT | Repair `query.ts:1958-2272`; self-heal `sqlSelfHeal.ts:122-175`; retry `AIService.ts:624-645`; abort `sse.ts:23-41` | `callClaudeMultiTurn` has **no retry** (`AIService.ts:737-756`) — every repair turn is one-shot |
| C5 | Dutch or English (P1) | PARTIAL | Prompts mirror the question's language (`nlToSqlPrompt.ts:57-60,394-405`) | Prompt-level only, no test; **French absent** from every trigger list; UI English-only (H1) |
| C6 | The default layer for business users gets the same entity check as the source layer ("did you mean…") | **ABSENT on product layer** | Pre-flight runs at `query.ts:1063-1190` and `:1793-1862`, source layer only | A misspelled customer on the product layer — the layer every viewer uses — yields an empty or wrong answer instead of a suggestion |
| C7 | Investigate and forecast triggered reliably (P5, P14) | PARTIAL | Client regexes `frontend/lib/questionMode.ts:29-56`; forecast substrings `page.tsx:1247-1256` | `includes('expect')` fires on "expected delivery"; self-described "~80 % accurate"; no server-side intent; French absent |
| C8 | Answers go somewhere: save, pin, schedule, export, **share** | PARTIAL | Save `MessageBubble.tsx:1647`; pin `:1738`; CSV/XLSX `:1157`; schedule from a saved question `EmptyState.tsx:135-151` | **No share-a-link** for an answer (zero permalink code in `frontend/app/query/`, no share route) — the analyst's "send this to a colleague who never logs in" loop has no door |
| C9 | The same question twice costs no model call | PARTIAL | `queryCache.ts:51-60` used at `query.ts:440,949` | **Only on the ghost `POST /query`**; `/think` never touches the cache — its only no-model path is a verified saved question |
| C10 | Viewers cannot reach the raw source layer (P15, blueprint §4 "off by default") | **BROKEN at the API** | UI gate `page.tsx:1649-1658` | Backend honours `dataLayer:'source'` from any role (`query.ts:1399`, `schemas.ts:285`) — a viewer's raw POST reaches source tables, bypassing the product layer's curated view |
| C11 | Every query route carries the same guard, policy, self-heal and freshness | **BROKEN (uneven)** | Guards: `POST /` via `shouldBlockQuery`, `/forecast` `:2546`, `/think` `:1480` | **`/cross-view` runs model SQL through `ATTACH`ed SQLite with no `assertSafeReadQuery`** (`query.ts:2407-2413`; policies applied, guard absent). Practically unreachable (B12) — which is the argument for deleting it, not for leaving it |
| C12 | "Under five seconds" (P1) | **UNMEASURED** | Per-call durations exist in `ai_call_log` (`aiUsage.ts:280`); per-tenant request p95 on `/admin/tenants` | Nothing reports time-to-answer per question. The happy path is one Sonnet call with an 8k thinking budget plus one Haiku call (`AIService.ts:249,1536-1540,1610`) — five seconds is unlikely for the streaming path, and the product promises it |
| C13 | Accuracy is measured (a golden set, an eval harness) | ABSENT | `tests/ask-surfaces-smoke.test.ts:19-25` says outright it does not catch wrong SQL; no eval/golden anywhere | Confidence is self-reported by the model and never validated. Wave C item 4 (8-3) was dropped by the owner; the gap stands |
| C14 | Suggested questions come from the tenant's data | BUILT | `queryStartersService.ts:33-57`; "Since yesterday" from the brief | English fallback starters when no product exists; cache process-local |

### D. See — dashboards, reports, home, mobile

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| D1 | Describe → questions → generate; refine by chat with tiered and per-card edits; arrange; filters with a private saved view; cross-filter; drill (P2, P5) | BUILT | `dashboards.ts:365,298,526,620-653,1713,2205,1468`; `react-grid-layout` `page.tsx:5,84-135` | Opening a dashboard costs zero AI calls — kept, and correct |
| D2 | Insights on demand; narrative story | BUILT | `/insights` `dashboards.ts:2869`; `/narrate` `:2687`; `StoryModal.tsx:59` | PDF is a client print window |
| D3 | Export (P2) | PARTIAL | Per-widget CSV/XLSX `:2434,2470`; whole-dashboard XLSX `:2506` | No whole-dashboard PDF beyond the story; no whole-dashboard CSV |
| D4 | Sharing (P2): with the team, with named people, externally, embedded | PARTIAL | `is_shared` boolean, tenant-wide (`dashboards.ts:2274,2302`) | `shared_permission='editor'` is stored and rendered (`page.tsx:2347`) but **never read** — PATCH is owner-only (`:2278`), the UI forks a copy (`:723`); **no external link, no embed** |
| D5 | Templates / gallery | PARTIAL | Routes `:1969-2044`; table `20260403000026` | No seeded templates; `preview_image` never written |
| D6 | Targets: actuals vs budget, rep vs target (P11) | **ABSENT** | Only `bullet_chart` carries `target` (`widgetContracts.ts:36`); no target column anywhere in 96 migrations; `KpiCard.tsx:18-21` has delta only | The workaround is a `kind='budget'` grid unlinked to any KPI (`migrations/…081:99`) |
| D7 | Ranked table with a sparkline per row, decliners called out (P13) | PARTIAL | Sparkline on KPI cards (`Sparkline.tsx`); `top_list` widget | No per-row sparkline in tables; no "sharpest decline" detection |
| D8 | Reports and the one-click board pack (P12) | **ABSENT** | `routes/reports.ts:17` is a one-shot KPI narrative with **no frontend caller** (no `app/reports`); "report" today = the scheduled dashboard email (`reportEmailService.ts`) | No report pack, no server-rendered PDF, no per-stakeholder pack |
| D9 | Chart vocabulary | BUILT | 14 types `widgetContracts.ts:22-37`; Recharts + ECharts (scatter, bullet); the `/dev/widgets` render gate | No map, no small multiples, **no dark mode** |
| D10 | Fast: cache, batch, rollups, windowing | BUILT | `widgetCache`; batch `:1040,1183`; rollups **registered** `ConnectorFactory.ts:188-194`; `useWindowedRows.ts:29` | — |
| D11 | Home: "what needs me + what I was doing", two shapes by role | **BROKEN in one section** | Role split `home/page.tsx:121`; `ViewerHome.tsx` | **`routes/home.ts:206-209` orders and selects `dashboards.starred`, a column that does not exist** (`is_favorite`, `migrations/20260329000008:11`); the error is swallowed (`:216`) → "No dashboards yet" for every tenant, both homes, and no Home test exists to catch it. Also `home.ts:25` sends the same payload to every role; only the client hides operator items |
| D12 | Works on a phone (P3/P10 land there) | **ABSENT** | `dashboards/page.tsx` has zero `md:`/`lg:` breakpoints; `AppShell.tsx:41` renders the rail unconditionally; no manifest, no viewport export in `app/layout.tsx:38` | Desktop-only. The push loop (E) has nowhere usable to land |

### E. Push — the product comes to you

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| E1 | A morning brief that arrives (P12) | PARTIAL | Job `morningBriefJob.ts:21` (06:00); `routes/briefs.ts:21`; card on both homes | **Never emailed** — `morning_briefs.emailed_at` is written nowhere (`migrations/…048:66`, read only at `morningBriefService.ts:421`). In-app only |
| E2 | Scheduled dashboard / question emails with an AI summary (P3) | BUILT | `emailSchedules.ts:72`; `reportEmailService.ts:155,340`; unattended reads get every policy (`:243-246`) | Recipients validated as non-empty only (`emailSchedules.ts:87`) — no address check, no tenant-membership check; **no unsubscribe, no `List-Unsubscribe`, no bounce handling** (`emailService.ts:93-96`) |
| E3 | User-set thresholds on a metric (P10) | **ABSENT** | Only `pass_threshold` on quality rules (`migrations/…010:51-52`) and pulse `sensitivity` (`…047:51-54`) which **no code reads to fire anything** (`pulseService.ts:5-6` claims it does) | *"Notify me when stock coverage drops below 2 weeks"* cannot be expressed |
| E4 | Quality alerts with business context (P4) | BUILT in-app | `quality.ts:448-546` | Not emailed |
| E5 | Notifications by email / digest / preferences | ABSENT | `notificationService.ts` never calls `sendEmail`; eight event types, all in-app | — |
| E6 | Exception lists and a forward view (who owes me, what is late, cash line) | ABSENT | No primitive (`grep exception|overdue|aging|runway` → prompt prose only); `forecastEngine.ts` not surfaced on Home | The gap analysis's G3, unchanged |
| E7 | Cash-flow forecasting (P14) | PARTIAL | Forecast in Ask via keyword trigger (C7) | Not on Home, not on dashboards, not scheduled |

### F. Govern — roles, policies, audit, GDPR, AI governance

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| F1 | One role model, documented and enforced the same everywhere | **BROKEN** | `frontend/lib/role.ts:33-66` vs the role table in `CLAUDE.md` | Six discrepancies: analyst can PUT but not POST a product (`products/core.ts:345` vs `:26`); two bus-matrix entry points with different gates (`build.ts:337…579` vs `:662,782`); **Sources page admits analysts (`sources/page.tsx:2471`) while every connection route is admin-only (`connections.ts:41,56,285,429`) — guaranteed 403s**; `/catalog` allows viewers but the rail hides it; profiling analyst-allowed vs doc; product-table PATCH admin-only so an analyst in Manage mode cannot save the summary the UI offers (`products/tables.ts:54`). Plus an undocumented fourth axis, `operatorOnly` (`IconRail.tsx:124`) |
| F2 | Identity: password, MFA, passkeys, backup codes, verification, invites, logout-all, support-session limits | BUILT | `auth.ts:70-1161`; `mfaService.ts`; `webauthnService.ts`; `refuseDuringSupportSession` | **No SSO** (zero hits for oidc/saml/entra/msal) — the 20–200-seat customer with Microsoft 365 will ask on day one; **no org-wide MFA policy** |
| F3 | Row filters and column masks on every read path (P8) | PARTIAL | `readPolicy.ts:53,60` applied on dashboards, notebooks, query, reports, add-in, investigate, emails, briefs | **`GET /semantic/product-preview` is `requireAuth` only and applies no policy** (`semantic.ts:1953-2013`) — a viewer reads unmasked rows of any product table; five more raw-value paths are analyst+ but unpoliced: `/semantic/preview` (`:1062`), grid `link-values` (`managedGrids.ts:343`), relationship measure/values (`relationshipMeasure.ts:340`, `columnValues.ts:194`), quality profiling samples (`quality.ts:303-371`), notebook cells (`products/cells.ts:199`) |
| F4 | Audit trail with auth events, export, retention | BUILT | 14 `recordAuthEvent` sites in `auth.ts`; CSV `users.ts:572`; retention `retention.ts:43` | — |
| F5 | GDPR self-service: export, delete workspace, erase a person | PARTIAL | Export ZIP `users/page.tsx:348-375` → `settings.ts:153` | **`POST /settings/delete-tenant` and `DELETE /users/:id` have no button** (zero frontend callers); "GDPR erasure built in" on the sign-in screen is true of the API, not of the product |
| F6 | AI governance: budgets, routing, off switch, usage | BUILT | `aiBudget.ts`, `tenantAiMode.ts`, `/admin/ai-usage` | — |
| F7 | Legal acceptance recorded per version | BUILT (engineering) | `services/legal.ts`; migration 94 | Not in force — counsel's step |

### G. Collaborate and integrate

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| G1 | Comments, mentions, activity | ABSENT | Only one-way thumbs (`conversations.ts:328-362`) | — |
| G2 | Saved questions with a verified tier | BUILT | `savedQuestions.ts:46-116` | — |
| G3 | Excel: refreshable results in a sheet | BUILT (thin) | `excel-addin/manifest.xml:46`; `routes/addin.ts:46-70` | Read-only, saved questions only, no refresh, no parameters |
| G4 | Public API / MCP / webhooks | ABSENT | Token auth mounted only at `/api/addin` (`index.ts:320`); MCP named as future in `addin.ts:12` | Deliberate narrowness; still the door an agent-era buyer will ask for |
| G5 | Notebooks for analysts | BUILT | Pyodide `usePyodide.ts`; diff proposals `notebooks/[id]/page.tsx:332` | Cannot see grids (B9) |
| G6 | Portfolio tier / white-label for the consultant channel (P16) | ABSENT | Operator console `/admin/tenants` is Clarion's, not a customer's | "White-label" in the overview has nothing behind it |

### H. Product quality — the things that make it feel finished

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| H1 | NL/FR UI for a Belgian market | ABSENT | No i18n dependency; no `users.locale`; `en-GB` ~30×, `nl-BE` in `query/utils.ts:59-70`, `en-US` in `SourceCard.tsx:30` | Three locales in one product; PR #114's i18n slice is closed unmerged and remains the restart point |
| H2 | Help, support, changelog, status in-product | ABSENT | `HelpTooltip.tsx` used in 2 files; no support link, no changelog | Blueprint §6.1 "every page self-explains" is unmet |
| H3 | Accessibility | PARTIAL | Good: `StepSpine.tsx:101-106`, `ui/Modal.tsx:33-56` | `DrillDetailModal.tsx:24-26` has no `role="dialog"`/focus trap; no focus return in sampled dialogs |
| H4 | Plain-language errors, no dead ends | PARTIAL | 9-1 error/404 pages; connector errors redacted | The wizard dead-end (A3) and the 403-as-UX cases (B3, F1) remain |
| H5 | No dead doors | PARTIAL | Orphans: `/gaps`, `/onboarding`, `/security`; redirect stubs `/ask`, `/semantic`, `/health`, `/glossary`; 10 components imported nowhere (`IntegrationsPanel`, `JobProgressBanner`, `SchedulePanel`, `PageWrapper`, `PageHeader`, `DatabaseTree`, `AuditPanel`, `PathFinderPanel`, `KpiPanel`, `BulkImportModal`); `SourceSelector` dead (`query/components.tsx:29`); `POST /query` a 900-line path whose only caller discards all but `answer`; `/api/jobs` and `/api/catalog` have no live callers | Each dead door is a place where the next change lands wrong |
| H6 | Tests where the product is | PARTIAL | 62 suites; strongest on auth/dashboards/users/connections | **Twelve routers with zero tests** incl. `/api/home`, `/api/quality`, `/api/pipelines`, `/api/policies`, `/api/pulse`, `/api/briefs`, `/api/investigations`; frontend 5 files, no page-level tests; the Home bug (D11) is what zero tests on `/api/home` costs |
| H7 | Release control | BUILT, idle | Flag system complete; registry empty (`contract.ts:360-369`) | By owner decision — fine until the first customer |

---

## 4. Promise versus code — the scorecard

| # | Promise | Verdict | Why |
|---|---|---|---|
| P1 | Dutch/English question, chart, **under five seconds**, no training | **HALF** | Question+chart+explanation: yes, and well. Dutch: prompt-level, untested. Five seconds: unmeasured and unlikely on the streaming path (C12). "No training": the entity check viewers need is missing on their layer (C6) |
| P2 | Dashboard in 30 s; saved, **shared**, exported | HALF | Generation, refine, arrange, filters, drill: yes. Sharing is a tenant-wide boolean; editor permission is dead config; no external link (D4). 30 s unmeasured |
| P3 | Scheduled email with AI summary | **TRUE** | E2 — with a recipient-validation and unsubscribe gap |
| P4 | Quality monitoring with plain-language alerts | TRUE (in-app) | E4; the alert never leaves the app |
| P5 | Drill to rows; Investigate why | TRUE | D1, C7 — trigger reliability is the caveat |
| P6 | AI-designed warehouse | TRUE | B5 — with the rebuild-loses-edits defect |
| P7 | **Questions that span sources** | **NOT TRUE** | B12 |
| P8 | Roles + masking + row filters | HALF | F3: one any-role endpoint bypasses policies; six raw-value paths unpoliced |
| P9 | Setup under an hour, review in 20 min | **NOT TRUE** for OAuth sources | A2: the customer registers their own OAuth app first; A3: nine actions and a dead-end |
| P10 | **Threshold alerts** | **NOT TRUE** | E3 |
| P11 | **Actuals vs budget, rep vs target** | **NOT TRUE** | D6; a budget grid exists but links to nothing |
| P12 | Monday CFO email ✓; **board pack in one click** | HALF | E2 yes; D8 no |
| P13 | Ranked table with per-row sparklines, decliners | HALF | D7 |
| P14 | Cash-flow forecasting | HALF | E7 — only as an Ask keyword |
| P15 | No SQL to business users; <70 % blocked | TRUE | C3, C10 — with the API-side source-layer hole |
| P16 | **White-label** | **NOT TRUE** | G6 |
| P17 | "Data stays in your environment" | **CONTRADICTED by the terms** | The terms say Clarion keeps a copy in an EU warehouse (`terms.ts:24-28`); the overview's comparison row says the opposite. One of them has to change before a customer reads both |

**Six true, six half, five not true.** The five untrue promises are, in order of what it would cost to make them true: P17 (a sentence), P16 (out of scope — remove), P10 (small: the pulse skeleton exists), P11 (medium: a target entity), P7 (large: the multi-source plan of record).

---

## 5. Defects found in shipped behaviour (fix, do not plan)

Ranked by who notices first. **Status (same day, same PR): all seven fixed** — the CLAUDE.md Current State entry of 2026-09-06 records what changed and which test pins each. Item 1 also gained the first test on `/api/home`; item 2 turned up a second defect in the policy engine (a double-quoted column reference walked past a mask), fixed with it.

1. **Home shows "No dashboards yet" for everyone** — `routes/home.ts:206-209` queries `dashboards.starred`; the column is `is_favorite`; the error is swallowed. Both homes. Queued as a separate task; needs the first `/api/home` test.
2. **A viewer reads unmasked product rows** through `GET /semantic/product-preview` (`semantic.ts:1953`): any role, no policy. Add `prepareUserRead`-equivalent masking to the preview (mask columns, apply row filters) or gate it to curators again.
3. **A viewer can request the raw source layer at the API** (`query.ts:1399`): enforce `dataLayer:'source'` ⇒ `canSeeSql` roles server-side. One line plus a test.
4. **Rebuild destroys human edits on products** (`busMatrixBuilder.ts:441-447`): snapshot `question_text`, `plain_summary`, KPI edits and `hidden` by product name before retire, merge after — the profiler's own pattern (`SchemaProfiler.ts:846-912`), third application after migration 70.
5. **Sources page admits analysts into an admin-only API** (`sources/page.tsx:2471` vs `connections.ts:41-497`): decide the role (the doc says admin), then make page, rail and routes agree. Fold in the other five F1 discrepancies and rewrite the role table in `CLAUDE.md` from code.
6. **Catalog sample rows 403 for analysts and viewers** (`semantic.ts:1032`): the product-preview decision (all roles, policies applied) should apply to the source preview too — after item 2.
7. **`/cross-view` executes model SQL with no read guard** (`query.ts:2407-2413`): unreachable today, so delete the route together with the dead `IntegrationsPanel`, `cross_view_relationships` read in `POST /query`, and `/api/cross-views` — or guard it. Deleting is right: B12 will be rebuilt on the canvas's match edges, not on SQLite `ATTACH`.

Smaller, same category: `callClaudeMultiTurn` without overload retry (C4); email recipients unvalidated (E2); `shared_permission` dead config (D4); pulse `sensitivity` claimed but unread (E3); notebooks blind to grids (B9); direct-DB freshness impossible (A5).

---

## 6. What to add, modify or improve — ranked

The ranking rule: **first make the promise and the product agree; then remove the friction between a new customer and their first true answer; then build the push loop the personas actually live in; only then multi-source.** Effort is a working figure for one engineer.

### 6.1 Make the promise true or stop making it (days)

> **Status: done, 2026-09-06.** The seven defects shipped to production
> (deploy #580); time-to-answer is measured (`query_log.duration_ms` +
> `/admin/ai-usage/answer-latency`); the overview states only what is true
> and badges the rest as roadmap; the dead doors are deleted. The router
> tests are the one line still open — see the CLAUDE.md entry.


| Action | Kind | Effort |
|---|---|---|
| Rewrite `clarion-overview.html` (and any copy derived from it) to the §4 scorecard: drop P16 white-label and P17 "stays in your environment", reword P7/P10/P11/P12 as roadmap or remove, replace "under five seconds" with a measured claim once C12 exists | modify | 0.5 d |
| **Measure time-to-answer**: stamp `answeredInMs` (already in message meta) into `query_log`, report p50/p95 per tenant on `/admin/ai-usage`; decide the claim from the number | add | 1 d |
| Fix the seven defects in §5 and the role table | modify | 3 d |
| Delete the dead doors (H5): three orphan pages, four redirect stubs, ten components, `SourceSelector`, the `POST /query` cross-source branch, `/api/cross-views`, `/api/jobs` | modify | 1 d |
| Tests for the twelve untested routers, starting with `/api/home`, `/api/policies`, `/api/briefs`, `/api/pulse` | improve | 3 d |

### 6.2 First fifteen minutes (one to two weeks)

| Action | Kind | Effort |
|---|---|---|
| **Platform-owned OAuth apps** for Exact Online and Microsoft: one registered app per provider, client id/secret as platform secrets, the wizard shows "Sign in with Exact Online" and nothing else (A2). The single biggest change to P9 | add | 3 d + provider approval lead time |
| **Chain the first run**: wizard save → sync starts automatically → the page the user lands on shows sync progress → structural catalog → "Create my topics" offered → first question suggested. Every hop the product performs itself; the user only confirms (A3). Retire `/onboarding` | modify | 4 d |
| **Recommended entity set** per connector (the template's `sourceEntities` is the list) pre-ticked; "everything" one click away (A4) | add | 1 d |
| **Hosted sample workspace** a prospect can ask questions in before connecting (A8) — the Belgian SMB seed already exists | add | 2 d |
| Cron presets ("every hour / every night at 02:00 / weekdays 07:00") instead of a five-field box (A5) | modify | 0.5 d |
| **CSV upload** through the Excel connector's spreadsheet core (A1) — the cheapest second source, still absent | add | 2 d |

### 6.3 The product comes to you (two to three weeks — the gap analysis's release 1, still not built)

| Action | Kind | Effort |
|---|---|---|
| **Email the morning brief** (E1): `emailed_at` exists, `reportEmailService` has the HTML builder, `notificationService` has the events — wire, add per-user opt-out | add | 2 d |
| **Thresholds on any KPI** (E3, P10): a `metric_thresholds` entity (kpi or saved question, comparator, value, recipients), evaluated by the pulse job that already snapshots daily, notification + email the moment it trips. Pulse `sensitivity` becomes real or is removed | add | 4 d |
| **Targets** (D6, P11): `target_value` + period on `product_kpis`, optionally fed from a budget grid column; attainment on `kpi_card`; "vs target" in the answer formatter | add | 4 d |
| **Share a link** (C8, D4): tokenised read-only link for an answer and a dashboard, expiry, revocation, audited; the analyst's Excel-shaped loop finally has a door that is not Excel | add | 3 d |
| **Phone-usable Home + brief + topic page** (D12): breakpoints, rail collapses to a bottom bar, manifest and viewport; dashboards stay desktop | modify | 4 d |
| Email hygiene (E2): address validation, tenant-membership check for recipients, `List-Unsubscribe` and an unsubscribe route | modify | 1 d |
| **Exception lists as a primitive** (E6): a saved question marked "exception list" with an owner and a cadence renders on Home as "12 invoices over 60 days · €48 k" and in the brief | add | 3 d |

### 6.4 Understand better, correct by talking (two weeks)

| Action | Kind | Effort |
|---|---|---|
| **AI writes `question_text` and `plain_summary`** at build time and on request (B4) — the topic page finally reads as promised | add | 2 d |
| **"Ask AI to change it"** on a KPI or definition (blueprint §6.2): NL edit → proposed change → confirm; the notebook diff pattern applied to metadata | add | 4 d |
| Entity pre-flight on the product layer (C6) | modify | 1.5 d |
| Confirmed-only relationships in AI context after the owner's re-analyse (B6) | modify | 0.5 d |
| Grids readable by viewers and visible to notebooks (B9) | modify | 1.5 d |
| Direct-DB parity: real primary keys as business keys, schedules and freshness for direct sources (A7, A5) | modify | 3 d |
| Verified lookup, sources and cache on every query route or collapse them into `/think` (C9, C11) | modify | 2 d |
| Eval harness: 30 golden questions per template with expected SQL shape and result invariants, run against a seeded warehouse in CI (C13). The owner dropped this in wave C; it is still the only way "accurate" becomes a measured word | add | 4 d |

### 6.5 Then, and only then: the multi-source promise (P7, B12)

The plan of record is `warehouse-value-for-smb.md §5.8` and `multi-source-strategy.md` P1–P4: the ten fixed dimension names, the second-source mapping flow on `/build`, the identity crosswalk, then un-scoping the query layer. Nothing in this evaluation changes that plan; it confirms that **none of it has started** and that the two half-built cross-source mechanisms (`cross_view_relationships` and canvas match edges) should be reduced to one before it does. Six to eight weeks. It is the largest unmet promise and the one a customer with one ERP will not miss for months — which is why it is last here and first nowhere.

### 6.6 Not in this list, deliberately

SSO (F2) is real and will be asked for, but it is a sales-cycle item, not a product-experience item, and it belongs with the market-readiness doc's identity domain. NL/FR i18n (H1) stays where the gap analysis put it — schedule alongside, restart from PR #114. Comments and mentions (G1), a public API or MCP (G4), dark mode and maps (D9) are all real but none of them makes the promise truer. Writeback, low-code apps and a connector-count race stay on the do-not-build list from `clarion-vs-peliqan.md §7`.

---

## 7. What is genuinely ahead of the promise — protect it

- **The `/think` path** (C1–C4): verified fast path → layer resolve → streaming with abort → gate → self-heal → policies → sources → answer, with two model calls and prompt caching. Nothing in the competitive doc's list of products shows a business user *"✓ Checked & corrected"* with a "What I checked" trail.
- **The worksheet** (C2): a question as a step in a tree, assumptions as controls, branch on change. This is the answer to "the chat gets long" that the industry has not shipped.
- **Documentation-before-inference profiling** (B1) with vendor docs, curated catalogues, human-edit survival and a review queue.
- **The relationships canvas** (B6): measured, provenance-marked, honest about thin data.
- **Deploy-time honesty**: render gate for every widget type, ten lint ratchets, the sync that says `partial`, the deploy that catches up by itself.
- **Cost**: one Sonnet + one Haiku per ordinary question, zero AI calls to open a dashboard.

Every item in §6 is additive to this. None of it should thin the trust layer to buy speed — the standing rule from the competitive doc holds.

---

## 8. Corrections to the record

- **`CLAUDE.md`'s role table is wrong in six rows** (F1). It should be regenerated from `frontend/lib/role.ts` and the route gates once §5 item 5 lands, not hand-edited.
- **One investigator claim was rejected on re-verification**: "login success/failure and password events are not audited". `routes/auth.ts` carries fourteen `recordAuthEvent` sites (wave B 2-4); the claim came from a grep for the older `recordAudit` name only.
- **`functionality-gap-analysis.md §6` said forecasting "EXISTS in Ask AI"** — true, but only behind a client-side substring trigger (C7); it does not exist as a feature a user can find.
- **The 2026-08-26 dashboard assessment listed "no undo of any kind"** — still true for dashboards; the notebook assistant's Keep/Discard diff (2026-09-01) is the pattern to port.
- **The rollup registration** flagged as "advertised but unregistered" in the 2026-08-04 entry is closed (`ConnectorFactory.ts:188-194`) — confirmed on this tree.

## 9. Limits of this evaluation

Read from the code at `f18adc9`; nothing was run against production. Latency (C12) and accuracy (C13) are stated as unmeasured because they are — the two numbers the promise most depends on are the two the platform does not yet record. The overview's claims were read from the repository copy of `clarion-overview.html`; if the public site or a sales deck carries a different version, grade that version by the same table. The effort figures in §6 are for one engineer on this codebase with the existing patterns (snapshot-and-merge, the read-policy helper, the pulse job, the email builder) and assume no provider lead time except where stated.

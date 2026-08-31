# CLAUDE.md — Clarion
> AI-powered semantic data platform. Read this file at the start of every session.

---

## CLAUDE.md Maintenance Rules
> These rules apply to every single session. No exceptions.

**At the start of every session:**
- Read this entire file before writing any code
- Check the Current State section below to understand what already exists
- Do not create files or folders that already exist
- Do not reimplement logic that is already built — find it and use it

**At the end of every session:**
- Update the Current State section to reflect every file added or changed
- If any new environment variables were added, add them to the .env.example section
- If the architecture changed in any meaningful way, update the relevant section
- Do not end a session without completing this step

**When the folder structure changes:**
- Update the Folder Structure section to match what is actually on disk
- If a file moved, update every reference to it in this document
- If a file was deleted, remove it from the structure

This document must always reflect reality. If it does not, the next session starts
with false assumptions and produces broken code.

---

## Current State
> Updated by Claude Code at the end of every session. Shows what actually exists now.

**Last updated:** 2026-08-31 (SPREADSHEET SOURCES — Excel + SharePoint
connectors, and an Excel add-in with the platform's first machine auth)

**THE OWNER ASKED FOR AN EXCEL CONNECTOR, A SHAREPOINT CONNECTOR AND AN EXCEL
ADD-IN, with a standing instruction: *"Kijk naar de ExactOnline connector. Ik
wil dat alles dezelfde wijze volgt… Consistentie, Robuustheid, Best practice."*
All three are built. ExactOnline is the shape every file follows.**
- **NEW SHARED CORE `packages/connectors/src/spreadsheet/`** — `xlsxReader.ts`
  (ported from `frontend/lib/xlsxRead.ts`; the frontend cannot import this
  package because its entry pulls DuckDB, the same reason `writeRowsParquet`
  was ported — **keep the two in step**) + `tabular.ts` (headers → warehouse
  identifiers, conservative type inference, rows → records). Both connectors
  go through it, so the same workbook lands IDENTICALLY whether uploaded or
  read out of SharePoint. First committed tests for this reader ever: a
  fixture builder in `__fixtures__/xlsxFixture.ts` writes REAL .xlsx (zip
  framing, CRC32s, content types), because a parser tested only on input its
  own author shaped proves nothing.
- **THE ONE BEHAVIOUR TO KNOW: THE READER REPORTS ITS ROW CAP, IT DOES NOT
  OBEY IT.** The grid importer truncates, which is right for a hand-kept
  mapping table. A SOURCE must never: silently ingesting the first N rows
  produces a table that LOOKS complete and answers questions with wrong
  numbers. `assertSheetComplete` (shared, so the rule and its wording exist
  once) fails the entity before anything is written. Losing a table is
  visible and recoverable; losing rows is neither.
- **SharePoint connector** (`sharepoint/`: schema · oauth · graph · entities ·
  connector) — Microsoft identity v2, read-only scopes (`Files.Read.All`,
  `Sites.Read.All`, `offline_access`), refresh via `onCredentialRotated`.
  **Its comments deliberately DIVERGE from EO's on one point**: EO invalidates
  the old refresh token instantly so a lost rotation bricks the connection;
  Microsoft's stays valid ~90 days, so this connector does NOT hard-fail when
  the persist hook is absent — that would turn a recoverable state into an
  outage. Entities are DISCOVERED (a library holds whatever the customer put
  there), every traversal in `graph.ts` is capped, and a cap being hit is
  REPORTED. `probeEntities` deliberately absent: a file we could list is a
  file we can read.
- **Excel connector** (`excel/`) — **the workbook rides INSIDE the connector
  config, and that is the deliberate part.** The platform decrypts a config in
  FIVE places (sync launch, profiling, three connection routes); a separate
  file store needs a hydration step in each and missing one fails deep inside
  a sync. As an ordinary config field all five already work. Cost: a bigger
  encrypted row (Postgres TOASTs it) and a ~15 MB cap the reader's memory
  profile wants anyway.
- **NAMING DIFFERS BETWEEN THE TWO AND IT IS THE SAME RULE, NOT AN
  INCONSISTENCY**: an entity is named by what identifies the sheet WITHIN ITS
  SOURCE. A library has many workbooks → `file__sheet`. An upload IS one file
  → `sheet`. Which also means re-uploading `Budget 2026 v2.xlsx` keeps the
  existing tables instead of orphaning them behind renamed ones. Neither is
  incremental: a worksheet has no row-level stamp and no business key, and a
  cursor without one makes the writer wipe the table on every delta.
- **Three framework fixes the work forced out, each closing a real hazard.**
  (a) `HttpClient` gained binary responses so a file download keeps the retry,
  pacing, 401-refresh and egress allow-list a bare axios call bypasses; its
  error excerpt now decodes byte bodies instead of stringifying them to `{}`.
  (b) **An EMPTY `egressAllowList` now means "reaches nothing", not "no
  policy"** — it previously disabled enforcement, inverting the safest
  declaration into the least safe one; conformance accepts `[]` for a
  connector that makes no network calls (the Excel one). (c) **The local
  launcher hands the worker its config as a 0600 temp file, not an env var** —
  Linux caps one env var at 128 KB so a config carrying a workbook could not
  be passed at all, and `/proc/<pid>/environ` is readable by anything running
  as the same user. Mirrors what the Azure launcher already does with a
  staged blob.
- **A defect this change would otherwise have introduced, caught and fixed**:
  `GET /connections/:id/source-config` redacted by FIELD NAME, and
  `fileContent` matches no credential word — so opening the edit dialog would
  have shipped the customer's whole workbook to the browser. Redaction is now
  SCHEMA-DRIVEN (anything the connector declares `contentEncoding: 'base64'`),
  so the next file-backed connector is covered the day it registers. PATCH
  already skips the `••••••••` placeholder, so a round trip leaves the file
  intact.
- **Body limit is scoped, not raised globally**: `/api/connections` and
  `/api/source-types` get 32 MB, everything else keeps 2 MB.
- **Wizard**: booleans render as CHECKBOXES (they fell through to a text input,
  so users typed the word "true") and any base64 schema property renders as a
  FILE PICKER — so a file-backed connector needs no frontend code of its own.
  Excel + SharePoint tiles registered on `/sources`.
- **EXCEL ADD-IN + THE PLATFORM'S FIRST MACHINE AUTHENTICATION.** Everything
  until now authenticated with a JWT from a person signing in; Excel has no
  Clarion session. **Migration 86 `api_tokens`** — a token belongs to a USER,
  carries their tenant and role RESOLVED LIVE from the `users` row (so a role
  change or deactivation takes effect immediately, and no token ever outranks
  its owner), stores only a SHA-256 hash (fast hash on purpose — the opposite
  of the password rule — because the secret is 256 bits of machine randomness
  with no dictionary, and this runs on every add-in request).
  `middleware/apiToken.ts` verifies the token, mints a short-lived JWT,
  REPLACES the header and steps aside so `requireAuth` runs unchanged — the
  two auth paths cannot drift apart. Accepted on `/api/addin` ONLY (three
  read-only endpoints); widening it later, e.g. for MCP, is a deliberate act.
  Data policies are re-applied and the saved SQL is re-guarded AT RUN TIME.
  Task pane at `frontend/app/excel-addin/` (served by the frontend, no second
  deployment), token UI on `/profile`, manifest + sideloading guide in
  `excel-addin/`.
- **⚠ A PRODUCTION FINDING THIS WORK TURNED UP, MEASURED AND NOT FIXED — worth
  reading before touching auth.** `unauthQuery`'s header, `tenantScopedWrite`
  and `routes/auth.ts` all describe an **`auth_lookup` RLS policy** that lets
  an unauthenticated SELECT find a user. **IT EXISTS NOWHERE** — not in any
  migration (74 creates only `tenant_isolation`), and not in a migrated
  database. Measured locally 2026-08-31: with a real user row present, a
  NOBYPASSRLS role running `SET LOCAL app.current_tenant = ''` — exactly what
  `unauthQuery` does — reads **0 rows**. If production truly connects as
  `databridge_app`, login cannot work; since it demonstrably does, production
  and the documented state disagree (the role flip did not take, the policy
  was made outside migrations, or the role has BYPASSRLS). **The 2026-08-06
  verification `health=200 login=401` cannot tell those apart** — a 401 is
  equally what a totally broken login returns. Not chased here: it is
  production auth, it needs evidence from production, and it is not what was
  asked for. `api_tokens` therefore carries its OWN explicit `token_lookup`
  policy (SELECT, only while there is no tenant context) rather than
  inheriting an assumption now known to be false.
- **BOTH NEW CONNECTORS SHIP BEHIND `CURRENT_RELEASE`** (owner's call before
  merging: "eerst achter de release-vlag"). `GET /api/source-types` filters
  `RELEASE_GATED_CONNECTORS` (`excel`, `sharepoint`) out of the catalog for a
  tenant not on the train, so deploying is not releasing — the tiles appear
  when the operator ticks the tenant on `/admin/features`. **The carve-out is
  load-bearing, not a nicety**: the EDIT dialog reads an existing connection's
  config schema from this same catalog, so a gated type the tenant already
  uses is always kept — otherwise switching the flag back off would make an
  already-created source unmanageable. The gate covers ADDING only; existing
  connections keep syncing. Migration 86 and the three behaviour changes
  (launcher config file, empty-egress semantics, schema-driven redaction)
  CANNOT be flagged and go live with the deploy, which is the category
  `DEV_FLOW.md` says to look at before pushing. Pinned by
  `source-types-release-gate.test.ts`, and the gate was removed once to
  confirm the test actually goes red.
- Validation: connectors **223 tests** (was 132) · backend **47 files / 473
  passed** (14 new in `api-tokens.test.ts`, mostly refusals: revoked, expired,
  deactivated owner, cross-tenant question, no role escalation; 4 in
  `source-types-release-gate.test.ts`) · all eight
  ratchets green from the repo root · backend/worker/frontend typecheck clean ·
  `next build` green (`/excel-addin` 3.56 kB) · new frontend files lint-clean.
- **NOT done, deliberately**: no CSV/`.xls`/`.xlsb` (different formats — a
  clear refusal at listing beats a confusing parse failure); no SharePoint
  Lists (document libraries only); no writeback anywhere; the add-in inserts
  saved-question results only, not arbitrary tables. **Neither connector has
  been exercised against a live Microsoft tenant or a real upload** — the
  SharePoint OAuth path in particular needs an Entra ID app registration the
  owner must create, and should be watched on its first real run.

**Prior last updated:** 2026-08-31 (COMPETITIVE ANALYSIS vs PELIQAN — doc only, no code
changed)

**NEW DOC: `docs/backlog/clarion-vs-peliqan.md` (2026-08-31, doc only).** Owner
asked what Peliqan.io can do, what Clarion can do, and what each has that the
other lacks — reasoned from someone CHOOSING a data platform, not building one.
Clarion's side is measured against this codebase (absences verified by
repo-wide grep, not assumed); **Peliqan's side is their own marketing plus
third-party reviews and is NOT verified** — `peliqan.io` is blocked by this
environment's egress policy (`EGRESS_BLOCKED`, a policy block, not a network
fault; not routed around), so the picture is built from search results that read
their pages. Every claim in the doc is marked *(gemeten)* or *(claim)*.
- **The shape of the difference: Peliqan sells the plumbing plus an ACTIVATION
  layer; Clarion sells UNDERSTANDING and TRUST in the answer.** They overlap in
  the middle (sources → warehouse → semantics → plain-language questions →
  dashboards) and diverge at both ends.
- **Measured asymmetry at the input end: 250–300+ connectors (claim) vs
  Clarion's 6** — 2 SaaS (Exact Online, Odoo) + 4 direct DBs. And Clarion has
  **no file/spreadsheet connector at all** (verified: nothing matching
  excel/csv/sheet in `packages/connectors/src/`), which is the cheapest possible
  second source and already sits as P1 in `multi-source-strategy.md`.
- **A whole output side Clarion does not have, verified by grep returning
  nothing**: reverse ETL / writeback (zero hits repo-wide), an MCP endpoint or
  public API for external agents (zero), embedding / white-label / external share
  links, low-code data apps. Plus federated cross-source query (they use Trino)
  where **Clarion's query layer is still connection-scoped** (`routes/query.ts`
  takes one `connectionId`) — the P4 debt, now with a competitor selling exactly
  what it blocks.
- **What Clarion has that they don't, and it is not nothing**: the model is
  designed FOR the user (bus-matrix / connector templates, one button on
  `/build`) rather than BY the user (their SQL + Python + spreadsheet). **Their
  own G2 reviews say steep learning curve and that SQL/Python knowledge is
  needed** — that is the only independent evidence in the document, and it names
  precisely the gap Clarion exists to fill. Plus per-answer trust display,
  the worksheet/step-tree Ask AI, morning briefs, the measured relationship
  canvas with source-laid vs manually-laid, linked grids with coverage, release
  trains. And a cost base orders below their €350/month floor — **the segment
  under that floor is unreachable for them and serviceable for Clarion**.
- **THE FINDING THAT MATTERS IS NOT A FEATURE LIST: they are already on this
  lawn.** Peliqan explicitly targets **Benelux accountancy firms running dozens
  of Exact Online tenants**, with per-tenant isolation, white-label dashboards
  and cross-tenant aggregation, plus an "Exact Online + Claude CFO playbook" and
  an Odoo MCP for Odoo partners (all claims). Same two ERPs, same geography, and
  **the same channel** — the accounting firm — that `warehouse-value-for-smb.md`
  §2.4 has as Clarion's channel strategy with the above-tenant tier still
  PLANNED. So G12 (portfolio tier) is more urgent than its position in the gap
  analysis suggests — but the doc argues explicitly AGAINST chasing them on
  breadth: 6 vs 300 connectors is unwinnable and unnecessary, and their
  technical-user requirement is structural to what they sell, not a bug they
  patch next quarter.
- **Re-ordered build advice (does not replace the gap analysis, re-ranks it):**
  spreadsheet connector → un-scope the query layer → MCP/public API → external
  share + white-label; and start the SOC 2 Type II clock, since the engineering
  exists and only the certificate (with its lead time) does not. **Explicit
  do-not-build list**: no connector-count race, no writeback yet (different risk
  class — writing into a customer's accounting system), no low-code app
  platform, and above all do not thin the trust layer to buy breadth.
- **Honest limits stated in the doc**: no Peliqan feature was verified, no price
  comparison is possible (Clarion has no pricing), their text-to-SQL quality is
  unmeasured — and a real bake-off (same Exact Online dataset, same ten
  questions, both products) would be worth more than the whole document.

**Prior last updated:** 2026-08-29 (DASHBOARD REFINE REBUILT — tiered edits, visible
progress, and the empty-dashboard-after-refine defect fixed)

**THE DASHBOARD CHAT SHOWS ITS WORK NOW, AND SMALL EDITS ARE SMALL (2026-08-29).
Owner, with two screenshots: "Make the AI output his answer in the chat when
asking to alter the dashboard… right now I see the 3 dots but I have no output…
A lot of the times the dashboards will not be 100% what the user wants. How can
we make sure adaptations are fast? Maybe not sending everything to the AI?"
Also: "It does not work at the moment" — his refine produced an all-€0,00
dashboard.**
- **THE €0,00 DEFECT WAS FILTER-VALUE LOSS, NOT SQL.** After every refine the
  client rebuilt filter values from defaults
  (`setFilterValues(buildDefaultFilters(...))`), so a dashboard being viewed on
  01/01/2024→now snapped back to the last-12-months default — and the owner's
  data ends early 2025, so every widget re-queried an empty window. New
  `frontend/app/dashboards/utils/refineCarryover.ts`: `carryFilterValues` (a
  filter that SURVIVED the refine keeps the value on screen; only genuinely NEW
  filters take a default; a filter whose column/type changed counts as new) and
  `dropChangedFromCache` (only widgets whose SQL changed lose their cached rows
  — an edit to one card no longer blanks twelve into skeletons; any change to
  an EXISTING filter value still wipes everything, a NEW key wipes nothing).
  Dry-run in real Node via esbuild, including the exact production case.
- **The second half of the screenshot (squashed cards): `preserveSpecCarryover`
  now makes the PREVIOUS layout authoritative** — the model breaks the
  echo-layout-verbatim prompt rule in both directions (drops it AND invents
  one), and an invented layout renders as a silently mangled dashboard. A model
  layout on a widget the user never arranged is dropped back to flow placement.
  The old "leaves a model-echoed layout alone" test pinned the buggy semantics
  and was rewritten.
- **TIERED EDITS — most adaptations no longer send the dashboard to the AI.**
  New `services/dashboardEditOps.ts` (pure, 23 tests): a typed
  `DashboardEditOp` catalogue (add/remove filter, filter defaults, chart-type
  swap, retitle, remove widget, format, top-N limit, scoped `sql_edit`,
  `add_widget`) + `applyEditOps`. Filter add/remove is TEXTUAL SQL SURGERY on
  the same predicate shapes the generation prompt emits
  (`('{{id}}' = 'all' OR col = '{{id}}')`, `BETWEEN '{{id_from}}' AND
  '{{id_to}}')`), via `injectWherePredicate` — the cross-filter WHERE-boundary
  logic generalised; it REFUSES CTEs/set-operators/no-FROM rather than guess,
  and `stripFilterPredicate` refuses to leave a dangling placeholder (would
  silently resolve to 'all'). Chart-type swaps allowed only within a
  column-contract group DERIVED from `REQUIRED_WIDGET_COLUMNS` (bar↔line↔pie↔
  top_list…); a cross-contract swap hands over to a scoped SQL edit
  (`NEEDS_SQL:` marker → `pendingSqlEdits`). Every op is total: unknown ids and
  unsafe identifiers REFUSE (reported to the user), never half-apply.
  `safeIdentifier` REJECTS rather than sanitises — a stripped identifier is a
  different identifier.
- **PLANNER: one Haiku call decides, small Sonnet calls execute.** New
  `ai/prompts/dashboardEditPlanPrompt.ts` + `AIService.planDashboardEdit` /
  `editWidgetSql` / `generateSingleWidget`. The planner sees a SQL-FREE DIGEST
  (`buildSpecDigest`: ids, titles, types, contract columns, which filters each
  widget is wired to — pinned by test that no SELECT reaches it) and returns
  `{strategy, summary, ops}`. "Slice by customer" is ONE add_filter op, not
  twelve rewritten widgets. `strategy:"regenerate"` (subject/audience changes)
  falls back to the untouched full-spec path — which also remains the safety
  net when the fast path errors.
- **`POST /dashboards/refine-spec-stream` (SSE, Zod via refineSpecSchema).**
  Stages: plan (Haiku) → deterministic ops applied instantly → scoped model
  calls IN PARALLEL → check: ONLY the widgets whose SQL is byte-different from
  the pre-edit spec are executed (`executeSpecForValidation` + column
  contract); a failure gets ONE scoped repair (for a broken filter injection
  the model gets the ORIGINAL sql + "wire the filter in properly — usually a
  join"; column binding errors DO surface despite the 'all' short-circuit
  because DuckDB binds at plan time), then REVERTS to the last working version
  with a spoken refusal — never ships broken, never silently drops an edit.
  Events: `phase` / `plan {summary, steps}` / `step {id, status, note}` /
  `done {spec, changes, notes, refusals}`. The non-stream `/refine-spec` stays
  for API compatibility.
- **The chat renders the plan as a live checklist** (ChatMessage gained
  `working/phase/steps`): summary sentence immediately, steps flipping
  pending→running→done/failed with per-step notes, refusals appended as ⚠
  lines to the final message — the three bouncing dots are suppressed while a
  working bubble exists, and a mid-stream error converts the working bubble
  instead of stranding it.
- Validation: backend `npm run check` clean; full suite green incl. 23 new
  edit-op tests + 4 digest tests + rewritten layout-carryover tests; all eight
  ratchets green from the repo root (validate-coverage 160/225 — route total
  224→225, new route validated); frontend `tsc` clean, touched files
  lint-clean, `next build` green. NOT yet exercised against a live AI backend
  — the first real refine through the stream endpoint should be watched once.
- **THE FAST PATH IS FLAG-GATED (same day, owner: "can I now decide for which
  tenants I want to roll this out?").** It shipped to main unflagged, which
  broke the owner's own rule that a user-visible change reaches production
  without reaching a customer — so `dashboard_fast_refine` ("Quicker dashboard
  changes") joined `FEATURE_FLAGS`, and `/refine-spec-stream` escalates to the
  full-spec path when it is off for the caller's tenant. **The split is
  deliberate and is the interesting part**: the two BUG FIXES (filter-value
  carryover, layout authority) ship UNGATED, because gating a fix means
  choosing who keeps the broken behaviour; and the STREAMED PROGRESS is ungated
  too, because an edit that reports what it is doing carries no risk worth an
  audience decision and is half of what the endpoint was built to fix. Only the
  tiered engine — the part that changes HOW an edit is computed — is behind the
  ring. Flag off is therefore not "the old experience": it is the old speed
  with the new honesty and the bugs fixed.
- **PROMOTING NOW ENDS AT THE AUDIENCE PICKER (same day, owner: "when I
  trigger Promote to production, I want to have the choice to click on which
  ones I want to deploy it for").** The ask cannot be met where it was made,
  and the reason is worth keeping: **promote runs `az containerapp ingress
  traffic set --revision-weight <rev>=100`, and one revision serves every
  tenant** — there is no promoting to a subset, and anything that behaves like
  one IS a flag underneath. Nor can the customer list live on the dispatch
  form: `workflow_dispatch` inputs are a STATIC list in the workflow file, so
  real customer names there would mean editing `promote.yml` on every
  onboarding. So the two acts stay separate and the PATH between them was
  built instead: promote.yml's job summary and deploy.yml's auto-promote
  summary both end with a resolved deep link to `/admin/features` (frontend
  FQDN read via `az containerapp show`, with a plain-text fallback when it
  cannot be resolved), and the console now LEADS with what is waiting — an
  "N features are live but nobody can see them yet" banner naming them, and
  unreleased flags sorted to the top. `isWaitingForAudience` is DERIVED, not a
  stored released-marker, so pulling a feature back to nobody re-queues it,
  which is what it is. The failure this closes: a feature reaching production
  and then sitting switched off because nothing said it was waiting.
- **THE UNIT OF ROLLOUT IS A RELEASE, NOT A FEATURE (same day, owner: "I don't
  want it per feature. Just the latest version I promoted").** He first asked
  for tenant selection at promote time; told that one revision serves every
  tenant, he restated the underlying want, which is the useful form: ONE switch
  per batch of shipped work. So `FEATURE_FLAGS` entries gained
  `kind: 'release' | 'feature'`, and everything user-visible now hangs off
  **`CURRENT_RELEASE`** (`release_2026_08`, "August 2026") rather than a key of
  its own — `dashboard_fast_refine` is GONE, and `/refine-spec-stream` calls
  `isCurrentReleaseEnabled()` so opening the next train is one edit to that
  constant, not a hunt for stale strings. A test pins that CURRENT_RELEASE
  exists AND is a release: pointing it at a missing key would resolve false for
  every tenant, i.e. a total silent rollout failure with nothing on screen.
  **`kind: 'feature'` survives as the deliberate exception** — a standing
  capability not tied to a train (only `preview_banner` today).
- **PER-TENANT CODE VERSIONS WERE CONSIDERED AND REFUSED, which is why the
  above is the answer.** Genuinely running old and new side by side needs a
  JWT-decoding proxy in front of both apps (ACA traffic weights are
  percentages, random per request — there is no routing by tenant), an
  always-on replica per live version, and — the killer — every future migration
  compatible with every version any tenant still sits on, forever. The current
  rule is only "backward-compatible within a deploy window".
- **Three placeholder flags were DELETED and that was a live bug, not tidying.**
  `brief_email` / `metric_thresholds` / `exception_lists` were declared for
  roadmap items and gated nothing. The new "waiting for an audience" banner
  counts flags with an empty audience, so it would have announced "4 features
  are live but nobody can see them yet" naming three things that DO NOT EXIST —
  the banner's credibility gone on its first render. Hence `isWaitingForAudience`
  is scoped to `kind === 'release'` too: a standing feature is switched on when
  someone wants it, never queued for a decision.
- **"WHO SEES WHAT" REFUSED ITS OWN OPERATOR FOR AN AFTERNOON, AND EVERY STEP
  OF THE DIAGNOSIS WAS WRONG BEFORE IT WAS RIGHT.** Worth keeping in full,
  because each wrong turn is a reusable lesson. (1) The file said
  `arnovda@telenet.be` — the owner's PERSONAL address; he signs into Clarion as
  `admin@vdaanalytics.com`. The check compares the list against the logged-in
  account and nothing else, so **a near-miss grants nothing and looks EXACTLY
  like a broken deploy** — same blank console, same silence, no error anywhere
  saying "that address matches no account". `.ops/operators` now says outright
  that it must be the sign-in address. (2) Chasing it, I assumed
  `az containerapp update --image` had dropped the env var across deploys. The
  re-apply DISPROVED that (`Current: arnovda@telenet.be → target:
  arnovda@telenet.be`) — `--image` does preserve env vars, and the value had
  survived three deploys. Worth knowing: the opposite would have shut the
  console on every release. (3) After the address was fixed the page STILL
  refused while the rail entry beside it rendered — and that entry only renders
  when the server says isOperator, so the refusal was a lie. Cause: the page's
  ONE blanket `catch` rendered every failure as "not open to you", so a fault
  wore a refusal's clothes. Now 404 alone is the refusal; anything else says it
  is a fault and shows the status. (4) The production logs finally settled it —
  `statusCode: 200, contentLength: 874` for the owner's own userId on
  `main-a5b530c`. The endpoint had been fine; the screen was stale client
  state. **The moral for the next person: when a screen and its own nav
  disagree, believe neither and go read the logs.**
- **`.ops/prod-logs` GAINED A `server-error` SIGNATURE (any 5xx), AND ITS FIRST
  VERSION COULD NOT MATCH ANYTHING.** It looked for `'request error'` AND a
  5xx status — but `requestLogger` emits `'request error'` at >=400 and
  **`'request failed'` at >=500**, so the conjunction was empty by
  construction. It came back clean and I read that as evidence the console was
  not faulting; it was evidence of nothing. **A check that cannot fail reports
  exactly what a healthy system reports** — the precise failure this control
  exists to stop the platform making, made inside the control itself on its
  first extension. Fixed to match `'request failed'`. Keep it: with no alerting
  anywhere, it is the closest thing this platform has.
- **Next natural slices**: a zero-AI "+ Add filter" picker on the FilterBar
  (needs a linkable-columns endpoint for dashboards; applyEditOps is ready for
  it), per-widget right-click "change this card" wired to the scoped
  `sql_edit` path, and suggestion chips under the chat input.
- SANDBOX NOTE: `.claude/hooks/session-start.sh` from the 2026-08-29 tooling
  session is NOT in this checkout (only its CLAUDE.md/docs entry landed) —
  this session hand-booted Postgres (`service postgresql start`, roles +
  `databridge_test` + `knex migrate:latest`) and used
  `.ops/cloud-setup-script.sh` for installs; the connectors DuckDB binary was
  copied from the backend's per the hook's recipe (versions matched at 1.4.2).

**Prior last updated:** 2026-08-29 (PER-TENANT FEATURE FLAGS — deploy and release are
two events now)

**FEATURE FLAGS SHIPPED (2026-08-29). Owner: *"So I can release it first to my
own test tenant."* Until now deploy and release were the same act — promoting a
revision showed every change to every tenant simultaneously, and the only way to
withdraw one was a rollback of everything else in that revision.**
- **A flag EXISTS IN CODE, its ROLLOUT lives in the database.** `FEATURE_FLAGS`
  in `shared/contract.ts` (both byte-identical copies) is the registry; adding a
  key is a reviewed code change, so a typo can never mint a second flag that is
  off forever, and an unreferenced flag reads as dead code. `feature_flags`
  (migration 85) holds only `key` / `rollout` / `tenant_ids`. Rows are created
  LAZILY — a declared flag with no row is 'off', which is the correct state for
  something just merged, so nothing needs seeding.
- **The ladder is `off` → `tenants` → `all`**, and the audience SURVIVES a trip
  through 'off' (pulling a feature back must not make the operator rebuild the
  ring to re-release it). Shipped keys: `preview_banner` (live, wired),
  `brief_email`, `metric_thresholds`, `exception_lists` (declared for the
  roadmap items, gating nothing yet).
- **THE TABLE HAS NO `tenant_id`, DELIBERATELY, AND THAT IS THE ONE THING TO
  KNOW BEFORE TOUCHING IT.** A flag is not tenant-owned data; it is an operator
  record ABOUT tenants. Under `tenant_isolation` the row would be visible only
  to the tenant it names, while the operator — whose session var holds their OWN
  tenant id — would be refused by the WITH CHECK on every insert. So the
  audience is a jsonb array and **the route gate is the ONLY access control**;
  unlike everywhere else in this schema there is no database-level second line.
  Hence `feature-flags.test.ts` asserts the refusal for viewer, analyst AND
  admin. Two consequences also handled: the console reads/writes through the
  ROOT pool (`reqDb` would filter the tenant list to the operator's own), and
  `purgeTenant` — which enumerates by tenant_id COLUMN and therefore cannot see
  this table — gained an explicit `removeTenantFromAllFlags` call.
- **OPERATOR IS NOT ADMIN, and reusing 'admin' would have been the bug.** A
  tenant admin administers their own company; an admin who can grant themselves
  preview features turns the flag from a release mechanism into a settings
  screen. `platformOperatorEmails()` reads `PLATFORM_OPERATOR_EMAILS` and
  answers empty → **nobody**, so a deployment that forgets to configure it has a
  console no one can open. Read LAZILY per call, not frozen at import: the parse
  is a string split, and a value captured at import cannot be varied by a test —
  the wrong trade for the one control with no database backstop. Refusal is
  **404, not 403** (a 403 confirms the console exists to someone probing).
- **Routes**: `GET /api/features` (any authed user — resolved flags for THEIR
  tenant + `isOperator`); `GET|PUT|DELETE /api/admin/feature-flags` (operator).
  PUT refuses a key not in the registry and a tenant id that does not exist (a
  stale id is invisible on the switch and reads as "released to someone" when it
  is released to nobody). Both mutating routes are `validate()`d — the
  validate-coverage ratchet stayed at 160 while the route total went 222→224.
- **Reads are cached in module memory for 20s**, so a change reaches every
  process in seconds without a deploy; a write clears the local cache so the
  operator sees their own switch immediately. A TTL rather than the Redis cache
  bus ON PURPOSE: that bus exists for warehouse invalidation where staleness
  means WRONG NUMBERS, whereas a late flag means a button appears 20s late. An
  unreadable table (migration not yet run, DB blip) resolves every flag to false
  and is NOT cached, so the next request retries.
- **Frontend**: `lib/features.tsx` — one fetch per shell mount, shared via
  context, `useFeature` / `useFeaturesLoaded` / `useIsOperator`. **Every flag
  reads false while in flight** (a preview feature must never flash into view
  for a tenant not on the ring). `/admin/features` is the console — rings as
  buttons, tenants as chips, orphan rows flagged for removal; gated on
  `useIsOperator()`, NOT `RequireRole`. Rail gained an operator-only entry
  (`operatorOnly` on NavItem, separate from `roles` on purpose). TopBar shows a
  **Preview** chip when `preview_banner` is on — so "is this tenant seeing
  something customers are not?" is answerable from the screen.
- **SIMPLIFIED SAME DAY, owner: *"as simple as possible … consider me dumb."***
  Three things were still developer-shaped and are gone. (a) **The console is
  ONE control per feature now, not two.** It had a three-way audience selector
  AND a separate tenant-chip list that only mattered in one of those states —
  two things to learn, one able to contradict the other. Now: a checkbox list,
  **Everyone** at the top then a line per customer, and the stored state is
  DERIVED (nothing ticked = off, some = tenants, Everyone = all). The three
  states stay in the data model because "everyone, including customers who join
  later" genuinely differs from "these three accounts" — but nobody has to name
  that distinction to use the screen. While Everyone is on, the per-customer
  rows render ticked but inert: unticking one would silently mean "everyone
  except", which the model cannot express. (b) **Features carry a human
  `name`** — `FEATURE_FLAGS` went from `{key: description}` to
  `{key: {name, description}}`, so the screen says "Morning brief by email",
  never `brief_email`. A test pins that every listed flag has one. Orphan rows
  (a key deleted from the registry) are FILTERED OUT of the console rather than
  shown with a Remove button: they enable nothing, so surfacing them put a
  code-cleanup chore on an audience-picking screen. (c) **`.ops/operators`** —
  the one setup step was "edit infrastructure config and redeploy"; it is now
  one email per line in a file, matching the `.ops` GitOps pattern the owner
  already operates (`operators.yml` cloned from `warehouse-container-mode.yml`,
  paths-scoped, waits for the specific revision then shifts traffic). **A
  dry-run of the parser caught a real bug before it shipped**: `tr -d
  '[:space:]'` strips NEWLINES too, gluing `a@b.com` and `c@d.com` into one
  unmatchable string — the second operator would never have worked. Per-line
  `sed` instead. Empty list warns loudly but succeeds (closing the page is a
  legitimate act). Rail label is **"Who sees what"**.
- **New env var**: `PLATFORM_OPERATOR_EMAILS` (in `.env.example`), set from
  `.ops/operators`. `docs/DEV_FLOW.md` **Loop 3** now splits the owner's part
  (one screen, four steps) from the developer's part — including the step
  everyone forgets: delete the flag once it has been on Everyone for a while.
- Validation: all eight ratchets green from the repo root; frontend `tsc` clean,
  touched files lint-clean. Backend typecheck + the new suite: see the session
  note below.

**PUSH-TO-MAIN IS THE RELEASE PROCESS NOW (2026-08-29, same day). Owner: "I
want you to always push things to main, and all I have to do is decide for
which tenants the change goes through."** Trunk-based + continuous deploy, with
the feature flag as the only control the owner operates. Two workflow changes
make it defensible rather than reckless:
- **`gate` job in deploy.yml — THE TESTS ARE A GATE AT LAST.** test.yml and
  deploy.yml both trigger on push to main and simply RACED: a commit with a red
  suite still built, still ran `migrate-sql`, still produced a deployable
  revision. The only thing between a failing test and production was whether
  someone looked at the Actions tab — tolerable behind reviewed PRs, not
  tolerable once pushes land directly and promotion is automatic. `gate` polls
  the Tests run for THIS sha; `migrate-sql` and `deploy` need it. **It gates
  those two only, NOT the image builds** — an image nobody deploys is
  side-effect free, so builds still run alongside the suite and the deploy
  stays fast. **No run at all is a FAILURE, not a pass** (5-min appearance
  deadline, 30-min total) — conflating "did not run" with "passed" is precisely
  how a red suite reaches production unnoticed. `workflow_dispatch` skips the
  gate (a manual redeploy is re-shipping an already-tested commit). Decision
  logic dry-run over all seven states before shipping.
- **`promote` job replaces the manual click.** Waits for the revision to be
  `Provisioned`, then — the load-bearing part — **curls `/api/health` on the
  new revision through its staging label** before shifting traffic.
  `Provisioned` only means Azure started the container; a revision that boots
  and 500s on every request is Provisioned too. Never `latest=100` (that
  auto-follows every future revision and would make the NEXT push go live
  unreviewed). Unhealthy → traffic stays put and the run fails loudly.
  Frontend-only changes promote without the health check (no endpoint to ask).
- **What makes it safe is the flag, not optimism**: a user-visible change ships
  behind a flag that is OFF, so reaching production ≠ reaching a customer.
  **The rule this depends on: anything a customer can see goes behind a flag.**
  What CANNOT be flagged — migrations, fixes to existing behaviour, dependency
  upgrades — is exactly where deploy still equals release, and those still want
  care before the push. Said plainly in `docs/DEV_FLOW.md` Loop 2.
- **`operators.yml` now shares deploy.yml's concurrency group.** Both run
  `az containerapp update` on the same app; Azure locks it while provisioning,
  so they would collide on exactly the push that first merges `.ops/operators`
  — and operators.yml would have shifted 100% traffic to a revision built from
  the PREVIOUS image while the new one sat at 0%, inverting the test-first
  model. The other `.ops` controls have the same latent hazard, still handled
  by procedure ("touch the file only AFTER deploy.yml finished").
- **Still missing, and it matters more now**: there is no alerting. Automatic
  promotion means nobody is watching a deploy by eye, so the absence of a
  "production is unhealthy" signal is the next thing to fix (gap analysis item,
  ~half a day). Rollback stays one click.

**BUILD WAIT DIAGNOSED AND CUT (2026-08-29, same day). Owner: "compiling always
takes too long."** CLAUDE.md had carried "DuckDB builds natively TWICE here
(~40-60 min each)" as an unexplained fact of life for months. Measured:
- **Root cause is an EGRESS POLICY DENIAL, not a slow compiler.** `duckdb`'s
  installer is `node-pre-gyp install --fallback-to-build`, which first tries
  `npm.duckdb.org` — a host this environment's proxy answers **403** to
  (`{"kind":"connect_rejected","host":"npm.duckdb.org:443"}` in its own status
  endpoint). `registry.npmjs.org` is allowed; that one is not. So the fallback
  fires every time.
- **node-gyp runs `make` with NO `-j` flag** — verified live: `make
  BUILDTYPE=Release -C build` with ONE `cc1plus` on a FOUR-core box. Setting
  `MAKEFLAGS=-j$(nproc)` took it to 5 concurrent compilers (measured, not
  assumed).
- **It compiled TWICE** because backend/ and packages/connectors/ are separate
  installs with separate node_modules (the root has no `workspaces` field).
- **`.claude/hooks/session-start.sh` (new)** fixes all three: MAKEFLAGS
  parallelism; the connectors install runs `--ignore-scripts` and COPIES the
  backend's compiled binary (guarded on both resolving the identical DuckDB
  version — on divergence it warns and builds properly, because a mismatched
  binary is worse than a slow one); and it runs at SESSION START, so the
  container snapshot taken afterwards already holds node_modules and later
  sessions start ready. It also boots Postgres with the `databridge` /
  `databridge_app` roles and `databridge_test` DB the suite expects, and writes
  `DATABASE_URL` / `JWT_SECRET` / empty `NEO4J_URI` to `$CLAUDE_ENV_FILE` —
  the manual setup every prior session repeated by hand. `.claude/settings.json`
  registers it. Guarded on `CLAUDE_CODE_REMOTE` so local machines are untouched.
- **Two more things the same investigation turned up, both correcting the
  record.** (a) **The sandbox runs a different Node than the product.** Both
  Dockerfiles are `FROM node:20` and all eleven CI jobs pin `node-version: 20`;
  the image ships Node 22. `.nvmrc` added and both scripts now select 20 — a
  local run on a Node the product never executes on is not evidence about the
  product. (b) **THE BACKEND SUITE NEEDS `knex migrate:latest` RUN BEFORE
  VITEST, and nothing said so.** CI has that step; a local run without it fails
  24 times with `relation "users" does not exist` PLUS one misleading
  `SyntaxError: 'knex' does not provide an export named 'Knex'` — which is the
  knex migrator failing to load a `.ts` migration through vitest's module
  runner, i.e. `migrateTestDb()` cannot migrate a fresh database from inside
  the suite. The hook now runs the migration. **Recorded because the wrong
  diagnosis was reached twice**: the SyntaxError looks like a code or
  Node-version problem and is neither.
- **Measured, on this 4-core sandbox**: hook 0.1s warm / 3.4s from a stopped
  Postgres and a dropped database (73 tables migrated). Full backend suite
  **43 files / 426 passed / 4 skipped** on Node 20 — the first time this
  session's work has been run against the suite at all.
- **The real fix is NOT in this repo**: allowing `npm.duckdb.org` through the
  egress policy makes the download take seconds. Reported, not routed around
  (the proxy README requires that). **The durable repo-side alternative** if the
  block is permanent: migrate off legacy `duckdb`/`duckdb-async` to
  `@duckdb/node-api`, whose binaries ship as ordinary npm packages from the
  ALLOWED registry and never compile — a real migration of the query engine's
  client library, wanting its own slice. Written up in `docs/DEV_TOOLING.md` §5.

**Prior last updated:** 2026-08-28 (NAV RAIL + THREAD LIST RESTYLED to the owner's
mockups — frontend presentation only, third slice of the day)

**THE RAIL AND THE THREAD LIST NOW MATCH THE OWNER'S MOCKUPS (2026-08-28,
frontend-only; two mockups + a screenshot of today, owner: "I want the
sidebar to look like this and the Ask AI. Don't mind the colour, just how
it looks compared to today").** Presentation only — no routes, roles, IA or
data changed, and every nav entry that existed still exists.
- **`IconRail` is light chrome now** (`bg-soft`, `border-r border-line`)
  instead of a block of ocean blue. The mockup's palette is warm cream; the
  owner said the colour is not the point, so the rail uses the app's own
  neutral tokens rather than a second palette nobody else in the product
  speaks. **Second pass, same day, from the owner's live screenshot ("a bit
  darker … text and icons a bit closer"): the rail went `--surface` →
  `--soft`, and with a deeper rail the ACTIVE ROW BECAME WHITE
  (`bg-raised`) instead of an ocean tint** — that inversion is the mockup's
  actual move, and it is why "you are here" reads at a glance; the badge
  and the collapsed-rail dot follow it (`bg-raised`, ring on `--soft`,
  since `bg-soft` is now the rail's own colour). Icon↔label gap 12 → 8px.
- **Full-bleed rows with a LEFT ACCENT BAR** replace the inset white/15
  pill: `border-l-2 border-ocean` + `bg-ocean-softer` + ink text, rows
  spanning the rail edge to edge so the bar sits flush against it. This is
  deliberately the same vocabulary the thread list two panels over already
  used — the two panels now read as one surface.
- Icons 14→16px, labels 13.5→14px, group eyebrows in `muted-2` at
  `tracking-[0.14em]`. **The disclosure chevron on Studio/Settings only
  shows on hover while the group is OPEN** (an open group should read as a
  plain eyebrow, not a control) and stays visible when CLOSED — there it is
  the only sign that rows are hidden. Collapsible groups, persisted
  width/collapse state, badges and the attention dot all behave as before;
  the badge is `bg-soft/ink-3` (ocean-on-white when active) and the
  collapsed-rail dot is now positioned off a `relative` row instead of the
  old margin hack.
- **Two labels shortened to the mockup's**: `Ask AI` → **Ask**,
  `Data Catalog` → **Catalog**. Nothing was removed from the rail — the
  mockup omits Notebooks / Your tables / Relations / Suggestions / Settings,
  but those are live pages and dropping their door would strand them.
- **`ChatSidebar` is the THREAD list**: eyebrow "Threads", a ghost
  `+ New thread` button (bordered, not a filled ocean block — starting a
  thread is not the loudest thing on the panel), and **titles wrap to two
  lines** (`line-clamp-2`, 14px) instead of truncating at one: a thread
  title is a QUESTION, and "Which suppliers have the highest…" is
  unidentifiable without its tail. Age moves under the title in the mono
  eyebrow. The `SHOW STARRED` row is gone as a row — the filter is now a
  star icon toggle on the eyebrow line (it is a lens on the list, not an
  action of the same weight as "new thread"); the per-row star/delete
  actions stay in flow so a wrapping title never runs under them.
- The mobile threads slide-over lost its own "All conversations" title
  (ChatSidebar supplies the heading now) — the header is just the close
  button; the dialog's `aria-label` says "Threads".
- Validation: frontend `tsc` clean, touched files lint-clean (the one
  warning is pre-existing on an untouched line of `query/page.tsx`),
  `next build` green (`/query` 40.5 kB / 374 kB, unchanged). Verified
  VISUALLY, not just by build: a throwaway `/dev/nav` harness rendered the
  rail + thread list with fixtures under a faked admin token and was
  screenshotted in real Chromium (expanded and collapsed), then deleted.

**Prior last updated:** 2026-08-28 (ASK AI WORKSHEET PHASES 5–8 SHIPPED — the brief is fully implemented; same day as phases 1–4 below)

**WORKSHEET PHASES 5–8 ARE BUILT (2026-08-28, second slice of the day; the
brief in `docs/backlog/ask-ai-worksheet.md` is now FULLY implemented):**
- **STRUCTURED ASSUMPTIONS — chips are CONTROLS now (§4.3).** All four
  NL→SQL prompts changed contract: `assumptions` entries are OBJECTS
  `{label, detail, options[{value,label}], value, silent}` — options are
  the 2–4 plausible interpretations INCLUDING the chosen one; material
  assumptions `silent:false` (chips), plus up to 3 ROUTINE defaults
  (time window, status filter) `silent:true` behind **"+ add"**.
  `AIService.defaultSubScores` (now exported) parses TOLERANTLY — strings,
  objects, garbage, mixed option shapes; caps 8×6; silent entries are
  EXCLUDED from the legacy `assumptions` label list so every existing
  consumer (persisted meta, repair context, exports) is unchanged; the
  structure rides new `assumption_details` → wire `assumptionDetails` on
  all four done-payload sites → `Message.assumptionDetails` (persisted in
  meta, restored on load). 5 new tests in `assumption-normalize.test.ts`.
- **Branch on change**: `AssumptionChips.tsx` — chip menus (detail as help
  text, options as menuitemradio, outside-click/Escape close); picking a
  different option calls `branchWithAssumption`: SAME question text, a new
  child of the selected step, label auto-set to the DIFF ("Same, drafts
  included"). The mechanism is `/query/think`'s new **`directive`** field
  (Zod ≤600): folded into the text the GENERATOR sees only
  (`effectiveQuestion`) — the stored/displayed question, query_log and the
  verified-check all keep the user's own words. Chips without options
  (legacy strings, old persisted answers) fall back to the sentence
  re-ask. No per-option SQL patches — the re-generate-with-pin approach
  from the mapping doc.
- **Re-run ↻ (§4.4)**: on the receipt line — same question against current
  data as a new SIBLING labelled "{label} (re-run)"; the model reads the
  RE-RUN STEP's own ancestor path (historyParent = the step, treeParent =
  its parent — send() gained `SendOpts {directive, labelOverride,
  treeParent, historyParentServerId}` decoupling the tree edge from the
  history anchor). **"newer data available"** appears in warn colour when
  the snapshot's data_as_of lags the newest warehouse refresh by >24h.
  Never a silent refresh.
- **Star + inline rename (§4.5)**: spine rows get a hover star (PATCH
  starred — starred steps are exempt from collapsing) and double-click
  rename (Enter commits, Escape cancels, empty PATCHes label:null which
  reverts to the auto label).
- **Collapsing (§4.6)**: pure `collapseSpine` in steps.ts — above 12
  steps, keep the first, the selection + its NEAREST TWO ancestors, the
  last three, starred and pending; consecutive hidden steps fold to one
  "N earlier steps" row expanding in place. **Recorded deviation:** the
  brief says "and its ancestors", but in a linear thread EVERY earlier
  step is an ancestor of the leaf, so keep-all would mean collapsing
  never fires for the most common shape — contradicting the brief's own
  example. Verified by dry-run (linear, tree, expand, under-threshold).
- **Responsive (§1)**: spine + toggle at `md:`; below 768px a horizontal
  step-chip scroller above the canvas.
- **States (§5)**: empty result → "No rows matched. Try widening the date
  range or removing an assumption." (dashed card; the chips above are the
  cause); error steps get a **Retry** button (re-ask as a SIBLING — the
  failure stays in the spine with its warn dot).
- **LANDING + HISTORY REWORKED (same day, owner feedback from first live
  use: "Ask AI just opens the latest chat… history is hidden behind 'All
  Conversations'").** Ask AI now ALWAYS lands on the fresh ask pane —
  never auto-opened into the most recent thread (`?t=` deep links still
  restore; clicking the nav entry while ON /query is detected via the
  router-visible search params and resets too). **The rail carries
  history**: thread list (ChatSidebar, 260px) when no thread is open or
  via "← threads"; the step spine (220px) while working one — so history
  sits next to the landing instead of behind a slide-over. The slide-over
  is MOBILE-ONLY now; "+ New thread" in the top strip; `freshPane()`
  replaced startNewConversation (no more empty server-side conversation
  rows — send() creates the thread on the first question); deleting the
  active thread lands on the fresh pane. Side effect, intended:
  `?q=&autoSubmit=1` deep links now ask in a NEW thread instead of
  appending to whichever conversation happened to be most recent.
- Validation: backend `npm run check` clean; **suite 42 files / 408
  passed** (5 new); all eight ratchets green (per-ratchet exit codes,
  repo root); frontend `tsc` clean, lint clean, `next build` green
  (`/query` 40.5 kB / 374 kB).

**Prior last updated:** 2026-08-28 (ASK AI WORKSHEET PHASES 1–4 SHIPPED — steps as a tree, spine + one-step canvas, branching on ask)

**THE WORKSHEET IS LIVE ON /query — PHASES 1–4 OF THE OWNER'S BRIEF
(2026-08-28, owner: "Let's go"; brief + mapping in
`docs/backlog/ask-ai-worksheet.md`, which marks what shipped).** A
question+answer is a STEP (frozen snapshot) in a TREE; the canvas renders
ONE step; the 220px spine holds the history. Phases 5–8 (assumption
option menus + branching on change, re-run/star, collapsing/inline
rename/responsive breakpoints, state polish) are the NEXT slice.
- **Migration 84** (`conversation_messages`): `parent_message_id`
  (self-FK, SET NULL), `label` (NULL = client-derived auto label),
  `starred`, `data_as_of` (warehouse freshness AT ASK TIME, from the
  answer's oldest source) + `(conversation_id, parent_message_id)` index.
  NO ordered array / path column — the brief's §3 rule; tree derives from
  parentId, siblings order by created_at.
- **Routes**: POST messages accepts `parentMessageId` (must belong to the
  SAME conversation → 400, else the tree silently corrupts), `label`,
  `dataAsOf`; PATCH messages accepts `label` (null reverts to auto) +
  `starred`. **`/query/think` accepts `parentMessageId`** and switches
  follow-up context to `loadStepAncestorHistory` — the ancestor path
  walked via parent_message_id, never the conversation's linear tail
  (after a branch the tail belongs to a DIFFERENT line of questioning);
  `historyEntry` (methodology splice) extracted and shared. A branch has
  history, so it never hits the verified-question fast path — correct.
- **`app/query/steps.ts` (pure)**: `deriveSteps` — parent resolution
  stored-server-id → session-local-id → LEGACY CHAINING (a parentless
  step that isn't its thread's first chains to the previous step: every
  pre-worksheet conversation opens as a straight spine, zero data
  rewrite); `flattenSteps` (DFS = spine order), `autoLabel` (drop EN+NL
  interrogatives, 32-char word-boundary cap — "Why?" can't label as
  empty), `countBranches`, `oldestSourceDate`. Verified by dry-run:
  legacy chain, explicit tree, pending-by-local-id, mixed legacy+branch.
- **`StepSpine.tsx`**: role=tree/treeitem + aria-level/selected, roving
  tabindex, ↑/↓/Home/End (selection follows focus), indent capped at 3
  with dashed rule, steps AFTER the selection render muted (descendants
  never hidden), pulsing dot on the pending step, warn dot on
  error/blocked steps, "+ branch here" under the selection (focuses the
  input), "N steps · M branches" footer.
- **The page** (`app/query/page.tsx`): spine (collapsible, persisted,
  <1100px starts closed) + canvas (max 880px) + ask input stuck to the
  canvas column; placeholder flips to "Ask from here — this will branch"
  and a banner names it on non-leaf steps. **Branching**: the new step is
  a CHILD of the step selected at send time (captured via ref), on every
  path — think/forecast/cross-view/investigate AND error steps (which
  join the tree with a warn dot instead of vanishing). The PENDING step
  is a synthetic assistant message injected into the derivation so it
  takes its true tree position; its canvas = question + the live
  progress timeline (`bare` ThinkingBubble/ThinkingPanel). `landStep`
  selects the answer when it arrives — including out of the repair
  hold's three exits. **URL**: `?t=<thread>&s=<step server id>` written
  with pushState (step moves) / replaceState (thread moves) directly —
  invisible to Next's router; popstate re-selects, so back walks steps;
  deep links restore thread + step. **The conversation list left the
  page** (the brief's space-buying move): ChatSidebar now mounts in an
  "All conversations" slide-over.
- **MessageBubble `canvas` prop**: full-width variants, assumptions
  suppressed in the card — the canvas renders them as the "reading" chip
  row under the serif-italic question; a chip click re-asks with that
  assumption changed, which BRANCHES from the selected step by
  construction. Role model untouched: SQL affordances stay canSeeSql.
- Validation: backend `npm run check` clean; **suite 41 files / 403
  passed** (3 new: parent/label/dataAsOf round-trip, cross-conversation
  parent 400, rename/star + label-null revert); all eight ratchets green
  (real exit codes, repo root); frontend `tsc` clean, lint clean, `next
  build` green (`/query` 37.5 kB / 371 kB).

**Prior last updated:** 2026-08-28 (ASK AI WORKSHEET — owner's build brief transcribed + implementation mapping; doc only, awaiting go-ahead)

**NEW DOC: `docs/backlog/ask-ai-worksheet.md` (2026-08-28, doc only; no
code changed).** The owner delivered a full build brief (PDF + two
mockups) replacing the stacked chat on /query with a **worksheet**: a
question+answer is a STEP (frozen snapshot of question, assumptions,
result, SQL, data-as-of), steps form a TREE (branch on ask-from-earlier
or on assumption change), a 220px thread spine on the left, ONE canvas
rendering one step at a time, assumption CHIPS as controls with option
menus (+ add exposes silently-resolved assumptions), frozen snapshots
with explicit re-run (never silently refresh), auto-labels, collapsing
above 12 steps, full tree a11y. Part 1 of the doc is the brief verbatim
in substance; **Part 2 is the implementation mapping**: verdict (this is
the structural fix for the "long chat" pain R1–R3 treated symptomatically
— and nothing shipped this week fights it: meta persistence IS the
snapshot, the quieted receipt IS the step footer, R3 actions are step
actions), the exists/gap table (conversation_messages needs only
parent_message_id/label/starred/data_as_of), **the one genuinely new
backend piece — STRUCTURED assumptions** ({label, detail, options,
value} incl. silently-resolved; recommendation: re-generate with the
changed assumption pinned + tolerant parsing, not per-option SQL
patches), proposed answers where the spec is silent (repair maps onto
the loading state and updates the SAME step; clarify is not a step;
investigate/forecast are step kinds; canSeeSql gating carries over
untouched; legacy conversations chain linearly at read time; keep
/query URL with t/s params), sizing (phases 1–4 ≈ one R1+R2-scale
slice; 5–8 a second), and what NOT to do (no ordered array — tree from
parentId; no branch-to-thread/diff/reorder; don't rebuild charts).
Owner's build order adopted as-is: **ship 1–4 before touching 5**.

**Prior last updated:** 2026-08-27 (ASK AI RELEASE 3 "ANSWERS GO SOMEWHERE" SHIPPED — third slice of the same day; R1+R2 below are on main)

**ASK AI RELEASE 3 "ANSWERS GO SOMEWHERE" IS BUILT (2026-08-27; implements
the assessment's §6 R3 with the owner's §8.3 decision: verified-answer
matching is EXACT normalized match only). Answers are destinations now —
save, verify, pin, schedule, and the feedback loop closes into curation:**
- **Migration 83 (`saved_questions` + schedule/gap wiring):**
  `saved_questions` (canonical RLS dance; `normalized_question`, `sql`,
  `tables_used`/`visualization` jsonb, `connection_id`, `data_layer`,
  `verified`/`verified_by`/`verified_at`, `times_used`/`last_used_at`;
  UNIQUE `(tenant_id, connection_id, normalized_question)`);
  `email_schedules.dashboard_id` dropped NOT NULL + new `saved_question_id`
  FK + CHECK exactly-one-target; `definition_gaps.conversation_message_id`
  FK (SET NULL).
- **THE VERIFIED TIER — human-attributed trust, the strongest mark.**
  `services/savedQuestions.ts`: `normalizeQuestion` (lowercase, collapse
  whitespace, strip trailing punctuation — deliberately conservative, a
  false match serves someone else's SQL), `findVerifiedQuestion` (exact
  match, explicit tenant filter), `recordVerifiedUse`. `/query/think`
  checks it FIRST (fresh questions only, no conversation history): on a hit
  the approved SQL runs (policies still applied, product or source layer),
  the answer formats + sources resolve as usual, `done` carries
  `{verified: true, confidence: 1}`, and the trust line reads **"★ Verified
  by your team"**. ANY error falls through to normal generation
  (`log.warn`) — a verified row must never break the question it speeds up.
  Usage counter rides the ROOT pool, not the request trx (the
  shared-trx-catch ratchet caught the first version).
- **Routes `/api/saved-questions`** (list all roles; save all roles with
  `assertSafeReadQuery` at SAVE time — an unsafe query must never be
  stored, since verified rows bypass generation; `verified` honoured only
  for admin/analyst; 409 on normalized duplicate; PATCH `/:id/verify`
  admin+analyst; DELETE creator-or-curator; every mutation explicit
  tenant_id filter, foreign ids 404). All Zod-validated.
- **`POST /api/dashboards/pin-widget`** (Zod; widget type enum kpi_card |
  bar/line/stacked_bar/pie chart | data_table): appends a widget to an
  OWNED dashboard's spec or creates a new dashboard from the answer
  ("Pinned from Ask AI"). The widget SQL is derived CLIENT-side
  (`widgetFromMessage` in MessageBubble: single scalar → kpi_card `SELECT
  x AS value FROM (…) AS _pin`; viz hint bar/line/pie → label/value;
  stacked → +series; else data_table; identifiers double-quote-escaped,
  trailing semicolons stripped, hint keys used only when actually present
  in the result columns) and re-guarded SERVER-side. Zero AI calls.
- **Scheduled question emails**: `email_schedules` rows targeting a saved
  question; `reportEmailService.sendScheduledReport` branches to
  `sendScheduledQuestion` (runs the saved SQL on the right layer, optional
  AI summary, one-section HTML email). `emailSchedules` routes accept
  either target (exactly-one enforced + 404 on missing question);
  list leftJoins both and ships `saved_question_text`.
- **Answer card actions (MessageBubble)**: **Save question** (POST, states
  saving/saved/already-saved) and **Pin to dashboard** (popover: owned
  dashboards — filtered by the JWT sub — or "+ New dashboard from this
  answer"; after pinning the button becomes a link `/dashboards?id=N`).
  Both render only when the message has SQL and a concrete `c:` connection.
- **EmptyState is proactive now**: **"Since yesterday"** — today's morning
  brief bullets (GET /briefs/today, zero AI calls) as clickable doors →
  "Why did <label> change since yesterday?"; **"Your saved questions"** —
  the library, Verified badge first, click asks it; curators (the existing
  admin+analyst prop) get inline verify-toggle / delete / schedule
  (Daily/Weekly → POST /email-schedules with the caller's own email,
  08:00 cron).
- **The feedback loop closes on /gaps**: feedback gaps now show the answer
  the user was given (`message_answer` snippet via the R1 LEFT join), and
  a **"Fix & verify"** button saves question+SQL as a VERIFIED saved
  question (409 tolerated) then resolves the gap — thumbs-down →
  curation → the next asker gets the approved answer. `/reports/gaps`
  ships `message_question/answer/sql/query_layer/source_key`.
- **Investigate is on the rail** (gap analysis G10 closed): Uncover group,
  all roles, Search icon — the fully-built root-cause agent had ZERO nav
  links since it shipped.
- **CARD QUIETED + REASONING GIVEN SPACE (same day, owner feedback: "too
  much information … you really can't follow the reasoning").** (a) The
  default "✓ Checked against your data" mark is GONE — an always-on mark
  carries no signal; marks render only in the exceptional states (★
  Verified / ✓ Checked & corrected / △ Take with care). (b) "How I got
  this" is gone as an always-on expander: the receipt is ONE muted line —
  `From <sources, catalog-linked> · data as of <oldest> · Ns` — and the
  expander survives only when it has real content (repair trail "What I
  checked" for any role; confidence/SQL/reasoning for analyst+, renamed
  "Details"). A viewer on an ordinary answer sees no expander at all.
  (c) `ThinkingBubble`'s 2-line reasoning clamp became a fixed-height
  (max-h-40) AUTO-SCROLLING pane showing the FULL live stream pinned to
  the tail — followable, scrollback available, layout still bounded.
- **HOTFIX (same day): the Lint workflow was RED on main after the R3
  push** — `sendScheduledQuestion` added 2 internal dynamic imports
  (dynamic-import ratchet 92 vs baseline 90); the local run had masked
  the ratchet's exit code behind a tail pipe (LESSON: capture `rc=$?`
  per ratchet, and run them from the REPO ROOT). All three dynamic
  imports in `reportEmailService` are static now — which exposed and
  fixed a LATENT BUG: the dashboard-email product path passed the whole
  product ROW to `getProductWarehousePath`, whose signature changed to
  `connectionId` in the 2026-05-05 rebuild (hidden by the untyped
  dynamic import; that path was silently broken). **Baseline lowered
  90→89** per the covenant.
- Validation: backend `npm run check` clean; **full suite 41 files / 400
  passed** (12 new in `saved-questions.test.ts`: normalization, unsafe-SQL
  400 + nothing stored, viewer-verified silently false, normalized-dup
  409, tenant isolation as 404 on list/verify/delete, viewer 403s,
  pin-widget create/append/foreign-404/unsafe-400); all eight ratchets
  green (shared-trx-catch caught + fixed the verified-use counter on the
  request trx); frontend `tsc` clean, touched files lint-clean, `next
  build` green.

**Prior last updated:** 2026-08-27 (ASK AI RELEASES 1+2 SHIPPED — same day as the assessment below, which is their spec)

**ASK AI RELEASE 1 "TELL THE TRUTH" + RELEASE 2 "THE ANSWER CARD" ARE BUILT
(2026-08-27; implements the assessment's §6 R1+R2 with the owner's settled
§8 decisions: hold-then-provisional during repair (~10s), analyst sees SQL
per the role table, answers MIRROR the question's language).**
- **CORRECTED ANSWERS PERSIST NOW (the assessment's #1 defect).** Migration
  82 adds `conversation_messages.meta` (one JSONB bundle: assumptions,
  subScores, uncertaintyNotes, clarify intent/options, visualization,
  forecast, sources, answeredInMs, policyNotice, repairSummary — everything
  `persistMessage` used to DROP); new
  `PATCH /conversations/:id/messages/:messageId` (Zod, ownership via the
  conversation's user_id, meta MERGES so a repair can't wipe the original's
  assumptions, rows capped 200); **`/query/repair` persists its correction
  SERVER-SIDE** (new `conversationId`+`messageServerId` body params,
  `persisted` flag in `revised_answer`; client PATCHes as fallback) — reload
  and export now show the corrected truth. Repair events are role-gated ON
  THE WIRE (viewers get narrative + row counts; SQL/rows/raw-DB-errors only
  to admin+analyst, errors as gated `detail` fields).
- **Feedback gaps are reachable**: `/reports/gaps` LEFT-joins query_log
  (thumbs-down gaps have NULL query_log_id and were structurally invisible);
  gaps page leads with gap_description when question_text is null; 👎 now
  collects an optional comment (column existed, no UI ever asked); feedback
  works on blocked cards too.
- **`applyDataPolicies` runs on ALL FIVE query paths** (was 1 of 5): POST /
  both layers, /think both layers, /repair revised SQL, /cross-view,
  /forecast — and `policyNotice` is finally rendered. Zod schemas on
  /think, /repair, /cross-view, /forecast (validate-coverage ratchet
  improved 166→160 unvalidated; **baseline LOWERED to 160**). Pre-flight
  diagnostic SQL gained SAFE_IDENT guards + backslash-literal skip.
- **Wire leaks closed**: `generateSqlStreaming`'s raw-JSON `text` deltas no
  longer forwarded (full SQL streamed to every role and was discarded);
  `sql_ready` emits only AFTER the safety gate and only to admin+analyst;
  new `tables` event (names only) for every role feeds the timeline;
  blocked payloads carry sql only for privileged + `adminNotified: true`
  (notifyAdmins now fires on ALL blocked paths, was 1 of 4).
- **Role model fixed**: `/query` uses `lib/role.ts` — `canSeeSql` =
  admin+analyst gates SQL/confidence detail/error detail/source toggle
  (analysts were treated as viewers); debug panel stays admin-only;
  `InvestigationView` takes REQUIRED `canSeeSql` (it showed raw SQL to
  every role — non-negotiable violation; both call sites updated).
- **THE ANSWER CARD** (`MessageBubble.tsx` redesign): categorical trust
  line for all roles — `✓ Checked against your data` / `✓ Checked &
  corrected` / `△ Take with care` + answer-scoped **`Data as of …`**
  (OLDEST source, coloured by ITS freshness) + `answered in Ns` — never a
  numeric % for business users in either direction (refusal cards no longer
  show confidence/sub-scores to viewers; they say "your admin has been
  notified"). **"How I got this"** collapsed expander: humanized source
  links to `/catalog?table=` (WidgetProvenance's pattern) with per-table
  freshness, "What I checked" (repairSummary), and — analyst+ one level
  deeper — confidence + sub-scores + layer + SQL + raw reasoning (the
  brain-bubble that showed raw CoT to every role is GONE). Assumptions are
  CLICKABLE CHIPS (click re-asks with that assumption flipped);
  single-value answers render as a big KPI number (not a one-cell table);
  the data table COLLAPSES behind "Show the N rows" when a chart is shown;
  markdown-lite prose (`RichText`); deterministic follow-up chips; per-
  message export filenames; confirm on delete/clear.
- **THE PROGRESS TIMELINE** (`thinking.tsx` rewrite): named domain-language
  steps (Understanding your question → Looking at <humanized tables> →
  Running the numbers → Writing the answer) with a bounded 2-line live
  reasoning tail — the 220ms/word reveal is gone; phase strings de-jargoned
  server-side ("star schema" no longer reaches viewers; "Writing the
  answer…"). **Repair = "Double-checking"**: new answers flagged by the
  validator are HELD up to 10s (`RepairState.holdMsg`/`revealed`,
  authoritative copy in a ref) — settle inside the hold and the answer
  appears ONCE, already corrected; run long and it reveals marked "△ Being
  double-checked"; the panel disappears once settled (the card's trust line
  + What-I-checked are the receipt — a corrected answer costs one card, not
  ~2,000px). Clarifications answered inline no longer wipe the trail.
- **Dutch**: all four NL→SQL prompts + answer formatter + repair prompt
  mirror the question's language (SQL/aliases stay English — the UI formats
  by suffix); Dutch investigate patterns (`waarom`, `hoe komt het`…) and
  forecast keywords (`voorspel`, `prognose`…); bare `project` keyword
  REMOVED (matched "projects"); ONE locale (nl-BE) across KPI tiles, chart
  axes, forecast tooltip. `formatAnswer` runs temperature 0 and is told the
  TRUE row count. New `resolveAnswerSources()` in `routes/query.ts` (no AI,
  explicit tenant filters) ships per-answer source freshness; the tenant-
  wide banner now shows the OLDEST date coloured consistently.
- Validation: backend `npm run check` clean; **full suite 40 files / 388
  passed** (5 new in `conversations-meta.test.ts`: meta round-trip, PATCH
  merge semantics + 200-row cap + foreign-user 404/empty 400, feedback gap
  visible via LEFT join); all eight ratchets green; 83 migrations on a
  fresh DB; frontend `tsc` + lint clean, `next build` green (`/query`
  30.8 kB / 364 kB). SANDBOX NOTE: DuckDB builds natively TWICE here
  (backend + packages/connectors, ~40-60 min each on shared CPU); the
  connectors `dist` can be tsc-built before its native build finishes, and
  the backend's built `duckdb.node` (same version) can be COPIED to
  `packages/connectors/node_modules/duckdb/lib/binding/` to unblock the
  suite.
- **NOT in this slice** (assessment §6 R3 + deferred): pin-to-dashboard,
  saved/Verified/scheduled questions, feedback→curation queue, "Since
  yesterday" proactive empty state, investigate nav link, structured
  `interpretation` field (assumption chips approximate it), server-side
  intent classification, entity pre-flight on the product layer,
  context-builder consolidation, chat on the SQL cache.

**Prior last updated:** 2026-08-27 (Ask AI experience assessment — doc only; same day as data experience Release B)

**NEW DOC: `docs/backlog/ask-ai-experience-assessment.md` (2026-08-27, doc
only; no code changed).** Owner asked for a zoomed-out assessment of the Ask
AI chat: what an optimal experience looks like, how to show reasoning/
assumptions/trust, and how to fix the named pain that a self-correcting
answer produces "a really long chat and think process". Method: three full
code investigations (frontend surface, backend flow, trust adjacencies —
every claim file:line) crossed with 2025–26 external research (Genie, Spotter
3, Cortex Analyst/Snowflake Intelligence, QuickSight Q, Power BI Copilot,
Tableau Pulse, Perplexity/ChatGPT reasoning display, NN/g + PAIR trust
research). **Verdict: the engine is ahead of the experience** — Clarion
already computes nearly every trust signal the leaders display (assumptions,
sub-scores, tables used, streamed reasoning, repair loop, per-table
freshness, provenance ladder, lineage) and shows them to the wrong people at
the wrong moments. Headline findings: **trust display is inverted**
(confidence + sub-scores shown to ALL roles on refusals, admin-only on
success — `MessageBubble.tsx:1094` vs `:959`; industry shows business users
categorical marks, never percentages); **corrected answers are never
persisted** (reload resurrects the wrong answer, export downloads
pre-correction rows) while the repair transcript runs ~1,500–2,500px and
never collapses; **thumbs-down gaps are structurally invisible** (NULL
`query_log_id` vs inner join in `/reports/gaps`); **analysts are treated as
viewers** (`isAdmin` keys everything, `lib/role.ts` unused);
`InvestigationView` shows raw SQL to every role (non-negotiable violation);
`applyDataPolicies` runs on 1 of 5 query paths; the chat never uses the SQL
cache; no prompt answers in the user's language (Dutch questions get English
answers); three parallel context-builder implementations have drifted. §5
designs the target: ONE answer card (interpretation chips à la QuickSight
restatement, categorical trust line Checked/Verified/Take-with-care,
answer-scoped freshness via the already-built `widget-context` endpoint,
"How I got this" plain-language expander with humanized catalog links, SQL
one level deeper for analyst+), ONE progress timeline (Perplexity-style named
steps → collapsed "Answered in 9s · checked" receipt), repair folded in as a
"Double-checking" step framed as diligence (Spotter pattern), one
clarification system, answers-as-destinations (pin to dashboard, saved +
Verified questions, schedule, feedback→curation), Dutch answer mirroring,
"Since yesterday" proactive empty state from the existing briefs endpoint.
§6 sequences three releases (1 tell-the-truth foundations, 2 the answer
card, 3 answers go somewhere); §7 what NOT to do (no raw CoT ever, no
numeric confidence for business users, don't hide that correction happened,
no agent-workspace chrome); §8 queues 4 owner decisions (provisional-answer
policy during repair, analyst SQL visibility, verified-answer matching
scope, language default). Published as artifact "Ask AI Experience". No code
changed.

**Prior last updated:** 2026-08-27 (data experience Release B "One page per thing" SHIPPED — same day as Release A)

**DATA EXPERIENCE RELEASE B IS BUILT (2026-08-27, frontend-only; implements
the consolidation plan's §5 Release B — the component merges. The catalog
now has ONE table page and ONE product page, whatever door you came
through):**
- **ONE TABLE PAGE: `ProductTableDetailPanel` is the merged panel.**
  Structure-tree clicks, Browse reference cards and `?refTableId`/`?table=`
  deep links all land on it. It gained: **dual-id lookup** (the incoming
  tableId may be a GRAPH id from the tree or a POSTGRES id from cards/deep
  links — matched against `id` OR the tree's `pg_table_id`, and the panel's
  data fetches use `pgTableId ?? tableId`); **sample rows FIRST** on
  Overview (PreviewTable on `/semantic/product-preview`, all roles per the
  Release A decision); a `compact` mode for the 480px cards inset
  (Overview + Columns only, wide tabs snap back, a **Full view** button
  wired to the parent's full-screen expansion); a "Reference data ·
  <product>" / "Product table · <product>" eyebrow; a read-only "What is
  this?" card for viewers with curator editing (and the SQL viewer, last,
  `curator && !compact`) intact. PATCHes still send the graph id — the
  Release A `GRAPH_ID_ALIAS` gate accepts both.
- **`ReferenceDetailPanel.tsx` is DELETED** (the second, read-only,
  role-blind table panel). `EntityDetailPanel`'s `reference-table` scope now
  routes to `ProductTableLoader`, whose fetch is **sequential on purpose**:
  product-tree first, resolve the graph id (`t.id === tableId ||
  t.pg_table_id === tableId`), THEN `/semantic/product-columns` with the
  resolved graph id — because that endpoint matches graph ids only, while
  reference cards hand over Postgres ids.
- **ONE PRODUCT PAGE: `ProductFullView` everywhere in the catalog.**
  `EntityDetailPanel`'s product-root non-preview branch (Structure mode) and
  `ProductPreviewPanel`'s "Open full view" both render it;
  **`ProductRootPanel` no longer mounts anywhere under /catalog** (its
  inline-fallback block in ProductPreviewPanel is deleted; the workshop
  keeps it at `/products/[id]`, reachable via the curator "Open in Build"
  link — trimming the workshop itself is Release C work).
  ProductPreviewPanel's At-a-glance swapped the "Dimensions" column-role
  count (warehouse vocabulary, answered nothing) for an **"Updated"** cell;
  `Stat` accepts strings now.
- **`lib/humanize.ts` (new)** — the ONE raw-name → business-label rule
  (`humanizeTableName`, `looksLikeRawTableName`). Used by the dashboard
  filter-provenance popover (its local copy deleted), `ReferenceCard` and
  `/shared-data` cards, so a stored raw `dim_*` display name can no longer
  reach a business user.
- **Vocabulary sweep**: the catalog hero counts say "N sources · N subjects
  · N reference tables" (was "analytics"/"dimensions");
  `ProductFullView`'s private `QualityTab` renamed `CatalogQualityTab`
  (name-collided with the workshop's `app/products/QualityTab`); every
  stale ProductRootPanel/ReferenceDetailPanel comment in the catalog
  updated.
- **Deviations from the plan's letter, recorded in the doc**: workshop
  Overview/Tables tabs NOT trimmed (Release C decides what the workshop
  keeps); no grain card (the graph payload has no `business_grain`);
  otherwise per plan.
- Validation: frontend `tsc` clean, touched files lint-clean, `next build`
  green (`/catalog` 54.8 kB / 370 kB, `/shared-data` 1.95 kB); backend
  untouched this slice — `npm run check` clean and all eight ratchets green
  re-confirmed on the same tree (full suite unchanged from Release A's 39
  files / 383 passed).
- **NOT in this slice**: Release C (the Manage-mode ↔ workshop cockpit
  merge; notebook pane survives it by owner constraint).

**Prior last updated:** 2026-08-27 (data experience Release A "Every door leads somewhere true" SHIPPED)

**DATA EXPERIENCE RELEASE A IS BUILT (2026-08-27, same day as the plan
below; implements its §5 Release A with the owner's settled decisions:
sample rows ALL ROLES, Structure tree stays, notebook pane NEVER deleted —
"it earns its keep"). All deterministic, zero AI calls:**
- **Shared-data cards now land on the Data Catalog for EVERY role**
  (`/catalog?refTableId=<id>`) — was: curators → the build workshop
  (broken anyway for display-named tables), viewers → a dead `<div>`.
- **`/catalog` deep links work**: new one-shot restore effect resolves
  `?refTableId=<product_tables id>` AND `?table=<name>` (matched against
  the new `tableName` on by-source reference cards + display name) once
  the catalog feed loads, landing on the FULL reference view (sample rows
  included); an unmatched `?table=` (fact/rollup) falls back to prefilled
  catalog search instead of a dead end.
- **`/semantic/product-preview` is ALL ROLES now** (owner decision —
  Ask AI already serves viewers the same rows; the non-negotiable is
  about SQL, not data). Kills the 403-as-UX on ProductFullView's and
  ReferenceDetailPanel's Sample surfaces. Tenant scoping unchanged.
- **The trust loop closes from the dashboard**: the filter provenance "?"
  popover gained "View <table> in the Data Catalog →"
  (`/catalog?table=`), and WidgetProvenance's product-table chips are
  links now. Build's finish card gained "See your subjects →".
- **Dead ends removed**: the workshop's stale "Tip" card (claimed a chat
  that never mounts) deleted; ProductFullView's "Edit in notebook →"
  now curator-gated (isCurator threaded through TablesTab/TableRow);
  stale header comments fixed (`products/[id]/page.tsx` "all 6 tabs",
  ReferenceDetailPanel's phantom editing claim — now points at the
  Release B merge).
- Validation: backend check clean, full suite **39 files / 383 passed**,
  all eight ratchets green, frontend tsc + lint (touched files, incl.
  removing catalog/page.tsx's pre-existing unused ProductCardGrid
  import) + `next build` green.
- **NOT in this slice**: Release B component merges (one product page,
  one table page, Structure driving shared panels) and Release C cockpit
  merge — see the plan below.

**Prior last updated:** 2026-08-27 (data experience consolidation plan — doc only; same day as the dual-id fix below)

**NEW DOC: `docs/backlog/data-experience-consolidation.md` (2026-08-27, doc
only; no code changed).** Owner, after walking the Reference/Item flow live:
too many panes/views on the same data; likes the Data Catalog; wants ONE
coherent flow. Method: full code inventory of every product-layer
data-inspection surface (file:line). Measured: **~15 surfaces / 6+
components render the same product data** — the product overview exists 4×
(workshop OverviewSection, the SAME component re-rendered inside catalog
Structure via EntityDetailPanel, ProductPreviewPanel, ProductFullView; topic
layer a deliberate 5th), the tables list 5×, ONE reference table has TWO
different detail panels depending on the door (Structure tree →
ProductTableDetailPanel, editable+SQL; Browse card → ReferenceDetailPanel,
read-only, no role logic), Quality renders via 5 call sites (two components
both named QualityTab), lineage 3 ways. Worst routing: a Shared-data card
click lands CURATORS in the build workshop ("Operator surface",
Deploy/Refine/Delete, SQL-first) — broken anyway for display-named tables
(card passes display_name, ProductRootPanel matches table_name) — and gives
VIEWERS a dead <div>. Plus: `?refTableId` written but never read,
/semantic/product-preview is admin-only while two consumer panels advertise
Sample rows (403 as UX), the workshop Tip references a chat that never
mounts (embedAskAI=false at every call site), and NOTHING links into the
understanding surfaces from dashboards/Ask-AI-success/Build-finish/Home.
**Target model (§3): three surfaces, one page per thing, role layers
capability on the page** — Subjects stays as-is; the Data Catalog becomes
the ONE understanding surface (one merged product page, one merged table
page with SAMPLE ROWS FIRST, Structure demoted to a tree toggle driving the
same panels); the workshop keeps only surgery (notebook/deploy/rebuild) and
is never the landing of a content click. Re-asserts the 2026-08-18 IA rule
that later additions broke. §5 sequences: Release A routing+defect fixes
(D1–D10), Release B component merges, Release C the Manage-mode↔workshop
cockpit merge (owner decision queued, recommendation: Manage wins, absorbs
the notebook). §6 queues: sample-row visibility (recommend all roles —
Ask AI already serves viewers the same rows), cockpit merge direction,
Structure's survival. Published as artifact "One Door Per Thing".

**Prior last updated:** 2026-08-27 (catalog product tables were 404ing since the 2026-07-28 gate — dual-id fix + filter provenance)

**THE CATALOG'S PRODUCT TABLES WERE "TABLE NOT FOUND" SINCE 2026-07-28 —
FOUND FROM THE OWNER'S FIRST CLICK, FIXED (2026-08-27).** Owner clicked
Reference → Item in Data Catalog (Structure view) to verify a distrusted
dashboard filter value and got "Table not found". Root cause is an ID
VOCABULARY MISMATCH the tenant-isolation hardening never learned:
`productGraphSync` mints a SEPARATE graph id per product table/column
(`neo4j_pg_id`, from the shared semantic sequence so it can't collide with
source-table graph ids) and the graph node's `pgId` — the id every
catalog/product-tree payload surfaces — is that minted id, while
`denyUnlessOwned('product_tables', id)` (added 2026-07-28 in front of
`/semantic/product-columns`, PATCH product-tables/product-columns) checked it
against `product_tables.id`. Never matches → 404 → the frontend loader's
blanket catch → "Table not found" for EVERY product table, EVERY tenant —
including the catalog's product-column semantic editing, which CLAUDE.md
itself notes is the ONLY surface for that. This is EXACTLY the
"ownership-refused / gate rejecting legitimate traffic" signature
`.ops/prod-logs` watches for, flagged "unverified since 2026-07-28" — the
logs will show `ownership check refused` for product_tables. `/product-tables/
:id/sql` had already been patched for this individually (resolves
neo4j_pg_id first) — the pattern existed, the gate never got it. Fixes, all
deterministic (owner condition: no new AI calls — none of this calls AI):
- **`tenantOwnership.ts`**: `GRAPH_ID_ALIAS` — for `product_tables`/
  `product_columns`, `owns()`/`ownedIds()` match `id` OR `neo4j_pg_id`,
  tenant_id stays a top-level predicate either way (no widening — whichever
  column matches, the row must be the caller's tenant's). `ownedIds` returns
  the INPUT ids that matched. 5 new tests (13 total in the file) incl. the
  predicate-shape assertions.
- **`semanticCacheScope.ts`**: product_tables/product_columns resolution
  matches both id spaces, so catalog edits invalidate the right connection
  instead of degrading to the global-wipe fallback.
- **`/semantic/product-tree` now ships `pg_table_id`** per table (resolved
  server-side via `neo4j_pg_id` → id; works for existing data, no graph
  rewrite) — `ProductTableDetailPanel`'s `pg_table_id ?? tableId` fallback
  finally gets the real Postgres id, so product-preview, SQL viewer and
  lineage from the catalog work too. Both improve-description routes accept
  either id space (grouped orWhere; RLS still scopes).
- **Filter provenance "?" on the dashboard FilterBar** (the ideal-flow half:
  the doubt is born on the filter, so the answer lives on the filter): a
  popover per filter showing the humanized source table + field, the distinct
  values already loaded for the dropdown, and — when only ONE value exists,
  the owner's exact case ("Item group: Sales") — a pointer to check the field
  in the Data Catalog or ask AI. ZERO AI calls, zero extra fetches: renders
  the spec + already-loaded options.
- Validation: backend check clean, **full suite 39 files / 383 passed** (5
  new), all eight ratchets green, frontend tsc + lint + `next build` green.
- **Residual known gap, deliberate**: PATCH /semantic/product-tables|columns
  still write the GRAPH only (pre-existing dual-write gap, now merely
  reachable again); catalog Browse-mode reference cards use Postgres ids and
  never had the bug.

**Prior last updated:** 2026-08-26 (dashboard Release 1 "Trust the loop" SHIPPED + the assessment doc)

**DASHBOARD RELEASE 1 — "TRUST THE LOOP" IS BUILT (2026-08-26, same session
as the assessment below; implements its §5 Release 1 plus the owner's AI-call
policy).** Owner: *"what I don't want is AI calls every time I open a
dashboard. Maybe once in the creation … the AI summary at the top I want
triggerable."* Enforced in code, verified across every call site:
- **AI-CALL POLICY: creation fires AI once (generation + validation + the one
  automatic summary with real rows); OPENING A DASHBOARD MAKES ZERO AI
  CALLS.** The insights strip is stored in `spec.insights {items,
  generatedAt}` and rendered from the spec on open; it regenerates ONLY via
  the explicit Summarize button / the strip's refresh icon
  (`generateInsights`), which silently PATCHes the row on a saved owned
  dashboard (a summary refresh must not flip the toolbar to unsaved). The
  old auto-fire on every `!hasCachedData` execution is gone —
  `pendingInsightsRef` (set only by createDashboard) gates the one
  creation-time call. Explain/Fix/Story/refine were already button-only.
- **THE SAVE-FORK BUG IS FIXED**: `saveDashboard` PATCHes in place when the
  open dashboard is saved and owned (`PATCH /dashboards/:id` already accepted
  spec); non-owners still POST their own copy. Pinned by a route test that
  counts rows before/after.
- **Context restore on open**: `openDashboard` restores the row's
  `connection_id` (was: whatever connection happened to be selected — wrong
  SQL target + wrong refine context) and `spec.productIds` (new spec field,
  stamped server-side at generation; refine-spec prefers the spec's own stamp
  over client state). The connections-list default uses a functional set so
  it can't clobber a deep-link-restored connection.
- **Refinement answers are honest now**: sent as `{question, answer}` PAIRS
  (backend accepts legacy bare strings too), rendered into the prompt as
  `- <question> → <answer>`; new `FilterSpec.defaultPreset`
  (last_7/30/90_days, last_6/12_months, this_year, all_time) +
  `defaultValue`, instructed in the prompt, declared in the JSON output
  schema, and honoured by `buildDefaultFilters` — "Last 30 days" no longer
  silently becomes the hard-coded 1-year default.
- **Refine can't clobber the user's arrangement**: `layout` added to
  `DASHBOARD_SPEC_JSON_SCHEMA` and both prompts' preserve clauses, AND
  deterministically re-applied server-side by new pure
  `services/dashboardSpecMerge.ts` (`preserveSpecCarryover` — runs after the
  refine call AND after the repair call; also inherits productIds/dataLayer
  and drops stale insights). View mode: the all-or-nothing
  `allWidgetsHaveLayout` guard is replaced by `completeLayouts()` — one
  AI-added layout-less widget now packs BELOW the arranged ones instead of
  discarding the entire arrangement.
- **The restore-net moved to `dashboardSpecMerge.restoreDroppedWidgets`**
  (AIService imports it) and the remove-intent regex no longer matches bare
  `\bweg\b` (Dutch words like "onderweg"/"wegens" were silently disabling
  the net) — now `weghalen | haal … weg | verwijder | verberg | remove…`.
- **Refine feedback**: refine-spec returns `changes {added, modified,
  removed, filtersChanged}` (`diffSpecChanges`) and the chat replies
  "Updated — changed **Revenue trend**; added **Orders by region**." instead
  of a bare "Dashboard updated"; `widgetCacheRef` is cleared on refine so
  widgets show skeletons instead of pre-refine rows behind a pulse dot, and
  the stale summary disappears (Summarize regenerates on demand).
- **Plumbing**: `/dashboards?id=N` deep link works now (Home + palette emit
  it; read via `window.location` in a mount effect — no Suspense boundary);
  generate failure returns to refining/choosing WITH the answers intact
  (was: dumped to the empty hero); `beforeunload` guard while unsaved;
  filter-option dropdowns load in parallel; dead
  `selectedDomains`/`availableDomains` state deleted.
- **Hygiene**: `/generate` + `/refine-spec` got Zod schemas
  (`generateDashboardSchema`, `refineSpecSchema` — refine-spec was the one
  dashboard AI route trusting `currentSpec` as arbitrary JSON) and both now
  sit under `aiLimiter` (path-mounted before the router's `computeLimiter`).
- Validation: backend `npm run check` clean; **full suite 39 files / 378
  passed** (15 new: 10 in `dashboard-spec-merge.test.ts` incl. the Dutch
  remove-intent cases, 5 route tests for validation 400s + PATCH-spec
  in-place); all eight ratchets green (contract-sync included — both
  contract copies updated together); frontend `tsc` + lint clean, `next
  build` green (`/dashboards` 208 kB first-load, unchanged).
- **HOTFIX (2026-08-27, after the owner's first live generate failed):**
  `defaultPreset` is MODEL OUTPUT and the enum is only enforced when
  structured outputs are on — the model can emit e.g. `last_3_months` (the
  refinement chips literally say "Last 3 months") and the frontend's
  exhaustive switch returned `undefined` → `.toISOString()` threw → the
  generic "Failed to generate dashboard". `presetFrom` is now a TOLERANT
  string parser (regex on days/months/year/all, 12-month fallback — can
  never crash), `last_3_months` was added to the enum on all three surfaces
  (contract typed as a tolerated `string & {}` superset), and the create
  path's catch now surfaces the real error detail instead of a blind
  generic (backend already gates detail to admins). LESSON: any spec field
  the model writes must be parsed tolerantly at every consumer.
- **NOT in this slice** (assessment §5 Releases 2–3): DSL
  hero/sections/narrative/targets, conditional clarifying questions,
  generated suggestion chips, per-widget AI edits, version history.

**Prior last updated:** 2026-08-26 (dashboard experience assessment — doc only)

**NEW DOC: `docs/backlog/dashboard-experience-assessment.md` (2026-08-26, doc
only; no code changed).** Owner asked three questions about dashboard
generation: is the creation flow optimal, are the dashboards too generic (up
to "should the AI write HTML layouts?"), and does the change flow actually
work. Method: three full code investigations (creation flow, refine flow,
rendering layer — every claim carries file:line) crossed with external
research (Databricks AI/BI, Power BI Copilot, Tableau Pulse, Omni, Hex,
Luzmo, DashChat CHI 2026, VisEval/VisCoder2/DashArena). **Companion to
`dashboard-architecture-plan.md`, which stays the plan of record for the
rendering architecture; this doc covers the experience and found defects that
doc predates.** Verdicts: (1) creation flow's SHAPE is right (prompt →
optional questions → generate, matching industry) but the steering is
theater — refinement answers are sent as anonymous bullets detached from
their questions, nothing is schema-bound, and `buildDefaultFilters`
hard-codes a 1-year window that silently overrides a "Last 30 days" answer;
(2) the JSON-DSL architecture is right and AI-written HTML is measurably
worse (do NOT switch) — genericness comes from a too-poor DSL vocabulary: the
prompt hard-codes one skeleton ("4× kpi_card ALWAYS first"), `featured` is in
the JSON schema but absent from the prompt so it is never emitted, and there
is no hero/sections/narrative-widget/targets/semantic color; (3) the change
flow's entry point is good (persistent chat bar, explicit Edit/Ask toggle)
but the plumbing has the WORST bug found: **`saveDashboard` always POSTs —
saving after a refine creates a DUPLICATE dashboard and the original is never
updated** (`page.tsx:566-592`), plus reopened dashboards refine against the
wrong connection (connection_id returned but ignored) and every product
(productIds never persisted), refine can clobber Arrange layout (`layout`
absent from prompts + output schema, all-or-nothing view-mode guard), no undo
of any kind, stale widget cache + insights strip after refine. §4 is the
consolidated 15-defect list; §5 sequences three releases (1: trust-the-loop
bug fixes; 2: DSL vocabulary + hero-first recipe + Pulse-anatomy KPI card +
streamed generation; 3: conditional questions + schema-bound answers +
per-widget AI edits + version history + eval harness); §6 what NOT to do (no
AI-HTML, no wizard, no patch protocol yet, no theming engine). Published as
artifact "Dashboard Experience Assessment". No code changed.

**Prior last updated:** 2026-08-24 (topics canvas drew ZERO relations in production — stub rows were starving it; fixed at both ends)

**THE TOPICS CANVAS WAS EMPTY OF EDGES IN PRODUCTION — TWO-SIDED FIX
(2026-08-24).** Owner screenshot: `/relationships` → Topics showed every
table but not one line ("I don't see any relations for my topics, like I
have for my sources"). Root cause is a STATUS LIE about stubs, latent since
the bus-matrix flow shipped:
- **Every bus-matrix table load excludes stubs.** All six
  `runProductTransformation` call sites that feed the AI build/refresh
  flows load tables with `whereNotNull('transformation_sql')` — and a
  shared-dim STUB has `transformation_sql = null` by construction. So the
  runner's skip-path (`publishStubFromUpstream`, the thing that flips a
  stub to `'success'` and mirrors the owner's `delta_path`) was DEAD CODE
  in those flows: every stub sits at `transformation_status='draft'`
  forever. The built relationships reference the STUB's id (that is how
  buildBusMatrix persists a fact→shared-dim join), so `topics-graph`'s
  `transformation_status='success'` filter dropped the stub rows AND, via
  the both-endpoints `whereIn`, every fact→shared-dim edge with them.
  Zero relations, exactly as screenshotted. (Only `pipelines.ts` passed
  stubs — which is why the skip-path comment believed itself.)
- **Fix 1 — the six loads include stubs now**
  (`whereNotNull(transformation_sql) OR is_shared_dimension`):
  busMatrixOrchestrator ×4 (build, pipeline, refresh, extension),
  products/design.ts, products/build.ts. Stubs flow through the skip-path
  again, so statuses and mirrored `delta_path` become truthful on the next
  build/refresh. Safe by construction: the runner checks
  `is_shared_dimension` BEFORE touching SQL, and pipelines has always
  passed stubs through the same path.
- **Fix 2 — `topics-graph` no longer trusts the status for stubs** (works
  for EXISTING builds without a rebuild): stub rows ship regardless of
  their own status (a stub's realness derives from its owner), each table
  carries `isStub`, and the endpoint now also **derives name-level joins
  from `product_columns.fk_target_table/_column`** where no relationship
  row asserts them (negative ids mark derived edges) — the read-time twin
  of `synthesizeFkRelationships`, covering fact→dim_date in non-owning
  products (dim_date is deliberately never stubbed, so those rows could
  not be persisted) and pre-2026-08-20 builds. Join-surface endpoint
  columns are marked BY NAME across every copy of a table, so whichever
  copy the client's dedupe keeps carries the join fields.
- **`TopicsCanvas` groups shared dims under their OWNING topic**: dedupe
  prefers the owner copy over stubs (then richest), and the sidebar lists
  a shared dim once — under Reference, not under every topic that joins
  it (which fix 2's stub-shipping would otherwise have caused).
- Validation: backend `npm run check` clean; full suite **38 files / 363
  passed** (1 new in `managed-grids.test.ts`: draft-stub edge survives,
  fk-metadata join derived with negative id, asserted join not
  duplicated, both copies ship with `isStub`); all eight ratchets green;
  frontend `tsc` + lint + `next build` green (`/relationships` 2.82 kB).
- **Watch on the next production build/refresh**: stubs now enter the
  results list as success rows (cosmetic count change in "N ok"), and
  stub `dag_order` is NULL (sorts last; harmless — the skip-path only
  mirrors metadata).

**Prior last updated:** 2026-08-21 (MANAGED GRIDS SHIPPED — "Your tables", the in-Clarion spreadsheet place)

**MANAGED GRIDS — G5's IN-PRODUCT HALF IS BUILT (2026-08-21, same session as
the gap analysis).** Owner: *"a sort of spreadsheet place in Clarion that we
can use for mappings, budgets … that the user can edit in place in Clarion
itself"* — then, on the security question, the shared-vs-per-tenant-tables
discussion settled the design: **two fixed RLS-forced Postgres tables hold
every grid of every tenant; a grid's schema is CONTENT (`columns` JSONB),
its cells are JSONB rows — never dynamic DDL** (runtime CREATE TABLE would
need DDL rights on `databridge_app` and re-establish RLS per table, the
opposite of the 2026-08-06 hardening). Postgres is the truth users edit;
every save materialises to the warehouse where the grid is an ordinary
table. The integration is the ROLLUP pattern's four-surface contract applied
a second time:
- **Migration 81** (`managed_grids` + `managed_grid_rows`): canonical RLS
  dance (ENABLE+FORCE+`tenant_isolation` with the NULLIF predicate), tenant
  default from the session var, conditional app-role grants incl. sequences,
  unique `(tenant_id, slug)` — the slug is FIXED at creation (renames change
  display name only) because `grid_<slug>` is the view name saved dashboards
  reference. `tenant_id` deliberately denormalised onto rows: RLS needs it
  and `purgeTenant` enumerates BY tenant_id column (a rows table without one
  is silently skipped by GDPR purge).
- **`services/managedGrids.ts`**: pure derivation (slug/column keys, strict
  `^[a-z][a-z0-9_]*$`, total functions), row coercion that reads
  **spreadsheet-shaped values** — `parseFlexibleNumber` (`1.234,56` eu AND
  `1,234.56` en, currency symbols, the rightmost-separator rule) and
  `parseFlexibleDate` (`21/08/2026` day-first + ISO) — Belgian Excel paste
  must just work; caps (10k rows — fits the 2mb body limit; 40 cols; 2k
  chars/cell) with add-it-as-a-source guidance in the refusal. **Values are
  data end to end** (JSONB → NDJSON → `read_json(columns={…})`); only
  names/types interpolate, allow-list-checked twice (service + writer).
- **`materializeGrid` writes a VERSIONED DIRECTORY** —
  `gridBasePath(tenant, grid, version)` → `…/grids/grid_<id>_v<n>` — because
  the DuckDB pool key includes every registered path, so a new URI is a new
  key and **pooled-session staleness is structurally impossible** (the exact
  trap the integration agent flagged for overwrite-in-place); old version
  deleted best-effort after success; widget+filter caches invalidated local
  + `publishInvalidation`. Directory-not-file URI on purpose: **the Azure
  branch of `createScanView` cannot resolve a bare `.parquet` file path**
  (found while grounding this — and NOTE: `rollup_path` stores a FILE path,
  so rollup views are likely still silently skipped on Azure; not fixed
  here, flagged as its own follow-up). Zero rows writes a schema-carrying
  empty parquet (`SELECT NULL::type … WHERE FALSE`).
- **`writeRowsParquet`** added to `services/warehouse/writer.ts` — the
  connector-package NDJSON→parquet pattern ported into the backend (the
  worker package deliberately shares no imports). New
  `setupDuckDBForWarehouse(db, needAzure, { needDelta })` option (default
  true, all callers unchanged): grids are plain parquet, and skipping
  `LOAD delta` lets the writer work where the extension repo is unreachable.
- **Query integration = one insertion point**: `createProductConnector`
  registers `grid_<slug>` views (tenant-level, in EVERY connection's
  product-layer session — which is what makes budget-vs-actual an ordinary
  JOIN today, without waiting for query-layer un-scoping; grids never shadow
  a product table name), and `productContext` appends a `## YOUR TABLES`
  section + adds grids to the entity-matching catalog — the
  fix-both-or-neither pair, honoured. `listManagedGridTables` lives in
  tableCatalog (URI read back verbatim, never re-derived). Reaches Ask AI,
  /think, /repair, /forecast, all dashboard paths, morning briefs,
  investigations, report emails. KNOWN EDGE: a tenant with grids but no
  built topics resolves to source layer and can't see grids in Ask AI.
  Notebooks don't register grids (they don't register rollups either).
- **Routes `/api/grids`** (admin+analyst, all mutating routes validate()'d
  incl. a params-only schema on DELETE — the ratchet caught it; numeric-id
  params schema so `/grids/abc` 400s instead of `WHERE id = NaN`):
  list/create/read+rows/update/save-rows/delete. **Save is truth-first**:
  rows commit in the request trx, materialisation failure lands in
  `materialize_error` (shown in the UI) — never a lost edit, never a 500.
  Full-replacement row save (coerce BEFORE delete so a 400 leaves old rows
  intact). 409 on slug collision (pre-check + 23505 race catch). Audit
  events on create/delete. purgeTenant needs no change (dynamic
  enumeration).
- **Frontend**: `/grids` (list + 3-template create modal: Budget/Mapping/
  Blank) and `/grids/[id]` — the editor: always-editable typed cells (text /
  number right-aligned tabular / native date / checkbox), **paste-from-Excel
  block fill** (TSV from the focused cell, rows auto-grow, single-cell paste
  falls through), column-header popover (rename keeps the KEY so row data
  survives, type change, guarded delete), row delete on hover, windowed
  rendering via the dashboards `useWindowedRows` hook above 150 rows,
  floating save bar (Cmd/Ctrl+S, Discard), `beforeunload` guard, status line
  "In answers as grid_x · updated …" / amber when materialisation failed.
  Rail: **"Your tables"** (Table2 icon) in Studio directly under Sources;
  CommandPalette action. Vocabulary rule holds with one deliberate
  exception: the `grid_<slug>` name shows in the status line because it is
  the name Ask AI will use.
- **v2 same day — the EXCEL-FEEL pass + XLSX UPLOAD (owner: "not adding row
  per row, but scrollable, seeing all cells … upload their own excels to
  map"). Frontend-only; the server has NO upload surface, by design.**
  (a) The editor is a SHEET now: a PHANTOM_PAD of 30 empty rows always
  renders below the data (windowed over indices, so the pad is free),
  typing in one materialises it — the "Add row" button is GONE, the empty
  cells are the affordance; Enter walks down a column, Shift+Enter up, Tab
  right (nav via `data-row`/`data-col` querySelector inside the sheet ref).
  (b) **`lib/xlsxRead.ts` — a dependency-free .xlsx reader** (~330 lines):
  zip central-directory parse + `DecompressionStream('deflate-raw')`,
  regex-scoped spreadsheetML (shared strings incl. runs, inline strings,
  booleans, sparse cells via `r=` refs), and DATE handling done right —
  styles.xml cellXfs → builtin (14-22,45-47,…) + custom formatCode date
  detection, serials converted to ISO at read time, 1900 AND 1904 systems.
  Deliberately NOT the npm `xlsx` package (unfixed high advisories → audit
  gate) — same house call as the hand-rolled `xlsxBuilder`. No DOM APIs, so
  it runs in Node ≥18: **verified by round-trip against `buildXlsx` output
  plus a hand-built zip exercising date styles/runs/inline/sparse** (serial
  46246 → 2026-08-12). Caps: 20k rows / 64 cols read.
  (c) `app/grids/import.ts` (pure): `splitSheet` (header toggle),
  `guessColumnType` (conservative — commits to number/date/boolean only on
  unanimous non-empty values), `matchColumns` (normalized-name match, no
  file column used twice), `convertCell` (incl. unstyled date serials when
  the TARGET column is a date).
  (d) Two flows: list page "Import Excel" / "From an Excel file" card →
  sheet picker + first-row-is-names toggle + 5-row preview + name →
  creates the grid (columns from headers, types guessed) and saves rows
  through the SAME `/api/grids` calls a typed table uses; editor "Import
  Excel" → per-column MAPPING selects (grid column ← file column,
  auto-matched) + Replace/Append → lands in the local draft → user reviews
  → Save. 10k row cap enforced client-side with the add-it-as-a-source
  message. `/grids` 4.53 kB, `/grids/[id]` 7.09 kB, tsc + lint + build
  green.
- **v3 same day — LINKED COLUMNS + THE TOPICS RELATIONS CANVAS (owner: "I
  create a mapping table, I select a column of a topic, I get the distinct
  values, I make my mapping. Also a relation canvas for my topics… including
  the budgets or mappings").** The reference-column killer feature, shipped:
  (a) `GridColumn` gains optional `link {table, column}` — a PRODUCT-layer
  column stored BY NAME (no ids: rebuild renames become a visible
  "pick it again" state, never a silent break), validated against strict
  ident rules in `normalizeColumns` and resolved at use time by
  `resolveLinkTarget` (existence-checked against product_tables/columns with
  explicit tenant filters).
  (b) Three new endpoints on /api/grids (LITERAL routes registered before
  `/:id`; `/api/grids` mount gained computeLimiter): `linkable-columns`
  (built dimension/bridge tables' non-technical non-measure columns, grouped
  by topic), `link-values` (≤500 distinct values via createProductConnector
  — catalog-resolved identifiers only), and `/:id/coverage` — per linked
  column: total distinct target values, matched, missing sample (≤25). ONE
  DuckDB session holds both sides because createProductConnector already
  registers grid views next to the topic's tables.
  (c) The AI join contract: productContext's YOUR TABLES lines now carry
  `JOIN grid_x.col = dim_y.col` per linked column — the model never guesses
  the join again.
  (d) Editor: column popover "Contains" picker (text columns), link icon in
  the header, cell dropdowns via native datalist fed by link-values, and the
  COVERAGE CHIP — "Customer: 42 of 57 mapped · add the 15 missing" (one
  click appends the missing values as rows). Mapping template's create flow
  asks "what are you mapping?" and the grid starts PRE-FILLED with every
  distinct value (client-side seed through the ordinary rows API).
  (d2, v3.1 — owner feedback from first live use): **searchable
  `LinkPicker`** (`app/grids/LinkPicker.tsx`) replaces both native selects —
  filters across topic/table/column names at once, matches stay grouped per
  table; and **TWO-FIELD COMBINATIONS** — a mapping can key on two columns
  of the SAME topic table: `link-values` gained optional `column2` (both
  columns existence-checked) returning distinct PAIRS, the create flow gains
  "+ combine with a second field" (second picker restricted to the first
  field's table) and seeds one row per combination. Coverage stays
  per-column; pair-level coverage is a later slice.
  (e) **`/relationships` now has a Sources | Topics toggle.** New
  `GET /api/relationships/topics-graph` (read-only; ships product tables BY
  NAME with topic + join-surface columns — technical endpoint columns
  included PAST the firewall, underscore names never; product_relationships;
  grids with links) + `components/relationships/TopicsCanvas.tsx` — same
  geometry/radialLayout imports as StarSchemaFlow, anchor + ring (≤12,
  §2.4), sidebar grouped by topic + "Your tables", facts purple, lookups
  ocean, GRIDS AMBER with dashed edges. Read-only on purpose: topic joins
  are built artefacts, grid links are edited on the grid.
  Validation: backend check clean, **38 files / 362 tests** (5 new: link
  round-trip + unsafe-target 400, linkable-columns filtering, link-values
  404, coverage target-missing/no-links, topics-graph incl. tenant
  isolation), ratchets green, frontend tsc/lint/build green (`/grids/[id]`
  8.22 kB, `/relationships` 2.82 kB).
- **Deliberately NOT in v1** (owner-discussed): no formula engine (grids
  hold facts; Clarion computes — Excel-file upload stays the P1 connector
  for formula workbooks), no viewer read UI. Next natural slices: surface a
  covered mapping as an attribute of the dim itself; budget versioning;
  an "everything else" fallback row.
- Validation: backend `npm run check` clean; **full suite 38 files / 357
  passed** (17 new in `managed-grids.test.ts`: derivation totality incl.
  SQL-injection-shaped names, eu/en number + day-first date parsing,
  coerceRow drops stale keys, create/collision/save/rename-keeps-slug,
  tenant isolation as 404, viewer 403 on every route, row cap, delete
  cascades); an end-to-end script proved write→register→readback and the
  empty-schema view against real DuckDB; all eight ratchets green;
  frontend `tsc` + lint clean, `next build` green (`/grids` 3.31 kB,
  `/grids/[id]` 5.55 kB). SANDBOX NOTE: backend + connectors `npm install`
  each build DuckDB natively (~15–25 min, background them); the DuckDB
  extension repo is NOT reachable through the sandbox proxy — `needDelta:
  false` paths work, anything needing `LOAD delta` does not.

**Prior last updated:** 2026-08-21 (functionality gap analysis v1.1 — doc only)

**NEW DOC: `docs/backlog/functionality-gap-analysis.md` (2026-08-21, doc
only; v1.1 same day).** Owner asked: walk through the app's functionality,
think about what users do day to day, research broadly, and find what's
missing. Method: a full code-verified inventory of the live feature surface
crossed with external research (SMB owner daily-metrics literature,
Fathom/Syft baselines, Tableau Pulse/ThoughtSpot push-BI, Peliqan/Weld,
BI-adoption failure data, Belgium's Peppol mandate live since 2026-01-01).
**v1.1 is the version of record** — owner pushed back on v1.0's accounting
lens (*"HR, operations, timesheets, ERP … will be onboarded too; the Excel
part I agree with totally"*), so every gap is restated as a DOMAIN-AGNOSTIC
primitive with finance examples marked as *first instances* (first only
because the two live connectors are finance-shaped). **Verdict, three parts:
(1) Clarion is a strong PULL product whose primary user lives in a PUSH
world** — the push skeleton is ~80% built (pulse, morning brief, email
schedules) but the brief never leaves the app, no metric has a user-set
threshold, nothing renders on a phone; **(2) Clarion describes but never says
what to DO** — no exception lists, no forward view, no targets; **(3) new G16,
promoted by the owner's roadmap: the questions that justify multi-domain
onboarding (revenue per FTE, labour cost vs project margin) are inexpressible
while the query layer stays connection-scoped** — the first non-finance
connector makes multi-source P3/P4 the product, not platform work. Sixteen
gaps in four tiers: T1 daily loop (G1 alerts+delivered brief —
`morning_briefs.emailed_at` exists unused; G2 mobile/PWA; G3 exception lists
+ forward view as a GENERIC primitive, first instance AR aging/chase
list/cash line on tables that already exist), T2 multi-domain + monthly loop
(G16 above; G4 generic targets on any KPI — NO entity exists, only the
bullet_chart contract; G5 spreadsheet connector — owner-confirmed, reconfirms
multi-source P1; G6 external share links + server-side PDF report pack; G7
refreshable Excel), T3 adoption (G8 NL/FR i18n — zero i18n exists, `lang="en"`
hardcoded; G9 onboarding mock still unwired; G10 built-but-buried:
**`/investigate` is a fully-built root-cause agent with ZERO nav links**, and
`/gaps` is orphaned; G11 connector breadth as the strategy — each new domain
needs its template/KPI/pulse CONTENT and its own freshness cadence; Peppol
demoted to a timeboxed spike; G12 portfolio tier — a generic seat, accountant
is *a* channel not *the* channel), T4 collaboration (G13 comments, G14
saved/scheduled questions, G15 benchmarking). Suggested order: items 1–3 are
one release ("Clarion comes to you"); item 8 ties G16+G11 to the first
non-finance connector, incl. default-masking sensitive columns when HR lands.
§4 what NOT to build (no practice management OR HR workflow tools, no
driver-based forecasting, no reverse ETL, no embeds, no custom roles). **§6
corrects the record: the 2026-07-15 assessment is partly stale — data
policies (row filter + column mask) EXIST with UI, audit log UI EXISTS (two),
forecasting EXISTS in Ask AI.** Published as artifact "Clarion Gap Analysis".
No code changed.

**Prior last updated:** 2026-08-20 (multi-source strategy doc + the Build chat batch below)

**NEW DOC: `docs/backlog/multi-source-strategy.md` (2026-08-20, doc only).**
Owner asked how to tackle companies with multiple source systems, missing
connectors, acquisitions, and planning in Excel/SharePoint. Companion to
`warehouse-value-for-smb.md` (that doc = the argument; this one = the
operational inventory): ten concrete cases C1–C10 (second ERP, no-connector,
Excel budgets, SharePoint satellites, legacy history, multi-entity, same
connector twice, identity, semantic conflicts, grain mismatches) with what
makes each hard; an honest built/planned/absent audit (notably: direct-DB
sources WORK today via the legacy path; NOTHING reads a spreadsheet; query
layer still connection-scoped); and a 7-phase build plan — P1 spreadsheet
connector as an ordinary SourceConnector (the highest-leverage gap), P2 ten
names + second-source mapping flow (§5.8 executed; the 2026-08-20 extension
workflow is the architectural template), P3 identity crosswalk +Mapping
primitive (deterministic before fuzzy, snapshot-and-merge), P4 un-scope the
query layer (deliberately AFTER P3), P5 entity axis + group-lite, P6
reconciliation-vs-source as a feature, P7 connector breadth via a REST kit +
demand signal from the Build chat. Standing guardrails carried over (§5) and
three owner decisions queued (§6). Published as artifact "Multi-Source
Strategy".

**Prior last updated:** 2026-08-20 (Build has a chat: ask what's covered, add ONE subject additively)

**"ASK ABOUT YOUR SUBJECTS" — THE BUILD PAGE CHAT + ADDITIVE SUBJECT
CREATION (2026-08-20, fifth batch).** Owner, after noticing Quotations was
missing from /subjects: *"add the option in build to add a subject when the
user wants it, or when a user has a question about whether something is
already in a topic … If there's a change needed then it can break no
downstream dependencies. I need a place where we can ask what's there
already and/or ask for changes/additions in human language."* Design of
record, each safety property enforced in CODE, not prompt hope:
- **The chat answers from real data, never guesses.** New
  `services/buildChatContext.ts` (`buildCoverageContext`) assembles the
  coverage context from the catalog: subjects with descriptions/KPIs/
  question_text/table display names, synced source tables with measured row
  counts (dataset_profiles, latest wins) and — the load-bearing line —
  per-table "used by: Sales" vs "not part of any subject yet"
  (data_product_sources inverted). Explicit tenant_id filters throughout
  (reqDb pool-race rule). `POST /products/build-chat` (admin+analyst,
  Zod-validated, `ai/prompts/buildChatPrompt.ts` +
  `AIService.respondBuildChat`, Zod-parsed JSON out) — READ-ONLY BY
  CONSTRUCTION: the endpoint has no mutation path. The model may return a
  `proposal`; the route re-validates it server-side (connection in tenant,
  entities ⊆ synced set — filtered, name not colliding — else dropped).
- **Only a click builds.** The proposal renders as a card in the new
  `frontend/app/build/AskPanel.tsx` ("New subject: Quotations · built from
  Quotations, QuotationLines · your existing subjects stay untouched") with
  ONE button → `POST /products/bus-matrix/extend-start` (admin+analyst,
  Zod). Guards run BEFORE the queue check so they hold without Redis and
  are testable: 404 unknown/foreign connection, 400 unsynced entities
  (named), 409 subject-name collision (case-insensitive, tenant-wide), 503
  no Redis, 409 another build running (one build at a time per tenant —
  an extension racing a rebuild would design against a schema being
  replaced under it). Job mode `'extend'` on the SAME bus-matrix queue, so
  SSE/cancel/active/reattach and the run panel work unchanged.
- **`runTopicExtensionWorkflow`** (busMatrixOrchestrator): reuses the
  design streamer via a new `promptOverride` param on
  `generateBusMatrixStreaming` (same thinking/design_progress events), a
  new `BUS_MATRIX_EXTEND_SYSTEM` prompt that lists the existing owner dims
  WITH their real columns (reuse by exact name, JOIN on real keys) and the
  forbidden table-name list. Then **`prepareExtensionMatrix`**
  (busMatrixBuilder, pure, 7 unit tests) enforces: exactly ONE product,
  approved name verbatim, build_order forced to 2 (never 1 — 1 is what
  materialises dim_date and the existing build owns that); AI
  redefinitions of existing tables DROPPED and replaced by DB-derived
  SHADOW entries (present in conformed_dimensions so buildBusMatrix's stub
  loop copies columns, never owned, so they persist as stubs); any
  remaining name collision is a HARD ERROR — persisting it would arm
  buildBusMatrix's retire-and-replace sweep, the one thing an additive
  flow must never do; a fact naming a dim that neither exists nor is
  defined is refused. Post-persist the workflow inserts
  `data_product_dependencies` rows to the owners of every reused dim PLUS
  the dim_date owner (buildBusMatrix can only wire owners inside the
  matrix; loadDependencyDimensions resolves through these rows at run
  time). Then transforms the ONE new product and emits the standard events.
- **Changes to existing subjects are refused**, with the honest reason
  (dashboards and saved questions built on them) and a pointer to the
  topic's own Manage mode; hide/show stays the Build page eye toggle. The
  chat prompt bans warehouse vocabulary in replies (subjects/shared data/
  tables, never fact/dimension/star schema/data product/SQL).
- **An extension needs a build to extend**: with no products on the
  connection the route 409s ("use Create my topics first" — an addition
  reuses the existing shared lookups and Date calendar, and build_order is
  forced past 1 so it never materialises dim_date itself); the workflow
  re-checks the dim_date owner, and the chat prompt points at the full
  build instead of proposing.
- **Known caveat, stated on purpose:** a later full Rebuild is still
  retire-and-replace for the whole topic set — an added subject gets
  re-designed like everything else.
- Drive-by: consolidated the orchestrator's repeated lazy imports into two
  module-level loaders (`loadTransformationRunner`/`loadProductGraphSync` —
  deferral kept, one ratchet site each) and used the static AIService
  imports in the new workflow → dynamic-import ratchet count 100→90;
  **baseline LOWERED 92→90** per the ratchet's covenant.
- Validation: backend `npm run check` clean, full suite **37 files / 339
  tests green** (16 new: 7 prepareExtensionMatrix, 9 route/coverage in
  `products-build-chat.test.ts`), all eight ratchets green, frontend `tsc`
  + lint clean, `next build` green.

**Prior last updated:** 2026-08-20 (the build's "working" pane is human now: no plumbing, live design progress)

**THE WORKING PANE SHOWED A DEBUGGER — FIXED (2026-08-20, fourth batch).**
Owner screenshot from a live rebuild: the "Show the working" disclosure was
dominated by `diag` lines (`content_block_start`, `progress thinking=444c/12d
text=6809c/37d`) — API-streaming plumbing meant for the /products workshop
terminal. Root cause is structural: the long stretch of the AI design phase
is the model WRITING the design (text deltas), during which no thinking
arrives, so plumbing was ALL the pane had to show. Two changes:
- **The Build page renders `thinking` only** — `diag` stays in the stream
  (the workshop terminal keeps it) but no longer reaches the business
  surface. The disclosure now appears only once real reasoning exists.
- **New structured `design_progress` event** (`tablesDrafted`): the design
  JSON must never stream to the Build page (raw SQL), but its shape gives
  an honest progress signal for free — every drafted table carries one
  `"table_name"` key. The orchestrator counts them as text deltas stream
  (throttled ≥2.5s AND only on increase) and the Build page puts it on the
  HEADLINE: "Writing the design — 12 tables drafted so far…" — alive for
  everyone, not just disclosure-openers. Unknown event types are ignored by
  the workshop (verified pattern), so no other consumer changes.
- Validation: backend `npm run check` clean, full suite 36 files / 323
  green, eight ratchets green, frontend `tsc` + lint clean, `next build`
  green.

**Prior last updated:** 2026-08-20 (Option A shipped: the Subjects hub replaces per-topic rail rows)

**THE RAIL'S PER-TOPIC ROWS ARE GONE — OPTION A, THE OWNER'S PICK FROM
THREE MOCKED DIRECTIONS (2026-08-20, third batch).** Owner: *"I'm starting
to think that putting a 'data catalog' under 'uncover' is better and
cleaner"* — and, after a three-option design canvas (A hub / B hub+pinned /
C home-as-front-door), *"I want option A."* The reasoning that settled it:
per-topic rows were right at two or three template topics, but the AI
designer produces six-plus, and a rail that grows with the model's output
always eventually scrolls.
- **New `/subjects` (viewer-readable)** — the hub: ask bar (deep-links
  `/query?q=…&autoSubmit=1`), a card per visible analytics topic
  (`iconForAnalytics` glyph, description, freshness dot — "waiting for
  data from your source" when `rows_total` is 0, same honesty rule as
  Build), and a Shared data band → `/shared-data`. Empty state: analyst+
  get "Create your topics" → /build; viewers get a quiet sentence.
  Vocabulary rule applies in full (business words only). NOT named "Data
  catalog" — Studio's Data Catalog is the curator surface and two catalogs
  with different audiences would confuse both; "Subjects" keeps the
  shipped vocabulary.
- **`IconRail`**: ONE "Subjects" entry under Uncover (Ask AI → Dashboards
  → Subjects → Notebooks, Layers icon, all roles); the `topics` group, the
  runtime topics fetch, the per-topic rows, the empty-state CTA row and
  the rail's Shared data row are all REMOVED. `ROUTE_ALIASES['/subjects']
  = ['/subjects', '/topics', '/shared-data']` keeps the hub entry lit on a
  topic page and on Shared data. CommandPalette gained a Subjects action.
- **`GET /products` now ships `rows_total`** (same SUM rule as
  build-overview's rowsTotal; NULL = nothing materialised) so the hub can
  render the waiting-for-data state — pinned by a new test in
  `products-build-overview.test.ts`.
- **`lib/topicsChanged.ts` has no listener today** (the rail was the only
  one); the Build page's dispatch is kept as the topic-set-changed bus —
  header comment updated to say so honestly.
- The three-option canvas lives at the "Clarion Subjects Navigation"
  artifact (design mockups only — never shipped as code).
- Validation: backend `npm run check` clean, full suite **36 files / 323
  tests green**, eight ratchets green, frontend `tsc` + lint clean,
  `next build` green (`/subjects` 2.81 kB / 116 kB).

**Prior last updated:** 2026-08-20 (lineage is BUILT now, not hoped for: derived from the transformation SQL at persist time)

**COLUMN LINEAGE IS DERIVED DETERMINISTICALLY AT BUILD TIME (2026-08-20,
second batch).** Owner: *"I want you to build the lineage and visualize it
correctly, like databricks lineage."* The blocker was data, not the viewer:
the bus-matrix prompt tells the model to OMIT `lineage[]` for trivial
columns (kept — it is a sound token rule), so AI-built topics wrote almost
no `column_lineage` rows and "Where it comes from" showed the honest empty
card. But a passthrough's lineage is not unknowable — `s.ItemCode` names
its source exactly, no model required.
- **New pure `services/lineageDerivation.ts`** (9 unit tests, no DB):
  `parseAliasMap` reads the table's FROM/JOIN clauses (comments + string
  literals stripped so they can't mint aliases; CTE names excluded — a ref
  through a CTE is not attributable in v1), `deriveColumnLineage` scans the
  column's `transformation_expression` for qualified refs. THE LOAD-BEARING
  GUARD: only tables in the design's declared `source_tables[]` may become
  a lineage source — fact SQL joins DIMENSION tables for surrogate keys,
  and a `d.item_key` ref must never mint a `column_lineage` row
  (`source_table_name` means a SOURCE-layer table; a product-table name
  there renders as "no longer in the catalog"). A bare identifier resolves
  only when the table reads exactly ONE source; two sources = ambiguous =
  no guess. Pure passthroughs get `transformation_description: 'Copied
  as-is'`; transforms get NULL and the lineage endpoint falls back to
  showing the expression — the honest rendering.
- **`busMatrixBuilder` wires it into BOTH column persist loops** (dims and
  facts): when the AI's `lineage[]` is absent, derive. Template builds are
  untouched (they author lineage). Existing topics fill in on their next
  rebuild, same as the dim_date links.
- **`LineageGraph` gained a row cap** (`ROW_CAP` 14, Databricks-style):
  with every column now threaded, a measures table would render a ~1,900px
  card. Cards cap with a "Show all N columns" toggle, and THE CAP YIELDS TO
  THE SELECTION — any row the selected column connects to is always
  included, so a thread can never point at a hidden row (the layout memo
  re-derives on selection; geometry is deterministic, so this is cheap).
- Validation: backend `npm run check` clean, full suite **36 files / 322
  tests green**, eight ratchets green, frontend `tsc` + lint clean, `next
  build` green.

**Prior last updated:** 2026-08-20 (the schema diagram gets its keys back, and the missing dim_date links are synthesized)

**THE JOIN SURFACE WAS EMPTY IN PRODUCTION — TWO GAPS THE OWNER'S FIRST
SCREENSHOTS EXPOSED (2026-08-20).** The rebuilt "How it fits together"
shipped, but on the live Inventory topic every card rendered zero field
rows (edges landed on card edges, not named fields) and the Date lookup
read "not linked yet". Both diagnosed to data, not rendering:
- **The `is_technical` firewall was starving the diagram.** `GET
  /products/:id` filters technical columns out of `columns`
  (`core.ts:176`), and `inferIsTechnical` marks exactly the join roles
  (foreign_key, surrogate_key) technical — so the relationship-endpoint
  columns never reached the frontend and the join-surface filter matched
  nothing. FIX: the payload now ships **`join_columns`** per table — the
  relationship-endpoint columns fetched PAST the firewall, still excluding
  underscore-prefixed names by name (`_row_hash` today, SCD2 metadata
  tomorrow), and never duplicating a column `columns` already carries.
  `StarSchemaFlow` merges them (join columns lead the expanded list). The
  contract stays: every OTHER consumer of `columns` keeps the firewalled
  view. Pinned in `products-detail-join-columns.test.ts` (3), including
  that a pathological relationship row naming `_row_hash` cannot smuggle
  it into any column list.
- **The AI omits the relationships[] entries that touch dim_date** — the
  prompt forbids listing dim_date as a table (auto-injected), and the
  model reliably drops the relationships to it too, while the per-column
  `fk_target_table/_column` metadata survives ("fact FKs point to
  dim_date.date_key" is a prompt rule). FIX: new pure
  `synthesizeFkRelationships()` (`busMatrixBuilder.ts`, 5 unit tests)
  derives the missing rows from column metadata at persist time — only
  FROM the product's own tables (so a shared dim stubbed into several
  schemas can't re-emit its links per schema), only TO tables the schema
  knows, never duplicating an existing assertion. Existing topics keep
  their honest "not linked yet" until a rebuild re-persists them.
- Validation: backend `npm run check` clean, full suite **33 files / 313
  tests green** (8 new), all eight ratchets green, frontend `tsc` clean +
  lint clean on touched files, `next build` green.

**Prior last updated:** 2026-08-19 (Manage mode's two diagrams rebuilt: schema in the relations language, lineage on the one real surface)

**"HOW IT FITS TOGETHER" NOW SPEAKS THE RELATIONS PANE'S LANGUAGE
(2026-08-19, second batch).** Owner, from the AI-built Purchasing topic:
*"I want 'how it fits together' to look like the relations pane. And I don't
see 'Where it comes from'."* Both were real defects surfaced by the AI
designer's richer output:
- **`StarSchemaFlow` rendered EVERY column of every table** — fine for an
  8-column template table, a 2,000px strip for an 80-column AI table, and
  fitView zoomed out until nothing was readable. REWRITTEN on the
  /relationships canvas's two paid-for lessons: tables render their JOIN
  SURFACE (+N more fields reveals the rest), and the layout answers the
  question — the measures table dead-centre, lookups on the ellipse
  (`radialLayout`). Geometry (`HEADER_H`/`ROW_H`/handle ids/`nodeHeight`)
  and the layout are IMPORTED from `components/relationships`, not
  re-derived — the two panes must agree visually and those numbers are
  solved there. Cardinality rides the line ends (`1`/`∗` circles, U+2217),
  edges solid ocean 2.2px. No fact in the data → anchor on the most-linked
  table. Sole consumer is ManageLayer.
- **"Where it comes from" rendered a BLANK canvas for AI-built topics**, by
  design collision: `busMatrixPrompt` deliberately tells the model to OMIT
  `lineage[]` for trivial columns (token rule, kept), and the old
  `LineageFlow` drew ONLY lineage-bearing tables — zero rows meant zero
  nodes and no message. The tab now uses **the catalog's `LineageGraph`**
  (the owner-approved 2026-08-18 lineage surface, `GET /api/lineage/table
  ?layer=product`) behind a table-picker chip row, defaulting to the
  measures table — the "lineage links from the topic page" extension that
  entry anticipated. Sparse/absent lineage now gets LineageGraph's honest
  "No column-level lineage was recorded" card instead of silence.
  **`LineageFlow.tsx` is DELETED** (zero consumers remained).
- Validation: frontend `tsc` clean, rewritten files lint-clean (the two
  `next lint` errors in `SourceRootPanel.tsx` are pre-existing findings on
  untouched lines), `next build` green.

**Prior last updated:** 2026-08-19 (Build shows the thinking; zero-row builds fixed end to end)

**THE BUILD RUN SHOWS THE WORK NOW (2026-08-19).** Owner: *"I want to see more
thinking work visually as an end user when clarion is creating the facts and
dimensions."* The finding that shaped the design: the orchestrator has
ALWAYS streamed the AI designer's `thinking` deltas — the Build page
discarded them and rendered only the last phase/log line, so the
multi-minute AI design phase was one frozen sentence. Three layers now,
each in the register the pane's outcome-language rule allows:
- **Structured events** (`busMatrixOrchestrator.ts`): new `designed` (the
  topic list with REAL product ids, emitted after Phase D persist so cards
  can deep-link; payload is names/descriptions/counts only — the colocated
  `busMatrixOrchestrator.test.ts` pins that no `dim_`/`fact_` name can
  reach it, same invariant as the build-overview plan) and `product_start`
  (flips a card to "building" without string-matching log text). Pure
  `designedTopicsFromBusMatrix()` is exported for the tests. Phase events
  gained an optional **`friendly`** business-language twin — the Build page
  prefers it, the /products workshop keeps the technical `text`, and no
  existing consumer changes.
- **The run panel** (`frontend/app/build/page.tsx`): headline strip
  (friendly phase + cancel) → **topic cards that materialize when the
  design lands** and flip pending → building → ready/partial/failed per
  product (reference products render as "Shared data") → a collapsed
  **"Show the working"** disclosure streaming the raw reasoning (capped at
  160k chars, auto-scrolling, labelled technical). `log` events no longer
  drive the headline. Per-topic `error_detail` lands on its card; the
  finish card folds topic errors into its summary. **Reattach works by
  construction**: the SSE route replays the job log from index 0, so
  landing mid-build rebuilds cards + reasoning. NOTE the deliberate
  vocabulary exception documented in the page header: the disclosure speaks
  warehouse vocabulary — never widen /build to viewers while it exists.

**ZERO-ROW BUILDS NO LONGER FAIL — THE 2026-08-19 PRODUCTION DEFECT (three
fixes, one root cause).** The owner's AI-mode build failed two facts with
`Delta sidecar failed: DeltaError: Generic error: No data source supplied
to write command`. Root cause REPRODUCED against deltalake 0.23.2 before
fixing: the transformation SQL legitimately returned ZERO rows
(AI-designed facts over entities that synced no data), and delta-rs
refuses a write with no record batches. The sidecar's author had even
handled `df.empty` in `add_row_hash` — the write step was the only gap.
The parquet escape hatch never had the bug (empty COPY works), which is
why it stayed latent; template builds can hit it too (any fact whose
source tables synced but hold 0 rows).
- **Fix 1 — the writer** (`etl/scd2/commit_table.py`): an empty result
  MATERIALISES. First run → `DeltaTable.create` from the schema
  (`mode="ignore"` so a transient load failure can't overwrite real data
  with emptiness); refresh → `dt.delete()` (a new Delta version). Counts
  honest: refresh-to-empty reports everything as deleted. Two new
  end-to-end pytests drive `main()` against a real local Delta table —
  suite now 28 green (run via a pinned venv; deps in etl/requirements.txt).
- **Fix 2 — the state is legible**: `build-overview` ships `rowsTotal` per
  product (SUM of `product_tables.row_count`; NULL = nothing
  materialised), and the Build page's topic row reads **"built — waiting
  for data from your source"** when a built topic's tables are all empty —
  instead of "refreshed just now". Pinned in
  `products-build-overview.test.ts`.
- **Fix 3 — the designer is grounded**: each table in the AI design context
  is annotated with its measured row count from `dataset_profiles` (a real
  COUNT(*) as of the last analysis; best-effort — a structural-only
  Analyse has no profiles and an unmeasured table gets no annotation), and
  `busMatrixPrompt.ts` gained the rule: NEVER design a fact whose source
  tables are ALL marked "NO ROWS"; empty lookups may still feed dimensions.
  Counts can be stale (analysed-then-synced), hence the "at last analysis"
  wording and fix 1 carrying correctness either way.

**NEW GITOPS CONTROL: `.ops/promote`** — promote.yml gained a
push-triggered path (paths-scoped to that file, `concurrency:
promote-production`). Exists because `workflow_dispatch` is 403 for the
integration token (re-verified this session via the GitHub MCP), so a
session could deploy but never promote — the container-mode re-apply trick
covered only the backend. First non-comment line = target (`backend +
frontend` | `backend only` | `frontend only`); re-apply = comment edit.
**Same LESSON as container-mode: touch the file only AFTER deploy.yml has
finished** — it promotes whatever revision is READY right now. Documented
in `.ops/README.md`.

- Validation: backend `npm run check` clean; full backend suite **33 files
  / 305 tests green** (this sandbox: native DuckDB builds via npm install,
  Postgres 16 service with `databridge`/`databridge_app` roles +
  `databridge_test` DB migrated); all eight lint ratchets green from the
  repo root; frontend `tsc` clean, touched files lint-clean, `next build`
  green; sidecar pytest 28 green.

**Prior last updated:** 2026-08-18 (BUILD front door + rail IA per the owner's sketch + Data Catalog back in Studio)

**THE RAIL NOW FOLLOWS THE OWNER'S SKETCH, AND THE DATA CATALOG IS BACK
(2026-08-18, second batch same day).** Owner, from a hand-drawn nav: the
catalog pane *"disappeared in one of the previous iterations… I want it as a
pane in the studio"*, the relationships tab must leave the catalog (*"it's
already in 'How it fits together'"*), and the groups become uncover /
subjects / Studio / Settings. Agreed additions in discussion: Home and Build
stay, Shared data moves under subjects **viewer-readable**, and — after the
owner pushed back on my "make the catalog source-only" suggestion — the
split is **by KIND OF WORK, not by layer**: the catalog is the
definition/inspection surface across BOTH layers, Manage mode is the one
per-topic cockpit, the workshop is structural surgery. Measured fact that
settled it: `ProductTableDetailPanel` in the catalog is the ONLY surface
that edits product COLUMN semantics (`PATCH /semantic/product-columns/:id`)
— Manage mode has no column editor, so a source-only catalog would have
made those definitions homeless.
- **Rail groups** (`IconRail.tsx`): workspace = Home alone, unlabelled ·
  **Uncover** = Ask AI, Dashboards, Notebooks (Notebooks analyst+, moved out
  of Studio) · **Subjects** (was "Your data") = topic rows + **Shared data**
  as its closing row for every role · **Studio** = Sources → Build →
  **Relations** (renamed from "How it fits together") → **Data Catalog**
  (new, `/catalog`) → Refresh → Suggestions · Settings unchanged.
  `/catalog` aliases `/semantic`, `/glossary`, `/health` so deep links keep
  the rail item lit.
- **`/shared-data` is now viewer-readable, read-only**: the lookups are
  CONTENT (your customers, your products) and viewers can already read the
  same rows through Ask AI. Viewers get the cards without the workshop
  click-through (`Wrapper = curator ? 'a' : 'div'`); copy adjusts. The
  backend endpoint was already `requireAuth`-only.
- **THE OLD RELATIONSHIP SURFACE IS RETIRED — the "retire at parity" debt
  is paid.** `SourceRootPanel`'s "Schema diagram" tab (three-way diagram /
  list / review queue) is deleted, and with it the entire old canvas:
  `components/semantic/RelationshipCanvas.tsx` (1,975 lines) and
  `components/catalog/relationships/*` are REMOVED from the repo.
  `useSchema` was the one load-bearing survivor — it feeds the whole panel,
  not just the dead tab — and moved to `components/catalog/useSchema.ts`.
  Relationships now have exactly ONE editing surface (`/relationships`);
  the catalog links there ("Relations ↗", and the relationship-drafts chip
  on Overview). **`GraphCanvas` accepts `?table=<id>`** to anchor on a
  specific table (read inside the ssr:false component, so no Suspense
  boundary is needed), so catalog doors can land on the thing being looked
  at; falls back to the most-work bootstrap when absent/unknown.
- **`ProductRootPanel` slimmed to definition/inspection**: the Schema
  diagram, Data flow, KPIs and Quality tabs DUPLICATED the topic's Manage
  mode — two cockpits for one topic drift apart. Gone (with
  `SchemaSection`/`LineageSection`/`SqlSection`); the tab bar now carries
  "Manage this topic ↗" → `/topics/:id?manage=1`. What stays is the
  catalog's own work: Overview, Tables with columns/definitions/data
  preview, and the per-table notebook (still the deploy surface).
- Frontend `tsc` clean; the touched files are lint-clean (repo-wide `next
  lint` still carries pre-existing findings in ~39 untouched files).

**THE LINEAGE VIEW SHIPPED (2026-08-18, third batch same day).** The owner's
definition: *"a graph to really showcase which source tables and columns
feed which data products and columns, and also transformations if there are
any."* The data existed since migration 17 — `column_lineage
(product_column_id, source_table_name, source_column_name,
transformation_description)`, written by every build path but until now
only read as prompt context.
- **New `GET /api/lineage/table?layer=source|product&tableId=`**
  (`routes/lineage.ts`, admin+analyst): anchored column-level lineage, both
  directions. The correctness details that are easy to lose:
  `source_table_name` is a NAME and names repeat across connections, so
  downstream matches are limited to products belonging to the source's
  connection (connection_id or a `data_product_sources` row) — never a bare
  name match; the **`is_technical` firewall applies** (this is one more
  user-facing read of `product_columns`, so `_row_hash` must not surface);
  every query filters tenant_id explicitly; an upstream name the catalog no
  longer has still renders (`tableId: null`) — the lineage is the fact, the
  catalog link is a bonus. 5 tests (`lineage.test.ts`) pin exactly these.
- **New `components/catalog/LineageGraph.tsx`** — two lanes (sources left,
  topic tables right), SVG threads per column edge, click a column to
  isolate its threads and read the transformations in a "How it flows"
  strip (readable, not hover-only). **Deliberately NOT ReactFlow**: the
  geometry is deterministic (fixed card/row heights, same idea as the
  canvas's `nodeHeight()`), so threads draw from computed positions with no
  DOM measuring and no pan/zoom machinery. Always anchored — §2.4 forbids
  the global lineage hairball. A source card shows only the columns that
  feed something, with "+N columns not feeding a topic yet" as a footer.
- **The detail panels' Relationships tab became the Lineage tab** (both
  `TableDetailPanel` and `ProductTableDetailPanel`): the per-table FK lists
  duplicated /relationships (source layer) and Manage mode's "How it fits
  together" (product layer). Each Lineage tab header links to the one real
  surface — "Relations ↗" (`/relationships?table=<id>`, the anchor deep
  link) on source tables, "Manage this topic ↗" on product tables.
  Curator-gated like History. NOTE: `ProductTableDetailPanel` passes
  `pgTableId` (the Postgres `product_tables.id`), not the tree's graph id.
- Backend `npm run check` clean, full suite 32 files / 299 tests green, all
  eight ratchets green, frontend `tsc` clean + `next build` green.
- **Not in this slice**: multi-hop walking (product→product dependencies),
  and lineage links from the SQL provenance trail on the topic page —
  both natural extensions of the same endpoint.

**EVERYTHING ABOVE IS ON MAIN AND PROMOTED (2026-08-18).** Owner: *"Doe
alles naar main aub"* — main fast-forwarded to the branch, all four CI
workflows green, and the owner ran "Promote to production" themselves. A
follow-up copy fix (the Build plan cards now lead with the template's
topic DESCRIPTION — "Accounting analytics: general-ledger detail, open
receivables and payables" — instead of only the KPI names, which undersold
Finance's three fact tables as one metric) is also on main, deployed
green.

**NEW GITOPS CONTROL: `.ops/star-schema-design`** (`templates` | `ai`) +
`.github/workflows/star-schema-design-mode.yml`, cloned from the
duckdb-runner control (paths-scoped, no-op when already applied, NOT a
promote vehicle). Backend-only (the bus-matrix queue runs in the API).
`ai` sets `STAR_SCHEMA_TEMPLATES_DISABLED=1` — the flag the code has
honoured since the template work but that had no production vehicle.
**Set to `ai` on 2026-08-18 at the owner's request** ("Ik wil nu even geen
pre-defined ster schema voor een connector gebruiken"): every "Create my
topics" run now uses the AI designer, including for EO. Costs: AI tokens +
minutes per design, non-deterministic naming across tenants, and a rebuild
replaces template-built products with AI-designed ones. Rollback = set the
file back to `templates` and push. Documented in `.ops/README.md`.

**Prior last updated:** 2026-08-18 (BUILD — the tenant-level front door from source to topics)

**THE BUS-MATRIX FLOW HAS A FRONT DOOR: STUDIO → BUILD (2026-08-18).** Owner:
*"Waar in de app zou het nu logisch zijn om die 'prepare my data' te zetten?
Dit zou niet achter een url zonder UI of knop moeten zitten."* — and, decisive:
the button must NOT live on the source card, *"omdat we over verschillende
bronnen ook conformed dimensions kunnen hebben."* Preparing data is a
TENANT-level act, so the door hangs above the sources: new page **`/build`**
(Studio, directly under Sources), which is warehouse doc §2.1b's coverage
checklist finally given a home. Agreed with the owner before building:
outcome language ("Create my topics", never fact/dimension/star schema);
build EVERYTHING the template can and make show/hide the topic selection
(activation, not determination); structure-rebuild behind a warned action.
- **`GET /api/products/build-overview`** (new `routes/products/buildOverview.ts`,
  admin+analyst) is the page's single read model: per connection → sync +
  analyse state, source-table count, built products (with `hidden`), and THE
  PLAN — the topics a build would create, computed by instantiating the REAL
  connector template (`tryBuildBusMatrixFromTemplate`) against the REAL synced
  table names, so the promise shown before the build is exactly what the build
  produces, never a hand-maintained copy. Ships DISPLAY names only; the test
  suite pins that no `dim_`/`fact_` name can reach the payload. Every query
  filters `tenant_id` EXPLICITLY (the reqDb pool-race rule, same as
  `/relationships/graph` and `/:id/topic`). **Mounted between `topic.ts` and
  `core.ts` in `routes/products/index.ts`** — a literal route that must
  register before core's `GET /:id` captures "build-overview" as an id.
- **Migration 80: `data_products.hidden`** (nullable boolean; only `true`
  means hidden — every pre-existing product stays visible). The rail's topics
  fetch filters on it; the Build page toggles it via the existing
  `PUT /products/:id` (schema + handler gained `hidden`). A hidden topic stays
  fully built — un-hiding is instant and free, which is the whole point.
- **The page** (`frontend/app/build/page.tsx`): one list, per source —
  built topic rows (link to `/topics/[id]`, freshness, eye-toggle), a
  Shared-data row for reference products (links `/shared-data`), and for an
  unbuilt source the PLAN PANEL: planned topics with their KPI names as
  "you'll see" hints, the shared lookups line, an **optional intent field**
  ("What do you most want to see?") and one button. **The intent never steers
  what gets built** — it becomes the finish card's CTA, deep-linking
  `/query?q=…&autoSubmit=1` so the loop closes on the user's own question.
  No template → honest AI-fallback copy, same button (the orchestrator
  already falls back). Progress = slim SSE strip (ManageLayer's pattern, not
  /products' dark terminal); reattaches on mount via `bus-matrix/active`
  (note: that endpoint also matches refresh-mode jobs — a topic refresh
  running elsewhere shows here with build copy; cosmetic, known).
  **Rebuild is a separate warned action** naming what it costs: retire-and-
  replace re-creates products, so product-level edits (reworded
  `question_text`, KPI changes, `plain_summary`) are reset — data refresh
  belongs to Refresh, not here. Snapshot-and-merge for product edits
  (migration 70's pattern, third application) is the noted future fix.
- **The doors all lead here**: rail gained a Studio entry **Build** (Blocks
  icon, under Sources); an EMPTY "Your data" group now renders "Create your
  topics →" for admin/analyst (it used to render nothing — the rail's one job
  with zero topics was invisible; viewers keep the quiet rail); the source
  card's analysed-state hint is now "Analysed. Turn it into topics on Build →".
  New `lib/topicsChanged.ts` (`clarion:topics-changed` window event): the
  shell persists across client navigations, so the rail re-fetches topics on
  build completion and hide/show instead of waiting for a full reload.
- **Role widening, deliberate and narrow**: the four bus-matrix job routes
  (start/active/cancel/stream) and `PUT /products/:id` went admin-only →
  admin+analyst, matching the role table's "Design star schema products:
  analyst YES". The other build.ts routes stay admin-only.
- **Tests**: new `products-build-overview.test.ts` (6) — the plan is the real
  template (Purchasing must DROP when its entities weren't synced), no
  warehouse vocabulary in the payload, hidden round-trips with NULL=visible,
  analyst can toggle via PUT, tenant isolation, viewer 403.
- Backend `npm run check` clean, all eight lint ratchets green from the repo
  root, frontend `tsc --noEmit` clean, `next build` green (`/build` route
  emitted). Repo-wide `next lint` carries pre-existing findings in ~39
  untouched files; the files this session added or changed are lint-clean.
- **NOT built (explicitly agreed as later phases)**: one-click chaining
  (sync → analyse → build as one job — today the page points at Sources for
  missing prerequisites); intent text feeding AI-written `question_text`;
  the second-source mapping rows (§5.8 item 4) which will appear on this
  same screen when built.

**Prior last updated:** 2026-08-17 (TWO KINDS OF LINE: laid by the source vs laid manually)

**"LAID BY THE SOURCE" WAS HALF A FACT — MEASURED AND GATED (2026-08-17).**
Owner, on the new source/manual split: *"Are the relations laid really coming
from ExactOnline's documentation? And where can I find it?"* Tracing it found a
defect in the CONTRACT, not in Exact Online, and the next connector shaped like
it walks into the same trap.
- **The vendor documents the target ENTITY. The target COLUMN is our
  inference.** EO's docs pages hyperlink an FK property to the target entity;
  `generate-eo-docs.ts` resolves the column from that entity's `data-key="True"`
  property. That inference is wrong wherever the entity carries a second,
  readable key. **`TransactionLines.JournalCode` (`Edm.String`) was sent to
  `Journals.ID` (`Edm.Guid`) and measures 0% containment; `Journals.Code`
  measures 100%.** Measured across the whole transcription: **35 of the 245
  documented references cross a type boundary** (32 String→Guid, 3 Int32→Guid).
  These rendered as *laid by the source* — the one kind of link the UI tells
  people not to second-guess.
- **A second, independent hole: 15 of the 81 curated relationships named a
  column that is not on the vendor's property list at all** — `BankEntries.
  Journal` where the API has `JournalCode`, `Quotations.OrderedBy` where it has
  `OrderAccount`. The profiler drops an unresolvable endpoint at runtime, so
  these failed SILENTLY: the link never appeared and nothing said why.
- **`columnTypes.ts` is the shared rule.** `typeClass()` reads OData/SQL/plain
  type names; `typesJoinable()` is false only when both sides declare types and
  the classes differ. **GUID is its own class, not a kind of string** — that is
  the whole point, since both land in the warehouse as VARCHAR. **It rejects
  only on positive evidence:** an absent or unreadable type is `unknown` and
  compatible with everything, so Odoo (whose `fields_get` docs channel publishes
  no types) is completely unaffected.
- **THE TARGET COLUMN IS NOW SETTLED BY MEASUREMENT, NOT BY ANYBODY'S HAND
  (2026-08-18).** Owner: *"Shouldn't we in an ideal world solely rely on the
  source's documented relations and not try ourselves? And if we're not sure
  that the relation is on code or ID, then we should check the data before
  laying that connection?"* Right, and it dissolves the problem instead of
  patching it. **I had begun writing 30 corrected links into the curated
  catalogue by hand and reverted them** — the catalogue is exactly where 15
  broken entries had been rotting unnoticed, and the target column is not a
  matter of opinion, it is DETERMINABLE.
- **New `backend/src/semantic/referenceResolution.ts`.** Division of labour, and
  neither half can answer alone: **the connector** knows the source's shape and
  nothing about the data, so it emits `EntityDocs.unresolvedReferences` (target
  entity, the rejected column, and the columns that could carry the key **by
  declared type only** — narrowing by NAME here would be the same class of guess
  that caused the defect); **the profiler** has the data and nothing about the
  shape, so it measures.
- **The uniqueness pre-filter is what makes it affordable.** Across EO's 35
  unresolved references the type filter leaves **371** candidate columns.
  But "the target must be a key" is a property of the COLUMN, not of the
  reference — 13 references into `PaymentConditions` share one answer — so
  uniqueness is measured **once per target table** in a single query, and
  almost always leaves one survivor. 371 measurements become ~35.
- **EXACTLY ONE CANDIDATE MAY PASS.** Type cannot separate `Code` from
  `Description` (both `Edm.String`), so if two pass we cannot know which the
  vendor meant and picking the higher containment would be the guess again.
  Refuse → *To review*, where a person decides. Same for an unreadable or empty
  target table: that is "we could not tell", never "no column is a key".
- **A reference resolved this way stays `vendor_docs` — source-laid.** The
  vendor asserted the relationship; the data settled the endpoint; no judgement
  entered. That is exactly what separates it from `curated`, where a person
  decided the relationship exists at all.
- **A HYPERLINK IS NOT THE VENDOR'S WHOLE DOCUMENTATION — measured.** 245 EO
  columns carry an FK hyperlink; a further **~186 describe a reference in PROSE
  only** (`"ID of warehouse to transfer item from"`, `"Reference to the
  header"`). This corrects a claim made earlier the same day: the 5 curated
  entries the vendor "does not document" ARE documented, just not marked up. So
  the curated catalogue is 93% redundant in CONTENT but not in PURPOSE — its
  real job is the prose-only channel, and it has been doing that for 5 things
  while ~100+ sit uncaptured. **A prose-derived link is MANUAL, never
  source-laid**: there, whether it is a reference at all is our reading.
- **The curated catalogue is NOT being shrunk yet.** Removing the 64 duplicates
  before the resolver is proven against real data would delete the safety net
  ahead of its replacement. Order: ship → re-Analyse → confirm the 35 resolve →
  then remove.
- **Curated catalogue 81 → 69**: 12 removed (columns that do not exist, or that
  the vendor already documents correctly under the right name) and **2
  corrected** — `BankEntries.Journal`→`JournalCode` and
  `WarehouseTransferLines.WarehouseTransferID→WarehouseTransfers.ID` →
  `TransferID→TransferID`. Each resolution came from asking the docs *"which
  column does the vendor say points at X?"*, never from guessing.
  **`TransactionLines.JournalCode → Journals.Code` is now the ONLY assertion of
  that link** (the vendor's own version is refused) — do not remove it.
- **THE POINT IS THE GATE, not the correction.** `validateKnownRelationships`
  gained an optional `columns` argument (endpoint EXISTENCE + type
  compatibility) and a new `validateDocumentedRelationships` checks the same on
  what `describeEntities` EMITS. Verified to fail: reintroducing
  `JournalCode → Journals.ID` turns 2 suites red. `docs.ts` stays a faithful
  transcription of the vendor's pages; the judgement about what may be claimed
  lives in the connector, as one readable rule.
- **`docs/SOURCE_ONBOARDING.md` Phase E1a** now states the rule, with the worked
  example, plus a Definition-of-Done line. It said nothing about target-column
  resolution before — the step that went wrong was not in the playbook.
- **Odoo escaped by construction, not by design**: `toColumn: 'id'` is
  hardcoded because Odoo's ORM guarantees every model's PK is `id` and a
  many2one holds exactly that. The trap only fires for sources that name a
  target entity whose key is ambiguous — i.e. most REST APIs with GUIDs
  alongside human-readable codes.
- 6 new `columnTypes` tests + 2 in `docs.test.ts`; **all 132 connector tests
  green across all 15 files**, 63 backend tests green, six lint ratchets green,
  `tsc` clean, dist rebuilt. That includes the DuckDB-backed star-schema
  template suites, which MATERIALISE the EO template against synthetic tables
  and run every KPI formula — so the curated-catalogue surgery above is
  confirmed against execution, not just against the type checker.
- **SANDBOX NOTE, correcting a long-standing entry: `npm install` in
  `packages/connectors` DOES build the DuckDB native binding here.** It takes
  ~15 minutes and needs a background run to clear the 600s tool timeout, but it
  succeeds. Several entries above say the DuckDB-native suites are "CI-only" and
  "can't run in the dev sandbox" — that is no longer true, and it means
  `ParquetWriter`, `ExactOnlineConnector`, `OdooConnector.sync` and both
  star-schema template suites can and should be run locally before pushing.

**A FAILING CHECK MEANS TWO DIFFERENT THINGS, AND THE SCREEN NOW SAYS WHICH
(2026-08-17).** Owner: *"I want to see 2 types of relations. 'laid by source' and
'laid manually'. We assume that everything that is documented by the source is
true, so this always has to hold. If it's laid by us, then maybe there can be an
error and we have to have a notion of it."* Correct, and the canvas was stating
the opposite. **`Payments.PaymentConditionID → PaymentConditions.ID` is
documented by Exact Online — it cannot not hold — and it drew as a red line
labelled "Doesn't hold" because 2 of 24 values had arrived.** The measurement was
right; the sentence attached to it was about the wrong subject.
- **`laidBy()` (`provenance.ts`) is the distinction, and it is DERIVED, not a new
  field** — `originOf(...).tier === 'documented'` already separated the source's
  own assertions (vendor docs, an enforced foreign key) from everybody's
  judgement (Clarion's connector catalogue, your team, a confirmed suggestion).
  Migration 79 did the storage work; this reads it. **A Clarion suggestion is not
  a third kind**: it is a proposal, it lives in *To review*, and accepting it
  makes it manual — because at that point a person laid it.
- **New `unverified` outcome** (`outcomeOf(m, laid)`): a source-laid link whose
  check comes back `broken` or `partial`. Neutral grey `#5a6b78`, glyph `○`,
  headline **"Not enough data to check fully"** — the owner's own wording, chosen
  over "your data is behind", which asserts a cause we have not established. The
  detail sentence is phrased about what we HOLD, never about the link: *"none of
  these values have arrived in PaymentConditions.ID yet"*, not *"no match"*.
  Same measurement, different subject.
- **`unknown` is NOT rerouted.** Only a check that RAN can report thin data; a
  link nobody measured stays "not checked" whoever laid it. Getting this wrong
  would have put "not enough data to check fully" on a check that never happened.
- **The flag has consequences beyond the label**, which is the whole point:
  `unverified` is excluded from *Needs attention* (there is nothing to decide —
  sending someone to inspect the link wastes the filter that means "these need a
  decision"), excluded from the toolbar's red `N don't hold` tally and counted
  separately as `N need more data`, and it suppresses `ContradictionFlag` (an
  amber warning triangle under a deliberately neutral headline undoes the
  distinction it was just drawn to make).
- **Confirmed now groups by WHO LAID THE LINE**, not by the seven-channel origin
  label. Two headings, source first. The finer channel stays on every row's
  `ProvenanceMark`, so nothing is lost — but the split you see first is the one
  that decides what a failing check accuses.
- **The dash on the canvas already carried this** (solid = the source, dashed =
  a person) — the legend now names it as such and both entries carry the
  `LAID_BY` hint.
- **THE CANVAS CHANNELS ARE NOW ASSIGNED PER BUCKET, and that is the second
  half of the same defect.** Owner: *"I need the person that looks at the
  'confirmed' pane to really feel they're confirmed; right now with the partial
  lines it seems it's not good, while they are confirmed."* Colouring Confirmed
  by its measurement made a decided link — one Ask AI is actively joining on —
  draw amber because 2 of 24 values had arrived. **Confirmed is now SOLID
  ALWAYS, coloured by WHO LAID IT** (`LAID_STROKE`: source `#164e63` at 2.4px,
  manual `#6b7680` at 2px), because "is this real?" is settled there and "whose
  is it?" is not. **To review stays dashed and coloured by the measurement** —
  there the evidence IS the decision aid. The measurement does not vanish from
  Confirmed: it becomes a **small ringed dot at the line's midpoint, drawn only
  when a check RAN and came back short**, so absence means fine and the eye is
  pulled by the two that have something to say instead of washed by all of them.
  Suppressed on match edges (measured by rate, so the check never runs and a
  permanent dot would mark a shortfall nobody can clear) and outranked by a
  flag. The toolbar tally is phrased per bucket too: `N worth another look` in
  amber for Confirmed, `N of M checked don't hold` in red for To review.
- **DRAG A TABLE ONTO THE CANVAS TO DRAW TO IT (2026-08-18).** The canvas
  draws the anchor plus what it already connects to — which made the one
  authoring job impossible: a table with NO link to the anchor is by definition
  not on screen, so there was nothing to drag a relationship to. Sidebar rows
  are now `draggable` (`application/x-clarion-table`); dropping one on the
  canvas adds it as a **GUEST** at the drop point with its fields showing
  (auto-added to `showAll` — a guest has no join surface yet, so without fields
  there is nothing to grab). **Dropping saves NOTHING**: guests are pure view
  state, cleared when the anchor changes — the owner's requirement that a
  dropped table you never drew to must not persist. A guest someone DID draw to
  comes back as a real neighbour on the post-save reload. Guests keyed to the
  ANCHOR only, not `selectedEdgeId` — selecting the freshly drawn edge must not
  sweep the guest away mid-flow. A guest's existing links to visible tables draw
  too (re-creating a link blind is worse than seeing it), drop on an empty
  canvas = pick as anchor, and the existing draw/measure/match flow takes over
  unchanged from `onConnect`.
- **THE LEGEND IS FIXED PER TOGGLE — two wrong versions before this one.** V1
  was a catalogue of eight entries shown unconditionally, so a canvas of four
  amber links taught a red, a green and a solid-line code that appeared nowhere.
  V2 derived membership from `drawnRels`, which fixed that and broke something
  worse: **the key changed every time you picked a table**, so it had to be
  re-read instead of learned once (owner: *"the legend changes with each table.
  I want it to be always on"*). V3 keys membership to the BUCKET, which moves
  only when the user moves it. **Confirmed:** `laid by the source` · `laid
  manually` · the three caveat marks. **To review:** the four outcome colours
  (`unverified` cannot occur there — it needs a source-laid link). **The `1`/`∗`
  pair is GONE from the key and so is the chevron** — a key with a disclosure
  control is a key you have to operate. The symbols still draw on the line ends;
  they are deliberately NOT hoverable, because a tooltip needs pointer events
  and those circles sit 15px off the node edge, on top of the handles you drag
  to draw a relationship. Cardinality is explained in the inspector, where it is
  also editable.
- `tsc` clean, `next lint` clean, `next build` green (`/relationships` 2.6 kB /
  100 kB), 63 backend tests green, all six lint ratchets green **from the repo
  root** (they fail spuriously when run from `backend/`).
- **STILL OWED, and it needs the owner:** re-Analyse the Exact Online source so
  `semantic_source` is populated for existing rows (they are NULL until then, and
  a NULL channel reads as manual — the safe direction, but it undercounts the
  source-laid half). Only after that do we look at the real Confirmed / To review
  split and flip `getRelationshipsForContext` to confirmed-only.


**RELATIONSHIP CANVAS — SLICE 1 SHIPPED: THE MEASUREMENT ENDPOINT (2026-08-11).**
`POST /api/relationships/measure` (analyst+, `computeLimiter`, four ids in) answers
whether a proposed relationship actually holds:
`{ verdict, reason, containment, target, cardinality, orphans, thresholds, elapsedMs }`.
This is the interaction the whole canvas is built around — drag a line, get a real
answer instead of a form asking you to declare the cardinality.
- **`verifyFkCandidate` was EXTRACTED to `semantic/fkVerification.ts`.** Importing
  it from `SchemaProfiler` dragged in `ConnectorFactory` → DuckDB's native binding,
  so the service could not even load where that binding is unbuilt (this sandbox,
  and any test run). It only ever needed `{ executeQuery }`. SchemaProfiler
  re-exports it — **still exactly one implementation of the FK test**, which is the
  invariant that stopped Pass B inventing `→ GLClassifications.Name`.
- **Never refuses, never throws.** Missing table, uncastable type, unmaterialised
  warehouse, budget expiry → `verdict: 'unmeasurable'` + a machine-readable
  `reason` the UI renders as a sentence. A weak/broken result is REPORTED, not
  blocked — a half-synced source looks exactly like low containment and the human
  decides. Verdicts: `strong` | `weak` | `broken` | `unmeasurable`.
- **Own wall-clock budget** `RELATIONSHIP_MEASURE_TIMEOUT_MS` (8s, in
  `.env.example`) far below DuckDB's 45s, because this runs under an open popover.
  When the budget wins, the abandoned query gets a rejection sink — the route's
  `disconnect()` would otherwise turn it into an unhandled rejection.
- **`thresholds` is echoed** so the UI never hardcodes a number that lives in the
  detector's env. Containment stays SAMPLED, cardinality/orphans are FULL-table and
  labelled `basis`, so the two can never be presented as one ratio (the 2026-08-03
  defect).
- **Cross-source → 400 `cross_source_unsupported`**, deliberately: it needs two
  connections' views in one DuckDB session (slice 6). Identifiers are catalog-resolved
  by id AND regex-guarded before interpolation; all four ids go through
  `denyUnlessOwned`, and a column must belong to the table it was submitted with.
- **Migration 77 (slice 2) adds `kind` / `measured` / `match_keys`** to
  `table_relationships`. `kind` (`join`|`match`) defaults to `'join'`, so every
  existing row keeps its meaning and no backfill is needed — everything written
  before it was single-source by construction. `measured` caches the last
  measurement (NULL = never measured, which must not render as a zero);
  `match_keys` is meaningless for a join, hence nullable not defaulted.
  **Deliberately NO `connection_id`** — this table has never had one and scope
  resolves via `from_table_id` (`db/semanticCacheScope.ts`); a second path to the
  same answer is how the two drift apart. The Neo4j relationship EDGE does not
  carry `kind` yet — nothing writes a match edge until slice 6.
- **Slice 3 — `GET /api/relationships/graph` (tenant-scoped) is DONE.** Optional
  `connectionId` / `anchorTableId` / `depth` (1–3) / `withColumns=1`; returns
  sources, tables, relationships + `stats.{pendingReview,crossSource,unresolved}`.
  **It reads POSTGRES, NOT NEO4J, on purpose** — `semanticGraph` matches on a bare
  `pgId` with no tenant predicate, so id-gating works for "name one entity" but
  inverts for "everything this tenant has" (you would fetch an unscoped graph and
  filter it against an ownership query, i.e. read other tenants' rows to discard
  them). Postgres has `tenant_id` on all three tables and the dual-write contract
  already treats whole-tenant aggregates as Postgres-side. Every query filters
  `tenant_id` EXPLICITLY — `reqDb` can fall back to the pool whose session-level
  tenant var races. `isCrossSource` is computed server-side (the one thing the
  canvas exists to show); edges with an out-of-scope or unresolved endpoint are
  DROPPED from the drawing but COUNTED in `stats.unresolved`; truncation sets
  `truncated` while `stats.tables` keeps the real total. Provenance =
  human > ai > declared, and a confirmed row counts as human even if it began as
  an AI draft (confirming is taking ownership) — otherwise the queue re-shows
  finished work. 16 further unit tests.
- **Slice 4 — THE CANVAS IS LIVE at `/relationships`** (analyst+, **Studio** nav
  group on purpose: repair/escape-hatch tool, NOT the front door). New
  `components/relationships/`: `geometry.ts` · `types.ts` · `laneLayout.ts` ·
  `TableNode` · `LaneNode` · `RelationEdge` · `MeasurePanel` · `GraphCanvas`.
  (`laneLayout.ts` and `LaneNode` were later DELETED — see the ring layout below;
  the module set today is `geometry` · `types` · `focusLayout` · `sourceColors` ·
  `TableNode` · `RelationEdge` · `MeasurePanel` · `MatchPanel` · `EdgeInspector` ·
  `ValueExplorer` · `TableList` · `GraphCanvas`.)
  **Source lanes are NODES, not an overlay** — an absolutely-positioned band sits
  in SCREEN space and drifts off its tables on the first pan/zoom; as a node it
  gets the same viewport transform as everything else. **Deliberately NOT dagre** —
  dagre optimises for hierarchy and would interleave tables from different sources
  wherever that shortened an edge, destroying the one property lanes exist for
  (a cross-source edge is the only kind crossing a boundary). **Nodes collapsed by
  default**; columns (and per-column handles) appear on expand, and edges
  re-anchor from the node handle to the specific column row as tables open.
  **Provenance rides the LINE STYLE** (human solid ocean / declared thin grey /
  AI dashed amber) because the default view is a review queue and "what has nobody
  checked?" must be answerable across the whole graph at a glance; a match edge
  carries a second offset stroke so it can never read as a join. **Drawing
  measures before it saves** — drop → `POST /measure` → plain-language verdict →
  nothing written until "Keep it", and the MEASURED cardinality becomes the stored
  `relationship_type`. Weak/broken verdicts keep Keep enabled (a half-synced source
  looks exactly like low containment). **Two bugs found and fixed while building:**
  `POST /semantic/relationships` takes **snake_case** (`from_table_id`…) and
  camelCase silently fails validation; and the first lane implementation was an
  overlay (see above). `next build` green, `/relationships` 2.69 kB / 100 kB —
  ReactFlow is dynamically imported so it costs nothing on other pages.
  **FIRST VERSION WAS UNUSABLE — fixed 2026-08-13.** It rendered ALL 36 tables and
  a lane stacked them in ONE column, so the graph was a ~3,300px ribbon one node
  wide; `fitView` zoomed out to fit and nothing was legible. Two structural fixes:
  `packLane` now WRAPS a source into columns of ≤7 so a lane is a block not a
  strip, and **review is the default mode** — the canvas shows the focused
  relationship's two tables + one hop, pair opened on the joined columns,
  everything else dimmed; `Explore` is a deliberate second mode. Viewport refits
  on scope change with `maxZoom: 1` / `minZoom: 0.25` so nothing shrinks below
  reading size. **The lesson:** §2.4 "never render everything" was written down,
  the graph endpoint was built with `anchorTableId`/`depth` to support it, and the
  canvas called it with neither — a constraint implemented in the API but not
  exercised by its only caller is not implemented.
  **THREE MORE FIXES 2026-08-13.** (1) **Edges were unclickable** — a hand-rolled
  custom edge gets NO interaction path (ReactFlow only adds one inside
  `BaseEdge`), so the visible ~2px stroke was the entire hit target and selecting
  a relationship was near-impossible. That is why editing felt absent: the
  inspector existed but could not be reached. A transparent 18px stroke now sits
  under each edge, and the visible strokes are `pointerEvents: none` so they
  cannot swallow the click first. (2) **Source colour now covers the WHOLE node**
  — 4px spine, tinted header, tinted border and column-row rules — instead of one
  small dot; selection adds a RING rather than recolouring, so "which system is
  this from?" never stops being answerable. (3) **Relationships are now
  editable**: the inspector's cardinality is a 4-way picker (§2.1 promised "the
  user may always override the measured type" and read-only text never delivered
  it) and the joined columns are re-pickable per side. Both go through the
  existing PATCH, which already stamps `confirmed_by_user` — correcting a
  relationship IS taking ownership of it. Changing a column CLEARS the cached
  measurement, because it described different columns and a stale number on
  screen is worse than none.
  **READ BOTH COLUMNS AGAINST EACH OTHER (2026-08-13).** Owner wanted to
  investigate actual sample values from the two columns either side of a
  relation — sorted, scrollable, side by side. Right: five samples form a
  suspicion, they don't settle one. New **`GET /api/relationships/:id/values`**
  (`services/columnValues.ts`) returns ≤300 distinct values per side plus the
  REAL distinct count so the cap is stated, not implied; never cached (values
  change every sync). Compared and ordered **as TEXT**, matching
  `verifyFkCandidate` — a numeric key then sorts 1, 10, 100, 2, which looks odd
  but IS the ordering under which the columns were judged to match; showing a
  different one invites the wrong conclusion. **THE LISTS ARE MERGED, not shown
  side by side — that is the whole design.** Two independently scrolled columns
  say nothing (row 40 left has no relation to row 40 right); interleaved, an
  equal value takes ONE row and a one-sided value leaves a gap opposite it, so
  **the shape of the mismatch is the shape of the whitespace**. A missing value
  renders as an EMPTY cell, never a dash or label — the gap is the finding, and
  anything written in it reads as a value. Plus `N on both sides · M on one
  side only` and an *Only show differences* filter. `mergeSorted` is pure and
  was dry-run over identical/disjoint/partial/empty/formatting-difference/
  numeric-as-text inputs asserting neither side loses a value; 6 new backend
  tests. New env `RELATIONSHIP_VALUES_TIMEOUT_MS` (8s).
  **THE MERGED VALUE VIEW WAS DELETED — IT COULD NOT CARRY INFORMATION
  (2026-08-13).** Owner, on the shipped dialog: *"is this the way we want to
  display the data?"* No. **In a containment check "found" means the two values
  are textually EQUAL**, so a paired row showed the same string twice and an
  unpaired row showed a blank — the alignment could not carry information in
  either case. What it DID carry was noise: 20 child values against 1,289 parent
  values meant ~280 rows of unrelated parent keys before the first row that
  mattered. Two versions of that merge shipped before the idea itself was
  examined. **Now: two plain lists, each ascending, each scrolling on its own,
  the veel-kant ticked ✓/✗** — which is what was asked for originally. Nothing
  implies a row-by-row correspondence because there is none. This also DELETED
  the range-bounding and the paired-first ordering (both were scaffolding for
  that alignment, and both made the parent sample unrepresentative); a label
  they produced was already wrong on screen — *"showing 4 that line up with the
  left"* on a relationship where none of the 8 values matched.
  **THE CHECK NOW STATES ITS ASSERTION IN THE USER'S OWN NAMES.** Owner asked
  what exactly is measured. The rules said "the other column identifies one row"
  and "values found on the other side" — true but abstract. They now read
  *"Every AccountCode exists there"* / *"GL classifications.Code identifies one
  row"*, above a sentence naming both columns and stating that empty values are
  skipped and that DIFFERENT VALUES are counted, not rows. **This matters
  because no measurement can decide whether a link is MEANINGFUL** —
  `LineNumber → GLClassifications.Code` measures 76% because line numbers 1-40
  happen to also be account codes. A person can reject that on sight, but only
  if the assertion is written in the names they know. Provenance next to the
  measurement is the other half: documented + measures well = trustworthy;
  measures well + nobody documented it = the coincidence the old detector mass-
  produced.
  **THE VALUE COMPARISON LIED — FIXED SAME DAY (2026-08-13).** Owner: *"Values
  found on the other side can never be 100% here, can it?"* It could, and the
  100% was right — **the dialog was wrong.**
  `Payments.TransactionID → TransactionLines.ID` measures a true 100%, while
  the comparison reported *30 on both sides · 458 on one side only*. Cause: the
  first N distinct values of EACH side were fetched independently, so 218 GUIDs
  on the left (all late in the alphabet) against the first 300 of 2,589 on the
  right (all early) gave two windows that barely overlap — every row read as a
  mismatch that does not exist. **This is the same defect shape as the
  2026-08-03 detector bug**: a numerator from one sample, a denominator from
  another. Two fixes, both needed: (1) **`matched` is an EXISTS against the
  WHOLE parent column**, never the fetched window, so the headline count always
  agrees with the check; (2) **the parent side is fetched within the child
  window's RANGE** (`bounds.lo`/`bounds.hi`), so both columns describe the same
  stretch of the value space. The header now says *only the matching stretch*,
  not "first 300" — which would have been wrong as well as misleading. **The
  tick is the fact, the gap is only alignment**: a row with nothing opposite it
  may just be past the end of the parent window, so only a LEFT value whose
  `matched` is false is highlighted; a parent key nobody references is normal.
  Verified by dry-run: the production case now reports `3 of 3 found` where a
  merge-derived count says 1. 9 backend tests.
  **EVIDENCE NOW OUTRANKS PROVENANCE ON THE LINE (2026-08-13).** Owner, after
  sweeping one table: *"they appear trustworthy because of their blue line, but
  some match for 0 percent."* **First, the facts: NONE of the failing columns is
  documented by Exact Online.** `TransactionLines.JournalCode → Journals.Code`
  IS curated (`entities.ts:881`) and measures 100%; `→ Journals.ID` is neither
  documented nor curated and measures 0%. Same for
  `Documents.FinancialTransactionEntryID → TransactionLines.ID` (0%, 330
  unmatched) and `AccountCode`/`LineNumber → GLClassifications.Code|Name`
  (76–80%). **These are exactly the invented FKs the 2026-08-03 audit measured**
  — it named those columns and `→ GLClassifications.Name` explicitly. The tenant
  was profiled BEFORE the detector rebuild, so the rows survive; a re-Analyse
  would not create most of them today. **The design defect:** the line encoded
  only WHO asserted a link, so a human-confirmed relationship measuring 0% drew
  as the strongest line on the canvas. Two unrelated facts, one channel. Now:
  **COLOUR = what the data says** (neutral unchecked · holds · partly · no
  match), **DASH = who asserted it**. Unchecked stays NEUTRAL, never green —
  not-yet-checked is not the same as fine, and that conflation was the bug. A
  flag outranks both. **Plus: you can find the damage.** Sidebar gained a
  *Needs attention* filter (flagged / contradicted / undecided — deliberately
  NOT "unchecked", which before the first sweep matches everything and so
  filters nothing) and **Check all shown**, scoped to whatever the list is
  showing so search doubles as scoping. Toolbar reports `N checked · M don't
  hold` at tenant scale. **A table's links are grouped by the FIELD they leave
  from** with an `N targets` marker: one column with two targets is this
  catalog's most common defect and is invisible when the rows are scattered.
  **FLAGGING — THE THIRD THING YOU CAN SAY ABOUT A RELATIONSHIP (2026-08-13).**
  Owner, on a human-confirmed link measuring 0%: *"I really want to flag this
  while I'm investigating the table."* Not possible: a relationship had exactly
  two states a person could put it in — **confirmed** or **deleted** — and
  neither fits the finding that actually turns up (*the data says this does not
  hold, but I am not deleting it; the source probably hasn't finished syncing*).
  Deleting throws away a likely-real link; confirming asserts what the data
  contradicts. So people do neither and the finding dies with the panel.
  **Migration 78** adds `flagged_at` + `flagged_reason` — a nullable TIMESTAMP
  not a boolean, because *when* it was raised tells you whether a sync has had
  time to fix it since. Deliberately **NOT `approval_status`**: source
  tables/columns carry that with its own draft/approved/flagged vocabulary tied
  to the AI review queue, and a relationship flag is an observation about the
  DATA, not a step in that queue. **`POST /api/relationships/:id/flag`** leaves
  `confirmed_by_user`/`ai_draft` alone (same rule as `/check`).
  **THE FLAG HAS TEETH: `getRelationshipsForContext` now EXCLUDES flagged
  edges**, so a link a person says doesn't hold stops being handed to the model
  as a joinable key — that is the whole reason to flag rather than leave a note,
  and the panel says so in words. One click puts it back. **This is the one
  field mirrored onto the Neo4j EDGE** (`setRelationshipFlagged`), so the
  AI-context read filters in its own `MATCH` instead of subtracting a Postgres
  query from a graph result; the reason text stays Postgres-only.
  **Findable or it's decoration:** flagged links sort to the top of a table's
  list with an icon, the table row shows a flag count that outranks the pending
  badge, the toolbar carries the tenant total — and `stats.flagged` counts over
  EVERY row including undrawable ones, because a flag on a link whose endpoint
  later stopped resolving is still owed an answer.
  **CHECK A WHOLE TABLE AT ONCE + THE CHECKS ARE NOW SHOWN (2026-08-13).**
  Owner asked (a) whether the "checked against your data" result was AI —
  **it never was**, it is `verifyFkCandidate`'s three fixed SQL rules — and
  (b) for a per-table run button instead of checking each relationship.
  (1) **The three rules now RENDER** with measured value vs threshold
  (enough distinct values · the other column identifies one row · values found
  on the other side), plus a line saying outright that these are fixed SQL
  rules with no AI. The defect was never the check, it was showing only the
  conclusion: **a verdict you cannot audit is one you must take on faith**,
  which is what this pane exists to avoid. All three rows always render even
  though the detector short-circuits — the one query computes every number
  anyway. (2) **Contradictions are FLAGGED**: a `declared` (vendor-documented)
  or human-confirmed relationship measuring `broken` is almost always an
  unfinished sync, not a wrong link, and saying so turns a number into a next
  step. (3) **NEW `POST /api/relationships/:id/check`** measures + caches.
  **It exists because MEASURING IS NOT DECIDING** — storing via
  `PATCH /semantic/relationships/:id` was silently stamping
  `confirmed_by_user` and clearing `ai_draft`, so "Check again" CONFIRMED an
  unreviewed AI suggestion and a table sweep would have emptied the review
  queue as a side effect of asking a question. Example sampling is now
  optional (`withExamples:false` for sweeps — saves a third query per link).
  (4) **The run lives in the table list** as ONE line (offer → progress →
  result), two links at a time (DuckDB allows two concurrent queries per
  tenant; more only queues and raises timeout risk), a failed link never stops
  the sweep, results land one by one, leaving the table abandons the run.
  (5) **Three outcomes, not four verdicts** — `weak`/`broken` blur what was
  asked for, the ratio does not: **holds** / **partly match** (usually a
  formatting difference worth fixing) / **no match** (usually the wrong column
  or an unfinished sync). `holds` still needs the FULL verdict: a link can
  match 100% and still fail because the other column is not an identifier.
  (6) Robustness: `cardinality` arrives as a CAST of a free-text column, so an
  unexpected stored value gave `undefined` and indexing it would throw inside
  a render and take the canvas down.
  **EXAMPLE VALUES + CARDINALITY ON THE LINE ENDS (2026-08-13).** Owner: the
  measurement panel wasn't intuitive, and the diagram didn't show cardinality.
  (1) **`measureRelationship` now returns `examples`** — a few source values that
  found a partner, a few that did not, and a few target values for comparison.
  A percentage says there is a gap; only the VALUES say whether it is a
  formatting difference you can fix (`BE 0123.456` vs `be0123456`), the wrong
  column (GUIDs vs codes), or a genuinely absent parent — all three look
  identical as `0%`. Same reasoning as slice 7's unmatched samples, applied to
  joins. **Sampling is NOT in `verifyFkCandidate`** (that runs for every
  candidate of every table during profiling and must not carry a presentation
  cost), its CTE is named `ex` not `src` so the unit tests can still tell the
  three queries apart, and it has **its own sub-budget** (total/3, capped 2.5s)
  — the first attempt raced all three queries against one wall clock, so a slow
  sample query returned `unmeasurable` for a measurement that had ALREADY
  SUCCEEDED. (2) **The panel leads with the verdict in words**, then an overlap
  BAR ("2 of 24 values exist in Payment conditions.ID") instead of a bare
  `FOUND 0%` sitting above "it may still be right" — which read as a
  contradiction. `too-few-distinct` copy split: all-matched-but-too-few really
  is "may still be right"; none-matched is evidence and says so. (3)
  **Cardinality moved to the LINE ENDS** — `1` = one row, `∗` = many (U+2217,
  centred in the circle). `N—1` in the middle tells you the shape but not which
  side it applies to. The middle badge survives only on MATCH edges, where it
  shows the rate and where a cardinality would be a lie; a corner legend names
  the symbols rather than assuming ERD literacy.
  **THE TABLE LIST IS NOW THE WORK LIST (2026-08-13).** Owner: *"how do I check
  or edit per table? I can't select anything myself."* Correct — Review walked a
  GLOBAL queue in whatever order the rows came back, and `TableList` existed only
  in Explore where it merely moved the camera, so "I want to go over the bank
  entries" was unreachable. Fixes: (1) **the list renders in BOTH modes** — it is
  how you choose what to work on, and without it the canvas decides for you;
  (2) **expanding a table lists its relationships**, each clickable straight into
  the inspector (undecided first, hollow amber dot = AI suggestion, solid = a
  person decided — same vocabulary as the edge styles), which is the "edit per
  table" path that stepping a queue could never give; (3) **picking a table in
  Review NARROWS the queue to that table**, with a visible chip and a one-click
  "Review everything" — a filter you cannot see is a filter you get stuck in;
  (4) **pending counts on the table rows**, sorted pending-first, so the list
  answers "where is the work?" before any click; (5) clicking a table means the
  same thing from the list and from a canvas node (one handler). **The scope is
  set by CLICKING and never derived from the current queue item** — deriving it
  would let the queue silently narrow itself to whatever it landed on. The page
  header copy still described the deleted lane grid ("grouped by where it came
  from") and now describes what the screen does.
  **ONE TABLE IN THE MIDDLE, ITS JOIN SURFACE VISIBLE (2026-08-13) — the
  layout is now a RING, and lanes are DELETED.** The grid still did not say which
  table the view was about, and finding the two fields a table joins on still
  meant opening it and reading forty column rows. Both are answers the layout
  should give. **A person does exactly two things here** — "what does THIS table
  connect to, and on which fields?" and "is this suggested relationship right?" —
  so there is no view that draws the whole graph. (1) **Explore is
  `focusLayout.radialLayout`: the anchor dead-centre, neighbours on an ellipse
  around it.** Centre is not decoration — it is the only layout where the subject
  needs no label — and it removes edge crossings BY CONSTRUCTION, since every edge
  runs from the centre outward. (2) **THE CHANGE THAT MATTERS: a table renders the
  fields it CONNECTS ON, not all of them and not none.** Forty columns buries the
  answer to the only question asked; zero columns makes you click to find it. The
  join surface is two or three rows, so every edge terminates on a NAMED FIELD at
  both ends with nothing to open; `+N more fields` reveals the rest, which is the
  one job (drawing a new relationship) that legitimately wants the full list.
  (3) **Review is the pair side by side** (`pairLayout`), joined columns lit — the
  one-hop context it used to draw was clutter, because the evidence for the
  decision is the measurement in the inspector. (4) **Handles follow the
  geometry** — they were hardcoded right-to-left, so every neighbour on the left
  half of the ring got a line sweeping all the way around its node. (5) **`LaneNode`
  and `laneLayout.ts` are DELETED**; `sourceColors.ts` keeps the palette and the
  stable per-source assignment. Lanes were real (a cross-source edge was the only
  kind crossing a band) but that only pays off in a view that draws everything,
  which §2.4 forbids — the two ideas could not both be right. (6) **Ring capacity
  12**, ranked by shared-link count then re-sorted so same-source neighbours are
  adjacent (an alternating ring makes the colour spine useless); the toolbar says
  "showing 12 of 31" rather than truncating silently. (7) **Finishing the queue
  now says so** — the bootstrap that opens on the first pending item runs ONCE via
  a ref, so clearing the queue no longer silently bounces you to Explore.
  **`nodeHeight()` is the single expression the layout and the node component both
  call** — they must agree exactly or edges land off their rows and the ring stops
  being centred. `tsc` clean, `next lint` clean, `next build` green
  (`/relationships` 2.69 kB / 100 kB).
  **EXPLORE REBUILT AROUND ONE ANCHOR (2026-08-13).** The full-graph Explore view
  was the hairball §2.4 exists to prevent — 36 tables, 169 edges, plus two
  40-column nodes whose expansion LEAKED IN FROM REVIEW MODE and shredded the
  lane packing (the packer assumes roughly uniform node heights). Four changes,
  agreed with the owner: (1) **there is no "everything" view** — Explore centres
  on ONE table and shows what it connects to, with a searchable `TableList`
  sidebar (grouped by source, sorted by relationship count, because hubs are what
  people look for and alphabetical buries them); clicking a neighbour re-anchors
  and walks the graph. (2) **Expansion resets on every mode change** and is scoped
  to the pair being linked. (3) **Only edges TOUCHING the focus are drawn** — a
  neighbour's own relationships are not this view's subject, and drawing them is
  what made 169 links unreadable. (4) **Colour stays always-on per source** (owner's
  call over my "only when it distinguishes" suggestion) but is now concentrated in
  a 5px SPINE instead of washing header + border + every row rule in one hue —
  with a single source those three tinted surfaces read as "everything is beige"
  rather than "this is Exact Online".
  **ONE PLACE FOR EVERYTHING — THE REVIEW/EXPLORE SPLIT IS DELETED (2026-08-13).**
  Owner, after the functionality was all in: *"is het nogal druk denk ik?"* — yes,
  and the mode switch was the root of it. **Review and Explore were two places to
  be**: the same table could be open in one and unreachable in the other, the
  sidebar meant something different on either side of the toggle, and "where do I
  go to fix this?" had two answers. **What the canvas is about is now DERIVED,
  never chosen** — a table selected shows its join surface, a relationship
  selected shows that pair; picking one thing is the only gesture, and Escape /
  pane-click / *Back to the table* lets go of the relationship. **The queue
  follows the sidebar**: J/K step through the SELECTED TABLE's links, not a global
  list of AI suggestions — walking the whole catalog meant the next item could be
  a table you had never opened, which is precisely why "I want to go over the bank
  entries" was unreachable. Deleted with the mode: `reviewScopeId`, the scope
  chip, the *Nothing left to review* card, and the bootstrap that dropped you
  inside one suggested link before you had asked about anything (it now opens on
  the table with the most work waiting on it).
  **THE INSPECTOR LEADS WITH THE EVIDENCE.** It opened with a provenance chip, a
  sentence about provenance, a 4-button shape picker with two explanatory lines
  and two column pickers with a third — so the measurement, *the only thing that
  tells you whether the shape and columns are worth correcting*, sat below the
  fold behind four paragraphs. Now: verdict → checks → compare-values, then the
  corrections. Provenance is a chip on the title line; the shape picker is a
  dropdown beside the column pickers (a settled field, not a decision — four
  always-visible options gave it the weight of one); **every explanation is intact
  behind a `?`**, because each is true and each is read exactly once. Plus: a
  table's links group under the field they leave from so one column with two
  targets is self-evident rather than announced; the legend folds down to the
  colour scale (the part that is a key rather than a paragraph); the page header
  is one line instead of three describing gestures the screen already offers.
- **Slices 6 + 7 — CROSS-SOURCE MATCHING.** `POST /api/relationships/match-preview`.
  Drawing between two sources opens a **match** panel, not the join panel.
  `crossSourceSession.buildTwoSourceConnector` puts **two connections' tables in
  ONE DuckDB session** — resolves each URI via `listSourceTables`, registers both
  under FIXED NEUTRAL view names (`match_left`/`match_right`) because two sources
  may each have a table called `Accounts`, and uses `DuckDBConnector.ephemeral` so
  a one-off scratch session never takes a key in the shared pool. Split from
  `matchMeasure` (pure, unit-tested) for the same reason `fkVerification` was split
  out — importing the measurement must not drag in the native binding.
  **Normalisation is the whole game:** default `loose` strips non-alphanumerics +
  upper-cases so `BE 0123.456.789` == `be0123456789`; raw comparison understates
  real overlap, which is what makes someone conclude their data can't be joined
  when it can. `exact` is one click away. **The unmatched SAMPLES are slice 7's
  substance** — a rate says there's a gap, the samples say it's a formatting
  problem you can fix. Stored `kind='match'` + `match_keys` + `measured`, never a
  join. **`getMatchAssertions` phrases matches for the AI as identity assertions**
  (`relationship_type: 'same_entity_as'` + a description stating outright it is NOT
  an FK and must not be JOINed); only CONFIRMED matches reach the prompt.
  **Two bugs found:** `POST /semantic/relationships` was **admin-only** while
  PATCH/DELETE were admin+analyst, so an analyst could measure a link and then be
  refused when saving it (widened for parity); and the confirm message claimed
  "Ask AI can now answer questions that span both sources", which is **NOT TRUE**
  while the query layer is still `connectionId`-scoped — copy now says what is
  true. **NOT shipped (honest boundary of slice 7):** the persisted per-row
  crosswalk ("Shopify customer 4471 IS Exact's VAN DAMME BVBA" × 900 rows). That
  is the identity layer and is a separate, much larger piece.
- 41 unit tests total across the three services, no DuckDB needed. `tsc` clean,
  validate-coverage ratchet back at
  166 (my multi-line `router.post(` initially hid the `validate()` from the linter's
  2-line window — keep it within two lines).

**RELATIONSHIP CANVAS — BUILD PLAN AGREED (2026-08-11).** New
`docs/backlog/relationship-canvas.md`. A cross-source relationship pane whose
purpose is **building AI context by drawing**. Four decisions are SETTLED: primary
job = **review what Clarion proposed** (the canvas IS the queue, not a blank
canvas); scope = **cross-source from day one**; downstream effect = **enrich AI
context only, never rebuild**; and **clean sheet** (new route + components; the
1,975-line `RelationshipCanvas.tsx` and `components/catalog/relationships/*` retire
only AT PARITY). Geometry constants (`HEADER_H`/`ROW_H`/`NODE_W`, the `L_`/`R_`
handle-ID scheme) are LIFTED not re-derived — handle alignment against column rows
is fiddly and currently correct.
**The five ideas that matter:** (1) **MEASURE the relation, never ask the user to
declare cardinality** — drop a line and Clarion answers "97% of values found in
target · 1-to-many (avg 3.2, max 47) · 23 orphans"; the measurement IS the
confirmation dialog. It MUST reuse the detector's own constants (`FK_SAMPLE_SIZE`,
`FK_MIN_DISTINCT`, `FK_TARGET_UNIQUENESS`, `FK_MIN_CONTAINMENT`) and take
containment + cardinality from the SAME sample — mismatched sets were the exact
defect measured in production on 2026-08-03. (2) **TWO EDGE KINDS that are not the
same object** — a `join` (inside a source, a real FK, verified by containment) vs a
`match` (between sources, an assertion that two tables describe the same real-world
things, verified by match rate, truth lives PER ROW). A match edge is the entry
point to per-row matching, NOT a join; collapsing them is what makes cross-system
look easy and then be wrong. (3) **SOURCE LANES** — vertical bands per source in the
`SourceBadge` palette, so cross-source edges are the only ones crossing a boundary
and the thing you came for is the thing that pops. (4) **NEVER RENDER EVERYTHING** —
60 EO entities × 170 rels is a hairball; anchor + one hop + expand on demand,
collapsed nodes by default. (5) **PROVENANCE IN THE LINE STYLE** (declared /
AI-suggested / human-confirmed) so the review queue becomes a canvas filter; human
wins forever via migration 70's EXISTING snapshot-and-merge — do not add a second
mechanism. Plus: **show the payoff** after confirming ("Ask AI can now answer
questions spanning Exact and your webshop") or the loop is invisible and the tool
goes unused.
**Backend prerequisites are the real work:** a **tenant-scoped graph endpoint**
(everything is `connectionId`-scoped today — same un-scoping problem as the query
layer, and every id must go through `denyUnlessOwned`/`ownedIds` because Neo4j has
no tenant predicate); a **measurement endpoint** (cross-source measurement needs
views from TWO connections in one DuckDB session — `createProductConnector` is
connection-scoped, so this is real work, not a query; column names must be validated
against the catalog, never interpolated); a **migration** adding `kind`
(`join`|`match`, default `join` so existing rows are unchanged), `measured` jsonb and
`match_keys` jsonb to `table_relationships` (which has NO `connection_id` — scope
resolves via `from_table_id`); and **match edges must reach
`getRelationshipsForContext`** phrased as identity assertions, not joins.
**Build order:** measurement endpoint (single-source, testable with no UI) →
migration → tenant-scoped graph → new route with lanes/collapsed nodes/join edges →
queue-as-canvas + keyboard model → match edges + cross-source measurement → match
panel into per-row review → retire the old canvas at parity.
**§6 what NOT to do:** not the onboarding front door (escape hatch and repair tool —
a new customer must never meet 170 edges on day one), no auto-rebuild, never render
the full graph, never store a match as a join, no second human-edit-survival
mechanism, no layout persistence in v1.

**PLAN OF RECORD IS §5.8 — TEN FIXED NAMES, NOTHING ELSE (2026-08-10).** The
owner ruled out versioned entries, promotion of names, aliases and deprecation
windows. Removing them makes the design SIMPLER, not weaker, because the contract
columns already do the work promotion was there to do. **The whole design:**
(1) **ONE LIST, 12 lines, written once, never changes** — `dim_customer`
(`customer_key`; match `vat_number,email`), `dim_supplier`, `dim_product`,
`dim_product_group`, `dim_gl_account`, `dim_journal`, `dim_payment_term`,
`dim_employee`, `dim_entity`, **`dim_location`, `dim_department`**, plus the
existing `dim_date`. Written from what is already known, not discovered over time.
No version number; nothing is ever promoted into it. (2) **Four sentences in the AI
prompt**, not systems: "if a source has customers the table is `dim_customer` and
the VAT number goes in `vat_number`"; "anything not on the list, name it
`dim_<singular_english_noun>`"; **"reuse a dim in multiple ROLES — invoice/due/
payment date are all `dim_date`; never emit `dim_invoice_date` or
`dim_ship_date`"**; **"never create a dimension for a status, transaction type,
flag set or audit metadata"**. (3) **Anything
off the list is the TENANT'S OWN** — AI names it, it builds, it works;
`dim_sales_channel` here and `dim_channel` there DOES NOT MATTER because Clarion
ships nothing that reads them. Divergence only matters for what Clarion ships
against, and Clarion only ships against the ten. No counting, no threshold, no
promotion. (4) **AI re-derives the mapping per tenant and that is fine** — the
fixed names + key/match columns pin the OUTPUT SHAPE however many times AI runs, so
consistency comes from the contract rather than from caching. **This is why the
"promote confirmed mappings" step earlier called load-bearing is NOT needed**;
caching a confirmed mapping is a pure cost optimisation to add later if AI spend
becomes annoying, as a cache, not as architecture.
**Nowhere can a customer be blocked waiting for us:** no shipped mapping → AI maps
it; unusual source → AI names and builds it; AI wrong → user corrects in the UI;
the list never changes so there is nothing to wait for.
**NOT built:** versioned entries, promotion, aliases/deprecation, unmatched-dim
counters as a feature, a canonical model, conformed facts or measures, per-tenant
model governance.
**§5.9 — THE LIST IS NOW EVIDENCED AGAINST KIMBALL, NOT JUST AGAINST EO+ODOO.**
The owner supplied a chapter-by-chapter breakdown of *The Data Warehouse Toolkit*
(3rd ed.) splitting each of 13 industry bus matrices into CONFORMED vs SINGLE-USE
dimensions. Tallying concepts across chapters (Passenger/Student/Patient/
Policyholder all = customer; Store/Warehouse/Branch/Facility/Airport all =
location): date 13/13, **customer 10/13**, employee 9/13, product 9/13,
**location 8/13**, **department 5/13**, carrier 4/13, supplier 3/13, then
gl_account / product_group / channel / promotion / status at 2/13.
**Result: +2 added (`dim_location`, `dim_department`), `dim_carrier` held back
until a webshop/delivery source exists — and FOUR earlier guesses REMOVED because
the book contradicts them:** currency (Kimball lists it SINGLE-USE), payment method
(SINGLE-USE, POS only), promotion/campaign (2/13, webshop-specific), project (absent
from every conformed set). **The book trimmed more than it added**, which is the
strongest evidence yet that this design does not quietly grow into a canonical
model. **Low Kimball frequency ≠ low value** — gl_account and journal score 2/13
only because most case studies aren't accounting-centric; for an SMB platform
anchored on accounting they are essential, so the second filter is always "would a
realistic SMB source actually emit this table?". **Two prompt rules fall out of the
book:** (a) ROLE-PLAYING — one physical dim used in several roles (invoice/due/
payment date, ship-to/bill-to, employee-as-manager); left alone AI emits
`dim_order_date` + `dim_ship_date` and breaks conformance immediately; (b) NEVER
conform a status / transaction type / flag set / audit dim — the book's clearest
structural teaching is that every bus-matrix column is conformed while junk, audit,
status, transaction-type and mini-dimensions live only in the detail figures;
degenerate dims (invoice/order numbers) stay on the fact with no table.
**WHAT TO ACTUALLY BUILD:** (1) write the ten-line list — half a day; (2) rename
the dims in both existing templates to match, which also fixes the live
`dim_account` collision — half a day; (3) add the two naming sentences to the
star-schema/bus-matrix prompts — small; (4) **the real build — an AI step that maps
a SECOND source into the dims that already exist**, proposed in plain language,
user confirms; (5) the identity layer for per-row matching (§2.2), separate and
larger. Items 1–3 are worth doing regardless of the rest of this doc.

**BACKGROUND — DERIVE THE DIMS, STANDARDISE THE NAMES (§5.7).**
The owner's landing position, and it supersedes both the canonical model (§2.1)
and the measured conformed set (§5.6); both are kept in the doc because their
reasoning is what produced §5.7. **Ship NO canonical model.** Let the first source
DERIVE its dims and facts (existing connector template, or AI where there is
none), but **standardise the dimension NAMES** to Kimball convention —
`dim_customer`, `dim_product`, `dim_gl_account`. When a second source arrives, AI
works out how it flows into the dims that ALREADY EXIST, using that source's
relationships and definitions, user confirming. This is better than a shipped
model: nothing to design up front, **unanticipated dims come free**
(`dim_cost_centre` just exists), the model reflects what sources actually have,
and AI is used for mapping-onto-a-known-target rather than schema design — the
task it was measurably bad at. **Three additions make it work:**
(1) **A thin attribute contract, not just a name** — a standard name with
free-form contents is a promise the platform can't keep, because a shipped metric
reading `dim_customer.country` works for the Exact-derived tenant and fails
silently for the Shopify-derived one. Fix only the identity column
(`customer_key`) + the match attributes (`vat_number`, `email`) — 3–5 columns per
dim; everything else stays source-derived.
(2) **A source-priority rule** — otherwise CONNECTION ORDER decides the model
(Shopify-first vs Exact-first tenants get differently-shaped `dim_customer`, and
adding Exact later squeezes rich accounting master data into a webshop shape).
Rule: **when present, the accounting/ERP source establishes master-data dim
shape.**
(3) **THE LOAD-BEARING ONE — promote confirmed mappings from tenant-local to
shipped.** The first time Shopify→`dim_customer` is AI-proposed and
human-confirmed, STORE it and reuse it for the next tenant on that connector. At
that point this design and §2.1 converge, because a cached confirmed mapping IS a
shipped connector mapping — only DISCOVERED from real data instead of authored in
advance, which is strictly better. Without it every tenant re-derives the same
mapping differently and the platform never accumulates. Ladder per connector:
**confirmed shipped mapping → AI proposal → user confirmation → promote back to
shipped** (a loop, not one-way).
**THE DIVIDING LINE (§5.7, "What Clarion specifies"):** Clarion standardises the
cheapest/highest-leverage thing — NAMES — and AI does everything expensive and
variable. The entire up-front spec is **one ~40-line file**: per standard dim, its
`identity` / `match` / `label` column names (`dim_customer` → `customer_key`,
`vat_number,email`, `customer_name`; likewise supplier, product, product_group,
gl_account, journal, payment_term, employee, entity; `dim_date` already exists).
It says "when a source has customers the table is `dim_customer`, and a VAT number
goes in `vat_number`" — NOT what a customer is or which attributes it has. AI then
reads each source's tables/columns/relations/docs, decides which source table
feeds which standard dim, fills the contract columns, **brings every other source
column along unchanged**, proposes in plain language, user confirms, mapping is
stored + reused. **Why Clarion must own even the names:** AI naming per tenant
gives one `dim_customer` and another `dim_client`, and then no shipped dashboard,
support answer, prompt or matching code works anywhere — names must be identical
everywhere AND cost zero flexibility (a name constrains no contents). **The list
grows from evidence:** an unmatched dim (Shopify sales channel) is created with no
contract columns and COUNTED; at ~20 tenants it earns a line in the file.
**DOES THE FILE EXPLODE AT 15 CONNECTORS? No — it grows with SHARED concepts, not
with sources, and those saturate.** Inclusion needs ≥2 connectors, and most of
what a new source brings is unique to it (Shopify → customer/product already
standard, *sales channel* only once a SECOND webshop exists; HubSpot → customer,
*pipeline stage* only at a second CRM). ~1–3 entries per connector, ~15–20 (≈80
lines) at ten connectors. **Tier the entries:** Tier 1 = MATCHING dims
(customer, supplier, product, employee, entity) carry identity+match columns —
**this set is essentially closed already**, because parties/products/people are
what SMBs match across systems and there is no sixth category; Tier 2 = name-only
dims (journal, payment term, sales channel, cost centre) need consistency of NAME
and nothing else — one word each. So the part that costs thought stops growing
immediately and the part that grows costs a word. Cost per entry is CONSTANT: a
name (+3 column names if Tier 1), never "what IS a sales channel" — that is the
whole difference from a canonical model, where each entity costs a design
discussion. **The real cost is RENAMING after promotion** (20 tenants hold
`dim_shop_channel`, it becomes `dim_sales_channel`). Two cheap day-one
mitigations: **constrain the naming PATTERN even where the name isn't specified**
(AI must emit `dim_<singular_snake_case_english_noun>`, so ad-hoc names land close
to the eventual standard and promotion is a trivial rename), and **keep an alias
list** so a promoted dim answers to its old name through a deprecation window.
Governance is the counter, not a design meeting: review it when onboarding a
connector, promote over threshold, version the file, tenants pick it up on next
build. **And if the file ever DOES reach ~50 rich entries, that is not a failure —
it is evidence a canonical model was right, arrived at from what customers
actually run. The design self-corrects in both directions.**
**Unchanged:** the identity layer is still required (no name convention or AI
mapping tells you Shopify customer 4471 IS Exact's VAN DAMME BVBA — per-row
assertion); facts stay per-connector; "not conformed" stays visible and counted.
**Deferred, not lost:** benchmarking needs comparable MEASURES, which live on
facts, so it moves further out — add measure conformance later on the same
promote-what-is-confirmed mechanism.

**BACKGROUND — WHAT CLARION SHOULD BECOME (2026-08-10).** New
`docs/backlog/warehouse-value-for-smb.md`: the three jobs an SMB actually buys a
warehouse for — cross-system questions, spreadsheets as a first-class source,
multi-entity consolidation — benchmarked against Fabric/Power BI. **Proposal
status, awaiting owner sign-off (§9).** The doc is a TARGET-STATE argument; the
current code is an appendix (§8), deliberately, because the first draft reasoned
from today's constraints and produced a roadmap for the platform Clarion is
rather than the one it should be.
**The reframe:** the three themes are one problem — an SMB's business never lives
in one system, so the warehouse's job is to be the single reconciled picture of
the whole business that stays true as systems come and go. In the Microsoft stack
those reconciliation decisions are Power Query code a consultant wrote; in
Clarion they should be **content** a business user owns.
**Six layers Clarion should have** (§2): (1) a **canonical SMB business model
that exists before any source** — ~10 entities, sources map INTO it rather than
defining it; this inverts today's source→profile→AI-designs-a-model direction and
makes cross-system a non-feature, turns each new connector into a cheap mapping
job, narrows AI from designer to mapper, and lets dashboards survive an ERP
migration; (2) an **identity layer** — a party registry with externally-VERIFIED
rungs (VIES VAT, KBO/BCE) above deterministic keys above AI, compounding into a
moat and yielding sector/size enrichment for free; (3) **Excel bidirectionally** —
linked files, in-product managed grids, round-trip keys, and Excel-as-a-client,
on the argument that Excel is the SMB accountant's real analytics UI and should be
made trustworthy rather than replaced; (4) **entity as an axis from day one**, not
a consolidation feature — and the broader read that the accounting firm's **client
portfolio** is the same axis, making this a CHANNEL strategy needing a tier above
the tenant designed into the permission model early; (5) a **shipped metric
library** and then **anonymous peer benchmarking**, which only a multi-tenant
platform with a canonical model can do and Fabric structurally cannot;
(6) **reconciliation as a shipped, visible feature** — a warehouse that proves
itself against the source system's own totals is worth paying for; one that does
not is a liability.
**Why this is not a rewrite (§4):** the connector star-schema templates are
already per-connector deterministic models, and both independently converged on a
customer dimension carrying `vat_number` under the same name. The move is to
unify deliberately what is already converging — extract the shared target, add it
alongside, keep existing products working.
**THE MAIN ALTERNATIVE IS ANSWERED IN §5** — "draw the relationships across all
sources in a canvas and derive the Kimball model from that graph, instead of
pre-determining entities". Read it before re-proposing that; it is the natural
instinct and it is right about the long tail. Why it fails as the PRIMARY path:
a relationship graph is only the ~10% of Kimball modelling that is "what joins to
what" — grain, additivity and meaning are untouched; the cross-system link is
precisely the one that CANNOT be drawn, because between two systems there is no
FK, only a per-ROW identity assertion about the real world (so §2.2's identity
layer is required either way); ~170 relationships across 60 EO entities is a
data-modelling exercise no SMB owner will do, and the 2026-08-03 audit measured
the AI-proposed version at 8 unresolved / 10 target-not-key / 14 multi-target out
of 170; per-tenant models compose with nothing, so shipped metrics, benchmarking
and cross-tenant support all become impossible and the platform stops
accumulating. **And Clarion already ran this experiment** — the connector
star-schema templates exist BECAUSE the AI designer working from schema +
relationships was worse, and the bus-matrix flow now prefers the template.
**The reframe:** a canonical model does not decide what the customer NEEDS, it
decides what Clarion KNOWS ABOUT — the other ~48 EO entities still sync, still
land as source tables, still query (spine, not cage). The entities are
near-universal (an invoice is an invoice; the Belgian chart of accounts is
legislated); what varies is the MAPPING and the vocabulary. **Synthesis (§5.3):**
the drawer is the INPUT, not the output — layer 0 source graph (drawer repairs +
extends) → layer 1 mapping into canonical concepts → layer 2 canonical model →
layer 3 generated star schema. The drawer stays and must be excellent, for
sources Clarion has never seen (custom SQL Server, homegrown), custom fields, and
repair — plus the highest-leverage use, **as Clarion's own authoring tool for
layer 1**, which makes connector onboarding a modelling task instead of a
TypeScript task and ships to every tenant at once. It is the escape hatch, not
the front door (§5.4).
**§5.5 answers the refined version** — "understand the sources and their
relations FIRST, then determine which entities this customer needs, then build
the model from both". Steps 1, 2 and 4 of that sequence are right and are what
the doc already proposes (understanding the source is a PREREQUISITE to mapping
it; "a mapping table in between" is exactly §2.2; and generating SQL genuinely
needs the source graph AND the canonical target, with the AI reading both).
**Only step 3 breaks, on one word**: a model *determined per customer* is not
canonical, it is a per-tenant model with a better name, and shipped metrics,
benchmarking, ERP-migration survival and reusable connector mappings all die with
it. The legitimate concern underneath it — a services firm has no stock — is
answered by **activation, not determination**: the model is identical for
everyone, and only the parts something maps into are shown. *Which entities does
this customer see* is per-customer; *what is a Customer* is not. (Analogy that
lands: the Belgian standardised chart of accounts — same accounts for everyone,
you just don't use 30–39 without inventory.) Vertical differences are handled by
**modules**, added once centrally, not by per-tenant design.
**§2.1a defines the canonical model concretely** — three versioned artefacts in
the repo, NOT per-tenant data: (a) ~12 entities with meaning/grain/identity +
measures with additivity; (b) a mapping per connector, the same shape as today's
`starSchemaTemplate.ts` retargeted from a per-connector model to a shared one;
(c) a deterministically generated star schema. **§2.1b is how a user meets it —
almost never**: connect and it already works; ONE plain-language coverage
checklist ("Customers ✓ from Exact · Budget — upload a spreadsheet · Stock —
doesn't apply") which is where "which entities do we need" is actually answered,
by hiding rows, not designing; a per-ROW matching inbox when a second source
arrives; **their own vocabulary** over canonical concepts — the one place
per-customer variation genuinely belongs; and one-question extension for custom
fields.
**§2.1c pins three things that are easy to get wrong.** (1) Canonical fields are
NOT all mandatory — a **required core** (Party: stable id, name, ≥1 role) plus an
**optional set** (VAT, email, country, sector), so a thin source maps as "covers 8
of 12 attributes" instead of failing. The coverage screen therefore has THREE
states, and the middle one is the growth loop: filled / **available-but-empty**
("Budget — upload a spreadsheet") / not-applicable. (2) Mapping precedence mirrors
the profiler's docs>curated>AI ladder: a **shipped, hand-authored mapping** for
known connectors with **no AI at run time** (per-tenant AI mapping would diverge
per tenant, which is the exact thing the canonical model removes), AI only for
custom fields / unknown tables / entirely unknown sources, human confirmation
asked ONLY where AI ran. (3) **The customisation rule: customise the mapping and
the vocabulary freely; never the definition.** Vocabulary (labels) and mapping
(which source column feeds it, plus tenant-only extra attributes) are per-tenant
and encouraged; **redefining what a canonical measure MEANS is refused** — a
tenant redefining net revenue kills shipped metrics and benchmarking on the same
day, and does it silently because every dashboard keeps working. Legitimate
routes: add it centrally as its own measure everyone can use, or a tenant-local
metric ALONGSIDE the canonical one, marked as theirs.
**§5.6 IS THE MOST IMPORTANT SECTION — it scales the whole proposal down.** The
owner's objection: a canonical model will be too RIGID (forcing fits), too
EXPENSIVE for us to maintain, and makes customers DEPENDENT on us for their own
modelling. All three are legitimate and the answers change the plan.
(a) Rigidity is real only at the PERIPHERY — an invoice is an invoice, the Belgian
CoA is legislated, so the core fit is genuine; manufacturing BOMs, construction
WIP, staffing placements, subscription MRR are where forcing starts. **Coverage is
therefore the wrong goal**; a small high-confidence core + AI-per-source for the
rest is the right one, and unmapped data still syncs and still answers questions.
(b) **The maintenance burden already exists and this REDUCES it** — the two
`starSchemaTemplate.ts` files are already hand-authored per-connector models,
chosen because the AI designer was worse; today connector #3 costs a whole
template including its own dim design, with a shared target it costs a mapping.
The genuinely NEW cost is governance: versioning the shared model and migrating
tenants without breaking dashboards.
(c) "Dependent on us" is a CHOICE BETWEEN dependencies — on our shipped model
(wait for us at the edges), on AI inference (non-deterministic, wrong silently —
the FK audit), or on the customer's own modelling skill (= a consultant, i.e. the
Power BI failure mode). The mitigation is a genuinely SELF-SERVICE escape hatch:
map an unmapped field yourself, add a tenant-local entity, extend a canonical
entity, use the drawer for an unknown source. **This raises the drawer above what
§5.3 gave it** — it is the guarantee the model can never become a ceiling.
**The counter-proposal — "teach the AI each source's intricacies instead" — is
right AND already built** (`exactonline/docs.ts`, 2,613 documented columns;
`getKnownRelationships`). But source knowledge tells the AI how to read THAT
source; it creates no vocabulary shared across sources or tenants, so there is
nothing for a shipped metric or benchmark to hang on and the same source profiled
twice can differ. Not a rigidity problem — a CONSISTENCY problem. And the two
positions are nearly the same artefact: "Exact `Accounts` where `IsSales` → Party
in Customer role" IS that intricacy, written down once instead of re-inferred per
tenant. **The real question is one axis: re-derived by AI per tenant, or written
down once and shipped?** Answer = the `docs > curated > ai` ladder one level up:
written down for the stable core, AI for the periphery.
**THE SMALLER BET (what to actually commit to): ship CONFORMED DIMENSIONS ONLY
and leave FACTS ENTIRELY ALONE** to the per-connector templates and the AI.
**The starter set is MEASURED, not argued** — diffing the two hand-authored
templates shows SIX concepts both connectors independently have: Party
(`dim_account`↔`dim_partner`), Product (`dim_item`↔`dim_product`), Product group
(`dim_item_group`↔`dim_product_category`), GL account
(`dim_gl_account`↔`dim_account`), Journal (both `dim_journal`), Payment terms
(`dim_payment_condition`↔`dim_payment_term`). Currency and UoM are Odoo-only (not
yet evidence); `dim_date` is already platform infrastructure; Entity is a
deliberate addition for the §2.4 requirement, not convergence. An earlier GUESS of
"Party, Product, Account, Period, Entity" was wrong in BOTH directions — proof of
why this is measured. **It also surfaced a real bug: `dim_account` means PARTY in
the EO template and GL ACCOUNT in the Odoo one** — same name, two concepts, which
collide the moment a query spans both. **Inclusion rule:** ≥2 connectors have it +
stable identity + people filter/group/match on it across systems. **Missing
dimensions are handled by making "not conformed" a VISIBLE, COUNTED state** ("Exact
also has Cost centres — not shared across systems yet"); counting it across tenants
is the demand signal for what to conform next, so the boundary is never guessed
twice. **Reversible** — a dimension that doesn't hold up is demoted back to
per-connector. **Why facts stay out, concretely:** 4 of 6 facts converge by NAME
but not SEMANTICS — Odoo needs `CASE WHEN move_type IN ('out_refund','in_refund')
THEN -price_subtotal` while the EO template's own comment says credit notes are
natively negative "so unlike the Odoo template no sign-flip". Facts are where rigidity hurts (grain,
additivity, vertical variation); dimensions are where sharing pays (join, match,
filter, benchmark). Five artefacts, not a model of a business — small enough to
write, version, and abandon. It is Kimball's own answer to this tension and
deliberately LESS than a canonical model. Both templates have already converged on
most of it. Extending toward §2.1's fuller model is a later, evidence-based call.
**Sequencing (§6):** conformed dims + entity axis → identity → spreadsheets → metric
library → groups/consolidation → reconciliation → connector breadth → accountant
portfolio → benchmarking. **§7 lists what kills this** (universal-model creep,
identity false-merges, human decisions lost to a rebuild, benchmarking before
consent, retrofitting the accountant tier).
Four measured facts from the code, kept because they still bind:
- **Everything is scoped to `connection_id`** end to end (design
  `busMatrixOrchestrator.ts:83`, build `transformationRunner.ts:426`, query
  `ConnectorFactory.ts:165` → `listProductTablesByConnection`, Ask AI
  `routes/query.ts:247`). A cross-connection question cannot be expressed at the
  product layer. **The front door became a topic on 2026-08-06 but the question
  path is still a connection** — the two disagree, and un-scoping the query layer
  is the largest single item in the plan.
- **BUT the cross-connection seam already works.**
  `loadDependencyDimensions` (`transformationRunner.ts:203`) resolves upstream
  dims by `dependent_product_id` alone — it never filters by connection — and
  `publishStubFromUpstream` puts the upstream URI on a stub row owned by the
  DEPENDENT product, so it is visible in that connection's DuckDB session.
  Cross-connection joins are plumbed; what is missing is matching keys, a design
  flow that proposes such a product, and query scope.
- **The `cross_view_relationships` + ATTACH path is SQLite-only legacy**
  (`routes/query.ts:706` reads `cfg.filepath`; `nlToSqlPrompt.ts:384`). It cannot
  work for any API connector. **Do not build on it.**
- **`vat_number` is already conformed across both templates**
  (`exactonline/starSchemaTemplate.ts:94`, `odoo/starSchemaTemplate.ts:97`), so
  deterministic cross-system customer matching starts high-accuracy with zero AI.
- **Spreadsheets: nothing exists** — `xlsxBuilder.ts` writes XLSX, nothing reads
  it. Still open since the 2026-07-15 assessment.
- **Multi-entity: nothing exists** — Exact Online is one division per connection
  by design (`exactonline/schema.ts:9`); Odoo's `dim_company` is a dimension, not
  a consolidation. No FX, no intercompany.
The plan's central argument: all three features need **one** primitive — a
**Mapping** (customer↔customer, GL account→reporting line, entity CoA→group CoA,
counterparty→own entity): a two-column correspondence proposed by machine,
decided by a business user in business language, materialised as a product table.
Build it once or acquire three half-versions. Human decisions must survive a
rebuild — **reuse migration 70's snapshot-and-merge**, this is its third caller.
And **deterministic matching ships before any AI fuzzy matching**, with the
residual measured on real data first — the 2026-08-03 invented-FK incident is the
precedent. Sequencing (§7) puts the **spreadsheet connector first** (built as an
ordinary `SourceConnector` so profiling/docs/quality/lineage work unchanged), on
the argument that cross-system value is gated on connector breadth — Clarion has
two connectors and both are ERPs no SMB runs together — and a spreadsheet is the
cheapest second system. §8 lists what NOT to do (don't extend the ATTACH path,
don't build statutory consolidation or FX, don't relax `sqlGuard` for uploads,
don't give consolidation its own nav item).

**Prior last updated:** 2026-08-06 (TOPIC-FIRST DATA EXPERIENCE — `/topics/[id]` replaces `/products` as the front door)

**THE FRONT DOOR IS NOW A TOPIC, NOT A DATA PRODUCT (2026-08-06).** Implements
the `design_handoff_topic_first_data` handoff. `/products` served the admin who
builds the warehouse, not the SMB owner who uses it; the business user's world
is now **topics** (Finance, Sales) reachable straight from the rail, and
everything technical lives behind one door — *Manage this data* → **Manage
mode**, the same URL with `?manage=1`.
- **New route `/topics/[productId]`** — two layers, one URL. The topic layer
  answers four things in order (what can I ask, what can I find out, is it
  current, can I trust it) and is **forbidden** SQL, row/table counts, and the
  words fact/dimension/star schema/data product. The manage layer (analyst+)
  carries Tables · How it fits together · Where it comes from · Metrics ·
  Quality · Activity, reusing `StarSchemaFlow`, `LineageFlow`, `KpiManager`,
  `QualityTab`, `RefineChat`, `RefreshHistoryChart` unchanged behind
  plain-language labels.
- **`?manage=1` rather than a second route** on purpose: the back button and a
  pasted link both work, and the switch is a cross-fade in place (260ms
  opacity / 320ms transform, `--ease`), so the user keeps their place. The
  manage layer is mounted a frame BEFORE it animates and unmounted a beat
  after — a layer that mounts at its final state cannot animate in.
  `prefers-reduced-motion` swaps instantly. **A viewer who lands on `?manage=1`
  gets the topic page**, not an error — the mode does not exist for them.
- **`GET /products/:id/topic` (new, `routes/products/topic.ts`)** is the topic
  page's ONE fetch. Deliberately not "`GET /:id` and throw 95% away": that
  returns every column of every table with lineage — kilobytes of warehouse
  vocabulary for a screen that must never say those words. Viewer-readable.
  Returns questions, lens labels, counts, freshness, a quality COUNT and
  `pendingChanges`. The heavy `GET /:id` payload is fetched only when Manage
  mode actually opens.
- **Migration 76 adds two nullable columns.** `product_kpis.question_text` —
  the KPI phrased as a first-person question ("Outstanding receivables" → "Who
  owes me money right now?"), STORED not derived, so the sentence a business
  user reads is one a curator chose; editable in Manage mode → Metrics, and it
  also feeds the "Answers …" sub-line in the table list. Falls back to the KPI
  name. `product_tables.plain_summary` — the plain-language paragraph that
  LEADS the "How it's built" card, with SQL demoted to a collapsed appendix.
  `description` already holds the one-line grain, hence a second column rather
  than overloading it.
- **The provenance trail is read off the SQL** (`lib/sqlProvenance.ts`), not
  from `product_relationships`: relationship rows are curated metadata that can
  lag the SQL, and a trail that describes something other than what the table
  actually reads is worse than no trail. Comments and string literals are
  stripped first; CTE names are dropped (an alias, not a relation). When
  `plain_summary` is empty the card falls back to a real sentence derived from
  that trail — **not** a "not documented yet" stub.
- **`pendingChanges` is whitespace-insensitive.** A deploy cell that differs
  from the deployed SQL only by reformatting must not read as "2 changes not
  deployed"; a permanently-wrong badge trains people to ignore it. Pinned by
  test.
- **Nav (`IconRail`)**: workspace is now exactly Home · Ask AI · Dashboards,
  then a **YOUR DATA** group holding one row per `kind='analytics'` product
  (fetched at runtime, curated glyph via `iconForAnalytics`), then Studio.
  `Data products` and `Catalog` are **removed from the rail**; new **Shared
  data** (`/shared-data`) holds the conformed lookups that used to be the
  "Core dimensions" pseudo-product — owned there, read-only pills everywhere
  else, which is what makes the ownership legible.
- **DEVIATION FROM THE HANDOFF, deliberate: `/products` is NOT redirected.**
  The handoff says retire it, but product CREATION (the bus-matrix "Prepare my
  data" flow) exists only on that page — redirecting it would strand the only
  way to make a new topic. It is removed from the nav (which is the substance
  of the ask) and stays reachable via Manage mode → overflow → "Open the build
  workshop". `/products/[id]` is likewise untouched: it is the only surface for
  the per-table notebook cells that "Deploy changes" deploys, so removing it
  while keeping the Deploy button would be incoherent.
- **NOT done from the handoff**, and it is the one gap: the plain-language
  summary is stored and editable but nothing AI-writes it yet, so today it is
  hand-written or the derived provenance sentence. Same for "Draft questions
  with AI" on an empty topic — `question_text` is editable, not generated.
- `POST /query` gained `?q=…&autoSubmit=1` (distinct from the existing
  `seedQuestion`, which only pre-fills): the topic page promises that clicking
  a question ANSWERS it, and landing on a filled-in box breaks that. Fires at
  most once per (question, product).
- **The handoff itself is committed at `docs/handoffs/topic-first-data/`** —
  README (the binding spec, including the "explicitly removed — do not carry
  over" list), both screen PNGs, and the interactive prototype. Read it before
  changing anything on these two screens; the copy and the token values in it
  are final, and several of the removals are load-bearing rather than taste.
- Tests: `src/tests/products-topic.test.ts` — tenant isolation (404 not 403),
  the measure/lookup count split, that no `dim_`/snake_case name can reach the
  break-down sentence, the KPI-name fallback, and the whitespace case above.
  Frontend `tsc --noEmit` clean and `next build` green (`/topics/[productId]`
  203 kB, `/shared-data` 124 kB).

**Prior last updated:** 2026-08-06 (ROW-LEVEL SECURITY IS NOW ACTUALLY ENFORCED IN PRODUCTION)

**THE ROLE FLIP IS DONE — RLS ENFORCES FOR THE FIRST TIME (2026-08-06).** The
backend connects as `databridge_app` (NOBYPASSRLS) instead of the superuser
`databridge`. Until now a superuser bypassed RLS unconditionally — FORCE ROW
LEVEL SECURITY binds the table OWNER, not a superuser — so every
`tenant_isolation` policy in the database was inert and isolation rested
entirely on the application's own tenant filters and the `denyUnlessOwned`
gates. Live revision `…--0000326` at 100% traffic; verified with
`health=200 login=401` on the first attempt, meaning the app read `users`
under RLS and correctly refused bad credentials.
- **Two migrations had to land first, and they are the reason the runbook was
  dangerous.** `20260403000020` created the policy on a hand-written list of 27
  tables; `20260512000056` then enabled + FORCEd RLS on EVERY table with a
  `tenant_id` column — 66 of them. **A table with RLS enabled and no policy
  denies every row.** `users` was one. Performing the runbook as written would
  have failed every login. Migration 74 backfills the policies, 75 the grants
  (plus `ALTER DEFAULT PRIVILEGES`, so a new table cannot reopen the gap).
- **Rollback is one line**: set `.ops/db-role` back to `admin` and push. The
  workflow also rolls back on its own if verification fails.
- **WATCH FOR `42501 insufficient_privilege`.** That is a missing grant on a
  table no code path touched during verification. It is the one residual risk.
  **Do not watch it by remembering to** — edit `.ops/prod-logs` (below), which
  queries for exactly this signature and four others.
- **`ai_model_config` has RLS enabled but NOT FORCEd** — the only table outside
  the FORCE audit. Harmless now that the backend is a non-owner, but it should
  be brought in line.
- **Eight runs, seven of which stopped before touching production.** They found:
  an unusable supplied password, a deleted-GitHub-secret-arrives-as-empty-string
  bug (`??` does not fall back on `''`), a credential-splicing regex that would
  have corrupted the Container App secret whenever the ADMIN password contained
  a URL-special character, and a race with the `deploy.yml` triggered by the
  merge itself. Only the third could have caused an outage, and it never
  reached Azure. **The order — verify the database, then touch production — is
  what made seven failures free.**

**PRODUCTION LOGS ARE NOW READABLE — `.ops/prod-logs` (2026-08-06).** This file
is full of sentences of the form "watch for X in the logs", each followed by
"NOT yet observed: no log access from the sandbox". Those were never
observations, they were intentions, and the platform's most-repeated failure is
the change that shipped, was believed to work, and was inert for weeks. A signal
nobody can read is not a feedback loop. Editing the file (it holds a lookback
window, `24h`/`7d`) runs a read-only Log Analytics query for five signatures:
`grant-missing` (the role flip's residual risk), `rls-write-denied`,
`ownership-refused` (the gate turning away legitimate traffic — flagged as
unverified since 2026-07-28), and `runner-active` / `runner-degraded` (whether
`DUCKDB_RUNNER=child` actually took effect, open since 2026-07-27).
- **It prints log VOLUME first, deliberately.** A clean report over a window in
  which nobody used the product proves nothing, and the whole point is to stop
  mistaking absence of evidence for evidence of health. For the same reason a
  query that could not run is reported as *unknown*, never as clean — the same
  discipline `prod-checks` applies to an unreachable Neo4j.
- **Absence is only reported as a finding for the POSITIVE signal.** Saying "no
  `grant-missing`, therefore fine" would repeat the exact mistake this exists to
  stop; the missing `runner-active` line, on the other hand, IS the finding.
- The report formatting was dry-run against synthetic query output before
  shipping — including a log excerpt beginning with `-`, which `echo` would have
  swallowed as an option flag, and the empty-result path.
- Retention is 30 days (`azurerm_log_analytics_workspace.main`).

**`.ops/prod-checks` RUNS THE PRODUCTION VERIFICATIONS FROM CI (2026-08-06).**
Both checks that gated this work needed production credentials, which live in
GitHub Actions and nowhere else, so leaving them as "the owner runs a script
against production" meant handing over secrets and losing the answer in
someone's terminal. `report` is read-only and safe any time.
- The **role-flip preflight** measured, against production:
  66 tenant tables / 66 RLS enabled / 66 with a policy / 67-of-67 table grants
  / all sequence grants. Re-run it before any future role change.
- The **graph tenant backfill CANNOT run from a GitHub runner** — Neo4j has
  `external_enabled = false`, so `getaddrinfo EAI_AGAIN`. Correct posture; it
  needs a runner inside the Container Apps environment, and `backend/scripts/`
  is not in the production image (only `dist/`). **Step 2 of the graph
  tenant-scoping is therefore still not done, and step 3 (read predicates) must
  not land until it is.** Likely path: move the entry point under `src/` the
  way `syncAllProducts.ts` already is.

**Prior last updated:** 2026-08-04 (improvement plan adopted; Phase 0 done, Phase 1a done — graph writes now stamp tenantId)

**THE PLAN OF RECORD IS `docs/backlog/platform-improvement-plan.md`.** Read it
before starting platform work. It reduces the review's findings to two causes —
correctness resting on discipline where construction was possible, and no
feedback loop from production — and sequences the work by what unblocks what.
It also lists what NOT to do, which is the part most likely to be ignored.

**THE MONTHLY ROLLUP HAD NEVER WORKED (2026-08-04, fixed).** Sprint 1.2 writes
`rollup_monthly_<fact>` next to every qualifying fact table and the dashboard
prompt tells the model to PREFER it. Two halves were broken and they cancelled
out, which is why nobody saw it:
- `productContext.detectRollupTables` scanned `./warehouse/product/<slug>` — the
  **v1 local** layout — and returned early on `az://`. The default is v2 and
  production is Azure, so it always returned empty.
- `ConnectorFactory.createProductConnector` only registered views for
  `product_tables` rows, and rollups are not rows, so the view never existed
  either. **Fixing only the advertisement would have turned a silent no-op into
  "table does not exist" on every time-series widget.**
- The location is now RECORDED at write time (`product_tables.rollup_path`,
  migration 72) instead of re-derived at read time — the same reason
  `delta_path` holds an absolute URI. `publishRollup` is called after every
  fact refresh **including with null**, so a table that stops qualifying does
  not keep advertising a stale rollup.
- The name lives in `rollupViewName()` because it is the contract between four
  surfaces that never see each other: runner, catalog, view registration,
  semantic context. Pinned by test.

**GRAPH WRITES NOW STAMP `tenantId` — STEP 1 OF 3 (2026-08-04).** The route to
tenant-scoping Neo4j is: (1) every write stamps, (2) backfill existing nodes,
(3) add read predicates. **Step 3 must not land before step 2 reports clean** —
an unstamped node does not leak once predicates exist, it silently vanishes
from its owner's catalog, which is its own outage.
- Only `SourceTable`/`SourceColumn` carried it. Now also `ProductTable`,
  `ProductColumn`, `KpiDefinition`, `QualityRule`, `CrossSourceView` and the
  `RELATES_TO` edge, on both ON CREATE and ON MATCH. The tenant comes from the
  mirror row the caller already holds — no new parameters threaded around.
- **`scripts/lint-graph-tenant-stamp.ts`, in the merge gate.** A write path that
  forgets `tenantId` fails no test; it just creates an invisible node. Verified
  to fail: removing one stamp exits 1.
- **`src/scripts/backfillGraphTenant.ts`** does step 2. Report-only unless
  `--apply`, idempotent, attributes from Postgres, and **refuses to guess** an
  owner for entities whose mirror row is gone (a `CrossSourceView` with no
  `connectionId` cannot be attributed). Exits non-zero while anything remains —
  that exit code is the gate on step 3.
- **It lives under `src/`, not `scripts/`, and that is the whole point.** Only
  `src/` is compiled into the production image, and Neo4j has
  `external_enabled = false` — so a script under `scripts/` can be run against a
  laptop and against nothing else. Verified by building to a temp `outDir`:
  `dist/scripts/backfillGraphTenant.js` is emitted, which is the path the job
  invokes. `src/syncAllProducts.ts` is here for the same reason.
- **Run it with `.ops/graph-backfill`** (`report` | `apply` | `noop`), which
  creates a one-shot Container Apps Job from the backend's current image and
  configuration, runs it inside the environment, and pulls its stdout back out
  of Log Analytics. The equivalent step in `.ops/prod-checks` was **removed**:
  it reported "COULD NOT RUN" on every invocation for lack of network reach, and
  a check that can neither pass nor fail is not a check.

**A DASHBOARD THAT WAS NEVER VERIFIED NOW SAYS SO (2026-08-04).**
`validateAndRepairSpec` caught, logged and returned the model's raw output,
indistinguishable from a spec that passed. Still best-effort — a transient
warehouse timeout must not throw away a good dashboard — but the spec now
carries `validation: { ok: false, reason }` and the UI shows an unverified
notice. Cleared whenever the pass does run, so refine-spec cannot leave a stale
warning behind.

**CORRECTION — the "16 error leaks" finding was overstated.** A grep found 16
sites returning `err.message`; checked individually, 15 are narrowly typed
domain errors (`ConfigValidationError`, `OwnerResolveError`, "Unknown connector
type", OAuth-session checks) whose message is deliberately user-facing and
correct as written. One was real — the transformation-preview route's blanket
catch — and now strips storage URIs and paths while keeping the SQL diagnostic,
which is the point of a preview. **There is no systemic error-leak problem.**

**Prior last updated:** 2026-08-04 (platform analysis; SQL-leak to viewers closed, RLS gate wired into CI, dependency audit made blocking)

**RAW SQL WAS STREAMING TO EVERY ROLE, INCLUDING VIEWERS (2026-08-04).** The
admin-only "show query" toggle on `MessageBubble` was cosmetic: while a query
ran, `<ThinkingBubble>` rendered the generated SQL and `<ThinkingPanel>`
rendered the repair loop's diagnostic SQL, its revised SQL and a raw JSON dump
of diagnostic rows — none of them gated. Both violate the non-negotiable
"never show raw SQL to a business user" and the role table's viewer: NO on the
show-query toggle. Flagged in the 2026-07-15 product assessment (§P0 item 4)
and still live three weeks later.
- **Fixed by construction, not by discipline**: both components now take a
  **REQUIRED** `canSeeSql: boolean`. Required rather than
  optional-defaulting-to-false so a future call site cannot inherit a default
  nobody reads — TypeScript makes the decision mandatory. Read the SQL
  VISIBILITY note at the top of `frontend/app/query/thinking.tsx` before
  adding a prop or a call site there.
- **What stays visible to everyone**: phase, streamed reasoning text, row
  COUNTS, clarifying questions. That is the part that makes the wait legible
  and it carries no query text. Hidden: all three SQL blocks + the raw row
  dump.
- Gated on `isAdmin`, matching `MessageBubble` exactly. **Note the
  discrepancy**: CLAUDE.md's role table grants the SQL toggle to admin AND
  analyst, but both surfaces implement admin-only. The implementation is
  STRICTER than the documented policy, so this change does not widen
  anything — but the two should be reconciled deliberately, in one place.

**THE RLS ISOLATION SUITE NOW RUNS IN CI — AND THREE OF ITS FOUR TESTS WERE
DEAD (2026-08-04).** `e2e/rls.spec.ts` existed since the RLS work but no
workflow ever invoked it (only `widgets.spec.ts` ran). Wiring it in first
required repairing it: three tests guarded their assertions behind conditions
that were always false, so they passed green while checking nothing.
- `connections`: read `data.id` where the route returns `data.connectionId`,
  and sent `config.filename` where the SQLite connector reads
  `config.filepath` — so `if (connId)` never fired.
- `query log`: called `/definitions/gaps`, which is not a mounted route (it is
  `/reports/gaps`) — so `if (status === 200)` never fired.
- All conditional guards removed. **Do not reintroduce them**: a skipped
  isolation test reports safety it never checked, which is worse than no test.
- The connections test now creates a real connection against a reachable
  Postgres (the route tests the connection before storing the row) — that is
  the most sensitive tenant-owned row in the schema, it holds AES-encrypted
  source credentials.
- Both dashboards and connections now also assert the **allow** direction (the
  owning tenant still gets 200). A gate that refuses everybody would otherwise
  pass every refusal assertion in the file while breaking the product.
- **New `rls-isolation` job in `test.yml`. THE ROLE MATTERS**: the backend is
  started as `databridge_app` (NOBYPASSRLS), not the `databridge` superuser
  used for migrations. A superuser bypasses RLS unconditionally, so pointing
  the API at it would make every assertion pass without RLS being enforced at
  all. Keep the two DATABASE_URLs distinct.
- `e2e/smoke.spec.ts` was also stale — it waited for `/(setup|dashboards|
  semantic)` while `register/page.tsx` pushes `/sources`, so it could only
  ever time out. Fixed; still not in CI (needs frontend + backend together).

**DEPENDENCY AUDIT IS NOW A GATE (2026-08-04).** Both audit steps in
`test.yml` were `continue-on-error: true` with a comment promising to
re-tighten "once the backlog is triaged". The backlog had grown to **58
advisories in backend (2 critical, 19 high) and 13 in frontend (10 high)**.
- **Runtime-exposed advisories fixed**: `axios` 1.14→1.19 (NO_PROXY bypass →
  SSRF, plus prototype-pollution auth bypass — axios is the transport for
  every connector, so this sits exactly in the threat model `egressAllowList`
  exists for); `nodemailer` 8→9 (CRLF header injection; the usage surface is
  `createTransport`/`Transporter`/`sendMail`, unchanged in v9, and
  `@types/nodemailer` stays at 8.x because v9 ships no types — backend `tsc`
  is clean); `protobufjs` →7.6.5 (CRITICAL, code execution);
  `applicationinsights` →3.15.1 (clears the @grpc/@opentelemetry cluster);
  `form-data`, `lodash`, `fast-xml-builder`, `fast-uri`, `js-yaml`, `postcss`
  via overrides — **each held inside its current major** so no package gets an
  API it wasn't written against.
- Result: backend **58 → 31** (critical 2 → 1), frontend **13 → 7** (critical
  0), connectors 18 → 16. **Every remaining high/critical is build-chain
  (duckdb → node-gyp: tar, cacache, make-fetch-happen, ip-address,
  brace-expansion) or dev-only (vite/postcss/vitest).** Nothing
  runtime-exposed remains.
- **New `scripts/audit-gate.mjs`**, run per workspace in the job that already
  installed it. Fails on any high/critical NOT in its allowlist; every
  allowlist entry carries its reason. Plain `npm audit --audit-level=high`
  cannot be used — the duckdb toolchain has unfixable advisories that would
  keep it permanently red, which is exactly how it came to be ignored. The
  gate also reports STALE allowlist entries (a fix shipped → remove the
  entry). Verified it actually fails: removing one entry produced exit 1.
- **`next` is deliberately allowlisted, not fixed.** The only published fix is
  next@16 — two majors above the pinned 14.2.35, and 14.x has no patch. The
  advisory is a DoS in the Image Optimizer driven by `remotePatterns`; this
  app configures no `remotePatterns` and imports `next/image` **nowhere**, so
  the path is unreachable. That is a claim about TODAY's config — re-check it
  when a new next advisory lands. The upgrade wants its own piece of work.
- Same for `vitest` in packages/connectors (2 majors; backend already runs
  v4) — do it where the DuckDB-native suites can actually be run against it.

**A FRONTEND TYPE ERROR CAN STILL REACH PRODUCTION (2026-08-04, found, NOT
fixed).** `frontend/next.config.mjs` sets `typescript.ignoreBuildErrors: true`
under a comment claiming "type checking is done in CI (test.yml)". That is
false: test.yml type-checks the backend and connectors, not the frontend. The
frontend's `tsc --noEmit` is in `check.yml`, whose own header says it does not
block deploy — and `deploy.yml` triggers straight off `push: [main, staging]`
with no `needs:` on any test workflow. So a frontend type error compiles into
the production image and lands as a 0%-traffic revision ready to promote. The
misleading comment is corrected in place; the flag is left ON deliberately
(turning it off changes what `next build` does in the Docker image and in the
widget-render gate — a deploy-behaviour change wanting its own review). **The
durable fix is to make deploy.yml depend on the type-check**, not to have the
image build re-do it.

**Prior last updated:** 2026-08-03 (FK detection measured against a real production sync and rebuilt — read the FK section before touching relationship detection)

**RELATIONSHIP DETECTION WAS INVENTING FOREIGN KEYS — MEASURED IN PRODUCTION,
THEN FIXED (2026-08-03).** New read-only control `.ops/relationship-audit`
(+ `.github/workflows/relationship-audit.yml`) takes a tenant id and dumps that
tenant's semantic layer: role + BYPASSRLS, per-connection table/column counts,
every relationship with provenance, and a SUMMARY LAST (so a log tail always
catches it) flagging four defect shapes. Only schema metadata is read — no row
values. Run 1 against the live ExactOnline tenant (9) measured **170
relationships**, of which **8** had an endpoint column that did not resolve and
**10** pointed at `GLClassifications.Name`. None of the source columns involved
— `AccountCode`, `LineNumber`, `VATCode`, `SalesVATCode`, `JournalCode` — has a
documented reference in the vendor docs, and the curated catalogue claims none of
them. They were invented by value-overlap verification. Three defects, all in how
a candidate was judged (`SchemaProfiler.ts`, same fix in `BaseConnector.ts`):
- **The ratio was computed from mismatched sets.** `matched` came from a 500-value
  SAMPLE while `total` came from the WHOLE column, so a key with 5,000 distinct
  values of which every one matched scored 0.10 and was rejected — a systematic
  false NEGATIVE on exactly the wide keys worth having. Both sides now come from
  the same `WITH src AS (… LIMIT n)` sample.
- **Overlap was the wrong measure.** A foreign key's values are a near-subset of
  its parent's keys, so the test is CONTAINMENT, and the parent must actually BE
  a key. Target uniqueness (`distinct/rows`) is **measured, not pattern-matched
  on the column name** — some source systems legitimately key on a natural or
  name column, so rejecting `→ *.Name` outright would be wrong for them.
  `GLClassifications.Name` fails on its own merits: it is not unique.
- **Small domains agree by coincidence.** A line counter with 40 distinct values
  that all appear in some code table scores 100% containment at ANY sample size.
  A minimum distinct-value count is required before agreement counts as evidence
  — raising the sample improves the estimate but cannot fix this.
- **Separately**, the persist loop wrote relationships whose endpoint column did
  not resolve, producing catalog rows reading `Table.? → Other.ID` that can never
  express a JOIN. Dropped now, with a warning naming the candidate.
New env (in `.env.example`): `FK_SAMPLE_SIZE` (1000), `FK_MIN_DISTINCT` (8),
`FK_TARGET_UNIQUENESS` (0.99), `FK_MIN_CONTAINMENT` (0.85).
**NOT yet measured**: detection quality is only observable against real data.
After this deploys, re-Analyse the EO connection and re-run
`.ops/relationship-audit`; the baseline to beat is `UNRESOLVED 8 /
TARGET-NOT-KEY 10 / MULTI-TARGET 14` out of 170.
**MULTI-TARGET is deliberately NOT special-cased** — dedup is by the full
`from.col→to.col` key, so one source column can still carry several targets. The
uniqueness + containment guards should collapse most of them; suppressing the
rest by rule would risk dropping legitimate ones. Measure first.

**ONE MALFORMED AI RELATIONSHIP USED TO ABORT THE WHOLE PROFILING RUN
(2026-08-03, found from the production UI, fixed in `main-d752d5a`).** The user's
Analyse showed `Profiling failed — Cannot read properties of undefined (reading
'toLowerCase')`. Pass B's JSON comes back through
`parseJson<TableContextOutput>(raw)` — a **CAST, not a schema** — so every field
on the returned relationships is `string` by assertion only. One element missing
`from_table` reached `rel.from_table.toLowerCase()` in the canonicalisation block
and threw OUT of the profiler uncaught: `profiling_status='error'` and **nothing
persisted at all** — no descriptions, no relationships — for one bad element out
of a couple of hundred. Relationships are now validated before canonicalisation
and dropped with a count; **all four names are required, not just the two
tables**, because a relationship without both columns cannot express a JOIN even
when its endpoints resolve. Table entries with no `table_name` go the same way.
*Inference, not stack-confirmed* (no log access from the sandbox) — but it is the
only `.toLowerCase()` on the profiling path that can receive `undefined`: the
connector-introspected names are always defined and the vendor-docs channel has
its own try/catch that degrades to AI descriptions.
**The endpoint-column guard also had to be applied TWICE.** There are two
relationship persist loops — the AI table-context loop and the programmatic
candidate loop. The FK PR guarded only the second, so the first kept writing
rows with a null `from_column_id`/`to_column_id`. That is where some of the eight
`Table.? → Other.ID` rows in the audit came from. If you touch either loop, check
the other.

**The dynamic-import ratchet had been red on main at 95 vs baseline 92** since
the cache bus shipped, and was fixed in the same PR: `jobs/cacheBus.ts`'s three
lazy imports claimed to avoid "a cycle with the connector layer", but there is
none (widgetCache/filterOptionsCache import nothing internal; DuckDBConnector
never reaches back), and nothing was deferred either — ConnectorFactory,
routes/quality and routes/ingestion already import DuckDBConnector statically on
index.ts's static graph. Now static; ratchet back at exactly 92. Note this job
(`check.yml`) is NOT the backend merge gate — `test.yml` is.

**LIVE IN PRODUCTION (probe run 6, image `main-89c7cdd`, verified from Azure):**
serving revision == template (so genuinely promoted), worker on the same image,
`DUCKDB_RUNNER: child`, `WAREHOUSE_CONTAINER_MODE: per-tenant`, queue split
non-overlapping. Everything from the isolation work is live: the ownership gate,
per-connection cache invalidation, transaction-local worker tenant context, the
child-process query runner, and the graph merge-key fix.
**Still `per-tenant containers: 0`** — the per-tenant WRITE path has never run.

**SOURCECOLUMN MERGE KEY — got it wrong twice, read this before changing it.**
The key must avoid TWO failure modes at once:
- `(tableName, columnName)` — the original — **collides across tenants**. Table
  names are not unique between connections; two tenants on the same connector
  have identical table names for every table, so both tenants' `invoices.id`
  merged onto ONE node and whoever ran Analyse second overwrote the other's
  semantics and `pgId`. That also breaks the ownership gate, whose `pgId` would
  then point at the other tenant's Postgres row.
- `(tablePgId, columnName)` — my first fix — **duplicates across re-profiles**.
  The profiler rebuilds its Postgres rows, so `source_tables.id` changes every
  run; the old node stops matching, a new one is created, and the stale node
  stays attached via `HAS_COLUMN`. Nothing wipes the graph, so duplicate columns
  accumulate in the catalog on every Analyse.
- **The answer is a PATTERN merge**: `MERGE (tbl)-[:HAS_COLUMN]->(col:SourceColumn
  {columnName: $cn})`. The column is "the column of this name hanging off THIS
  table node", and the table node is merged on `(connectionId, tableName)` —
  tenant-scoped AND stable across re-profiles, so the column inherits both.

`tenantId` is now stamped on `SourceTable` and `SourceColumn` writes. The indexes
already existed in `db/neo4j.ts`; nothing had ever written the property. The
tenant predicate in the ~94 `MATCH` clauses is still NOT added — it must not land
before existing nodes carry `tenantId`, or every catalog reads empty. A
re-profile after this build rewrites them.

**Open, and NOT verified by anyone:** the two log lines that prove today's work
behaves under real traffic — `Child-process query runner ACTIVE` (absent = the
runner silently fell back to in-process) and `ownership check refused` (a burst =
the gate is rejecting legitimate traffic). No log access from the sandbox.
Also unverified: which Postgres ROLE production connects as. `FORCE ROW LEVEL
SECURITY` is applied on 27 migrations, so RLS binds even the table owner — but a
role with `BYPASSRLS` still bypasses everything, and
`docs/runbooks/db-role-flip.md` describes the cutover to `databridge_app` as
"the last step of Sprint 1 hardening" with no record of it having run.
Good news, checked: Neo4j has `external_enabled = false` — internal ingress only.

**Prior last updated:** 2026-07-28 (tenant-isolation audit: cross-tenant Neo4j read/write CLOSED; Fase 3 made safe to enable)

**MEASURED 2026-07-29 (preflight run 5) — the per-tenant WRITE path has never
run.** `per-tenant containers: 0`. The mode has been `per-tenant` since 26/07,
but no `tenant-*` container exists, so nothing has been written since the flip;
all data still sits in the legacy shared `warehouse` container. Live revision
`…--main-5d2b327` (that IS the PR #62 code — PR #63 changed only a `.ops` file,
so no new image was built). `DUCKDB_RUNNER` unset. Queue split confirmed
non-overlapping: API holds the identity queues, worker the compute queues.
**This changes Fase 4.** With no customer tenants onboarded, there is no
migration worth writing: the cheapest correct path is a **re-sync**, which lands
data in per-tenant containers by itself, after which the shared container can be
dropped and the per-tenant SAS becomes trivially safe. Migrating blobs would be
work done to preserve data nobody depends on.

**✅ THE FIX IS LIVE AT 100% TRAFFIC (verified 2026-07-28).** PR #60 merged
(`1f860ad`), backend image built, and "Warehouse container mode" run #3
(`30354021361`) promoted it: revision `…--main-1f860ad` reached `Provisioned`,
the traffic table shows it as the sole entry at **weight 100**, and the read-back
reported `Applied mode: per-tenant` with the assertion passing. The revision
reaching `Provisioned` is the boot smoke test — the API came up healthy WITH the
ownership gate before any traffic moved.
**The container-mode control was used as the promote vehicle on purpose**, not
`promote.yml`: `deploy.yml` never waits for the new revision to boot, and
`promote.yml` shifts traffic to `latestReadyRevisionName`, which silently
promotes the PREVIOUS revision if the new one failed — it would have reported
success either way. Only this control waits for the specific new revision and
fails loudly.
**Watch for**: a burst of `ownership check refused` warnings means the gate is
rejecting legitimate traffic (a graph entity whose Postgres mirror row is
missing), not that someone is probing. Rollback = the "Rollback production"
workflow. NOT yet observed: no log access from the sandbox, so nobody has
confirmed the absence of those warnings against real traffic.

**Worker tenant context is transaction-local (2026-07-28, branch only).** Every
job opened with a session-level `SET app.current_tenant` on the shared pool while
BullMQ runs workers at concurrency 2–4, so jobs from different tenants
interleave: job A sets its tenant on connection X, job B on Y, and A's next query
can be handed Y — still carrying B's tenant. RLS then filters to the WRONG tenant
and the job reads/writes someone else's rows. **Fail-open**, and the jobs-worker
split made it sharper by concentrating all multi-tenant batch work in one process.
Seven dependent queries (ingestion's connection lookup, transformation's product
+ table loads, scheduled-transformation's schedule + run tracking) now go through
`tenantQuery()`. All seven ambient `SET`s are gone; the long-running work is
deliberately NOT one big transaction (that would pin a pool connection per job).

**Route-level test coverage for the ownership gate (2026-07-28, CI green).**
`tests/semantic-graph-isolation.test.ts` — the gate had shipped to production in
front of ~30 endpoints with no test touching any of them.
- Asserts BOTH directions. The allow direction matters as much as the refusal:
  **a gate that refuses everything would pass any test that only checked the
  attacker**, while breaking the catalog for every legitimate user.
- The allow direction is asserted at the ownership oracle, not through routes —
  a successful request continues to Neo4j and CI runs `NEO4J_URI=""`. Refusals
  never reach the graph, so those are checked end-to-end over HTTP, including
  that a refused write leaves the Postgres row untouched.
- The cache-scope tests validate the join chains against the REAL schema; the
  mocked ones only assert query shape and cannot catch a non-existent column.
- **The test immediately earned its keep**: it caught that
  `denyUnlessOwnedRelationship`'s legacy graph fallback ran on the REFUSAL path,
  so with Neo4j down every denial became a **500 instead of 404**. An
  unavailable graph is not permission to proceed, and a caller must not be able
  to distinguish "denied" from "graph is down". Now refuses on any error.
- **Two traps for the next session**: `npm run check` uses
  `tsconfig.build.json`, which EXCLUDES `src/**/*.test.ts` — no local type-check
  ever parses a test file (a syntax error in one sailed through and only CI
  caught it). Run `npx vitest run <file>` instead: without Postgres it fails on
  `ECONNREFUSED`, which distinguishes "does not compile" from "cannot reach the
  DB". And `check.yml` is NOT the backend gate — `test.yml` is, and it runs on
  every PR and push to main.

**Semantic cache invalidation is now per-connection (2026-07-28).** All 9
`invalidateSemanticCache()` calls in `routes/semantic.ts` were no-arg, i.e.
`cacheInvalidate('semantic:*')` — a Redis `SCAN` over the whole keyspace plus a
`DEL` of everything found. Any tenant editing any definition therefore dropped
the cached AI context of EVERY tenant. Invisible at a handful of tenants;
at hundreds it means the context cache is permanently cold and every edit costs
an O(keyspace) scan.
- **Not the one-liner it looked like**: only `source_tables`, `kpi_definitions`
  and `data_products` carry `connection_id`. `source_columns` joins via
  `table_id`, **`table_relationships` has no `connection_id` column at all**
  (resolve via `from_table_id`), and the product side is three joins away
  (`product_columns` → `product_tables` → `star_schemas` → `data_products`).
  Hence `db/semanticCacheScope.ts` (`connectionIdForEntity`).
- **Fail-safe by design**: null means "scope unknown" and the caller falls back
  to the global wipe. Under-invalidating would serve stale semantic context for
  the whole TTL — a correctness bug; a needless global wipe is merely slow.
- **`DELETE /relationships/:id` resolves the scope BEFORE deleting the row** —
  afterwards there is nothing left to join through.
- 8 tests (`semanticCacheScope.test.ts`) assert the join chains and, more
  importantly, that a null/0/NaN FK yields null rather than being coerced into a
  wrong connection id. 88 unit tests green; `npm run check` clean.
- **NOT deployed** — this landed after the traffic shift below, so it is on the
  branch only.

**CROSS-TENANT LEAK IN THE SEMANTIC LAYER — FOUND AND CLOSED (2026-07-28).**
A full storage+compute isolation audit found that **Neo4j has no tenant scoping
at all** (`db/semanticGraph.ts`: 94 `MATCH` clauses, 0 tenant references — every
node is matched by a globally-unique, enumerable `pgId`). Postgres RLS protects
the mirror rows, so the hole was invisible from the Postgres side. ~30 endpoints
passed a request-supplied id straight into unscoped Cypher.
- **Confirmed READ leak** (worst): `GET /semantic/columns?tableId=` returned
  another tenant's full column catalog — names, descriptions, sample-derived
  stats — to **any authenticated user, viewer included** (`requireAuth` only).
  Same shape on `GET /semantic/tables|relationships|kpis|domains|paths`,
  `GET /catalog/:catalog/:schema/:table`, and all of `/cross-views`.
  `GET /semantic/product-tree` took **no parameter at all** and returned every
  tenant's products and star schemas.
- **Confirmed WRITE/DELETE**: `PATCH /semantic/tables|columns|relationships/:id`
  and `DELETE /semantic/relationships/:id` mutated the graph before any
  ownership check. The Postgres mirror underneath is RLS-scoped and silently
  updated 0 rows, so the two stores diverged while the damage landed in the
  store that feeds AI context and the catalog UI.
- **Fix**: new `db/tenantOwnership.ts` (`owns()` / `ownedIds()`) + a
  `denyUnlessOwned` gate applied to every id-taking endpoint in
  `routes/semantic.ts`, `routes/catalog.ts`, `routes/cross-views.ts`. It matches
  `tenant_id` EXPLICITLY rather than relying on RLS, so it also survives the
  session-level `SET app.current_tenant` pool race. Refuses with 404, never 403.
  Legacy graph-only relationships stay deletable via a new
  `graph.getRelationshipConnectionId()` → authorise through the owning
  connection, so rejecting old AI drafts still works.
- **Drive-by**: `PATCH /semantic/tables/:id` was making two pointless Neo4j round
  trips per request (`getTablesByConnection(0)` into an unused variable, plus a
  `getColumnsByTablePgId(0)` inside a comma-expression). Removed.
- **Tests**: `db/tenantOwnership.test.ts` (8) asserts the gate refuses by default
  AND that `tenant_id` is in the WHERE clause — a mock that only faked
  found/not-found would still pass if the tenant filter were dropped, which is
  the regression worth catching. 80 unit tests green; `npm run check` clean.
- **The durable rule is in the "Dual-write contract" section below — read it
  before adding any `graph.*` call.** The structural fix (put `tenantId` on the
  nodes and into the Cypher) is still open; the gate is an application-layer
  control in front of an unscoped store.
- **Audit findings NOT yet fixed** (ranked, with evidence): worker tenant context
  is still the racy session-level `SET` while BullMQ workers run at concurrency
  2–4 (`jobs/workers.ts:40,86,137,166`) — the split concentrated multi-tenant
  work in one process, so this got *more* important; every DuckDB session still
  carries the **account-wide** `AZURE_STORAGE_CONNECTION_STRING`
  (`services/warehouse/duckdb.ts:197`), making the `sqlGuard` denylist the only
  barrier on the read path (Fase 4's per-tenant SAS is the real fix); all 9
  **[FIXED 2026-07-28]** the semantic cache invalidation was a
  global wipe; `tenantKey()`
  regex-derives the fairness key from the warehouse path and falls back to the
  whole path, so legacy layouts let one tenant hold several semaphore slots;
  `warehouseContainer(tenantId?)` silently returns the SHARED container when the
  id is omitted (all 5 call sites pass it today — latent, not live).

**Prior last updated:** 2026-07-28 (Fase 3 made SAFE to enable — per-runner memory budget bug fixed; flip control + storage validation probe added)

**FASE 3 WAS NOT SAFE TO TURN ON — FIXED (2026-07-28).** Preparing the
`DUCKDB_RUNNER=child` flip surfaced a bug that would have made enabling it a
REGRESSION, not an improvement: `queryRunnerPool.spawnRunner` forked children
with `env: process.env`, so every child inherited the **undivided**
`DUCKDB_MEMORY_LIMIT`. The child runs the same `setupDuckDBForWarehouse` →
`applyResourceGuardrails`, so each runner set `memory_limit='70%'` — at
`DUCKDB_RUNNER_MAX=4` that is **280% of container memory** and 4×2=8 threads on
a 1 vCPU replica. A few concurrent heavy queries would get the whole API
OOM-killed by the platform: precisely the blast radius Fase 3 exists to remove.
- **Fix**: new exported `runnerEnv()` / `dividedMemoryLimit()` /
  `dividedThreads()` in `queryRunnerPool.ts` — the process-wide budget is
  DIVIDED across the runner slots so the AGGREGATE footprint equals what one
  in-process session was allowed (70% / 4 = 17% each; absolute values divided in
  MB with a 128MB floor; threads never below 1). Percentages stay percentages on
  purpose: no knowledge of replica size needed, and it is cgroup-safe. A
  malformed value passes through untouched rather than being silently replaced
  (`applyResourceGuardrails` rejects it either way; substituting would hide the
  typo). Raising `DUCKDB_RUNNER_MAX` now makes each runner smaller instead of
  raising the replica's total footprint.
- **The divisor is NOT `DUCKDB_RUNNER_MAX`** — that was the second half of the
  same bug. When the keyed runner is busy `runQuery` spawns an extra process,
  and `evictIfNeeded` can only reap IDLE runners, so the real ceiling on live
  processes is `DUCKDB_MAX_CONCURRENT_QUERIES` (DuckDBConnector's global
  semaphore), which **defaults higher than the runner cap: 6 vs 4**. Dividing by
  4 while 6 processes can exist puts the aggregate back over budget (6×17% =
  102%). `BUDGET_DIVISOR = max(MAX_RUNNERS, MAX_CONCURRENT_QUERIES)` → 70%/6 =
  11% each, 66% total. Exposed as `_budgetDivisor()` for tests.
- **Invalidation no longer kills in-flight queries** (`invalidateRunnersByPrefix`):
  it used to SIGKILL busy runners, so the moment a transformation finished, the
  cache-invalidation bus would abort any concurrent dashboard query with an
  infrastructure error — reintroducing, and worsening, the mid-query-close
  failure that review finding **H2** explicitly fixed for the in-process
  `DuckDBPool`. A busy runner is now marked `stale` instead: it serves no further
  queries (its views point at the pre-refresh file set, so reuse would return
  silently stale rows) and is destroyed the moment the in-flight query settles.
  Without this fix, flipping the runner on would have produced intermittent
  dashboard errors right after every data refresh — exactly when users look.
- **Two smaller fixes in the same file**: `childScriptPath()` is now memoised —
  it was doing an `existsSync` **and** a `log.warn` on EVERY query whenever the
  flag was on without a compiled script (log flood + a syscall per query); and a
  one-time `Child-process query runner ACTIVE` info log was added, because
  without a positive signal a silent fall back to in-process is
  indistinguishable from success.
- **Tests**: `services/warehouse/queryRunnerPool.test.ts` grew from 4 to **21**
  (17 new: the division rule, the budget divisor vs the concurrency cap, env
  inheritance, no-parent-mutation). 72 tests green across the warehouse + guard
  suites; `npm run check` clean. The stale-invalidation path is NOT unit-tested —
  it needs real child processes, and DuckDB's native binding still can't build in
  this sandbox (the documented Node-22 limitation).
- **Verified, not assumed**: `tsc --project tsconfig.build.json` really does emit
  `dist/services/warehouse/queryRunnerChild.js` next to `queryRunnerPool.js`,
  i.e. exactly where `childScriptPath()` looks. The `import type` of the child is
  erased, so nothing in the module graph forces its emission — it is the
  `include: ["src/**/*"]` glob that does. Confirmed by building to a temp outDir.
  So the runner will not silently self-disable in the production image.
- **Flip vehicle**: `.ops/duckdb-runner` (`child` | `off`) +
  `.github/workflows/duckdb-runner-mode.yml` — same shape as the container-mode
  control (paths-scoped so ordinary pushes keep deploy.yml's 0%-traffic model;
  waits for the revision to reach `Provisioned`, which doubles as the boot smoke
  test, then shifts 100% traffic and reads the value back). **BACKEND ONLY, on
  purpose**: the runner is wired into `DuckDBConnector.executeQuery`, i.e. the
  READ path (dashboards, Ask-AI, notebooks, quality profiling — all in the API);
  the worker's heavy DuckDB work is `transformationRunner`'s WRITE path, which
  does not go through executeQuery, so runners there would take memory from the
  transformation itself for no benefit. Don't "fix" this by adding the worker
  unless a read path moves there first.
  **Unlike the container-mode control, this one is NOT a promote vehicle**: it
  exits without touching anything when the value is already applied. Re-applying
  would create a revision from the app's current TEMPLATE image and shift 100%
  traffic to it, silently promoting a possibly untested build. That guard is also
  what makes merging the new `.ops/duckdb-runner` file (value `off`) a true
  no-op, even though adding it triggers the workflow.
- **Storage validation is now a measurement, not a vigil**: the read-only
  preflight probe gained **section 5** — it identifies the warehouse storage
  account, lists `tenant-*` containers and reports per container whether
  anything has been WRITTEN into it. An empty container for a tenant that has
  synced is the failure signature to look for; data in it proves the per-tenant
  write path works for that tenant. Uses account keys, which `Contributor` can
  read, so no new permissions are needed. Also reports `DUCKDB_RUNNER`.
- **NOT done (needs the flip to actually run)**: `.ops/duckdb-runner` is still
  `off`. Flipping it is a one-line edit + push; then confirm the `ACTIVE` log
  line and run a real dashboard query. Terraform does not set `DUCKDB_RUNNER` at
  all (matching the `off` default) — if the control is left on `child`, add it to
  `infra/main.tf` or a later apply reverts it.

**Prior last updated:** 2026-07-27 (Fase 2 jobs-worker LIVE in production + Fase 3 child-process query runner shipped opt-in)

**JOBS-WORKER IS LIVE (2026-07-27).** The compute split from Fase 2 is no longer
"awaiting terraform apply" — it runs in production as a second Container App,
provisioned entirely from CI because the sandbox has no `az`/`terraform` binary
and no Azure credentials. Verified from Azure by the preflight probe:
`databridge-prod-jobs-worker` **exists**, `runningStatus: Running`, image
`databridge-backend:main-a17a71a` (same build as the backend), 0.5 vCPU / 1 GiB,
1 replica, no ingress.
- **How it got there without terraform**: the preflight probe
  (`.github/workflows/infra-preflight.yml` + `.ops/infra-preflight`, read-only)
  established three facts that changed the plan: the deploy identity holds only
  **`Contributor`** (so it CANNOT create role assignments), the backend app's
  **secret VALUES are readable** (so a new app can be cloned with identical
  config, no human input), and there is **no Terraform state storage account** in
  the subscription — state lives on someone's laptop, so `terraform apply` from
  CI would try to RECREATE live infrastructure. Hence provisioning with `az`
  (`.github/workflows/provision-jobs-worker.yml` + `.ops/provision-jobs-worker`,
  values `create`|`delete`|`noop`, idempotent). **Terraform does not know this app
  exists** — reconcile later with
  `terraform import azurerm_container_app.jobs_worker <resource-id>`;
  `infra/main.tf` already describes it so the definitions agree.
- **PHASED split, on purpose** (`backend/src/jobs/queueRoles.ts`): because the
  worker cannot be granted its own managed identity, queues that authenticate to
  Azure AD stay in the API — `bus-matrix`, `connection-sync-schedule`,
  `pipeline-schedule` (start sync-worker job executions through ARM),
  `email-report`, `morning-brief` (Communication Services). The worker owns the
  queues that authenticate with the storage connection string and are the actual
  reason for the split: `transformation`, `scheduled-transformation`,
  `warehouse-maintenance`, `security-maintenance`. Selection is by
  `WORKER_QUEUES` (comma-separated; **unset = run everything**, so local dev and
  any un-split deployment are unchanged); `workers.ts` routes every
  `new Worker` through `makeWorker()` which returns undefined for a queue this
  process doesn't own. The provisioning workflow ATTEMPTS the role grants first
  and upgrades itself to the full split if they succeed — they returned 0/2, as
  predicted. To unlock the full split someone with Owner rights runs
  `az role assignment create … "User Access Administrator"` for the deploy SP and
  re-pushes `.ops/provision-jobs-worker`.
- **Exactly one process owns the schedulers**: `RUN_SCHEDULERS=false` on the
  worker. Schedule loaders, crash recovery and the 5-min reaper stay in the API.
  This is not cosmetic — those reapers mark `source_sync_runs` stale on AGE ALONE
  with no owner/heartbeat, so two processes running them would fail each other's
  healthy in-flight work.
- **Fase 3 — child-process query runner** (`services/warehouse/queryRunnerChild.ts`
  + `queryRunnerPool.ts`), **opt-in, default OFF** (`DUCKDB_RUNNER=child`). Gives
  the real per-query kill the 45s wall-clock timeout could not: the parent
  SIGKILLs the child, so a runaway query stops burning CPU instead of merely
  freeing its caller. Warm-pooled on the same key as `DuckDBPool`; self-disables
  when the compiled script is absent; falls back in-process on any spawn error
  (permits are deliberately still held during the fallback so the bounded path
  can't be bypassed). M1 from the earlier review is now closable once this is
  flipped on and validated live.
- **Also shipped**: `jobs/cacheBus.ts` (Redis pub/sub cache invalidation — after
  a split the transformation runner would otherwise clear only the *worker's*
  caches while the API serves stale filter dropdowns and pooled DuckDB views for
  up to 30 min), `jobs/scheduleReconciler.ts` (re-registers repeatables on a Redis
  reconnect; replaces the AOF idea, which persists nothing on a Container App's
  ephemeral filesystem and is unnecessary because Postgres is the source of
  truth), Redis started with `--maxmemory-policy noeviction` (BullMQ's documented
  requirement), `lifecycle.ignore_changes` on the container images and
  `ingress[0].traffic_weight` (a later `terraform apply` must not reset images to
  the mutable `:main-latest` tag nor undo the 0%-traffic test-first model),
  `jobs_worker` max_replicas pinned to **1** (see the reaper note above).
- **Cost**: ~EUR 35/month working figure for the always-on worker. It cannot be
  scaled to zero: BullMQ delayed/repeatable jobs are promoted by a **running**
  worker, so at 0 replicas scheduled work never fires — which is also why KEDA
  queue-depth scaling cannot be the wake-up mechanism (a delayed job is not queue
  depth yet).
- **Operating the platform without a laptop**: three GitOps controls now exist in
  `.ops/` (documented in `.ops/README.md`) — `warehouse-container-mode`,
  `provision-jobs-worker`, `infra-preflight`. Each is a one-word/free-text file
  whose edit on `main` triggers a paths-scoped workflow. This is the only
  automation vehicle available: `workflow_dispatch` returns 403 for the
  integration token, push-triggered runs work.

**Prior last updated:** 2026-07-23 (P0 compute security-isolation + Fase 0 guards IMPLEMENTED — shipping to prod)

**P0 + Fase 0 + A0 isolation hardening SHIPPED (2026-07-23):** Backend
`npm run check` clean; 23 new unit tests green (sqlGuard 15 total, semaphore 8).
Closes the cross-tenant compute-read/write vector found in the security audit,
plus the runaway-query blast-radius risk. Owner authorised implementation +
direct prod deploy.
- **SQL guard extended (`utils/sqlGuard.ts`)** — new `assertNoExternalAccess`
  (rejects path/URI table functions: `read_parquet`/`read_csv`/`read_json`/
  `read_text`/`read_blob`/`delta_scan`/`glob`/`parquet_scan`/`postgres_scan`/
  `mysql_scan`/`sqlite_scan`/… AND storage/fs URI literals `az://`/`s3://`/
  `file://`/`abfss://`/…), `assertNoExternalAccess` scans URI on RAW sql +
  functions on literal-stripped sql; `assertSafeReadQuery` = `assertSelectOnly`
  + `assertNoExternalAccess`; `isSafeReadQuery`. Rationale: legitimate user/AI
  SQL only names the tenant-scoped VIEWS we register, so any query naming these
  functions/literals is an attack or bug. This closes the exact
  `SELECT * FROM read_parquet('az://warehouse/tenant_<OTHER>/...')` case that
  passed the old SELECT-only guard, and `read_text('/proc/self/environ')`.
- **Guard applied to EVERY user/AI read surface**: Ask-AI (`query.ts`
  `shouldBlockQuery` now `isSafeReadQuery`; repair-loop diagnostic/revised SQL
  `assertSafeReadQuery`); **notebooks `/query` + `/execute` (had NO guard at
  all — the worst surface)**; dashboards `batch-execute`, `batch-execute-stream`,
  `execute`, drill-detail, `executeSpecForValidation`, `executeWidgetSql`
  (exports), investigate; `investigateService`. Widget SQL is guarded on the
  TEMPLATE (pre-filter-substitution) so legitimate URL data values don't
  false-positive on the URI check.
- **DEFERRED defense-in-depth (needs live validation, deliberately NOT shipped
  blind)**: DuckDB session lockdown (`SET enable_external_access=false` /
  `allowed_paths` scoped to tenant prefix / `lock_configuration=true`) and the
  per-tenant-scoped SAS secret replacing `AZURE_STORAGE_CONNECTION_STRING` in
  read sessions — both can break az:// reads / spill-to-disk and per CLAUDE.md's
  own lesson must be verified live before shipping. The guard already closes the
  vector; these are additional layers.
- **Fase 0 compute guards**: `utils/semaphore.ts` (`Semaphore` + `KeyedSemaphore`,
  unit-tested); `DuckDBConnector.executeQuery` now acquires a GLOBAL
  (`DUCKDB_MAX_CONCURRENT_QUERIES`=6) + PER-TENANT
  (`DUCKDB_MAX_CONCURRENT_QUERIES_PER_TENANT`=2, keyed on the `tenant_<id>`
  prefix in warehousePath) permit and runs under a wall-clock timeout
  (`DUCKDB_QUERY_TIMEOUT_MS`=45000; permit released on REAL settle, not on
  timeout, so concurrency stays honest — true per-query kill is the later
  child-process runner). `DuckDBPool` gained an LRU cap (`DUCKDB_POOL_MAX`=12,
  `evictOverCap`). `computeLimiter` (90/min/IP) added to `/dashboards`,
  `/notebooks`, `/quality` (previously only the global 200/min). Batch-execute's
  uncapped `Promise.all` is now bounded by the executeQuery semaphore.
- **A0 pre-flip fixes**: `assertValidContainerName` (3–63 chars, lowercase,
  single interior hyphens) in `warehouseContainer()`; `getProductWarehousePath`
  now tenant-aware (`warehouseRoot(tenantId)` derived from the connection row —
  no more shared-root cache key in per-tenant mode).
- **New env vars** (`.env.example`): `DUCKDB_MAX_CONCURRENT_QUERIES`,
  `DUCKDB_MAX_CONCURRENT_QUERIES_PER_TENANT`, `DUCKDB_QUERY_TIMEOUT_MS`,
  `DUCKDB_POOL_MAX`.
- **Behaviour note for notebooks**: notebook SQL is now SELECT-only + no external
  access (was arbitrary SQL incl. DDL). Analyst read workflows unaffected; DDL/
  writes in notebooks are intentionally refused.
- **Files changed**: `backend/src/utils/sqlGuard.ts`, `utils/semaphore.ts` (new),
  `connectors/DuckDBConnector.ts`, `connectors/DuckDBPool.ts`, `routes/query.ts`,
  `routes/notebooks.ts`, `routes/dashboards.ts`, `services/investigateService.ts`,
  `services/warehouse/paths.ts`, `services/productContext.ts`, `index.ts`,
  `tests/sqlGuard.test.ts`, `tests/semaphore.test.ts` (new), `.env.example`,
  `docs/backlog/storage-compute-isolation-plan.md`.
- **Remaining phases** (next increments, see plan §5): Fase 1 per-tenant
  container flip (validate → default), Fase 2 jobs-worker split (ROLE flag +
  Redis pub/sub + AOF + KEDA), Fase 3 child-process runner pool + sizing, Fase 4
  legacy migration + auth untangling + the deferred DuckDB SET-lockdown /
  per-tenant SAS secret.

**Post-review hardening (2026-07-23, same session):** An independent adversarial
review of the compute changes found and we FIXED: (H1) the guard missed DuckDB's
BARE-PATH replacement scan — `SELECT * FROM '/warehouse/tenant_<other>/x.parquet'`
reads a file with no `read_*` function and (local paths) no URI scheme; added
`markLiterals` + `FROM_LITERAL_RE` so a string literal in FROM/JOIN position is
refused (`assertNoExternalAccess`). (H2) `DuckDBPool` eviction (evictOverCap /
evictIdle / invalidateByPrefix) could close a shared instance mid-query, aborting
every concurrent query on it; added an `active` in-flight counter
(`beginQuery`/`endQuery`, wired through `DuckDBConnector.executeQuery`) — busy
entries are skipped by eviction and invalidation defers the close until the last
query settles. (M2) narrowed `URI_SCHEME_RE` to object-storage schemes only
(dropped http/https/file) so legitimate URL/file *data* literals no longer
false-positive. (M3) `resolveWidgetFilters` / `resolveFiltersFromQuery` / the
`/execute` inline substitution now escape single quotes AND re-validate the
FULLY-SUBSTITUTED SQL with `assertNoExternalAccess` — closes injection via a
filter value in numeric/identifier context. (M1, acknowledged/deferred) the
45s query timeout frees the caller but not the permit — a runaway query holds
its permit for its real duration; true per-query kill is the Fase 3
child-process runner. Semaphore itself reviewed clean (no leak/double-release/
deadlock). Backend `npm run check` clean; 47 unit tests green (sqlGuard 21,
semaphore 8, paths 22... i.e. guard + container-name coverage added).

**Fase 1 (per-tenant container flip) prep (2026-07-23, same session):** Container-
lifecycle test coverage added (`services/warehouse/container.test.ts`, mocked
@azure/storage-blob: shared-mode no-op + offboarding refuse, per-tenant
create-once-memoised + delete, graceful degradation without a connection string;
51 unit tests green total). Ops runbook written:
`docs/runbooks/per-tenant-container-flip.md` (validate on the 0%-traffic staging
revision with a throwaway test tenant → flip via terraform/az → incremental legacy
migration → rollback). The terraform default stays `shared` on purpose (flipping it
without applying would let a later unrelated `terraform apply` flip prod
unexpectedly); the flip is a deliberate, reversible ops action — code is ready, the
apply requires terraform/az CLI. Read-path compatibility + container lifecycle were
verified flip-safe in the earlier audits. Deferred defense-in-depth (per-tenant SAS
secret / DuckDB SET-lockdown) is Fase 4, not required for the flip.

**Fase 3 (child-process query runner) — BUILT, opt-in, default OFF (2026-07-27).**
Closes the M1 gap: in-process, `DUCKDB_QUERY_TIMEOUT_MS` only frees the caller —
the query keeps burning CPU and holds its concurrency permit for its real
duration. New `services/warehouse/queryRunnerChild.ts` (child entrypoint: builds
the same views via `setupDuckDBForWarehouse` + `createScanView`, runs one query
at a time, converts BigInt before IPC) and `queryRunnerPool.ts` (parent: warm
runners pooled on the SAME key as `DuckDBPool` so the ~500ms view registration
is paid once; SIGKILL on timeout; unexpected exit = crash containment, one runner
dies instead of the API). Wired invisibly behind `DuckDBConnector.executeQuery`
(48 call sites unchanged) — on timeout the permits are released immediately
because the work has genuinely stopped; on any OTHER runner failure it falls back
to in-process WITH the permits still held. `invalidateWarehouse` also rebuilds
runners so they can't serve pre-refresh views. Enable with `DUCKDB_RUNNER=child`;
it self-disables (logged) when the compiled child script isn't present, e.g. TS
dev mode — tested. New env: `DUCKDB_RUNNER`, `DUCKDB_RUNNER_MAX`,
`DUCKDB_RUNNER_IDLE_MS`, `DUCKDB_RUNNER_INIT_TIMEOUT_MS`. Deliberately one
in-flight query per child: multiplexing would reintroduce the head-of-line
blocking this exists to remove (you can't kill one query without killing its
neighbours). NOT yet validated against a live warehouse — flip the flag on the
0%-traffic staging revision first. 55 unit tests green; `npm run check` clean.
Industry note: this is Dagster's `DefaultRunLauncher` shape (process per run
inside a long-lived server), the recognised middle step before per-run
containers.

**Terraform drift protection added (2026-07-27):** an apply would have (a) reset
every app's image to the mutable `:main-latest` — the same cached-stale-image bug
that had sync-worker running weeks-old code — and (b) reasserted
`traffic_weight { latest_revision = true }` on backend/frontend, silently undoing
deploy.yml's 0%-traffic test-first model and sending the next push straight to
production. Added `lifecycle.ignore_changes` for the image (backend, frontend,
etl, jobs-worker) and for `ingress[0].traffic_weight` (backend, frontend). Also
`docs/runbooks/jobs-worker-apply.md` — apply guide that LEADS with the
state-file check, because the remote backend is commented out and `*.tfstate` is
gitignored, so state lives only on the machine that last applied.

**✅ FASE 2 CODE IS LIVE AT 100% TRAFFIC (verified 2026-07-27).** Workflow run
"Warehouse container mode" #2 (`30287449982`) succeeded: revision
`…--main-2b66d79` reached `Provisioned`, the traffic table shows it as the sole
entry at **weight 100**, and the read-back reported `Applied mode: per-tenant`
with the assertion passing. The revision reaching `Provisioned` is also the
smoke test that could not be run in the sandbox (no Postgres/Redis there): the
API booted healthy WITH the new Redis pub/sub subscriber and the async
cancellation path, and traffic only shifted after that. Now live: cross-process
cancellation, the cache-invalidation bus, the schedule reconciler, the ROLE flag
and the opt-in DuckDB lockdown.
**Still inert on purpose:** `ROLE` is set nowhere, so the backend still runs API
+ workers in one process exactly as before. The actual split needs
`terraform apply` (creates `jobs-worker`, sets `backend_role=api`, applies the
1 vCPU/2Gi sizing) — no workflow runs terraform, and the sandbox has no
terraform/az binaries or Azure credentials.
Note: the promote vehicle was a re-apply of the container-mode control, since
`workflow_dispatch` is 403 for the integration token. The control file now
accepts `#` comment lines so a re-apply documents itself instead of needing a
whitespace-only diff.

**Fase 2 jobs-worker split — CODE + INFRA WRITTEN, awaiting `terraform apply`
(2026-07-26).** A plumbing audit corrected the plan: **SSE job progress already
works cross-process** (`job.log()` → Redis → the stream route polls `getJobLogs`),
so no pub/sub was needed there. What genuinely broke is now fixed:
- **`jobs/cancellation.ts`** — Redis is the authoritative channel (`cancelJob`
  SETs a key, `isJobCancelled` is now async — the orchestrator's `isCancelled`
  hook already allowed `Promise<boolean>`); `watchForCancellation` polls so the
  worker can `abort()` an in-flight AI stream, which no checkpoint can interrupt.
- **`SyncOrchestrator.requestCancellation`** — a SECOND, undocumented registry
  with the same flaw (a pipeline-started sync registers its handle in the worker
  while the cancel route runs in the API → 404 on a live run). Now async and
  proves tenant ownership against `source_sync_runs` when the handle is remote.
- **`jobs/cacheBus.ts` (the silent one)** — widgetCache / filterOptionsCache /
  DuckDBPool are invalidated from ONE block in `transformationRunner`; after the
  split that clears the *worker's* unused caches while the API serves
  pre-refresh rows, stale filter dropdowns and pooled DuckDB sessions whose
  registered VIEWS point at the old file set — no error, up to 5/30/30 min. That
  block now also publishes on a Redis pub/sub channel every process subscribes
  to (`subscribeToInvalidations()` in both roles).
- **`ROLE` flag** in `index.ts`: `api` | `worker` | unset(=both, today's
  behaviour, so local dev is unchanged). Everything behind the guard — workers,
  schedule loaders, crash recovery, the 5-min reaper — is owned by exactly one
  process: those reapers mark rows stale on AGE ALONE with no owner/heartbeat,
  so two containers running them would mis-reap each other's healthy in-flight
  work.
- **Terraform**: `azurerm_container_app.jobs_worker` (same image, `ROLE=worker`,
  no ingress, own sizing + blob/job/ACS role assignments), `backend_role`
  (default `api`; set `all` to roll the split back), parameterised backend
  sizing (now 1 vCPU / 2Gi; `backend_min_replicas` deliberately stays 0 — once
  workers move out nothing needs to be always-on). **`jobs_worker_min_replicas`
  MUST be ≥1**: BullMQ delayed/repeatable jobs are promoted by a *running*
  worker, so at 0 replicas scheduled work never fires — which is also why KEDA
  queue-depth scaling can't be the wake-up mechanism (a delayed job isn't queue
  depth yet). This is the split's one always-on cost (~EUR 65/mo at 1 vCPU/2Gi).
- **`deploy.yml`** gained a jobs-worker step pinning the immutable per-commit tag
  (same lesson as the sync-worker `:main-latest` cache bug); it skips silently
  until the app exists, so merging before the apply is safe.
- **Redis AOF deliberately NOT enabled** — Postgres is the source of truth for
  schedules and `jobs/scheduleReconciler.ts` re-registers repeatables on a Redis
  reconnect (the loaders already ran at boot). AOF on a Container App's ephemeral
  filesystem would persist nothing anyway.
- **Also opt-in, default OFF**: `applySessionLockdown` (`DUCKDB_SESSION_LOCKDOWN=1`)
  blocks DuckDB's LocalFileSystem on Azure sessions. `enable_external_access=false`
  is NOT usable — it would kill the `az://` reads the platform depends on.
- **NOT validated here**: no `terraform` binary in the sandbox, so the new HCL is
  brace-balanced and hand-checked but never `terraform validate`d/`plan`ned. The
  apply is manual, so plan is the gate.

**✅ PER-TENANT CONTAINERS ARE LIVE IN PRODUCTION (verified 2026-07-26).** Workflow
run "Warehouse container mode" #1 (`30205852430`) succeeded: revision `…--0000322`
created and `Provisioned`, traffic table shows it at **weight 100** (previous
revision 0), and the workflow's read-back reported **`Applied mode: per-tenant`**
with the `test "$APPLIED" = "$MODE"` assertion passing — so this is confirmed from
Azure, not inferred. The revision runs the newest backend image (`main-79cd750`, the
last backend build = everything through the review fixes), so the **P0 security guard
+ Fase 0 compute guards went live in the same traffic shift**. NOT yet validated (the
deliberately skipped staging run): the per-tenant WRITE path end-to-end — first real
sync creating `tenant-<id>` and the Delta sidecar writing a product table. Watch the
first sync/transformation per tenant; a `ContainerNotFound` on a transformation is the
signature to look for. Rollback = set `.ops/warehouse-container-mode` to `shared` and
push.

**FLIP EXECUTED VIA NEW GITOPS CONTROL (2026-07-23, owner: "ik wil dat jij alles
doet"):** Since no CLI/credentials exist in the session sandbox and
`workflow_dispatch` is 403 for the integration token, the only automation vehicle
available is a PUSH-triggered workflow (push-triggered runs do work — the session's
deploys all ran). Added `.github/workflows/warehouse-container-mode.yml` +
`.ops/warehouse-container-mode` (+ `.ops/README.md`): a GitOps control where that
one-word file (`per-tenant` | `shared`) drives the backend's
`WAREHOUSE_CONTAINER_MODE`. The workflow sets the env var (`--set-env-vars`, other
vars untouched), waits for THAT revision to reach `Provisioned`, shifts 100% traffic
to it, then re-reads the env var and fails if Azure didn't take it. Deliberate design
choices: (a) `paths:`-scoped to the single file so ordinary code pushes keep
deploy.yml's 0%-traffic test-first model intact; (b) the mode is NOT hardcoded into
deploy.yml because that would silently undo a rollback on the next deploy — with the
control, rollback is the same one-line edit; (c) `environment: production`, matching
deploy.yml's posture. Terraform stays source of truth for a fresh environment — keep
`infra/variables.tf` and the `.ops` file in agreement or a later apply reasserts
Terraform's value. NOTE: the traffic shift also promotes the newest backend image, so
it made the P0/Fase-0 compute fixes live at the same time.

**FLIP DONE IN CONFIG (2026-07-23, owner asked for per-tenant to be live NOW):**
`infra/variables.tf` `warehouse_container_mode` default is now **`per-tenant`**
(was `shared`); `shared` remains the documented rollback path. IMPORTANT
OPERATIONAL FACT: merging this changes NOTHING at runtime — no workflow runs
terraform (`grep terraform .github/workflows` = 0 hits), so the Container App keeps
whatever `WAREHOUSE_CONTAINER_MODE` its last apply set until someone runs
`terraform apply` (infra/) or `az containerapp update --set-env-vars
WAREHOUSE_CONTAINER_MODE=per-tenant` + a traffic shift. Both commands are in
`docs/runbooks/per-tenant-container-flip.md` §Stap 2. This session could not execute
either: no terraform/az binaries in the sandbox and no Azure credentials (they are
GitHub secrets), and `workflow_dispatch` returns 403 "Resource not accessible by
integration" for the integration token, so Promote/rollback workflows can't be
triggered from here either. Flipping without the staging validation run means the
per-tenant WRITE path (esp. the Delta sidecar, which needs the container to
pre-exist — `ensureWarehouseContainer` covers it) goes live unvalidated; reads and
legacy data are safe (absolute URIs), and rollback is one env var.

**Prior last updated:** 2026-07-23 (compute security-isolation audit added to the plan — doc only, awaiting owner sign-off)

**Compute security-isolation finding (2026-07-23, added to the plan §3bis):**
A dedicated security audit of the query-execution paths found compute is NOT
security-isolated between tenants today — more serious than the noisy-neighbor
story and it re-prioritises the plan. DuckDB sessions are un-sandboxed and hold
an ACCOUNT-WIDE Azure secret (`AZURE_STORAGE_CONNECTION_STRING`); no session
sets `enable_external_access=false`/`allowed_paths`/`lock_configuration` (repo
grep = 0 hits). The only SQL guard (`sqlGuard.ts`) blocks non-SELECT keywords
but NOT table functions / path literals, so `SELECT * FROM read_parquet(
'az://warehouse/tenant_<OTHER>/...')` passes. Verdict per surface: notebooks
(`routes/notebooks.ts:132,764` — no guard, arbitrary SQL, read+write any
tenant blob, `read_text('/proc/self/environ')` dumps the conn string) and
dashboards (`routes/dashboards.ts:522-630` — widget SQL raw from request body,
no re-validation) are the worst; Ask-AI is SELECT-only but a steered
`read_parquet('az://...other...')` still reads cross-tenant; transformations
run `CREATE TABLE AS ${sql}` with the account secret. Postgres RLS scopes which
connectionId/productId a user may NAME but does NOT stop the in-SQL path-literal
vector. Market context: Peliqan's compute isolation (shared Trino + shared
Postgres, logical DB per workspace, soft limits) is almost certainly NO stronger
than ours — their edge is SOC 2/ISO 27001 certification, not hard compute
isolation; DuckDB's own docs say its settings are defense-in-depth, "not a
substitute for proper sandboxing" (precedents: ChaosDB, SynLapse — both
cross-tenant leaks via shared compute, both fixed with per-execution isolation).
P0 mitigations now lead the phasing: DuckDB lockdown (external-access off /
allowed_paths scoped to tenant prefix / lock_configuration) + per-tenant-scoped
SAS secret instead of the account string + extend the SQL guard (deny table
functions/path literals, SELECT-only on notebooks+dashboards, re-validate widget
SQL). Plan doc updated with §3bis + P0 row in §5.

**Prior last updated:** 2026-07-23 (storage/compute isolation PLAN added — doc only, awaiting owner sign-off)

**Storage & compute isolation plan (2026-07-23, same session as the analysis):**
New `docs/backlog/storage-compute-isolation-plan.md` (Dutch, proposal status —
NO code changed yet). Grounded in two deep code audits (all DuckDB execution
paths; all WAREHOUSE_CONTAINER_MODE call sites). Load-bearing audit facts:
- EVERYTHING except source syncs runs in the one backend Express process —
  `startWorkers()` is called inside `app.listen`, so all BullMQ workers
  (transformation/bus-matrix/profiling/email/brief) share the API process.
  There is NO per-query timeout or cancel anywhere (no `interrupt()`, no
  Express timeout); dashboard batch-execute is an uncapped `Promise.all`;
  DuckDBPool is unbounded and `memory_limit 70%` is per-instance not global.
- The per-tenant-container flip is safer than assumed: read paths NEVER
  recompute Azure URIs from env (stored `warehouse_path`/`delta_path` read
  verbatim); offboarding (`deleteTenantWarehouseContainer`) is already wired
  into `purgeTenant`. Residual gaps: no staging infra exists (deploy "staging"
  = 0%-traffic revision on prod resources); container creation + DuckDB secret
  + Python sidecar ALL run on the account key (nothing uses managed identity /
  DefaultAzureCredential — disabling shared key today breaks three things);
  `getProductWarehousePath` still returns the shared root in per-tenant mode
  (cache-key only); prefix-scoped SAS (sr=d/sdd) is NOT generatable with the
  pinned @azure/storage-blob — would need @azure/storage-file-datalake.
- Plan: Track A (activate per-tenant containers: pre-flip fixes → validation
  via test tenant on 0%-traffic staging revision → terraform default flip →
  incremental legacy migration; NO prefix-SAS detour) + Track B three-tier
  compute (L1 interactive stays in-process hardened with timeouts/semaphores/
  p-limit/pool-cap then a child-process query-runner pool; L2 all BullMQ work
  to a separate `jobs-worker` ACA app via a ROLE env flag on the backend
  image, KEDA-scaled on Redis queue depth, requires Redis AOF + events/
  cancellation moved to Redis pub/sub FIRST or SSE build logs break; L3 syncs
  unchanged). Phasing 0-4 with efforts, owner decision points (cost ~€60-100/mo
  idle, validation approach, legacy migration, start) in plan §6.

**Prior last updated:** 2026-07-23 (storage competitive analysis — doc only, no code changes)

**Storage & compute competitive analysis (2026-07-23):** New
`docs/storage-competitive-analysis.md` (research doc, Dutch — no product code
changed). Compares Clarion's warehouse architecture against Peliqan
(Postgres+Trino on AWS Frankfurt), Definite (DuckDB+DuckLake on GCP — closest
architectural cousin), MotherDuck, Keboola, Mozart Data, Weld, Y42, 5X, plus
Microsoft's official multitenant-storage guidance. Key conclusions: (1) the
DuckDB+Parquet/Delta-on-vendor-owned-blob choice is right and market-validated;
one storage account suffices for hundreds of SMB tenants (containers unlimited,
5 PiB / 20k req/s per account); (2) production still runs the WEAKEST isolation
model (shared container + path prefix, container-wide worker SAS) while the
better per-tenant-container mode is built but default-off — validate in staging
and flip to default; (3) the bigger multi-tenant risk is COMPUTE, not storage:
all tenants share one in-process DuckDB in a 0.5 vCPU/1 GiB backend — route
heavy queries (transforms/Analyse/exports) through the existing job-worker
machinery; (4) prefix-scoped user-delegation SAS went GA April 2026 and can
harden legacy shared-container data without moving blobs; (5) Azure is not a
disadvantage vs Peliqan's AWS-Frankfurt story — EU residency is the argument,
not the cloud vendor; SOC 2/ISO 27001 is their real sales edge. Prioritised
action list in the doc §5.

**Prior last updated:** 2026-07-22 (EO typed writes hardened: $metadata → vendor-docs → auto-detect ladder, loud fallback)

**EO JSON-types recurrence fixed for good (2026-07-22):** The 2026-07-20
vendor-typed-writes fix ($metadata → explicit `columns`) did NOT hold in
production — a fresh 2026-07-22 sync still produced JSON-typed columns in
the catalog (all-NULL columns under DuckDB auto-detect), meaning the
`$metadata` path silently degraded (fetch failure in prod, or stale worker
image; CI builds for 480b82e all succeeded so the image SHOULD be current).
Root problem: the fallback to auto-detect was a log line nobody sees.
- **New `resolveEntityColumns` ladder** (`ExactOnlineConnector.ts`, exported):
  live `$metadata` → static vendor docs (`EXACT_ONLINE_COLUMN_DOCS.dataType`
  via `edmTypeToDuckDb`) → auto-detect. The docs rung covers ALL catalog
  entities (test-enforced), so typed writes can no longer silently degrade;
  auto-detect can only fire for an entity outside the docs catalog.
- **Loud, user-visible degradation**: `$metadata` fetch failure and any
  auto-detect fallback now push SYNC WARNINGS (surface in the sync-run UI)
  instead of buried `log.warn`s. Empty-entity parquets use the same ladder.
- **Tests**: `resolveEntityColumns.test.ts` (5, no DuckDB): Edm mapping via
  real CSDL parse, docs fallback, full catalog coverage, never-JSON
  invariant. Package `tsc` clean. DuckDB-native suites still CI-only.
- **Rollout note**: existing EO tables written before this fix keep their
  JSON types even after an incremental sync (merge unions old+new schema) —
  a clean re-sync (remove + re-add the connection, or a forced full sync)
  is needed once. If warnings then still report $metadata failure, that is
  the real prod signal to chase (auth/timeout on `/api/v1/{division}/$metadata`).
- **Stale-worker-image root cause closed** (`deploy.yml` + `infra/main.tf`):
  the sync-worker Job referenced the MUTABLE `:main-latest` tag and relied
  on "pulls fresh every execution" — but ACA job executions serve from a
  node image cache, so production syncs kept running pre-2026-07-20 worker
  code even though every CI build succeeded (the most likely reason the
  original typed-writes fix never took effect). deploy.yml now runs
  `az containerapp job update --image <sha-tag>` whenever the worker is
  built (job name derived: `${BACKEND_APP_NAME%-backend}-sync-worker`), so
  the job spec always points at an immutable per-commit tag; Terraform's
  job resource got `lifecycle.ignore_changes` on the image so a later
  apply can't silently reset it to the stale tag. Terraform edit NOT
  validated locally (no terraform binary in the sandbox) — syntax is a
  plain lifecycle block; watch the first apply.

**Odoo curated core-field docs (2026-07-20, fourth session of the day):**
Odoo's docs channel is runtime `fields_get`, but many standard fields ship
without a `help` tooltip and fell through to the AI pipeline. New
`packages/connectors/src/odoo/docs.ts` (`ODOO_COLUMN_DOCS`): hand-curated
descriptions for ~242 core fields across ALL 21 allowlisted models (Odoo
16+ semantics). Precedence in `buildEntityDocs`: live instance help
(tenant customisation/language) > curated fallback > many2one synthesis >
AI. Tests: data invariants (models ⊆ allowlist, safe names, non-empty,
every model covered, ≥240 fields), precedence tests (live help beats
curated; custom fields still fall to AI). Connectors: 119 tests pass,
`tsc` clean, dist rebuilt; backend untouched.

**Prior last updated:** 2026-07-20 (semantic enrichment plan Phases 1-3: sibling context, human-edit tracking, opt-in AI enrichment)

**Semantic enrichment Phases 1-3 (2026-07-20, third session of the day):**
Implements `docs/backlog/semantic-enrichment-plan.md` in full. Backend
`npm run check` clean; both lint ratchets green (dynamic-import 92,
validate-coverage 166); prompt unit tests 3/3; RLS round-trip smoke passed
(hand-edit + confirmed relationship + approved enrichment survive re-profile,
pending enrichment wiped back to vendor text, vendor_description persisted).
- **Phase 1 — vendor sibling context**: `VendorDocsContext` threaded from
  `SchemaProfiler` (built from the describeEntities harvest) into Pass B
  (vendor TABLE definitions section) and Pass C (VENDOR-DOCUMENTED SIBLING
  COLUMNS section — custom fields described in the vendor's vocabulary).
  Caps: 40 siblings/table, descriptions truncated at 120 chars. New pure
  test `ai/prompts/schemaContextPrompt.test.ts`.
- **Phase 2 — human-edit tracking (migration 70)**: `edited_by_user` on
  source_tables/source_columns (set by PATCH /semantic/{tables,columns}/:id
  ONLY when a semantic field actually CHANGED — bare confirm ≠ authorship);
  `confirmed_by_user` on table_relationships (any PATCH). Profiler persist
  snapshots flagged rows + confirmed rels BEFORE the wipe and merges them
  into the persist maps (so PG **and** the Neo4j mirror get human values);
  confirmed rels the pipeline didn't re-derive are re-INSERTED. Missing
  source columns → snapshot dropped with log line.
- **Phase 3 — opt-in enrichment (migration 71)**: `vendor_description`
  (immutable curated base) on source_tables/source_columns, written by the
  profiler. New `POST /connections/:id/enrich-descriptions` (admin,
  `?dryRun=1` for scope preview; selection = vendor-documented AND
  (measure OR FK endpoint) AND NOT edited/enriched; caps 300/run,
  40/table) → `AIService.enrichColumnDescriptions` (Sonnet, one call per
  table; server GUARANTEES the vendor sentence leads — prepends it if the
  model drifted; no-op enrichments skipped). Persist:
  `semantic_source='ai_enriched'`, `ai_draft=true`,
  `approval_status='pending'` → existing review queue. Flagging an
  ai_enriched row in PATCH /semantic/columns/:id RESTORES the vendor text
  (new targeted `graph.updateColumnDescriptionOnly` — `updateColumn`'s
  full-SET shape would null other fields). Approved enrichments ride the
  Phase 2 snapshot (survive re-profile); pending ones don't. Frontend:
  "Enrich descriptions" button on the sources card (visible when analysed;
  dry-run count + confirm dialog before spending tokens).
- **Go-live note**: enrichment needs `vendor_description` populated — run
  Analyse once after this deploys before the button has candidates.

**Prior last updated:** 2026-07-20 (EO semantic-correctness sweep: RLS docs-channel bug, vendor-typed writes, docs-derived relationships)

**EO semantic-correctness sweep (2026-07-20, second session of the day):**
User compared Clarion's catalog against ExactOnline's REST reference and found
AI descriptions where vendor docs exist, `json` data types for `Edm.String`
columns, and missing GUID-documented relationships. All three root-caused and
fixed. Connectors: 116 tests pass, `tsc` clean, dist rebuilt; backend
`npm run check` clean; dynamic-import ratchet at 92.
- **Docs channel was DEAD IN PRODUCTION (RLS pool bug).** `SchemaProfiler`
  re-fetched the connections row on the raw `semanticDb` pool; under the
  prod `databridge_app` role a pooled connection without `app.current_tenant`
  returns ZERO rows → `connRow` undefined → connector_type null → the
  describeEntities docs harvest AND getKnownRelationships silently skipped →
  pure-AI descriptions for fully-documented EO columns (confirmed in prod
  Log Analytics: the 2026-07-20 08:56 Re-analyse of connection 17 emitted no
  describeEntities/known-relationship lines). Dev never reproduced it (owner
  role bypasses RLS). Fix: `ProfilerOptions.connection` — every caller
  (routes/connections /profile ×2, SyncOrchestrator ×2, workers, index.ts
  legacy route) now passes the row it already fetched under correct tenant
  context; the profiler's fallback fetch warns LOUDLY when it misses; the
  persist transaction pins `setTenantContext(trx, tenantId)` (kills the
  stale-pool-var cross-tenant hazard); credential-rotation persist is
  tenant-scoped. Verified with a throwaway-clone profile run against local
  Postgres AS `databridge_app` with no ambient tenant var: 455/455 curated
  columns land verbatim (`curated`/`approved`), 25 confirmed relationships.
- **Vendor-typed warehouse writes (EO).** EO synced via
  `read_json(auto_detect)` — all-NULL columns became JSON (user-visible:
  `CreatorFullName` "json" vs `Edm.String`), types could drift per sync. The
  connector already fetched OData `$metadata` every sync but only used it for
  empty tables. Now every entity write passes `columns` (Edm →
  `edmTypeToDuckDb`) — same explicit-schema path Odoo uses; metadata-fetch
  failure degrades to auto_detect. PLUS: both writers' merge paths
  (`ParquetWriter` + `BlobSasWarehouseWriter`) now CAST the EXISTING parquet
  side to the declared schema when `columns` is supplied, so legacy mistyped
  columns CONVERGE on the next incremental sync (no manual parquet surgery;
  CAST not TRY_CAST — unconvertible legacy values fail that entity loudly).
  Tested: all-NULL Edm.String lands VARCHAR; JSON→VARCHAR convergence merge.
- **Docs-derived relationships (245 vs 82 hand-curated).** EO's docs pages
  hyperlink every FK property to its target entity's page; the original
  transcription discarded the links. New PERMANENT tool
  `packages/connectors/scripts/generate-eo-docs.ts` (replaces the lost
  scratchpad script): fetches the resources index (355 endpoint mappings,
  prefers non-`Read*` entity pages; `SupplierItems`→`LogisticsSupplierItem`
  and `TimeCostTransactions`→`SyncProjectTimeCostTransactions` overrides) +
  61 details pages, and regenerates `docs.ts` with — per column —
  verbatim description, role hint, NEW `dataType` (Edm type) and NEW
  `references: {table, column}` (hyperlink target resolved to catalog
  entities; `toColumn` from the target's `data-key="True"` property — catches
  `SalesInvoices.InvoiceID` as the header PK). Regenerated docs.ts: 61
  entities, 2,613 documented columns (EXACTLY the original count — parse
  fidelity), 245 FK references. `ColumnDoc` gained `dataType?`/`references?`;
  `describeEntities` emits them as declared-rung relationships filtered to
  selected entities (profiler merges + dedupes vs the known catalog, which
  stays authoritative for special cases). New tests: reference targets ∈
  catalog + documented key columns, core-join spot checks, relationship
  emission + selection filtering.
- **Go-live runbook (after promote):** on the prod EO connection click
  Re-analyse → descriptions become verbatim vendor docs + relationships jump
  to docs coverage. Data types converge on the NEXT sync (typed writes +
  merge casts); no cursor reset needed unless a CAST failure surfaces
  (then clear `entity_sync_cursors` for the connection + delete its
  warehouse blobs to force a clean full pull).
- **Open (user-requested, not yet built):** AI ENRICHMENT of vendor
  descriptions (vendor text as base + AI extends with data context, marked
  ai_draft; do selectively — measures/FK/template columns) and passing
  documented sibling descriptions as context when AI describes custom
  fields.

**Prior last updated:** 2026-07-20 (first-sync structural catalog registration — tables visible in catalog before AI analysis)

**First-sync structural catalog registration (2026-07-20):** Fixes the
onboarding gap where "Sync complete" left the Catalog empty (source_tables is
populated only by the schema profiler, and post-sync auto-profiling is
default-off for cost reasons). Now a first sync into an empty catalog
automatically runs a FREE **structural** profiler pass — introspection +
connector docs channel (describeEntities / getKnownRelationships) only, ZERO
AI calls — so tables/columns/declared relationships appear in the catalog
immediately; the AI passes stay behind the explicit "Analyse" click. Backend
`npm run check` clean; smoke-tested end-to-end against the local dev stack
(SQLite sample DB → 5 tables / 43 cols / 5 rels registered, no ai_draft/
quality phases emitted, review queue untouched, Neo4j mirrored).
- **`SchemaProfiler.ts`**: new `ProfilerOptions { mode: 'full' | 'structural' }`
  4th param on `runSchemaProfiler`. Structural mode skips AI FK matching,
  quality profiling, and AI Passes A/B/C + verification; persists tables/
  columns with vendor docs where available (trusted rung unchanged:
  approved + declared/curated) and bare structure otherwise —
  `ai_draft=false, approval_status='draft', semantic_source=NULL` so bare
  rows stay OUT of the review queue (nothing to review yet). Persist maps
  now carry `approvalStatus` explicitly (was derived from aiDraft).
- **`SyncOrchestrator.runProfilerInBackground`**: when `!AUTO_REPROFILE_ON_SYNC`
  and the connection has ZERO source_tables (first sync), runs the structural
  pass, sets new terminal `profiling_status='structural'`, persists
  `schema_hash` (so routine re-syncs short-circuit at the steady-state gate
  instead of re-registering/re-notifying), and notifies "tables are in the
  catalog — click Analyse". Failure falls back to the old notify-only path.
  `profiling_status` values are now: null | running | **structural** | done |
  error (comment updated in both `shared/contract.ts` copies).
- **Frontend truth-telling**: `/sources` card badge for synced-but-unanalysed
  sources is now **"Synced"** (was a misleading "Ready"); hint reads "Tables
  are loaded and visible in the catalog. Click Analyse…"; the card's action
  button is **"Analyse"** (ocean-emphasised) until the first AI pass, then
  "Re-analyse". IconRail Sources badge counts 'structural' as pending action.
  `SourceRootPanel` (catalog) shows a warn strip when status='structural':
  "Tables are loaded, but this source hasn't been analysed yet" + link to
  /sources for curators.
- **Not changed**: manual Analyse (`POST /connections/:id/profile`) is the
  unchanged full pipeline; AUTO_REPROFILE_ON_SYNC=true legacy path unchanged;
  schema-drift notifications for already-registered sources unchanged.
- **Known cosmetic follow-up**: sources-sidebar caption shows raw `conn.type`
  ("DUCKDB") with a "?" avatar for connector-framework sources instead of the
  connector branding.

**Prior last updated:** 2026-07-19 (deploy flow streamlined: fixed staging URL, traffic-pinning fix, rollback workflow)

**Deploy flow streamlined (2026-07-19):** CI/CD-only change (no app code).
Cuts a typical deploy from ~13 min to ~6 min and makes the test-first model
actually hold. See `docs/DEV_FLOW.md` (rewritten Loop 2) for the user flow.
- **Neo4j-constraints job gated** (`deploy.yml`): it consistently burned ~7
  min per deploy (slow connect to the Neo4j Container App) and the backend
  ensures constraints at startup anyway. New `neo4j` paths-filter — the job
  now only runs when `backend/src/db/neo4j.ts` itself changed.
- **Traffic-pinning bug fixed** (`deploy.yml` + `promote.yml`): promote used
  `--revision-weight latest=100`; a traffic entry pinned to "latest"
  auto-follows every future revision, so after the first promote every
  subsequent push went STRAIGHT LIVE — the 0%-traffic staging model was
  silently broken (this is why "we can only test in production"). Both deploy
  steps now pin traffic to the currently-live revision BY NAME before
  creating the new revision, and promote resolves `latestReadyRevisionName`
  and promotes by name. Never set `latest=100` (CI or portal).
- **Fixed, bookmarkable test URL** (`deploy.yml`): each deploy moves the
  Azure Container Apps revision label `staging` to the new revision, so
  `https://<app>---staging.<env-domain>` (backend + frontend) is a stable URL
  that always serves the newest pushed version. Printed in the job summary.
- **New `rollback.yml` workflow**: "Rollback production" (workflow_dispatch,
  backend/frontend/both) shifts 100% traffic to the newest active revision
  older than the one currently serving — one-click undo after a bad promote.
- **Known limitation** (documented in DEV_FLOW.md): the test frontend calls
  the LIVE backend (`NEXT_PUBLIC_API_URL` baked at build). Full-stack staging
  isolation would need either a second frontend build against the backend
  staging-label URL or a runtime API proxy — deliberately not done (footgun:
  a promoted frontend must never point at the moving staging label).
- **Not yet verified live**: the first push to main after this merge should
  be watched once — confirm the new revision lands at 0% traffic, the
  staging-label URLs resolve, and Promote/Rollback behave as described.
- **Drive-by fix — validate-coverage ratchet red on main since 2026-07-14**:
  `POST /dashboards/fix-widget` (Tier-1b self-heal endpoint) shipped without
  Zod validation, pushing unvalidated mutating routes to 167 vs baseline 166.
  Added `fixWidgetSchema` (`middleware/schemas.ts`) + `validate()` on the
  route; lint back at 166, `tsc` clean (only the pre-existing knexfile
  rootDir warning).
**Prior last updated:** 2026-07-15 (product assessment — user/feature/business audit vs the "Odoo of SMB analytics" strategy)

**Product assessment (2026-07-15):** New `Clarion-Product-Assessment.docx` at the
repo root (source: `.archdoc/build-product-assessment.js`, regenerate with
`node .archdoc/build-product-assessment.js` then Word COM for TOC/PDF). Audits
the platform against the strategy doc `Clarion-Platform-Strategy.md` (user's
Downloads; the Odoo-playbook positioning). Evidence: full PROD walkthrough
(live EO tenant) + 4 parallel code investigations at 4c51a14. Doc only — no
product code changed this session. **Verdict: the engine matches the strategy;
the first fifteen minutes don't.** Four launch-killers found, all
surface/wiring-level (P0 in the doc §6):
1. **"Prepare my data" re-run duplicates every product** — `busMatrixBuilder.ts:203-254`
   inserts unconditionally, no retire/replace of the prior generation. Prod
   tenant has 9 products (Sales ×2, Purchases ×2, Reference ×2, 0 healthy);
   duplication pollutes Catalog, dashboard picker, Trust list AND the AI schema
   context (two column-casing conventions coexist).
2. **Dashboard generation shipped 6/6 broken chart widgets in prod** ("Sales
   overview" test); `validateAndRepairSpec` is fail-open (`dashboards.ts:236-245`
   ships unvalidated specs); fix-widget self-heal failed silently; $/€ mismatch
   between AI insights and KPI cards; ~100s generation vs <30s claim.
3. **Onboarding wizard is dead code** — register routes to /sources
   (`register/page.tsx:32`); `/onboarding` is presentation-only, advertises
   Snowflake/BigQuery/Redshift/CSV (none exist), omits EO/Odoo. Real funnel =
   ~6 technical decisions (OAuth app creds, entity multi-select w/ no defaults,
   manual Sync now, "Prepare my data" concept).
4. **Live thinking stream ungated** — ThinkingBubble/ThinkingPanel stream raw
   SQL + "star schema" phase strings + confidence to ALL roles incl. viewers
   (`query/page.tsx:1064-71`, `thinking.tsx:96-105`, backend phase strings
   `query.ts:1163,1236`). Makes the admin-only Show-SQL gating cosmetic.
Other key findings: trust signals (confidence/tables-used/provenance) are
admin-only on SUCCESSFUL answers (`MessageBubble.tsx:1094-99`) — business users
only see them on refusals; no export-everything / glossary export; GDPR
purge/erasure routes exist but have NO UI; formatting bugs (year "2.025", raw
ISO timestamps, alias-cased headers); missing business features ranked: metric
alerts (promised in `pulseService.ts:6`, unbuilt), Excel/CSV upload connector,
targets/budget-vs-actual UI, NL/FR i18n (UI is English-only), external sharing,
weekly digest. Drift watchlist (§5): freeze notebooks (rfc-002 targets
analysts), demote /pipelines DAG canvas, bury star-schema designer surface,
DELETE orphaned cross-views (IntegrationsPanel imported nowhere), retire /gaps.
Strong list worth protecting (§3): repair loop verified end-to-end in prod
("Corrected after investigation" on a live wrong answer), Workspace/Studio IA,
Pulse→Morning Brief proactive layer, docs-before-inference profiling +
star-schema templates, glossary as semantic moat, ~$0.75-2/mo AI cost per
tenant, security/GDPR hygiene. During the audit a temp admin user was created
and DELETED in the LOCAL dev DB (tenant 63); prod was walked through read-only
(one Ask-AI question + one discarded dashboard generation).

**Prior last updated:** 2026-07-14 (source-onboarding playbook §8 COMPLETE: items 1-5 shipped)

**EO star-schema template + §8 item 5 conformance checks (2026-07-14):**
Closes the playbook's §8 platform-gap list. Connectors package: 111 tests
pass, `tsc` clean, dist rebuilt; backend `npm run check` clean (no backend
code changes — the template path from item 4 is generic, EO just plugs in).
- **ExactOnline template v1** (`exactonline/starSchemaTemplate.ts`): 6
  conformed dims (account, item, item_group, gl_account, journal
  [code-keyed], payment_condition [code-keyed]), 6 facts
  (fact_sales_invoice_lines [joins SalesInvoiceLines+SalesInvoices],
  fact_transaction_lines, fact_sales_order_lines, fact_purchase_order_lines,
  fact_receivables, fact_payables), 4 products (Core dimensions → Finance →
  Sales → Purchasing), 25 relationships, 4 KPIs. Authored strictly from the
  docs.ts transcription — the test suite PROVES every column lineage points
  at a vendor-documented field. EO conventions: credit notes natively
  negative (no sign-flip), *DC = division currency (additive), dates
  TRY_CAST from ISO strings, GUID FKs raw VARCHAR + technical. No
  dim_gl_classification (GLAccounts has no GLClassification field per the
  vendor docs). Tested in `exactonline/starSchemaTemplate.test.ts` — same
  DuckDB-execution rigor as Odoo's (synthetic tables, DESCRIBE column
  equality, full materialisation, KPI runs, invoice+credit-note netting).
- **Conformance (item 5)**: `validateEntityCatalog` now REQUIRES a
  description on every entity; new `validateKnownRelationships` (endpoints ∈
  catalog, safe columns, valid cardinality, no dupes); `conformance.test.ts`
  runs both plus `validateStarSchemaTemplate` generically for every
  registered connector that ships a template.
- **Remaining follow-ups** (tracked, not §8): template-version UPGRADE flow
  (`data_products.template_version` makes staleness visible); human-edit
  tracking so re-profiles don't overwrite user edits; live-instance
  validation of both templates against real Odoo/EO connections.

**Deterministic star-schema templates (2026-07-14, §8 item 4):** The
"Prepare my data" bus-matrix workflow now instantiates a connector-shipped
template instead of the AI designer whenever one covers the synced entities —
the AI is officially the fallback. Connectors package: 99 tests pass, `tsc`
clean; backend `npm run check` clean, migrations applied, full backend suite
green.
- **Contract** (`packages/connectors/src/starSchema.ts`):
  `SourceConnector.getStarSchemaTemplate(): StarSchemaTemplate | null` —
  versioned template of conformed dims + facts (each with `sourceEntities`,
  SQL over BARE source-table names, full column metadata incl. roles /
  FK targets / isTechnical), product groupings (buildOrder), relationships,
  KPIs (with `requiresTables`). `instantiateStarSchemaTemplate` = graceful
  degradation (all-entities-or-drop per table; repairs relationships,
  dimensionsUsed, product groupings, orphaned-dim ownership, renumbers
  buildOrder; drops KPIs whose tables dropped; returns null when no fact
  survives → caller uses AI). `validateStarSchemaTemplate` = structural
  conformance, run in each connector's test suite.
- **Odoo template v1** (`odoo/starSchemaTemplate.ts`): 9 conformed dims
  (partner, product, product_category, account, journal, company, currency,
  payment_term, uom), 6 facts (fact_invoice_lines with credit-note
  sign-flip + display_type filter, fact_journal_items, fact_sales_order_lines,
  fact_purchase_order_lines, fact_payments, fact_stock_moves), 5 products
  (Core dimensions → Finance → Sales → Purchasing → Inventory), 33
  relationships, 5 KPIs. Facts carry natural FK ids and never JOIN dims.
  Targets modern Odoo (16+ fields). Tested in
  `odoo/starSchemaTemplate.test.ts`: structural validation vs catalog,
  degradation scenarios, and REAL DuckDB execution — synthetic Odoo source
  tables, every dim/fact SQL executed with output columns asserted equal to
  declared metadata, full template materialised, every KPI formula run.
- **Backend integration**: `services/starSchemaTemplates.ts`
  (`tryBuildBusMatrixFromTemplate`) maps the instantiated template onto
  `BusMatrixOutput`; `busMatrixOrchestrator` tries it after loading
  source_tables and skips AI Phases B/C-recovery on a hit (validation +
  `buildBusMatrix` + transformations unchanged). Migration
  `20260714000069_add_template_version.ts`: nullable
  `data_products.template_version` (NULL = AI-designed);
  `BuildBusMatrixOptions.templateVersion` threads it through. Env
  `STAR_SCHEMA_TEMPLATES_DISABLED=1` forces the AI path (documented in
  `.env.example`).
- **Not yet**: EO star-schema template (authoring job — profiler+platform
  side is generic); template-version UPGRADE flow (customers stay on their
  materialised version; `template_version` column makes it visible); no
  frontend changes (wizard flow is identical, just faster).

**ExactOnline column-docs curation (2026-07-14, §8 item 3):** All 61 EO
catalog entities transcribed from the vendor's REST reference into
`packages/connectors/src/exactonline/docs.ts` (GENERATED file — 2,613
documented columns). Transcription was DETERMINISTIC: a Node HTML-table
parser over the docs details pages (each property row's checkbox input
carries name/data-type/data-isnavigation; last `<td>` = description;
navigation properties skipped) — no model in the loop, verbatim by
construction. Role hints from Edm types (Double/Decimal → measure;
Guid/String/Boolean/DateTime → dimension; ints → none).
`ExactOnlineConnector.describeEntities` serves the map statically
(`provenance: 'curated'`, no network; relationships NOT duplicated —
`getKnownRelationships` already covers them; unknown entity names skipped).
Docs-page-name quirk: `TimeCostTransactions` has no standalone REST docs
page — transcribed from `SyncProjectTimeCostTransactions` (same model,
`Timestamp` excluded). New `exactonline/docs.test.ts` (6 tests) gates the
data: keys ⊆ catalog, safe names, non-empty descriptions, ≥40 entities /
≥1000 columns, AmountDC-is-measure spot check. Package: 81 tests pass,
`tsc` clean, dist rebuilt; backend `npm run check` clean (no backend
changes needed — the profiler side shipped with §8 item 1). Next: §8
item 4 — `getStarSchemaTemplate`.

**Trusted-tier docs channel + Odoo `fields_get` harvest (2026-07-14):** Items
1+2 of the playbook's §8 platform gaps — "documentation before inference" is
now live end-to-end for Odoo. Connectors package: 75 tests pass (12 new);
`tsc` clean. Backend: `npm run check` clean; migration applied locally.
- **Connector contract** (`packages/connectors/src/types.ts`): new optional
  `SourceConnector.describeEntities?(config, selectedEntities, ctx)` returning
  `EntityDocs[]` — per-entity `description`/`displayName`, per-column
  `ColumnDoc { name, displayName, description, role: 'measure'|'dimension' }`,
  docs-derived `relationships`, and `provenance: 'declared' | 'curated'`.
  Exported from the package index (with `KnownRelationship`).
- **Odoo harvest**: transports now request
  `['type','store','string','help','relation']` from `fields_get` (shared
  `FIELDS_GET_ATTRIBUTES` const in `transport.ts`; previously only
  type/store — the vendor's own field docs were discarded).
  `OdooConnector.describeEntities` maps `help` → column description
  (verbatim), `string` → display label, many2one `relation` → declared
  relationships (target `id`, filtered to selected entities) + synthesised FK
  descriptions ("Customer — references res_partner."), and field type → role
  hints via `odooFieldRole` (`entities.ts`). Covers customer custom fields
  (`x_...`) automatically since it runs against the connected instance.
  `ODOO_ALLOWLIST` gained curated one-line `description`s for all 21 entities
  (also shown in the wizard picker now). Pure builder `buildEntityDocs`
  exported for tests; new `odoo/docs.test.ts` (12 tests, incl. mocked JSON-2
  wiring + non-string `help: false` coercion).
- **Profiler** (`backend/src/semantic/SchemaProfiler.ts`): new step 1a decrypts
  `connections.connector_config_encrypted` and calls `describeEntities` (with
  credential-rotation persist hook; failure degrades to the AI pipeline).
  Documented columns are EXCLUDED from AI Pass C (token + review-queue win);
  docs-derived relationships merge into the `declared` FK rung (deduped
  against the static `getKnownRelationships` catalog). Persist values (display
  name, description, dim/measure flags, ai_draft, semantic_source) are
  computed ONCE in `tablePersistByName`/`colPersistByKey` maps and consumed by
  BOTH the Postgres insert and the Neo4j sync so the dual-write mirror can't
  diverge. Precedence: connector docs > AI; documented rows land
  `ai_draft=false, approval_status='approved'` (skip the review queue);
  vendor display labels beat AI guesses even on undocumented columns; role
  hints fill dim/measure only where the AI pass didn't run.
- **Migration `20260714000068_add_semantic_source.ts`**: nullable
  `semantic_source` text on `source_tables` + `source_columns`
  ('declared' | 'curated' | 'ai', NULL = pre-provenance). Mirrored to Neo4j:
  `UpsertTableInput`/`UpsertColumnInput` gained `aiDraft`/`semanticSource`;
  Cypher sets `semanticSource` on create+match, and `aiDraft` is forced false
  on match only when the incoming row is trusted (preserves user confirmations
  otherwise). Relationship EDGES in Neo4j still hardcode `aiDraft: true`
  (pre-existing divergence from PG's `ai_draft=!isKnown`; PG drives the
  review queue).
- **Known limitation** (documented in the playbook §8): re-profiling still
  rebuilds all rows, so human edits are overwritten on the next profile run —
  pre-existing behaviour; "human edit beats everything" needs edit-tracking
  (follow-up).
- **Next**: §8 item 3 — EO column-docs curation (implement `describeEntities`
  returning a static curated map, `provenance: 'curated'`; profiler side
  already live). Then item 4 — `getStarSchemaTemplate`.

**Source-onboarding playbook (2026-07-14):** New binding contract
`docs/SOURCE_ONBOARDING.md` — the way of working for every new source
connector. Core principle: *documentation before inference*. Classifies
sources into three metadata tiers (1 self-describing via runtime metadata
APIs, 2 vendor-documented → build-time curation in the connector package,
3 undocumented → AI pipeline as today), defines the semantic precedence
ladder (`declared > curated > ai_verified > ai_draft`, human edits beat
all), a phase-by-phase checklist (research brief → transport/auth → entity
catalog → sync correctness → semantic wiring → deterministic star-schema
template → tests/conformance → registration), explicit fallback rules for
missing documentation, and a Definition-of-Done merge gate. §8 lists the
platform gaps the contract depends on, in build order: (1) trusted-tier
descriptions in SchemaProfiler + provenance column, (2) Odoo `fields_get`
harvest of `string`/`help`/`relation` (today only `['type','store']` are
fetched — the vendor's own field docs are discarded), (3) EO column-docs
curation, (4) `getStarSchemaTemplate` contract, (5) new conformance
checks. Doc only — no code changed this session.


**Prior last updated:** 2026-07-13 (dashboard generation — architecture assessment + Tier-1 reliability hardening)

**Dashboard generation — architecture assessment + Tier-1 hardening (2026-07-13):**
Full review of the dashboard-generation stack (prompts, AIService, route
validation pass, productContext, ChartWidgets, the reverted Vega migration)
plus an external survey of the 2025–26 charting/AI-dashboard landscape.
**Plan of record: `docs/backlog/dashboard-architecture-plan.md`** — read it
before touching dashboard generation/rendering. Headline verdict: the
current LLM→app-owned-JSON-DSL→deterministic Recharts pattern is the
industry-winning architecture (same as Databricks Genie / Hex / Superset
MCP); do NOT return to Vega-Lite (its silent-blank failure is a documented
structural property + worst measured LLM generation accuracy); the upgrade
path is ECharts 6 as a *second* backend behind the same DSL (Tier 2),
react-grid-layout for user layout editing (Tier 3), Mosaic-style
DuckDB-WASM cross-filtering (Tier 3). Tier 1 shipped in this session
(backend typechecks clean; 11 new unit tests pass):
- **`backend/src/shared/widgetContracts.ts` (new)** — single source of truth
  for the per-widget-type required SQL column contract
  (label/value/series/row_label/…); `validateWidgetColumns()` turns the
  "mis-aliased SELECT renders an empty card" silent failure into a caught,
  repairable issue. Unit-tested (`widgetContracts.test.ts`, pure functions).
- **`/generate` validation pass hardened** (`routes/dashboards.ts`) —
  deterministic column-contract check per executed widget feeds a new
  `contractIssue` field into `hasIssues` + the repair prompt (new fix rule 8
  in `VALIDATE_DASHBOARD_SYSTEM`); swallowed validation failures are now
  logged loudly instead of silently shipping an unvalidated spec.
- **Truncation repair wired into `parseJson`** (`AIService.ts`) — a 16K-token
  spec cut at the maxTokens cap now goes through `repairTruncatedJson` +
  Zod instead of 500ing the whole request.
- **Prompt contracts for the three phantom widget types** — combo_chart /
  treemap_chart / radar_chart were legal in the Zod enum but had no spec
  block in `DASHBOARD_SYSTEM`; full blocks + decision-table rows added,
  matching the actual frontend component contracts (combo: label/value +
  optional `line` right-axis overlay).
- **`kpiFormulas` now reaches dashboard generation** — was built by
  `productContext` but only used for NL→SQL; now threaded through
  `generateDashboardSpec` → `buildDashboardUser` as a "use these formulas
  verbatim" section.
- **Tier 1b + Tier 2/3 shipped later the same day (2026-07-13, same branch):**
  - **Structured outputs** behind `AI_STRUCTURED_OUTPUTS=1` (default OFF.
    No staging env — verify with the one-shot live check
    `backend/scripts/verify-structured-outputs.ts` before flipping; pinned
    SDK predates the feature, params passed via cast). Generate/refine/validate
    dashboard calls send `DASHBOARD_SPEC_JSON_SCHEMA` (in `outputSchemas.ts`,
    widget enum derived from `REQUIRED_WIDGET_COLUMNS`) as `output_format`
    + the structured-outputs beta header. Documented in `.env.example`.
  - **refine-spec parity**: kpiFormulas in the refine prompt; the validation
    pass (extracted to `validateAndRepairSpec()` in `routes/dashboards.ts`)
    now also runs on `/refine-spec`, scoped to only the widgets the
    refinement changed.
  - **Widget self-heal**: `POST /dashboards/fix-widget` re-runs
    execute→contract-check→repair for ONE widget; frontend `WidgetCard`
    shows "Fix with AI" on errored widgets and patches the spec in place
    (marks dashboard unsaved).
  - **ECharts 6 second rendering backend** (tree-shaken `echarts/core`,
    ~100 kB gz, SVG renderer so marks are DOM-assertable, own ~40-line
    wrapper `components/EChart.tsx` — NOT echarts-for-react — with a
    visible render-error state; Observatory theme in
    `utils/echartsSetup.ts`). Two new widget types shipped on it
    full-stack: **scatter_chart** (label/x/y[/size]) and **bullet_chart**
    (label/value/target, attainment colouring) — added to the shared
    contract (both copies), Zod enum, JSON schema, prompt decision table +
    spec blocks, `REQUIRED_WIDGET_COLUMNS`, page switch.
  - **The Vega-lesson render gate, implemented**: `/dev/widgets` fixture
    gallery renders every DSL widget type (no auth/backend);
    `e2e/widgets.spec.ts` asserts in REAL Chromium that each type draws
    visible SVG marks, the ECharts types are on the ECharts engine, and no
    page errors fire. PASSING. Add every new widget type to the gallery or
    the spec fails on its count check. `playwright.config.ts` accepts
    `PLAYWRIGHT_CHROMIUM_PATH` for managed environments.
  - **Code-split chart bundle**: widget-type switch extracted to
    `components/WidgetBody.tsx`, loaded via next/dynamic —
    `/dashboards` first-load JS now **210 kB** (was ~565 kB with static
    Recharts). `next build` green.
  - **Table virtualization**: dependency-free `utils/useWindowedRows.ts`
    (spacer-row windowing, inert ≤150 rows) in `DataTableWidget`,
    `PivotTableWidget`, `DrillDetailModal`.
  - **User-adjustable layout**: "Arrange" mode on `/dashboards` via
    react-grid-layout 2.2 (drag/resize, 12-col grid, rowHeight 96;
    `useContainerWidth` for measurement). Placements persist per widget as
    `spec.widgets[].layout {x,y,w,h}` (new optional contract field); view
    mode renders explicit CSS-grid placement when every widget has a
    layout, and falls back to the legacy flow layout otherwise (so
    refine-added widgets never overlap).
  - **New frontend deps**: `echarts ^6.1.0`, `react-grid-layout ^2.2.3`.
    New root devDep usage: `@playwright/test` (already declared).
- **Still open (see plan doc §2/§3):** flip `AI_STRUCTURED_OUTPUTS` after
  running the verify script against the live API; small-multiples widget + brush/zoom on ECharts;
  dark mode; token-source consolidation; paginated PDF export; Mosaic-style
  DuckDB-WASM cross-filter graduation; VisEval-style eval harness (needs
  live API); domain-detection upgrade.

**Last updated (prior):** 2026-07-11 (storage-layer hardening — per-tenant containers + DuckDB guardrails)

**Storage-layer hardening — per-tenant warehouse containers + DuckDB compute guardrails (2026-07-11):**
Outcome of the platform professionality audit (see repo-root
`Clarion-Platform-Professionality-Audit.docx`). Two shipped changes, both
additive; the container work is feature-flagged **default-off** so this deploy
is behaviour-preserving until the flag is set. Backend typechecks clean; new
unit tests pass (19); Terraform validates + formatted.
- **Per-tenant warehouse containers (opt-in, `WAREHOUSE_CONTAINER_MODE`).**
  New `shared` (default) | `per-tenant` mode. In `per-tenant` mode each tenant
  gets its own Azure Blob container (`<AZURE_WAREHOUSE_CONTAINER_PREFIX><id>`,
  default `tenant-<id>`), turning tenant isolation on the data side from a
  code-enforced path prefix into a **hard storage boundary**: a worker SAS
  scoped to `tenant-42` physically cannot touch `tenant-43`, and offboarding a
  tenant becomes a single container delete. Backward-compatible: existing
  `delta_path`/`warehouse_path` are absolute URIs, so old data keeps reading
  after the flip; only NEW writes land in per-tenant containers (same
  incremental-migration model as v1→v2 layout).
  - `services/warehouse/paths.ts` — new `warehouseContainerMode()`,
    `warehouseContainer(tenantId?)`, `warehouseRoot(tenantId?)` (now
    tenant-aware), `sourceBasePathV2(tenantId, connectionId)`,
    `sourceWorkerPathPrefix(...)`; `productBasePathV2` drops the redundant
    `tenant_<id>/` path segment in per-tenant mode (container encodes it).
  - `services/warehouse/container.ts` (new) — `ensureWarehouseContainer(tid)`
    (createIfNotExists, memoised) called before worker SAS issuance
    (SyncOrchestrator) and before product writes (transformationRunner);
    `deleteTenantWarehouseContainer(tid)` offboarding primitive;
    `perTenantContainersActive()`.
  - `orchestrator/BlobSasTokenIssuer.ts` — warehouse SAS now scoped to
    `warehouseContainer(tenantId)` (heartbeat unchanged); `IssueArgs.tenantId`
    added. `orchestrator/AzureContainerAppsJobLauncher.ts` — passes `tenantId`,
    uses `sourceWorkerPathPrefix` (so worker write prefix + backend read path
    always agree). `orchestrator/SyncOrchestrator.ts` —
    `computeWarehousePathForDuckDB` Azure branch delegates to
    `sourceBasePathV2`; ensures the container before launch.
  - Terraform: `WAREHOUSE_CONTAINER_MODE` / `DUCKDB_MEMORY_LIMIT` /
    `DUCKDB_THREADS` env on the backend app; new vars in `infra/variables.tf`
    (default `shared` / `70%` / `2`). Per-tenant mode needs the backend
    identity to create containers — the existing `Storage Blob Data
    Contributor` role covers it. **Validate in staging before flipping.**
- **DuckDB compute guardrails (default ON).** `services/warehouse/duckdb.ts`
  `applyResourceGuardrails()` runs on every warehouse session:
  `SET memory_limit` (default `70%`, env `DUCKDB_MEMORY_LIMIT`), `SET threads`
  (default 2, `DUCKDB_THREADS`), `SET temp_directory` (spills to disk instead
  of OOM, `DUCKDB_TEMP_DIR`). Plus `capResultRows()` (default 100k, env
  `DUCKDB_MAX_RESULT_ROWS`, 0=off) wraps single SELECT/WITH reads in
  `DuckDBConnector.executeQuery` to bound the Node heap — leaves multi-statement
  scripts and notebook DDL/PRAGMA/COPY untouched. Fixes the audit's "DuckDB
  unbounded on 1 GB container" red-flag (Tier-A A2). Transformation write path
  and introspection are unaffected.
- **Tests:** `services/warehouse/paths.test.ts` (new, 19 cases) — proves
  shared-mode URIs are byte-identical to today, per-tenant URIs are correct,
  read path ↔ worker write prefix agree, local mode is container-mode-agnostic,
  and `capResultRows` caps SELECTs while leaving DDL/multi-statement alone.
  Runs without a live DB or native DuckDB (pure functions).
- **New env vars (documented in `.env.example`):** `WAREHOUSE_CONTAINER_MODE`,
  `AZURE_WAREHOUSE_CONTAINER_PREFIX`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS`,
  `DUCKDB_TEMP_DIR`, `DUCKDB_MAX_RESULT_ROWS`.
- **Audit docs at repo root** (untracked, generated via `.archdoc/`):
  `Clarion-Platform-Professionality-Audit.docx` (rubric + grades + Tier A/B/C
  action plan), `Clarion-AI-Analytics-Gap-Analysis.docx`,
  `Clarion-Technical-Architecture.docx`. This change closes Tier-A A2 (DuckDB
  guardrails) and delivers the storage-isolation half of the "alternatives"
  recommendation (per-tenant containers over moving to Postgres).

**Connector-framework audit fixes (2026-06-14, follow-up to the Odoo work):**
Tackled the deferred findings from the framework audit. All connector-package
changes are unit-tested (37 tests, `tsc` clean); backend changes typecheck
clean (`tsc --noEmit`, only the pre-existing `knexfile.ts` rootDir warning).
- **Egress enforcement (SSRF guard).** `HttpClient` now enforces an
  `egressAllowList`: every request (including server-provided pagination
  links) is host-checked and a request off the list is refused before it
  leaves the process. Wired into ExactOnline (its static `*.exactonline.*`
  list) and Odoo (the single configured host, so self-hosted instances aren't
  blocked). Closes the "follow a tampered next-link to exfiltrate creds" hole.
- **Error redaction.** `HttpClient` runs error-response excerpts through
  `redact()` before they reach the thrown message; the orchestrator redacts
  `error_message` / `warnings` / `log_excerpt` before persisting. Secrets in an
  error body can no longer land in the DB / UI.
- **Worker wall-clock timeout + force-kill.** Orchestrator races `handle.done`
  against `SYNC_MAX_DURATION_MS` (default 30 min) and cancels on timeout;
  `JobLauncher.cancel` now escalates SIGTERM → SIGKILL after
  `WORKER_CANCEL_GRACE_MS` (default 20s). A hung worker can no longer sit in
  `running` forever, and cancellation has teeth.
- **stdout flood guard.** The launcher caps the line-reassembly buffer (1 MB);
  a newline-less blob from the child can't exhaust memory.
- **In-flight dedupe is now a DB invariant.** New migration
  `20260614000067_source_sync_runs_inflight_unique.ts` adds a partial unique
  index on `source_sync_runs(connection_id) WHERE status IN ('queued','running')`
  (pre-cleans existing duplicates first); `triggerSync` catches the 23505
  conflict and returns the winning run — closes the TOCTOU race.
- **Retention.** The 5-min reaper now prunes terminal `source_sync_runs` older
  than `SYNC_RUN_RETENTION_DAYS` (default 90) so the table can't grow forever.
- **Tenant-context injection hardening.** All `SET app.current_tenant` string
  interpolations in the orchestrator replaced with a parameterised
  `set_config('app.current_tenant', ?, false)` helper.
- **Config validation on write.** New package export `validateConnectorConfig`
  (compiles the connector's JSON Schema); `PATCH /:id/source-config` now
  rejects a schema-invalid merged config with 400 instead of writing it to the
  encrypted cell to fail deep in the next sync.
- **ExactOnline cursor `>` → `>=`.** Applied the boundary-safe incremental
  filter to EO too (it merges by businessKey, so the re-pull is idempotent);
  removes the same second-precision watermark skip the Odoo connector already
  avoided. Cursor still only advances on a strictly-greater value.
- **Azure SAS (NOT code-fixed — honest docs only).** The warehouse SAS is
  still container-scoped; true path scoping (per-blob / HNS-directory SAS, or
  per-tenant containers) is an infra change that can't be verified without a
  live Azure account, so shipping it blind was declined. The misleading
  comments in `types.ts` + `BlobSasWarehouseWriter.ts` that claimed Azure
  returns a 403 for out-of-prefix writes are corrected to state the real
  guarantee (code-enforced pathPrefix + tenant-prefixed layout). Worker-side
  confinement (pathPrefix + `isSafeTableName`) is unchanged and remains the
  active control. **Still open:** path-scoped SAS, RLS-in-prod for
  `source_sync_runs`/`oauth_pending` + id-only IDOR `WHERE`s, worker secrets via
  stdin instead of env (local launcher), merge-via-Delta for large incremental
  tables. These remain tracked.

**Last updated (prior):** 2026-06-14 (Odoo source connector + connector-framework hardening)

**Odoo source connector + framework hardening (2026-06-14):** Added **Odoo** as
a first-class source connector built the same way as ExactOnline (the
`packages/connectors/` `SourceConnector` framework — NOT the legacy
`backend/src/connectors` + ETL path). Preceded by a critical audit of the
connector framework; the Odoo connector is built to dodge the framework's
latent bugs, and the "required hardening" subset of the audit fixes shipped
alongside it. ExactOnline behaviour is unchanged (every shared change is
additive or default-off).
- **New connector package `packages/connectors/src/odoo/`:**
  - `schema.ts` — JSON-Schema config (`url`/`db`/`username`/`apiKey`); API-key
    auth (no OAuth). `asOdooConfig` strips trailing slashes.
  - `transport.ts` — `OdooTransport` interface + `resolveOdooTransport()`
    (probes JSON-2, falls back to XML-RPC) + a strict **read-only method
    allow-list** (`assertReadOnly`: only fields_get/search/search_read/
    search_count/read/read_group — create/write/unlink impossible by
    construction) + error types (`OdooAuthError`, `OdooEndpointMissingError`).
  - `json2Transport.ts` — **PRIMARY** transport. Odoo 19+/Online `/json/2`
    REST, `Authorization: bearer <apiKey>`, `X-Odoo-Database`. Reuses the
    shared HttpClient with `requestsPerSecond: 1` (Odoo Online throttles ~1
    req/sec). The only non-deprecated path (`/xmlrpc/2` + `/jsonrpc` are
    deprecated in Odoo 19, removed earliest on Odoo Online).
  - `xmlrpcTransport.ts` + `xmlrpcCodec.ts` — **FALLBACK** for older on-prem
    (Odoo ≤ ~16). Hand-rolled XML-RPC encode + `fast-xml-parser` decode; the
    codec is fully unit-tested (`xmlrpcCodec.test.ts`) so it's not shipped
    blind. Auth in body, no Authorization header.
  - `entities.ts` — 21-model curated allowlist with **dotted→underscore
    table-name mapping** (`account.move.line` → `account_move_line`; required
    because the warehouse writer's `isSafeTableName` rejects dots). Every entity
    is incremental on `write_date` with `businessKey:'id'`. Plus
    `ODOO_KNOWN_RELATIONSHIPS` (documented many2one FKs) and
    `odooTypeToDuckDb` (Odoo field type → stable DuckDB SQL type).
  - `OdooConnector.ts` — `testConnection`/`listEntities`/`probeEntities`
    (dynamic "available tables": `search_count` per model; missing models like
    `stock.valuation.layer` on v19 surface as `not_found`)/`sync`/
    `getKnownRelationships`. Sync paginates `search_read` (PAGE 2000, order
    `id`), passes the writer an **explicit `columns` schema from `fields_get`**
    (stable types — no per-sync inference drift), flattens many2one
    `[id,name]→id` and Odoo's `false` empty-sentinel → null (type-aware: a real
    boolean `false` is preserved), and uses a **`write_date >= cursor`** filter
    (not `>`) with merge-by-`id` so boundary-second rows are never skipped
    (idempotent re-pull). Cursor advances only on strictly-greater `write_date`
    (satisfies the orchestrator's monotonicity guard).
  - `index.ts` registers the connector; `packages/connectors/src/index.ts`
    imports `./odoo`. No backend route, ETL, or migration changes — the
    `add-source` wizard + `/source-types` are registry-driven, so Odoo appears
    automatically.
- **Required framework hardening (shared, additive / default-off):**
  - **HttpClient client-side rate limiting** (`requestsPerSecond` /
    `minIntervalMs`, per-instance single-flight pacer) — default off, so EO is
    unchanged; Odoo sets 1/sec. Also fixed `Retry-After` to honour the HTTP-date
    form. Test bypass via `HTTP_CLIENT_RATE_LIMIT_DISABLED=1`.
  - **Explicit-schema writes** — `WriteTableOptions.columns` threaded through
    both `ParquetWriter` + `BlobSasWarehouseWriter` (`read_json(columns=…)`
    instead of `auto_detect`). Eliminates type drift / date-as-string /
    bigint-precision loss for connectors that know their schema. EO (no
    `columns`) keeps `auto_detect` — unchanged.
  - **`source_sync_runs` reaper** (`backend/src/index.ts`) — startup closes
    `queued`/`running` rows interrupted by a restart; the 5-min interval reaper
    fails rows stuck >30min (`COALESCE(started_at, queued_at)`). Fixes the
    "zombie running row permanently blocks a connection" blocker for ALL
    connectors. Also resets the connection's denormalised `last_sync_status`.
  - **Connector conformance suite** (`conformance.ts` + `conformance.test.ts`)
    — every registered connector is checked for metadata invariants (lower-snake
    type, compilable configSchema, non-empty egressAllowList, oauth
    preAuthFields ⊆ schema props) and every catalog for entity invariants
    (`supportsIncremental === !!incrementalCursor`, **`incrementalCursor ⇒
    businessKey`** — the table-wipe blocker — name safety, uniqueness). Runs over
    both Odoo and ExactOnline today; the gate that scales to many connectors.
- **Frontend** (`frontend/app/sources/page.tsx`): removed the stale
  `available:false` Odoo tile and added Odoo to `REGISTRY_DESCRIPTIONS` /
  `REGISTRY_COLORS`, so the live tile renders from `/source-types` and routes to
  the registry-driven `add-source` wizard — identical to how ExactOnline works.
- **Validated:** `tsc -p packages/connectors --noEmit` clean; 32 tests pass
  (`xmlrpcCodec` 11, `registry` 6, `OdooConnector` 10, `conformance` 5).
  DuckDB-dependent tests (`OdooConnector.sync.test.ts`, `ParquetWriter.test.ts`,
  `ExactOnlineConnector.test.ts`) can't run in the dev sandbox here — Node 22 has
  no DuckDB prebuilt and the native build needs toolchain/network — they run in
  CI / the backend image where DuckDB is available.
- **Deferred (tracked, NOT in this change — from the framework audit):** Azure
  warehouse SAS is container-scoped not path-scoped (cross-tenant write
  isolation rests on worker convention); `egressAllowList` is declarative-only
  (never enforced) + SSRF via followed pagination links; error
  excerpts/`log_excerpt` not redaction-scrubbed; RLS conditional on a prod-absent
  role + a few id-only `WHERE`s (cross-tenant IDOR); no worker wall-clock timeout
  / SIGKILL escalation; `source_sync_runs` unbounded growth + TOCTOU in the
  in-flight dedupe; config not validated on `PATCH /source-config`; merge path
  rewrites the whole table each incremental sync (route large incremental tables
  through the Delta sidecar). Apply the EO cursor `>`→`>=` fix too when touching
  EO (it has the same boundary-skip latent bug; deferred to avoid changing the
  working connector without explicit sign-off).

**Earlier last-updated:** 2026-06-06 (Dashboards reverted to Recharts — Vega migration backed out)

**Dashboards reverted to Recharts (2026-06-06):** The entire Vega-Lite migration
(commits `90d6970`, `f9fe7b7`, `b723884`, `a6ebba9`, `e73c887`, `aabed9f`) was
reverted in a single revert commit. Dashboards are back on the original Recharts
engine — the state working before 2026-06-06. **Why:** the Vega migration kept
producing silent blank charts in production (most recently bullet / scatter /
small-multiples rendered empty cards with NO console errors despite correct SQL
output). Multiple attempted fixes (autosize, format strings, SVG renderer,
post-render mark detection) all passed headless validation through the real
vega-lite compiler + vega.View but failed in the actual browser — i.e. the
sandbox tests didn't reproduce the browser's behaviour, so each fix shipped
blind. After several failed iterations the user (rightly) requested a rollback.
- **What was kept:** the deploy traffic-routing fix (`fb981aa` — pins 100% to
  the latest revision after `az containerapp update --image`, critical and
  unrelated to charts) and the three design-direction HTML mockups
  (`design-mockups/A-executive-brief.html`, `B-analyst-cockpit.html`,
  `C-boardroom.html` from `e16e9dd` — useful reference if/when the visual
  refresh is attempted again).
- **What's gone:** every Vega file (`utils/vegaSpecBuilder.ts`,
  `utils/vegaTheme.ts`, `components/VegaChart.tsx`), the vega/vega-lite/
  react-vega/vega-tooltip deps from `package.json`, the `canvas: false` webpack
  alias in `next.config.mjs`, the new widget types (bullet_chart, scatter_chart,
  small_multiples) from `frontend/app/dashboards/types.ts` +
  `backend/src/ai/prompts/dashboardPrompt.ts`, and the cockpit-style prompt
  changes. The Recharts-based ChartWidgets and the original prompt layout
  rules are back exactly as they were before the migration.
- **Validated:** `next build` exit 0; the production state is the one shown in
  the user's screenshot where bars, lines, and top-lists render correctly.
- **If anyone attempts the Vega migration again:** the lesson is that headless
  vega-lite/vega.View tests do NOT reproduce browser canvas/SVG rendering
  edge cases. Don't ship without verifying in a real browser (e.g. Playwright
  driving `/dashboards` and snapshotting actual rendered marks).

**Earlier last-updated:** 2026-05-07 (SCD1 foundation: Delta + Python sidecar + change-evolution chart)

**SCD1 + change tracking — Delta + Python sidecar (2026-05-07):** Replaces
the parquet-overwrite write path for product tables with Delta Lake +
a small Python sidecar that diffs new vs existing state on a business
key. Per-refresh `unchanged / updated / inserted / deleted` counts are
persisted to a new `product_table_refresh_history` table and surfaced
as a per-table change-evolution mini chart on `/products/[id]`. **Delta
is the default** — production images bake the Python venv +
deltalake/pandas/pyarrow in, so no env var is needed in Azure. Set
`STORAGE_FORMAT=parquet` to opt out (the escape hatch for local dev
where Python deps aren't installed). Sets the foundation SCD2 will
extend later — full design captured in `docs/backlog/SCD2.md`.

- **New migration `20260508000052_create_refresh_history.ts`:**
  - `product_table_refresh_history` (RLS-protected, one row per refresh
    attempt, keeps counts + status + error + storage_format)
  - `product_columns.is_technical` boolean — firewall flag that keeps
    `_row_hash` and future SCD2 columns out of every UI/AI surface.
- **Python sidecar `etl/scd2/commit_table.py`:**
  - JSON-over-stdin/stdout protocol; deltalake + pandas, no extra deps
  - md5 row-hash with ASCII unit separator; explicit NULL handling
  - Outer-merge diff on business key; falls back to "all inserted" when
    no BK is declared
  - `mode='overwrite'`, `schema_mode='merge'` so the writer widens
    schema automatically when a transformation produces new columns
  - 11 pytest cases covering hash + diff (`scd2/test_commit_table.py`)
- **Node `services/warehouse/deltaWriter.ts`:**
  - Spawns sidecar via `child_process.spawn`, 15-min timeout, SIGKILL
  - Records `product_table_refresh_history` row regardless of outcome
    (failed rows show up on the chart so users see "something tried")
  - `isSidecarReachable()` fast-fail check called from
    `transformationRunner` BEFORE the AI-generated SQL runs — turns a
    deferred "spawn failed" into an immediate "config wrong" error.
- **`transformationRunner.ts` integration:** Feature-flagged Delta
  branch runs before the legacy parquet branch; `_row_hash` filtered
  out of `syncProductColumns` so it never lands in `product_columns`.
  Same code path for dim and fact (per spec — facts overwrite each
  refresh too, change counts tracked for the chart).
- **`is_technical` firewall wired into 7 surfaces:** `productContext`
  (NL→SQL prompt context), `investigateService` + `refineService` (AI
  prompts), `routes/products.ts` GET `/:id` and `/:id/refine` (UI panel
  + refine prompt), `routes/notebooks.ts` (schema explorer + AI prompt),
  `productGraphSync` (Neo4j sync). Every read of `product_columns` for
  a user/AI-facing surface now appends
  `WHERE is_technical = false OR is_technical IS NULL`.
- **API `GET /api/products/tables/:tableId/refresh-history?limit=N`:**
  Returns chronological refresh rows under tenant RLS; default 30, max
  200.
- **Frontend mini chart (`components/products/RefreshHistoryChart.tsx`):**
  Two variants — `compact` (32px sparkline shown inline in each table
  row) and `full` (200px chart with axes, legend, "last refresh"
  summary strip, shown in the expanded view). Wired into
  `ProductRootPanel` so it surfaces on both `/products/[id]` and
  `/catalog?productId=…`.
- **Backend Dockerfile:** Production image now bakes Python venv with
  deltalake/pandas/pyarrow pinned to the same versions as
  `etl/requirements.txt`. Sidecar copied to `/app/etl/scd2/` so the
  default path resolver in `deltaWriter` finds it without env-var
  overrides.
- **New env vars (documented in `.env.example`):** `STORAGE_FORMAT`
  (default unset = parquet), `PYTHON_BIN` (default `python3`),
  `SCD2_SIDECAR_PATH` (override for non-default deployment layouts).
- **What's NOT in this commit (next ops steps):**
  - Notification on anomalous deletes (e.g. >50% rows deleted) — the
    data is there, no UI hook yet.
  - Backfill of refresh-history rows for refreshes that ran before
    this commit shipped — they're invisible on the chart until the
    next refresh of each table populates a row.
  - SCD2 itself — see `docs/backlog/SCD2.md` for the design.

**Storage layer consolidation — Phase 3 (2026-05-05):** Tenant-prefixed,
id-stable warehouse layout for product tables. Eliminates the cross-tenant
collision risk identified in the storage-layer audit (`./warehouse/product/<slug>`
was shared across tenants — two tenants with a "Sales" product would
overwrite each other's parquet on the same host). Behaviour-preserving by
default; opt-in via `WAREHOUSE_LAYOUT_VERSION=v2`.

- **New URI helpers in `services/warehouse/paths.ts`:**
  - `warehouseRoot()` — single source of truth for the warehouse base
    URI. Returns `az://<container>` in Azure mode (detected via
    `AZURE_CONTAINER_APPS_JOB_NAME`), `<repo>/warehouse` locally.
    Container name from `AZURE_WAREHOUSE_CONTAINER`, default `'warehouse'`.
  - `isAzureMode()` — environment-level Azure detection (separate from
    `isAzurePath(uri)` which tests a single string). Mirrors the
    detection logic in `SyncOrchestrator` so source + product paths
    agree on the active mode.
  - `productBasePathV2(tenantId, productId)` — new layout
    `<root>/tenant_<tid>/product_<pid>`. Stable across product renames
    because it uses `product.id` not `slug(product.name)`.
  - `warehouseLayoutVersion()` — reads `WAREHOUSE_LAYOUT_VERSION` env;
    returns `'v1'` (default) or `'v2'`.
- **Wired into `transformationRunner.runProductTransformation`:**
  When the layout flag is `'v2'` and a tenant id is present, the
  product output path is `productBasePathV2(tenantId, productId)`
  instead of `productBasePath(warehousePath, productSlug(name))`.
  All other state (the parquet write itself, the `delta_path`
  publish via the catalog, dependency loading, rollups) is unchanged
  — it just consumes the new path. v1 builds still work; the flag is
  per-deployment.
- **Migration model — naturally incremental, no data copy required:**
  - Existing rows keep their `delta_path` pointing at v1 directories.
    They continue to read fine because the catalog returns
    `delta_path` verbatim.
  - When a v2 build runs (because the operator turned the flag on),
    new writes go to the v2 location, the catalog publishes the v2
    URI, the row's `delta_path` flips to v2.
  - Every product table eventually migrates as it's re-refreshed.
    No big-bang job, no downtime. Old v1 directories become orphans
    and can be cleaned up by a maintenance job at leisure.
- **`productContext.getProductWarehousePath` rebuilt on top of catalog:**
  Was: hardcoded `./warehouse/product/<slug>` (wrong on Azure, never
  matched real paths). Now: returns `warehouseRoot()` if any product
  table for the connection has been materialised, else null. Real
  per-table URIs come from `tableCatalog.listProductTablesByConnection`
  via `createProductConnector` — `getProductWarehousePath` is only a
  cache key now. Side benefit: the `dim_account` and similar
  cross-product reads now work in Azure mode where they didn't before.
- **Sources are unchanged.** `SyncOrchestrator.computeWarehousePathForDuckDB`
  already produced `<root>/tenant_<tid>/conn_<cid>` paths — Phase 3
  brings products into alignment with that pattern.
- **What's NOT in this commit (next ops steps):**
  - Migration script to copy v1 → v2 paths in bulk (so older tables
    don't have to wait for re-refresh). Trivial: walk every
    `product_tables` row matching the v1 pattern, copy parquet, update
    `delta_path`. Will write when there's demand.
  - Switching production to v2. The flag defaults to `v1`. To opt in:
    set `WAREHOUSE_LAYOUT_VERSION=v2` in the deployed env, then trigger
    a refresh — new writes start using the new layout. Old reads keep
    working throughout.
- **New env vars:** `WAREHOUSE_LAYOUT_VERSION` (`v1`|`v2`, default
  `v1`), `AZURE_WAREHOUSE_CONTAINER` (default `warehouse`). Documented
  in `.env.example`.

**Storage layer consolidation — Phase 2 (2026-05-04):** Built the table
catalog as the single source of truth for "where does this logical
table live?" Every consumer that previously queried
`product_tables.delta_path`, `ingested_tables.delta_path`, or
`connections.warehouse_path` directly now goes through one module.
Behaviour-preserving — no schema changes, no metadata migrations.

- **New module `backend/src/services/tableCatalog.ts`** with one
  uniform API:
  - **Resolution (single):** `resolveSourceTable(tenantId, connectionId, tableName)`,
    `resolveProductTable(tenantId, productId, tableName)`,
    `resolveProductTableById(tenantId, productTableId)` — returns
    `{ tableName, uri, rowCount, lastUpdatedAt }` or null. The catalog
    encapsulates the legacy ETL → docker-host path remap and the
    source-connector-flow fallback (deriving from
    `connections.warehouse_path` + `selected_entities` when
    `ingested_tables` is empty).
  - **Listings:** `listSourceTables(tenantId, connectionId)`,
    `listProductTables(tenantId, productId)`,
    `listProductTablesByConnection(tenantId, connectionId)` — return
    arrays of resolved tables. The cross-connection listing is what
    `createProductConnector` uses to register one DuckDB session that
    can JOIN across products (conformed dimensions).
  - **Writes:** `publishProductTable(tenantId, ptId, uri, rowCount)`,
    `publishStubFromUpstream(tenantId, ptId, productId, tableName)`,
    `markProductTableRunning(tenantId, ptId)`,
    `markProductTableFailed(tenantId, ptId, msg)`. The catalog is the
    ONLY writer of `delta_path` + `transformation_status='success'` —
    the regression class "runner says SUCCESS but delta_path is null"
    is now structurally impossible (the contract is enforced at the
    function boundary, not at the schema row).
- **Migrated callers (5 surfaces, ~6 inline join queries deleted):**
  - `connectors/ConnectorFactory.createProductConnector` — replaced
    the 20-line transactional join with a one-line catalog call.
    Affects `/query`, `/dashboards`, `/notebooks`, `/quality`,
    `/semantic` (every NL→SQL surface).
  - `services/transformationRunner.runProductTransformation` — write
    path: `publishProductTable` (success), `markProductTableFailed`
    (error), `markProductTableRunning` (start),
    `publishStubFromUpstream` (skip path). All four schema writes
    routed through catalog.
  - `services/transformationRunner.loadDependencyDimensions` —
    read path: replaced bespoke join with `listProductTables(upstream)`
    + filter to `tableRole === 'dimension' && !isStub`.
  - `routes/semantic.ts` `/product-preview` — replaced direct
    `product_tables` lookup + `delta_path` checks with
    `resolveProductTableById`. Distinguishes "row doesn't exist" from
    "not materialised" in the error message.
  - `routes/notebooks.ts` `buildNamespacedDuckDB` — replaced two
    separate `ingested_tables` + `product_tables` joins with
    `listSourceTables` + `listProductTablesByConnection`.
- **What this enables next:** Phase 3 (tenant-prefixed product layout)
  becomes a single-file change — only the catalog needs to know the
  new path scheme; every caller already gets a URI back. Migration
  job can run in the background and update `delta_path` rows; readers
  pick up the new paths transparently.
- **What still queries `delta_path` directly (deferred):**
  - `services/dbtProjectBuilder.ts` — generates dbt config strings
    embedded in YAML hooks (different process, can't go through our
    catalog). Will revisit if we kill the legacy ETL path entirely.
  - `services/productContext.getProductWarehousePath` — derives a
    parent-only path for use as DuckDB warehouse root. Currently
    broken on Azure (uses `./warehouse/product/<slug>` literally);
    Phase 3 will rebuild this on top of the catalog.
- **Net diff:** ~190 lines added (the new catalog module), ~140
  removed across the 5 callers. Bigger numbers, fewer places to
  patch when something changes.

**Storage layer consolidation — Phase 1 (2026-05-04):** Extracted four
duplicated implementations of "construct a warehouse path / register a
DuckDB view / write parquet" into a single `services/warehouse/` module.
Behaviour-preserving — no metadata changes, no on-disk layout changes.
Sets up Phase 2 (centralised table catalog) and Phase 3 (tenant-prefixed
product layout) to be safe scoped refactors.

- **New module `backend/src/services/warehouse/`** with four files:
  - `paths.ts` — `isAzurePath`, `parseAzurePath`, `productBasePath`,
    `productTablePath`, `productSlug`, `sqlEscapePath`. The single
    place that constructs warehouse URIs.
  - `duckdb.ts` — `setupDuckDBForWarehouse(db, needAzure)` consolidates
    the LOAD delta / LOAD azure / curl-transport / CREATE SECRET dance.
  - `views.ts` — `createScanView(db, viewName, uri, opts?)` replaces
    four near-duplicate implementations (transformationRunner,
    DuckDBConnector, notebooks, dbtProjectBuilder). Auto-detects
    Delta vs Parquet, local vs Azure; supports schema-qualified views
    via `{schema}` opt.
  - `writer.ts` — `writeParquet(db, uri, selectSql)` replaces three
    write paths (writeParquetToAzure, two inline COPY TO sites in
    transformationRunner). Handles the Azure stage-then-upload dance
    internally so callers don't need to branch.
  - `index.ts` — re-exports public API.
- **Migrated call sites** (8 files):
  - `services/transformationRunner.ts` — removed local `isAzurePath`,
    `parseAzurePath`, `setupAzure`, `writeParquetToAzure`,
    `productBasePath`, `productTablePath`, `createScanView` (~120
    lines deleted). All inline COPY TO / read_parquet write paths now
    delegate to `writeParquet`.
  - `connectors/DuckDBConnector.ts` — `loadExtensions` is now a
    one-liner; `createDeltaView` delegates to shared `createScanView`;
    duplicate `isAzureUri` closures replaced with imported `isAzurePath`.
  - `routes/notebooks.ts` — inline `createView` closure deleted; uses
    shared `createScanView` + `setupDuckDBForWarehouse`.
  - `services/dbtProjectBuilder.ts` — local `isAzurePath` deleted (the
    raw read_parquet/COPY strings inside dbt hooks remain inline; they
    run inside dbt's own DuckDB process, not ours).
  - `routes/quality.ts` — inline product-path construction replaced
    with `productBasePath(warehousePath, productSlug(name))`.
  - `routes/ingestion.ts`, `routes/products.ts`, `routes/semantic.ts`,
    `services/productContext.ts` — leftover `startsWith('az://')`
    checks all routed through `isAzurePath`.
- **Net effect:** ~250 lines removed, ~330 added (the four new
  warehouse files). One canonical place for "is this Azure?" "where
  does this product live?" "register a view." When DuckDB's azure or
  delta extension changes behaviour, one file needs updating, not four.
- **What stayed the same:** the on-disk layout (`./warehouse/product/<slug>`
  for local, `az://<container>/products/<slug>` for Azure) — Phase 3
  will introduce a tenant-prefixed v2 layout; for now we kept the
  existing paths so this commit is purely a refactor.
- **`utils/storage.ts`** (`StorageProvider` interface) was untouched —
  it's still dead code. Its API (upload/download/list/delete/exists)
  is at a different abstraction level; if we ever need it for
  non-DuckDB blob ops it's there. Otherwise it'll be removed in a
  later cleanup pass.

**Project rename — DataBridge → Clarion (2026-05-04):** Brand-only rename across
the source tree, docs, UI strings, comments, log messages, file names, and
package.json `name` fields where they're internal-only. The persistence /
infrastructure layer was deliberately preserved as `databridge` to avoid a
destructive migration of data and live deployments. **What stayed `databridge`
(do NOT change without an ops migration plan):**
- PostgreSQL database name, superuser role `databridge`, RLS role `databridge_app`
- Postgres password defaults (`databridge:databridge` in dev, `databridge_secret`
  for Neo4j, `databridge_redis` for Redis)
- Docker volumes `databridge_pgdata`, `databridge_neo4j_data`, `databridge_neo4j_logs`
  (renaming = data loss)
- Docker container names (`databridge-postgres`, `databridge-neo4j`, etc.) and
  Azure Container App / image names (`databridge-backend`, `databridge-etl`,
  `databridge-frontend`, `databridge-sync-worker`, `databridgeacr`,
  `databridge-rg`, etc.) — recreating these in Azure is a separate, scheduled
  ops task
- npm package `@databridge/connectors` (16 import callsites; renaming cascades
  to package.json deps and every workspace), and the workspace package names
  `databridge-backend` + `databridge-sync-worker` which match the Azure image
  names above
- Project root directory on disk is still `databridge/` — rename when
  convenient; Folder Structure section below uses the brand name `clarion/`.

If/when you want to retire the `databridge` infra names: it's a coordinated
operation involving `ALTER DATABASE`, `ALTER ROLE`, Docker volume migration,
Terraform state surgery, and an npm package rename. Single, well-scoped
follow-up task; not blocking.

**Files renamed:** `databridge-overview.html` → `clarion-overview.html`,
`DataBridge_Architecture.py` → `Clarion_Architecture.py` (the generated
`DataBridge_Architecture.pdf` artifact is left in place; re-run the .py to
regenerate as `Clarion_Architecture.pdf`).

**Dual-write contract — relationship mirrors + docs (2026-05-04):** Closed three
latent count-divergence bugs in the same class as the AI review queue confirm bug
fixed last session. The relationship endpoints `POST /semantic/relationships`,
`DELETE /semantic/relationships/:id`, and `POST /semantic/relationships/re-suggest`
now mirror their Neo4j writes into Postgres `table_relationships` so Home's
"relationships approved / total" counts (and any other Postgres aggregate that
reads the table) stay accurate. `id` is kept identical across stores — routes
draw from `semantic_node_id_seq` via `graph.nextPgId()` and insert into Postgres
with the explicit pgId via `.onConflict('id').merge()`, then `setval` is called
on `table_relationships_id_seq` so a later SchemaProfiler run can't collide.
Stale comment block at top of the Relationships section in `routes/semantic.ts`
(the old "user-facing endpoints write to Neo4j ONLY" comment) replaced with a
contract-style note pointing at CLAUDE.md. New top-level CLAUDE.md section
**"Dual-write contract (Postgres ↔ Neo4j)"** documents which surfaces read
Postgres directly, which writes are mirrored, which are still un-mirrored
(revert / approve / import — the rare admin paths), and the exit criterion for
retiring the contract entirely (migrate every direct-Postgres aggregate to
Neo4j count helpers). Architectural note: the user pushed back on dropping
Neo4j entirely (textbook argument: graph DBs good for AI semantics + relations).
We agreed to keep Neo4j and stabilise the dual-write contract instead — a
reversible decision pending future scale. Files changed: `backend/src/routes/semantic.ts`, `CLAUDE.md`.

**IA cleanup — 2026-04-27:**
- New tenant business glossary: `business_glossary` table (migration `20260427000040`), `/semantic/glossary` CRUD routes, `services/glossaryContext.ts` loads + formats entries for prompts, `AIService` injects the block into NL→SQL (source + cross + DuckDB), dashboard gen/refine, and schema-draft via `getTenantAiContext()`. New `Glossary` tab on `/semantic` (`components/semantic/GlossaryPanel.tsx`).
- KPIs tab removed from `/semantic`. KPIs now live only at the product layer (`/products` → KPIs tab, `product_kpis` table consumed by `productContext.kpiFormulas`). The `kpi_definitions` table and `/semantic/kpis` route are kept (notebooks still reads them; no destructive migration) but no longer have a UI surface. Source-layer KPIs are deprecated.
- `TableDetailPanel` and `ProductTableDetailPanel` now have **Definition / Quality** sub-tabs. Quality reuses `QualityPanel` scoped to the selected table — for product tables it queries `(parent connectionId, product table_name)` since `POST /quality/product/:id/profile` already writes results under that key.
- Nav rename: IconRail "Semantic" → "Catalog"; CommandPalette entry retitled. The `/semantic` route is the entity browse + detail surface (CatalogBrowser sidebar + tabbed detail panels). `/products` is the authoring surface (star-schema design, transformations, schedules, KPIs).
- **Quality removed from top-level nav.** The `/health` route still exists (orphaned; reachable by deep link only) but no longer surfaces in IconRail or ROUTE_ALIASES. Quality is consolidated under `/products` via a new **Quality** tab (`frontend/app/products/QualityTab.tsx`) that lists product tables grouped by product, sorted by score, with per-product "Profile all" and click-to-drill into `QualityPanel`. Source-table quality is reachable via the per-table Quality sub-tab on `TableDetailPanel` in `/semantic`. A cross-cutting "what's broken right now" feed (failed jobs + `quality_alerts` aggregate) is **deferred** — infrastructure exists (alerts table, AI context, notifications) but the unified UI does not.
- **Nav IA redesign — Phase A:** `IconRail` reorganized into four user-intent groups: **Discover** (Data catalog, Data products, Glossary), **Work** (Ask AI, Dashboards, Notebooks), **Curate** (Sources, AI review queue) — analyst+, **Settings** (Team & roles, Policies) — admin only. Old groups `workspace/model/admin` removed. `/setup` page role-gate widened from admin-only to admin+analyst (curators can now manage sources). `/semantic` Glossary tab extracted to standalone `/glossary` route (page renders existing `GlossaryPanel`, viewer-readable). New `/review` page (AI review queue) lists `ai_draft=true` source tables/columns with inline Confirm/Flag actions, powered by existing `GET /semantic/pending-approvals` and `PATCH /semantic/{tables,columns}/:id`. Backend `PATCH /semantic/tables/:id` and `PATCH /semantic/columns/:id` role-gates relaxed from `admin` to `admin+analyst` so analysts can confirm/flag. IconRail shows badge counts on Sources (unprofiled connections) and AI review queue (pending approvals). `/products` tab labels normalized to lowercase: "Coverage Map" → "Data tables", kept "Schema diagram" + "Data flow" as separate tabs (per user direction — they show different things: logical star structure vs upstream lineage). `/semantic` top-level Relationships tab kept (cross-cutting graph view).
- **Pipelines: ADF-style activity dock + FK fix (2026-05-04):** Two fixes after running the first pipeline against EO + wholesale_erp.
  - **FK bug**: `runPipelineWorkflow` and `runProductRefreshWorkflow` were passing `triggeredByUserId: 0` to `triggerSync()`, which violated the FK on `source_sync_runs.triggered_by_user_id → users.id` (no user with id 0). Source syncs from pipelines / per-product refresh would silently fail with `insert or update on table "source_sync_runs" violates foreign key constraint`. Fix: pass `undefined` instead of 0 — the column is nullable and `triggerSync` handles it. Audit attribution for pipeline-driven syncs lives on `pipeline_runs.triggered_by` ('user:email' / 'cron' / 'pipeline:N'), not on the synthetic source_sync_runs row.
  - **ADF-style activity dock** replaces the slide-over toast for live run progress. New component `RunActivityDock` sits BETWEEN the DAG canvas and the Recent-runs list (so users never lose sight of either while a run is in progress). Two halves: LEFT — node status table (each source + product in scope, queued/running/ok/failed/skipped/idle pill, click to expand per-table errors), RIGHT — terminal-style cumulative output with `phase`/`log`/`error`/`done` colour-coding. Header bar shows pipeline name, overall status, live counts ("3 ok · 1 running · 2 queued · 1 failed"). Collapsible to a single-line strip; dismissable when the run completes. Seeded from the scope hint so users see queued nodes immediately, then status updates pin to specific nodes by name (`<source>: queueing sync` / `: sync OK` / `: skipped` for sources, `Running "<product>"…` for products) as SSE events arrive.

- **Pipelines as first-class entities — `/pipelines` rebuilt (2026-05-03):** Replaced the legacy product-only DAG page with a first-class refresh-pipeline surface that includes sources as nodes, supports built-in + custom pipelines, and exposes triggers per pipeline. New mental model: a pipeline is a NAMED scope on the (sources → products) graph + zero-or-more triggers; everything else (per-product refresh, "Sync source + refresh", scheduled cron, sync-then-transform chains) is just a different scope/trigger combination.
  - **New tables**: `pipelines` (name, kind: `builtin|custom`, scope JSONB, triggers JSONB, enabled, last_run_at, last_status) + `pipeline_runs` (history, node_results JSONB rolled up from sub-jobs, job_id pointing at BullMQ for live attach). Migration `20260503000045_create_pipelines.ts`. Existing `connection_sync_schedules` + `transformation_schedules` left untouched — pipelines is a parallel, higher-level concept; we'll deprecate them in a follow-up.
  - **Built-in pipelines** computed on-the-fly from the dependency graph (never stored): `Refresh everything`, `Sync sources only`, `Transform products only`, `Refresh from <source>` + `Sync <source> only` per source, `Refresh <product>` + `Rebuild <product> (transformations only)` per product. Always reflect reality, no maintenance.
  - **`backend/src/services/pipelineService.ts`** — `getDag(tenantId)` (full graph: sources + products + (source→product, product→product) edges, computed from `data_product_sources`/`source_tables.connection_id`/`data_product_dependencies` with fallback to `data_products.connection_id`); `resolveScope(scope, tenantId)` (turns a scope JSON into concrete `{ sourceIds, productIds, shouldSyncSources }`, expanding upstream/downstream + filling source ids from product picks); `topoSortProducts(ids)` (Kahn's, used by the runner); `listBuiltinPipelines(tenantId)`.
  - **`runPipelineWorkflow`** in `busMatrixOrchestrator.ts` — Phase 1 syncs every source in scope in parallel (waits for `source_sync_runs` terminal status, fail-and-continue per source). Phase 2 runs products in topo order, fail-and-continue per product (independent products keep going), per-failed-table `error_detail` events flow through the same SSE stream. Persists `node_results` to `pipeline_runs` for history.
  - **Worker mode** `pipeline` added to `BusMatrixJobData` (alongside `design` + `refresh`). Reuses the existing bus-matrix queue + SSE / cancel / active-job endpoints unchanged.
  - **Routes** under `/api/pipelines/*`: `dag` (full graph), `list` (built-in + custom), `saved` POST/PUT/DELETE (custom CRUD), `run-pipeline` (enqueue by id `builtin:…` / `custom:…` or `adhocScope`), `runs` (history). Legacy product-DAG endpoints kept intact.
  - **Frontend** `/pipelines` page rebuilt (full rewrite): two-column layout — left rail lists built-in (grouped: global / per-source / per-product) + custom; right pane shows the shared DAG with the selected pipeline's scope highlighted, plus header (run / edit / triggers shown as chips), legend, and a recent-runs panel scoped to the selected pipeline. ReactFlow LR layout (sources left → products right). Custom pipeline editor as a modal: source picker (checkboxes), product picker (checkboxes), expansion toggles (include upstream / include downstream / skip source sync), trigger CRUD (cron + on-source-sync). Live run progress streams into a slide-over toast (re-uses `/api/products/bus-matrix/:jobId/stream` SSE) — per-table errors render in red.
  - **Locked decisions on the open UX questions**: notification-not-auto-run on profile completion / source sync auto-flips dependents ON by default (refreshes don't cost Claude tokens) / no default schedule (opt-in) / fail-and-continue per item / "Prepare my data" does NOT auto-sync source.
  - **Cron firing + on-source-sync chaining**: trigger UI accepts the data today, but the BullMQ repeatable-job that fires triggers is the next ship. UI surfaces this with a "manual run works today, automated triggers in the next release" hint on the editor.

- **Per-product refresh + upstream source sync + per-failed-table errors (2026-05-03):** Three connected fixes after a user reported "Build completed with errors — Sales: 0 ok, 2 failed" with no idea WHY, no way to refresh just one product, and no way to include source sync in the rebuild.
  - **`error_detail` event added to OrchestratorEvent union** (`busMatrixOrchestrator.ts`). When a product's transformation has failures, the orchestrator now emits one event per failed table containing `tableName` + `error` (the actual SQL/transformation error message). Frontend's SSE handler in `app/products/page.tsx` renders these as red `    ✗ <table>: <error>` lines under the product summary, so the user can SEE the cause and act.
  - **New refresh mode on the bus-matrix queue.** `BusMatrixJobData` now has optional `mode: 'design' | 'refresh'` + `productId` + `syncSource` fields. The worker (`processBusMatrixJob`) dispatches: `mode='design'` (legacy default) runs the full bus-matrix workflow; `mode='refresh'` runs the new `runProductRefreshWorkflow`. Reusing the same queue keeps the existing `/bus-matrix/:jobId/stream` (SSE), `/bus-matrix/active`, `/bus-matrix/:jobId/cancel` endpoints working unchanged for both modes.
  - **`runProductRefreshWorkflow`** (new export from `busMatrixOrchestrator.ts`). Optionally triggers source connection sync via `triggerSync()`, polls `source_sync_runs` until terminal state (3s interval, 30 min timeout, cancellation-aware), then runs `runProductTransformation` for the single product. Emits the same OrchestratorEvent stream so the frontend handler doesn't change.
  - **`POST /api/products/:id/refresh-start`** — enqueues a refresh job. Body `{ syncSource?: boolean }`. Returns `{ jobId }`. Refuses to enqueue a duplicate refresh for the same product. Frontend then attaches via the existing `/bus-matrix/:jobId/stream`.
  - **Per-card refresh control on `/products`** — split-button in each card footer: clicking the icon = "Sync source + refresh" (the end-to-end pipeline); clicking the chevron opens a menu with "Sync source + refresh" + "Rebuild transformations only" so users who already synced can skip it. Reuses the existing build-log overlay for progress + errors.
  - Files changed: `backend/src/jobs/queues.ts` (BusMatrixJobData fields), `backend/src/jobs/workers.ts` (mode dispatch + OrchestratorEvent type import), `backend/src/services/busMatrixOrchestrator.ts` (error_detail event + new orchestrator), `backend/src/routes/products.ts` (refresh-start route), `frontend/app/products/page.tsx` (handleRefreshProduct + per-card UI + error_detail rendering).

- **Products grouped by primary source — Phase 2 (2026-05-03):** Extends Phase 1's grouping to two more surfaces using the same `<SourceBadge>` primitive + helpers.
  - **`/dashboards` product picker** (`app/dashboards/page.tsx`) — flat product-button row → grouped sections per source. When the user has products from a single source, headers are suppressed (no visual noise); with ≥2 sources, each gets its own subsection with a small ocean-coloured eyebrow. Multi-source products carry an inline `+N` chip on the button (matching the badge's framing) with a hover tooltip listing the other contributors. Uses the shared `productSourceGroupKey()` / `productSourceGroupLabel()` helpers — selection-state recolouring kept the badge from being directly reusable on the buttons themselves, but the grouping rule is identical to /catalog and /products.
  - **`ProductRootPanel` header** (`components/products/ProductRootPanel.tsx`) — added `<SourceBadge size="compact">` next to the product name + status pill. Visible from both `/products/[id]` and `/catalog?productId=…` since both routes mount this panel. Backend `GET /api/products/:id` now returns the same `source` block as `GET /api/products`.
  - **Skipped** `/query` (the source selector's items ARE sources — adding source-grouping there would be circular) and `/notebooks` (each notebook is already pinned to a single connection with a chip; no products in the picker).

- **Products grouped by primary source — Phase 1 (2026-05-03):** Every data product now has a derived "primary source" — the connection contributing the most source tables, falling back to `data_products.connection_id`, with a `multiSource` flag when contributors span >1 connection. No migration; computed at the API boundary in two places:
  - `GET /api/products` enriched with `source: { id, name, connectorType, multiSource, sourceDeleted, otherSources[] }` per product
  - `GET /api/catalog/products` schemas enriched with `meta.sourceConnectionId / sourceConnectionName / sourceConnectorType / multiSource / sourceDeleted`
  Frontend treatment shared across surfaces:
  - **`frontend/components/SourceBadge.tsx`** — single visual primitive (Lucide Database icon + source name + optional `+N` chip with hover tooltip listing the other sources). Three states: normal, multi-source, source-deleted. Plus exported helpers `productSourceGroupKey()` + `productSourceGroupLabel()` so URL params and grouping keys stay consistent across pages.
  - **`/catalog` tree** (`CatalogBrowser`) — products no longer flat. Sub-grouped under their primary source: `Data Products → Exact Online → [products]`. Multi-source / Source deleted / Unassigned synthetic groups sink to the bottom and only render when non-empty. Sort: alphabetical by source name. Bucket headers are collapsible (default open).
  - **`/products` page** — source filter chip row above the grid (`All N · Exact Online 2 · wholesale_erp 1 · Multi-source 1`). When no filter active → grouped sections with source-name eyebrow and a per-group "Design your first <Source> product →" ghost card for sources with zero products (the killer feature: converts "browsing" into "doing"). When filtered → flat grid of one bucket. Each card now carries a `<SourceBadge size="compact">` in the top-right.
  - The "design from <source>" CTA pre-selects that connection in the existing build flow (`setBuildConnId`) so users land one click into "designing from this source".
  Edge cases handled: deleted source connection → faded "Source deleted" pill, product still openable; no resolvable source → "Unassigned" group; cross-source product → counted once under "Multi-source", `+N` chip shows the other sources on hover.
  Phase 2 (dashboards, query, notebooks) reuses the same `<SourceBadge>` primitive — same grouping rule, same vocabulary.

- **3-pass schema profiler + connector-declared relationships (2026-05-03):** Diagnosed why ExactOnline syncs were producing only one relationship across 7 tables / 511 columns: heuristic FK detection was completely dead on PascalCase API columns (Layer 2 only matched `_id` snake_case, Layer 4 INT-filtered out GUID FKs, declared-FK introspection is a no-op on Parquet), and the post-hoc AI relationship pass was running on cold per-table column descriptions written without cross-table awareness. Rewrite of the profiling pipeline:
  - **`SourceConnector.getKnownRelationships?(selectedEntities)`** — new optional method on the connector framework (`packages/connectors/src/types.ts`). API-style sources expose the documented FKs from their data model so the profiler doesn't have to re-discover them. ExactOnline now ships a 14-relationship catalog (`packages/connectors/src/exactonline/entities.ts → EXACT_ONLINE_KNOWN_RELATIONSHIPS`) covering invoice header↔lines, account roles (InvoiceTo / OrderedBy / DeliverTo → Accounts), Item↔GL accounts, GL classification hierarchy, transaction lines → ledger / accounts / journals, and the Parent self-references on Accounts + GLClassifications. Filtered to selected entities at runtime so unsynced relationships drop out cleanly.
  - **Generalised heuristic detector** (`backend/src/connectors/BaseConnector.ts`) — added `getKeyStem()` + `tokenizeTableName()` helpers handling both snake_case AND PascalCase / camelCase suffixes (`InvoiceID` → stem `invoice`, then matched to `SalesInvoices` via tokenisation `['sales', 'invoice']`). Layer 4's INT-only filter dropped — value-overlap verification handles precision.
  - **3-pass AI pipeline** (`backend/src/ai/prompts/schemaContextPrompt.ts` + `AIService.ts`):
    1. **`detectSchemaConventions`** — Haiku call, single short prompt. Asks "what naming convention does this source use?" Returns `{ naming_style, pk_pattern, fk_pattern, fk_target_inference, common_fk_columns_without_suffix, id_data_type, confidence }`. Cheap, drives the next two prompts.
    2. **`generateTableContext`** — Sonnet, single call, all tables. Input: column NAMES + samples + stats + conventions + pre-detected FKs (now actually populated). Output: per-table description / grain, **plus every relationship Claude can infer**. Prompt is explicitly biased towards generosity ("be liberal — every suggestion is value-verified afterwards"). Empty-pre-detected case has its own prompt branch nudging Claude not to be conservative.
    3. **`generateColumnDescriptions`** — Sonnet, per-batch. Input: this batch's columns + table descriptions + relationships from pass B. Now Claude knows `SalesInvoices.InvoiceTo` references `Accounts` and writes "Which customer is being billed for this invoice" instead of "Account reference". Same column-budget batching + recursive split as the legacy draft path.
  - **Value-overlap verification of AI relationships** — after pass B, the profiler runs a JOIN against the live data for every AI-suggested relationship that didn't come from a trusted source (declared / known / heuristic-verified). 50% overlap threshold. Lets the AI prompt be bolder while keeping precision honest.
  - **Case-insensitive table-name resolution** — pre-existing silent merge bug fixed: AI returning `salesinvoicelines` when the schema has `SalesInvoiceLines` would silently drop the relationship. Now canonicalised + dropped suggestions logged.
  - **Domain-primed prompts** — `connector_type` (ExactOnline / NetSuite / Salesforce / …) is plumbed into all three prompts so Claude can apply source-specific data-model knowledge without us teaching it.
  - **Net effect on ExactOnline**: relationship count goes from 1 (a self-reference) to ~14 just from the connector registry, plus whatever the AI pass adds on top via verified inference.
  - Files changed: `packages/connectors/src/{types,exactonline/{entities,ExactOnlineConnector}}.ts`, `backend/src/connectors/BaseConnector.ts`, `backend/src/ai/AIService.ts`, `backend/src/ai/prompts/schemaContextPrompt.ts` (new), `backend/src/semantic/SchemaProfiler.ts` (full rewrite of the AI section).
- **Source detail parity (2026-05-02):** `frontend/components/catalog/SourceRootPanel.tsx` rebuilt to mirror `ProductRootPanel`'s tabbed surface so clicking a data source in `/catalog` opens a rich detail view (was a single-purpose Relationships pane). Tabs: **Overview**, **Tables**, **Schema diagram**, **Data flow**, **Quality**, **SQL** (KPIs intentionally dropped — KPIs are a product-layer concept). Header surfaces connection name, source type, sync status pill, last-synced relative time, and AI-draft warnings. Overview = description / 4 stats / pending-drafts cards / "Used in — data products" via `GET /api/products/by-source-table/:id`. Tables = expandable list with column previews + dim/measure tags. Schema diagram = retains the existing three-way switch (Diagram / List / Review queue) with `RelationshipsDiagramView` + `RelationshipsListView` + `ReviewQueueView` — this stays the most important surface, with the original `RelationshipCanvas` editing affordances intact. Data flow = inverse-lineage list (which products consume each table, plus an "Unused source tables" callout). Quality = `connectionId`-scoped `/quality/tables` view, click-through to `<QualityPanel>` plus a "Profile all" button calling `POST /quality/:connId/:table/profile`. SQL = paste-ready `SELECT … FROM <table> LIMIT 100;` snippets per table for analyst reference. No backend changes — every endpoint already existed.
- **Nav IA redesign — Phase B:** `TableDetailPanel` restructured from 2 sub-tabs (Definition / Quality) to **5 tabs**: **Overview**, **Columns**, **Relationships**, **Quality**, **History**. Overview surfaces an AI-suggested banner with prominent inline Confirm/Flag buttons whenever `ai_draft && approval_status !== 'approved'` (PATCHes `ai_draft=false, approval_status=approved` or `approval_status=flagged`). Overview also shows a new **Used in — data products** card listing every product that references this source table, powered by new endpoint `GET /api/products/by-source-table/:sourceTableId` (joins `data_product_sources` → `data_products`, returns `id/name/status`). Relationships tab fetches `/semantic/relationships?connectionId=` and filters to rels where `from_table` or `to_table` matches the current table; shows IN/OUT direction badges. Quality tab still renders `<QualityPanel />`. History tab now always-visible (was a hide/show button). Floating "Save table" bar removed — save button is inline on Overview tab. Frontend `ApprovalStatus` type and `SourceTable.approval_status` widened to include `'flagged'` (backend already accepted the value). `ProductTableDetailPanel` not yet restructured — left for a follow-up if needed.

**Status:** All original POC build steps (1–11) are complete. The platform has grown significantly beyond the initial POC into a multi-tenant, multi-connector data platform with ETL ingestion, star schema products, quality profiling, background job queues, user management, and Azure production deployment.

**SMB competitive speed layer — Sprint 1.1–1.3 (April 2026):**
- Sprint 1.1a: `POST /api/dashboards/batch-execute` — single request for all widgets, `Promise.all` execution, one DuckDB connector shared across all widgets. Frontend `executeAllWidgets` replaced per-widget calls with one batch call. `executeSpecForValidation` also parallelised.
- Sprint 1.1b: After transformation success, DuckDB pool is immediately re-warmed (fire-and-forget `connect()`/`disconnect()`) so the next dashboard load hits a hot pool.
- Sprint 1.1c: `backend/src/services/widgetCache.ts` — 5-minute in-memory widget result cache keyed on `(tenantId, sha256(resolvedSql))`. Cache is invalidated on transformation and ingestion success. Integrated into `batch-execute` endpoint.
- Sprint 1.2: `generateMonthlyRollup()` in `transformationRunner.ts` — after each fact table materialises, a `rollup_monthly_<fact>` Parquet is auto-generated (monthly grain, SUM measures, FK dims, surrogate keys excluded via `product_columns` query). Detected by `detectRollupTables()` in `productContext.ts` and injected into semantic context. Dashboard prompt updated to always prefer rollup tables for aggregate/time-series queries.
- Sprint 1.3: Client-side filter cache via `widgetCacheRef` in `dashboards/page.tsx`.
- Sprint 2.2: Quality alerts enriched with Claude Haiku–written 2-sentence business context. New `ai_context` column on `quality_alerts`. Fires fire-and-forget after each critical/rule_fail alert insert. `QualityAlertBanner` shows it as italic text below the raw metric.
- Sprint 2.3: `pivot_table` widget type — cross-tab matrix.
- Sprint 2.4: KPI drill-to-detail — `DrillDetailModal.tsx` (overlay data table, Escape to close, row count footer). `KpiCard` shows "View detail →" when `spec.drillDownSql` exists; click calls `openDrillDetail()` in `page.tsx` which executes drill SQL via batch-execute and opens modal. Dashboard prompt updated: KPI cards now always include `drillDownSql`. Calculated measures in `DataTableWidget`: "+ formula" button opens inline form, formula evaluated safely via `new Function()` with column names as args, calc columns rendered in ocean colour with row-level computed values. — cross-tab matrix (row_label × col_label → value), heat-mapped cells, auto row/col totals. Wired end-to-end: `types.ts`, `ChartWidgets.tsx` (`PivotTableWidget`), `page.tsx` switch, `dashboardPrompt.ts` (type decision table + full example SQL). KPI delta (`value` + `delta` + `delta_label`) was already in the prompt and KpiCard — no changes needed. Stale-while-revalidate: filter changes show cached data instantly, server revalidates in background. For SELECT filters where `filter.column === widget.crossFilterKey`: pure JavaScript label-match filtering with zero server round-trips. `WidgetData` extended with `revalidating?: boolean`; `WidgetCard` shows a subtle pulse dot while stale data is shown.

**Recent frontend refactor (April 2026 — "Observatory" design system):**
- Full visual overhaul: editorial serif display font (Source Serif 4), mono eyebrows (Geist Mono), neutral light surfaces, single `ocean` accent. Replaces earlier Material-ish / glass / gradient styles. Tokens live in `frontend/lib/observatory.ts` (JS/SVG mirror) and `frontend/app/globals.css` (CSS variables).
- New shared primitives in `frontend/components/ui/` (Toast + global `<Toaster />`, NotificationBell, JobProgressBanner, ChartCard, EmptyState).
- Shell chrome is `AppShell` + `IconRail` + `TopBar` + optional `ContextPanel`; pages slot content via `children`/`contextPanel` props.
- `/query` page split across 7 files: `page.tsx` (orchestrator), `types.ts`, `utils.ts`, `components.tsx` (leaf UI), `MessageBubble.tsx`, `thinking.tsx`, `ChatSidebar.tsx`, `EmptyState.tsx`. Dropped from 2267 → 859 lines.
- `/dashboards` page modularized into `./components/` (10 widget files + header + KPI card + filter bar + CreateInput + EmptyDashboardHero), `./utils/` (format, motion, chart-theme, download), `./types.ts`. `page.tsx` is 1471 lines of mode-driven orchestration.
- `/products` page extracted to `./types.ts`, `./helpers.ts`, `./badges.tsx`; tabs (Schema/Lineage/Bus-Matrix/Kpis) remain inline. `page.tsx` is 1449 lines.
- `/semantic` table/product detail panels de-duplicated into `components/semantic/shared.tsx` (parseDomains, parseExamples, classifyType, completenessBucket, PreviewTable).
- Legacy CSS removed from `globals.css`: `.glass-card*`, `.gradient-mesh`, `.gradient-primary`, `.glass-sidebar`, `.widget-card*`, `.dashboard-topbar`, `.ghost-border*`, `.pill-active/inactive`, `.focus-teal/primary`, `.tonal-shift`, `.accent-bar`, `.glow-*`. Went from ~461 → 320 lines.
- Icon system: `lucide-react` added (v1.8.0). Migrated ~40 inline `<svg>` blocks across shared layout chrome (IconRail, TopBar, NotificationBell, CommandPalette), `/query`, `/dashboards`, `/health`, `/products` to named Lucide components. Remaining inline SVGs are diagram geometry (RelationshipCanvas, StarSchemaFlow, LineageFlow) or legacy panels not yet touched.
- Auth gating: `components/RequireRole.tsx` wraps admin pages (`/setup`, `/users`, `/gaps`, `/policies`, `/products`); shows a "Restricted" card rather than router-push to avoid disruption.
- Date formatting consolidated: `frontend/lib/dates.ts` (formatDate/formatDateTime/formatRelative/formatRelativeShort, `en-GB` locale).
- Tenant chip in TopBar fetches real org name from `/users/profile` (cached in sessionStorage), no longer derived from email domain.
- Deleted routes: `/connect`, `/cross-views`, `/dictionary`, `/quality`, `/reports`, `/review`, `/team` (consolidated into `/setup`, `/semantic`, `/users`, `/health`).
- New routes: `/dev/*` (internal playground), `/onboarding` (new-user wizard).

**Neo4j integration status:**
- All phases complete (0–6). Phase 7 (drop Postgres semantic tables) deferred.
- Neo4j is the source of truth for: source_tables, source_columns, table_relationships, kpi_definitions, cross_source_views, quality_rules.
- Postgres still stores: connections, query_log, definition_gaps, dashboards, rule_executions, quality_failures, quality_score_history, dataset_profiles, field_profiles, tenants, users, conversations, notifications, data_products, transformation_schedules, transformation_checks.
- quality_rules remain dual-written (Postgres primary for rule_executions FK integrity; Neo4j for AI context traversal).

**To start locally:**
1. `docker compose up -d` (starts Postgres, Neo4j, ETL)
2. `cd backend && npx knex migrate:latest` (run all 30 migrations)
3. `npm run neo4j:migrate` (seed Neo4j from Postgres, if data exists)
4. `npm run dev` in backend/ (Express on port 3001)
5. `npm run dev` in frontend/ (Next.js on port 3000)
Or use `start.bat` / `start.sh` to do all of the above in one command.

**Known issues / blockers:**
- `better-sqlite3` v9.x does not compile on Node 24 — pinned to `latest` (v11+) which has Node 24 prebuilt binaries
- Neo4j container takes ~30s to start — backend retries constraint creation automatically for up to 30s
- Backend must be restarted after any changes to `backend/src/**` (no hot-reload)
- Redis is optional for local dev — if not configured, jobs execute inline (synchronous)
- quality_rules are dual-written (Postgres + Neo4j) — rule_executions FK still points to Postgres quality_rules.id

**Key architectural decisions made during build:**
- Entity pre-flight check in `query.ts`: extracts string literals from generated SQL, checks exact match count in source dimension columns before executing. Count 0 → fuzzy suggestions. Count 2–15 → disambiguation picker. Count 16+ → treated as category value, proceeds normally.
- Repair loop in `query.ts`: SSE stream, max 5 turns, Claude fires diagnostic queries and reconstructs SQL. Auto-triggered when validator flags a suspicious result.
- Dashboard spec format: JSON with `filters[]` and `widgets[]`. Filters use `{{id_from}}`/`{{id_to}}` for date ranges and `('{{id}}' = 'all' OR col = '{{id}}')` pattern for select filters. Widget SQL contains placeholders; backend substitutes before executing.
- Dashboard refinement: `POST /api/dashboards/refine` generates 3–4 schema-aware clarifying questions with suggestion chips before generation.
- Multi-tenancy: PostgreSQL Row-Level Security (RLS) policies on all tables, tenant context set via `SET app.current_tenant` in every request.
- Star schema products: AI designs fact/dimension tables from source schema, DuckDB materializes them as Parquet files in a data warehouse (local or Azure Blob).
- Background jobs: BullMQ queues (schema-profiling, ingestion, transformation) with Redis; falls back to inline execution when Redis is unavailable.

---

## Project Overview

**Clarion** is a multi-tenant semantic data platform that allows business users to connect
to their source databases, enrich them with AI-assisted semantic definitions (table/column
descriptions, relationships, KPI formulas), and then query that data using conversational
AI — without ever writing SQL.

The platform supports the full data lifecycle:
1. **Connect** — plug in source databases (SQLite, PostgreSQL, MySQL, SQL Server)
2. **Profile** — AI generates draft definitions; quality profiling scores data health
3. **Ingest** — ETL pipeline loads source data into a Delta Lake warehouse
4. **Model** — AI designs star schemas (fact/dimension tables) from source data
5. **Query** — natural language questions converted to SQL via Claude
6. **Visualize** — AI-generated dashboards, reports with executive summaries
7. **Govern** — definition gaps, quality alerts, audit trails, approval workflows

**Target users:**
- **Admin** — data team or consultants who set up sources and curate definitions
- **Analyst** — power users who query, build dashboards, and explore data
- **Viewer** — business users who consume dashboards and ask questions

---

## Non-Negotiables

- **Never show raw SQL to a business user.** A "show query" toggle is allowed for
  admin/analyst roles, but never visible by default.
- **Never expose API keys or credentials in the frontend.**
- **Never query the source database without first passing through the semantic layer context.**
- **Never guess a KPI definition.** If context is insufficient, ask a clarifying
  question instead of executing.
- **All AI calls go through a single AIService module.** No direct fetch() to the
  Claude API anywhere else in the codebase.
- **Every AI-generated SQL query must carry a confidence score** before execution.
  Queries below 0.70 confidence are blocked and logged as definition gaps.
- **Stored credentials are encrypted** with AES-256-GCM before persisting to Postgres.

---

## Tech Stack

### Backend
- **Runtime:** Node.js 20+ with TypeScript
- **Framework:** Express.js with Helmet (security headers), CORS, rate limiting
- **Query builder:** Knex.js for PostgreSQL (semantic layer) and SQLite (source)
- **Semantic layer database:** PostgreSQL 16 (Docker locally, Azure Flexible Server in prod)
- **Knowledge graph:** Neo4j 5 Community — stores semantic relationships, cross-source views
- **Source connectors:** SQLite, PostgreSQL, MySQL, SQL Server (via `connectors/` abstraction)
- **Query engine:** DuckDB — used to query ingested Parquet files (star schema products)
- **AI:** Anthropic Claude API (`claude-sonnet-4-6`) via `@anthropic-ai/sdk`
- **Auth:** JWT-based with bcrypt password hashing; three roles: admin, analyst, viewer
- **Job queue:** BullMQ + Redis (optional — falls back to inline execution)
- **Logging:** Pino (structured JSON logging)
- **Monitoring:** Azure Application Insights (optional)
- **Storage:** Local filesystem or Azure Blob Storage (auto-detected)
- **Secrets:** AES-256-GCM encryption for stored credentials; Azure Key Vault in production
- **Validation:** Zod schemas for request validation
- **Testing:** Vitest with PostgreSQL service container

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS 3.4
- **Charts / Dashboards:** Recharts for data visualisation
- **Graph visualization:** ReactFlow + Dagre (star schema diagrams, lineage flows)
- **Export:** html2canvas + jsPDF for dashboard PDF export
- **API calls:** Axios with a central `api.ts` client (JWT interceptor, 401 auto-redirect)
- **Custom fonts:** Geist / Geist Mono

### ETL Pipeline
- **Runtime:** Python 3.12 (FastAPI)
- **Storage format:** Delta Lake (Apache Parquet-based)
- **Supported sources:** SQLite, PostgreSQL, MySQL, SQL Server
- **Output:** Local filesystem or Azure Blob Storage
- **Incremental loading:** Watermark-based CDC

### Infrastructure
- **Local dev:** Docker Compose (Postgres, Neo4j, ETL; Redis optional)
- **Production:** Azure Container Apps with scale-to-zero
- **IaC:** Terraform (Azure: PostgreSQL Flexible Server, Container Apps, ACR, Blob Storage, Key Vault, App Insights)
- **CI/CD:** GitHub Actions (test on PR, deploy on push to main/staging)
- **E2E:** Playwright (Chrome, headless)

---

## Folder Structure

> Note: the on-disk root directory is still `databridge/`. The brand was renamed
> to Clarion but the directory wasn't moved (would require updating every shell
> script + dev launcher). Rename when convenient.

```
clarion/                              ← on disk: databridge/
├── CLAUDE.md                         ← you are here
├── .env                              ← local only, gitignored
├── .env.example                      ← committed, no secrets
├── .gitignore
├── docker-compose.yml                ← dev: Postgres + Neo4j + ETL
├── docker-compose.production.yml     ← prod-like: adds Redis + backend + frontend
├── package.json                      ← root workspace (minimal)
├── playwright.config.ts              ← E2E test config
├── start.bat / start.sh              ← one-command startup scripts
├── start-backend.bat / start-frontend.bat / start-docker.bat / stop-docker.bat
├── run-migrations.bat / run-seed.bat / rebuild-etl.bat
├── PROJECT_PLAN.md / DEPLOY.md       ← planning and deployment docs
│
├── shared/
│   └── types.ts                      ← UserRole, AuthUser, JwtPayload, ApiResponse<T>
│
├── e2e/
│   └── smoke.spec.ts                 ← Playwright: register, login, navigate pages
│
├── etl/
│   ├── main.py                       ← FastAPI ETL service (discover, ingest endpoints)
│   ├── Dockerfile                    ← Python 3.12-slim
│   └── requirements.txt              ← fastapi, deltalake, pyarrow, pandas, etc.
│
├── infra/
│   ├── main.tf                       ← Azure resources (Postgres, Container Apps, ACR, etc.)
│   ├── variables.tf                  ← Terraform variables
│   ├── outputs.tf                    ← Terraform outputs
│   └── prod.tfvars.example           ← Example production variables
│
├── .github/workflows/
│   ├── deploy.yml                    ← Build + push images + deploy to Container Apps
│   ├── test.yml                      ← Run vitest + security audit on PR
│   └── dependabot.yml                ← Weekly dependency updates
│
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── knexfile.ts
│   ├── Dockerfile                    ← Node.js backend container
│   └── src/
│       ├── index.ts                  ← Express app: routes, middleware, startup, shutdown
│       ├── seed.ts                   ← creates data/sample.db (Belgian SMB data)
│       ├── seed-hr.ts                ← creates sample HR database (hr.db)
│       ├── seed-postgres.ts          ← populates Azure Postgres with sample data
│       ├── migrate-sqlite-to-postgres.ts  ← one-time SQLite→Postgres migration tool
│       │
│       ├── ai/
│       │   ├── AIService.ts          ← single entry point for ALL Claude API calls
│       │   └── prompts/
│       │       ├── schemaDraftPrompt.ts      ← schema profiling prompts
│       │       ├── nlToSqlPrompt.ts          ← NL→SQL for source databases
│       │       ├── nlToSqlPromptDuckDB.ts    ← NL→SQL for DuckDB (warehouse queries)
│       │       ├── dashboardPrompt.ts        ← dashboard generation + refinement
│       │       ├── starSchemaPrompt.ts       ← star schema design + transformation SQL
│       │       ├── answerFormatterPrompt.ts   ← report narrative generation
│       │       ├── repairPrompt.ts           ← agentic SQL repair loop
│       │       └── qualityAlertPrompt.ts     ← 2-sentence business context for quality alerts (Haiku)
│       │
│       ├── connectors/
│       │   ├── BaseConnector.ts      ← abstract interface + FK detection + table classification
│       │   ├── ConnectorFactory.ts   ← creates correct connector from connection config
│       │   ├── ConnectorPool.ts      ← connection pooling + shutdown drain
│       │   ├── SqliteConnector.ts    ← better-sqlite3
│       │   ├── PostgresConnector.ts  ← pg
│       │   ├── MysqlConnector.ts     ← mysql2
│       │   ├── MssqlConnector.ts     ← mssql
│       │   └── DuckDBConnector.ts    ← duckdb-async (warehouse query engine)
│       │
│       ├── db/
│       │   ├── knex.ts               ← PostgreSQL semantic DB (with RLS role switching)
│       │   ├── neo4j.ts              ← Neo4j driver singleton + constraints + shutdown
│       │   ├── semanticGraph.ts      ← ALL Cypher queries (only file with Cypher)
│       │   ├── migrateSemanticToNeo4j.ts  ← one-shot migration script
│       │   └── migrations/           ← 30 Knex migrations (see list below)
│       │
│       ├── jobs/
│       │   ├── redis.ts              ← IORedis singleton (optional)
│       │   ├── queues.ts             ← BullMQ queue definitions (4 queues: profiling, ingestion, transformation, email-report)
│       │   ├── workers.ts            ← schema-profiling, ingestion, transformation, email-report workers
│       │   ├── scheduler.ts          ← repeatable job manager for cron-based transformation schedules
│       │   └── emailScheduler.ts     ← repeatable job manager for email report schedules
│       │
│       ├── middleware/
│       │   ├── auth.ts               ← JWT verify, password hash, role checks (admin/analyst/viewer)
│       │   ├── tenant.ts             ← multi-tenant isolation (SET app.current_tenant)
│       │   ├── validate.ts           ← Zod request validation middleware
│       │   ├── schemas.ts            ← Zod schemas for auth, invites, etc.
│       │   ├── requestLogger.ts      ← structured request logging with request IDs
│       │   └── errorHandler.ts       ← global error handler, never leak internals
│       │
│       ├── routes/
│       │   ├── auth.ts               ← register, login, forgot-password, reset, refresh token
│       │   ├── connections.ts        ← CRUD connections; trigger profiling; manage ingestion
│       │   ├── semantic.ts           ← confirm/edit table/column definitions from AI draft
│       │   ├── query.ts              ← NL→SQL; execute; repair loop (SSE); entity pre-flight
│       │   ├── reports.ts            ← CRUD reports; AI narrative generation
│       │   ├── dashboards.ts         ← CRUD dashboards; execute widget SQL; refinement
│       │   ├── cross-views.ts        ← admin-only cross-source views (Neo4j graph)
│       │   ├── quality.ts            ← quality profiling; alerts; trends
│       │   ├── ingestion.ts          ← trigger ETL ingestion to Delta Lake warehouse
│       │   ├── products/            ← CRUD data products, split 11 ways (see products/index.ts)
│       │   │   ├── topic.ts         ← GET /:id/topic — the topic page's single read model
│       │   │   ├── buildOverview.ts ← GET /build-overview — the Build page's single read model
│       │   │   └── …                ← catalog, core, design, tables, refine, kpis, build, refineChat, cells
│       │   ├── jobs.ts               ← check background job status
│       │   ├── schedules.ts          ← CRUD transformation schedules (cron); manual triggers
│       │   ├── users.ts              ← admin-only user management; invites; role updates
│       │   ├── conversations.ts      ← chat history persistence; export results
│       │   ├── notifications.ts      ← user notifications (job complete, quality alerts, invites)
│       │   └── emailSchedules.ts     ← CRUD dashboard email schedules; send-now trigger
│       │
│       ├── services/
│       │   ├── notificationService.ts      ← notify(), notifyTenant()
│       │   ├── productContext.ts           ← build star schema semantic context for NL→SQL; detects rollup tables
│       │   ├── transformationRunner.ts     ← DuckDB transformation materialization (Parquet) + monthly rollup generation
│       │   ├── transformationChecks.ts     ← BK uniqueness + fan-out quality gates
│       │   ├── widgetCache.ts             ← 5-min in-memory widget result cache (tenantId + sql_hash keyed)
│       │   ├── emailService.ts            ← nodemailer wrapper; no-op when SMTP_HOST not configured
│       │   └── reportEmailService.ts      ← execute dashboard widgets + AI summary + HTML email builder
│       │
│       ├── quality/
│       │   └── QualityProfiler.ts    ← per-field stats: nulls, distinct, min/max, histograms
│       │
│       ├── semantic/
│       │   └── SchemaProfiler.ts     ← full profiling workflow: introspect → AI draft → store
│       │
│       ├── utils/
│       │   ├── logger.ts             ← Pino structured logging
│       │   ├── crypto.ts             ← AES-256-GCM credential encryption/decryption
│       │   ├── cache.ts              ← in-memory cache utility
│       │   ├── monitoring.ts         ← Azure App Insights telemetry
│       │   ├── paginate.ts           ← pagination helper
│       │   ├── secrets.ts            ← Azure Key Vault secret retrieval
│       │   └── storage.ts            ← Azure Blob Storage helpers
│       │
│       ├── shared/
│       │   └── types.ts              ← backend-internal shared types
│       │
│       └── tests/
│           ├── setup.ts              ← Vitest global setup
│           ├── helpers.ts            ← test utilities
│           ├── db-helpers.ts         ← database test helpers
│           ├── auth.test.ts
│           ├── connections.test.ts
│           ├── dashboards.test.ts
│           ├── health.test.ts
│           ├── notifications.test.ts
│           ├── tenant-isolation.test.ts
│           └── users.test.ts
│
└── frontend/
    ├── package.json
    ├── tsconfig.json
    ├── next.config.mjs
    ├── tailwind.config.ts
    ├── postcss.config.mjs
    ├── .eslintrc.json
    ├── Dockerfile                    ← Next.js frontend container
    ├── public/
    │   └── logo.svg
    ├── app/
    │   ├── layout.tsx                ← root layout + <Toaster /> mount
    │   ├── globals.css               ← Observatory CSS variables, scrollbar utilities, orbs, heatmap
    │   ├── page.tsx                  ← login / landing page
    │   ├── register/page.tsx         ← new user registration form
    │   ├── forgot-password/page.tsx  ← password reset request
    │   ├── reset-password/page.tsx   ← password reset confirmation (token-based)
    │   ├── profile/page.tsx          ← user profile: display name, password change
    │   ├── onboarding/page.tsx       ← new-user onboarding wizard
    │   ├── setup/page.tsx            ← admin: connect sources, trigger AI schema profiling (RequireRole)
    │   ├── semantic/page.tsx         ← definitions: tables/columns/relationships/glossary tabs (KPIs moved to /products)
    │   ├── topics/                   ← TOPIC-FIRST FRONT DOOR (business user's home)
    │   │   ├── layout.tsx            ← ShellLayout wrap
    │   │   ├── types.ts              ← Topic, TopicQuestion, ManageTab, TableSubTab, DeployState
    │   │   └── [productId]/page.tsx  ← topic layer + manage layer (?manage=1) + cross-fade
    │   ├── shared-data/              ← conformed lookups (was the "Core dimensions" product)
    │   │   ├── layout.tsx
    │   │   └── page.tsx
    │   ├── build/                    ← Studio → Build: source → topics (plan, create, show/hide, warned rebuild)
    │   │   ├── layout.tsx
    │   │   └── page.tsx
    │   ├── products/                 ← build workshop — off the nav, deep-link only
    │   │   ├── page.tsx              ← orchestrator + tabs (overview, bus-matrix, schema, lineage, kpis)
    │   │   ├── types.ts              ← Connection, DataProduct, StarSchema, ProductTable/Column/Relationship, KPI, ActiveTab
    │   │   ├── helpers.ts            ← statusBorderColor, productIcon, cleanTopicName
    │   │   └── badges.tsx            ← StatusDot, StatusBadge, RoleBadge, ColumnRoleBadge, Spinner
    │   ├── query/                    ← NL chat with repair loop + disambiguation
    │   │   ├── page.tsx              ← stateful orchestrator
    │   │   ├── types.ts              ← Message, DebugInfo, Conversation, RepairState, EntityMismatch/Ambiguity, ForecastData
    │   │   ├── utils.ts              ← formatSql, formatCellValue
    │   │   ├── components.tsx        ← SourceSelector, BoldText, ConfidenceBadge, QueryLayerBadge
    │   │   ├── MessageBubble.tsx     ← main bubble + ResultVisualizer + ForecastChart + LowConfidenceGuide + AdminDebugPanel
    │   │   ├── thinking.tsx          ← ThinkingBubble (live reasoning) + ThinkingPanel (repair-loop events)
    │   │   ├── ChatSidebar.tsx       ← conversation list (slots into AppShell contextPanel)
    │   │   └── EmptyState.tsx        ← pre-chat landing with STARTERS
    │   ├── dashboards/               ← AI dashboard builder with filters + drill-down
    │   │   ├── page.tsx              ← orchestrator (mode: empty | choosing | refining | creating | viewing)
    │   │   ├── layout.tsx            ← app shell wrap
    │   │   ├── types.ts              ← FilterSpec, WidgetSpec, DashboardSpec, SavedDashboard, DashboardTemplate, DrillState, RefinementQuestion, ChatMessage, WidgetData
    │   │   ├── utils/
    │   │   │   ├── format.ts         ← buildDefaultFilters, relTime, formatValue
    │   │   │   ├── motion.ts         ← Framer Motion variants (containerVariants, slideUp, shimmerClass)
    │   │   │   ├── chart-theme.ts    ← Recharts palette + style helpers
    │   │   │   └── download.ts       ← authenticated file-download helper (CSV/XLSX/PDF)
    │   │   └── components/
    │   │       ├── CreateInput.tsx           ← reusable text-input + Go button
    │   │       ├── EmptyDashboardHero.tsx    ← empty-state hero + suggestion chips
    │   │       ├── DashboardHeader.tsx       ← title + save/discard + dark-mode toggle
    │   │       ├── FilterBar.tsx             ← dashboard filter row
    │   │       ├── MarkdownAnswer.tsx        ← streaming markdown renderer
    │   │       ├── KpiCard.tsx               ← KPI tile with trend + sparkline
    │   │       ├── ChartWidgets.tsx          ← Bar/Line/Pie/Stacked/Combo/Radar/Treemap/TopList/DataTable
    │   │       ├── WidgetCard.tsx            ← widget container (header + body + error state)
    │   │       ├── WidgetSkeletons.tsx       ← shimmer placeholders while loading
    │   │       ├── Sparkline.tsx             ← compact trend line for KPI cards
    │   │       ├── PremiumTooltip.tsx        ← styled Recharts tooltip
    │   │       ├── AnimatedNumber.tsx        ← counting animation for KPI values
    │   │       └── EmailSchedulePanel.tsx    ← dashboard email report schedules (CRUD + send-now; slotted into settings dropdown)
    │   ├── health/page.tsx           ← data-quality dashboard (split-pane: sidebar + overview/detail pills)
    │   ├── gaps/page.tsx             ← admin: definition gaps + query log tabs (RequireRole)
    │   ├── users/page.tsx            ← admin: team management, invites, roles (RequireRole)
    │   ├── policies/page.tsx        ← admin: data policies (RequireRole)
    │   ├── notebooks/                ← interactive Python notebooks (Pyodide)
    │   │   ├── page.tsx              ← list + create notebook
    │   │   └── [id]/page.tsx         ← editor with cells, schema explorer
    │   └── dev/                      ← internal-only playground (UI, tokens, icons)
    │       └── ui/page.tsx
    │
    ├── components/
    │   ├── Nav.tsx                   ← legacy role-aware nav (kept for non-shell pages)
    │   ├── RequireRole.tsx           ← admin gate wrapper (shows "Restricted" card instead of redirecting)
    │   ├── IngestionWizard.tsx       ← step-by-step data ingestion setup
    │   ├── IntegrationsPanel.tsx     ← integration management UI
    │   ├── JobProgressBanner.tsx     ← (legacy) background job progress (prefer components/ui/JobProgressBanner)
    │   ├── NotificationBell.tsx      ← notification icon + dropdown (used by TopBar)
    │   ├── Pagination.tsx            ← generic pagination component
    │   ├── QualityAlertBanner.tsx    ← data quality issue alerts
    │   ├── QualityPanel.tsx          ← quality profiling dashboard
    │   ├── EmptyState.tsx            ← Observatory empty state (eyebrow/title/description/actions)
    │   ├── SchedulePanel.tsx         ← transformation schedule management
    │   ├── layout/
    │   │   ├── AppShell.tsx          ← Observatory chrome (IconRail + TopBar + ContextPanel + children)
    │   │   ├── AuthLayout.tsx        ← auth-page chrome (login/register/reset)
    │   │   ├── ShellLayout.tsx       ← legacy shell (superseded by AppShell)
    │   │   ├── IconRail.tsx          ← leftmost icon nav (Lucide icons, role-aware)
    │   │   ├── TopBar.tsx            ← header: wordmark + tenant chip + search + notifications + avatar menu
    │   │   ├── ContextPanel.tsx      ← optional left context panel (sits between IconRail and main)
    │   │   ├── CommandPalette.tsx    ← Cmd+K palette (nav + actions)
    │   │   └── PillNav.tsx           ← pill-style tab switcher
    │   ├── topics/
    │   │   ├── TopicLayer.tsx        ← screen 1 — no SQL, no counts, no warehouse vocabulary
    │   │   ├── ManageLayer.tsx       ← screen 2 — mode bar + header + 6 tabs (analyst+)
    │   │   └── ManageTables.tsx      ← Tables tab: measures / shared lookups / "How it's built"
    │   ├── products/
    │   │   ├── StarSchemaFlow.tsx    ← ReactFlow star schema diagram (Observatory palette)
    │   │   └── LineageFlow.tsx       ← ReactFlow data lineage visualization (Observatory palette)
    │   ├── semantic/
    │   │   ├── ApprovalBadge.tsx     ← approval status indicator
    │   │   ├── AuditPanel.tsx        ← audit trail viewer
    │   │   ├── BulkImportModal.tsx   ← bulk definition import
    │   │   ├── DatabaseTree.tsx      ← database schema tree (Observatory light tokens)
    │   │   ├── HistoryPanel.tsx      ← change history tracking
    │   │   ├── KpiPanel.tsx          ← KPI definitions management
    │   │   ├── PathFinderPanel.tsx   ← relationship path finder
    │   │   ├── TableDetailPanel.tsx  ← source-layer table detail panel
    │   │   ├── ProductTableDetailPanel.tsx ← product-layer table detail panel
    │   │   ├── shared.tsx            ← de-duplicated helpers: parseDomains/parseExamples/classifyType/completenessBucket/PreviewTable
    │   │   └── types.ts             ← shared TypeScript types for semantic components
    │   ├── notebooks/
    │   │   ├── SchemaExplorer.tsx    ← left sidebar table/schema tree
    │   │   └── usePyodide.ts         ← Pyodide runtime hook (loads from CDN)
    │   └── ui/                       ← Observatory primitives (preferred callsites)
    │       ├── Toast.tsx             ← <Toast> + <Toaster /> + useToast() hook (module-level dispatch queue)
    │       ├── NotificationBell.tsx  ← (newer variant, dev use)
    │       ├── JobProgressBanner.tsx ← background job progress (Observatory tokens)
    │       └── ChartCard.tsx         ← card wrapper for Recharts embeds
    │
    └── lib/
        ├── api.ts                   ← Axios client; JWT interceptor; 401 → redirect to /
        ├── auth.ts                  ← JWT storage, getTokenPayload, isAdmin, setToken
        ├── cn.ts                    ← classnames helper (clsx + tailwind-merge)
        ├── dates.ts                 ← formatDate/formatDateTime/formatRelative/formatRelativeLong/Short (en-GB)
        ├── sqlProvenance.ts         ← FROM/JOIN extraction for the "How it's built" provenance trail
        ├── observatory.ts           ← JS/SVG mirror of globals.css tokens + SERIES chart palette
        ├── freshness.ts             ← data-freshness helpers (formatRelativeTime, getFreshnessStatus)
        └── hooks/
            └── useDebounce.ts       ← custom debounce hook
```

### Database Migrations (30 files)

```
20260328000001  create_connections
20260328000002  create_source_tables
20260328000003  create_source_columns
20260328000004  create_table_relationships
20260328000005  create_kpi_definitions
20260328000006  create_query_log
20260328000007  create_definition_gaps
20260329000008  create_dashboards
20260329000009  create_cross_views
20260329000010  create_quality_tables
20260329000011  add_business_key_column
20260329000012  add_domains_to_source_tables
20260329000013  add_domains_to_connections
20260330000014  create_semantic_id_seq
20260331000015  add_gap_hit_tracking
20260402000016  add_ingestion_support
20260402000017  create_data_products
20260402000018  create_transformation_checks
20260403000019  create_tenants_and_users
20260403000020  add_tenant_id_and_rls
20260403000021  create_schedules_and_run_history
20260403000022  create_quality_alerts
20260403000023  add_incremental_load_support
20260403000024  add_user_avatar
20260403000025  create_conversations
20260403000026  dashboard_improvements
20260403000027  semantic_layer_improvements
20260403000028  create_notifications
20260404000029  performance_indexes
20260407000030  add_profiling_status
20260421000037  create_email_schedules
20260421000038  add_ai_context_to_quality_alerts
```

---

## AI Architecture — How Claude Is Used

All AI calls go through `backend/src/ai/AIService.ts` — no exceptions.
The model is `claude-sonnet-4-6` for all call types.

### Call Type 1 — Schema Draft (setup phase)
**When:** After a source database is connected and schema is read.
**Purpose:** Generate first-draft definitions for every table and column.
**Also:** `suggestFkMatches()` — Claude validates FK candidate pairs detected by heuristics.
All output stored with `ai_draft: true` until a human confirms.

### Call Type 2 — Natural Language to SQL (every user question)
**When:** A user types any question in the chat interface.
**Two modes:**
- `nlToSql()` — generates SQL for source databases (SQLite/Postgres/MySQL/MSSQL dialect)
- `nlToSqlCross()` — generates cross-source SQL using Neo4j graph context

**Confidence gating:** If confidence < 0.70, SQL is NOT executed. Question logged as a definition gap.

**Repair loop:** If the result looks suspicious, an SSE-streamed repair cycle (max 5 turns) runs diagnostic queries and reconstructs the SQL.

### Call Type 3 — Report Narrative
**When:** A user generates a report with selected KPIs.
**Purpose:** Write a short executive summary tying together KPI results.

### Call Type 4 — Dashboard Generation
**When:** A user creates or refines an AI-generated dashboard.
- `generateDashboardSpec()` — NL → JSON dashboard spec (widgets, filters, SQL)
- `refineDashboard()` — iterates on an existing spec
- `validateDashboard()` — checks widget SQL and data types

### Call Type 5 — Star Schema Design
**When:** Admin designs a data product from source tables.
- `designStarSchema()` — Claude designs fact/dimension tables + transformations
- `generateTransformationSql()` — generates DuckDB SQL for each table

### Call Type 6 — Answer Formatting
**When:** After a query executes successfully.
**Purpose:** Summarize the result in 1–3 plain-language sentences for business users.

---

## Key Workflows

### Source Connection & Profiling (Admin)
1. Admin adds a data source (SQLite file path, or Postgres/MySQL/MSSQL credentials)
2. Connection test validates reachability
3. Schema profiling job queued (BullMQ or inline):
   - Introspects tables, columns, types, sample values
   - Runs quality profiling (null%, distinct%, min/max, histograms)
   - Claude generates draft definitions + FK suggestions
   - Results stored with `ai_draft: true`
4. Admin reviews and confirms definitions in /semantic

### Data Ingestion (Admin)
1. Admin triggers ingestion for selected tables
2. ETL service (Python/FastAPI) reads source data
3. Writes Delta Lake tables (Parquet) to warehouse (local or Azure Blob)
4. Supports full and incremental (watermark-based) load modes

### Star Schema Products (Admin)
1. Admin selects source tables to model
2. Claude designs star schema: fact tables, dimension tables, transformation SQL
3. Admin reviews and adjusts the design
4. Transformation runs via DuckDB — materializes Parquet files
5. Quality gates check BK uniqueness and fan-out
6. Scheduled transformations via cron (BullMQ repeatable jobs)

### Query Flow (All Users)
1. User types a question in the chat interface
2. Backend builds semantic context (source or product layer)
3. Claude generates SQL + confidence score
4. If confidence >= 0.70: SQL executes → Claude formats answer in plain language
5. If confidence < 0.70: clarifying message shown, gap logged silently
6. Repair loop auto-triggers if result looks suspicious
7. "Show query" toggle visible to admin/analyst only

### Dashboard Builder (All Users)
1. User describes desired dashboard in natural language
2. Optional refinement: 3–4 schema-aware clarifying questions with suggestion chips
3. Claude generates dashboard spec (JSON: widgets + filters + SQL)
4. Backend executes widget SQL with filter substitution
5. Frontend renders interactive dashboard (Recharts)
6. Save/favorite/delete per user

### Report Builder (All Users)
1. User selects KPIs + time period
2. KPI SQL queries run in parallel
3. Results rendered as bar charts (Recharts)
4. Claude writes executive summary paragraph

---

## Roles & Permissions

| Feature                          | admin | analyst | viewer |
|---------------------------------|-------|---------|--------|
| Connect / manage data sources    | YES   | NO      | NO     |
| Run schema profiling             | YES   | NO      | NO     |
| Review / confirm definitions     | YES   | NO      | NO     |
| Add / edit KPI definitions       | YES   | NO      | NO     |
| View definition gaps             | YES   | NO      | NO     |
| Manage team (users / invites)    | YES   | NO      | NO     |
| Design star schema products      | YES   | YES     | NO     |
| Manage transformation schedules  | YES   | YES     | NO     |
| Ask questions (chat)             | YES   | YES     | YES    |
| Build and view dashboards        | YES   | YES     | YES    |
| Build and view reports           | YES   | YES     | YES    |
| View full query log              | YES   | YES     | NO     |
| See "show query" SQL toggle      | YES   | YES     | NO     |

---

## Multi-Tenancy

- Every table has a `tenant_id` column (added in migration 20260403000020)
- PostgreSQL Row-Level Security (RLS) enforced via policies
- `requireAuth` middleware sets `app.current_tenant` session variable on every request
- `knex.ts` switches between `databridge_app` role (with RLS) and `databridge` role (for migrations)
- Tenant context flows through to job workers via job data

---

## Dual-write contract (Postgres ↔ Neo4j)

**Status:** Phase 7 of the Neo4j migration (drop Postgres semantic tables) is deferred.
Until then, the system runs a deliberate, scoped dual-write between Neo4j (source of
truth for AI context + traversal queries) and Postgres `source_tables` /
`source_columns` / `table_relationships` (still queried directly by a handful of
aggregate surfaces). This section is the contract — read it before touching any
write to those three tables.

**The rule:**
- All semantic READS go through `db/semanticGraph.ts` (Neo4j-backed). Postgres reads
  of `source_tables` / `source_columns` / `table_relationships` are tolerated only in
  the "aggregate surfaces" list below, and only because rewriting them would require
  Neo4j count helpers we haven't built yet.
- Every WRITE that mutates one of those three tables in Neo4j MUST mirror the same
  change to Postgres in the same request, OR the consuming aggregate must be
  rewritten to read from Neo4j. No exceptions, no "we'll fix it next sprint."
- The `id` is identical on both sides. Routes that create new rows pull an id from
  `semantic_node_id_seq` via `graph.nextPgId()` and insert into Postgres with
  `id = pgId` (using `.onConflict('id').merge()` for safety), then bump the Postgres
  table's own sequence via `setval` so future Postgres-first inserts don't collide.

**Aggregate surfaces that read Postgres directly (the reason the contract exists):**
- `routes/home.ts` — Home health-score COUNTs of tables/columns/relationships and
  pending-review queues.
- `routes/quality.ts` — source-table quality dashboard joins.
- `routes/products.ts` — FK derivation in product-design flows joins
  `table_relationships`.
- `routes/query.ts` — relationship lookup for cross-source NL→SQL.
- `routes/notebooks.ts` — schema explorer.

**Mirrored write surfaces today:**
- `POST /api/relationships/:id/flag` — mirrors ONLY the boolean `flagged` onto
  the `RELATES_TO` edge, so `getRelationshipsForContext` can filter flagged
  links out of AI context inside its own `MATCH`. The reason text is
  Postgres-only. Best-effort: an unreachable graph must not stop someone
  recording a problem.
- `SchemaProfiler.ts` — Postgres-first (gets auto-increment id), then Neo4j with
  that id as `pgId`. The original pattern; sets the id-alignment invariant.
- `PATCH /semantic/tables/:id` — mirrors confirm/edit to `source_tables`.
- `PATCH /semantic/columns/:id` — mirrors confirm/edit to `source_columns`.
- `PATCH /semantic/relationships/:id` — mirrors confirm/edit to `table_relationships`.
- `POST /semantic/relationships` — mirrors create with explicit `id = pgId`.
- `DELETE /semantic/relationships/:id` — mirrors delete.
- `POST /semantic/relationships/re-suggest` — mirrors the bulk wipe of AI drafts +
  bulk insert.

**Known un-mirrored writes (latent bugs of the same class — fix when a user reports):**
- `POST /semantic/revert` — revert-to-version writes Neo4j only.
- `POST /semantic/approve` — generic approval flow writes Neo4j only.
- `POST /semantic/import` — bulk CSV import writes Neo4j only.

**MANDATORY: Neo4j has NO tenant scoping — gate every request-supplied id.**
`db/semanticGraph.ts` matches nodes and edges by their globally-unique `pgId`
(or `connectionId`) with **no tenant predicate anywhere** — 90+ `MATCH` clauses,
zero tenant references. Postgres RLS protects the mirror rows but not the graph,
so any route that hands a request-supplied id to a `graph.*` call reaches
whichever tenant owns that id, and ids come from a shared sequence (trivially
enumerable). A 2026-07-28 audit found this live on ~30 endpoints across
`routes/semantic.ts`, `routes/catalog.ts` and `routes/cross-views.ts`, including
`GET /semantic/columns?tableId=` returning another tenant's column catalog to any
authenticated user, and `DELETE /semantic/relationships/:id` deleting another
tenant's relationship.

The rule, no exceptions: **before an id from a path param, query string or body
reaches a `graph.*` call, authorise it with `owns()` / `ownedIds()` from
`db/tenantOwnership.ts`** (in routes: the local `denyUnlessOwned` helpers).
Those match `tenant_id` EXPLICITLY rather than relying on RLS, because `reqDb()`
falls back to the global pool whose session-level `SET app.current_tenant` has a
documented race — an authorisation check must not depend on which side of that
race it lands. Refuse with **404, never 403**: a 403 confirms the id exists and
belongs to someone else.

Two things this does not cover, both tracked: entities that exist ONLY in the
graph (pre-dual-write relationships) authorise via
`graph.getRelationshipConnectionId()` → the owning connection; and the real fix
is putting `tenantId` on the nodes and into the Cypher, which retires this rule.

**If you add a new write to any of those three tables, you have two options:**
1. Mirror it (preferred — follow the pattern in `PATCH /semantic/tables/:id`).
2. Rewrite the relevant aggregate read in `routes/home.ts` etc. to use a Neo4j
   count helper. This is the long-term fix and the path to retiring this contract.

**When can we drop this?** When every entry in "Aggregate surfaces that read Postgres
directly" has been migrated to Neo4j. At that point the Postgres tables become
write-side-only legacy and we can finish Phase 7.

---

## Error Handling Rules

- All connector errors must return a user-friendly message. Never expose file paths,
  SQL errors, or stack traces to the frontend.
- All AI call failures must be caught and logged server-side. Return a graceful
  fallback message to the user: "Something went wrong. Please try again."
- Definition gaps must be silently logged without alarming the client user.
  Return: "I don't have enough context to answer that confidently yet.
  This question has been noted for review."
- Never let a raw SQL error reach the frontend under any circumstances.
- Rate limiting: 200 req/min global, 20 req/min auth endpoints, 30 req/min AI-intensive.

---

## Environment Variables (.env.example)

```bash
# Backend
PORT=3001
NODE_ENV=development

# Semantic layer DB — PostgreSQL running in Docker
DATABASE_URL=postgresql://databridge:databridge@localhost:5432/databridge

# JWT auth
JWT_SECRET=change_me_in_production
JWT_EXPIRES_IN=8h

# Claude API (get key from console.anthropic.com)
ANTHROPIC_API_KEY=your_key_here
CLAUDE_MODEL=claude-sonnet-4-6

# SQLite source database (optional — for local sample data)
SQLITE_DB_PATH=./data/sample.db

# Neo4j — semantic knowledge graph (runs in Docker alongside Postgres)
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=databridge_secret
NEO4J_DATABASE=neo4j

# Credential encryption key (32-byte hex string for AES-256-GCM)
CREDENTIALS_ENCRYPTION_KEY=generate_a_32_byte_hex_key_here

# ETL service URL (Python FastAPI, runs in Docker)
ETL_URL=http://localhost:8000

# CORS — allowed frontend origins
CORS_ORIGINS=http://localhost:3000

# Redis — optional; enables BullMQ job queues + caching
# If not set, jobs execute inline (synchronous)
REDIS_URL=redis://localhost:6379

# SMTP — Scheduled email reports (Sprint 2.1)
# Leave SMTP_HOST blank to disable email sending (no-op in dev)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Clarion <noreply@yourdomain.com>

# Storage format for product tables. Delta Lake + Python sidecar is the
# DEFAULT — production images bake Python + deltalake in. Set
# STORAGE_FORMAT=parquet to opt out (e.g. local dev without Python deps).
STORAGE_FORMAT=

# Python interpreter the SCD1/SCD2 sidecar runs under. Defaults to `python3`.
PYTHON_BIN=

# Override sidecar script path. Defaults to <repo>/etl/scd2/commit_table.py.
SCD2_SIDECAR_PATH=

# Azure (optional — only needed for production / Azure deployment)
# AZURE_STORAGE_CONNECTION_STRING=
# AZURE_KEY_VAULT_URL=
# APPLICATIONINSIGHTS_CONNECTION_STRING=
```

---

## Docker Services

### Development (`docker-compose.yml`)
| Service    | Image              | Port(s)          | Purpose                         |
|------------|--------------------|-----------------|---------------------------------|
| postgres   | postgres:16-alpine | 5432            | Semantic layer DB               |
| neo4j      | neo4j:5-community  | 7474, 7687      | Knowledge graph                 |
| etl        | ./etl (Dockerfile) | 8000            | Python ETL service              |

### Production (`docker-compose.production.yml`)
Adds:
| Service    | Image              | Port(s)          | Purpose                         |
|------------|--------------------|-----------------|---------------------------------|
| redis      | redis:7-alpine     | 6379            | Job queues + caching            |
| backend    | ./backend          | 3001            | Express API                     |
| frontend   | ./frontend         | 3000            | Next.js UI                      |

---

## CI/CD

### GitHub Actions Workflows
- **test.yml** — runs on PR + push to main: Vitest tests against PostgreSQL service container, security audits
- **deploy.yml** — runs on push to main/staging: builds Docker images → pushes to ACR → deploys to Azure Container Apps → runs migrations
- **dependabot.yml** — weekly dependency updates for backend, frontend, GitHub Actions

### Azure Production Architecture
- PostgreSQL Flexible Server (always-on, B_Standard_B1ms)
- 4 Container Apps: Neo4j (min=1), ETL (scale-to-zero), Backend (0–3 replicas), Frontend (0–3 replicas)
- Azure Blob Storage for data warehouse
- Azure Key Vault for secrets
- Application Insights + Log Analytics for monitoring
- ACR (Azure Container Registry) for Docker images
- Estimated cost: ~30 EUR/month idle, ~50-60 EUR/month active

---

## Session Closing Prompt
> Copy and paste this at the end of every Claude Code session.

```
We are done for this session. Before we close:

1. Update the Current State section in CLAUDE.md:
   - Set "Last updated" to today's date
   - List every file that now exists on disk under "Files that exist on disk"
   - Note any known issues or blockers we discovered
   - Set "Next session should start with" if there is pending work

2. If the folder structure changed, update the Folder Structure section to match
   what is actually on disk right now.

3. If any architectural decision changed from what was planned, update the
   relevant section and add a short note explaining why it changed.

Do not summarise what you did in chat — write everything directly into CLAUDE.md.
```

---

*Last updated: April 2026 — Clarion v0.2*

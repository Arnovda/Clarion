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

**When Current State passes ~12 entries:**
- Move the oldest ones to `docs/history/current-state-archive.md`, VERBATIM —
  never summarise them, and never delete them. The lessons in old entries are
  the most valuable thing in this repository.
- The rule exists because this file reached 6,700 lines and 56 entries, at which
  point "read this entire file at the start of every session" stopped being
  something anyone could actually do. A rule nobody can follow is not a rule.

**Never restore a hand-kept list of files.** The migrations list here rotted at
30 while the directory grew to 87, and the Folder Structure tree drifted too.
Where a directory listing answers the question, point at the directory.

**When the folder structure changes:**
- Update the Folder Structure section to match what is actually on disk
- If a file moved, update every reference to it in this document
- If a file was deleted, remove it from the structure

This document must always reflect reality. If it does not, the next session starts
with false assumptions and produces broken code.

---

## Current State
> Updated by Claude Code at the end of every session. Shows what actually exists now.

**Last updated:** 2026-09-01 (P0-1 REMEDIATION, CODE HALF — `auth_lookup` is a
migration at last, CI logs in as `databridge_app`, and the preflight reads
policy PREDICATES instead of counting rows in `pg_policy`)

**First PR of the market-readiness remediation plan (wave 1, item 1). One
finding, three controls, each proven to fail before it shipped:**
- **NEW MIGRATION 88 (`20260901000088_auth_lookup_policies.ts`)** — the
  `auth_lookup` FOR SELECT policy (`USING (NULLIF(current_setting(
  'app.current_tenant', true), '') IS NULL)`) on the five unauthenticated-path
  tables: `users`, `refresh_tokens`, `webauthn_credentials`,
  `mfa_backup_codes`, `oauth_pending` — verbatim the shape
  `prod-fix-missing-policies.ts` applied by hand, DROP-then-CREATE so a
  production database where that script already ran migrates cleanly.
  **Reproduced before fixing**: on a migration-only database, a real user row
  read as **0 rows** under `databridge_app` with empty tenant context; with
  the migration, 1. `down` drops the carve-outs (a true inverse).
- **`oauth_pending` needed two repairs FIRST, in the same migration**: its
  RLS was conditional on `databridge_app` existing at migration time, and its
  policy predicate was the pre-NULLIF shape
  `current_setting('app.current_tenant')::integer`, which THROWS under empty
  or unset context. Permissive policies OR into one qual with no guaranteed
  evaluation order, so adding `auth_lookup` beside it could have made the very
  SELECT it permits error instead. Now: unconditional ENABLE+FORCE and the
  canonical `tenant_isolation`.
- **NEW `e2e/auth-login.spec.ts`**, wired into test.yml's `rls-isolation` job
  (the one environment where the backend runs as `databridge_app` against a
  migration-only database): register → **LOGIN** (the call `rls.spec.ts` never
  makes) → `/auth/me` with the issued token → wrong-password 401 → refresh
  exchange → duplicate-email register **409** (the check that always said
  "free" under P0-1 — this doubles as the P0-5 duplicate-defect regression
  test). Verified red against the pre-migration schema: login returned 401
  with the correct password, exactly the production signature.
- **`preflight-role-flip.ts` asserts policy IDENTITY now** — for every
  RLS-enabled tenant table, an ALL-command policy whose USING **and** WITH
  CHECK actually compare `tenant_id` to `app.current_tenant` (matched on the
  predicate, not the name — `oauth_pending_tenant` and
  `refresh_tokens_tenant_isolation` are legitimate); for the five auth tables,
  a permissive FOR SELECT carve-out that references `app.current_tenant`,
  `IS NULL`, and NOT `tenant_id`. Against the pre-migration database — where
  the old count check reported GO with "71/71 with a policy" — it now reports
  **NO-GO with 5 named blockers**; post-migration, GO with `auth_lookup
  verified 5/5`.
- **The two halves of P0-1 are deliberately not conflated**: this migration is
  correct whatever production turns out to be. The production `pg_policy` /
  `rolbypassrls` query (owed to the owner, SQL prepared) answers a DIFFERENT
  question — whether live login is broken today or RLS is inert — and changes
  operations, not this schema.
- Validation: defect reproduced at SQL level and end-to-end, then the same
  checks green; backend `npm run check` clean; full vitest suite green;
  all eight ratchets green from the repo root with per-ratchet exit codes;
  `e2e/rls.spec.ts` 4/4 and `e2e/auth-login.spec.ts` 4/4 against a live
  backend running as `databridge_app`; frontend `tsc` clean and `next build`
  green (no frontend files touched).
- **NOT in this PR, deliberately**: email verification, default AI budget and
  slug collision handling (P0-5 — next wave-1 items after P0-2), and any
  change to production (P0-1's second half is a read-only query the owner
  runs).

**Prior last updated:** 2026-09-01 (MARKET READINESS ASSESSMENT — doc only, no code
changed; the platform around the product is what is unfinished)

**Owner: *"I want to bring Clarion to the market. What is still missing? What do
I miss for multiple customers? Is this platform complete in all functional and
non-functional aspects?"* Full audit against a seven-plane multi-tenant SaaS
model, verified from code/migrations/workflows/Terraform rather than from these
notes. NEW DOC: `docs/backlog/market-readiness-assessment.md`. Artifact:
"Clarion Launch Preflight".**
- **VERDICT: no-go for paid onboarding.** The data engine is ahead of where a
  platform this young usually is; almost every gap sits AROUND it — the layer
  that proves isolation, the layer that takes money, the layer that says
  production is broken, and the paperwork that makes processing a customer's
  accounting data lawful. 6 P0 / 7 P1 / 5 P2.
- **P0-1 — `auth_lookup` EXISTS IN NO MIGRATION, and this is now measured, not
  suspected.** The only thing that creates it is `backend/scripts/prod-fix-
  missing-policies.ts`, which NO workflow and NO `.ops` control invokes. A
  migration-only database gives `users` just `tenant_isolation`, whose predicate
  under empty tenant context is `tenant_id = NULL` — zero rows. Under
  `databridge_app` login/forgot-password/refresh/WebAuthn can only fail. **Three
  controls all miss it and each for its own reason**: `e2e/rls.spec.ts` uses the
  token `/register` RETURNS and never calls `/auth/login`; `auth.test.ts` does
  test login but connects as the superuser, so RLS is inert; and
  `preflight-role-flip.ts` asserts each table has ≥1 policy — `users` has one, so
  it reports GO. **A preflight that counts policies cannot notice the wrong one.**
- **P0-2 — the graph's tenant scoping is still 1 of 3 steps done.** Measured:
  **0 tenant predicates across 90 `MATCH` clauses**; `.ops/graph-backfill` is
  still `report`. Isolation rests on ~30 handlers each remembering a gate, which
  has already failed once (the 2026-07-28 `/semantic/columns` leak).
  `routes/catalog.ts:242` still calls the scope-free `getProductTree()` — read
  only for counts of owned ids today, so latent rather than live.
- **P0-3 — no commercial layer at all** (no plan/subscription/entitlement/
  payment/trial/dunning). The METERING half is real though: `ai_usage` +
  enforced `monthly_token_budget` is a usable base for usage pricing, so this is
  a build-on, not a build-from-zero.
- **P0-4 — no ToS, privacy policy, DPA or subprocessor list.** GDPR Art. 28
  wants the contract BEFORE processing; the real subprocessors are Azure,
  Anthropic, ACS. The engineering is ahead of the paperwork — EU residency,
  `services/retention.ts`, `audit_events`, and a working `purgeTenant` all exist.
- **P0-5 — open registration + `monthly_token_budget = NULL` (unlimited).** No
  email verification. Two defects in the same handler: the duplicate-email check
  goes through `unauthQuery` so under P0-1 it ALWAYS says the address is free
  (and login's `.first()` is then non-deterministic), and the slug is derived
  into a UNIQUE column with no collision handling — **the second customer called
  "Acme" 500s on signup**.
- **P0-6 — still no alerting, and `/api/health` probes POSTGRES ONLY** while
  deploy auto-promotes on it. A revision with Redis/Neo4j/worker dead reports
  `200 ok` and takes 100% traffic. The gap CLAUDE.md has called "the next
  fundamental" since 2026-08-29, now compounded by automatic promotion.
- **P1 highlights**: `schema-profiling` and `bus-matrix` both run
  `concurrency: 1` GLOBALLY and the worker is pinned to one replica (the reapers
  have no owner/heartbeat) — **one tenant's build blocks every other tenant's**;
  rate limits are per-IP, in-memory, per-replica, so every published limit is
  ~3× and brute-force is ~15/15min; `requireAuth` re-checks only the JWT
  signature, so **suspension takes up to 8h to bite**; Postgres has no HA, Redis
  no persistence, and Neo4j **no backup at all** (14-day PITR on Postgres vs a
  5 GiB file share holding the semantic layer); no per-tenant observability; and
  `ignoreBuildErrors` + a deploy gate that never type-checks the frontend, which
  has **zero tests**.
- **P2**: no i18n in a NL/FR market; `/onboarding` referenced from NOWHERE so
  register lands on a cold `/sources`; `routes/query.ts` still single-
  `connectionId` so the cross-system demo cannot be given; no status page or
  support channel; MFA is per-user and cannot be required org-wide.
- **Remediation is three waves with exit gates**, sequenced by dependency, not
  preference: W1 *prove it is safe and make it lawful* (~3-4wk), W2 *be able to
  charge and to operate* (~5-7wk), W3 *sell it into this market* (~4-6wk). Full
  task list in the doc.
- **TWO THINGS THIS ASSESSMENT COULD NOT ESTABLISH, both one production query
  away and both owed before W1 closes**: the live database's actual `pg_policy` /
  `rolbypassrls` state (P0-1 is unresolvable without it — either login is broken
  or RLS is inert, and a 401 looks identical either way), and whether per-tenant
  warehouse containers have taken any writes since the 2026-07-26 flip (last
  measured: 0).

**Prior last updated:** 2026-09-01 (YOUR OWN FILTERS, REMEMBERED — plus the provenance
SQL is readable at last)

**Owner, two asks off one screenshot: *"Format the SQL"* in the provenance panel,
and *"be able to save a specific state of a report so next time their filters are
already applied. This is per person. If someone else saves it, you don't see
that."***
- **THE FORMATTER ALREADY EXISTED AND THE PANEL DID NOT USE IT.** `sql-formatter`
  has been a dependency for months and `app/query/utils.ts` wrapped it properly
  (duckdb dialect, upper keywords, try/catch). There were **FOUR** treatments of
  the same problem: that good one; a naive regex in `gaps/page.tsx` that inserted
  a newline before every keyword — **including keywords inside string literals**,
  which corrupts the query on screen; a bare `format()` in
  `ProductTableDetailPanel` with **no guard, so unparseable SQL throws inside a
  render**; and the provenance panel, which did nothing at all. All four now go
  through **`lib/formatSql.ts`**.
- **`whitespace-pre-wrap` → `whitespace-pre` + horizontal scroll** in the panel.
  Once a query is indented, wrapping a long line re-flows it under the wrong
  indent level and undoes the formatting. Verified against the owner's actual
  widget SQL: 1 line → **43 lines, longest 79 chars, all 8 `{{placeholders}}`
  intact**, CTEs reading properly.
- **NEW `dashboard_user_views` (migration 87) — a private lens on a shared
  dashboard.** One row per (dashboard, user); `filter_values` jsonb; canonical
  RLS dance. `GET|PUT|DELETE /dashboards/:id/my-view`. Opening a dashboard
  restores your own filters, on any device.
- **SERVER-SIDE, NOT localStorage, deliberately**: "next time they look at the
  dashboard" means from any device, and browser storage would lose the view on a
  new laptop while appearing to work on the old one.
- **Only filter VALUES are stored.** Layout, widget set and titles belong to the
  dashboard and are shared by definition; a per-user copy of those forks the
  artefact rather than filtering it.
- **Restored through `carryFilterValues`, not applied raw** — the spec can have
  changed since the view was saved, so a filter that is gone must not linger and
  one that was added takes its default. Third caller of that already-tested
  helper.
- **THE PER-USER HALF IS NOT ENFORCED BY RLS AND THAT IS THE THING TO KNOW.** The
  policy isolates TENANTS; "only you see your view" is an explicit `user_id`
  filter on every query. Hence the test that a colleague **in the same tenant**
  saving their own view leaves yours untouched — RLS cannot catch that one.
- **A REAL ISOLATION GAP THE TESTS CAUGHT BEFORE IT SHIPPED**: the first
  visibility query leant on RLS alone, and a request from ANOTHER TENANT read a
  shared dashboard (200 instead of 404). `findVisibleDashboard` filters
  `tenant_id` EXPLICITLY now, per the house rule that an authorization decision
  must never depend on the session variable. **Note the pre-existing
  `GET /dashboards/:id` has the same shape** — protected in production by RLS
  since the role flip, but worth the same treatment on a future pass.
- **THE RENDER CHECK CHANGED THE DESIGN, not just a colour.** First version showed
  a chip plus *Update my view* plus *Reset* whenever a view existed — three
  controls that **wrapped onto a second row of the filter bar**, permanently, on
  the screen whose whole job is charts. Now *Save/Update* appears only when the
  filters have actually MOVED from what was saved (compared over the union of
  both key sets, so an added filter counts as a change). The steady state is a
  chip and *Reset*, inline, no extra row — and a button that cannot change
  anything is never shown.
- Validation: backend **50 files / 510 passed** (10 new in
  `dashboard-my-view.test.ts`), all eight ratchets green — validate-coverage
  caught the unvalidated DELETE and it now carries a params-only schema, the same
  catch the managed-grids work hit — frontend `tsc` + lint clean, `next build`
  green 40/40. Four filter-bar states screenshotted in real Chromium, then the
  harness deleted.
- **NOT done, deliberately**: cross-filter state and the Arrange layout are not
  saved — the first is a transient drill, the second is the dashboard's own
  shape. And a saved view is not shareable as a link; that is a different
  feature (a URL), not this one.

**Prior last updated:** 2026-09-01 (THE BUSINESS KEY COMES FROM THE SOURCE NOW — a
`Created` timestamp was identifying bank statement lines)

**Owner, from the Quality tab on ExactOnline's `BankEntryLines`: *"the business
key is proposed as Created, while that obviously can't be right… I think it just
identifies the first column with 100% uniqueness. Include it in the source system
list like ExactOnline where we already describe the relations?"* Right about the
symptom, right about the fix — and the fix was already half-built.**
- **THE OLD RULE WAS ONE LINE**: `fields.reduce((best, f) => f.distinct_pct >
  best.distinct_pct ? f : best, fields[0])` — highest uniqueness wins, and
  because `>` is strict, **ties go to whichever column came first**. On an
  append-only table `ID`, `Created` and `Modified` are all 100% unique, so field
  order decided it. **No AI was involved at any point** (the owner assumed there
  was); it is measured stats and a tie-break.
- **THE HARM IS NOT THE LABEL, IT IS THE SCORE.** BK Completeness and BK
  Uniqueness are computed FROM the key column, so both read 100% while measuring
  a timestamp — a timestamp is trivially complete and trivially unique. **A wrong
  key does not look like a broken table, it looks like a perfect one.**
- **THE DECLARATION ALREADY EXISTED AND NOTHING READ IT.**
  `EntityDescriptor.businessKey` has been in the connector contract since the
  framework was built, the warehouse writer merges rows on it every sync, and
  conformance already enforces `incrementalCursor ⇒ businessKey`.
  **`BankEntryLines` declares `businessKey: 'ID'`.** 55 of 61 EO entities declare
  one (the six that do not are the report-shaped endpoints); Odoo declares `id`
  for all 21. The quality profiler was simply the one consumer that never asked.
  So this is not a new list — it is wiring the list that exists, which is exactly
  the `declared > curated > ai` ladder `SOURCE_ONBOARDING.md` already states.
- **NEW `getBusinessKeys()` on `SourceConnector`**, deliberately the same shape
  as `getKnownRelationships`: SYNCHRONOUS and network-free, because it is a
  compile-time constant and a live-metadata failure must never be able to cost
  us it. Both connectors implement it in one line over the shared
  **`businessKeysFromCatalog`** (new `packages/connectors/src/businessKeys.ts`).
  An entity with no declared key is OMITTED, never returned blank — "the source
  does not say" and "the source says none" must stay distinguishable.
- **Precedence is now `user's own pick > the source's declaration > a name-shape
  guess > nothing`**, resolved by the CALLER (`declaredBusinessKeys.ts`) and
  passed in as the existing `overrideBkColumn`, so the profiler needed no new
  parameter. Matching is case-insensitive: a declaration says `ID`, a parquet
  header may say `Id`, and a key that fails to match its own column is the exact
  failure being removed.
- **THE FALLBACK NO LONGER GUESSES WILDLY, AND REFUSES WHEN IT CANNOT TELL.**
  New pure exported `chooseBusinessKey(fields, tableName)`: a candidate must be
  100% distinct AND 0% null AND not a date/time/bool/float, and must be
  key-SHAPED (`id`, `<table>id`, `code`, `number`, `guid`, `*_id`…). Ranked
  best-shape → shortest → alphabetical, so the same data always yields the same
  answer. **Nothing key-shaped ⇒ null, and null scores** — because an unmeasured
  table must not render as a perfect one. `overall/completeness/uniqueness` are
  now `number | null`; every consumer already handled null
  (`checkAndCreateAlerts` returns early on it, home.ts filters it out), so
  nothing else had to change.
- **A SECOND BUG FOUND WHILE FIXING THE FIRST: an Analyse threw away the
  curator's business key.** The profiler's persist step is wipe-and-reinsert and
  never carried `business_key_column`, so a hand-picked key survived until the
  next Analyse and then silently reverted to a guess. It is read before the wipe
  and written back now — and the Analyse-time quality pass, which passed NO key
  at all, now gets `user ?? declared` like the standalone route.
- **The screen names its authority instead of saying AUTO-DETECTED for
  everything**: *From Exact Online* / *Guessed from your data* / *Set by you* /
  *none established*, with a sentence explaining which. Derived from
  `declared_bk` (new on the settings endpoint) versus what the profile used —
  **no migration and no new stored column**, because the distinction was already
  implied by data we hold. `CONNECTOR_LABELS` moved from `sources/page.tsx` to
  `lib/connectorIcons.tsx` so the second consumer imports it rather than copying.
- **Conformance gained `validateBusinessKeyExposure`**: a catalog that declares
  keys must EXPOSE them. Verified to fail — renaming EO's accessor turns the
  suite red. Without it a new connector silently sends every table back to
  guessing, and nothing errors.
- Validation: backend **49 files / 500 passed** (14 new in `businessKey.test.ts`,
  10 of which were confirmed to go RED against the old rule), connectors **231
  passed** (8 new), all eight ratchets green, frontend `tsc` + `next build` green
  40/40, new/changed files lint-clean (the four in `sources/page.tsx` are the
  documented pre-existing ones). The provenance derivation was dry-run over its
  nine states in real Node. **NOT render-checked** — unlike the notebook panel
  this adds no new component or layout, only a chip and copy inside an existing
  card.
- **TAKES EFFECT ON THE NEXT ANALYSE OR PROFILE RUN.** Existing
  `dataset_profiles` rows keep their old key until the table is re-profiled;
  clicking **Run profile** on one table is enough to see it change.
- **NOT done, deliberately**: direct-database sources (Postgres/MySQL/SQL Server/
  SQLite) still get the heuristic — their real primary key IS knowable by
  introspection and is not plumbed into the profiler. That is the obvious next
  slice, and it is why the fallback refuses rather than guesses.

**Prior last updated:** 2026-09-01 (STOP MEANS STOP — a running question is cancellable
everywhere, and the notebook gets the dashboard's assistant)

**Owner: *"Be able to cancel a question if the AI is running"* and *"Have the same
style of box for the AI in the notebook section (to write code) as in the dashboard
session (right bottom corner and expandable)."* Two asks, one shared piece of
plumbing underneath.**
- **CANCEL WAS NOT EXPRESSIBLE ANYWHERE.** Every AI surface had an
  `AbortController` already — and every one of them was aborted ONLY on unmount.
  There was no control that said stop, so the answer to "I asked the wrong thing"
  was to sit and wait for it. Now: **Ask AI** (the primary button becomes Stop
  while a question runs, plus a Stop under the live timeline and Escape in the
  box), the **dashboard assistant**, and the new **notebook assistant**.
- **THE INTERESTING HALF IS THAT STOPPING NOW STOPS THE WORK, NOT THE WATCHING.**
  Aborting the client stream only ever stopped the browser listening: the
  Anthropic stream ran to completion and the tenant paid for an answer nobody
  would see. New **`utils/requestAbort.clientAbort(res)`** turns a client
  disconnect into an `AbortSignal`; `startSSE` exposes it as **`sse.signal`**;
  `generateSqlStreaming` and `callClaudeMultiTurn` accept it and hand it to the
  SDK. `/query/think` and `/query/repair` pass it, and also BAIL before running
  the warehouse query and the answer-formatting call when the asker is already
  gone. Bus-matrix's hand-rolled abort wiring collapsed into the same shared
  `attachAbort` helper.
- **THE ONE SUBTLETY, and it is the whole reason `settle()` exists**:
  `res.on('close')` fires on a NORMAL completion too. Aborting there would cancel
  the tail of a request that already succeeded — persisting the answer, usage
  accounting, audit rows. So the route settles the abort when it finishes and a
  later close is a no-op. Two of the four new tests pin exactly that direction,
  and both were **verified to go red** when the guard is removed.
- **NEW `frontend/app/notebooks/[id]/NotebookAssistant.tsx` — the dashboard's
  panel, doing the notebook's job.** Same floating bottom-right box, same
  collapsed pill that keeps reporting while closed, same "only the newest
  exchange is expanded" rule, same elapsed counter. What differs is the job: it
  writes CODE into a specific cell, so the dashboard's *scope* chip is here a
  **TARGET** chip naming the cell about to be written — code landing in a cell
  you were not looking at is the one outcome nobody catches by eye. Modes are
  **This cell** / **New cell** (+ a SQL/Python pick for a new one); answers carry
  the code with *Insert again* and *Copy*.
- **THE PER-CELL AI PROMPT BAR IS DELETED and the cell's AI button now AIMS the
  panel at that cell** — the wand pattern the dashboard already uses on widgets.
  Two doors to the same generator, each with its own history, is how the two
  quietly drift apart. The cell keeps the prompt that produced its code as
  provenance; that state moved to the page.
- **`POST /notebooks/generate` gained `history`** (≤12 turns) so "now group that
  by month" edits the code the assistant just wrote instead of guessing from the
  prompt alone — and gained **Zod validation**, which it never had: an
  unvalidated AI route bills the tenant for garbage. **validate-coverage ratchet
  lowered 160 → 159.**
- **A cancelled run is never a red card and never costs what you typed.** On both
  new Stop paths the request goes back into the composer, the working bubble is
  dropped (notebook) or marked *Stopped* with its half-run steps reset to
  pending (dashboard), and `AbortError` is swallowed instead of being rendered as
  a failure. A new cell is created only once there is code to put in it, so a
  cancelled "new cell" request leaves no empty cell behind.
- Validation: backend **48 files / 486 passed** (8 new in `cancellation.test.ts`),
  all eight ratchets green from the repo root, frontend `tsc` clean, new/changed
  files lint-clean (the four findings in `notebooks/[id]/page.tsx` are
  pre-existing — verified by re-running the linter against `HEAD`), `next build`
  green 40/40 (`/notebooks/[id]` 8.4 → 16.9 kB), diff engine dry-run 20/20 in
  real Node. Both the panel and the diff were checked by RENDERING them: a
  throwaway `/dev/notebook-ai` harness screenshotted in real Chromium (mid-run,
  idle-new-cell, collapsed pill; then a real SQL edit, a folded 30-line cell, a
  brand-new cell, and the panel's kept/waiting history), then deleted. That
  check is what caught the green pending bubble and a duplicated instruction.
- **THE AI NO LONGER WRITES A CELL — IT PROPOSES ONE (same day, owner: *"show
  what will be deleted from the code and what will be added, then the user can
  accept or reject… check the new logic and if it's not right reject it and keep
  his old code"* — the Databricks pattern).** The first version overwrote the
  cell and offered *Insert again*, which is not the same thing at all: once the
  old code is gone, "keep my old code" is an undo the product does not have.
  Now a generated answer lands as a **pending proposal** on the target cell,
  rendered as a diff with **Keep** / **Discard**, and nothing is written until
  Keep.
- **NEW `frontend/app/notebooks/[id]/diff.ts`** — a classic LCS line diff, pure
  and dependency-free (the same house call as the hand-rolled xlsx reader).
  **Minimality is the whole point**: a naive implementation renders a one-line
  edit as "everything removed, everything added", which tells the reviewer
  nothing. Verified by DRY-RUN in real Node over 20 cases — identical text,
  single-line edit, pure insert, pure delete, empty either side, reordering,
  and two the eye would miss: **a trailing newline is not a line** and **CRLF vs
  LF is not a change**, both of which would otherwise show a phantom diff.
  `collapseUnchanged` folds long untouched runs to `⋯ N unchanged lines` (click
  to expand) so a one-line edit in a 200-line query is not 199 lines from the
  change. Above 2,000 lines it degrades honestly to block replacement rather
  than building a four-million-cell table.
- **NEW `CellDiff.tsx` renders IN THE CELL, not in the panel.** The panel is
  440px and code needs width — but the real reason is that "is this logic
  right?" is a question about the cell, and it is easiest to answer where the
  code will live. Old and new line numbers side by side, `+`/`−` gutter,
  green/red rows, `whitespace-pre-wrap` so a long SQL line cannot hide off the
  right edge unreviewed. The decision bar LEADS so a long diff never pushes the
  buttons below the fold.
- **Three rules that make reject mean what it says.** (a) The editor is
  REPLACED by the diff while a decision is pending — two editable versions of
  one cell is a state nobody can reason about. (b) **Run and Run All refuse a
  cell with a pending suggestion**: the cell still holds the OLD code, so
  running it would attribute an old result to the new logic. (c) The reject
  baseline is the user's OWN code, carried across a chain of follow-ups, so
  discarding the third suggestion restores what the user wrote — not the first
  suggestion's output. A proposal that CREATED its cell deletes it on discard.
- **The outcome comes back to the panel**: messages carry
  `decision: pending | accepted | rejected | superseded`, so the history reads
  *Waiting for you* / *Kept* / *Discarded* instead of implying every suggestion
  was applied. **A pending decision is deliberately NOT green** — the render
  check caught it rendering in the success colour, which says "done" about the
  one thing that is not.
- **NOT done, deliberately**: the collapsed pill has no stop of its own (a button
  inside a button is invalid; open it, then stop). The dashboard assistant is
  NOT given a diff — it edits a spec, not code the user wrote, and it already
  has the equivalent (unsaved state + Discard). Neither Stop path nor the
  proposal flow has been exercised against a live AI backend — watch the first
  real cancel, since that is where `sse.signal` reaches the Anthropic stream for
  the first time.

**Prior last updated:** 2026-09-01 (REPO CLEANUP — dead code deleted, and CLAUDE.md
made readable again)

**Owner: *"Kan je de repo wat opkuisen? Bestanden of teksten die outdated zijn,
code die niet meer gebruikt wordt, claude.md die misschien niet up-to-date is."***
Everything below was verified before deletion — no file was removed on a hunch.
Frontend `tsc` clean, backend `tsc` clean, all eight ratchets green, `next build`
green.

- **12 SOURCE FILES DELETED, EVERY ONE WITH ZERO IMPORTERS** (~3,300 lines).
  `IntegrationsPanel` (1,024 lines — CLAUDE.md's own drift watchlist had named it
  as orphaned since the 2026-07-15 assessment and it was still here),
  `PathFinderPanel`, `DatabaseTree` (its only remaining mention was a COMMENT
  inside IntegrationsPanel — dead code kept alive by a reference in other dead
  code), `BulkImportModal`, `KpiPanel` (the KPIs tab left `/semantic` in April),
  `AuditPanel`, `SchedulePanel`, the legacy `components/JobProgressBanner`
  (superseded by the `ui/` one), `ui/PageHeader`, `layout/PageWrapper`,
  `dashboards/components/DashboardHeader`, and `backend/src/utils/secrets.ts`.
  Method: import-graph sweep, then a per-name grep to confirm, because the sweep
  alone produces false positives for anything loaded dynamically.
- **Three stale artefacts**: `start-backend-now.bat` (hardcoded to
  `C:\Users\vandarn\Documents\databridge` — one person's machine, under the
  pre-rename directory), `test-results/.last-run.json` (a Playwright run artefact
  committed by accident; `test-results/` and `playwright-report/` are gitignored
  now), and `DataBridge_Architecture.pdf` (a generated file carrying the retired
  brand name; regenerate from `Clarion_Architecture.py` if it is wanted).
- **CLAUDE.md WAS 6,753 LINES AND 88% OF IT WAS THE LOG.** Its own first rule is
  "read this entire file before writing any code", and at that size nobody could.
  The 33 entries older than 2026-08-24 moved VERBATIM to
  `docs/history/current-state-archive.md` — nothing summarised, nothing dropped,
  because those entries carry the most expensive lessons in the repo (the context
  read above its own provider, the mismatched-sample FK defect, the role flip that
  would have broken every login). **CLAUDE.md is now 2,563 lines**, and a new
  maintenance rule archives past ~12 entries so it cannot grow back silently.
- **THE MIGRATIONS SECTION WAS ACTIVELY MISLEADING.** It was headed "Database
  Migrations (30 files)" and listed 32, while the directory holds **87**. Anyone
  reading it would have numbered their next migration 39. It is now a pointer to
  the directory plus the count, with the rule that a hand-kept file list must
  never be restored — that list is exactly how the Folder Structure tree drifted
  too (it still named `Nav.tsx`, `LineageFlow.tsx` and `utils/storage.ts`, all
  long deleted, and its own narrative said so 4,000 lines further down).
- **A DOCUMENTATION BUG THAT WOULD HAVE COST SOMEONE AN AFTERNOON: CLAUDE.md's
  env block said `CORS_ORIGINS`; `config.ts` reads `CORS_ORIGIN`.** Set the
  plural in production and CORS silently falls back to localhost, which fails as
  a browser error far from its cause. `.env.example` had it right all along.
- **`.env.example`**: `SQLITE_DB_PATH` removed (nothing anywhere reads it), and
  **`AZURE_KEY_VAULT_URL` annotated rather than removed** — `infra/main.tf` and
  `docker-compose.production.yml` still set it, but no code has read it since its
  only consumer (`utils/secrets.ts`, zero importers) went. **Key Vault is not in
  the loop today**; the infra was deliberately left alone because changing it is
  a `terraform apply` away from production, not a cleanup.
- **A near-miss worth recording: three `RETENTION_*_DAYS` vars looked orphaned
  and are not.** `services/retention.ts` names them as `envVar:` STRINGS in a
  table, so a `process.env.X` grep cannot see them. They were one command away
  from being deleted from `.env.example`. Verify before removing, always.
- **NOT deleted, deliberately, and left for the owner to decide.** (a) Twelve of
  the eighteen `components/ui/` primitives (Card, Table, Tabs, Modal, KPITile,
  SourceCard, OutlineRail, NotebookCell, AIResponseBlock, ChartCard,
  ui/JobProgressBanner, ui/PageHeader is gone) are imported ONLY by the
  `/dev/ui` playground — the design system is largely aspirational rather than
  adopted. That is ~12 files, but deleting a design system is a product call.
  (b) `handoff/` and `stitch_review/` are referenced by nothing, but they are
  design history, not code. (c) `PROJECT_PLAN.md` still says "Last updated
  2026-04-03, current block 4.3" five months on. **`/dev/widgets` must NOT be
  touched — it is the Widget Render Gate's fixture gallery and CI depends on it.**
- Sandbox note: this checkout had no `node_modules` at all, so the first
  typecheck failed on missing `react`/`Buffer` and said nothing about the
  deletions. `packages/connectors` installs fine with `--ignore-scripts` and a
  plain `tsc` build (6s), which is all the backend needs to typecheck — no DuckDB
  native build required for that.

**Prior last updated:** 2026-09-01 (MCP vs IN-PRODUCT AI — competitive analysis, doc only,
no code changed)

**NEW DOC: `docs/backlog/mcp-vs-in-product-ai.md` (2026-09-01, doc only).** Owner
asked what to make of the single MCP endpoint Peliqan leads with, versus
Clarion's approach of having the AI inside the platform for everything — pros,
cons, cost, and whether Clarion chose right. Follow-up to
`clarion-vs-peliqan.md`, which treated MCP in one paragraph.
- **THE QUESTION SETS TWO THINGS AGAINST EACH OTHER THAT SIT ON DIFFERENT
  LAYERS.** MCP is transport; in-product AI is the experience. The serious
  players ship both — Snowflake has Cortex Analyst AND an MCP server, Databricks
  has Genie AND one; dbt, Cube and AtScale all ship one on top of their semantic
  layer *(market claim, not verified)*. They stack, they don't compete.
- **THE STRONGEST SIGNAL IS PELIQAN'S OWN REPOSITIONING: they now call
  themselves "the trust layer for AI & BI"** *(claim — their homepage title in
  September 2026 search results)*. In August they sold pipes plus activation.
  Their positioning is moving TOWARD Clarion's, not the other way round — which
  is the best available evidence that the trust layer was the right thing to
  build.
- **"MCP only" would have been fatal for Clarion and is rational for Peliqan,
  for the same reason: MCP turns your product into a SOURCE.** When your value is
  breadth (300 connectors) being a source is excellent. When your value is
  understanding (6 connectors, understood deeply), being a source gives away the
  only reason to choose you.
- **MEASURED, AND THE SURPRISE OF THE RESEARCH: an MCP endpoint is DAYS, not a
  quarter.** Eight prerequisites, seven already built — `api_tokens` +
  `middleware/apiToken.ts` (machine auth, role resolved live), `routes/addin.ts`
  (the narrow read-only surface as a pattern; its own header already names MCP as
  "the obvious next caller"), `applyDataPolicies`, `assertSafeReadQuery`,
  `/query/think`, `saved_questions`. Only the MCP transport + tool definitions are
  missing (repo-wide grep for "mcp" returns comments and docs only). Not having
  built it was a priority call, not an architectural gap.
- **THE DESIGN REQUIREMENT THAT DECIDES WHETHER IT IS WORTH ANYTHING: the trust
  payload must travel as STRUCTURED fields.** `/query/think`'s done payload
  already carries `verified`, `sources`, `confidence`, `policyNotice`,
  `tablesUsed` (`routes/query.ts:1355`). Ship those over MCP or Clarion is
  indistinguishable from a SQL endpoint — the differentiator stripped out at the
  one place it had to count.
- **A REAL WEAKNESS THE ANALYSIS TURNED UP: verified answers are bypassable by
  rephrasing.** `findVerifiedQuestion` matches normalized EXACT question text; an
  agent rephrases without thinking, misses the match, and falls back to
  generation — the path human verification existed to replace.
- **COST, and Clarion is the only side of this comparison that can actually
  answer it** *(measured)*: `ai_call_log` records model + tokens + `cost_usd` per
  call, `ai_usage` rolls up per tenant per month, `/admin/ai-usage` renders it,
  and soft budgets refuse with a 402 BEFORE the call so an overrun costs nothing.
  Plus Haiku/Sonnet splitting, prompt caching on 23 system prompts (0.1x reads),
  per-category Claude/Azure routing, and the deterministic paths that skip the
  model entirely. The structural trade: **in-product AI = Clarion pays every
  token, margin falls with use; MCP = the customer pays, margin holds — but you
  hand answer quality to a model you did not choose**, which is not a detail for
  a product that sells trust in the answer.
- **Recommendation**: keep in-product AI as the product (do not thin it); add MCP
  as a DOOR on the same guarded surface — three read-only tools
  (`list_questions`, `run_saved_question`, `ask`) on the existing token
  mechanism; trust payload mandatory. **Do NOT**: expose a raw-SQL tool (then you
  are a database with extra steps), allow any write (writeback is a different
  risk class), widen `api_tokens` beyond the narrow surface, or replace the own
  chat with "just use Claude". **Sequencing**: cheap enough not to wait, but less
  urgent than un-scoping the query layer — an agent that can only query one
  source hits the same wall the chat does (`routes/query.ts:370` still takes one
  `connectionId`).
- **BIGGER THAN MCP: APACHE OSSIE (formerly Open Semantic Interchange) — §9 of
  the doc, added 2026-09-01 on the owner's follow-up, and it CORRECTS the first
  version's unverified claim.** A vendor-neutral YAML/JSON spec for semantic
  metadata: `semantic_model` → `dataset` → `field` / `relationship` / `metric`,
  with `ai_context` as a first-class field at EVERY level and `custom_extensions`
  so exporting never means discarding. Out of scope: data formats and query
  interfaces — so it is not a rival to MCP (MCP moves answers, Ossie describes
  models) nor to the warehouse.
  **Maturity splits in two.** Governance is real: Apache 2.0, donated to the ASF,
  in the Apache Incubator since June 2026 (`github.com/apache/ossie`), JSON
  Schema plus merged reference converters for dbt/GoodData/Salesforce/Polaris.
  **Adoption is zero**: as of July 2026 NO semantic-layer product ships a
  user-facing import or export, and despite the "v1.0 finalized" announcement of
  27 Jan 2026 the repo sits at **`0.2.0.dev0`** (last release 0.1.1) — the spec
  still moves. Plus the structural objection: fragmentation is expensive for
  users and strategically useful for platforms, and a customer locked into
  Snowflake Semantic Views is a retained customer.
  **Clarion's product layer is ALREADY almost an Ossie model** *(measured against
  `20260402000017_create_data_products.ts`)* — `data_products`+`star_schemas` →
  `semantic_model`, `product_tables` → `dataset`, `product_columns` → `field`
  (with more detail than the spec asks), `product_relationships` → `relationship`
  1:1, `product_kpis` → `metric`, and descriptions + `plain_summary` +
  `question_text` + `business_glossary` overshoot `ai_context`. **The one real
  friction: `expression` is per SQL dialect and the spec's list is
  ANSI_SQL/SNOWFLAKE/DATABRICKS/MDX/TABLEAU — DuckDB is not on it**, so
  non-ANSI expressions belong in `custom_extensions`.
  **Recommendation: track it, do not build it.** No importer (nobody can produce
  a file for you to import); do NOT reshape the semantic layer to be Ossie-shaped
  (0.2.0.dev0 moves, and the shape already fits); the exporter is the only thing
  that ever needs building and it is a few days over tables that already exist.
  The trigger is commercial, not technical — the first prospect who asks, or the
  first major vendor shipping a real import. What makes it cheap later is that
  Clarion's semantics live in enumerable tables rather than in prompts or code;
  that is a property to keep, not a task.
- **Honest limits**: `peliqan.io` is still EGRESS_BLOCKED (retried 2026-09-01, not
  routed around), so no Peliqan feature was seen running; the market percentages
  are other people's numbers; and the comparison that would actually settle it —
  the same ten questions over the same Exact Online data, once through Clarion's
  chat and once through an agent on an MCP endpoint — has not been run.

**Prior last updated:** 2026-08-31 (DASHBOARD EDITING — the filter that never reached
the KPI cards, an assistant that gets out of the way, and one card at a time)

**Owner, from a live dashboard whose Customer filter said "Commerce 5 Sa" while
the four headline numbers showed everybody: *"I still get too little
information along the way. I don't know if it's working or stuck… the kpi cards
on top don't filter, why? Also the chat box at the bottom takes up a lot of the
screen… wouldn't it also be an idea to just be able to change or alter 1
visual?"* Four complaints, two of which are the same missing mechanism.**
- **THE KPI CARDS COULD NOT BE FILTERED, BY CONSTRUCTION, AND THE SCREEN SAID
  SO IN WORDS NOBODY COULD ACT ON.** `dashboardPrompt.ts:129` REQUIRES every
  `kpi_card` to compute its prior-period delta with `WITH curr AS (…), prev AS
  (…)`, and `injectWherePredicate` refuses `WITH` on purpose — a predicate
  landed in the wrong arm of a CTE is a wrong number. So `add_filter` wired the
  charts, skipped every KPI, and reported *"4 widget(s) need a closer look …
  because their query shape can't take a filter automatically"*. **The filter
  bar was lying about the four biggest numbers on the page** — the worst
  outcome available, because it renders.
- **The fix is a HANDOVER, not a better regex.** `AppliedEdit` gained a
  structured `handovers: SqlHandover[]` (replacing the `NEEDS_SQL:<id>:<text>`
  string encoding, which could only ever carry ONE — and one `add_filter` needs
  four). A card the app cannot edit textually is now handed to a scoped
  `editWidgetSql` call with the exact predicate and an instruction to put it
  inside EVERY arm that reads the rows, not just the final SELECT. The existing
  CHECK stage then executes those widgets and reverts any that fail, so a
  handover can still refuse — visibly — but it can no longer go silent.
- **`MAX_FILTER_HANDOVERS = 12`**, because each handover is its own Sonnet call
  and "add a filter" must not silently become forty of them. Past the cap it is
  a stated refusal naming the cards. Correctness first, cost second: a filter
  that quietly does not apply is worth more than 12 model calls to avoid.
- **THE PROGRESS NOW NAMES EACH CARD.** `step` events gained `label` +
  `parentId`, and a step whose id the client has not seen APPENDS rather than
  being dropped — so work the server only discovers while applying the plan
  ("Add a Customer filter" → four cards to rewrite) becomes four visible lines
  nested under it, each flipping pending → running → done. The parent stays
  `running` until its last child settles, so a tick means the whole thing.
  Plus a per-step and per-message ELAPSED COUNTER: "is it working or is it
  stuck" is not answerable from a spinner, and it is the only question being
  asked during the wait.
- **`scopeWidgetId` on `/refine-spec-stream` — change ONE visual.** The planner
  is shown only that widget, **every returned op is filtered to it in code**
  (not by prompt hope), and if nothing survives it falls back to a single
  `sql_edit` carrying the user's words. **Escalation is DISABLED while scoped**
  — regenerating a whole dashboard is the one thing "change this card" must
  never do. Deterministic ops still apply: "show 20 rows" and "make it a bar
  chart" stay instant and cost no model call at all.
- **NEW `frontend/app/dashboards/components/AssistantPanel.tsx` — the chat is a
  panel now, not a plinth.** The old bar was a `shrink-0` sibling of the grid:
  **~98px of the dashboard permanently, ~306px once it had any history, with no
  way to put it away.** The panel is absolutely positioned against the viewing
  container (`relative` on it is load-bearing), so it OVERLAYS the charts and
  closing it returns every pixel. Collapsed it is a pill that still reports
  progress ("Writing 4 queries… 56s") so closing it never means losing the run.
- **Two rules keep it from becoming what it replaced**: only the newest
  exchange is expanded (older ones collapse to a one-line summary you can click
  open — three stacked checklists is a wall, and the wall is why people stop
  reading the one that matters), and anything running states its elapsed time.
- **"Change this card" is a wand on every widget** — in the chart header's
  hover toolbar and, for KPI cards which have no toolbar, beside the provenance
  button. It sets the scope, opens the panel and focuses the input; the scope
  renders as a chip above the composer with an × (a scope you cannot see is a
  scope you get stuck in) and is RELEASED after one submit.
- **A real bug the render check caught that the type checker could not**:
  `Elapsed` read `Date.now()` during render, which tears hydration. Now read in
  an effect, null until the first tick. Found by screenshotting a throwaway
  `/dev/assistant` harness in real Chromium (deleted after) — the same
  discipline as the source-tile marks, and it also showed the scoped kicker
  wrapping to three shouting uppercase lines, now just "Card updated".
- Validation: backend **47 files / 478 passed** (2 new: the CTE handover with
  its predicate, the cap), all eight ratchets green from the repo root,
  frontend `tsc` clean, touched files lint-clean, `next build` green 40/40
  (`/dashboards` 62.8 kB / 212 kB).
- **NOT done, deliberately**: the handover path has NOT been exercised against
  a live AI backend — watch the first real "add a filter" on a dashboard with
  KPI cards, since that is where four parallel scoped calls now fire. And
  `injectCrossFilter` (`routes/dashboards.ts`) is still a SECOND copy of the
  injection logic with its own boundary regex and a sanitising identifier
  check; the comment in `dashboardEditOps.ts` claiming it is a caller has been
  wrong since the file was written.

**Prior last updated:** 2026-08-31 (SOURCE TILES — real brand marks, and Exact Online
stopped appearing twice; the preview marker is gone with the trains it described)

**Owner, looking at `/sources` and the flag console: *"I don't want preview and
I don't want ExactOnline there 2 times. And I want the correct icons for the
source systems."* Three separate defects, one screen.**
- **EXACT ONLINE RENDERED TWICE — a greyed-out "Coming soon" tile beside the
  live one.** `CONNECTORS` in `app/sources/page.tsx` still carried a hardcoded
  `exactonline` entry with `available: false` from before the connector shipped,
  while the live tile comes from the `/source-types` fetch. Both lists rendered
  into the same grid. Deleted — and `staticConnectors` now filters any static
  tile whose id appears in the registry, so the collision cannot come back for
  the next connector that graduates from placeholder to real.
- **NEW `frontend/lib/connectorIcons.tsx` — one map, ten brand marks.** The
  tiles were a coloured square with the product's initial, which tells the
  reader nothing. Provenance is recorded per mark because it matters both
  legally and for accuracy: **postgres / mysql / sqlite / odoo / googlesheets
  from Simple Icons (CC0, official paths and the brand's own hex), salesforce +
  the MySQL dolphin from SVG Logos (CC0), excel / sharepoint / sqlserver from
  Material Design Icons (Apache-2.0) tinted to each product's documented brand
  colour.** Microsoft's own Fluent icons are trademarked and their brand
  guidelines do not permit shipping them, so those three are recognisable
  stand-ins, not reproductions — naming a product you integrate with is
  nominative use, copying its logo asset is not.
- **`exactonline` is the one HAND-DRAWN mark and the one to replace.** Exact
  publishes no open icon and this environment's egress policy blocks both
  Wikimedia Commons and Brandfetch, so it is a monogram in Exact red rather
  than their logo. Stated in the file header; dropping in their real SVG is a
  one-entry change.
- **Every mark renders as a single-colour glyph on a wash of its own colour**
  (`${color}14` fill, `${color}2E` border) so ten tiles read as one set instead
  of ten logo treatments at ten weights. **Verified by rendering, not by
  compiling**: a throwaway HTML harness was screenshotted in real Chromium,
  which caught two things the type checker cannot — Simple Icons' MySQL mark
  includes the wordmark and is illegible at 20px (swapped for the dolphin), and
  the first Exact mark was a solid red block that shouted over the other nine
  (redrawn as an outline).
- **The sidebar's "?" avatar over the caption "DUCKDB" is fixed too** — a
  registry connection stores `type: 'duckdb'` with the real product in
  `connector_type`, and the sidebar keyed off `type` alone. It now shows the
  product's mark and its name (`CONNECTOR_LABELS`).
- **`preview_banner` is DELETED and `FEATURE_FLAGS` is now EMPTY.** A badge
  whose whole job is to say "this account sees things customers cannot" is
  noise once every account sees everything; it went with the gates it
  described. The console honestly renders "nothing waiting to be released".
- **Two changes that empty registry forced, both improvements.**
  (a) `featureMeta(key)` replaces direct `FEATURE_FLAGS[key]` indexing in the
  console route — with an empty registry that expression narrows to `never` and
  every field access is a compile error. (b) `FEATURE_KEYS` became
  **`featureKeys()`**, derived at call time: a snapshot taken at import is the
  same information twice and the two can disagree.
- **The flag suite now REGISTERS ITS OWN KEY** (`test_release`, added in
  `beforeAll`, removed in `afterAll`) instead of borrowing `preview_banner`.
  Retiring a product flag used to take the whole flag-machinery suite with it —
  the tests were coupled to whatever happened to be shipping rather than to the
  mechanism under test. 23 tests, all still green with zero flags declared.
- Validation: backend **47 files / 476 passed**, all eight ratchets green from
  the repo root, frontend `tsc` clean, touched files lint-clean (the four
  findings in `sources/page.tsx` are pre-existing — verified by re-running the
  linter against `HEAD`), `next build` green 40/40.

**Prior last updated:** 2026-08-31 (NOTHING IS GATED — the August train was retired and
the platform ships to everyone, on purpose, until the first customer)

**Owner: *"Kunnen we voorlopig alles gwn laten doorkomen en automatisch voor
iedereen beschikbaar maken? Ik heb nog geen klanten en wil snelheid maken."*
Right call, and it was executed through exactly the removal path built hours
earlier — the mechanism's first real use was retiring itself.**
- **`release_2026_08` is DELETED from `FEATURE_FLAGS`, and `tsc` produced the
  cleanup list**: two errors, `dashboards.ts:574` and `sources.ts:63`. Both
  gates removed. Excel + SharePoint are now in the catalog for every tenant;
  the tiered dashboard fast path runs for everyone (its `escalate()` fallback
  is untouched and still the safety net). **`CURRENT_RELEASE` is `null`** —
  "no train is open" is now a representable state rather than a lie.
- **`ReleaseKey` narrows to `never` with no train declared, so
  `isReleaseEnabled` cannot be called at all.** That is the right error for
  someone reaching for a gate before opening a train, and it means the idle
  machinery cannot be half-used.
- **WHY THIS IS NOT A CORNER CUT.** A flag protects an audience; there is no
  audience. A switch guarding nobody is a second code path that can only ever
  be wrong, plus a decision to remember on every change. Everything that makes
  gating work is still built and still tested — the console, the ladder, the
  audience-survives-'off' rule, the lifecycle reporting. Only the audience is
  missing, and the registry comment + `DEV_FLOW.md` Loop 3 carry the four-step
  reversal (declare a train, point `CURRENT_RELEASE` at it, gate the next
  user-visible change, tick a tenant) so the day-one-customer flip is an hour,
  not a rediscovery.
- **`source-types-release-gate.test.ts` → `source-types-catalog.test.ts`.** The
  gate tests would have been deleted as meaningless; instead the file now pins
  the DECISION — every connector is offered to a brand-new tenant — so
  re-introducing a gate is a visible act rather than something that creeps
  back. The `CURRENT_RELEASE` test allows null OR a real key, and still refuses
  the third state (a name that looks real and is not).
- **The production `feature_flags` row for `release_2026_08` becomes an
  orphan** — the console already filters orphans out, so it simply vanishes
  from the screen. Nothing to clean up by hand. `preview_banner` survives as
  the one standing capability, and is the only thing on the console now.
- **THE GAP THIS WIDENS, stated plainly: with no flags AND no alerting, the
  only safety net between a bad push and a customer is the CI gate plus a
  manual rollback.** That is an acceptable trade at zero customers and it stops
  being one at one customer. Alerting is now unambiguously the next fundamental
  — more urgent than any flag work.
- Validation: backend **47 files / 476 passed** (one fewer file: the gate suite
  replaced), all eight ratchets green from the repo root, frontend `tsc` + lint
  clean, `next build` green 40/40.

**Prior last updated:** 2026-08-31 (RELEASE MECHANICS HARDENED — a gate names its own
train, and the console reports the END of a release's life)

**THE RELEASE TRAIN HAD A SUCCESSION BUG THAT WOULD HAVE FIRED ON THE FIRST DAY
OF SEPTEMBER, silently.** Owner: *"think deep and hard if this is the way
(semi-)professional software companies roll out features."* Measured against
the standard taxonomy (release / experiment / ops / permission toggles) most of
this platform is already right — deploy is separated from release, tenant-list
targeting is the correct granularity for B2B (percentage rollout would show two
colleagues different products), flags fail closed, both sides of the gate are
tested, and the audience survives a trip through 'off'. Three things were not.
- **A gate must name the release it shipped in, and did not.** Both live gates
  called `isCurrentReleaseEnabled()`, which read whatever `CURRENT_RELEASE`
  pointed at. The comment on it argued this was the benefit: opening the next
  train would be one edit. It would ALSO, in that same edit, have taken August
  offline everywhere — every live gate would have started reading September's
  audience, which is empty by definition on the day it opens. The Excel and
  SharePoint tiles would have vanished for tenants that already had them, the
  fast dashboard edits would have reverted to the slow path, and nothing would
  have logged a thing. Now: `isReleaseEnabled(tenantId, 'release_2026_08', db)`.
  **The owner's ask is untouched** — one switch per batch, not one per feature —
  because every gate from a batch names the same key.
- **The fix is enforced by the type system, and both directions were PROVEN by
  making the compiler fail before restoring.** `CURRENT_RELEASE` is deliberately
  typed `string` (not the literal), so passing it to `isReleaseEnabled`, which
  takes a `ReleaseKey`, does not compile — the old mistake cannot be made by
  hand again. And deleting a finished train from `FEATURE_FLAGS` narrows
  `ReleaseKey` to `never`, so `tsc` names EVERY gate that referenced it: the
  removal checklist is generated, not remembered. That is Uber's Piranha idea at
  1/1000th the cost, using only the type checker.
- **The console reports the END of a release's life, not just the start.** An
  unremoved release toggle is the standard way a flag system rots. The rule is
  the industry default — 14 days at 100% — and it is computable from data
  already stored (`kind==='release' && rollout==='all' && updated_at`). Pure
  helpers `daysFullyReleased` / `gateIsRemovable` live in `contract.ts` (both
  copies) so the rule exists once; the console shows a per-row line and a quiet
  secondary note, deliberately QUIETER than the waiting-for-an-audience banner
  because this is not an audience decision, it is a message to whoever writes
  the code. 5 new pure tests pin the edges: mid-rollout says nothing (advising
  removal there would delete a gate still doing its job), `kind:'feature'` is
  never reported (a standing capability is not scaffolding), an unparseable
  timestamp is "do not know" rather than a guess.
- **DELIBERATELY NOT ADDED: a per-feature kill switch.** With a train, switching
  off withdraws the whole batch. That is acceptable while a month is one or two
  changes you would withdraw together, and the escape hatch already exists —
  give the risky thing `kind: 'feature'`. Adding an `ops` kind now would be
  speculative. The registry comment names the trigger for revisiting it.
- **`docs/DEV_FLOW.md` Loop 3 rewritten** around joining a train vs opening one,
  and a stale claim was corrected: it said CI "runs on push as a signal … they
  don't block you", which stopped being true when the `gate` job landed. Tests
  ARE a gate on migrate-sql and deploy.
- **STILL THE LARGEST GAP, unchanged and now more visible: there is no
  alerting.** Progressive delivery without a health signal is just hoping — the
  ring exists to catch a problem with one tenant before ten, and nothing tells
  anyone a problem occurred. Rollback is one click; noticing is manual.
- Validation: backend **47 files / 477 passed** (5 new), all eight ratchets green
  from the repo root, frontend `tsc` + lint clean, `next build` green.

**Prior last updated:** 2026-08-31 (SPREADSHEET SOURCES — Excel + SharePoint
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
- **⚠ THE ENTRY ABOVE ENDED ON THE WRONG ANSWER. THE REAL CAUSE, FOUND
  2026-08-31: THE PAGE READ THE FLAGS ABOVE ITS OWN PROVIDER.**
  `FeaturesProvider` is mounted inside `AppShell`, and
  `app/admin/features/page.tsx` called `useIsOperator()` in its own body — one
  level ABOVE the `<AppShell>` it returns. React resolves context by position
  in the tree, so the page got the context DEFAULT (`isOperator: false`) and
  refused, forever, for everyone. The nav entry beside it rendered because
  IconRail lives INSIDE the shell. Every observation in the entry above is
  therefore consistent and none of it was the cause: the 200/874 log line was
  real, the env var was fine, and "stale client state" was a guess that
  happened to end the search. Then the fault/refusal split shipped the next
  day turned the wrong refusal into a **permanent spinner**, because
  `featuresLoaded` came from the same default and could never become true.
  **The durable lesson is not about logs: a context with a plausible default
  cannot report that it was read from the wrong place.** So the four hooks now
  THROW outside the provider, which fires during `next build`'s prerender and
  is therefore a merge gate; the page is split so the chrome is the default
  export and every hook sits in `FeatureFlagsConsole` inside the shell.
- **THE GATE CAUGHT A SECOND, LARGER BUG ON ITS FIRST RUN, AND THIS ONE HAD
  NEVER BEEN NOTICED AT ALL.** `ShellLayout` — the OTHER copy of the app
  chrome, used by twelve routes (Home, Dashboards, Catalog, Build, Subjects,
  Grids, Notebooks, Pipelines, Products, Relations, Shared data, Topics) —
  mounted `TopBar` and `IconRail` with **no `FeaturesProvider`**. So on most of
  the app the rail's `useIsOperator()` and the top bar's `preview_banner` read
  the default: an operator had no operator entry in the nav, and no error was
  ever raised. `next build` went red on exactly those twelve pages, which is
  what the throw is for. ShellLayout now provides the flags, and **nesting a
  provider is a deliberate no-op** (the outermost wins) so the two copies of
  the chrome can never fire two requests or hand a subtree a different answer
  than the rail above it. **Rule: two components rendering the same chrome must
  provide the same context.**
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

**Older entries (33 of them, 2026-04 → 2026-08-24) are archived** in
`docs/history/current-state-archive.md` — verbatim, nothing summarised. They were
88% of this file, which made the "read this entire file at the start of every
session" rule above unfollowable in practice. Go there for the reasoning behind
anything older than the entries below; the lessons in them are still binding.

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
    │   ├── RequireRole.tsx           ← admin gate wrapper (shows "Restricted" card instead of redirecting)
    │   ├── IngestionWizard.tsx       ← step-by-step data ingestion setup
    │   ├── NotificationBell.tsx      ← notification icon + dropdown (used by TopBar)
    │   ├── Pagination.tsx            ← generic pagination component
    │   ├── QualityAlertBanner.tsx    ← data quality issue alerts
    │   ├── QualityPanel.tsx          ← quality profiling dashboard
    │   ├── EmptyState.tsx            ← Observatory empty state (eyebrow/title/description/actions)
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
    │   ├── semantic/
    │   │   ├── ApprovalBadge.tsx     ← approval status indicator
    │   │   ├── HistoryPanel.tsx      ← change history tracking
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

### Database Migrations

**89 migrations**, in `backend/src/db/migrations/`, newest
`20260901000088_auth_lookup_policies`.

The list that used to live here was hand-kept, stopped at 30 while the
directory grew to 89, and told anyone reading it that the next
migration number was 39. **Do not restore it** — `ls backend/src/db/migrations/`
is the only version that cannot go stale. Migrations are applied with
`npx knex migrate:latest` from `backend/`; the suite needs them run before
vitest (see the sandbox note in Current State).
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

# CORS — allowed frontend origins (comma-separated)
# NOTE the singular: config.ts reads CORS_ORIGIN. This block said CORS_ORIGINS
# for months, which silently falls back to localhost in production.
CORS_ORIGIN=http://localhost:3000

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

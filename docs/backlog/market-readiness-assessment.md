# Market readiness assessment — what is missing before Clarion carries paying customers

> **Status:** assessment, doc only. No code changed.
> **Date:** 2026-09-01 · verified against the working tree at `e320c98`.
> **Companion artifact:** "Clarion Launch Preflight".

Owner's question: *"I want to bring Clarion to the market. What is still missing?
What do I miss for multiple customers? Is the platform complete in all functional
and non-functional aspects?"*

Method: read the code, migrations, workflows and Terraform directly. Every claim
below carries its evidence. Where production state could not be established from
the repository, that inability is recorded as the finding rather than guessed at.

---

## Verdict

**No-go for paid onboarding.** Clarion is a capable product on an unfinished
platform. Nothing here is a rewrite — the gaps are additive and several are
already understood inside the codebase. But two of them mean the platform cannot
currently *prove* that customer A cannot see customer B, and that claim is the
product being sold to an accountant.

| Severity | Count | Meaning |
|---|---|---|
| **P0** | 6 | Blocks the first paying customer |
| **P1** | 7 | Breaks between customer two and ten |
| **P2** | 5 | Gap between the product and the Belgian SMB market |

---

## 1. The reference model — seven planes

Running one tenant well and running many are different problems. Seven planes
have to hold at once; a platform is only as ready as its weakest, because each
represents a failure a customer cannot recover from alone.

| # | Plane | What it requires | Status |
|---|---|---|---|
| 1 | Tenancy & isolation | Every store separates tenants at the **data layer**, proven by tests in both directions | **Partial** |
| 2 | Identity & access | Verified signup, strong auth, org-wide policy, immediate suspend/offboard | **Partial** |
| 3 | Commercial | Plans, entitlements enforced in real time, metering, collection, dunning | **Absent** |
| 4 | Operations | Alerting, meaningful health, rehearsed backups, no SPOFs, per-tenant headroom | **Partial** |
| 5 | Compliance & legal | ToS, privacy, DPA, subprocessors, residency, audit, retention, erasure | **Partial** |
| 6 | Support & operability | Tenant admin console, safe reproduction, status page, support channel | **Weak** |
| 7 | Product fit | Self-serve onboarding, customer's language, core promise delivered | **Partial** |

---

## 2. P0 — blocks the first paying customer

### P0-1 · The policy that makes login work exists in no migration

> **REMEDIATED 2026-09-01** ([PR #101](https://github.com/Arnovda/Clarion/pull/101),
> merged): migration 20260901000088 creates `auth_lookup` on all five tables,
> `e2e/auth-login.spec.ts` logs in as `databridge_app` in CI, and the
> preflight asserts policy identity. Production settled the same day — see
> §7 item 1. The original finding follows.

Thirteen places describe an `auth_lookup` RLS policy letting an unauthenticated
`SELECT` find a user. It is created by exactly one thing:
`backend/scripts/prod-fix-missing-policies.ts`, a hand-run script no workflow and
no `.ops` control invokes.

Migration-provisioned databases give `users` only `tenant_isolation`, whose
predicate under empty tenant context is `tenant_id = NULL` — never true, so
**zero rows**. Production connects as `databridge_app` (`NOBYPASSRLS`) since the
2026-08-06 role flip, so login, forgot-password, refresh-token validation and
WebAuthn verification can only fail.

Either production runs a hand-applied policy no environment can reproduce, or
`databridge_app` retains `BYPASSRLS` and RLS enforces nothing. **From the
repository the two are indistinguishable.**

Why nothing catches it:

- `e2e/rls.spec.ts` registers two tenants and uses the token `/register` returns
  directly — it **never calls `/auth/login`**.
- `backend/src/tests/auth.test.ts` does test login, but connects as the
  superuser, so RLS is inert.
- `scripts/preflight-role-flip.ts` asserts each table has **≥1 policy**; `users`
  has one, so it reports GO. It never checks policy *identity*.

### P0-2 · The semantic graph has no tenant boundary

> **REMEDIATED 2026-09-01** (third wave-1 PR; all three steps now done). Step 2
> first: `.ops/graph-backfill` gained `apply` and `prune` modes and ran inside
> the Container Apps environment — the first apply stamped everything
> attributable and left 5,089 leftovers, every one an orphan of a deleted
> connection or product; `prune` deleted them (they belonged to nobody) and the
> recount came back **clean on every label including `RELATES_TO`**. Then step
> 3: every `MATCH` on a tenant-owned label in `db/semanticGraph.ts` carries a
> `tenantId: $tenantId` predicate, every read function takes the tenant as an
> explicit required parameter threaded from `req.user!.tenantId` (or the
> RLS-scoped row in services), and `getProductTree` — this finding's named
> example — now requires a tenant argument, so `routes/catalog.ts` cannot call
> it scope-free any more. A wrong tenant matches nothing: the failure direction
> is an empty result, never another tenant's data. Held by a new merge-gate
> linter (`lint-graph-tenant-predicate`, 80 anchored clauses checked, verified
> to go red when a predicate is removed) beside the existing stamp linter, and
> by `db/semanticGraph.tenant.test.ts` (11 tests asserting the tenant a caller
> passes is bound to `$tenantId` on every query each function runs). The
> route-level ownership gates deliberately STAY: they are the 404-vs-empty
> distinction and the Postgres-backed second line. Three deliberate exemptions
> carry `// tenant-exempt:` comments — the ownership resolver
> (`getRelationshipConnectionId`) and the two owner-key purges
> (`deleteTenantGraph`, `deleteProductGraph`), where a tenant predicate would
> strand mis-stamped nodes instead of deleting them. The original finding
> follows.

`db/semanticGraph.ts`: **90 `MATCH` clauses, 0 tenant predicates**. Nodes match
on a globally unique, sequential, enumerable `pgId`.

The three-step plan is stalled: step 1 (stamp `tenantId` on writes) shipped and
is held by a linter; step 2's control `.ops/graph-backfill` is still set to
`report`; step 3 (read predicates) has not started.

Isolation therefore rests on ~30 route handlers each remembering an ownership
gate — a discipline control where a construction control is possible. It has
already failed once: the 2026-07-28 audit found `GET /semantic/columns` returning
another tenant's full column catalogue to any authenticated user, viewer
included. `routes/catalog.ts:242` still calls `graph.getProductTree()`, which
takes no scope and returns every tenant's tree (currently read only for counts of
owned ids — a latent footgun, not a live leak).

### P0-3 · There is no commercial layer

> **OWNER DECISION 2026-09-01** — *"Don't incorporate the billing system yet.
> It's through manual invoices in the beginning."* No Mollie integration, no
> automated invoicing/dunning for now: the first customers are invoiced by
> hand. What that leaves in scope for wave 2, if anything, is the thin
> administrative layer manual invoicing still needs — recording which plan a
> tenant is on and reading their metered `ai_usage` when writing the invoice —
> plus suspend/resume, which P1-5's operator console already covers. Revisit
> the payment processor when manual invoicing stops scaling; the metering
> foundation below is unchanged and keeps accruing.

No plans, subscriptions, entitlements, payment processor, invoicing, trial or
dunning. `tenants` carries `name`, `slug`, `status` and a nullable AI token
budget — nothing describing what a customer bought.

The metering half is further along: `ai_usage` (migration 36) rolls up tokens per
tenant per month and `callClaude` genuinely enforces `monthly_token_budget`. That
is a usable foundation for usage-based pricing. Everything between measuring and
getting paid is missing.

### P0-4 · No terms, privacy policy, or DPA

> **DRAFTED 2026-09-01** (fifth wave-1 PR) — drafted, deliberately not yet in
> force. Four documents exist as single-source string modules
> (`frontend/lib/legal/`) rendered at `/legal/terms`, `/legal/privacy`,
> `/legal/dpa` and `/legal/subprocessors`, each carrying a visible
> "draft — not yet in force" banner (`LEGAL_IN_FORCE=false` in
> `app/legal/LegalPage.tsx`). They are grounded in verified platform facts —
> EU-only hosting except Anthropic (and the privacy policy says plainly that
> questions, schema metadata, sampled values AND query results reach
> Anthropic), the real retention windows from `services/retention.ts`, the
> real erasure mechanics from `services/accountDeletion.ts`, and a DPA
> Annex II listing only measures the platform demonstrably implements. Entity
> name / KBO number / address / transfer-mechanism details are explicit
> `[PLACEHOLDERS]`; `docs/legal/README.md` is the lawyer's checklist and the
> go-live procedure (review → flip the banner → wire acceptance into
> registration). **Registration acceptance is deliberately NOT wired**:
> presenting unreviewed AI-drafted text as the binding agreement was the one
> instruction this work carried, so the auth screens link to the documents
> informationally only. Drive-by held to the same standard: the auth screen's
> **"SOC 2 Type II" footer claim was removed** — no such certification exists,
> and a compliance claim on the sign-in page is a representation, not
> decoration. The finding is CLOSED only when the lawyer-reviewed versions are
> in force and accepted at signup. The original finding follows.

No legal surface exists in the frontend. Clarion processes Belgian SMB accounting
data on its customers' behalf — a processor under GDPR. Article 28 requires a
written contract **before** processing begins, naming subprocessors. The real
subprocessor list is Microsoft Azure, Anthropic, and Azure Communication Services.

The engineering is ahead of the paperwork: EU residency is real (`westeurope`),
`services/retention.ts` sweeps with per-table configurable windows, `audit_events`
exists, and `purgeTenant` implements erasure wired to `routes/settings.ts`.

### P0-5 · Open registration with an unlimited AI budget

> **REMEDIATED 2026-09-01** (second wave-1 PR). Email verification gates login
> when an email provider is configured (`REQUIRE_EMAIL_VERIFICATION`
> overrides; environments that cannot send mail create users pre-verified —
> enforcement without delivery would be a lockout, not a control). New tenants
> get a non-null `monthly_token_budget` (`DEFAULT_MONTHLY_TOKEN_BUDGET`,
> 2,000,000 unless overridden). Slug collisions retry over numbered then
> random candidates instead of 500ing. The duplicate-email check works since
> P0-1's `auth_lookup` migration and is pinned by `e2e/auth-login.spec.ts`.
> Redeeming a password-reset/invite link counts as verification, so invited
> users are never locked out. Pinned by
> `backend/src/tests/signup-hardening.test.ts` (13 tests, all reproduced red
> against the pre-fix handler). The original finding follows.

`POST /auth/register` is unauthenticated, creates a tenant plus admin user, and
performs **no email verification**. New tenants get `monthly_token_budget = NULL`,
which enforcement reads as unlimited.

Two further defects in the same handler:

- The duplicate-email pre-check runs through `unauthQuery`, which under P0-1
  returns zero rows — it always concludes the address is free. Downstream,
  login's `trx('users').where({ email }).first()` is non-deterministic across
  duplicate rows.
- The slug is derived from company name into a `UNIQUE` column with no collision
  handling — the second customer called "Acme" gets a 500 on signup.

### P0-6 · Nothing reports that production is broken

> **REMEDIATED 2026-09-01** (fourth wave-1 PR). Two halves. **The promote gate
> asks a real question now**: `GET /api/health` (which ACA's own probes never
> touch — they hit `/api/ping`, so a Redis blip can stop a promotion but never
> restart healthy replicas) checks Postgres, Redis, Neo4j, blob storage and —
> the sharpest one — whether anything is LISTENING on the transformation and
> bus-matrix queues, via BullMQ's `getWorkers()` (Redis `CLIENT LIST`), which
> measures the jobs-worker's liveness directly instead of trusting a
> heartbeat. Per-component 5s budget, three-valued statuses (`ok` / `error` /
> `skipped` for not-configured, so dev and CI are unchanged), no error detail
> on the unauthenticated wire. The finding's exact scenario was reproduced red
> first (Redis+Neo4j dead → pre-fix `200 ok`) and then all four states
> verified against live processes, including Redis-alive-but-nobody-listening
> → 503. deploy.yml now also echoes the failing component's name instead of a
> bare status code. **The other half is alerting**: new GitOps control
> `.ops/alerts` (email address or `off`) drives `alerts.yml`, which creates an
> Azure Monitor action group plus rules for backend 5xx, backend/worker
> restarts, Postgres CPU/storage, `request failed` (HTTP ≥500) and
> `sync run failed` log lines — the last being a new load-bearing log line in
> SyncOrchestrator, since failures were previously only a database row no
> alert could read. ACA metric names are discovered at run time and printed to
> the summary; a rule that cannot be created fails the workflow (an alert you
> believe exists but does not is the failure this control replaces).
> `infra/alerts.tf` mirrors the resources for a future `terraform import`.
> Deliberately deferred, with reasons in `.ops/alerts`: queue-depth alerting
> (needs a metrics exporter — P1-6; the queue-listener health probe covers the
> dead-consumer case) and a continuous uptime web test. The original finding
> follows.

No alerting exists — no metric alerts, action groups or paging integration across
`infra/` or any workflow. Meanwhile `deploy.yml` promotes automatically once a
revision is `Provisioned` and answers one health probe.

That probe checks **Postgres only**:

```ts
await semanticDb.raw('SELECT 1'); checks.postgres = 'ok';
```

Redis, Neo4j, blob and the jobs-worker are untested, so a revision where every
scheduled sync, transformation and email report is dead reports `200 ok` and is
promoted to 100% traffic with nobody watching.

---

## 3. P1 — breaks as customer count rises

| ID | Finding | Evidence |
|---|---|---|
| **P1-1** | One customer's build blocks every other's. `schema-profiling` and `bus-matrix` both run at `concurrency: 1`, globally, and the jobs-worker is pinned to one replica because its reapers mark rows stale on age alone with no owner or heartbeat. | `jobs/workers.ts`, `infra/main.tf` |
| **P1-2** | Rate limits are per-IP, in-memory, per-replica. With `max_replicas = 3` every published limit is effectively tripled, including brute-force (5/15min → ~15). No tenant can be throttled individually. | `index.ts:149-215` |
| **P1-3** | **REMEDIATED 2026-09-01** (first wave-2 PR). `requireAuth` now re-validates `tenants.status` + `users.is_active` on every request behind a 30s-TTL cache (`services/accountStatus.ts`; fail-open on a DB error, fail-closed on a definitive negative), and `/auth/refresh` gained the tenant-status check it never had — before it, a suspended tenant's users could mint fresh access tokens for the refresh token's whole 30-day lifetime. Access tokens are genuinely 15m now: the code default already was, but production's legacy `JWT_EXPIRES_IN=8h` was honoured as the access lifetime; the alias is deprecated and ignored (`JWT_ACCESS_EXPIRES_IN` overrides deliberately), safe because the frontend silently auto-refreshes on 401. Proven live: suspension measured biting at exactly the 30s TTL on a running backend as `databridge_app`. Original finding: suspending a customer took up to 8 hours — `tenants.status` was checked only at login; `requireAuth` re-validated the JWT signature and nothing else. | `middleware/auth.ts`, `services/accountStatus.ts`, `services/refreshTokenService.ts` |
| **P1-4** | Every stateful dependency is a SPOF. Postgres has no `high_availability` block. Redis is one replica with `--save '' --appendonly no` (no persistence). Neo4j is one replica on a 5 GiB file share with **no backup policy**, scaled to zero (30–60s cold start). Postgres has 14-day PITR; the graph has replication but no recovery point. | `infra/main.tf:131, 210, 287, 353` |
| **P1-5** | **REMEDIATED 2026-09-01** (second wave-2 PR). `/admin/tenants` — the operator console: every tenant with health (users, sources, failing syncs, last sync) and this month's AI usage; suspend/resume (which bites in ≤30s via P1-3's enforcement, and refuses the operator's own tenant); AI budget control; sync inspection; and **audited 15-minute impersonation** — a hard-boxed token for one real user of the target tenant, no refresh token so the window closes itself, requiring a stated reason that lands in the TARGET tenant's audit trail next to the operator's email (`recordAuditForTenant`). Same operator gate and 404-not-403 refusal as the feature-flag console; cross-tenant reads run per-tenant under `tenantQuery` with explicit tenant_id filters (RLS cannot aggregate across tenants under the non-bypass role). Original finding: operator surface was `/admin/features` + `/admin/ai-usage` only, no impersonation — reproducing a customer issue meant a production database session. | `routes/adminTenants.ts`, `frontend/app/admin/tenants/` |
| **P1-6** | No per-tenant observability. App Insights is wired and logging is structured, but nothing aggregates by tenant — no per-tenant error rate, latency, sync success or cost-to-serve. | repo-wide |
| **P1-7** | A frontend type error can reach production. `ignoreBuildErrors: true`; the deploy gate waits on the Tests workflow, whose four jobs (api-tests, rls-isolation, connector-tests, widget-render-gate) do not type-check the frontend. **Zero frontend tests exist.** | `next.config.mjs`, `.github/workflows/test.yml` |

---

## 4. P2 — product/market gaps

- **P2-1 · English-only in a Dutch/French market.** No i18n library, no locale
  files, `lang` hardcoded. Sharpened by the AI now mirroring the question's
  language — Clarion replies in Dutch inside an English interface.
- **P2-2 · A new customer lands on an empty screen.** `/register` pushes to
  `/sources`; `/onboarding` is referenced from **nowhere** in the frontend.
- **P2-3 · The cross-system promise is still not expressible.**
  `routes/query.ts:370` takes a single `connectionId`. The demo that wins the
  deal cannot be given.
- **P2-4 · No status page, support channel or in-app help.** During an incident
  the customer notices first and has nowhere to write.
- **P2-5 · Auth policy is not customer-controllable.** MFA (TOTP + WebAuthn +
  backup codes) is well built but per-user and optional; no admin can require it.
  Passwords need 8 characters, no breach check. No SSO.

---

## 5. Remediation — three waves

Sequencing is not preference: wave 1 items are the ones whose absence makes
wave 2 unverifiable.

### Wave 1 — Prove it is safe, and make it lawful (≈3–4 weeks)

**Exit gate:** a database built only from migrations supports login under
`databridge_app`, CI proves it, and a DPA template exists.

1. **P0-1** Move `auth_lookup` into a migration for all five unauthenticated-path
   tables. Add a CI login test as `databridge_app` against a migration-only
   database. Extend the preflight to assert policy *identity*, not count.
2. **P0-1** Settle production directly — query `pg_policy` and `rolbypassrls` on
   the live database. Every isolation claim depends on the answer.
3. **P0-2** Run `.ops/graph-backfill` to `apply` until it reports zero unstamped
   nodes, then add tenant predicates to all 90 `MATCH` clauses plus a linter.
   Give `getProductTree` a required tenant argument.
   **DONE 2026-09-01** — backfill+prune reported clean on every label, the
   predicates and linter shipped in the third wave-1 PR (see the addendum
   under the finding).
4. **P0-5** Email verification, a non-null default AI budget, slug collision
   handling, and a duplicate-email check that works once P0-1 lands.
5. **P0-6** Deepen `/api/health` to Redis + Neo4j + blob + worker heartbeat and
   gate promotion on it. Add Azure metric alerts (5xx rate, restarts, queue
   depth, failed syncs, DB saturation) routed somewhere that reaches a human.
   **DONE 2026-09-01** — deep health live-verified in all four states, alerts
   via the `.ops/alerts` control (queue depth deferred to P1-6 with the
   queue-listener probe covering the dead-consumer case; see the addendum).
6. **P0-4** Publish terms, privacy policy, subprocessor list and DPA template.
   Lawyer-and-a-week — start day one, in parallel.

### Wave 2 — Be able to charge, and to operate (≈5–7 weeks)

**Exit gate:** a customer can subscribe, be metered, be suspended within a
minute, and be supported without a database session.

1. **P0-3** Commercial layer on the existing metering: `plans`/`subscriptions`,
   entitlements in middleware, Mollie (better SEPA/Bancontact fit than Stripe for
   Belgium), trials, dunning. Feed `ai_usage` into invoicing.
   *(Owner decision 2026-09-01: DEFERRED — manual invoices at first; see the
   P0-3 addendum. Wave 2 starts at item 2.)*
2. **P1-3** Re-validate tenant status and `is_active` in `requireAuth` behind a
   short-TTL cache; shorten the access token. *(DONE 2026-09-01 — see the P1-3
   row above; the refresh endpoint's missing tenant check closed with it.)*
3. **P1-5** Operator console: tenant list with health/usage, suspend/resume,
   budget control, sync inspection, and audited time-boxed impersonation.
   *(DONE 2026-09-01 — see the P1-5 row above.)*
4. **P1-1** Give the reapers an owner and heartbeat so the worker can scale past
   one replica, then move AI queues to per-tenant fairness. Show queue position
   meanwhile.
5. **P1-2** Redis-backed rate limiting keyed on tenant and account.
6. **P1-4** Postgres zone-redundant HA, Redis persistence, scheduled Neo4j dump
   with a **rehearsed** restore. Write down the RTO/RPO being offered.
7. **P1-6** Stamp tenant id on every log line, metric and trace; one dashboard
   for per-tenant error rate, latency, sync success and cost-to-serve.

### Wave 3 — Sell it into this market (≈4–6 weeks)

**Exit gate:** a Belgian SMB reaches a first answer, in Dutch, unaided.

1. **P2-1** Internationalise to NL and FR — mechanical but wide; before the sales
   push, not after.
2. **P2-2** A real first-run flow: connect → sync → build → first question.
3. **P2-3** Un-scope the query layer from `connectionId` to tenant.
4. **P1-7** Frontend type-check into the deploy gate; first component tests.
5. **P2-4** Status page, support address, in-app help. Start the SOC 2 Type II
   clock — most engineering exists, the certificate and its lead time do not.

---

## 6. What is already ahead of schedule

A gap list read alone misrepresents this codebase. Each of these is load-bearing
and would be months to acquire:

- **Data engine and semantics** — documentation-before-inference profiling,
  deterministic connector star-schema templates, measured FKs, a provenance
  ladder, lineage derived from the SQL itself, per-answer trust display.
- **Deployment discipline** — tests genuinely gate migrations and deploy;
  revisions land at 0% traffic and promote after a health probe; one-click
  rollback; a GitOps control plane in `.ops/`.
- **Authentication primitives** — TOTP, WebAuthn, backup codes, server-side
  revocable refresh tokens, AES-256-GCM credential encryption, machine tokens
  whose role resolves live so none outranks its owner.
- **Compute containment** — per-query child processes with real SIGKILL, divided
  memory budgets, global + per-tenant semaphores, a SQL guard refusing external
  file access and bare-path reads.
- **GDPR mechanics** — EU residency, configurable retention sweep, audit events,
  working tenant purge reachable from the UI.
- **Release control** — per-tenant feature flags with a typed registry, operator
  console and lifecycle reporting, deliberately empty and one edit from live.

---

## 7. Limits of this assessment

Two things could not be established from the repository and should be answered
before wave 1 closes — both are single queries against production:

1. The live database's actual policy and role state (P0-1).
   **ANSWERED 2026-09-01** — the owner ran the extended `prod-checks`
   preflight against production: `databridge_app` is genuinely
   `bypassrls=false`, all 71 tenant tables carry a verified tenant-isolation
   predicate, and `auth_lookup` is present 5/5. Combined with daily logins
   since the 2026-08-06 role flip, this settles the history: the hand-run
   `prod-fix-missing-policies.ts` HAD been applied and was carrying login;
   RLS was genuinely enforcing all along. Migration 20260901000088 now owns
   those policies, so every freshly built database matches production.
2. Whether per-tenant warehouse containers have received writes since the mode
   was switched to `per-tenant` on 2026-07-26 (last measured: 0 containers).

Effort figures are indicative ranges for one experienced engineer and exclude the
wave 1 legal work, which runs in parallel.

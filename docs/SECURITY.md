# Security Posture — Clarion

> Last updated: 2026-09-20 (rows refreshed against the code; the 2026-05-12 sprint
> plan that used to close this file is superseded by the market-readiness work —
> `docs/backlog/market-readiness-assessment-v2.md` — and by the runbooks)
>
> This document is the source of truth for "what are Clarion's security
> controls today?" Used internally for security questionnaires, audits,
> and onboarding new engineers. Update when controls change.

---

## Trust model

**One backend serves all tenants.** Tenant isolation is enforced at three layers, in order of importance:

1. **Postgres Row-Level Security (RLS) + FORCE RLS** on every tenant-scoped table. The database itself is the final arbiter of who can read what.
2. **Tenant-scoped transactions** (`req.dbTrx`) — every authenticated request runs queries inside a `SET LOCAL`-scoped transaction so connection pool reuse can never leak tenant context across requests.
3. **Tenant-prefixed warehouse paths** (`tenant_<tid>/conn_<cid>/...` for sources, `tenant_<tid>/product_<pid>/...` for products) so even if the application layer leaks, storage paths physically segregate data.

This is the **shared-compute, hard-isolated-data** model. Used by Stripe, Notion, HubSpot, and the majority of B2B SaaS. SOC 2 and ISO 27001 accept it as long as the implementation is robust.

---

## Authentication & authorization

| Control | Implementation |
|---|---|
| Password hashing | bcrypt, cost factor 12 |
| Access token | JWT (HS256), 15-minute expiry |
| Refresh token | 30-day expiry, sha256-hashed in `refresh_tokens` table, server-side revocable |
| Token secret strength | Production refuses to start with `< 32 chars` or known-weak secrets |
| Cascade revocations | password change, password reset, user deactivate, role change → revokes all refresh tokens for affected user |
| Role model | 3 roles: `admin`, `analyst`, `viewer` |
| Role enforcement | Per-route `requireRole(...)` middleware after `requireAuth` |
| Self-demotion guard | Admin cannot change their own role or deactivate themselves |
| Password reset tokens | sha256-hashed at rest, 1h expiry |
| Reset URL logging | Dev only (`NODE_ENV === 'development'`); never logged in staging/prod |

| MFA | TOTP (`/auth/mfa/*`, backup codes) and WebAuthn passkeys (`/auth/webauthn/*`), per user; org-wide enforcement is not built |
| Account status | `requireAuth` re-checks the tenant and user status every 30 s (`AUTH_STATUS_TTL_MS`), so a suspension bites within that window, not at token expiry |
| Auth events | register, login success/fail/refused, MFA challenge, logout, password reset and email verification land in `audit_events` (`recordAuthEvent`) |
| Machine auth | Excel add-in API tokens: sha256 at rest, owner's role resolved live, accepted on `/api/addin` only |

**Gaps still open:**

- MFA is per user; a tenant cannot require it for everyone.
- Refresh tokens stored in localStorage (not httpOnly cookies). XSS protection is therefore not absolute — partially mitigated by short access-token lifetime + server-side revocation. httpOnly cookies are a follow-up.

---

## Tenant data isolation

| Control | Implementation |
|---|---|
| RLS on every tenant table | migration `20260512000056_force_rls_audit.ts` enforces ENABLE + FORCE on every table with a `tenant_id` column; `20260804000074` backfilled the `tenant_isolation` policy on all of them and `20260901000088` added the `auth_lookup` carve-out for the unauthenticated paths |
| Non-bypass role | Production connects as `databridge_app` (NOBYPASSRLS) since 2026-08-06 (`.ops/db-role`); the `rls-isolation` CI job runs the API as that role. Before the flip a superuser connection made every policy inert. |
| Per-request transaction | `requireAuth` opens a `SET LOCAL`-scoped transaction; routes use `req.dbTrx` for guaranteed-isolated queries |
| Tenant context propagation | JWT → `req.user.tenantId` → `SET LOCAL app.current_tenant` inside transaction |
| Warehouse isolation | Per-tenant blob **containers** in production (`WAREHOUSE_CONTAINER_MODE=per-tenant`, since 2026-07-26): the worker's SAS is scoped to one tenant's container. Layout v2 is tenant-prefixed inside it. |
| DuckDB query scope | Each DuckDB session receives URIs from the (tenant-RLS-filtered) catalog only; every user- or model-authored query passes `assertSafeReadQuery` (SELECT-only, no external reads, quoted-name denylist) and the data policies (`prepareUserRead`) |
| Semantic graph | Every Neo4j `MATCH` on a tenant-owned label carries a `tenantId` predicate, held by the `lint-graph-tenant-predicate` ratchet; request-supplied ids pass the `owns()` gate (404, never 403) |

**Gaps still open:**

- 17 bare-pool reads outside the request path remain (`lint-no-session-tenant-set` baseline, only ever lowered); the request-path fallback `SET` in `middleware/auth.ts` stays until that count is zero.ndition. Routes are being migrated incrementally; **mutation endpoints and security-sensitive reads have been migrated first**.

---

## Secrets management

| Control | Implementation |
|---|---|
| Connection credentials | AES-256-GCM with random IV, packed `iv:authTag:ciphertext` base64. Key sourced from `CREDENTIALS_ENCRYPTION_KEY`, delivered as a Container App secret. |
| Production safety guard | Backend refuses to encrypt or decrypt when key is missing in `NODE_ENV=production` |
| Secret store | Secrets reach the containers as Container App secrets (Terraform / GitHub secrets). A Key Vault exists in `infra/main.tf` and holds copies, but nothing in the application reads it — the Key Vault SDK client was removed on 2026-09-20 as dead code. |
| Soft-delete | 90 days on Key Vault |
| Purge protection | Enabled — vault cannot be permanently deleted |
| Key rotation | Manual; key sha256-derived from env var → rotation requires re-encrypting all credential rows. Tracked as Sprint 2. |

---

## Audit trail

| Control | Implementation |
|---|---|
| Admin-action log | `audit_events` table (created `20260512000057_create_audit_events.ts`). Append-only — `databridge_app` role has SELECT+INSERT but no UPDATE/DELETE. |
| AI query log | `query_log` — every NL query, its generated SQL, confidence score, was-flagged status |
| AI cost log | `ai_call_log` — per-tenant, per-user spend |
| HTTP request log | Pino structured logs, redacted (password, token, Authorization header, API keys) |
| Audited actions | user/role/invite mutations, connection and product deletes, tenant customer-record changes, operator actions (support sessions, suspend/resume, budgets — written into the TARGET tenant's trail), legal acceptance, exports, every auth event |
| Retention + export | `audit_events` kept 730 days (`RETENTION_AUDIT_EVENTS_DAYS`); `GET /users/audit/export.csv` (admin, itself audited); the UI lives on `/users → Audit log` |
| Failed writes | an audit write that fails logs `'audit write failed'` at ERROR with a metric — never a swallowed warning |

**Gaps still open:**

- Some mutation endpoints are still not wired to `recordAudit` — incremental.

---

## Network & infrastructure

| Control | Implementation |
|---|---|
| TLS | Azure Container Apps + Front Door, TLS 1.2 minimum on storage account |
| Postgres firewall | Allows Azure services only + explicit local IPs for migration runs |
| Container Apps egress | Default Azure egress (no explicit firewall); connector HTTP goes through `HttpClient` with a per-connector egress allow-list (SSRF guard) |
| Compute isolation | DuckDB sessions are bounded (memory, threads, per-tenant concurrency); `DUCKDB_RUNNER=child` runs each query in a killable child process; the sync worker runs one Container Apps Job execution per sync with a tenant-scoped SAS and no database credentials |
| Alerting | Azure Monitor rules from `.ops/alerts` (5xx, restarts, Postgres, failed syncs, brute force, stale sources, SQL-guard refusals, queue depth); the promote gate curls the deep `/api/health` before shifting traffic |
| Image registry | Private ACR (`databridgeacr`) |
| Managed identity | Backend → Blob Storage via system-assigned MI |
| Compute isolation | Single backend deployment shared across tenants. Worker jobs are per-execution. |

---

## Data durability & recovery

| Control | Implementation |
|---|---|
| Postgres backups | 14-day point-in-time recovery + geo-redundant backups (paired Azure region) |
| Storage replication | GRS (geo-redundant; asynchronously replicated cross-region) |
| Blob versioning | Enabled — accidental overwrites recoverable for 30 days |
| Blob soft-delete | 30 days |
| Key Vault soft-delete | 90 days |
| Neo4j data | Azure File Share, single-region |

| Neo4j recovery point | daily Azure Backup snapshots of the file share + 30-day share soft-delete (`infra/main.tf`; applied on the owner's next `terraform apply`) |

**Gaps still open:**

- RTO/RPO per store are written down in `docs/runbooks/disaster-recovery.md`, but **no restore has been rehearsed** — the numbers are not quotable to a customer until the §6 checklist there is ticked.
- Neo4j is rebuildable from Postgres state (`migrateSemanticToNeo4j.ts`) — the un-mirrored graph-only edits are the residual exposure.

---

## CI / supply chain

| Control | Implementation |
|---|---|
| Dependency vulnerability scan | `scripts/audit-gate.mjs` on every PR and push, for backend, connectors AND frontend — fails on any high/critical not in its reasoned allowlist |
| Type-check gate | Strict `tsconfig.build.json` compile (backend, connectors) and `tsc --noEmit` (frontend) in the Tests workflow |
| Test gate | Vitest (backend against a Postgres service container, connectors, frontend), the RLS isolation suite as `databridge_app`, a migration rollback round trip and the widget render gate — and `deploy.yml` will not migrate or deploy a commit whose Tests and Lint workflows are not green |
| Ratchets | twelve `lint-*.ts` scripts in the Lint workflow (session-level tenant SET, dynamic imports, validation coverage, warehouse scans, graph tenant predicates, …) whose baselines only ever go down |
| Image signing | Not yet — planned |
| SBOM | Not yet — planned for Sprint 3 |
| Dependabot | Weekly updates for backend, frontend, GitHub Actions |

---

## What's NOT yet in place (honest)

These are real gaps. Listed so we're transparent with customers and ourselves.

### Done since this file was first written

- ✅ **JWT refresh tokens + revocation** — 15-min access + 30-day refresh; revokeAll on password change / role change / deactivate
- ✅ **Audit log UI** — `/users → Audit log` (admin only), plus CSV export
- ✅ **Public `/security` page**
- ✅ **MFA** — TOTP + WebAuthn passkeys, per user
- ✅ **Incident response runbook** — `docs/runbooks/incident-response.md` (severity ladder, first hour, breach path, evidence preservation)
- ✅ **DR runbook with RTO/RPO per store** — `docs/runbooks/disaster-recovery.md` (rehearsal still owed)
- ✅ **DPA / ToS / privacy / subprocessor DRAFTS** — `docs/legal/`, rendered at `/legal/*`, not in force until counsel reviews (`LEGAL_IN_FORCE`)
- ✅ **Tenant data export** — `GET /settings/export.zip`; erasure via `purgeTenant`
- ⚠️ **Migrate remaining bare-pool reads to `tenantQuery`** — 17 left (the ratchet baseline). Done so far: every mutation on `users.ts`, `connections.ts`, `policies.ts`; `dashboards.ts` POST + DELETE; `products.ts` POST. The remaining read endpoints + non-critical mutations still use the session-level SET fallback (which IS racy under concurrency). Helper at `db/reqDb.ts` (`const db = reqDb(req)`) is the migration pattern.
- 🟦 **Penetration test** — budget allocated, vendor TBD.

### Still open

1. **Legal review** of the drafts, then `LEGAL_IN_FORCE` (owner + counsel).
2. **GDPR formal review** + a written data-residency commitment (the deployment is EU-only today).
3. **A rehearsed restore** for Postgres and Neo4j (`docs/runbooks/disaster-recovery.md` §6).
4. **Penetration test** — vendor TBD.
5. **SOC 2 Type I gap assessment → Type II observation period** (~12-18 months total); **ISO 27001** alongside (~30% overlap).
6. **Org-wide MFA policy** and httpOnly cookie storage for tokens.
7. **Per-tenant database option** ("Dedicated Instance" tier) for customers who explicitly request stricter isolation.

---

## Incident response

1. Acknowledge: PagerDuty + incident channel within 15 minutes
2. Contain: revoke affected JWTs, rotate compromised keys, block IPs if needed
3. Eradicate: identify root cause, deploy fix
4. Recover: verify normal operation, confirm with affected customers
5. Notify: customers within 72h of confirmed data breach (GDPR Article 33)
6. Post-mortem: blameless within 7 days, published internally + summary to affected customers
7. Track: every incident logged in `audit_events` with `action='incident.*'`

The runbook is `docs/runbooks/incident-response.md`; the quarterly rehearsal it asks for has not happened yet.

---

## Contact

Security issues → `security@clarion.io` (configure when domain ready)
PGP key → TBD

Responsible disclosure policy → TBD (not yet written)

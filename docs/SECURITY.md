# Security Posture — Clarion

> Last updated: 2026-05-12 (post-Sprint 1 hardening)
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

**Gaps still open:**

- No MFA. Planned as Sprint 3 when first enterprise customer asks.
- Refresh tokens stored in localStorage (not httpOnly cookies). XSS protection is therefore not absolute — partially mitigated by short access-token lifetime + server-side revocation. httpOnly cookies are a follow-up.

---

## Tenant data isolation

| Control | Implementation |
|---|---|
| RLS on every tenant table | 27+ tables enabled originally; migration `20260512000056_force_rls_audit.ts` enforces FORCE on all tables with a `tenant_id` column |
| Per-request transaction | `requireAuth` opens a `SET LOCAL`-scoped transaction; routes use `req.dbTrx` for guaranteed-isolated queries |
| Tenant context propagation | JWT → `req.user.tenantId` → `SET LOCAL app.current_tenant` inside transaction |
| Warehouse path isolation | Default `WAREHOUSE_LAYOUT_VERSION=v2` (tenant-prefixed). Per-tenant blob path prefixes. |
| DuckDB query scope | Each DuckDB session receives URIs from the (tenant-RLS-filtered) catalog only |

**Gaps still open:**

- Many older routes still use global `semanticDb` instead of `req.dbTrx`. They fall back to the session-level `SET app.current_tenant` which has a known pool-leak race condition. Routes are being migrated incrementally; **mutation endpoints and security-sensitive reads have been migrated first**.

---

## Secrets management

| Control | Implementation |
|---|---|
| Connection credentials | AES-256-GCM with random IV, packed `iv:authTag:ciphertext` base64. Key sourced from `CREDENTIALS_ENCRYPTION_KEY` env / Azure Key Vault. |
| Production safety guard | Backend refuses to encrypt or decrypt when key is missing in `NODE_ENV=production` |
| Secret store | Azure Key Vault (`db-prod-kv-*`). Backend reads via managed identity. |
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
| Currently audited actions | `user.invite`, `user.update`, `user.deactivate`, `user.reactivate`, `connection.delete`, `product.delete` |

**Gaps still open:**

- Audit log UI on `/users` for admins (planned Sprint 2)
- Some mutation endpoints not yet wired to `recordAudit` — incremental migration

---

## Network & infrastructure

| Control | Implementation |
|---|---|
| TLS | Azure Container Apps + Front Door, TLS 1.2 minimum on storage account |
| Postgres firewall | Allows Azure services only + explicit local IPs for migration runs |
| Container Apps egress | Default Azure egress (no explicit firewall) |
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

**Gaps still open:**

- Neo4j data on file share without cross-region replication. Lower-priority because Neo4j is rebuildable from Postgres state (`migrateSemanticToNeo4j.ts`).
- No documented RTO/RPO commitments. Tracked for Sprint 3.

---

## CI / supply chain

| Control | Implementation |
|---|---|
| Dependency vulnerability scan | `npm audit --audit-level=high` on every PR (backend fails build; frontend warns) |
| Type-check gate | Strict `tsconfig.build.json` compile in CI |
| Test gate | Vitest suite runs against a Postgres service container |
| Image signing | Not yet — planned |
| SBOM | Not yet — planned for Sprint 3 |
| Dependabot | Weekly updates for backend, frontend, GitHub Actions |

---

## What's NOT yet in place (honest)

These are real gaps. Listed so we're transparent with customers and ourselves.

### Short-term (Sprint 2 — partially shipped)

- ✅ **JWT refresh tokens + revocation** — 15-min access + 30-day refresh; revokeAll on password change / role change / deactivate
- ✅ **Audit log UI** — `/users → Audit log` (admin only)
- ✅ **Public `/security` page**
- ⚠️ **Migrate remaining routes to `req.dbTrx`** — incremental migration. Done so far: every mutation on `users.ts`, `connections.ts`, `policies.ts`; `dashboards.ts` POST + DELETE; `products.ts` POST. The remaining read endpoints + non-critical mutations still use the session-level SET fallback (which IS racy under concurrency). Helper at `db/reqDb.ts` (`const db = reqDb(req)`) is the migration pattern.
- 🟦 **Penetration test** — budget allocated, vendor TBD.

### Medium-term (Sprint 3 — 1-2 months)

5. **DPA template + sub-processor list** (legal).
6. **Public security page** at `clarion.io/security` summarising the above.
7. **GDPR formal review** + data residency commitment (EU-only deployment).
8. **Incident response runbook** + breach notification SLA.

### Long-term (Sprint 4 — when first enterprise asks)

9. **SOC 2 Type I gap assessment → Type II observation period** (~12-18 months total).
10. **ISO 27001** alongside SOC 2 (~30% overlap).
11. **MFA**.
12. **Per-tenant database option** ("Dedicated Instance" tier) for customers who explicitly request stricter isolation.

---

## Incident response

1. Acknowledge: PagerDuty + incident channel within 15 minutes
2. Contain: revoke affected JWTs, rotate compromised keys, block IPs if needed
3. Eradicate: identify root cause, deploy fix
4. Recover: verify normal operation, confirm with affected customers
5. Notify: customers within 72h of confirmed data breach (GDPR Article 33)
6. Post-mortem: blameless within 7 days, published internally + summary to affected customers
7. Track: every incident logged in `audit_events` with `action='incident.*'`

**Runbook not yet formalised. Tracked Sprint 3.**

---

## Contact

Security issues → `security@clarion.io` (configure when domain ready)
PGP key → TBD

Responsible disclosure policy → TBD (template in `docs/responsible-disclosure.md` once created)

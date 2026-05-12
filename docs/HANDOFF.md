# Handoff — security & platform hardening

> Single source of truth for "what's done, what's next, why each piece
> matters." Updated 2026-05-12.
>
> Read this first before touching auth, the catalog, or the data
> warehouse. Several decisions here are deliberate trade-offs that look
> wrong without context.
>
> Companion docs:
> - `docs/SECURITY.md` — posture / controls / known gaps (customer-facing tone)
> - `docs/runbooks/db-role-flip.md` — the production DB role switch
> - `CLAUDE.md` — broader codebase context

---

## Mental model — where the platform stands today

### Architecture (shared-compute, hard-isolated-data)

One backend serves all tenants. Tenants are isolated by, in order of importance:

1. **Postgres Row-Level Security (RLS) + FORCE RLS** on every table with a `tenant_id` column. The database is the final arbiter; even buggy application code can't return another tenant's rows.
2. **Per-request tenant transaction** — `requireAuth` opens a Knex transaction, runs `SET LOCAL app.current_tenant = '<id>'` inside it, attaches `req.dbTrx`. Routes that use `req.dbTrx` (via `reqDb(req)`) are bulletproof against connection-pool reuse races.
3. **Per-tenant storage paths** — `tenant_<id>/conn_<cid>/...` for sources, `tenant_<id>/product_<pid>/...` for products. Defense-in-depth: even with an application-layer leak, blob paths physically segregate data.

This is industry-standard for B2B SaaS (Stripe, Notion, Slack all do it). SOC 2 and ISO 27001 accept it. **Don't change this model** unless a customer with regulated-industry requirements demands per-tenant compute — even then, it should be an opt-in "Dedicated Instance" tier, not the default.

### Auth model

- **Access token**: 15-minute HS256 JWT. Carried as `Bearer ...` on every request.
- **Refresh token**: 30-day random string, stored sha256-hashed in `refresh_tokens`. Server-side revocable.
- **MFA (TOTP)**: optional; when enabled, login returns an `mfaRequired: true` response with a short-lived challenge token instead of access+refresh. `POST /auth/mfa/verify` swaps challenge + code → real tokens.
- **Cascade revocations**: password change, password reset, user deactivate, role change all call `revokeAllForUser()` — every device gets kicked out.

### Audit model

`audit_events` is append-only (`databridge_app` has SELECT+INSERT only — no UPDATE/DELETE). Every administrative mutation should call `recordAudit(req, { action, entityType, entityId, context })`. Failures NEVER break the underlying action — audit gaps are recoverable, 500s on a role change are not.

---

## Code patterns to keep using

### Pattern 1: `reqDb(req)` for tenant-scoped queries

```typescript
import { reqDb } from '../db/reqDb';
import { recordAudit } from '../services/auditService';

router.post('/foo', requireAuth, async (req, res, next) => {
  try {
    const db = reqDb(req);
    const [row] = await db('foos').insert({ ... }).returning('id');
    await recordAudit(req, {
      action: 'foo.create',
      entityType: 'foo',
      entityId: (row as { id: number }).id,
      context: { /* relevant input */ },
    });
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});
```

**Use this in every new mutation endpoint.** Existing routes that still use the global `semanticDb` work (the session-level `SET` in `requireAuth` covers them) but are racy under concurrency.

### Pattern 2: Audit verbs

Namespaced by entity. Verbs so far:
- `user.invite / .update / .deactivate / .reactivate / .password_change`
- `connection.create / .update / .delete`
- `product.create / .delete`
- `policy.create / .update / .delete`
- `mfa.enable / .disable / .regenerate_backup_codes`

**Match the pattern** (`<entity>.<verb>`) when adding new ones.

### Pattern 3: Revoke refresh tokens on security-relevant state changes

Anywhere a user's privileges or identity change, revoke their refresh tokens so they're forced to re-auth within at most one access-token lifetime (15 min):

```typescript
import { revokeAllForUser } from '../services/refreshTokenService';

// After a role downgrade, deactivation, password change, etc.:
try {
  await revokeAllForUser(userId, 'role_change');  // or 'password_change' / 'deactivation'
} catch (err) {
  // Log but don't fail the parent action
}
```

---

# Remaining tasks, in priority order

## TASK 1 — Finish the `req.dbTrx` route migration

### What

About 20 of the 25 route files still use `semanticDb(...)` directly instead of `reqDb(req)`. Migrate them.

### Why this matters

Today, `requireAuth` opens a per-request transaction AND also fires a session-level `SET app.current_tenant`. Routes that use `req.dbTrx` are isolated by the transaction. Routes that use the global `semanticDb` rely on the session-level SET — which is **racy under concurrency** because Knex's connection pool can hand request B a connection still configured for request A.

The session SET happens BEFORE the request body runs, so for routes that fire a single query the race window is small. For routes that fire many queries (most of products.ts, dashboards.ts, semantic.ts), the window grows.

RLS + FORCE RLS still protects you (a wrong tenant id means no rows match, not wrong rows returned), but the migration is the textbook fix.

### How

For every route file with mutations or sensitive reads:

1. Add the import at the top:
   ```typescript
   import { reqDb } from '../db/reqDb';
   ```
2. Inside each authenticated handler, replace the first uses of `semanticDb(...)` with:
   ```typescript
   const db = reqDb(req);
   // ... use db('table') instead of semanticDb('table') below ...
   ```
3. For helper functions called by the route, pass `db` as a parameter rather than importing `semanticDb` directly.
4. Routes that already use the `tenantQuery(...)` helper are fine — that helper opens its own transaction with `SET LOCAL` and is correct.

**Files still to migrate** (approximate priority order, mutations first):

- `routes/products.ts` — already has `POST /` + `DELETE /:id` migrated. Remaining: `POST /:id/design`, `POST /:id/refine`, `POST /:id/refine/apply`, `POST /:id/run`, `POST /:id/kpis`, `PUT /:id`, `PATCH /columns/:id`, etc. ~30 endpoints.
- `routes/semantic.ts` — relationship + KPI + glossary mutations. ~15 endpoints. Note: many touch Neo4j too (via `graph.*`); the migration here is only for Postgres queries.
- `routes/dashboards.ts` — already has `POST /` + `DELETE /:id`. Remaining: `PATCH /:id`, `PATCH /:id/favorite`, `POST /templates`, `POST /from-template`, `POST /:id/duplicate`. ~10 endpoints.
- `routes/quality.ts` — quality rule CRUD.
- `routes/schedules.ts`, `routes/connectionSyncSchedules.ts` — schedule CRUD.
- `routes/notebooks.ts` — notebook CRUD.
- `routes/pulse.ts` — pulse-entry CRUD.
- `routes/emailSchedules.ts`, `routes/conversations.ts`, `routes/notifications.ts`, `routes/briefs.ts`, `routes/investigations.ts`, `routes/reports.ts` — lower priority, mostly user-scoped reads.
- `routes/query.ts`, `routes/ingestion.ts`, `routes/pipelines.ts`, `routes/settings.ts`, `routes/sources.ts`, `routes/cross-views.ts`, `routes/jobs.ts` — lower priority.

### Definition of done

- Every `semanticDb(...)` call inside an authenticated handler is replaced with a `reqDb(req)` or `tenantQuery()` equivalent.
- Type-check passes (`npx tsc --project tsconfig.build.json`).
- No new audit log entries needed (the existing migration is enough — only ADD audit calls for routes where the action is admin-significant).
- Smoke test: log in, exercise each migrated route, verify nothing 500s.

### Effort

1-2 days of mechanical work for one engineer. Can be split into batches by route file. Update `docs/SECURITY.md`'s "Migrate remaining routes" section as you finish each file.

---

## TASK 2 — Switch production backend to the unprivileged DB role

### What

The production backend connects to Postgres as the admin role `databridge` (because `NODE_ENV=production` sets `useAppRole = false` in `db/knex.ts`). The unprivileged role `databridge_app` exists and has the GRANTs it needs, but isn't being used.

### Why this matters

Even though `FORCE ROW LEVEL SECURITY` protects you when running as admin (because FORCE applies to the table owner too), defense-in-depth requires using the unprivileged role. Reasons:

1. **If a future migration adds a table and forgets `FORCE RLS`**, the admin connection would silently bypass RLS on that table. With `databridge_app`, a missing policy means "no rows returned" — which is the fail-safe direction.
2. **Auditors specifically ask** whether your application connects with least privilege. SOC 2 CC6 references this.
3. **It's the one item left on the Sprint 1 security plan** — closes the loop on the role-separation discipline.

### How

Follow `docs/runbooks/db-role-flip.md`. The short version:

1. Pre-flight: verify the role exists, verify all sequences have USAGE granted, verify every tenant table has FORCE RLS (migration `20260512000056` already enforces this).
2. Update `DATABASE_URL` in Azure Key Vault to use `databridge_app:<password>@...` instead of `databridge:<password>@...`.
3. Restart the backend Container App.
4. Smoke-test within 2 minutes — watch logs for `permission denied for table ...` errors.
5. Roll back by flipping `DATABASE_URL` back if anything breaks. ~30 second recovery.
6. After 24h of stable operation, delete the `useAppRole` toggle from `db/knex.ts` so the invariant holds.

### Definition of done

- Backend connects as `databridge_app` in production.
- Migration `20260512000056` runs cleanly (already does — verify in CI).
- `db/knex.ts` no longer has the `NODE_ENV !== 'production'` toggle for the role.
- `docs/SECURITY.md` updated to remove this from the "still open" list.

### Effort

30 minutes if everything works the first time. Budget 2 hours including verification + the cleanup PR.

### Risk

LOW. Easy to roll back. Only fails if a table is missing a GRANT — which would surface immediately in logs.

---

## TASK 3 — Apply the Terraform infrastructure changes

### What

Three Terraform changes are coded in `infra/main.tf` but not yet applied to production:

1. Postgres `backup_retention_days = 14` and `geo_redundant_backup_enabled = true`.
2. Storage account `account_replication_type = "GRS"` (was LRS) + blob versioning + 30-day soft-delete.
3. Key Vault `soft_delete_retention_days = 90` and `purge_protection_enabled = true`.

The user explicitly held back on applying these earlier in the security sprint.

### Why this matters

| Change | What it protects against |
|---|---|
| **Postgres geo-redundant backups** | A single-region Azure outage (rare but documented; West Europe has had multi-hour outages). Without geo-redundancy, a major regional incident means data loss + extended downtime. |
| **GRS storage** | Same — warehouse data (Parquet/Delta files) survives a region outage. |
| **Blob versioning + 30-day soft-delete** | A bad refresh that overwrites correct data can be recovered. Today, you lose the previous version on every refresh. |
| **Key Vault purge protection** | A panicked operator or malicious admin can't permanently delete secrets within 90 days. Recovery window for accidental deletes. **WARNING: once enabled, the vault can NEVER be deleted** — that's the point. |

The cost increase is small (~2× the storage component, single-digit % of total Azure bill). The downside of NOT having these is "we lose data in a regional outage scenario," which is a real auditor concern and a real customer concern.

### How

```bash
cd infra
terraform plan -out=tfplan.bin
# Review the diff carefully — particularly the storage account
# replication change (LRS → GRS triggers a one-time geo-replication
# seeding which takes 24-48h to complete) and the Key Vault purge
# protection (IRREVERSIBLE once enabled).
terraform apply tfplan.bin
```

The Postgres backup change is non-disruptive (just retention + region mirror).
The storage account change is non-disruptive (existing data keeps serving from the primary region; geo-replication runs in background).
The Key Vault change is **one-way** — once `purge_protection_enabled=true`, you can't disable it. That's the design.

### Definition of done

- `terraform apply` succeeds.
- Azure Portal shows GRS replication on the storage account, geo-redundant backups on Postgres, purge protection on Key Vault.
- Update `docs/SECURITY.md` "Data durability" section to move these to "enabled" rather than "configurable."

### Effort

15 minutes if `terraform plan` looks clean. Extra time only if a sub-resource has drifted from the Terraform state.

### Risk

LOW for Postgres + Storage. **MEDIUM for Key Vault purge protection** — once enabled, irreversible. Worth a moment of "are we sure" before applying. The alternative scenarios where you'd want to disable it (recreate the vault from scratch) are recoverable via the 90-day soft-delete window.

---

## TASK 4 — WebAuthn / passkeys alongside TOTP

### What

The current MFA is TOTP (6-digit codes from an app). Add WebAuthn so users can register a hardware key (YubiKey, Touch ID, Windows Hello, etc.) as a second factor.

### Why this matters

- **TOTP is phishable.** A user can be tricked into typing their 6-digit code into a fake login page within the 30-second window.
- **WebAuthn is phishing-resistant** because the credential is cryptographically bound to the domain. A phishing site cannot use it.
- **Many enterprise customers will ask for WebAuthn** specifically when comparing vendors. Salesforce, Slack, Google Workspace, Microsoft 365 all support it.
- TOTP can stay as a fallback (and for users without WebAuthn-capable devices).

### How

1. **Add `@simplewebauthn/server`** to the backend dependencies.
2. **Migration**: new `webauthn_credentials` table with `user_id`, `credential_id`, `public_key`, `counter`, `transports`, `created_at`, `last_used_at`. RLS + FORCE RLS.
3. **Backend endpoints**:
   - `POST /api/auth/webauthn/register-options` → returns challenge + RP info for the browser's `navigator.credentials.create()`.
   - `POST /api/auth/webauthn/register-verify` → verifies the attestation, stores the credential.
   - `POST /api/auth/webauthn/login-options` → returns challenge + allowed credential IDs.
   - `POST /api/auth/webauthn/login-verify` → verifies the assertion, issues access+refresh tokens.
4. **Frontend**: extend `MfaSection` on `/profile` with a "Add a hardware key" button. Extend login page to offer WebAuthn first if the user has any credentials registered.
5. **Recovery**: backup codes (already implemented for TOTP) cover the "lost device" case. WebAuthn credentials don't need separate recovery — users register multiple keys.

### Definition of done

- A user can register a WebAuthn credential from `/profile`.
- A user with WebAuthn registered can log in using it.
- Backup codes still work as a fallback.
- TOTP still works for users who haven't enrolled WebAuthn.
- Audit events `mfa.webauthn_register` and `mfa.webauthn_remove` captured.

### Effort

1-2 days for one engineer comfortable with the WebAuthn spec. The `@simplewebauthn/server` library handles most of the protocol complexity.

### Risk

LOW. Additive feature — doesn't disturb the existing TOTP flow.

---

## TASK 5 — Self-service "Log out everywhere" UI + admin MFA-reset

### What

Two small UX additions that the API already supports:

### 5a. "Log out everywhere" on `/profile`

The endpoint `POST /api/auth/logout-all` exists (revokes every refresh token for the calling user). There's no UI for it yet.

### Why

A user who thinks their account was compromised needs a single-click way to kick themselves out of every device. Today they'd have to either change their password (which is a hassle) or contact an admin.

### How

Add a button on `/profile` near the password change section: "Log out of every device." On click → `POST /api/auth/logout-all` → toast confirmation → redirect to `/`.

### Effort

30 minutes.

### 5b. Admin MFA reset

If a user loses both their authenticator AND their backup codes (rare but happens — phone broken + codes lost), there's no recovery path except a direct database UPDATE today.

### Why

This is operational. Without it, "I lost my phone and my backup codes" is a support ticket that requires a developer with DB access. Not scalable.

### How

1. Backend: new endpoint `POST /api/users/:id/reset-mfa` (admin only) that calls `disableMfa(userId)`. Already audit-logged via the existing `mfa.disable` verb (extend the audit context with `reset_by_admin: true`).
2. Frontend: add a "Reset MFA" button on the user row in `/users` (admin only). Confirm with a modal ("This will let the user log in without MFA until they re-enrol. Continue?").

### Effort

1-2 hours total for both pieces.

### Risk

LOW. Admin role required + audit-logged.

---

## TASK 6 — Penetration test

### What

Hire an external security firm to attack the platform. They try to:
- Bypass authentication / RLS / tenant isolation
- Find injection points (SQL, NL→SQL, dashboard SQL)
- Find privilege escalation paths
- Exploit any business-logic flaws

### Why this matters

- **Most enterprise procurement processes ask for a pentest report.** Without one, they fall back to a much longer security questionnaire.
- **A pentest finds bugs that internal review misses.** Especially around the NL→SQL surface where prompt injection could become a real attack vector.
- **Best done after the route migration is complete** (Task 1), so the pentest tests the final state rather than an in-flight migration.

### How

1. **Scope it.** Decide what's in: auth + RLS + NL→SQL (definitely); the AI prompt injection vector (definitely); the warehouse blob storage (definitely); the marketing site (maybe). The narrower the scope, the cheaper.
2. **Pick a vendor.** EU-based for GDPR alignment. Common picks: Computest (NL), Cure53 (DE), NCC Group (UK/EU). Budget €5-10K for a 1-2 week focused engagement; €15-25K for a broader assessment.
3. **Provide the test plan**: scoped to a clone environment with seed data, a test admin account, a test analyst account. Don't pentest production unless they specifically need to.
4. **Triage findings**: critical → fix this week; high → fix this sprint; medium → backlog; low → document.
5. **Report**: you get a sanitized version of the report to share with prospects. They get the unsanitized version to file away.

### Definition of done

- Test executed.
- All critical + high findings remediated.
- A summary report exists that you can share with prospects under NDA.

### Effort

2-3 weeks calendar time, ~€5-10K external spend, plus engineering time to remediate findings (size depends on what they find).

### Risk

LOW operationally (they test a clone). Findings might be uncomfortable — that's the point.

---

## TASK 7 — Data Processing Agreement (DPA) + sub-processor list

### What

Legal documents, not engineering work. Two pieces:

1. **DPA template** — the contract every customer needs to sign for GDPR compliance.
2. **Sub-processor list** — every third-party service that processes customer data on your behalf (Microsoft Azure, Anthropic for AI, Resend/SendGrid for email if used, etc.).

### Why this matters

- **GDPR Article 28 requires a DPA** in writing between you (processor) and your customer (controller) for any EU customer.
- **Without a DPA, you cannot legally process EU customer data.** This is non-optional once you have an EU customer.
- The sub-processor list goes alongside — customers want to know which vendors touch their data.

### How

1. Hire an EU-tech-savvy lawyer to draft the DPA template. Budget €2-5K. They'll use a standard template (typically based on the EU Commission's Standard Contractual Clauses) and customize for your specifics.
2. Inventory every external service the platform calls:
   - Azure (data + compute + Key Vault)
   - Anthropic API (every NL→SQL query, every AI design, every brief)
   - Sentry / Application Insights (errors + telemetry; if PII is captured, document)
   - GitHub (source code; not customer data, but list anyway)
   - Any SMTP provider for email
   - Future: payment processor when you start charging
3. Write each sub-processor's purpose + data categories + region into the list.
4. Publish: the DPA template at `clarion.io/dpa`, the sub-processor list at `clarion.io/security/subprocessors`.
5. Notification procedure: when you add or change a sub-processor, customers get 30 days' notice (standard term).

### Definition of done

- DPA template available for customers to sign.
- Sub-processor list public and current.
- Internal process exists for vetting new sub-processors before adoption.

### Effort

1-2 weeks calendar time. 80% legal work, 20% you assembling the list.

### Risk

NONE technically. The risk is legal — operating without a DPA when you have an EU customer is a regulatory violation. Resolve before signing your first paid EU customer.

---

## TASK 8 — SOC 2 Type II

### What

The big one. SOC 2 is an external audit attesting that you have the controls in place to handle customer data securely. Two flavours:

- **Type I**: point-in-time assessment ("on date X, these controls existed"). Cheaper, faster.
- **Type II**: observation period assessment ("over the past N months, these controls operated effectively"). What enterprises actually want.

### Why this matters

- **US enterprise customers (and an increasing number of EU ones) require SOC 2** before signing a paid contract. The deal-breaker question is "do you have SOC 2 Type II?"
- **Without it, you cannot sell to most enterprises**, full stop. You can sell to SMB and mid-market without.
- The audit forces discipline — quarterly access reviews, formal incident response, vendor management, etc.

### How

1. **Gap assessment** (Type I prep): hire a SOC 2 firm (Drata, Vanta, Tugboat Logic, etc. — they're as much SaaS-platforms-for-compliance as audit firms) for €5-10K. They scan your current controls vs the SOC 2 Trust Services Criteria. Output: a list of gaps.
2. **Remediate** the gaps. Most of what you'd find:
   - Formal access reviews (we have audit log; need quarterly review procedure)
   - Formal incident response runbook
   - Vendor risk assessment process
   - Background checks for employees with prod access
   - Security awareness training
3. **Type I audit**: same firm certifies you're at the bar. €10-20K. One-time.
4. **Observation period** (6-12 months): controls must operate effectively continuously. The firm collects evidence quarterly.
5. **Type II audit**: €15-30K final audit at the end of the observation period. Output: the SOC 2 Type II report.

Total: 12-18 months from kickoff. €40-60K end-to-end.

### Why I'm NOT recommending you start this yet

**Don't pursue SOC 2 until you have a real customer asking for it.** Reasons:

- The certification cost is wasted until you can monetize it.
- The internal process burden (quarterly access reviews, formal vendor assessments, etc.) slows engineering velocity. Worth it for paying enterprise customers; pure overhead before.
- You can pass most SMB and mid-market security questionnaires honestly today by pointing at `docs/SECURITY.md` and `clarion.io/security`.

Trigger: first prospect who says "we can't sign without SOC 2." Then start.

### Definition of done

- SOC 2 Type II report exists, dated within the past 12 months.
- Available to prospects under NDA.

### Effort

12-18 months calendar. €40-60K direct cost. ~20% of one engineer's time during the observation period (collecting evidence, responding to audit requests).

### Risk

The bigger risk is starting too early and burning capital. Wait for demand.

---

## TASK 9 — ISO 27001

### What

The European / international equivalent of SOC 2. Different framework, similar concept.

### Why this matters

- **Some European enterprise customers explicitly require ISO 27001** rather than SOC 2.
- About 60% of the controls overlap with SOC 2 — if you've done one, the other is much cheaper.
- More process-heavy than SOC 2 (formal Information Security Management System — ISMS).

### When

After SOC 2 Type II. Don't start before.

### Effort

If after SOC 2: ~30% additional work, ~€20-30K incremental audit cost.
If before SOC 2: full burden, €30-50K.

---

## Things explicitly NOT to do

These show up on best-practices lists but I'd advise against pursuing them:

### Per-tenant compute / per-tenant database

The "ultimate isolation" model where each customer gets their own backend + database + storage. Costs 5-10× current Azure bill. Operationally complex. **Not what your market expects.** Reserve as a possible "Dedicated Instance" tier (3-5× list price) for customers who explicitly request and pay for it — but never make it the default.

### Rolling your own MFA app

A few SaaS vendors have built their own authenticator apps. Don't. The TOTP standard works perfectly fine with every existing authenticator (Google Authenticator, 1Password, Authy, Bitwarden, etc.) and you avoid an entire mobile-app supply chain.

### httpOnly cookies for refresh tokens

The "right" way to store refresh tokens is in an httpOnly cookie (XSS-resistant). Today they're in `localStorage`, which is XSS-vulnerable. But: moving to cookies requires CORS-with-credentials, CSRF protection on every mutation, and a significant frontend refactor. The short access-token lifetime (15 min) + server-side revocation already mitigates the XSS impact substantially. Consider this for Sprint 6+ if a security audit flags it; not urgent.

### Web Application Firewall (WAF) in front of Azure Container Apps

Azure Front Door has WAF features. Worth enabling eventually but the current rate limiting + input validation covers the OWASP Top 10 reasonably well at SMB scale. Defer until a pentest specifically recommends it.

---

# Suggested execution order

If you have one engineer for a focused security sprint:

| Week | Task | Output |
|---|---|---|
| 1 | TASK 1 (route migration) | All authenticated mutation routes on `req.dbTrx` |
| 1 (parallel) | TASK 2 (DB role flip) | Production runs as `databridge_app` |
| 1 (parallel) | TASK 3 (Terraform apply) | Geo-redundancy + Key Vault purge protection live |
| 2 | TASK 4 (WebAuthn) | Hardware keys supported alongside TOTP |
| 2 | TASK 5 (Logout-all UI + admin MFA reset) | Self-service + admin recovery flow |
| 3-4 | TASK 6 (pentest scoping + execution) | External pentest report |
| 3-6 | TASK 7 (DPA + sub-processor list) | Legal docs available |
| Later | TASK 8 + 9 (certifications) | When customer demand justifies the spend |

---

# Key files & where to find things

| Thing | File |
|---|---|
| Per-request transaction setup | `backend/src/middleware/auth.ts` (the `requireAuth` middleware opens `req.dbTrx`) |
| `reqDb(req)` helper | `backend/src/db/reqDb.ts` |
| Audit service | `backend/src/services/auditService.ts` |
| Refresh token service | `backend/src/services/refreshTokenService.ts` |
| MFA service | `backend/src/services/mfaService.ts` |
| Encryption helpers | `backend/src/utils/crypto.ts` |
| Logger config | `backend/src/utils/logger.ts` |
| Rate limit config | `backend/src/index.ts` |
| Migrations | `backend/src/db/migrations/` (numbered chronologically) |
| Security maintenance cron | `backend/src/jobs/securityMaintenanceJob.ts` |
| MFA UI | `frontend/app/profile/page.tsx` (`MfaSection` component) |
| Audit log UI | `frontend/app/users/page.tsx` (`AuditLogPanel` component) |
| Login flow with MFA challenge | `frontend/app/page.tsx` |
| Public security page | `frontend/app/security/page.tsx` |
| Internal security doc | `docs/SECURITY.md` |
| DB role flip runbook | `docs/runbooks/db-role-flip.md` |

---

# What to ask the team / customer before starting each task

Before TASK 2 (DB role flip): "Do we have a 30-minute window where it's OK if a transient deploy bug causes 500s?" If yes, do it. Roll-back is fast.

Before TASK 3 (Terraform): "Are we OK with the IRREVERSIBLE Key Vault purge protection toggle?" Yes is the right answer for a customer-data-handling platform, but it should be a conscious choice.

Before TASK 6 (pentest): "Do we have a clone environment they can hit, or do we provision one? Do we have synthetic test data?"

Before TASK 8 (SOC 2): "Is a specific customer asking for it, and are they willing to sign a contract conditional on it?" If no, defer.

---

# In one paragraph

The platform's architecture is sound; the work remaining is making the implementation match. Finishing the database-session migration and switching to the unprivileged DB role closes out the security-architecture story. Applying the Terraform infrastructure changes closes out the durability story. WebAuthn and the admin MFA-reset close out the auth story. The pentest validates everything. The legal documents (DPA, sub-processor list) make the platform legally usable in the EU. Certifications follow customer demand — don't chase them.

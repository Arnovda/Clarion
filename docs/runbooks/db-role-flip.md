# Runbook: switch production backend to `databridge_app` DB role

> **Read this box before the rest of the document. Two of its original claims
> were wrong, and acting on them would have taken production down.**
>
> **Goal:** make the production backend connect as the RLS-enforced
> `databridge_app` role instead of the admin `databridge` role. This is not
> defence-in-depth polish — it is the step that makes row-level security do
> anything at all. A superuser bypasses RLS unconditionally, and
> `FORCE ROW LEVEL SECURITY` binds the table OWNER, not a superuser. Until this
> flip happens, every `tenant_isolation` policy in the database is inert and
> isolation rests entirely on the application's own tenant filters.
>
> **Corrected — "FORCE RLS already protects us if a single migration was
> missed".** It does not, against the role production actually uses. See above.
>
> **Corrected — "the migrations grant … on every tenant table consistently".**
> They did not. Migrations granted per-table only from `20260502000041`
> onwards; the entire original schema — `users`, `tenants`, `connections`,
> `dashboards` — was granted by hand, out of band, by whoever last followed
> this document. Worse, `20260512000056` enabled RLS on every table with a
> `tenant_id` column while only the 27 tables in `20260403000020` ever got a
> policy, and **a table with RLS enabled and no policy denies every row**.
> `users` was one of them. Performing this runbook as originally written would
> have failed every login and every registration.
>
> Both gaps are closed by migrations `20260804000074` (policies) and
> `20260804000075` (grants, including `ALTER DEFAULT PRIVILEGES` so a future
> table cannot reopen it). Apply them before flipping.
>
> **Do not perform the manual steps below.** They are kept as reference for
> understanding and for diagnosing a specific failure. The flip itself is now:
>
> 1. `cd backend && DATABASE_URL='<admin url>' npx tsx scripts/preflight-role-flip.ts`
>    — read-only; exits 0 only when every table has a policy and every grant is
>    present, and names the blockers when it does not.
> 2. Set the `DATABASE_URL_APP` repository secret to the `databridge_app`
>    connection string.
> 3. Set `.ops/db-role` to `app` and push.
>
> The workflow re-runs the preflight, shifts traffic only after the new
> revision provisions, then proves the new role can read a real table — a login
> attempt with a nonsense address must return 401, not 500 — and **returns
> traffic to the previous revision by itself** if it cannot.
>
> **Reversibility:** set `.ops/db-role` back to `admin` and push. The workflow
> also rolls back on its own on a failed verification.
>
> **What to watch after a successful flip:** `42501 insufficient_privilege` in
> the logs. That is a missing grant on a table no code path had touched during
> verification.

---

## Pre-flight checks (do these first)

### 1. Verify the role exists in prod Postgres

Connect to the Azure Postgres Flexible Server as admin (`databridge`):

```sql
SELECT rolname FROM pg_roles WHERE rolname = 'databridge_app';
-- Expect: 1 row.
```

If 0 rows, create it:

```sql
CREATE ROLE databridge_app WITH LOGIN PASSWORD '<set a strong password>';
GRANT CONNECT ON DATABASE databridge TO databridge_app;
GRANT USAGE ON SCHEMA public TO databridge_app;
```

Then re-run the most recent migrations so each table grants
`SELECT/INSERT/UPDATE/DELETE` to `databridge_app`:

```bash
cd backend
DATABASE_URL=postgresql://databridge:...@host/databridge npx knex migrate:rollback --all
DATABASE_URL=postgresql://databridge:...@host/databridge npx knex migrate:latest
```

(Migrations are idempotent; running `latest` is safer than re-running
individual ones.)

### 2. Verify every tenant table has FORCE RLS

```sql
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND EXISTS (
    SELECT 1 FROM information_schema.columns col
    WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
  )
ORDER BY c.relname;
```

**Expected: every row has both `rls_enabled` and `rls_forced` = `t`.**

If any are `f`, the FORCE-RLS audit migration (`20260512000056`)
should have fixed it. Re-run `npx knex migrate:latest`.

### 3. Verify `databridge_app` has the GRANTs it needs

Pick a few tenant tables and check:

```sql
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee = 'databridge_app'
  AND table_name IN ('users', 'connections', 'data_products', 'audit_events', 'refresh_tokens')
ORDER BY table_name, privilege_type;
```

**Expected: SELECT, INSERT, UPDATE, DELETE on each.**

### 4. Verify `databridge_app` has USAGE on sequences

```sql
SELECT n.nspname AS schema, c.relname AS sequence, r.rolname AS grantee, has_sequence_privilege('databridge_app', n.nspname || '.' || c.relname, 'USAGE') AS has_usage
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN pg_roles r
WHERE c.relkind = 'S'
  AND n.nspname = 'public'
  AND r.rolname = 'databridge_app';
```

Any sequence without USAGE will block INSERTs on auto-increment tables.
Backfill with:

```sql
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO databridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO databridge_app;
```

---

## The flip

### 5. Update the production env

The backend reads the DB connection string from `DATABASE_URL`. Currently
it's set to the admin role. Update it to the unprivileged role:

**Where:** Azure Key Vault → secret `database-url` (or wherever
`DATABASE_URL` is sourced — check `infra/main.tf` for the binding).

Change FROM:
```
postgresql://databridge:<admin-pwd>@<host>:5432/databridge?sslmode=require
```
TO:
```
postgresql://databridge_app:<app-pwd>@<host>:5432/databridge?sslmode=require
```

Update the Key Vault secret, then restart the backend Container App:

```bash
az containerapp revision restart --name databridge-backend --resource-group databridge-rg
```

(Container Apps reads Key Vault secrets at startup, so a restart picks
up the new value.)

### 6. Smoke test

Within 2 minutes of the new revision being ready:

1. Open `/home` as a normal user — should load.
2. Hit `/users` as an admin — list should populate.
3. Trigger a refresh on any product — should run end-to-end.
4. Check backend logs for any `permission denied for table ...` errors.
   If you see any, that table needs an explicit GRANT. Add it as a one-off
   SQL or create a follow-up migration.

If anything is broken:

```bash
# Roll back: change DATABASE_URL back to the admin user
az containerapp revision restart --name databridge-backend --resource-group databridge-rg
```

Total downtime should be the restart window (~30 seconds with
scale-from-zero, ~5 seconds otherwise).

### 7. Update knex.ts to remove the "always admin in prod" override

**Pre-completed in code.** The `useAppRole` toggle has been removed
from `backend/src/db/knex.ts`. The backend now connects via whatever
role `DATABASE_URL` specifies — there is no longer a non-prod-only
URL rewrite. Prod behaviour is unchanged until step 5 above is done
(the env var still resolves to the admin role until you update Key
Vault). Local dev's fallback default is now
`postgresql://databridge_app:databridge@localhost:5432/databridge` —
local devs running without an explicit `.env` get the unprivileged
role automatically.

### 8. Update `docs/SECURITY.md`

Move "Switch production DB role from admin → app" from the "still
open" list to the "completed controls" section.

---

## Why we do this

Even though FORCE RLS protects us when the backend runs as admin (the
role is the table owner, but FORCE bypasses the owner exemption), the
defense-in-depth principle says: every layer must hold on its own.

If a future migration adds a table and forgets the `FORCE ROW LEVEL
SECURITY` clause, the admin connection would silently bypass RLS on
that table. With `databridge_app` (which has no admin powers regardless
of FORCE), the policy still applies — and a missing policy results in
"no rows visible" rather than "all tenants visible," which is the
fail-safe direction.

That's the whole game. RLS as the database-side filter, role
separation as the safety net that makes a misconfiguration fail closed
instead of open.

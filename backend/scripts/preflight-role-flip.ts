/**
 * preflight-role-flip — can the backend safely connect as `databridge_app`?
 *
 * Row-level security is not enforcing anything in production today. The backend
 * connects as the superuser `databridge`, and a superuser bypasses RLS
 * unconditionally — FORCE ROW LEVEL SECURITY binds the table OWNER, not a
 * superuser. Tenant isolation therefore rests entirely on the application's own
 * filters. Switching to `databridge_app` (NOBYPASSRLS) is what turns RLS on.
 *
 * docs/runbooks/db-role-flip.md has described that switch as "the last step of
 * Sprint 1 hardening" since May, and nobody has taken it. That caution was
 * justified: performed as written it would have taken the platform down, because
 * several tenant-scoped tables — `users` among them — had RLS enabled with no
 * policy at all, which denies every row to a non-bypassing role. Migration
 * 20260804000074 fixed the policies and 20260804000075 the grants, but the
 * lesson stands: the flip must be verified, not attempted.
 *
 * This script is that verification. It is READ-ONLY and answers one question —
 * "would the backend still work as `databridge_app`?" — by checking the three
 * things that can independently break it:
 *
 *   1. the role exists and is genuinely NOBYPASSRLS (otherwise the flip is
 *      cosmetic: it would change the username and enforce nothing)
 *   2. every tenant-scoped table with RLS enabled has the RIGHT policies,
 *      asserted by predicate identity, not by count:
 *        - a tenant-isolation policy whose predicate actually compares
 *          tenant_id against app.current_tenant (RLS + no policy = deny
 *          everything, but RLS + the WRONG policy is just as fatal and a
 *          count can't see it)
 *        - on the five tables the unauthenticated auth paths read (users,
 *          refresh_tokens, webauthn_credentials, mfa_backup_codes,
 *          oauth_pending): the auth_lookup SELECT carve-out for empty tenant
 *          context. Without it login, refresh and forgot-password read zero
 *          rows under this role — `users` "having a policy" was exactly how
 *          the market-readiness assessment's P0-1 slipped past this script.
 *   3. the role holds SELECT/INSERT/UPDATE/DELETE on every table and USAGE on
 *      every sequence (missing grants deny access before RLS is consulted)
 *
 * Exit 0 = safe to flip. Exit 1 = do not flip, with the blockers listed.
 *
 * Run with the ADMIN url — it inspects the catalog, and asking the app role
 * whether it has permission is exactly the thing that might be broken:
 *
 *   cd backend
 *   DATABASE_URL='postgresql://databridge:…@host/databridge?sslmode=require' \
 *     npx tsx scripts/preflight-role-flip.ts
 */
import { Client } from 'pg';

const APP_ROLE = process.env.RLS_APP_ROLE ?? 'databridge_app';

/**
 * Tables the unauthenticated auth paths SELECT from before any tenant is
 * known (login, register's duplicate-email check, forgot/reset-password,
 * refresh-token validation, WebAuthn login verify, OAuth callback). Each
 * must carry the `auth_lookup` FOR SELECT carve-out — created by migration
 * 20260901000088; keep this list in agreement with that migration and with
 * scripts/prod-fix-missing-policies.ts.
 */
const AUTH_LOOKUP_TABLES = [
  'users',
  'refresh_tokens',
  'webauthn_credentials',
  'mfa_backup_codes',
  'oauth_pending',
];

interface Blocker {
  kind: string;
  detail: string;
}

interface PolicyRow {
  table_name: string;
  polname: string;
  /** 'r' = SELECT, 'a' = INSERT, 'w' = UPDATE, 'd' = DELETE, '*' = ALL */
  polcmd: string;
  polpermissive: boolean;
  qual: string | null;
  with_check: string | null;
}

/**
 * Does this policy isolate tenants? Identity is asserted on the predicate,
 * not the name — the policies predate a naming convention
 * (`tenant_isolation`, `refresh_tokens_tenant_isolation`,
 * `oauth_pending_tenant` all exist) and renaming them in place would churn
 * production for no behavioural gain. What actually matters is that reads
 * AND writes are both constrained to `tenant_id = <the session's tenant>`.
 */
function isTenantIsolation(p: PolicyRow): boolean {
  if (p.polcmd !== '*') return false;
  // WITH CHECK falls back to USING when absent (Postgres semantics), so the
  // effective write predicate is with_check ?? qual.
  const read = p.qual ?? '';
  const write = p.with_check ?? p.qual ?? '';
  const references = (expr: string) =>
    expr.includes('tenant_id') && expr.includes('app.current_tenant');
  return references(read) && references(write);
}

/**
 * Is this the auth_lookup carve-out? FOR SELECT only, permissive, visible
 * exactly when there is NO tenant context — and NOT itself tenant-scoped
 * (a tenant-scoped SELECT policy is tenant_isolation wearing the wrong
 * polcmd, not a carve-out).
 */
function isAuthLookup(p: PolicyRow): boolean {
  const qual = p.qual ?? '';
  return (
    p.polcmd === 'r' &&
    p.polpermissive &&
    qual.includes('app.current_tenant') &&
    qual.includes('IS NULL') &&
    !qual.includes('tenant_id')
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const out = (s = '') => process.stdout.write(s + '\n');
  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  const blockers: Blocker[] = [];

  try {
    out(`preflight-role-flip — target role: ${APP_ROLE}\n`);

    // ── 1. Role exists, and actually has RLS applied to it ──────────────────
    const role = await client.query<{
      rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    );

    if ((role.rowCount ?? 0) === 0) {
      blockers.push({ kind: 'role', detail: `${APP_ROLE} does not exist` });
      out(`  role .............. MISSING`);
    } else {
      const r = role.rows[0];
      const enforced = !r.rolsuper && !r.rolbypassrls;
      out(`  role .............. exists (login=${r.rolcanlogin}, superuser=${r.rolsuper}, bypassrls=${r.rolbypassrls})`);
      if (!r.rolcanlogin) blockers.push({ kind: 'role', detail: `${APP_ROLE} cannot log in` });
      if (!enforced) {
        blockers.push({
          kind: 'role',
          detail: `${APP_ROLE} is superuser or BYPASSRLS — flipping to it would enforce nothing`,
        });
      }
    }

    // ── 2. Every RLS-enabled tenant-scoped table has a policy ───────────────
    const rls = await client.query<{
      table_name: string; enabled: boolean; forced: boolean; policies: number;
    }>(`
      SELECT c.relname                       AS table_name,
             c.relrowsecurity                AS enabled,
             c.relforcerowsecurity           AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name   = c.relname
              AND col.column_name  = 'tenant_id')
       ORDER BY c.relname
    `);

    const noPolicy = rls.rows.filter((t) => t.enabled && t.policies === 0);
    const notEnabled = rls.rows.filter((t) => !t.enabled);
    const notForced = rls.rows.filter((t) => t.enabled && !t.forced);

    // Policy IDENTITY, not just count. A table "having a policy" proved
    // nothing when the policy was the wrong one: `users` carried only
    // tenant_isolation, this script said GO, and login under the app role
    // could still only fail (P0-1). So fetch every policy's actual predicate
    // and check that each table's policies do what the flip depends on.
    const pol = await client.query<PolicyRow>(`
      SELECT c.relname                            AS table_name,
             p.polname,
             p.polcmd,
             p.polpermissive,
             pg_get_expr(p.polqual, p.polrelid)      AS qual,
             pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
        FROM pg_policy p
        JOIN pg_class c     ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
       ORDER BY c.relname, p.polname
    `);
    const policiesByTable = new Map<string, PolicyRow[]>();
    for (const p of pol.rows) {
      const list = policiesByTable.get(p.table_name) ?? [];
      list.push(p);
      policiesByTable.set(p.table_name, list);
    }

    const enabledTables = rls.rows.filter((t) => t.enabled);
    const missingIsolation = enabledTables.filter(
      (t) => t.policies > 0 && !(policiesByTable.get(t.table_name) ?? []).some(isTenantIsolation),
    );
    const missingAuthLookup = AUTH_LOOKUP_TABLES.filter((name) => {
      const t = rls.rows.find((r) => r.table_name === name);
      // A table with RLS off needs no carve-out to be readable (and is
      // already reported below as not isolated); a missing table is a schema
      // problem this check should still surface.
      if (t && !t.enabled) return false;
      return !(policiesByTable.get(name) ?? []).some(isAuthLookup);
    });

    out(`  tenant tables ..... ${rls.rows.length} with a tenant_id column`);
    out(`    RLS enabled ..... ${enabledTables.length}`);
    out(`    with a policy ... ${rls.rows.filter((t) => t.policies > 0).length}`);
    out(`    tenant-isolation verified ... ${enabledTables.length - noPolicy.length - missingIsolation.length}/${enabledTables.length}`);
    out(`    auth_lookup verified ........ ${AUTH_LOOKUP_TABLES.length - missingAuthLookup.length}/${AUTH_LOOKUP_TABLES.length}`);

    for (const t of noPolicy) {
      // This is the one that would have taken production down.
      blockers.push({
        kind: 'policy',
        detail: `${t.table_name}: RLS enabled with NO policy — denies every row`,
      });
    }
    for (const t of missingIsolation) {
      const names = (policiesByTable.get(t.table_name) ?? []).map((p) => p.polname).join(', ');
      blockers.push({
        kind: 'policy',
        detail: `${t.table_name}: has policies (${names}) but NONE isolates tenants — no ALL-command policy comparing tenant_id to app.current_tenant`,
      });
    }
    for (const name of missingAuthLookup) {
      blockers.push({
        kind: 'policy',
        detail: `${name}: no auth_lookup SELECT carve-out for empty tenant context — unauthenticated lookups (login, refresh, password reset) read zero rows under ${APP_ROLE}`,
      });
    }
    for (const t of notEnabled) {
      // Not fatal to the flip, but it means that table is not isolated at all.
      out(`    ! ${t.table_name}: has tenant_id but RLS is OFF — not isolated`);
    }
    for (const t of notForced) {
      out(`    · ${t.table_name}: RLS on but not FORCEd (owner connections bypass)`);
    }

    // ── 3. Grants ───────────────────────────────────────────────────────────
    if ((role.rowCount ?? 0) > 0) {
      const grants = await client.query<{ table_name: string; missing: string }>(`
        SELECT t.tablename AS table_name,
               concat_ws(',',
                 CASE WHEN NOT has_table_privilege($1, quote_ident(t.tablename), 'SELECT') THEN 'SELECT' END,
                 CASE WHEN NOT has_table_privilege($1, quote_ident(t.tablename), 'INSERT') THEN 'INSERT' END,
                 CASE WHEN NOT has_table_privilege($1, quote_ident(t.tablename), 'UPDATE') THEN 'UPDATE' END,
                 CASE WHEN NOT has_table_privilege($1, quote_ident(t.tablename), 'DELETE') THEN 'DELETE' END
               ) AS missing
          FROM pg_tables t
         WHERE t.schemaname = 'public'
           AND t.tablename NOT LIKE 'knex_migrations%'
         ORDER BY t.tablename
      `, [APP_ROLE]);

      const missingGrants = grants.rows.filter((g) => g.missing !== '');
      const grantTotal = grants.rowCount ?? grants.rows.length;
      out(`  table grants ...... ${grantTotal - missingGrants.length}/${grantTotal} complete`);
      for (const g of missingGrants) {
        blockers.push({ kind: 'grant', detail: `${g.table_name}: missing ${g.missing}` });
      }

      // AS MATERIALIZED is load-bearing. Without it the planner is free to
      // evaluate has_sequence_privilege() before the relkind filter, and it
      // then errors on the first index it meets — `"knex_migrations_pkey" is
      // not a sequence`. The CTE forces the filter to run first.
      const seqs = await client.query<{ sequence_name: string }>(`
        WITH seqs AS MATERIALIZED (
          SELECT c.oid, c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'S'
        )
        SELECT relname AS sequence_name
          FROM seqs
         WHERE NOT has_sequence_privilege($1, oid, 'USAGE')
         ORDER BY relname
      `, [APP_ROLE]);

      out(`  sequence grants ... ${seqs.rows.length === 0 ? 'complete' : `${seqs.rows.length} missing USAGE`}`);
      for (const s of seqs.rows) {
        // Missing sequence USAGE blocks INSERTs on auto-increment tables, which
        // is every write path in the product.
        blockers.push({ kind: 'grant', detail: `sequence ${s.sequence_name}: missing USAGE` });
      }
    }

    // ── Verdict ─────────────────────────────────────────────────────────────
    out('');
    if (blockers.length === 0) {
      out('GO — the backend can run as ' + APP_ROLE + ' with row-level security enforced.');
      out('');
      out('Flip by setting .ops/db-role to `app` and pushing. The workflow shifts');
      out('traffic only after the new revision answers a live database read, and');
      out('rolls back automatically if it does not.');
    } else {
      out(`NO-GO — ${blockers.length} blocker(s). Do not flip:`);
      out('');
      const byKind = new Map<string, Blocker[]>();
      for (const b of blockers) {
        const list = byKind.get(b.kind) ?? [];
        list.push(b);
        byKind.set(b.kind, list);
      }
      for (const [kind, list] of byKind) {
        out(`  ${kind}:`);
        for (const b of list.slice(0, 20)) out(`    - ${b.detail}`);
        if (list.length > 20) out(`    …and ${list.length - 20} more`);
      }
      out('');
      out('Missing tenant-isolation policies are fixed by migration 20260804000074,');
      out('missing grants by 20260804000075, and the auth_lookup carve-outs by');
      out('20260901000088. If any is still reported, those migrations have not');
      out('been applied to this database yet.');
    }

    process.exitCode = blockers.length === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`preflight-role-flip failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});

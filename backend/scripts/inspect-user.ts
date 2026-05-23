/**
 * One-off operator script — inspect a user by email across every tenant.
 *
 * Same multi-tenant back-door pattern as admin-tenants.ts: connect with
 * the admin DB role (BYPASSRLS), iterate every matching row, present a
 * cross-tenant view. Used to answer questions like "is this user
 * registered, in which tenant, and what state is their password reset
 * token in?" — questions the product UI deliberately can't answer
 * because of RLS isolation.
 *
 * Outputs per matching user:
 *   - users.id, tenant_id, tenant.name, tenant.slug, tenant.status
 *   - role, is_active
 *   - email + display_name
 *   - created_at, updated_at
 *   - password_reset_token present? (without leaking the hash)
 *   - password_reset_expires + whether it's still in the future
 *   - active refresh_tokens count
 *   - mfa_enabled_at (when MFA is on the row)
 *
 * Usage:
 *
 *   cd backend
 *   DATABASE_URL='postgresql://databridge:...@host/databridge?sslmode=require' \
 *   EMAIL='arnovda@telenet.be' \
 *     npx tsx scripts/inspect-user.ts
 *
 * Read-only. No CONFIRM gate needed — won't mutate anything.
 */

import { Client } from 'pg';

interface UserRow {
  id: number;
  tenant_id: number;
  email: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  password_reset_token: string | null;
  password_reset_expires: string | null;
  created_at: string;
  updated_at: string | null;
  mfa_enabled_at?: string | null;
}

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  status: string;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const email = process.env.EMAIL;
  if (!url) throw new Error('DATABASE_URL not set');
  if (!email) throw new Error('EMAIL not set');

  const log = (s: string) => process.stdout.write(s + '\n');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // Detect whether the mfa_enabled_at column exists so the script
    // keeps working on older snapshots. Same pattern as the refresh-token
    // guard in prod-reset-password.ts.
    const mfaColExists = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name='mfa_enabled_at'
      ) AS exists
    `).then((r) => r.rows[0]?.exists ?? false);

    const cols = ['id','tenant_id','email','display_name','role','is_active',
                  'password_reset_token','password_reset_expires',
                  'created_at','updated_at'];
    if (mfaColExists) cols.push('mfa_enabled_at');

    const users = await client.query<UserRow>(
      `SELECT ${cols.join(', ')} FROM users WHERE LOWER(email) = LOWER($1) ORDER BY tenant_id, id`,
      [email],
    );

    if (users.rows.length === 0) {
      log(`No user with email "${email}" — nothing matches.`);
      log('');
      log('Possibilities:');
      log('  • Account was never registered.');
      log('  • Email is stored with different casing (LOWER() catches that).');
      log('  • Account was deleted (admin-tenants.ts delete cascade).');
      return;
    }

    log(`Found ${users.rows.length} matching user row(s) for "${email}".`);
    log('');

    for (const u of users.rows) {
      const tenant = await client.query<TenantRow>(
        `SELECT id, name, slug, status FROM tenants WHERE id = $1`,
        [u.tenant_id],
      );
      const t = tenant.rows[0];

      // Refresh token count — guard for snapshots without the table.
      let activeRefresh = -1;
      try {
        const r = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM refresh_tokens
            WHERE user_id = $1 AND revoked_at IS NULL
              AND expires_at > now()`,
          [u.id],
        );
        activeRefresh = Number(r.rows[0]?.n ?? 0);
      } catch { activeRefresh = -1; }

      const resetExpiresMs = u.password_reset_expires
        ? new Date(u.password_reset_expires).getTime()
        : null;
      const resetStatus = u.password_reset_token == null
        ? '∅ none'
        : resetExpiresMs == null
          ? 'token set, NO expiry (anomalous)'
          : resetExpiresMs > Date.now()
            ? `set, valid for ${Math.round((resetExpiresMs - Date.now()) / 60000)} more min`
            : `set, EXPIRED ${Math.round((Date.now() - resetExpiresMs) / 60000)} min ago`;

      log(`────────────────────────────────────────────────────────`);
      log(`users.id          = ${u.id}`);
      log(`tenant            = #${u.tenant_id} "${t?.name ?? '<missing>'}" (slug=${t?.slug ?? '?'}, status=${t?.status ?? '?'})`);
      log(`email             = ${u.email}`);
      log(`display_name      = ${u.display_name ?? '<null>'}`);
      log(`role              = ${u.role}`);
      log(`is_active         = ${u.is_active}`);
      log(`created_at        = ${u.created_at}`);
      log(`updated_at        = ${u.updated_at ?? '<null>'}`);
      if (mfaColExists) {
        log(`mfa_enabled_at    = ${u.mfa_enabled_at ?? '<null>'}`);
      }
      log(`password_reset    = ${resetStatus}`);
      if (u.password_reset_token) {
        log(`  token (sha256)  = ${u.password_reset_token.slice(0, 12)}…  (${u.password_reset_token.length} chars)`);
        log(`  expires_at      = ${u.password_reset_expires ?? '<null>'}`);
      }
      log(`active refresh    = ${activeRefresh < 0 ? '<table missing>' : activeRefresh}`);
    }

    log('────────────────────────────────────────────────────────');
    log('');
    log('Interpreting password_reset:');
    log('  ∅ none           → forgot-password was never POSTed for this row');
    log('                     OR the UPDATE silently failed (e.g. RLS blocked it).');
    log('  set, valid       → forgot-password landed AND token is still usable.');
    log('  set, EXPIRED     → token landed but the 1h window passed.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

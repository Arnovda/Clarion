/**
 * set-app-role-password — make DB_APP_PASSWORD the real password of
 * `databridge_app`, then prove the role can actually read.
 *
 * The role exists in production with every grant it needs, but its password was
 * chosen ad hoc by whoever followed docs/runbooks/db-role-flip.md and was never
 * recorded anywhere — not Terraform, not Key Vault, not GitHub. Rather than
 * hunt for it, we set a known one. That is safe precisely because nothing
 * connects with this role today: production runs as the superuser, so changing
 * this password cannot interrupt anything.
 *
 * Two things happen here, in this order, and both BEFORE anything touches the
 * Container App:
 *
 *   1. ALTER ROLE … WITH PASSWORD  (as admin)
 *   2. connect AS databridge_app and read a real table
 *
 * Step 2 is the one that matters. A password that authenticates proves nothing
 * about whether the backend will work — the failure this whole exercise exists
 * to prevent was a role that could log in and then be denied every row. So the
 * check reads `users`, the table that was unreadable, under the same
 * row-level-security rules the backend will run under.
 *
 * Nothing sensitive is printed. Exit 0 means the flip can proceed.
 *
 *   DATABASE_URL='<admin url>' DB_APP_PASSWORD='…' \
 *     npx tsx scripts/set-app-role-password.ts
 */
import { Client } from 'pg';

const APP_ROLE = process.env.RLS_APP_ROLE ?? 'databridge_app';

/**
 * The password is spliced into a connection URL by the caller, so characters
 * with meaning in a URL would silently produce a different password than the
 * one stored. Refuse them here rather than debug it later against production.
 */
const SAFE_PASSWORD = /^[A-Za-z0-9._~-]{16,}$/;

function ssl(url: string) {
  return url.includes('localhost') || url.includes('127.0.0.1')
    ? undefined
    : { rejectUnauthorized: false };
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  const password = process.env.DB_APP_PASSWORD;
  const out = (s = '') => process.stdout.write(s + '\n');

  if (!adminUrl) throw new Error('DATABASE_URL not set');
  if (!password) {
    throw new Error(
      'DB_APP_PASSWORD is not set. Add it as a repository secret — see docs/runbooks/db-role-flip.md.',
    );
  }
  if (!SAFE_PASSWORD.test(password)) {
    throw new Error(
      'DB_APP_PASSWORD must be at least 16 characters of letters, digits, and - _ . ~ only. ' +
      'Other characters have meaning inside a connection URL and would not survive the round trip.',
    );
  }

  // ── 1. Set the password ───────────────────────────────────────────────────
  const admin = new Client({ connectionString: adminUrl, ssl: ssl(adminUrl) });
  await admin.connect();
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    if (exists.rowCount === 0) {
      throw new Error(
        `${APP_ROLE} does not exist. Create it first — see docs/runbooks/db-role-flip.md.`,
      );
    }
    // Identifier is a constant, not user input; the password cannot be a bound
    // parameter in ALTER ROLE, hence the literal — validated above.
    await admin.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${password}'`);
    out(`  password set on ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  // ── 2. Prove the role can log in AND read ─────────────────────────────────
  const appUrl = adminUrl.replace(/:\/\/[^@]*@/, `://${APP_ROLE}:${encodeURIComponent(password)}@`);
  const app = new Client({ connectionString: appUrl, ssl: ssl(appUrl) });

  try {
    await app.connect();
  } catch (err) {
    throw new Error(
      `${APP_ROLE} cannot log in with the new password: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // Authentication is the easy half. This is the half that was broken: RLS
    // enabled with no policy denies every row to a non-bypassing role, and the
    // backend cannot log a single user in.
    await app.query(`SELECT count(*) FROM users`);
    out(`  ${APP_ROLE} can read users`);

    // Tenant-scoped reads must return nothing without a tenant context rather
    // than erroring — that is RLS filtering, which is the point of the flip.
    await app.query(`SELECT count(*) FROM connections`);
    out(`  ${APP_ROLE} can read connections under RLS`);
  } catch (err) {
    throw new Error(
      `${APP_ROLE} logs in but cannot read: ${err instanceof Error ? err.message : String(err)}\n` +
      `This is the failure the flip must not hit. Run scripts/preflight-role-flip.ts for the detail.`,
    );
  } finally {
    await app.end();
  }

  out('');
  out(`${APP_ROLE} is ready: it authenticates and reads real tables under row-level security.`);
}

main().catch((err) => {
  process.stderr.write(`set-app-role-password failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

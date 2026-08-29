/**
 * Central application configuration.
 *
 * The single place environment variables are read and interpreted. Everything
 * else should import `config` rather than touching `process.env` directly, so:
 *   • defaults live in ONE place (no more three files each defaulting a var
 *     differently),
 *   • one concept has one name (the app URL was read as FRONTEND_URL /
 *     FRONTEND_BASE_URL / PUBLIC_APP_URL in different files, with different
 *     fallback chains — now resolved once here as `config.appUrl`),
 *   • values are typed, so a typo in a var name is a compile error at the
 *     call site instead of a silent `undefined`.
 *
 * Migration is incremental: call sites move onto `config` over time. The
 * `no-scattered-frontend-url` lint prevents the specific drift that bit us
 * (the three URL names) from recurring. `process.env` is still read directly
 * in not-yet-migrated modules; that's expected during the transition.
 *
 * NB: read at import time. `index.ts` loads `.env` (when not under VITEST)
 * before importing routes/services, so `process.env` is populated by the time
 * this module is first imported.
 */

function str(name: string): string | undefined {
  const v = process.env[name];
  return v == null || v === '' ? undefined : v;
}

function trimTrailingSlash(u: string | undefined): string | undefined {
  return u?.replace(/\/$/, '');
}

/**
 * The public URL of the frontend app. Historically read under three names
 * with ad-hoc fallback chains; unified here. Order: the explicit app URL, then
 * the name Terraform sets on the backend Container App, then the local default.
 */
const appUrl =
  trimTrailingSlash(str('PUBLIC_APP_URL'))
  ?? trimTrailingSlash(str('FRONTEND_URL'))
  ?? trimTrailingSlash(str('FRONTEND_BASE_URL'))
  ?? 'http://localhost:3000';

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd,
  isTest: !!process.env.VITEST || process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT ?? 3001),

  /** Public URL of the frontend — the one true source. */
  appUrl,

  /** Allowed CORS origins (comma-separated in CORS_ORIGIN). */
  corsOrigins: (str('CORS_ORIGIN') ?? 'http://localhost:3000').split(','),

  jwt: {
    secret: str('JWT_SECRET'),
    /** Access-token lifetime. JWT_EXPIRES_IN kept as a legacy alias. */
    accessExpiresIn: str('JWT_ACCESS_EXPIRES_IN') ?? str('JWT_EXPIRES_IN') ?? '15m',
    refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 30),
  },
} as const;

/**
 * Fetch the JWT secret or throw. Centralises the "secret must be set" check
 * that middleware/auth.ts, routes/auth.ts and webauthnService.ts each did
 * inline — and the production weak-secret guard that previously lived ONLY in
 * middleware/auth.ts (so MFA-challenge and WebAuthn tokens signed elsewhere
 * skipped it). Now every JWT operation gets the same check.
 */
/**
 * Platform operators — the people who may change feature-flag rollouts.
 *
 * Deliberately env config and not a database role. A flag decides which
 * tenants can see unreleased work, so the ability to flip one must not be
 * reachable from inside any tenant: a tenant admin is an admin OF THEIR OWN
 * COMPANY, and if they could grant themselves preview features the flag would
 * stop being a release mechanism. Putting the list in the environment means
 * changing WHO is an operator requires a deploy (rare, and reviewable in the
 * infrastructure), while changing WHAT a flag does is a row update (frequent,
 * instant).
 *
 * Unset means NOBODY is an operator. Fail closed: an empty allowlist that
 * defaulted to "any admin" would silently hand every customer the console.
 *
 * Read on each call rather than frozen at import: the parse is a split on a
 * short string, and a value captured at import time cannot be varied by a test
 * — which for the one control with no database-level backstop is the wrong
 * trade.
 */
export function platformOperatorEmails(): string[] {
  return (str('PLATFORM_OPERATOR_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function requireJwtSecret(): string {
  const secret = config.jwt.secret;
  if (!secret) {
    throw new Error('JWT_SECRET is not set — refusing to sign/verify tokens.');
  }
  if (isProd) {
    const tooWeak =
      secret.length < 32 ||
      secret === 'change_me_in_production' ||
      secret === 'changeme' ||
      /^(test|dev|local)/i.test(secret);
    if (tooWeak) {
      throw new Error(
        'JWT_SECRET is too weak for production. ' +
        'Provide a random ≥32-character secret via JWT_SECRET (or Key Vault).',
      );
    }
  }
  return secret;
}

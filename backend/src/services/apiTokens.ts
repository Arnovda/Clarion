/**
 * Personal API tokens — how a client that is not a browser proves who it is.
 *
 * Created for the Excel add-in, which runs inside Excel's webview with no
 * Clarion session, and deliberately built as a general mechanism because the
 * same gap blocks every other non-browser client we might add (an MCP endpoint
 * for AI agents, a scheduled export, a customer's own script).
 *
 * Three properties hold the design together:
 *
 * **A token never outranks its owner.** It carries the creating user's tenant
 * and role, resolved fresh on every request from the `users` row rather than
 * copied into the token at creation. So revoking someone's access, changing
 * their role or deactivating them takes effect on their tokens immediately —
 * a token that kept a stale role would be a privilege-escalation path that
 * outlives the decision to close it.
 *
 * **Only a hash is stored.** The plaintext is returned once and is
 * unrecoverable; losing it means issuing a new one. SHA-256 rather than
 * bcrypt, which is the OPPOSITE of the rule for passwords and correct here:
 * the secret is 256 bits of machine randomness with no dictionary to attack,
 * so a slow hash buys nothing, while a fast one matters because this runs on
 * every request the add-in makes.
 *
 * **Comparison is constant-time.** Lookup is by hash, so a timing signal would
 * be weak — but `timingSafeEqual` on the final check costs nothing and removes
 * the question.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import { unauthQuery } from '../db/unauthQuery';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'api-tokens' });

/** Recognisable, greppable, and obviously not a JWT when one turns up in a log. */
const TOKEN_PREFIX = 'clr_';
/** Characters of the plaintext kept in clear so a user can tell tokens apart. */
const VISIBLE_CHARS = TOKEN_PREFIX.length + 8;

export interface MintedToken {
  id: number;
  name: string;
  /** Returned ONCE. Never stored, never recoverable. */
  plaintext: string;
  prefix: string;
  expiresAt: Date;
}

export interface ResolvedToken {
  tokenId: number;
  userId: number;
  tenantId: number;
  role: string;
  email: string;
  displayName: string;
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf-8').digest('hex');
}

/**
 * Create a token for a user. The caller is responsible for having established
 * that `userId` is the requesting user — this function does not authorise, it
 * mints.
 */
export async function mintToken(
  db: Knex | Knex.Transaction,
  args: { tenantId: number; userId: number; name: string; ttlDays: number },
): Promise<MintedToken> {
  // 32 bytes of CSPRNG output. The prefix is cosmetic; the entropy is all in
  // the secret half.
  const secret = crypto.randomBytes(32).toString('hex');
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  const prefix = plaintext.slice(0, VISIBLE_CHARS);
  const expiresAt = new Date(Date.now() + args.ttlDays * 24 * 60 * 60 * 1000);

  const [row] = await db('api_tokens')
    .insert({
      tenant_id: args.tenantId,
      user_id: args.userId,
      name: args.name,
      token_hash: hashToken(plaintext),
      prefix,
      expires_at: expiresAt,
    })
    .returning(['id', 'name']);

  log.info({ tokenId: row.id, userId: args.userId }, 'api token created');
  return { id: row.id, name: row.name, plaintext, prefix, expiresAt };
}

/**
 * Resolve a plaintext token to the user it acts as, or null.
 *
 * Runs through `unauthQuery` because this is authentication: there is no
 * tenant context yet, by definition. The `token_lookup` RLS policy on
 * `api_tokens` is what permits the uncontexted read — see the migration for
 * why this table carries its own policy rather than relying on the
 * `auth_lookup` carve-out the codebase describes but does not have.
 *
 * Returns null for every failure mode — unknown, revoked, expired, or owned by
 * a deactivated user — without distinguishing them to the caller. A client
 * cannot act differently on "expired" than on "wrong", and telling it which
 * only helps someone probing.
 */
export async function resolveToken(plaintext: string): Promise<ResolvedToken | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plaintext);

  const row = await unauthQuery(async (trx) =>
    trx('api_tokens as t')
      .join('users as u', 'u.id', 't.user_id')
      .where('t.token_hash', hash)
      .select(
        't.id as token_id', 't.token_hash', 't.revoked_at', 't.expires_at',
        'u.id as user_id', 'u.tenant_id', 'u.role', 'u.email', 'u.display_name', 'u.is_active',
      )
      .first(),
  );
  if (!row) return null;

  // Redundant given the lookup was BY hash, and free. Removes the question of
  // whether anything downstream could leak a comparison timing signal.
  const a = Buffer.from(hash, 'utf-8');
  const b = Buffer.from(String(row.token_hash), 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  // The role and tenant come from the USER row, live. A deactivated user's
  // tokens stop working the moment they are deactivated.
  if (!row.is_active) return null;

  return {
    tokenId: Number(row.token_id),
    userId: Number(row.user_id),
    tenantId: Number(row.tenant_id),
    role: String(row.role),
    email: String(row.email),
    displayName: String(row.display_name ?? row.email),
  };
}

/**
 * Record that a token was used. Best-effort and deliberately not awaited by
 * the auth path: a write failure here must never turn a valid request into a
 * 401, and "last used" being a few seconds stale costs nothing.
 */
export function touchToken(db: Knex, tenantId: number, tokenId: number): void {
  void db('api_tokens')
    .where({ id: tokenId, tenant_id: tenantId })
    .update({ last_used_at: new Date() })
    .catch((err) => log.warn({ err, tokenId }, 'could not record token use'));
}

/** A user's own tokens. Never returns a hash. */
export async function listTokens(db: Knex | Knex.Transaction, tenantId: number, userId: number) {
  return db('api_tokens')
    .where({ tenant_id: tenantId, user_id: userId })
    .whereNull('revoked_at')
    .orderBy('created_at', 'desc')
    .select('id', 'name', 'prefix', 'last_used_at', 'expires_at', 'created_at');
}

/**
 * Revoke one of the caller's own tokens. Scoped by user AND tenant so an
 * id from another account resolves to nothing rather than to someone else's
 * credential.
 */
export async function revokeToken(
  db: Knex | Knex.Transaction,
  tenantId: number,
  userId: number,
  tokenId: number,
): Promise<boolean> {
  const n = await db('api_tokens')
    .where({ id: tokenId, tenant_id: tenantId, user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date() });
  return n > 0;
}

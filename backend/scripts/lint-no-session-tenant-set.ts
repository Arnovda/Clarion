/**
 * lint-no-session-tenant-set — two rules that keep tenant context
 * TRANSACTION-LOCAL in the backend (P0-5 of the 2026-09-05 market-readiness
 * assessment v2).
 *
 * Why: the API and the jobs-worker share one knex pool per process, and
 * BullMQ runs jobs from different tenants concurrently. A session-level
 * `SET app.current_tenant` (or `set_config(…, false)`) sticks to whichever
 * pooled connection ran it; the next query from the same job can be handed
 * a connection carrying ANOTHER tenant's id. RLS is then satisfied — it
 * filters to the wrong tenant. That is fail-OPEN, and no superuser test can
 * see it. `services/tenantQuery.ts` (a short transaction with
 * `set_config(…, true)`) is the only sanctioned way to set the context.
 *
 * Rule 1 — HARD, no baseline: no session-level SET anywhere in backend/src
 * outside the allowlist below. `SET LOCAL` and `set_config(…, true)` are
 * fine (transaction-local by definition).
 *
 *   Allowlisted: middleware/auth.ts — the request-path fallback that
 *   unmigrated bare-pool reads in routes/services still lean on. It goes
 *   when Rule 2's baseline reaches 0 for the request-reachable files.
 *
 * Rule 2 — COUNT RATCHET: bare `semanticDb('table')` query starts outside
 * routes/ (services, orchestrator, jobs, semantic, quality). Each one reads
 * or writes a tenant-owned table on the root pool with whatever context the
 * connection happens to carry. The BASELINE below may only ever be LOWERED;
 * convert a site to tenantQuery and lower it in the same commit. Files that
 * deliberately read tables WITHOUT RLS (`tenants`, `feature_flags`) or that
 * run on the unauthenticated path are listed in ROOT_POOL_OK with the reason.
 *
 * Usage (from the repo root):  npx tsx backend/scripts/lint-no-session-tenant-set.ts
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = 'backend/src';
const SESSION_SET_ALLOWLIST = new Set(['middleware/auth.ts']);
const RATCHET_ROOTS = ['services', 'orchestrator', 'jobs', 'semantic', 'quality'];
/** Files whose remaining root-pool reads are deliberate. Reason per entry. */
const ROOT_POOL_OK: Record<string, string> = {
  'services/tenantQuery.ts': 'the helper itself; reads `tenants`, which has no RLS',
  'services/autoApproveService.ts': 'reads `tenants` (no RLS) to enumerate; every tenant-owned write is under tenantQuery',
  'services/aiBudget.ts': 'reads `tenants` (no RLS) + ai_usage with an explicit tenant filter — convert with the AI-cost pass',
  'services/refreshTokenService.ts': 'unauthenticated path: `refresh_tokens` carries the auth_lookup carve-out',
  'services/mfaService.ts': 'unauthenticated MFA path: `users` carries the auth_lookup carve-out; writes are SET LOCAL transactions',
  'services/webauthnService.ts': 'unauthenticated WebAuthn path: same carve-out as mfaService',
};
const BASELINE = 19;

const SESSION_SET_RE = /SET\s+app\.current_tenant|set_config\(\s*'app\.current_tenant'\s*,\s*[^,]+,\s*false\s*\)/;
const BARE_POOL_RE = /(?:^|[^.\w])semanticDb\s*\(\s*['"`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

const files = walk(SRC).filter((f) => !f.includes(`${SRC}/tests/`) && !f.includes(`${SRC}/db/migrations/`));
const sessionSets: string[] = [];
const barePool: Record<string, number> = {};

for (const file of files) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (SESSION_SET_RE.test(line) && !/SET\s+LOCAL/.test(line) && !SESSION_SET_ALLOWLIST.has(rel)) {
      sessionSets.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
    if (RATCHET_ROOTS.some((r) => rel.startsWith(`${r}/`)) && BARE_POOL_RE.test(line) && !(rel in ROOT_POOL_OK)) {
      barePool[rel] = (barePool[rel] ?? 0) + 1;
    }
  });
}

let failed = false;
if (sessionSets.length > 0) {
  failed = true;
  process.stderr.write(`lint-no-session-tenant-set: ${sessionSets.length} session-level tenant SET(s) outside the allowlist:\n\n`);
  for (const s of sessionSets) process.stderr.write(`  ${s}\n`);
  process.stderr.write('\nUse services/tenantQuery.ts (transaction-local) instead. See jobs/workers.ts for why.\n\n');
}

const total = Object.values(barePool).reduce((a, b) => a + b, 0);
if (files.length < 50) {
  failed = true;
  process.stderr.write(`lint-no-session-tenant-set: only ${files.length} files scanned — the walker is broken, not the tree clean.\n`);
} else if (total > BASELINE) {
  failed = true;
  process.stderr.write(`lint-no-session-tenant-set: ${total} bare-pool semanticDb('…') query start(s) outside routes/ — baseline is ${BASELINE}.\n\n`);
  for (const [f, n] of Object.entries(barePool).sort()) process.stderr.write(`  ${n.toString().padStart(3)}  ${f}\n`);
  process.stderr.write('\nWrap new queries in tenantQuery(tenantId, (db) => db(…)). The baseline only ever goes DOWN.\n');
} else {
  process.stdout.write(
    `lint-no-session-tenant-set: OK — no session-level SET outside the allowlist; ${total} bare-pool query start(s) (baseline ${BASELINE}).` +
    (total < BASELINE ? ` Lower BASELINE in backend/scripts/lint-no-session-tenant-set.ts to ${total}.` : '') + '\n',
  );
}
process.exit(failed ? 1 : 0);

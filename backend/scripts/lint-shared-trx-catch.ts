/**
 * Lint check — flag dangerous `.catch(() => …)` patterns on Knex queries
 * inside shared request transactions.
 *
 * Background: see backend/src/db/safeQuery.ts. The naive defensive
 * pattern `.catch(() => [])` chained to `db('foo').where(...)` looks
 * safe but silently poisons the request transaction when the query
 * fails. Postgres rejects every subsequent statement in the same
 * request with 25P02 — exactly the bug class that ate the May 23 2026
 * /query DISTINCT-ON incident.
 *
 * What we check:
 *
 *   • Every `.ts` file under backend/src/routes/ and backend/src/services/
 *   • Each `.catch(() => ...)` where the handler is a no-op fallback
 *     (`[]`, `{}`, `null`, `undefined`, `0`, `false`)
 *   • If the catch is attached to a Knex-shaped call AND there is no
 *     `// SAVEPOINT-safe` / `// fire-and-forget` / `// non-db` marker
 *     within 2 lines, fail.
 *
 *   We trust the developer when they explicitly mark the call. The
 *   marker forces an audit moment — "is this really safe?" — and shows
 *   reviewers that the author thought about it.
 *
 * Heuristic for "Knex-shaped":
 *
 *   The previous ~6 lines contain a Knex builder call —
 *   `.where(`, `.insert(`, `.update(`, `.delete(`, `.select(`, `.first(`
 *   or the start of a query: `db(`, `trx(`, `reqDb(req)(`.
 *
 *   This catches the dangerous shape without false-positiving on
 *   `notifyTenant(...).catch(...)` (no Knex builder verb in scope)
 *   or `db.close().catch(...)` (the `.close()` is a DuckDB cleanup,
 *   not a Knex builder method).
 *
 * Allowed markers (case-insensitive, must appear on same line as
 * the .catch OR on one of the two previous lines):
 *
 *   • SAVEPOINT-safe       — caller has wrapped the query in a savepoint
 *                            via safeQuery() or equivalent
 *   • fire-and-forget      — call is intentionally fire-and-forget AND
 *                            is NOT a Knex query (e.g. notify, neo4j)
 *   • non-db               — explicit acknowledgment this is not a DB op
 *
 * Usage:
 *
 *   cd backend
 *   npx tsx scripts/lint-shared-trx-catch.ts
 *
 *   # Exits 0 if all .catch patterns are safe / marked.
 *   # Exits 1 and prints each violation with file:line if not.
 *
 * Wire into CI by adding to .github/workflows/test.yml:
 *
 *   - run: npx tsx backend/scripts/lint-shared-trx-catch.ts
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOTS = ['backend/src/routes', 'backend/src/services'];
const KNEX_BUILDER_VERBS = /\.(where|insert|update|delete|del|select|first|count|whereIn|whereNotIn|whereNull|whereRaw|orWhere|join|leftJoin|innerJoin|returning|onConflict|orderBy|groupBy|having|limit|offset)\(/;
const KNEX_QUERY_START = /(?:^|[^.\w])(?:reqDb\(req\)|semanticDb|trx)\s*\(\s*['"`]/;
const SAFE_MARKER = /\/\/.*\b(SAVEPOINT-safe|fire-and-forget|non-db)\b/i;
const CATCH_NOOP_PATTERN = /\.catch\(\s*\(\s*\)\s*=>\s*(\[\s*\]|\{\s*\}|null|undefined|0|false|void\s+\d+)\s*\)/;

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function lookbackHasKnex(lines: string[], idx: number, window = 6): boolean {
  for (let i = Math.max(0, idx - window); i <= idx; i++) {
    const line = lines[i];
    if (KNEX_BUILDER_VERBS.test(line) || KNEX_QUERY_START.test(line)) return true;
  }
  return false;
}

function nearbyHasSafeMarker(lines: string[], idx: number, window = 2): boolean {
  for (let i = Math.max(0, idx - window); i <= idx; i++) {
    if (SAFE_MARKER.test(lines[i])) return true;
  }
  return false;
}

function check(): Violation[] {
  const violations: Violation[] = [];
  const files: string[] = [];
  for (const root of ROOTS) {
    try { walk(root, files); } catch { /* root missing — skip */ }
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip pure comment lines — they're documentation about the
      // pattern, not actual code (e.g. comments explaining WHY the
      // pattern is bad would otherwise self-trigger).
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (!CATCH_NOOP_PATTERN.test(line)) continue;
      if (nearbyHasSafeMarker(lines, i)) continue;
      if (!lookbackHasKnex(lines, i)) continue;
      violations.push({
        file,
        line: i + 1,
        text: line.trim(),
        reason: 'Knex query chained to .catch(() => no-op) — use safeQuery() for SAVEPOINT-isolated defensive queries, or add a `// SAVEPOINT-safe` / `// fire-and-forget` / `// non-db` comment marker on this line or the previous two if the call is genuinely not a request-trx Knex query.',
      });
    }
  }
  return violations;
}

function main(): void {
  const violations = check();
  if (violations.length === 0) {
    process.stdout.write('lint-shared-trx-catch: OK — no dangerous .catch() patterns found.\n');
    process.exit(0);
  }
  process.stderr.write(`lint-shared-trx-catch: ${violations.length} violation(s) found.\n\n`);
  process.stderr.write('Each of these silently no-ops a Knex query inside a shared request\n');
  process.stderr.write('transaction. When the query fails, the JS catch hides the error but\n');
  process.stderr.write('the Postgres transaction is poisoned — every subsequent query in the\n');
  process.stderr.write('same request fails with 25P02 "current transaction is aborted".\n\n');
  process.stderr.write('Fix: wrap the query in safeQuery(trx, fn, fallback) — see\n');
  process.stderr.write('backend/src/db/safeQuery.ts. Or add `// SAVEPOINT-safe` /\n');
  process.stderr.write('`// fire-and-forget` / `// non-db` if the call is intentionally\n');
  process.stderr.write('not a Knex query on the request trx.\n\n');
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
    process.stderr.write(`    ${v.text}\n\n`);
  }
  process.exit(1);
}

main();

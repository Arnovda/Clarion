/**
 * lint-no-inline-500 — ratchet for Phase 3 of the code-quality plan.
 *
 * Route handlers must not answer with an inline `res.status(500)`. With
 * `express-async-errors` active, throwing (or `next(err)`) routes the error
 * to the central errorHandler, which logs it structured, shows admins the
 * real message, and gives everyone else a generic one. Inline 500s bypass
 * all of that and historically echoed raw driver errors (messages, Postgres
 * constraint names) straight to the client.
 *
 * Escape hatch: when a 500 with a deliberately crafted user-friendly body is
 * the right answer (a mapped message, not an error leak), tag the line — or
 * the line directly above it — with a `deliberate-500` comment explaining why.
 *
 * Scope: backend/src/routes only. middleware/ (the errorHandler itself and
 * pre-handler auth bootstrap) is intentionally out of scope.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, sep } from 'path';

const SRC = 'backend/src/routes';
const BANNED = /res\s*\.\s*status\(\s*500\s*\)/;
const ESCAPE = 'deliberate-500';

function isTestFile(relPath: string): boolean {
  return relPath.endsWith('.test.ts') || relPath.split(sep).includes('tests');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const violations: Array<{ file: string; line: number; text: string }> = [];
for (const file of walk(SRC)) {
  if (isTestFile(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (!BANNED.test(text)) return;
    const prev = i > 0 ? lines[i - 1] : '';
    if (text.includes(ESCAPE) || prev.includes(ESCAPE)) return;
    violations.push({ file, line: i + 1, text: text.trim() });
  });
}

if (violations.length === 0) {
  process.stdout.write('lint-no-inline-500: OK — no untagged inline res.status(500) in routes.\n');
  process.exit(0);
}

process.stderr.write(`lint-no-inline-500: ${violations.length} violation(s) found.\n\n`);
process.stderr.write(
  'Route handlers must not respond with an inline `res.status(500)` — throw the\n' +
  'error (or call `next(err)`) so the central errorHandler handles logging and\n' +
  'message redaction (admins get the real message, others a generic one).\n' +
  'If a crafted, user-friendly 500 body is genuinely intended, add a\n' +
  '`// deliberate-500: <why>` comment on the same line or the line above.\n\n',
);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.exit(1);

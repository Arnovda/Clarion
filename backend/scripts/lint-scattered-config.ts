/**
 * lint-scattered-config — ratchet for Phase 2 of the code-quality plan.
 *
 * The app URL used to be read under three different names (FRONTEND_URL,
 * FRONTEND_BASE_URL, PUBLIC_APP_URL) in different files with different fallback
 * chains, which drifted and caused real bugs (a prod password-reset lockout).
 * It's now resolved once in `backend/src/config.ts` as `config.appUrl`.
 *
 * This lint keeps it that way: those three env names may only be read inside
 * config.ts. Any other `process.env.<name>` read of them is a violation — use
 * `config.appUrl` instead.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const SRC = 'backend/src';
const ALLOWED_FILE = join('backend', 'src', 'config.ts');
const BANNED = /process\.env\.(FRONTEND_URL|FRONTEND_BASE_URL|PUBLIC_APP_URL)\b/;

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
  if (relative('.', file) === ALLOWED_FILE) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (BANNED.test(text)) violations.push({ file, line: i + 1, text: text.trim() });
  });
}

if (violations.length === 0) {
  process.stdout.write('lint-scattered-config: OK — app URL read only via config.appUrl.\n');
  process.exit(0);
}

process.stderr.write(`lint-scattered-config: ${violations.length} violation(s) found.\n\n`);
process.stderr.write('The app URL must be read via `config.appUrl` (backend/src/config.ts),\n');
process.stderr.write('not by reading FRONTEND_URL / FRONTEND_BASE_URL / PUBLIC_APP_URL directly.\n');
process.stderr.write('This prevents the three-names drift that caused a prod password-reset bug.\n\n');
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.exit(1);

/**
 * lint-no-console — ratchet for Phase 2b of the code-quality plan.
 *
 * All backend logging goes through the structured pino logger
 * (`backend/src/utils/logger.ts`) so production logs are JSON lines with
 * level/time/mod bindings that Azure Monitor can aggregate. Raw
 * `console.*` calls bypass that (no level, no redaction, silently dropped
 * extra args) and were swept out in Phase 2b.
 *
 * This lint keeps them out: any `console.(log|warn|error|info|debug)(`
 * call in backend/src is a violation — use `logger.child({ mod: '…' })`
 * instead. CLI/seed scripts (where console output IS the interface),
 * tests, the logger itself, and dead code awaiting deletion are
 * allowlisted below.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = 'backend/src';

// Files where console.* is deliberately allowed. Paths relative to repo root.
const ALLOWED_FILES = new Set(
  [
    // CLI / seed scripts — console is the user interface there.
    'backend/src/seed.ts',
    'backend/src/seed-hr.ts',
    'backend/src/seed-postgres.ts',
    'backend/src/migrate-sqlite-to-postgres.ts',
    'backend/src/syncAllProducts.ts',
    'backend/src/db/migrateSemanticToNeo4j.ts',
    // The logger itself.
    'backend/src/utils/logger.ts',
    // Dead code — will be deleted in Phase 3.
    'backend/src/utils/storage.ts',
  ].map((p) => p.split('/').join(sep)),
);

const BANNED = /\bconsole\.(log|warn|error|info|debug)\s*\(/;

function isAllowed(relPath: string): boolean {
  if (ALLOWED_FILES.has(relPath)) return true;
  // Any test file (src/tests/ directory or *.test.ts anywhere).
  if (relPath.split(sep).includes('tests')) return true;
  if (relPath.endsWith('.test.ts')) return true;
  return false;
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
  if (isAllowed(relative('.', file))) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    const trimmed = text.trim();
    // Skip pure comment lines — commented-out code isn't a live call.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (BANNED.test(text)) violations.push({ file, line: i + 1, text: trimmed });
  });
}

if (violations.length === 0) {
  process.stdout.write('lint-no-console: OK — backend/src logs only via the pino logger.\n');
  process.exit(0);
}

process.stderr.write(`lint-no-console: ${violations.length} violation(s) found.\n\n`);
process.stderr.write('Backend code must log via the structured pino logger, not console.*:\n');
process.stderr.write("  import { logger as rootLogger } from '<relative>/utils/logger';\n");
process.stderr.write("  const log = rootLogger.child({ mod: '<module>' });\n");
process.stderr.write('Mind the argument order: log.error({ err }, \'message\') — pino silently\n');
process.stderr.write('drops arguments placed after the message string.\n\n');
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.exit(1);

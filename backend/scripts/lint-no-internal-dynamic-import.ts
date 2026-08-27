/**
 * lint-no-internal-dynamic-import — ratchet for Phase 3 of the code-quality plan.
 *
 * `await import('./…')` / `await import('../…')` of our OWN modules is almost
 * always there to paper over a circular dependency (module A can't statically
 * import module B because B transitively imports A). That hides the cycle
 * instead of fixing it, defeats tree-of-imports reasoning, and moves an
 * import-time failure to request time. New internal dynamic imports are
 * forbidden; the existing ones are grandfathered at the BASELINE below and
 * will be removed as Phase 6 splits the fat modules.
 *
 * The baseline may only ever be LOWERED. When you remove internal dynamic
 * imports, lower BASELINE to the new count in the same commit.
 *
 * Dynamic imports of npm packages (e.g. `await import('exceljs')`) are fine —
 * they lazy-load heavy deps — and are not matched here.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, sep } from 'path';

const SRC = 'backend/src';

// Count as of 2026-07-20 (SyncOrchestrator's SchemaProfiler +
// notificationService imports made static). LOWER this as cycles are
// untangled; never raise it.
const BASELINE = 89;

const PATTERN = /await import\(\s*['"]\.\.?\//g;

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

const hits: Array<{ file: string; line: number; text: string }> = [];
for (const file of walk(SRC)) {
  if (isTestFile(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    const matches = text.match(PATTERN);
    if (matches) {
      for (let m = 0; m < matches.length; m++) {
        hits.push({ file, line: i + 1, text: text.trim() });
      }
    }
  });
}

if (hits.length <= BASELINE) {
  process.stdout.write(
    `lint-no-internal-dynamic-import: OK — ${hits.length} internal dynamic import(s) (baseline ${BASELINE}). ` +
    `Lower the baseline in backend/scripts/lint-no-internal-dynamic-import.ts when you remove more.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `lint-no-internal-dynamic-import: ${hits.length} internal dynamic import(s) found — baseline is ${BASELINE}.\n\n`,
);
process.stderr.write(
  'New `await import(\'./…\')` / `await import(\'../…\')` of our own modules are forbidden.\n' +
  'They paper over circular dependencies instead of fixing them (and move import-time\n' +
  'failures to request time). Restructure the modules so a static import works — usually\n' +
  'by extracting the shared piece into its own file (see services/profilingProgress.ts\n' +
  'for the pattern that broke the connections ↔ SyncOrchestrator cycle).\n' +
  'The baseline only ever goes DOWN as Phase 6 removes the grandfathered ones.\n\n',
);
for (const h of hits) {
  process.stderr.write(`  ${h.file}:${h.line}\n    ${h.text}\n`);
}
process.exit(1);

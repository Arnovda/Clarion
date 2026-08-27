/**
 * lint-validate-coverage — ratchet for Phase 4a of the code-quality plan.
 *
 * Every mutating route (router.post/patch/put/delete) should validate its
 * request body with the Zod `validate()` middleware (middleware/validate.ts +
 * middleware/schemas.ts) instead of blind `req.body as {...}` casts. Phase 4a
 * attached the orphaned schemas and covered the highest-value mutating routes;
 * this lint stops the count of UNVALIDATED mutating routes from growing.
 *
 * Rule: a `router.(post|patch|put|delete)(` declaration counts as validated
 * when `validate(` appears on the same line or within the next 2 lines (the
 * middleware chain may wrap). The baseline below is the unvalidated count at
 * the time Phase 4a shipped — new mutating routes must ship with validate(),
 * and the baseline only ever goes DOWN. When you cover more routes, lower it.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const ROUTES_DIR = 'backend/src/routes';
const BASELINE_UNVALIDATED = 160;

const ROUTE_DECL = /\brouter\.(post|patch|put|delete)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

let total = 0;
let validated = 0;
const unvalidated: Array<{ file: string; line: number; text: string }> = [];

for (const file of walk(ROUTES_DIR)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (!ROUTE_DECL.test(text)) return;
    total += 1;
    // Same statement: look on the declaration line and the next 2 lines for
    // the validate() middleware.
    const window = lines.slice(i, i + 3).join('\n');
    if (/\bvalidate\s*\(/.test(window)) {
      validated += 1;
    } else {
      unvalidated.push({ file, line: i + 1, text: text.trim() });
    }
  });
}

if (unvalidated.length <= BASELINE_UNVALIDATED) {
  process.stdout.write(
    `lint-validate-coverage: OK — ${unvalidated.length}/${total} mutating routes unvalidated ` +
    `(baseline ${BASELINE_UNVALIDATED}, ${validated} validated).\n`,
  );
  if (unvalidated.length < BASELINE_UNVALIDATED) {
    process.stdout.write(
      `lint-validate-coverage: coverage improved — lower BASELINE_UNVALIDATED to ${unvalidated.length} ` +
      `in backend/scripts/lint-validate-coverage.ts to lock it in.\n`,
    );
  }
  process.exit(0);
}

process.stderr.write(
  `lint-validate-coverage: ${unvalidated.length} unvalidated mutating route(s) — baseline is ${BASELINE_UNVALIDATED}.\n\n`,
);
process.stderr.write('New mutating routes must ship with the validate() middleware:\n');
process.stderr.write('  router.post(\'/foo\', requireAuth, validate(fooSchema), handler)\n');
process.stderr.write('Schemas live in backend/src/middleware/schemas.ts. If you validated more\n');
process.stderr.write('routes, lower BASELINE_UNVALIDATED so the ratchet only ever goes down.\n\n');
for (const v of unvalidated) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.exit(1);

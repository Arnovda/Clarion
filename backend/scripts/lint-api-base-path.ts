/**
 * lint-api-base-path — the eleventh ratchet.
 *
 * `frontend/lib/api.ts` creates the axios client with
 * `baseURL: NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'` — the base
 * URL ALREADY ends in `/api`. So every call site passes the path WITHOUT
 * it: `api.get('/dashboards')`, never `api.get('/api/dashboards')`. There
 * is no interceptor that rewrites the path, and no Next.js rewrite: the
 * doubled form resolves to `…/api/api/…` and 404s on every request.
 *
 * This is not hypothetical. It shipped TWICE, in two files, months apart,
 * and neither was caught by tsc, lint or a test — because a wrong URL is a
 * runtime 404, not a type error, and neither surface had a test:
 *
 *   • `EmailSchedulePanel.tsx` — all five calls. Dashboard email schedules
 *     were dead on every request, while the SAME feature worked from Ask
 *     AI's empty state, which used the bare path.
 *   • `AskAIPanel.tsx` — all three calls. The "Ask AI to change this
 *     subject" panel rendered, accepted input and 404'd every submit.
 *
 * Both were found by the 2026-09-07 platform coherence review (D1), which
 * measured 374 call sites on the bare convention against 7 on the doubled
 * one. The two conventions cannot both be right; this ratchet pins which.
 *
 * If `NEXT_PUBLIC_API_URL` is ever changed to NOT end in `/api`, this
 * ratchet is what has to be revisited — and at that point every one of the
 * ~380 bare call sites is the thing that breaks, not these.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, sep } from 'path';

const SRC = 'frontend';

/** `api.get('/api/…`, `api.post<T>(`/api/…` — any verb, either quote. */
const BANNED = /\bapi\s*\.\s*(?:get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*[`'"]\/api\//;
/** Any api.<verb>('/… — used only to prove the scan actually saw the calls. */
const ANY_CALL = /\bapi\s*\.\s*(?:get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*[`'"]\//;

/**
 * A scan that inspects nothing reports exactly what a clean tree reports.
 * The frontend has hundreds of these calls; anything near zero means the
 * matcher or the walk broke, not that the code is clean.
 */
const MIN_CALLS_EXPECTED = 100;

function skip(entry: string): boolean {
  return entry === 'node_modules' || entry === '.next' || entry.startsWith('.');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (skip(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const violations: Array<{ file: string; line: number; text: string }> = [];
let callsSeen = 0;

for (const file of walk(SRC)) {
  if (file.split(sep).includes('tests')) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (ANY_CALL.test(text)) callsSeen += 1;
    if (BANNED.test(text)) violations.push({ file, line: i + 1, text: text.trim() });
  });
}

if (callsSeen < MIN_CALLS_EXPECTED) {
  process.stderr.write(
    `lint-api-base-path: BROKEN SCAN — only ${callsSeen} api call site(s) inspected, ` +
    `expected at least ${MIN_CALLS_EXPECTED}.\nThe walk or the matcher is wrong; ` +
    'a clean report here would be meaningless.\n',
  );
  process.exit(1);
}

if (violations.length === 0) {
  process.stdout.write(
    `lint-api-base-path: OK — ${callsSeen} api call site(s) inspected, none double the /api prefix.\n`,
  );
  process.exit(0);
}

process.stderr.write(`lint-api-base-path: ${violations.length} violation(s) found.\n\n`);
process.stderr.write(
  'The axios client in frontend/lib/api.ts already has `/api` in its baseURL, so a\n' +
  'path starting with `/api/` resolves to `…/api/api/…` and 404s on EVERY request.\n' +
  'Nothing type-checks this and nothing fails loudly — the feature just silently\n' +
  'stops working. Drop the prefix: `/api/email-schedules` becomes `/email-schedules`.\n\n',
);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.exit(1);

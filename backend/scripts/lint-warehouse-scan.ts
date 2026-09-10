/**
 * lint-warehouse-scan — the twelfth ratchet.
 *
 * Ingestion phase 2 (B2) made deletes SOFT: every table a source connector
 * writes carries `_clarion_synced_at` and `_clarion_deleted`, and a row the
 * source no longer has is MARKED rather than removed. That only works because
 * exactly one place hides those rows on the way out —
 * `parquetSelect` / `createScanView` in `backend/src/services/warehouse/views.ts`,
 * which registers a parquet-backed view as
 *
 *     SELECT * EXCLUDE (_clarion_deleted, _clarion_synced_at)
 *     FROM read_parquet('…') WHERE NOT COALESCE(_clarion_deleted, false)
 *
 * A read that reaches the file directly gets the tombstones back, and the two
 * technical columns with them. Nothing about that fails: the query runs, the
 * dashboard renders, the total is wrong. It is the failure mode this platform
 * is least able to notice, which is why it gets a merge gate rather than a
 * convention.
 *
 * The rule this pins: in `backend/src`, a warehouse table is scanned through
 * `createScanView`, never through a bare `read_parquet` / `delta_scan` /
 * `parquet_scan`. The allowlist below names the deliberate exceptions and why
 * each one is safe; entries only ever come OFF it.
 *
 * NOT in scope, on purpose: `packages/connectors` is the WRITER. Its merge,
 * `finalizeFullSync` and `reconcileKeys` must see tombstones — hiding them
 * there would make a revived row invisible to the code whose job is to revive
 * it. The firewall is a read-side rule.
 *
 * Zero runtime deps beyond Node's fs/path (run via `npx tsx`).
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, sep } from 'path';

const SRC = join('backend', 'src');

/** `read_parquet(`, `delta_scan(`, `parquet_scan(` — any casing. */
const SCAN = /\b(?:read_parquet|delta_scan|parquet_scan)\s*\(/i;

/**
 * Files permitted to scan a warehouse path directly. Path is
 * repo-relative and compared with `/` separators.
 */
const ALLOWED: Record<string, string> = {
  'backend/src/services/warehouse/views.ts':
    'The firewall itself. `parquetSelect` IS the rule. Its `delta_scan` branches ' +
    'read Delta directories, which only the legacy ETL and the product-side ' +
    'sidecar write — neither carries the _clarion_* columns. If a source ' +
    'connector ever writes Delta (phase 2 B1, DuckLake), the rule has to move ' +
    'into those branches too.',

  'backend/src/services/transformationRunner.ts':
    "Reads a PRODUCT table's own freshly written output: the incremental merge " +
    "needs every row it is merging, DESCRIBE needs the real column list, and the " +
    'rollup count counts what was just written. Product tables carry no ' +
    '_clarion_* columns — the source rows reached them through createScanView.',

  'backend/src/services/dbtProjectBuilder.ts':
    'Generates on-run-start hook SQL for the dbt engine, which executes in dbt\'s ' +
    'own DuckDB process and therefore cannot call parquetSelect. Allowlisted as ' +
    'UNREACHABLE, not as safe: runProductTransformation refuses to start when ' +
    'USE_DBT_TRANSFORMATIONS is set, pinned by tests/ingestion-firewall.test.ts. ' +
    'Reviving the engine means teaching this builder the firewall first.',
};

/**
 * A scan that inspects nothing reports exactly what a clean tree reports —
 * the failure this repo has already made twice (.ops/prod-logs, twice). The
 * allowlisted files alone hold ~10 of these calls, so anything near zero
 * means the walk or the matcher broke.
 */
const MIN_SCANS_EXPECTED = 6;

/**
 * The firewall file gets a tighter rule than "allowlisted", because the bug
 * this ratchet was written for lived INSIDE it: two of `createScanView`'s
 * fallbacks registered `read_parquet('<dir>/*.parquet')` raw, so a table that
 * did not use the `data.parquet` convention was served with its tombstones.
 * A whole-file exemption would have let that back in. So: exactly ONE
 * `read_parquet(` may appear in views.ts — the one inside `parquetSelect`,
 * which is the rule. Every other scan there must be `delta_scan`.
 */
const VIEWS_FILE = 'backend/src/services/warehouse/views.ts';
const VIEWS_READ_PARQUET_ALLOWED = 1;

/**
 * Blank out comments while keeping every line and every string literal in
 * place, so line numbers stay true and a scan hidden inside a string is still
 * seen. Naively cutting at `//` would eat `read_parquet('az://…')`; naively
 * NOT cutting reports every prose mention of the rule as a breach of it (the
 * first run of this script did exactly that, five times).
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  '; i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function skip(entry: string): boolean {
  return entry === 'node_modules' || entry === 'dist' || entry.startsWith('.');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (skip(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const violations: Array<{ file: string; line: number; text: string }> = [];
let scansSeen = 0;
let viewsReadParquet = 0;
const allowedHit = new Set<string>();

for (const file of walk(SRC)) {
  const rel = file.split(sep).join('/');
  // Tests legitimately write and read fixture parquet directly — they are
  // where the firewall's own behaviour is proven.
  if (rel.includes('/tests/') || rel.endsWith('.test.ts')) continue;
  // Migrations describe historical shapes in comments and DDL.
  if (rel.includes('/db/migrations/')) continue;

  const raw = readFileSync(file, 'utf8').split('\n');
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((code, i) => {
    if (!SCAN.test(code)) return;
    const text = raw[i] ?? code;
    scansSeen += 1;
    if (rel === VIEWS_FILE && /\bread_parquet\s*\(/i.test(code)) viewsReadParquet += 1;
    if (ALLOWED[rel]) { allowedHit.add(rel); return; }
    violations.push({ file: rel, line: i + 1, text: text.trim() });
  });
}

if (scansSeen < MIN_SCANS_EXPECTED) {
  process.stderr.write(
    `lint-warehouse-scan: BROKEN SCAN — only ${scansSeen} warehouse scan(s) inspected, ` +
    `expected at least ${MIN_SCANS_EXPECTED}.\nThe walk or the matcher is wrong; a clean ` +
    'report here would be meaningless.\n',
  );
  process.exit(1);
}

if (viewsReadParquet !== VIEWS_READ_PARQUET_ALLOWED) {
  process.stderr.write(
    `lint-warehouse-scan: ${VIEWS_FILE} holds ${viewsReadParquet} read_parquet( call(s), ` +
    `expected exactly ${VIEWS_READ_PARQUET_ALLOWED}.\n\n` +
    'The only one belongs inside `parquetSelect`, which is where the soft-delete\n' +
    'firewall is applied. A second one means a fallback registers a view straight\n' +
    'over the file again, and every table that takes that fallback serves rows the\n' +
    'source has deleted. Route it through `parquetSelect` instead.\n',
  );
  process.exit(1);
}

// An allowlist entry that matches nothing is a rule nobody is following any
// more. Report it so the list shrinks instead of rotting.
const stale = Object.keys(ALLOWED).filter((f) => !allowedHit.has(f));

if (violations.length === 0) {
  process.stdout.write(
    `lint-warehouse-scan: OK — ${scansSeen} warehouse scan(s) inspected, ` +
    `all outside ${allowedHit.size} allowlisted file(s) go through createScanView.\n`,
  );
  if (stale.length > 0) {
    process.stdout.write(
      `\nSTALE allowlist entr${stale.length === 1 ? 'y' : 'ies'} — no raw scan left in:\n` +
      stale.map((f) => `  ${f}\n`).join('') +
      'Remove the entry from backend/scripts/lint-warehouse-scan.ts.\n',
    );
  }
  process.exit(0);
}

process.stderr.write(`lint-warehouse-scan: ${violations.length} violation(s) found.\n\n`);
process.stderr.write(
  'A warehouse table read with a bare read_parquet / delta_scan sees the rows a\n' +
  'source has DELETED (phase 2 marks them, it does not remove them) and the two\n' +
  '_clarion_* technical columns. Nothing errors: the query runs and the number is\n' +
  'wrong. Register the table with `createScanView` from services/warehouse, or —\n' +
  'when you are reading a file this code just wrote and must see whole — add the\n' +
  'file to ALLOWED in this script with the reason.\n\n',
);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.text}\n`);
}
process.exit(1);

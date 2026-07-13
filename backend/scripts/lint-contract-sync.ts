/**
 * lint-contract-sync — ratchet for Phase 4b of the code-quality plan.
 *
 * The shared API contract (`ApiResponse`, `JwtPayload`, the dashboard spec
 * types, `ConnectionDto`, `DataProductDto`, …) is maintained as TWO
 * BYTE-IDENTICAL COPIES:
 *
 *     backend/src/shared/contract.ts
 *     frontend/lib/contract.ts
 *
 * Two copies because the frontend Docker image is built with `frontend/` as
 * its entire build context, so it cannot reach a shared package outside that
 * directory. This lint is what makes the two copies behave as one file: any
 * edit that lands in only one of them fails CI.
 *
 * Comparison is byte-for-byte after normalising CRLF → LF (git autocrlf on
 * Windows means the working-tree copies may legitimately differ in line
 * endings only — that is not drift).
 *
 * Zero runtime deps beyond Node's fs/path/crypto (run via `npx tsx`).
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const BACKEND_COPY = join('backend', 'src', 'shared', 'contract.ts');
const FRONTEND_COPY = join('frontend', 'lib', 'contract.ts');

function fail(message: string): never {
  process.stderr.write(`lint-contract-sync: ${message}\n`);
  process.exit(1);
}

for (const file of [BACKEND_COPY, FRONTEND_COPY]) {
  if (!existsSync(file)) {
    fail(`missing copy: ${file}\nBoth copies of the shared contract must exist.`);
  }
}

// Normalise line endings so git autocrlf checkouts don't false-positive.
const normalise = (s: string): string => s.replace(/\r\n/g, '\n');

const backendText = normalise(readFileSync(BACKEND_COPY, 'utf8'));
const frontendText = normalise(readFileSync(FRONTEND_COPY, 'utf8'));

if (backendText !== frontendText) {
  const backendLines = backendText.split('\n');
  const frontendLines = frontendText.split('\n');
  let firstDiff = -1;
  const max = Math.max(backendLines.length, frontendLines.length);
  for (let i = 0; i < max; i++) {
    if (backendLines[i] !== frontendLines[i]) { firstDiff = i; break; }
  }

  process.stderr.write('lint-contract-sync: the two copies of the shared API contract DIFFER.\n\n');
  process.stderr.write(`  ${BACKEND_COPY}\n  ${FRONTEND_COPY}\n\n`);
  process.stderr.write('These files are one logical module kept as two byte-identical copies\n');
  process.stderr.write('(the frontend Docker build context cannot reach a shared package).\n');
  process.stderr.write('Edit BOTH copies together — apply the same change verbatim to the other\n');
  process.stderr.write('file (or copy the edited file over the stale one) and re-run this lint.\n\n');
  if (firstDiff >= 0) {
    process.stderr.write(`First difference at line ${firstDiff + 1}:\n`);
    process.stderr.write(`  backend : ${backendLines[firstDiff] ?? '<end of file>'}\n`);
    process.stderr.write(`  frontend: ${frontendLines[firstDiff] ?? '<end of file>'}\n`);
  }
  process.exit(1);
}

const sha = createHash('sha256').update(backendText).digest('hex');
process.stdout.write(`lint-contract-sync: OK — both contract copies are byte-identical (sha256 ${sha.slice(0, 12)}…).\n`);
process.exit(0);

#!/usr/bin/env node
/**
 * Vendor the Python runtime the notebooks use so the browser never contacts
 * a CDN (assessment 4-2: every notebook open pulled Pyodide from jsdelivr,
 * a host that appears in no subprocessor list).
 *
 * What lands in public/pyodide/ (gitignored, built at `npm run build`):
 *   - the runtime core, copied from the `pyodide` npm package (same version
 *     the loader pins) — pyodide.mjs, pyodide.asm.js, pyodide.asm.wasm,
 *     python_stdlib.zip, pyodide-lock.json;
 *   - the wheels for numpy, pandas and matplotlib AND their dependency
 *     closure, resolved from pyodide-lock.json and downloaded from the
 *     Pyodide CDN with the lock file's sha256 checked on every file. The
 *     npm package does not ship wheels, so this is the one build-time
 *     network step; it runs where images are built (CI), never in a
 *     customer's browser.
 *
 * Idempotent: a file already present with the right hash is skipped, so a
 * warm checkout costs nothing. `PYODIDE_VENDOR=skip` skips everything
 * (local dev without egress) — the loader then falls back to the CDN in
 * development only, and refuses in production (see usePyodide.ts).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkgDir = join(root, 'node_modules', 'pyodide');
const outDir = join(root, 'public', 'pyodide');

const PACKAGES = ['numpy', 'pandas', 'matplotlib'];
const CORE = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

if (process.env.PYODIDE_VENDOR === 'skip') {
  console.log('vendor-pyodide: skipped (PYODIDE_VENDOR=skip)');
  process.exit(0);
}
if (!existsSync(join(pkgDir, 'pyodide-lock.json'))) {
  console.error('vendor-pyodide: node_modules/pyodide is missing — run npm ci');
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const CDN = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
mkdirSync(outDir, { recursive: true });

for (const f of CORE) {
  copyFileSync(join(pkgDir, f), join(outDir, f));
}
console.log(`vendor-pyodide: core ${version} copied (${CORE.length} files)`);

const lock = JSON.parse(readFileSync(join(pkgDir, 'pyodide-lock.json'), 'utf8'));
const wanted = new Set();
const stack = [...PACKAGES];
while (stack.length) {
  const name = stack.pop();
  if (wanted.has(name)) continue;
  const p = lock.packages[name];
  if (!p) { console.error(`vendor-pyodide: ${name} is not in pyodide-lock.json`); process.exit(1); }
  wanted.add(name);
  stack.push(...(p.depends ?? []));
}
const files = [...wanted].sort().map((n) => ({ name: n, file: lock.packages[n].file_name, sha256: lock.packages[n].sha256 }));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const dryRun = process.argv.includes('--dry-run');
let downloaded = 0, kept = 0, bytes = 0;
for (const f of files) {
  const dest = join(outDir, f.file);
  if (existsSync(dest) && sha(readFileSync(dest)) === f.sha256) { kept++; continue; }
  if (dryRun) { console.log(`  would fetch ${f.file}`); continue; }
  const res = await fetch(CDN + f.file);
  if (!res.ok) { console.error(`vendor-pyodide: ${CDN}${f.file} → HTTP ${res.status}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== f.sha256) { console.error(`vendor-pyodide: sha256 mismatch for ${f.file} — refusing to ship it`); process.exit(1); }
  writeFileSync(dest, buf);
  downloaded++; bytes += buf.length;
}
console.log(`vendor-pyodide: ${files.length} wheels (${[...wanted].sort().join(', ')}) — ${downloaded} downloaded (${(bytes / 1048576).toFixed(1)} MB), ${kept} already present${dryRun ? ' [dry run]' : ''}`);

#!/usr/bin/env node
/**
 * Dependency-audit gate.
 *
 * `npm audit` on its own is all-or-nothing: either it fails the build on every
 * advisory — including ones with no published fix, which would leave the gate
 * permanently red and therefore permanently ignored — or it runs advisory-only
 * and nobody looks. Clarion had the second shape: `continue-on-error: true` on
 * both audit steps in test.yml, with a comment promising to re-tighten "once
 * the backlog is triaged". The backlog grew to 58 advisories instead.
 *
 * This gate splits the difference. It FAILS on any high or critical advisory
 * that is not explicitly listed below, and each entry in that list carries the
 * reason it is tolerated. New advisories are red on the first PR that pulls
 * them in; known-and-reasoned ones stay quiet until a fix ships.
 *
 * Usage:  node scripts/audit-gate.mjs <workspace-dir>
 *
 * Adding an entry is a deliberate act. Write down WHY — "no fix published"
 * and "not reachable from the request path" are reasons; "it was already
 * failing" is not. Remove an entry the moment a fix exists: a stale
 * allowlist silently re-opens the hole it was written for.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Advisories tolerated per workspace, keyed by the package npm reports.
 *
 * Two categories qualify, and only these two:
 *   • BUILD-CHAIN — runs during `npm install`/native compilation, never in the
 *     request path. Nothing an HTTP request reaches can drive it.
 *   • DEV-ONLY — test/lint tooling that is not in the production image.
 *
 * Anything runtime-exposed gets fixed, not listed.
 */
const ALLOW = {
  backend: {
    // duckdb ships a native addon; these are its build toolchain and have no
    // published fix. They execute at image-build time, not per request.
    tar:                 'BUILD-CHAIN duckdb -> @mapbox/node-pre-gyp; no fix published',
    'node-gyp':          'BUILD-CHAIN duckdb; no fix published',
    cacache:             'BUILD-CHAIN duckdb -> node-gyp; no fix published',
    'make-fetch-happen': 'BUILD-CHAIN duckdb -> node-gyp; no fix published',
    'brace-expansion':   'BUILD-CHAIN duckdb -> node-gyp -> glob',
    'ip-address':        'BUILD-CHAIN duckdb -> node-gyp -> make-fetch-happen',
    duckdb:              'BUILD-CHAIN the native addon itself; no fix published',
    'duckdb-async':      'BUILD-CHAIN wrapper around duckdb; no fix published',
    // vitest's bundler. Not in the production image.
    vite:                'DEV-ONLY vitest',
    postcss:             'DEV-ONLY vitest -> vite',
  },

  frontend: {
    // The only published fix is next@16 — two majors above the pinned 14.2.35,
    // and 14.x has no patch. The live advisory is a DoS in the Image Optimizer
    // driven by `remotePatterns`; this app sets no `remotePatterns` and imports
    // `next/image` nowhere, so the vulnerable path is unreachable. Tracked as
    // its own upgrade; re-check this reasoning whenever a new next advisory
    // lands, because "unreachable" is a claim about TODAY's config.
    next:                       'DEFERRED fix is next@16 (2 majors); Image Optimizer path unreachable — no remotePatterns, no next/image import',
    'eslint-config-next':       'DEV-ONLY resolves with the next@16 upgrade',
    '@next/eslint-plugin-next': 'DEV-ONLY resolves with the next@16 upgrade',
    glob:                       'DEV-ONLY eslint-config-next; the advisory is in glob CLI, which nothing here invokes',
    'brace-expansion':          'DEV-ONLY eslint/glob; fixed version is several majors above what they pin',
  },

  'packages/connectors': {
    tar:                 'BUILD-CHAIN duckdb -> @mapbox/node-pre-gyp; no fix published',
    'node-gyp':          'BUILD-CHAIN duckdb; no fix published',
    cacache:             'BUILD-CHAIN duckdb -> node-gyp; no fix published',
    'make-fetch-happen': 'BUILD-CHAIN duckdb -> node-gyp; no fix published',
    'brace-expansion':   'BUILD-CHAIN duckdb -> node-gyp -> glob',
    'ip-address':        'BUILD-CHAIN duckdb -> node-gyp -> make-fetch-happen',
    duckdb:              'BUILD-CHAIN the native addon itself; no fix published',
    'duckdb-async':      'BUILD-CHAIN wrapper around duckdb; no fix published',
    vitest:              'DEV-ONLY fix is vitest@4 (2 majors); tracked separately so the DuckDB-native suites can be run against it',
    vite:                'DEV-ONLY vitest',
    postcss:             'DEV-ONLY vitest -> vite',
  },
};

const BLOCKING = new Set(['high', 'critical']);

const workspace = process.argv[2];
if (!workspace || !(workspace in ALLOW)) {
  console.error(`usage: node scripts/audit-gate.mjs <${Object.keys(ALLOW).join('|')}>`);
  process.exit(2);
}

const allowed = ALLOW[workspace];
const cwd = resolve(process.cwd(), workspace);

// `npm audit` exits non-zero when it finds anything, so the throw carries the
// payload we actually want. Read stdout in both cases.
let raw;
try {
  raw = execFileSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout;
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error(`audit-gate: could not parse npm audit output for ${workspace}`);
  console.error(String(raw).slice(0, 2000));
  process.exit(2);
}

const found = Object.values(report.vulnerabilities ?? {}).filter((v) => BLOCKING.has(v.severity));
const blocking = found.filter((v) => !(v.name in allowed));
const tolerated = found.filter((v) => v.name in allowed);

console.log(`\n=== audit gate: ${workspace} ===`);
console.log(`totals: ${JSON.stringify(report.metadata?.vulnerabilities ?? {})}`);

if (tolerated.length) {
  console.log(`\ntolerated (${tolerated.length}) — each with a recorded reason:`);
  for (const v of tolerated.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  · ${v.severity.padEnd(8)} ${v.name.padEnd(26)} ${allowed[v.name]}`);
  }
}

// An allowlist entry that no longer matches anything is worth surfacing: it
// usually means a fix shipped and the entry should go, and leaving it behind
// would silently tolerate the advisory if it ever came back.
const stale = Object.keys(allowed).filter((name) => !found.some((v) => v.name === name));
if (stale.length) {
  console.log(`\nstale allowlist entries (no longer reported — remove them): ${stale.join(', ')}`);
}

if (blocking.length) {
  console.error(`\nBLOCKING (${blocking.length}) — high/critical with no recorded exemption:`);
  for (const v of blocking.sort((a, b) => a.name.localeCompare(b.name))) {
    const fix = v.fixAvailable
      ? (typeof v.fixAvailable === 'object'
          ? `fix: ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (MAJOR)' : ''}`
          : 'fix available')
      : 'NO FIX PUBLISHED';
    console.error(`  ✗ ${v.severity.padEnd(8)} ${v.name.padEnd(26)} ${fix}`);
    console.error(`      vulnerable: ${v.range}`);
  }
  console.error(
    '\nFix it, or — if it is genuinely build-chain or dev-only — add it to ALLOW\n' +
    'in scripts/audit-gate.mjs with the reason. Do not add a runtime-exposed\n' +
    'package to the allowlist.\n',
  );
  process.exit(1);
}

console.log('\nno unexplained high/critical advisories.\n');

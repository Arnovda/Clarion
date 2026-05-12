'use client';

/**
 * Singleton lifecycle for DuckDB-WASM in the browser.
 *
 * Phase 5a of the dashboard performance roadmap: an opt-in "fast mode"
 * that runs widget SQL directly against an in-browser DuckDB instance
 * loaded with the dashboard's underlying Parquet data. Eliminates the
 * server round-trip on every filter / cross-filter / drill click —
 * Power-BI/Qlik-level instant.
 *
 * Two important architectural choices made up front:
 *
 *   1. Bundle selection: we use `selectBundle()` which auto-picks the
 *      best of MVP / EH / COI based on the browser's capabilities.
 *      MVP works everywhere modern (no SharedArrayBuffer, no COEP
 *      headers needed). EH adds exception handling (faster). COI adds
 *      multi-threading via SharedArrayBuffer (needs Cross-Origin
 *      headers). When COEP headers aren't set on the deployment, we
 *      gracefully fall back to MVP. So this works in production
 *      WITHOUT any infra change today — speed gains are upper-bounded
 *      until we set the headers, but the feature isn't blocked.
 *
 *   2. JsDelivr bundles by default: getJsDelivrBundles() returns CDN
 *      URLs for the worker + wasm assets. Default is fine for a PoC;
 *      production would self-host these assets to avoid the CDN
 *      dependency. Self-hosting = copying 3 files to /public.
 *
 * The singleton is lazy-initialised — the first call to getWasmDb()
 * pays the ~200ms-1s init cost; subsequent calls return the cached
 * instance. Closing the tab tears it down naturally; we don't expose
 * an explicit dispose because there's no use case for it today.
 */

import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';

let instance: AsyncDuckDB | null = null;
let initPromise: Promise<AsyncDuckDB> | null = null;

export interface WasmInitResult {
  db: AsyncDuckDB;
  /** Which bundle was picked. Useful for telemetry / dev info. */
  bundleType: 'mvp' | 'eh' | 'coi';
}

/**
 * Lazily build (or return the cached) DuckDB-WASM instance.
 *
 * Errors propagate to the caller — the dashboard's WASM path should
 * catch them and fall back to the server path silently. Never let a
 * WASM init failure crash the dashboard.
 */
export async function getWasmDb(): Promise<AsyncDuckDB> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dynamic import keeps the ~3-5MB WASM lib out of the main bundle.
    // Only the dashboards page pulls it in, and only when the user
    // toggles fast mode on.
    const duckdb = await import('@duckdb/duckdb-wasm');

    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    if (!bundle.mainModule || !bundle.mainWorker) {
      throw new Error('DuckDB-WASM: no compatible bundle for this browser');
    }

    // The worker bundle is fetched as text, wrapped in a Blob URL.
    // Library convention — see duckdb-wasm's quick-start.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
    );

    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    instance = db;
    return db;
  })();

  try {
    return await initPromise;
  } catch (err) {
    // Allow the next call to retry; cached failure would be worse than
    // a fresh attempt after, e.g., a transient network blip on the CDN.
    initPromise = null;
    throw err;
  }
}

/**
 * True when DuckDB-WASM is available + the browser meets baseline
 * requirements. Used by the toggle UI to decide whether to surface
 * the "Fast mode" affordance at all.
 */
export function isWasmSupported(): boolean {
  if (typeof window === 'undefined') return false;
  // WebAssembly is the floor; everything else (SharedArrayBuffer, etc)
  // is bonus. The MVP bundle works without those.
  return typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
}

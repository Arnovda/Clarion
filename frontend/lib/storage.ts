/**
 * Centralised browser-storage access.
 *
 * Every localStorage/sessionStorage touch in the app goes through these
 * helpers so:
 *   - SSR renders never crash (`typeof window` guard),
 *   - Safari private mode / disabled storage never throws (try/catch —
 *     setItem throws QuotaExceededError there),
 *   - the string keys live in ONE place (`storageKeys`) instead of being
 *     scattered as inline literals across 12 files.
 *
 * lib/auth.ts wraps the token keys with its own typed API on top of this.
 */

export const storageKeys = {
  /** JWT access token (see lib/auth.ts). */
  token: 'clarion_token',
  /** JWT refresh token (see lib/auth.ts). */
  refreshToken: 'clarion_refresh_token',
  /** /query — last-used data source key ('c:<id>' / 'v:<id>'). */
  querySource: 'clarion_query_source',
  /** /dashboards — DuckDB-WASM fast-mode toggle ('1' / '0'). */
  fastMode: 'clarion:fastMode',
  /** /products — active bus-matrix job id, for reattach after reload. */
  busMatrixJobId: 'busMatrixJobId',
  /** IconRail — persisted width/collapsed/open-groups JSON. */
  navRail: 'clarion:navRail',
  /** /catalog — cards vs structure view mode. */
  catalogViewMode: 'catalog:viewMode',
  /** /catalog — sources/products/all layer filter (structure mode). */
  catalogLayer: 'catalog:layer',
  /** /catalog — grid vs list layout (cards mode). */
  catalogCardsLayout: 'catalog:cardsLayout',
  /** Catalog relationships diagram — left rail collapsed state. */
  catalogDiagramRail: 'catalog:diagram:rail',
  /** Product detail — AI panel open state ('1' / '0'). */
  productDetailAiPanel: 'product-detail:ai-panel-open',
  /** TopBar tenant chip — cached org name (sessionStorage). */
  tenantName: 'clarion_tenant_name',
} as const;

export type StorageKey = (typeof storageKeys)[keyof typeof storageKeys] | string;

export function getItem(key: StorageKey): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function setItem(key: StorageKey, value: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable — ignore */ }
}

export function removeItem(key: StorageKey): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

// ── sessionStorage variants ─────────────────────────────────────────────────

export function getSessionItem(key: StorageKey): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

export function setSessionItem(key: StorageKey, value: string): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(key, value); } catch { /* ignore */ }
}

export function removeSessionItem(key: StorageKey): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(key); } catch { /* ignore */ }
}

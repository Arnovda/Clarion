/**
 * Odoo transport abstraction.
 *
 * Odoo exposes the same model methods over several wire protocols. We isolate
 * the protocol behind `OdooTransport` so the connector's discover/read logic
 * never touches XML or JSON envelopes — and so the protocol can be swapped as
 * Odoo deprecates older ones.
 *
 * Two implementations:
 *   • Json2Transport  (PRIMARY)  — Odoo 17+/Online `/json/2` REST API, bearer
 *     token auth. The only non-deprecated path: `/xmlrpc/2` and `/jsonrpc` are
 *     deprecated as of Odoo 19 and slated for removal (earliest on Odoo
 *     Online). Plain HTTP+JSON, so it reuses the shared HttpClient.
 *   • XmlRpcTransport (FALLBACK) — `/xmlrpc/2` for older on-prem instances that
 *     don't expose `/json/2`.
 *
 * `resolveOdooTransport` probes JSON-2 and falls back to XML-RPC when the
 * endpoint is absent. Selection is automatic — version differences are handled
 * without configuration.
 *
 * SAFETY: this layer is strictly read-only. `assertReadOnly` rejects any model
 * method outside the allow-list, so a coding mistake can never issue a
 * create/write/unlink. Both transports route every call through it.
 */

import type { Logger } from '../types';
import type { OdooConfig } from './schema';
import { Json2Transport } from './json2Transport';
import { XmlRpcTransport } from './xmlrpcTransport';

/** Odoo `fields_get` per-field metadata (we only need type + store). */
export interface OdooFieldMeta {
  type: string;
  store?: boolean;
  [k: string]: unknown;
}

/** A search domain — Odoo's list of `[field, op, value]` triplets / operators. */
export type OdooDomain = unknown[];

export interface OdooSearchReadParams {
  domain: OdooDomain;
  fields: string[];
  limit: number;
  offset: number;
  order: string;
}

export interface OdooTransport {
  readonly kind: 'json2' | 'xmlrpc';
  /**
   * Confirm credentials work against the instance. Throws `OdooAuthError` when
   * the credentials are rejected, `OdooEndpointMissingError` when this
   * transport's endpoint doesn't exist (JSON-2 only — triggers fallback).
   * Returns optional display detail for the wizard's success panel.
   */
  verify(): Promise<{ detail?: Record<string, string> }>;
  fieldsGet(model: string): Promise<Record<string, OdooFieldMeta>>;
  searchCount(model: string, domain: OdooDomain): Promise<number>;
  searchRead(model: string, params: OdooSearchReadParams): Promise<Record<string, unknown>[]>;
}

// ─── Errors ─────────────────────────────────────────────────────────────────
export class OdooAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'OdooAuthError'; }
}
/** Thrown by JSON-2 when `/json/2` returns 404 — the instance is too old. */
export class OdooEndpointMissingError extends Error {
  constructor(message: string) { super(message); this.name = 'OdooEndpointMissingError'; }
}
/** Thrown when a non-read-only method is attempted. Defence in depth. */
export class OdooReadOnlyViolation extends Error {
  constructor(method: string) {
    super(`Refusing non-read-only Odoo method '${method}'. The connector is strictly read-only.`);
    this.name = 'OdooReadOnlyViolation';
  }
}

/**
 * The ONLY model methods the connector is ever allowed to call. Anything that
 * could mutate Odoo (create / write / unlink / action_* / button_*) is absent
 * by construction. Both transports assert against this before every call.
 */
export const READONLY_METHODS: ReadonlySet<string> = new Set([
  'fields_get',
  'search',
  'search_read',
  'search_count',
  'read',
  'read_group',
]);

export function assertReadOnly(method: string): void {
  if (!READONLY_METHODS.has(method)) {
    throw new OdooReadOnlyViolation(method);
  }
}

// ─── Resolver ────────────────────────────────────────────────────────────────
/**
 * Pick the best available transport for an instance. Tries JSON-2 first
 * (preferred + future-proof); on a missing `/json/2` endpoint falls back to
 * XML-RPC. Auth failures are NOT a fallback trigger — the same credentials
 * would fail on XML-RPC too, so we surface the auth error immediately.
 *
 * The transports import only VALUES used at call time from this module
 * (`assertReadOnly`, the error classes), so the static import cycle here is
 * benign — nothing is referenced at module-load time.
 */
export async function resolveOdooTransport(
  config: OdooConfig,
  log: Logger,
): Promise<{ transport: OdooTransport; detail?: Record<string, string> }> {
  const json2 = new Json2Transport(config, log);
  try {
    const { detail } = await json2.verify();
    log.info('Odoo: using JSON-2 transport');
    return { transport: json2, detail };
  } catch (e) {
    if (e instanceof OdooEndpointMissingError) {
      log.info('Odoo: /json/2 unavailable — falling back to XML-RPC transport');
      const xml = new XmlRpcTransport(config, log);
      const { detail } = await xml.verify();
      return { transport: xml, detail };
    }
    throw e;
  }
}

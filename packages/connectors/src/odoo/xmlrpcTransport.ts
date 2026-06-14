/**
 * Odoo XML-RPC transport (`/xmlrpc/2`) — fallback for instances that predate
 * the JSON-2 API (Odoo ≤ ~16 on-prem).
 *
 *   common.authenticate(db, username, api_key, {})        → uid
 *   object.execute_kw(db, uid, api_key, model, method, [args], {kwargs})
 *
 * Auth is in the body (db / uid / api_key), so this transport sends NO
 * Authorization header. It still goes through HttpClient for retry, redaction,
 * and rate limiting. Read-only by construction — every call is gated by
 * `assertReadOnly`.
 */

import { HttpClient, HttpError } from '../HttpClient';
import type { Logger } from '../types';
import type { OdooConfig } from './schema';
import { encodeMethodCall, parseMethodResponse, XmlRpcFault } from './xmlrpcCodec';
import {
  assertReadOnly,
  OdooAuthError,
  type OdooDomain,
  type OdooFieldMeta,
  type OdooSearchReadParams,
  type OdooTransport,
} from './transport';

const ODOO_REQUESTS_PER_SECOND = 1;

export class XmlRpcTransport implements OdooTransport {
  readonly kind = 'xmlrpc' as const;
  private readonly http: HttpClient;
  private uid: number | null = null;

  constructor(private readonly config: OdooConfig, log: Logger) {
    this.http = new HttpClient({
      baseUrl: config.url,
      log,
      maxRetries: 6,
      requestsPerSecond: ODOO_REQUESTS_PER_SECOND,
      // No authHeader: XML-RPC carries credentials in the request body.
    });
  }

  async verify(): Promise<{ detail?: Record<string, string> }> {
    const uid = await this.ensureAuth();
    return { detail: { transport: 'XML-RPC', database: this.config.db, uid: String(uid) } };
  }

  async fieldsGet(model: string): Promise<Record<string, OdooFieldMeta>> {
    const res = await this.executeKw(model, 'fields_get', [], { attributes: ['type', 'store'] });
    return (res ?? {}) as Record<string, OdooFieldMeta>;
  }

  async searchCount(model: string, domain: OdooDomain): Promise<number> {
    const res = await this.executeKw(model, 'search_count', [domain], {});
    return typeof res === 'number' ? res : Number(res) || 0;
  }

  async searchRead(model: string, params: OdooSearchReadParams): Promise<Record<string, unknown>[]> {
    const res = await this.executeKw(model, 'search_read', [params.domain], {
      fields: params.fields,
      limit: params.limit,
      offset: params.offset,
      order: params.order,
    });
    return Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
  }

  // ─── Internals ─────────────────────────────────────────────────────────
  private async ensureAuth(): Promise<number> {
    if (this.uid != null) return this.uid;
    const res = await this.rpc('/xmlrpc/2/common', 'authenticate', [
      this.config.db,
      this.config.username,
      this.config.apiKey,
      {},
    ]);
    // Odoo returns the integer uid on success, or `false` on bad credentials.
    if (typeof res !== 'number' || res <= 0) {
      throw new OdooAuthError('Odoo authentication failed (check URL, database, username and API key).');
    }
    this.uid = res;
    return res;
  }

  private async executeKw(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    assertReadOnly(method);
    const uid = await this.ensureAuth();
    return this.rpc('/xmlrpc/2/object', 'execute_kw', [
      this.config.db,
      uid,
      this.config.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  private async rpc(path: string, method: string, params: unknown[]): Promise<unknown> {
    const xml = encodeMethodCall(method, params);
    try {
      const resp = await this.http.request<string>({
        method: 'POST',
        url: path,
        headers: { 'Content-Type': 'text/xml', Accept: 'text/xml' },
        body: xml,
      });
      const raw = typeof resp.body === 'string' ? resp.body : String(resp.body);
      return parseMethodResponse(raw);
    } catch (e) {
      throw this.mapError(e, method);
    }
  }

  private mapError(e: unknown, method: string): Error {
    if (e instanceof XmlRpcFault) {
      const msg = e.message.toLowerCase();
      if (msg.includes('access') || msg.includes('login') || msg.includes('credential') || msg.includes('password')) {
        return new OdooAuthError('Odoo rejected the credentials.');
      }
      return new Error(`Odoo XML-RPC ${method} fault: ${e.message}`);
    }
    if (e instanceof HttpError) {
      if (e.status === 401 || e.status === 403) {
        return new OdooAuthError('Odoo rejected the API key.');
      }
      return new Error(`Odoo XML-RPC ${method} failed: HTTP ${e.status}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}

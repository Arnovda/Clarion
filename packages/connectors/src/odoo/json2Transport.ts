/**
 * Odoo JSON-2 transport (`/json/2`) — the primary, future-proof path.
 *
 * Odoo 19 introduced the JSON-2 API as the replacement for the now-deprecated
 * `/xmlrpc/2` and `/jsonrpc` endpoints. It's plain HTTP+JSON:
 *
 *   POST {url}/json/2/{model}/{method}
 *   Authorization: bearer <api_key>
 *   X-Odoo-Database: <db>
 *   Content-Type: application/json
 *   body: { ...named kwargs }      → returns the method's JSON result
 *
 * Because it's ordinary REST it reuses the shared HttpClient (retry, redaction,
 * and — critically for Odoo Online's ~1 req/sec throttle — client-side rate
 * limiting).
 */

import { HttpClient, HttpError } from '../HttpClient';
import type { Logger } from '../types';
import type { OdooConfig } from './schema';
import {
  assertReadOnly,
  OdooAuthError,
  OdooEndpointMissingError,
  type OdooDomain,
  type OdooFieldMeta,
  type OdooSearchReadParams,
  type OdooTransport,
} from './transport';

/** Odoo Online throttles around ~1 req/sec sustained; pace to stay under it. */
const ODOO_REQUESTS_PER_SECOND = 1;

export class Json2Transport implements OdooTransport {
  readonly kind = 'json2' as const;
  private readonly http: HttpClient;

  constructor(private readonly config: OdooConfig, log: Logger) {
    this.http = new HttpClient({
      baseUrl: config.url,
      authHeader: `bearer ${config.apiKey}`,
      log,
      maxRetries: 6,
      requestsPerSecond: ODOO_REQUESTS_PER_SECOND,
    });
  }

  async verify(): Promise<{ detail?: Record<string, string> }> {
    // Cheap, always-present probe. Distinguishes "endpoint missing" (old Odoo)
    // from "auth rejected" so the resolver only falls back to XML-RPC in the
    // former case.
    await this.searchCount('res.users', [['id', '=', 1]]);
    return { detail: { transport: 'JSON-2', database: this.config.db } };
  }

  async fieldsGet(model: string): Promise<Record<string, OdooFieldMeta>> {
    return this.call<Record<string, OdooFieldMeta>>(model, 'fields_get', {
      attributes: ['type', 'store'],
    });
  }

  async searchCount(model: string, domain: OdooDomain): Promise<number> {
    const n = await this.call<number>(model, 'search_count', { domain });
    return typeof n === 'number' ? n : Number(n) || 0;
  }

  async searchRead(model: string, params: OdooSearchReadParams): Promise<Record<string, unknown>[]> {
    const rows = await this.call<Record<string, unknown>[]>(model, 'search_read', {
      domain: params.domain,
      fields: params.fields,
      limit: params.limit,
      offset: params.offset,
      order: params.order,
    });
    return Array.isArray(rows) ? rows : [];
  }

  // ─── Internals ─────────────────────────────────────────────────────────
  private async call<T>(model: string, method: string, body: Record<string, unknown>): Promise<T> {
    assertReadOnly(method);
    try {
      const resp = await this.http.request<T>({
        method: 'POST',
        url: `/json/2/${model}/${method}`,
        headers: {
          'X-Odoo-Database': this.config.db,
          'Content-Type': 'application/json',
        },
        body,
      });
      return resp.body;
    } catch (e) {
      throw this.mapError(e, model, method);
    }
  }

  private mapError(e: unknown, model: string, method: string): Error {
    if (e instanceof HttpError) {
      if (e.status === 404) {
        // 404 on a known model (res.users during verify) means the /json/2
        // router itself is absent → this Odoo predates JSON-2. Trigger
        // fallback. For other models a 404 is unusual but treated the same
        // (the resolver only probes res.users, so this is the right signal).
        return new OdooEndpointMissingError(
          `Odoo /json/2 endpoint not found (HTTP 404). Instance likely predates the JSON-2 API.`,
        );
      }
      if (e.status === 401 || e.status === 403) {
        return new OdooAuthError('Odoo rejected the API key (check URL, database, username and key).');
      }
      return new Error(`Odoo JSON-2 ${method} on ${model} failed: HTTP ${e.status}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}

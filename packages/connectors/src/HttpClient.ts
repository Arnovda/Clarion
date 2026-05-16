/**
 * HTTP client for connector implementations.
 *
 * What it adds on top of plain axios:
 *   • automatic retry on 429 (rate-limited, respects Retry-After) and 5xx
 *   • plug-in token refresh: when a request returns 401, an `onUnauthorised`
 *     callback runs once to refresh credentials, then the request is retried
 *   • request/response redaction so headers + bodies in error messages
 *     never carry raw bearer tokens or client secrets
 *   • generous default timeouts; per-request override available
 *   • structured error type so connectors don't have to inspect axios shapes
 *
 * Connectors should NOT use axios directly. Always go through HttpClient
 * — that's how we guarantee the redaction guarantees in `BaseSourceConnector`'s
 * logger actually hold (an axios error caught by the user's try/catch could
 * otherwise carry an Authorization header straight to console.error).
 */

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { Logger } from './types';

export interface HttpClientOptions {
  /** Base URL prepended to relative paths. Optional. */
  baseUrl?: string;

  /** Default Authorization header value (e.g. `Bearer xxx`). Override per-request via `headers`. */
  authHeader?: string;

  /** Default request timeout (ms). Default: 60_000. */
  timeoutMs?: number;

  /** Max retry attempts on 429 / 5xx. Default: 5. */
  maxRetries?: number;

  /**
   * Called when a request returns 401. Should refresh the credential and
   * return a new Authorization header value to use for the retry.
   *
   * Returning `null` means "give up, surface the 401 to the caller".
   *
   * Throwing from here propagates to the caller (treated as auth failure).
   */
  onUnauthorised?: () => Promise<string | null>;

  /**
   * Logger for transient warnings (retries, token refreshes). Required so we
   * never accidentally fall back to console.log.
   */
  log: Logger;
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute URL or relative to `baseUrl`. */
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Per-request timeout override. */
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

/**
 * Structured error connectors can pattern-match on. Axios's own errors
 * carry the full request config including headers — we keep them off the
 * structured error so they can't leak via stack-trace logging.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly responseBodyExcerpt: string | undefined,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly opts: HttpClientOptions;
  private currentAuthHeader: string | undefined;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.currentAuthHeader = opts.authHeader;
    this.axios = axios.create({
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs ?? 60_000,
      // We handle non-2xx ourselves so retry / 401-refresh logic runs.
      validateStatus: () => true,
    });
  }

  /** Update the Authorization header used for subsequent requests. */
  setAuthHeader(value: string | undefined): void {
    this.currentAuthHeader = value;
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    return this.requestWithRetries<T>(req, 0, /* unauthorisedHandled */ false);
  }

  private async requestWithRetries<T>(
    req: HttpRequest,
    attempt: number,
    unauthorisedHandled: boolean,
  ): Promise<HttpResponse<T>> {
    const maxRetries = this.opts.maxRetries ?? 5;

    let resp: AxiosResponse<T>;
    try {
      resp = await this.axios.request<T>(this.toAxios(req));
    } catch (err) {
      // Network-level error (DNS, connection refused, timeout). Retry up to maxRetries.
      const e = err as AxiosError;
      if (attempt >= maxRetries) {
        throw new HttpError(
          `network error: ${e.code ?? e.message ?? 'unknown'}`,
          0,
          this.safeUrl(req),
          undefined,
        );
      }
      const wait = backoffMs(attempt);
      this.opts.log.warn(`network error, retrying in ${wait}ms`, {
        attempt: attempt + 1,
        url: this.safeUrl(req),
        code: e.code,
      });
      await sleep(wait);
      return this.requestWithRetries<T>(req, attempt + 1, unauthorisedHandled);
    }

    // 401 → refresh once, retry once
    if (resp.status === 401 && !unauthorisedHandled && this.opts.onUnauthorised) {
      this.opts.log.info('got 401, attempting credential refresh');
      const newAuth = await this.opts.onUnauthorised();
      if (newAuth) {
        this.currentAuthHeader = newAuth;
        return this.requestWithRetries<T>(req, attempt, /* unauthorisedHandled */ true);
      }
      // refresh declined → fall through to error path below
    }

    // 429 → respect Retry-After
    if (resp.status === 429 && attempt < maxRetries) {
      const retryAfter = parseRetryAfter(resp.headers['retry-after']);
      const wait = retryAfter ?? backoffMs(attempt);
      this.opts.log.warn(`rate-limited, sleeping ${wait}ms`, {
        attempt: attempt + 1,
        url: this.safeUrl(req),
      });
      await sleep(wait);
      return this.requestWithRetries<T>(req, attempt + 1, unauthorisedHandled);
    }

    // 5xx → retry with backoff
    if (resp.status >= 500 && attempt < maxRetries) {
      const wait = backoffMs(attempt);
      this.opts.log.warn(`server error, retrying in ${wait}ms`, {
        attempt: attempt + 1,
        url: this.safeUrl(req),
        status: resp.status,
      });
      await sleep(wait);
      return this.requestWithRetries<T>(req, attempt + 1, unauthorisedHandled);
    }

    // 2xx → success
    if (resp.status >= 200 && resp.status < 300) {
      return {
        status: resp.status,
        headers: stringifyHeaders(resp.headers),
        body: resp.data,
      };
    }

    // Anything else → throw a structured error with a redacted excerpt.
    // Include the body excerpt directly in the message so it shows up in
    // worker IPC events (which only carry .message, not the full HttpError).
    const excerpt = excerptOfBody(resp.data);
    throw new HttpError(
      `HTTP ${resp.status} from ${this.safeUrl(req)}${excerpt ? ` — ${excerpt}` : ''}`,
      resp.status,
      this.safeUrl(req),
      excerpt,
    );
  }

  private toAxios(req: HttpRequest): AxiosRequestConfig {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (this.currentAuthHeader && !headers.Authorization) {
      headers.Authorization = this.currentAuthHeader;
    }
    if (!headers.Accept) {
      headers.Accept = 'application/json';
    }
    return {
      method: req.method ?? 'GET',
      url: req.url,
      headers,
      params: cleanQuery(req.query),
      data: req.body,
      timeout: req.timeoutMs ?? this.opts.timeoutMs ?? 60_000,
    };
  }

  /** URL with sensitive query params (`access_token`, `key`, `token`) redacted. */
  private safeUrl(req: HttpRequest): string {
    let url = req.url;
    if (this.opts.baseUrl && !/^https?:\/\//i.test(url)) {
      url = this.opts.baseUrl.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
    }
    try {
      const u = new URL(url);
      const SENSITIVE = ['access_token', 'token', 'key', 'apikey', 'secret', 'refresh_token'];
      for (const param of SENSITIVE) {
        if (u.searchParams.has(param)) u.searchParams.set(param, '<redacted>');
      }
      return u.toString();
    } catch {
      return url;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function backoffMs(attempt: number): number {
  // Exponential with jitter: 500, 1000, 2000, 4000, 8000, 16000, 30000, …
  // (capped at 30s). Connectors like EO need long backoffs on 429 to
  // ride out the API's per-minute throttle windows.
  //
  // Cap is overridable via env to keep tests fast — production code never
  // sets this; only the connector test suite + local debugging do.
  const capEnv = Number(process.env.HTTP_CLIENT_BACKOFF_CAP_MS);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : 30_000;
  const base = Math.min(cap, 500 * 2 ** attempt);
  return Math.floor(base * (0.75 + Math.random() * 0.5));
}

function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  // RFC 7231 also allows HTTP-date — ignore for now, fall back to backoff.
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanQuery(
  q: Record<string, string | number | boolean | undefined> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!q) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function stringifyHeaders(h: unknown): Record<string, string> {
  if (!h || typeof h !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function excerptOfBody(body: unknown, max = 500): string | undefined {
  if (body == null) return undefined;
  let s: string;
  try {
    s = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    s = String(body);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

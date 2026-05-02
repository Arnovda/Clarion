/**
 * ExactOnline OAuth helpers.
 *
 * EO uses OAuth 2.0 with one specific quirk: refresh tokens **rotate** on
 * every refresh — using a refresh_token returns a new refresh_token, and
 * the previous one is invalidated. If a sync interrupts after token use
 * but before the new token is persisted, the connection is bricked
 * (the old refresh_token is dead, the new one is lost).
 *
 * The connector mitigates by:
 *   1. Refreshing the token EXACTLY ONCE per sync (at the start), holding
 *      the access_token for the duration.
 *   2. Calling `ctx.onCredentialRotated(newConfig)` immediately after a
 *      successful refresh, BEFORE doing any data fetching. The orchestrator
 *      re-encrypts and persists. If the sync crashes after this point, the
 *      next run still works.
 *
 * Anything more sophisticated (token storage with audit logging, multi-region
 * failover) is out of scope for the spike. Single-shot refresh is correct
 * for the common case.
 */

import axios, { AxiosError } from 'axios';
import type { Logger } from '../types';

export interface RefreshResult {
  accessToken: string;
  /** New refresh token. Always present on a successful refresh — EO rotates every time. */
  newRefreshToken: string;
  /** Lifetime of the access token in seconds (typically 600 = 10 minutes). */
  expiresIn: number;
}

export interface RefreshArgs {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  log: Logger;
  /** Override for tests. Default: 30s. */
  timeoutMs?: number;
}

/**
 * Exchange a refresh_token for a new access_token.
 *
 * Uses axios directly rather than HttpClient because:
 *   • This is the bootstrap path — no auth header is set yet.
 *   • The endpoint takes form-encoded body, not JSON.
 *   • We never want retries on bad credentials (a 400 means "your refresh
 *     token is dead"; retrying repeatedly would just hammer the endpoint).
 *
 * Throws `AuthRefreshError` on any failure — the caller surfaces it as a
 * user-facing "credentials invalid, re-paste your refresh token" message.
 */
export async function refreshAccessToken(args: RefreshArgs): Promise<RefreshResult> {
  const { baseUrl, clientId, clientSecret, refreshToken, log, timeoutMs = 30_000 } = args;
  const url = `${baseUrl.replace(/\/$/, '')}/api/oauth2/token`;

  log.info('refreshing ExactOnline access token', { baseUrl });

  let resp;
  try {
    resp = await axios.post(
      url,
      // axios serialises this as application/x-www-form-urlencoded when given a URLSearchParams instance.
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
        // Let us inspect non-2xx responses ourselves.
        validateStatus: () => true,
      },
    );
  } catch (err) {
    const e = err as AxiosError;
    throw new AuthRefreshError(`Network error during token refresh: ${e.code ?? e.message}`);
  }

  if (resp.status !== 200) {
    const excerpt = excerptOf(resp.data);
    throw new AuthRefreshError(
      `Token refresh failed (HTTP ${resp.status})${excerpt ? `: ${excerpt}` : ''}`,
    );
  }

  const body = resp.data as Partial<TokenEndpointResponse>;
  if (!body.access_token || !body.refresh_token) {
    throw new AuthRefreshError(
      'Token refresh succeeded but response was missing access_token or refresh_token',
    );
  }

  log.info('access token obtained', { expiresIn: body.expires_in });
  return {
    accessToken: body.access_token,
    newRefreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 600,
  };
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
}

export class AuthRefreshError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthRefreshError';
  }
}

function excerptOf(body: unknown, max = 200): string | undefined {
  if (body == null) return undefined;
  let s: string;
  try {
    s = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    s = String(body);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

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
import type { ConnectorConfig, Logger, OAuthSpec } from '../types';

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

// ─── Authorization Code flow (the "Connect with X" UX) ───────────────────
/**
 * The connector's `OAuthSpec`. The platform owns state generation, popup
 * management, and the pending-row lifecycle; this just provides the URL
 * builder + code exchanger.
 *
 * Reference: https://developers.exactonline.com/#OAuth%20overview.html
 *
 * EO quirks worth noting:
 *   • `force_login=0` skips the username/password screen if the user has
 *     a valid session — better UX, identical security.
 *   • The redirect_uri sent to /auth MUST exactly match the one sent to
 *     /token. The platform passes the same string to both sides.
 *   • Scopes are NOT specified in OAuth params — they're configured in
 *     the user's EO app registration.
 *   • EO returns refresh_token + access_token together on Authorization
 *     Code exchange; both have the same TTL semantics as `refreshAccessToken`
 *     above (refresh tokens rotate on every use).
 */
interface ExactOnlineTokenExchange {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
}

export const exactOnlineOAuth: OAuthSpec = {
  preAuthFields: ['clientId', 'clientSecret', 'division', 'baseUrl'],

  buildAuthUrl(config, state, redirectUri) {
    const cfg = config as { clientId: string; baseUrl: string };
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      state,
      // Skip the username/password screen if the user has a live EO session.
      force_login: '0',
    });
    return `${cfg.baseUrl.replace(/\/$/, '')}/api/oauth2/auth?${params.toString()}`;
  },

  async exchangeCode(config, code, redirectUri): Promise<ConnectorConfig> {
    const cfg = config as {
      clientId: string;
      clientSecret: string;
      baseUrl: string;
    };
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/oauth2/token`;

    let resp;
    try {
      resp = await axios.post(
        url,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          // MUST match the redirect_uri sent to /auth — EO verifies.
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }),
        {
          headers: { Accept: 'application/json' },
          timeout: 30_000,
          validateStatus: () => true,
        },
      );
    } catch (err) {
      const e = err as AxiosError;
      throw new Error(`Network error during OAuth code exchange: ${e.code ?? e.message}`);
    }

    if (resp.status !== 200) {
      const excerpt = excerptOf(resp.data);
      throw new Error(
        `OAuth code exchange failed (HTTP ${resp.status})${excerpt ? `: ${excerpt}` : ''}`,
      );
    }

    const body = resp.data as Partial<ExactOnlineTokenExchange>;
    if (!body.access_token || !body.refresh_token) {
      throw new Error(
        'OAuth code exchange succeeded but response was missing access_token or refresh_token',
      );
    }

    // Return the full config = pre-auth fields + the newly-acquired refresh_token.
    return {
      ...config,
      refreshToken: body.refresh_token,
    };
  },
};

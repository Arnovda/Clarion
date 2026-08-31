/**
 * Microsoft identity platform (v2.0) OAuth helpers for the SharePoint connector.
 *
 * Same shape as `exactonline/oauth.ts` — a refresher, an error type, and an
 * `OAuthSpec` the platform drives — so the two connectors read alike and a
 * change to the handshake has one obvious place to go in each.
 *
 * ONE DELIBERATE DIFFERENCE IN THE COMMENTS, because copying Exact Online's
 * reasoning here would be wrong. EO invalidates the previous refresh_token the
 * instant a new one is issued, so losing a rotation bricks the connection —
 * hence EO's refuse-to-continue-without-the-persist-hook guard. Microsoft
 * issues a new refresh_token too, but the previous one stays valid for its
 * remaining lifetime (90 days by default). So a missed rotation here degrades
 * rather than bricks. We still persist eagerly, and for the same reason: the
 * token we are about to use should be the token the next run finds. But this
 * connector does NOT hard-fail when the hook is absent, because that would
 * turn a recoverable situation into an outage.
 *
 * Scopes requested are read-only (`Files.Read.All`, `Sites.Read.All`). A
 * consent this connector holds cannot modify a customer's documents — that is
 * a property of the scope list, not of the code, which is why it is stated
 * here next to the list rather than promised elsewhere.
 */

import axios, { AxiosError } from 'axios';
import type { ConnectorConfig, Logger, OAuthSpec } from '../types';

/** Host every token call goes to. Mirrored in the connector's egress allow-list. */
export const LOGIN_HOST = 'https://login.microsoftonline.com';

/**
 * Delegated permissions the connector asks for. `offline_access` is what makes
 * Microsoft return a refresh_token at all — without it the connection would
 * work until the first access token expired and then silently stop.
 */
export const SHAREPOINT_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Files.Read.All',
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/User.Read',
].join(' ');

export interface RefreshResult {
  accessToken: string;
  /** Microsoft returns a fresh refresh_token on every exchange. */
  newRefreshToken: string;
  /** Access-token lifetime in seconds (typically 3600). */
  expiresIn: number;
}

export interface RefreshArgs {
  directory: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  log: Logger;
  /** Override for tests. Default: 30s. */
  timeoutMs?: number;
}

function tokenUrl(directory: string): string {
  return `${LOGIN_HOST}/${encodeURIComponent(directory)}/oauth2/v2.0/token`;
}

/**
 * Exchange a refresh_token for a new access_token.
 *
 * Uses axios directly rather than HttpClient for the same reasons the EO
 * connector does: this is the bootstrap path with no auth header yet, the
 * endpoint is form-encoded, and a 400 here means the credential is dead —
 * retrying would only hammer the endpoint.
 */
export async function refreshAccessToken(args: RefreshArgs): Promise<RefreshResult> {
  const { directory, clientId, clientSecret, refreshToken, log, timeoutMs = 30_000 } = args;

  log.info('refreshing Microsoft access token', { directory });

  let resp;
  try {
    resp = await axios.post(
      tokenUrl(directory),
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        scope: SHAREPOINT_SCOPES,
      }),
      {
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
        validateStatus: () => true,
      },
    );
  } catch (err) {
    const e = err as AxiosError;
    throw new AuthRefreshError(`Network error during token refresh: ${e.code ?? e.message}`);
  }

  if (resp.status !== 200) {
    throw new AuthRefreshError(
      `Token refresh failed (HTTP ${resp.status})${describeOAuthError(resp.data)}`,
    );
  }

  const body = resp.data as Partial<TokenEndpointResponse>;
  if (!body.access_token) {
    throw new AuthRefreshError('Token refresh succeeded but the response carried no access_token');
  }

  log.info('access token obtained', { expiresIn: body.expires_in });
  return {
    accessToken: body.access_token,
    // Microsoft normally returns a new refresh_token; when it does not, the
    // one we already hold is still valid and carrying it forward is correct.
    newRefreshToken: body.refresh_token ?? refreshToken,
    expiresIn: body.expires_in ?? 3600,
  };
}

/**
 * Return a usable access token, refreshing only when the cached one is close
 * to expiry. Persists a rotated refresh_token through `onCredentialRotated`
 * before the caller does any data work, so a crash mid-sync cannot strand it.
 *
 * The 60s skew guards against a token that is technically valid when checked
 * and expired by the time a long page fetch reaches Graph.
 */
export async function getOrRefreshAccessToken(
  config: {
    directory: string;
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
    accessToken?: string;
    accessTokenExpiresAt?: number;
  },
  log: Logger,
  onCredentialRotated?: (c: ConnectorConfig) => Promise<void>,
): Promise<string> {
  if (config.accessToken && config.accessTokenExpiresAt && config.accessTokenExpiresAt > Date.now() + 60_000) {
    return config.accessToken;
  }
  if (!config.refreshToken) {
    throw new AuthRefreshError(
      'This SharePoint connection has not completed sign-in yet. Reconnect it to grant access.',
    );
  }
  const r = await refreshAccessToken({
    directory: config.directory,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    log,
  });
  if (onCredentialRotated) {
    await onCredentialRotated({
      ...config,
      refreshToken: r.newRefreshToken,
      accessToken: r.accessToken,
      accessTokenExpiresAt: Date.now() + r.expiresIn * 1000,
    } as unknown as ConnectorConfig);
  } else {
    // Not fatal here (see the header note on Microsoft's token lifetimes), but
    // it means the next run re-refreshes needlessly — worth a line in the log
    // rather than silence.
    log.warn('no credential-rotation hook available — the refreshed token will not be persisted');
  }
  return r.accessToken;
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

export class AuthRefreshError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthRefreshError';
  }
}

/**
 * Turn Microsoft's OAuth error body into something a user can act on.
 *
 * Microsoft returns a machine-readable `error` plus an `error_description`
 * that begins with a correlation id and a wall of trace detail. Surfacing the
 * whole thing puts internal ids in front of a business user; surfacing none of
 * it makes a misconfigured app registration undiagnosable. So we keep the
 * error code and the FIRST sentence of the description, which is the part
 * that names the actual problem.
 */
function describeOAuthError(body: unknown): string {
  if (body == null || typeof body !== 'object') return '';
  const b = body as { error?: unknown; error_description?: unknown };
  const code = typeof b.error === 'string' ? b.error : undefined;
  let detail: string | undefined;
  if (typeof b.error_description === 'string') {
    // AADSTS codes lead the description and are the searchable part.
    const firstLine = b.error_description.split(/\r?\n/)[0]?.trim();
    if (firstLine) detail = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  }
  if (code && detail) return `: ${code} — ${detail}`;
  if (code) return `: ${code}`;
  if (detail) return `: ${detail}`;
  return '';
}

// ─── Authorization Code flow (the "Connect with Microsoft" UX) ───────────
/**
 * The connector's `OAuthSpec`. The platform owns state generation, popup
 * management and the pending-row lifecycle; this provides the URL builder and
 * the code exchanger.
 *
 * Reference: https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
 *
 * Microsoft quirks worth noting:
 *   • `response_mode=query` keeps the code in the query string, which is what
 *     the platform's callback route reads.
 *   • `prompt=select_account` shows the account picker rather than silently
 *     reusing whichever account the browser is signed into — important when
 *     someone administers several tenants, which is the norm for the
 *     accountancy firms this connector is aimed at.
 *   • The redirect_uri sent to /authorize MUST match the one sent to /token.
 *   • The redirect URI must also be registered on the app registration as a
 *     Web platform redirect, or consent fails with AADSTS50011.
 */
export const sharePointOAuth: OAuthSpec = {
  preAuthFields: ['clientId', 'clientSecret', 'directory', 'siteUrl', 'libraryName', 'folderPath', 'headerRow'],

  buildAuthUrl(config, state, redirectUri) {
    const cfg = config as { clientId: string; directory: string };
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: SHAREPOINT_SCOPES,
      state,
      prompt: 'select_account',
    });
    return `${LOGIN_HOST}/${encodeURIComponent(cfg.directory)}/oauth2/v2.0/authorize?${params.toString()}`;
  },

  async exchangeCode(config, code, redirectUri): Promise<ConnectorConfig> {
    const cfg = config as { clientId: string; clientSecret: string; directory: string };

    let resp;
    try {
      resp = await axios.post(
        tokenUrl(cfg.directory),
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          scope: SHAREPOINT_SCOPES,
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
      throw new Error(`OAuth code exchange failed (HTTP ${resp.status})${describeOAuthError(resp.data)}`);
    }

    const body = resp.data as Partial<TokenEndpointResponse>;
    if (!body.access_token || !body.refresh_token) {
      throw new Error(
        'Sign-in succeeded but Microsoft returned no refresh token. '
        + "Check that the app registration requests the 'offline_access' permission.",
      );
    }

    const ttlSeconds = body.expires_in ?? 3600;
    return {
      ...config,
      refreshToken: body.refresh_token,
      accessToken: body.access_token,
      accessTokenExpiresAt: Date.now() + ttlSeconds * 1000,
    };
  },
};

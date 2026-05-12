/**
 * Source-connector routes — drives the "Add source" wizard.
 *
 *   GET  /api/source-types                              → list registered connectors + their schemas
 *   POST /api/source-types/:type/oauth-init             → start an OAuth handshake; returns authUrl + stateToken
 *   GET  /api/source-types/:type/oauth-callback         → OAuth provider's redirect target; exchanges code for tokens
 *   POST /api/source-types/:type/test                   → testConnection (accepts inline config OR oauthStateToken)
 *   POST /api/source-types/:type/list-entities          → listEntities (accepts inline config OR oauthStateToken)
 *
 * Sync triggering and run history live in `routes/connections.ts`.
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  ConfigValidationError,
  createAdapterLogger,
  getConnector,
  listConnectorCatalog,
  type ConnectorConfig,
} from '@databridge/connectors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { reqDb } from '../db/reqDb';
import { encryptCredentials, decryptCredentials } from '../utils/crypto';
import { logger } from '../utils/logger';

const router = Router();

// ─── GET /api/source-types ────────────────────────────────────────────────
router.get('/', requireAuth, (_req: Request, res: Response) => {
  const catalog = listConnectorCatalog();
  res.json({
    ok: true,
    data: catalog.map((c) => ({
      type: c.type,
      displayName: c.displayName,
      iconSvg: c.iconSvg,
      configSchema: c.configSchema,
      egressAllowList: c.egressAllowList,
      // Surface OAuth capability + which fields are pre-auth so the wizard can
      // render the right form. Connectors without OAuth omit this.
      oauth: c.oauth ? { preAuthFields: [...c.oauth.preAuthFields] } : undefined,
    })),
  });
});

// ─── Shared validation ────────────────────────────────────────────────────
const probeSchema = z.object({
  body: z.object({
    config: z.record(z.string(), z.unknown()).optional(),
    oauthStateToken: z.string().optional(),
  }).refine((v) => !!v.config || !!v.oauthStateToken, {
    message: 'Body must include either `config` or `oauthStateToken`',
  }),
  params: z.object({
    type: z.string().min(1),
  }),
});

// ─── Helpers ──────────────────────────────────────────────────────────────
/**
 * Resolve the config for a probe call. Either inline (config) or via
 * stateToken (look up the latest pending OAuth row, decrypt its config).
 *
 * The stateToken path is gated by tenant + initiating user — a stateToken
 * from one tenant is meaningless to another, even if the random bits leaked.
 */
async function resolveProbeConfig(
  db: Knex | Knex.Transaction,
  body: { config?: Record<string, unknown>; oauthStateToken?: string },
  user: { tenantId: number; sub: number },
): Promise<Record<string, unknown>> {
  if (body.config) return body.config;
  if (!body.oauthStateToken) throw new Error('Missing config or oauthStateToken');
  const row = await db('oauth_pending')
    .where({
      state_token: body.oauthStateToken,
      tenant_id: user.tenantId,
      initiated_by_user_id: user.sub,
    })
    .first();
  if (!row) throw new Error('Unknown or expired stateToken');
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error('OAuth session expired — re-run the Connect step');
  }
  return JSON.parse(decryptCredentials(row.encrypted_config));
}

/**
 * Compute the redirect URI the OAuth provider should send the user back to.
 *
 * Order of preference:
 *   1. `OAUTH_REDIRECT_BASE_URL` env var — the canonical answer in prod (the
 *      backend's external URL might not be reflected in `req.host` if running
 *      behind a custom domain or proxy).
 *   2. `req.protocol`://`req.get('host')` — fallback for local dev.
 */
function computeRedirectUri(req: Request, connectorType: string): string {
  const base = process.env.OAUTH_REDIRECT_BASE_URL?.replace(/\/$/, '')
    ?? `${req.protocol}://${req.get('host')}`;
  return `${base}/api/source-types/${encodeURIComponent(connectorType)}/oauth-callback`;
}

// ─── POST /api/source-types/:type/oauth-init ──────────────────────────────
/**
 * Kicks off an OAuth Authorization Code flow.
 *   • Encrypts + stashes the user's pre-auth fields in `oauth_pending`.
 *   • Generates a CSRF-resistant state token (random 32 bytes, base64url).
 *   • Asks the connector to build the provider's authorisation URL.
 *   • Returns { authUrl, stateToken } — the wizard opens authUrl in a popup
 *     and waits for postMessage from the callback page.
 */
router.post(
  '/:type/oauth-init',
  requireAuth,
  requireRole('admin'),
  validate(z.object({
    body: z.object({ config: z.record(z.string(), z.unknown()) }),
    params: z.object({ type: z.string().min(1) }),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const { type } = req.params;
      const { config } = req.body as { config: Record<string, unknown> };

      let connector;
      try {
        connector = getConnector(type);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Unknown connector type')) {
          res.status(404).json({ ok: false, error: e.message });
          return;
        }
        throw e;
      }

      if (!connector.oauth) {
        res.status(400).json({
          ok: false,
          error: `Connector '${type}' does not support OAuth. Use paste-token instead.`,
        });
        return;
      }

      // CSRF guard: random 32 bytes, base64url. Long enough that brute-forcing
      // a valid token (and matching tenant + user + non-expired row) is infeasible.
      const stateToken = crypto.randomBytes(32).toString('base64url');
      const redirectUri = computeRedirectUri(req, type);

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
      const encryptedConfig = encryptCredentials(JSON.stringify(config));

      // Opportunistic GC: drop expired rows for this tenant.
      await db('oauth_pending')
        .where('tenant_id', req.user!.tenantId)
        .andWhere('expires_at', '<', new Date())
        .del();

      await db('oauth_pending').insert({
        tenant_id: req.user!.tenantId,
        initiated_by_user_id: req.user!.sub,
        connector_type: type,
        status: 'pending',
        state_token: stateToken,
        encrypted_config: encryptedConfig,
        redirect_uri: redirectUri,
        expires_at: expiresAt,
      });

      const authUrl = connector.oauth.buildAuthUrl(config as ConnectorConfig, stateToken, redirectUri);
      res.json({ ok: true, data: { authUrl, stateToken, redirectUri } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/source-types/:type/oauth-callback ───────────────────────────
/**
 * The OAuth provider's redirect target. Stateless — does NOT touch the DB.
 *
 * IMPORTANT: cross-origin window.opener access is unreliable in modern
 * browsers (severed by COOP isolation, especially when the popup has
 * passed through a third-party login page like EO's auth screen). So
 * instead of rendering a postMessage page from backend's domain, we
 * 302-redirect the popup to a SAME-ORIGIN page on the frontend
 * (`/sources/oauth-return`) which then does the postMessage. Code + state
 * travel in the URL fragment (#…) so they never hit server logs.
 *
 * The actual code-exchange + DB write happens in a separate auth'd
 * endpoint (`POST /:type/oauth-finish`) that the wizard calls after
 * receiving the postMessage. Splitting the work this way means we never
 * need an unauthenticated DB path — RLS stays unbroken.
 */
router.get('/:type/oauth-callback', (req: Request, res: Response) => {
  const { type } = req.params;
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const providerError = typeof req.query.error === 'string' ? req.query.error : null;

  const frontendBase = process.env.FRONTEND_BASE_URL?.replace(/\/$/, '');
  if (!frontendBase) {
    // Hard fail with a visible message rather than try to fall back —
    // misconfiguration here would silently break the OAuth UX in subtle ways.
    res.status(500).send('Server misconfigured: FRONTEND_BASE_URL not set');
    return;
  }

  // Build the fragment payload. Encode each value so the parser on the
  // frontend can decode safely.
  const params = providerError
    ? `ok=0&error=${encodeURIComponent(`Provider error: ${providerError}`)}`
    : !code || !state
      ? `ok=0&error=${encodeURIComponent('Missing code or state')}`
      : `ok=1&type=${encodeURIComponent(type)}&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

  // Use a 303 See Other so the GET-only nature is explicit. The fragment
  // is preserved by browsers when a Location header includes one.
  res.redirect(303, `${frontendBase}/sources/oauth-return#${params}`);
});

// ─── POST /api/source-types/:type/oauth-finish ────────────────────────────
/**
 * Auth'd finalisation step: takes the auth code the wizard captured from the
 * popup callback, looks up the matching `oauth_pending` row (gated by
 * tenant + initiator), exchanges the code for tokens via the connector's
 * `OAuthSpec.exchangeCode`, and updates the row's encrypted config to
 * include the freshly-acquired refresh_token.
 *
 * After this returns success, subsequent calls (test, list-entities, save)
 * pass the SAME stateToken — backend resolves it to the now-full config.
 */
router.post(
  '/:type/oauth-finish',
  requireAuth,
  requireRole('admin'),
  validate(z.object({
    body: z.object({
      stateToken: z.string().min(1),
      code: z.string().min(1),
    }),
    params: z.object({ type: z.string().min(1) }),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type } = req.params;
      const { stateToken, code } = req.body as { stateToken: string; code: string };

      let connector;
      try {
        connector = getConnector(type);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Unknown connector type')) {
          res.status(404).json({ ok: false, error: e.message });
          return;
        }
        throw e;
      }
      if (!connector.oauth) {
        res.status(400).json({ ok: false, error: `Connector '${type}' does not support OAuth` });
        return;
      }

      const db = reqDb(req);
      const row = await db('oauth_pending')
        .where({
          state_token: stateToken,
          connector_type: type,
          tenant_id: req.user!.tenantId,
          initiated_by_user_id: req.user!.sub,
        })
        .first();
      if (!row) {
        res.status(404).json({ ok: false, error: 'Unknown or already-consumed stateToken' });
        return;
      }
      if (row.status !== 'pending') {
        // Idempotent: if already authorised, just return success.
        res.json({ ok: true, data: { alreadyAuthorised: true } });
        return;
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        res.status(400).json({ ok: false, error: 'OAuth session expired — please retry' });
        return;
      }

      const partialConfig = JSON.parse(decryptCredentials(row.encrypted_config));
      let fullConfig: Record<string, unknown>;
      try {
        fullConfig = await connector.oauth.exchangeCode(partialConfig, code, row.redirect_uri);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'OAuth code exchange failed';
        res.status(400).json({ ok: false, error: msg });
        return;
      }

      const reencrypted = encryptCredentials(JSON.stringify(fullConfig));
      await db('oauth_pending')
        .where({ id: row.id })
        .update({ status: 'authorised', encrypted_config: reencrypted });

      res.json({ ok: true, data: { ok: true } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/source-types/:type/test ────────────────────────────────────
router.post(
  '/:type/test',
  requireAuth,
  requireRole('admin', 'analyst'),
  validate(probeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const { type } = req.params;
      const config = await resolveProbeConfig(
        db,
        req.body as { config?: Record<string, unknown>; oauthStateToken?: string },
        { tenantId: req.user!.tenantId, sub: req.user!.sub },
      );

      const connector = getConnector(type);
      const result = await connector.testConnection(config, {
        log: createAdapterLogger(logger.child({
          mod: 'connector-probe',
          connector: type,
          tenantId: req.user?.tenantId,
        })),
      });
      res.json({ ok: true, data: result });
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      if (err instanceof Error) {
        if (err.message.startsWith('Unknown connector type')) {
          res.status(404).json({ ok: false, error: err.message });
          return;
        }
        if (err.message.includes('stateToken') || err.message.includes('OAuth session')) {
          res.status(400).json({ ok: false, error: err.message });
          return;
        }
      }
      next(err);
    }
  },
);

// ─── POST /api/source-types/:type/list-entities ───────────────────────────
router.post(
  '/:type/list-entities',
  requireAuth,
  requireRole('admin', 'analyst'),
  validate(probeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const { type } = req.params;
      const config = await resolveProbeConfig(
        db,
        req.body as { config?: Record<string, unknown>; oauthStateToken?: string },
        { tenantId: req.user!.tenantId, sub: req.user!.sub },
      );

      const connector = getConnector(type);
      const entities = await connector.listEntities(config, {
        log: createAdapterLogger(logger.child({
          mod: 'connector-list-entities',
          connector: type,
          tenantId: req.user?.tenantId,
        })),
      });
      res.json({ ok: true, data: entities });
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      if (err instanceof Error) {
        if (err.message.startsWith('Unknown connector type')) {
          res.status(404).json({ ok: false, error: err.message });
          return;
        }
        if (err.message.includes('stateToken') || err.message.includes('OAuth session')) {
          res.status(400).json({ ok: false, error: err.message });
          return;
        }
      }
      next(err);
    }
  },
);

export default router;

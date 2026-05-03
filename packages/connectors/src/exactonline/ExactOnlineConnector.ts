/**
 * ExactOnline source connector.
 *
 * Implements `SourceConnector` for ExactOnline's OData v3 REST API:
 *   • testConnection — refresh token + GET `/system/Me` to verify creds
 *   • listEntities  — return curated catalog (see `entities.ts`)
 *   • sync          — refresh token (rotate via `onCredentialRotated`),
 *                     paginate each selected entity, clean OData noise,
 *                     stream rows through `ctx.warehouseWriter`.
 *
 * Each public method instantiates its own `HttpClient`. There is no shared
 * mutable state between calls — connector instances are per-invocation, not
 * singletons. This keeps tenant boundaries tight (no risk of leaking a
 * previous tenant's auth header into a new request).
 *
 * Inspired by the patterns in TicketSwap's tap-exact-online (MIT) and the
 * spike script in databridge-exact-spike/sync_exact.py. Both informed the
 * pagination / OData cleanup choices here.
 */

import { BaseSourceConnector } from '../BaseSourceConnector';
import { HttpClient } from '../HttpClient';
import type {
  ConnectorConfig,
  EntityDescriptor,
  ProbeContext,
  SourceConnector,
  SyncContext,
  SyncOptions,
  SyncResult,
  TestResult,
} from '../types';
import { asEntityDescriptors, ENTITIES_BY_NAME, type ExactOnlineEntity } from './entities';
import { asExactOnlineConfig, exactOnlineConfigSchema, type ExactOnlineConfig } from './schema';
import { AuthRefreshError, exactOnlineOAuth, refreshAccessToken } from './oauth';

export class ExactOnlineConnector extends BaseSourceConnector implements SourceConnector {
  readonly type = 'exactonline';
  readonly displayName = 'Exact Online';
  readonly configSchema = exactOnlineConfigSchema;
  readonly oauth = exactOnlineOAuth;
  readonly egressAllowList: readonly string[] = [
    '*.exactonline.nl',
    '*.exactonline.be',
    '*.exactonline.com',
    '*.exactonline.de',
    '*.exactonline.fr',
    '*.exactonline.es',
    '*.exactonline.co.uk',
    '*.exactonline.us',
  ];

  // ─── testConnection ────────────────────────────────────────────────────
  async testConnection(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<TestResult> {
    this.validateConfig(rawConfig);
    const config = asExactOnlineConfig(rawConfig);

    let accessToken: string;
    try {
      const refreshed = await refreshAccessToken({
        baseUrl: config.baseUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: config.refreshToken,
        log: ctx.log,
      });
      accessToken = refreshed.accessToken;
    } catch (e) {
      if (e instanceof AuthRefreshError) {
        return { ok: false, error: e.message };
      }
      throw e;
    }

    // Minimal validation call — `/system/Me` is the standard EO auth-probe
    // endpoint (returns the current user / division metadata). Lightweight.
    const http = new HttpClient({
      baseUrl: config.baseUrl,
      authHeader: `Bearer ${accessToken}`,
      log: ctx.log,
      maxRetries: 1, // no retry for a probe — fail fast
    });

    try {
      const resp = await http.request<MeResponse>({
        url: `/api/v1/${encodeURIComponent(config.division)}/system/Me`,
      });
      const me = extractFirst(resp.body);
      return {
        ok: true,
        details: {
          ...(me?.UserName ? { user: me.UserName } : {}),
          ...(me?.CurrentDivision ? { division: String(me.CurrentDivision) } : {}),
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return { ok: false, error: `Authenticated, but verification call failed: ${msg}` };
    }
  }

  // ─── listEntities ──────────────────────────────────────────────────────
  async listEntities(rawConfig: ConnectorConfig, _ctx: ProbeContext): Promise<EntityDescriptor[]> {
    // Entity catalog is curated today (see `entities.ts`). When we add
    // dynamic discovery, this method fetches `/api/v1/{division}/$metadata`
    // and merges parsed entities with the curated list. The shape of the
    // returned descriptors does not change.
    this.validateConfig(rawConfig);
    return asEntityDescriptors();
  }

  // ─── sync ──────────────────────────────────────────────────────────────
  async sync(
    rawConfig: ConnectorConfig,
    opts: SyncOptions,
    ctx: SyncContext,
  ): Promise<SyncResult> {
    this.validateConfig(rawConfig);
    const config = asExactOnlineConfig(rawConfig);

    if (opts.entities.length === 0) {
      return { rowCounts: {}, warnings: ['No entities selected — nothing to sync.'] };
    }

    // ── Resolve entities (reject unknowns up-front) ────────────────────
    const resolved: ExactOnlineEntity[] = [];
    const warnings: string[] = [];
    for (const name of opts.entities) {
      const entity = ENTITIES_BY_NAME.get(name);
      if (!entity) {
        warnings.push(`Unknown entity '${name}' — skipped.`);
        continue;
      }
      resolved.push(entity);
    }
    if (resolved.length === 0) {
      return { rowCounts: {}, warnings };
    }

    // ── Refresh token ONCE, persist rotation BEFORE doing any data work ─
    const refreshed = await refreshAccessToken({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
      log: ctx.log,
    });
    if (refreshed.newRefreshToken !== config.refreshToken) {
      // Rotated. Persist immediately — if the sync crashes after this point,
      // the next run uses the new token; the old one is dead either way.
      const newConfig: ExactOnlineConfig = {
        ...config,
        refreshToken: refreshed.newRefreshToken,
      };
      if (ctx.onCredentialRotated) {
        await ctx.onCredentialRotated(newConfig as unknown as ConnectorConfig);
      } else {
        ctx.log.warn(
          'refresh token rotated but no onCredentialRotated handler — next sync may fail',
        );
      }
    }

    // ── HttpClient with the new access token ───────────────────────────
    const http = new HttpClient({
      baseUrl: config.baseUrl,
      authHeader: `Bearer ${refreshed.accessToken}`,
      log: ctx.log,
      // Inside a sync, retries on 429 / 5xx are valuable — we want to ride
      // out transient failures rather than abort and re-do everything.
      maxRetries: 5,
      // If the access token expires mid-sync (unlikely for a 10-min lifetime
      // sync, but possible for very large entities), refresh it once.
      onUnauthorised: async () => {
        const r = await refreshAccessToken({
          baseUrl: config.baseUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          // Use the rotated one we just saved.
          refreshToken: refreshed.newRefreshToken,
          log: ctx.log,
        });
        if (r.newRefreshToken !== refreshed.newRefreshToken && ctx.onCredentialRotated) {
          await ctx.onCredentialRotated({
            ...config,
            refreshToken: r.newRefreshToken,
          } as unknown as ConnectorConfig);
        }
        return `Bearer ${r.accessToken}`;
      },
    });

    // ── Sync each selected entity ──────────────────────────────────────
    const rowCounts: Record<string, number> = {};

    for (const entity of resolved) {
      ctx.cancellationToken.throwIfCancelled();
      ctx.progress({
        message: `Syncing ${entity.displayName ?? entity.name}…`,
      });
      ctx.log.info(`syncing ${entity.name}`, { apiPath: entity.apiPath });

      const written = await this.syncOneEntity(http, config, entity, ctx);
      rowCounts[entity.name] = written;

      if (written === 0) {
        warnings.push(`Entity '${entity.name}' returned no rows.`);
      }
    }

    return { rowCounts, warnings };
  }

  /** Sync a single entity. Streams pages → cleans → writes Parquet. */
  private async syncOneEntity(
    http: HttpClient,
    config: ExactOnlineConfig,
    entity: ExactOnlineEntity,
    ctx: SyncContext,
  ): Promise<number> {
    const initialUrl = this.buildInitialUrl(config, entity);

    let pagesFetched = 0;
    let rowsFetched = 0;

    const rowIterable = BaseSourceConnector['paginate']<Record<string, unknown>>({
      initialCursor: initialUrl,
      cancellationToken: ctx.cancellationToken,
      onPage: (pageNum, _rowsInPage, total) => {
        pagesFetched = pageNum;
        rowsFetched = total;
        ctx.progress({
          message: `Syncing ${entity.name} (page ${pageNum}, ${total} rows)`,
          perEntity: { [entity.name]: { pagesFetched: pageNum, rowsFetched: total } },
        });
      },
      nextPage: async (cursor) => {
        const resp = await http.request<ODataResponse>({
          url: cursor,
        });
        const page = parseODataPage(resp.body);
        const cleaned = page.rows.map((r) => BaseSourceConnector['cleanRecord'](r));
        return { rows: cleaned, nextCursor: page.nextLink };
      },
    });

    const result = await ctx.warehouseWriter.writeTable(entity.name, rowIterable);
    ctx.log.info(`${entity.name} sync complete`, {
      pages: pagesFetched,
      rows: rowsFetched,
      bytes: result.bytesWritten,
    });
    return result.rowsWritten;
  }

  private buildInitialUrl(config: ExactOnlineConfig, entity: ExactOnlineEntity): string {
    const base = `${config.baseUrl.replace(/\/$/, '')}/api/v1/${encodeURIComponent(config.division)}${entity.apiPath}`;
    if (entity.defaultFilter) {
      // OData uses URI components — encode the filter expression.
      const encoded = encodeURIComponent(entity.defaultFilter);
      return `${base}?$filter=${encoded}`;
    }
    return base;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
interface ODataResponse {
  d: unknown;
}

interface ODataPagedShape {
  results: Record<string, unknown>[];
  __next?: string;
}

interface MeResponse {
  d?: { results?: { UserName?: string; CurrentDivision?: string | number }[] }
     | { UserName?: string; CurrentDivision?: string | number };
}

/**
 * ExactOnline returns two shapes:
 *   • {"d": [...]}                              — small / unpaginated
 *   • {"d": {"results": [...], "__next": ...}}  — paginated
 * Normalise into rows + optional nextLink.
 */
function parseODataPage(body: ODataResponse): { rows: Record<string, unknown>[]; nextLink: string | null } {
  const d = body.d;
  if (Array.isArray(d)) {
    return { rows: d as Record<string, unknown>[], nextLink: null };
  }
  if (d && typeof d === 'object') {
    const paged = d as ODataPagedShape;
    return {
      rows: paged.results ?? [],
      nextLink: typeof paged.__next === 'string' ? paged.__next : null,
    };
  }
  return { rows: [], nextLink: null };
}

/**
 * Pull the first record from a `/Me`-style response that may be wrapped
 * in either shape. Used by `testConnection` to surface user/division info.
 */
function extractFirst(body: MeResponse): { UserName?: string; CurrentDivision?: string | number } | undefined {
  const d = body.d;
  if (!d) return undefined;
  if ('results' in d && Array.isArray(d.results)) return d.results[0];
  if ('UserName' in d || 'CurrentDivision' in d) return d as { UserName?: string; CurrentDivision?: string | number };
  return undefined;
}

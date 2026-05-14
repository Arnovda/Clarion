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
 * spike script in clarion-exact-spike/sync_exact.py. Both informed the
 * pagination / OData cleanup choices here.
 */

import { BaseSourceConnector } from '../BaseSourceConnector';
import { HttpClient } from '../HttpClient';
import {
  CancellationError,
  type ConnectorConfig,
  type EntityAvailability,
  type EntityDescriptor,
  type ProbeContext,
  type SourceConnector,
  type SyncContext,
  type SyncOptions,
  type SyncResult,
  type TestResult,
} from '../types';
import { asEntityDescriptors, EXACT_ONLINE_ENTITIES, EXACT_ONLINE_KNOWN_RELATIONSHIPS, ENTITIES_BY_NAME, type ExactOnlineEntity } from './entities';
import type { KnownRelationship } from '../types';
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

    // Use the existing access_token if it's still fresh — EO refuses to
    // refresh while the issued access_token has time left ("access_token
    // not expired" 400). Critical right after OAuth, where the access_token
    // we just received is fully valid for ~10 minutes.
    let accessToken: string;
    try {
      accessToken = await getOrRefreshAccessToken(config, ctx.log, ctx.onCredentialRotated);
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

  // ─── probeEntities ─────────────────────────────────────────────────────
  /**
   * Probe each catalogued entity against the division using `$top=1`. Returns
   * one EntityAvailability per entity in the catalog — the wizard renders
   * forbidden entities as disabled, hidden 404s entirely, and shows row-
   * count hints for the available ones.
   *
   * EO rate-limits aggressively (per-app quota + per-endpoint throttling),
   * so probes run with bounded concurrency (3 in flight). When the API
   * returns 429 with a Retry-After header, the probe sleeps for the
   * suggested duration and retries once before giving up. Worst-case
   * wall-clock for a 50-entity catalog: ~25-40 seconds.
   *
   * Categorisation rules:
   *   200 → 'available'              (rowCountSample from $top=1)
   *   403 → 'forbidden'              (module not licensed)
   *   404 → 'not_found'              (path doesn't exist; hidden from UI)
   *   401 → 'error'                  (auth issue — likely a stale access token, surface as transient)
   *   429 → retry once, then 'error' (rate limited)
   *   5xx / network → 'error'        (transient)
   *
   * The probe is BEST EFFORT — connector code that hits a hard failure
   * (e.g. token refresh fails) throws as usual. Per-entity probe failures
   * never throw; they become 'error' entries the wizard can show.
   */
  async probeEntities(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<EntityAvailability[]> {
    this.validateConfig(rawConfig);
    const config = asExactOnlineConfig(rawConfig);

    // Get a fresh access token once for the whole probe sweep. Pass the
    // rotation hook so a refresh during probing doesn't strand the
    // newly-issued refresh_token — that's the scenario where the next
    // sync would otherwise fail with EO's "Old refresh token used" 401.
    const accessToken = await getOrRefreshAccessToken(config, ctx.log, ctx.onCredentialRotated);

    const baseUrl = config.baseUrl.replace(/\/$/, '');
    const division = encodeURIComponent(config.division);

    // Concurrency limit — 3 in flight. EO's per-app rate limit + per-endpoint
    // throttling means probing 50 entities all at once triggers cascading
    // 429s that lengthen the probe overall. Three is empirically the sweet
    // spot from the sync runs we saw in the field.
    const CONCURRENCY = 3;
    const queue = [...EXACT_ONLINE_ENTITIES];
    const results: EntityAvailability[] = [];

    const probeOne = async (entity: ExactOnlineEntity): Promise<EntityAvailability> => {
      const url = `${baseUrl}/api/v1/${division}${entity.apiPath}?$top=1`;
      return doProbe(url, accessToken, entity.name, ctx);
    };

    // Run the queue with bounded concurrency.
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const entity = queue.shift();
          if (!entity) return;
          const result = await probeOne(entity);
          results.push(result);
        }
      })());
    }
    await Promise.all(workers);

    // Preserve catalog order on the way out — the wizard groups by category
    // and assumes a stable order for rendering.
    const byName = new Map(results.map((r) => [r.name, r]));
    return EXACT_ONLINE_ENTITIES.map((e) => byName.get(e.name)!).filter(Boolean);
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

    // ── Get access token (use cached if fresh, else refresh) ────────────
    // EO rate-limits refresh while the access_token is still valid. Right
    // after OAuth, we have a fresh access_token and refreshing immediately
    // would be denied — so we use the cached one when present + valid.
    let accessToken: string;
    let currentRefreshToken = config.refreshToken;
    if (config.accessToken && config.accessTokenExpiresAt && config.accessTokenExpiresAt > Date.now() + 30_000) {
      ctx.log.info('using cached access token (still fresh)');
      accessToken = config.accessToken;
    } else {
      const refreshed = await refreshAccessToken({
        baseUrl: config.baseUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: config.refreshToken,
        log: ctx.log,
      });
      accessToken = refreshed.accessToken;
      currentRefreshToken = refreshed.newRefreshToken;
      // Persist rotated tokens BEFORE doing any data work — if the sync
      // crashes after this point, the next run uses the new tokens.
      const newConfig: ExactOnlineConfig = {
        ...config,
        refreshToken: refreshed.newRefreshToken,
        accessToken: refreshed.accessToken,
        accessTokenExpiresAt: Date.now() + (refreshed.expiresIn * 1000),
      };
      if (ctx.onCredentialRotated) {
        await ctx.onCredentialRotated(newConfig as unknown as ConnectorConfig);
      } else {
        ctx.log.warn('tokens rotated but no onCredentialRotated handler');
      }
    }

    // ── HttpClient with the access token ───────────────────────────────
    const http = new HttpClient({
      baseUrl: config.baseUrl,
      authHeader: `Bearer ${accessToken}`,
      log: ctx.log,
      // Inside a sync, retries on 429 / 5xx are valuable — we want to ride
      // out transient failures rather than abort and re-do everything.
      maxRetries: 5,
      // If the access token expires mid-sync (long-running entities,
      // 10-min token lifetime), refresh it once.
      onUnauthorised: async () => {
        const r = await refreshAccessToken({
          baseUrl: config.baseUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: currentRefreshToken,
          log: ctx.log,
        });
        currentRefreshToken = r.newRefreshToken;
        if (ctx.onCredentialRotated) {
          await ctx.onCredentialRotated({
            ...config,
            refreshToken: r.newRefreshToken,
            accessToken: r.accessToken,
            accessTokenExpiresAt: Date.now() + (r.expiresIn * 1000),
          } as unknown as ConnectorConfig);
        }
        return `Bearer ${r.accessToken}`;
      },
    });

    // ── Sync each selected entity ──────────────────────────────────────
    // Per-entity isolation: an error on one entity is recorded as a
    // warning and the loop continues with the rest. Only cancellation
    // aborts the whole sync. This is meaningfully better UX than
    // failing the entire sync when, say, one wide-table endpoint
    // rejects a filter — you still keep the work that succeeded.
    //
    // Incremental sync (May 2026): for entities declaring
    // `incrementalCursor`, we read the prior cursor from
    // `opts.cursors[entityName]`, append a `Modified gt datetime'X'`
    // filter to the OData URL, and track the highest Modified value
    // seen. The new cursor is returned in `result.cursors` only if
    // the entity's sync completed without error — per-entity
    // granularity prevents partial progress from advancing the cursor.
    const rowCounts: Record<string, number> = {};
    const cursors: Record<string, { type: 'timestamp'; value: string }> = {};

    for (const entity of resolved) {
      ctx.cancellationToken.throwIfCancelled();
      ctx.progress({
        message: `Syncing ${entity.displayName ?? entity.name}…`,
      });
      const priorCursor = opts.cursors?.[entity.name];
      ctx.log.info(`syncing ${entity.name}`, {
        apiPath: entity.apiPath,
        mode: entity.incrementalCursor ? (priorCursor ? 'incremental' : 'initial-full') : 'always-full',
        priorCursor: priorCursor?.value,
      });

      try {
        const { rowsWritten, maxCursorSeen } = await this.syncOneEntity(http, config, entity, ctx, priorCursor);
        rowCounts[entity.name] = rowsWritten;
        if (rowsWritten === 0) {
          warnings.push(`Entity '${entity.name}' returned no rows.`);
        }
        // Only emit a new cursor when the entity is incremental-capable AND
        // we saw at least one row. If no rows came back, keep the prior
        // cursor unchanged (or absent on first run) — re-running the same
        // filter next time is idempotent under the merge-by-key writer.
        if (entity.incrementalCursor && maxCursorSeen) {
          // Defensive: never move cursor BACKWARDS. EO shouldn't return
          // rows whose Modified < prior cursor (we asked for >), but guard
          // anyway against time-zone bugs or out-of-order pages.
          if (!priorCursor || maxCursorSeen > priorCursor.value) {
            cursors[entity.name] = { type: 'timestamp', value: maxCursorSeen };
          }
        }
      } catch (err) {
        if (err instanceof CancellationError) throw err; // never swallow cancellation
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`entity '${entity.name}' failed — continuing with remaining entities`, { error: msg });
        warnings.push(`Entity '${entity.name}' failed: ${msg}`);
        rowCounts[entity.name] = 0;
        // Don't write a cursor for failed entities — the next sync
        // re-pulls from the same point.
      }
    }

    return { rowCounts, warnings, cursors };
  }

  /** Sync a single entity. Streams pages → cleans → writes Parquet. */
  private async syncOneEntity(
    http: HttpClient,
    config: ExactOnlineConfig,
    entity: ExactOnlineEntity,
    ctx: SyncContext,
    priorCursor: { type: string; value: string } | undefined,
  ): Promise<{ rowsWritten: number; maxCursorSeen?: string }> {
    const initialUrl = this.buildInitialUrl(config, entity, priorCursor);

    let pagesFetched = 0;
    let rowsFetched = 0;
    // Track the highest cursor value seen across all pages of this
    // entity. For EO's `Modified` (ISO-8601 timestamp) ordering is
    // lexicographic — string compare is correct.
    let maxCursorSeen: string | undefined;
    const cursorField = entity.incrementalCursor?.field;

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
        // Advance maxCursorSeen as pages stream in. Doing it here (not
        // after the whole sync) makes the cursor robust to mid-sync
        // crashes — though the orchestrator only persists when the
        // entity completes, so the live tracking is for logging.
        if (cursorField) {
          for (const row of cleaned) {
            const v = row[cursorField];
            const s = typeof v === 'string' ? v : null;
            if (s && (!maxCursorSeen || s > maxCursorSeen)) {
              maxCursorSeen = s;
            }
          }
        }
        return { rows: cleaned, nextCursor: page.nextLink };
      },
    });

    // Pass the entity's businessKey to the writer when incremental.
    // Without a mergeKey the writer overwrites — which is wrong for
    // incremental (we'd lose all rows not in this delta). With it, the
    // writer reads existing rows, upserts the delta, writes back.
    const writeOpts = entity.incrementalCursor && entity.businessKey
      ? { mergeKey: entity.businessKey }
      : undefined;

    const result = await ctx.warehouseWriter.writeTable(entity.name, rowIterable, writeOpts);
    ctx.log.info(`${entity.name} sync complete`, {
      pages: pagesFetched,
      rows: rowsFetched,
      bytes: result.bytesWritten,
      mode: writeOpts?.mergeKey ? `merge:${writeOpts.mergeKey}` : 'overwrite',
      newCursor: maxCursorSeen,
    });
    return { rowsWritten: result.rowsWritten, maxCursorSeen };
  }

  /**
   * Returns FKs that are part of the documented ExactOnline data model.
   *
   * Filtered to the user's selected entities so we never insert a relationship
   * pointing to a table that wasn't synced. Same casing as the OData payload
   * (PascalCase, IDs like `InvoiceID`/`ID`) so the SchemaProfiler's column
   * lookup against the introspected Parquet headers actually matches.
   */
  getKnownRelationships(selectedEntities: readonly string[]): readonly KnownRelationship[] {
    const set = new Set(selectedEntities);
    return EXACT_ONLINE_KNOWN_RELATIONSHIPS.filter(
      (r) => set.has(r.fromTable) && set.has(r.toTable),
    );
  }

  private buildInitialUrl(
    config: ExactOnlineConfig,
    entity: ExactOnlineEntity,
    priorCursor: { type: string; value: string } | undefined,
  ): string {
    const base = `${config.baseUrl.replace(/\/$/, '')}/api/v1/${encodeURIComponent(config.division)}${entity.apiPath}`;

    // Build the $filter clause by AND-ing the (optional) defaultFilter
    // with the (optional) incremental cursor filter. Either may be
    // absent — when both are absent we issue no filter at all.
    const filterParts: string[] = [];
    if (entity.defaultFilter) filterParts.push(entity.defaultFilter);
    if (entity.incrementalCursor && priorCursor && priorCursor.type === 'timestamp') {
      // EO OData expects: `Modified gt datetime'YYYY-MM-DDTHH:MM:SS'`.
      // The cursor's value is the literal ISO string (no quotes), we
      // wrap it here when composing the filter.
      filterParts.push(`${entity.incrementalCursor.field} gt datetime'${priorCursor.value}'`);
    }

    const params: string[] = [];
    if (filterParts.length > 0) {
      params.push(`$filter=${encodeURIComponent(filterParts.join(' and '))}`);
    }
    // Order by the cursor field ascending so a mid-sync interruption
    // leaves the cursor at the highest fully-processed value. EO
    // accepts $orderby for entities with a Modified field — for
    // entities without an incremental cursor we don't order.
    if (entity.incrementalCursor) {
      params.push(`$orderby=${encodeURIComponent(`${entity.incrementalCursor.field} asc`)}`);
    }

    return params.length === 0 ? base : `${base}?${params.join('&')}`;
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

/**
 * Returns a usable access_token. Uses the cached one in `config` when it's
 * still fresh (>30s of life left); falls back to refreshing the refresh_token.
 *
 * Used by testConnection + probeEntities. Refreshing rotates the
 * refresh_token at EO's end — see oauth.ts. If we don't propagate the
 * NEW refresh_token back to durable storage, the next sync uses the
 * stale one and EO returns "Old refresh token used" (HTTP 401). To
 * close that loop, callers MUST pass an `onCredentialRotated` callback
 * (via ProbeContext) that re-encrypts and persists. Without it, this
 * function still works the first time (you get an access token) but
 * silently corrupts the stored credential for the next caller.
 *
 * The sync path has its own inline copy of this logic because it needs
 * to track `currentRefreshToken` across mid-sync 401 retries; this
 * helper is for one-shot callers.
 */
async function getOrRefreshAccessToken(
  config: ExactOnlineConfig,
  log: import('../types').Logger,
  onCredentialRotated?: (newConfig: ConnectorConfig) => Promise<void>,
): Promise<string> {
  if (config.accessToken && config.accessTokenExpiresAt && config.accessTokenExpiresAt > Date.now() + 30_000) {
    log.debug('using cached access token (still fresh)');
    return config.accessToken;
  }
  const refreshed = await refreshAccessToken({
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    log,
  });
  if (onCredentialRotated) {
    const rotated: ExactOnlineConfig = {
      ...config,
      refreshToken: refreshed.newRefreshToken,
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: Date.now() + (refreshed.expiresIn * 1000),
    };
    await onCredentialRotated(rotated as unknown as ConnectorConfig);
  } else {
    log.warn('refresh_token rotated but no onCredentialRotated handler — next caller will see "Old refresh token used"');
  }
  return refreshed.accessToken;
}

/**
 * Probe one EO endpoint with `$top=1` and categorise the response into one
 * of the four `EntityAvailability` states. Never throws — every failure
 * mode maps to a state. Uses native fetch (Node 18+) to avoid pulling
 * HttpClient's retry-on-5xx behaviour (we don't want retries during a
 * probe — slow probes hurt the wizard).
 *
 * 429 handling: honour `Retry-After` once, then retry once. If the second
 * attempt still 429s, surface as `error` (the connector can't recover
 * from sustained rate-limit pressure during a wizard step).
 */
async function doProbe(
  url: string,
  accessToken: string,
  entityName: string,
  ctx: ProbeContext,
  retryCount = 0,
): Promise<EntityAvailability> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      // Tight timeout — probes that take >10s aren't useful for the wizard.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    ctx.log.warn(`probe failed for ${entityName}`, { error: err instanceof Error ? err.message : String(err) });
    return { name: entityName, state: 'error', reason: 'Verification timed out — try again.' };
  }

  if (resp.status === 429 && retryCount === 0) {
    const retryAfter = parseInt(resp.headers.get('retry-after') ?? '2', 10);
    const sleepMs = Math.min(Math.max(retryAfter, 1), 10) * 1000;
    await new Promise((r) => setTimeout(r, sleepMs));
    return doProbe(url, accessToken, entityName, ctx, 1);
  }

  if (resp.status === 200) {
    let rowCountSample = 0;
    try {
      const json = await resp.json() as { d?: unknown };
      const d = json.d;
      if (Array.isArray(d)) rowCountSample = d.length;
      else if (d && typeof d === 'object' && 'results' in d && Array.isArray((d as { results: unknown[] }).results)) {
        rowCountSample = (d as { results: unknown[] }).results.length;
      }
    } catch {
      // Body unparseable — entity is reachable but the response shape is
      // unexpected. Treat as available with unknown row count.
    }
    return { name: entityName, state: 'available', rowCountSample, httpStatus: 200 };
  }

  if (resp.status === 403) {
    return {
      name: entityName,
      state: 'forbidden',
      reason: 'Module not licensed for this division.',
      httpStatus: 403,
    };
  }

  if (resp.status === 404) {
    return {
      name: entityName,
      state: 'not_found',
      httpStatus: 404,
    };
  }

  // Everything else (401, 429-after-retry, 5xx, …) → transient error.
  // Wizard can show a retry control for these.
  return {
    name: entityName,
    state: 'error',
    reason: resp.status === 401
      ? 'Authorization rejected — re-authenticate and try again.'
      : resp.status === 429
        ? 'Rate-limited by Exact Online — try again in a minute.'
        : `Verification failed (HTTP ${resp.status}).`,
    httpStatus: resp.status,
  };
}

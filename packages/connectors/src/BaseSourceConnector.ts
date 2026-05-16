/**
 * Abstract base class for source connectors.
 *
 * Concrete connectors (ExactOnlineConnector, NetSuiteConnector, ...) extend
 * this class to inherit:
 *   • Config validation against `configSchema` via Ajv
 *   • Helpers for OData-style record cleanup (`cleanRecord`, `cleanValue`)
 *   • A typed `paginate()` helper for cursor / link-based APIs
 *   • Cancellation-token plumbing (each loop iteration checks)
 *
 * Design choice: helpers live as `protected static` methods so subclasses
 * can use them without `this` magic, and tests can call them directly.
 * Anything stateful (HttpClient instance, current credentials) is owned by
 * the subclass — base class is intentionally stateless.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  CancellationError,
  type CancellationToken,
  type ConnectorConfig,
  type EntityDescriptor,
  type ProbeContext,
  type SourceConnector,
  type SyncContext,
  type SyncOptions,
  type SyncResult,
  type TestResult,
} from './types';

const ajv = new Ajv({ allErrors: true, useDefaults: true, removeAdditional: false });
addFormats(ajv);

export abstract class BaseSourceConnector implements SourceConnector {
  abstract readonly type: string;
  abstract readonly displayName: string;
  abstract readonly configSchema: SourceConnector['configSchema'];
  abstract readonly egressAllowList: readonly string[];

  readonly iconSvg?: string;

  // ─── Subclass implements the three lifecycle methods ───────────────────
  abstract testConnection(config: ConnectorConfig, ctx: ProbeContext): Promise<TestResult>;
  abstract listEntities(config: ConnectorConfig, ctx: ProbeContext): Promise<EntityDescriptor[]>;
  abstract sync(config: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult>;

  // ─── Config validation ─────────────────────────────────────────────────
  /**
   * Validates `config` against the connector's JSON Schema. Throws a clear
   * error listing the violations. Subclasses should call this first thing in
   * every public method — it's not invoked automatically because some methods
   * (e.g. listEntities) might want to accept a partial config in the future.
   */
  protected validateConfig(config: ConnectorConfig): void {
    const v = this.getValidator();
    if (!v(config)) {
      const errors = (v.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`)
        .join('; ');
      throw new ConfigValidationError(`Config validation failed: ${errors}`);
    }
  }

  private cachedValidator: ValidateFunction | undefined;
  private getValidator(): ValidateFunction {
    if (!this.cachedValidator) {
      this.cachedValidator = ajv.compile(this.configSchema as object);
    }
    return this.cachedValidator;
  }

  // ─── OData / REST record cleanup ───────────────────────────────────────
  /**
   * Strip OData navigation noise and normalise common field shapes.
   *
   *   • Drops `__metadata` keys (per-record OData envelope, not data).
   *   • Drops `__deferred` navigation links (would require separate fetches).
   *   • Converts `/Date(<unix-ms>)/` strings into ISO 8601 timestamps.
   *   • Trims whitespace on string values.
   *
   * Connectors targeting other API families (Salesforce, NetSuite REST)
   * can override or skip this — it's optional.
   */
  protected static cleanRecord(rec: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === '__metadata') continue;
      if (isDeferred(v)) continue;
      out[k] = BaseSourceConnector.cleanValue(v);
    }
    return out;
  }

  /** Per-cell cleanup. Idempotent. Used by `cleanRecord` and exposed for tests. */
  protected static cleanValue(v: unknown): unknown {
    if (typeof v === 'string') {
      const dateMatch = ODATA_DATE_RE.exec(v);
      if (dateMatch) {
        const ms = Number(dateMatch[1]);
        if (Number.isFinite(ms)) {
          return new Date(ms).toISOString();
        }
      }
      const trimmed = v.trim();
      return trimmed === v ? v : trimmed;
    }
    return v;
  }

  // ─── Pagination helper ─────────────────────────────────────────────────
  /**
   * Async-iterable adapter for cursor / link-based pagination. Yields one
   * page of rows at a time. Subclasses provide a `nextPage` callback that
   * returns `{ rows, nextCursor }` per iteration; base class handles the
   * loop, cancellation checks, and stop conditions.
   *
   * Why an iterable instead of returning the full list: the WarehouseWriter
   * accepts an `AsyncIterable`, so connectors can stream pages directly into
   * Parquet without buffering the whole entity in memory.
   */
  protected static async* paginate<T extends Record<string, unknown>>(args: {
    /** Initial cursor / URL passed to the first nextPage call. */
    initialCursor: string;
    /** Returns the next page given the previous cursor. Return null cursor to stop. */
    nextPage: (cursor: string) => Promise<{ rows: T[]; nextCursor: string | null }>;
    /** Optional cancellation token; throws if cancelled between pages. */
    cancellationToken?: CancellationToken;
    /** Optional per-page hook (for progress emission). */
    onPage?: (pageNumber: number, rowsInPage: number, totalSoFar: number) => void;
    /**
     * Safety cap on total pages. EO has been observed returning the same
     * `__next` link twice under eventual-consistency edge cases; without
     * a cap the loop would never terminate. 200k pages * 60 rows/page =
     * 12M rows, well above the largest real EO division. Override with
     * `maxPages` if a future connector legitimately needs more.
     */
    maxPages?: number;
  }): AsyncIterable<T> {
    let cursor: string | null = args.initialCursor;
    let pageNum = 0;
    let total = 0;
    const seenCursors = new Set<string>();
    const maxPages = args.maxPages ?? 200_000;

    while (cursor !== null) {
      args.cancellationToken?.throwIfCancelled();
      if (pageNum >= maxPages) {
        throw new Error(
          `Pagination safety cap reached: ${maxPages} pages fetched without seeing a null cursor. ` +
          `Either the API is stuck in a loop or maxPages needs raising. Aborting to prevent runaway sync.`,
        );
      }
      // Cycle detection — if the same cursor URL comes back twice, the
      // upstream API has bugged out (mid-sync rollback, transient cursor
      // invalidation). Breaking the loop is far better than the
      // alternative: silently re-ingesting the same rows forever.
      if (seenCursors.has(cursor)) {
        throw new Error(
          `Pagination cycle detected: the API returned a previously-seen cursor (page ${pageNum + 1}). ` +
          `Aborting to prevent infinite ingestion. This is upstream API instability, not a connector bug.`,
        );
      }
      seenCursors.add(cursor);

      pageNum += 1;
      const { rows, nextCursor } = await args.nextPage(cursor);
      total += rows.length;
      args.onPage?.(pageNum, rows.length, total);
      for (const row of rows) yield row;
      cursor = nextCursor;
    }
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────
export class ConfigValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConfigValidationError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const ODATA_DATE_RE = /^\/Date\((-?\d+)\)\/$/;

function isDeferred(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.prototype.hasOwnProperty.call(v, '__deferred')
  );
}

// ─── Cancellation token impl (used by the worker, exported for tests) ────
export function createCancellationToken(): CancellationToken & { cancel(): void } {
  let cancelled = false;
  return {
    get isCancelled() { return cancelled; },
    throwIfCancelled() {
      if (cancelled) throw new CancellationError();
    },
    cancel() { cancelled = true; },
  };
}

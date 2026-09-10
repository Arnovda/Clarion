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
  type WriteTableOptions,
} from './types';

/** See `BaseSourceConnector.writeEntityInChunks`. */
export interface ChunkedWriteArgs<T extends Record<string, unknown>> {
  entity: string;
  rows: AsyncIterable<T>;
  ctx: SyncContext;
  writeOpts?: WriteTableOptions;
  /**
   * Present ONLY when `rows` arrive in ascending order of this cursor and the
   * source pages by key rather than by offset (so a row updated mid-run
   * cannot shift an unseen row backwards across a page boundary). Enables
   * mid-entity checkpoints: after every flushed chunk the highest cursor
   * written so far is reported through `ctx.onEntityCheckpoint`.
   */
  checkpoint?: { type: 'timestamp' | 'integer' | 'string'; cursorOf: (row: T) => string | undefined };
  /** Rows per flush; default `SYNC_CHECKPOINT_ROWS` (50 000). Ignored without a merge key. */
  chunkRows?: number;
}

export interface ChunkedWriteResult {
  rowsWritten: number;
  bytesWritten: number;
  rowsTotal?: number;
  maxCursorSeen?: string;
  preservedExisting?: boolean;
  /** True when the time budget stopped the entity before its rows ran out. */
  stoppedForBudget: boolean;
}

const DEFAULT_CHUNK_ROWS = 50_000;

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

  // ─── Chunked, resumable entity writes (phase 2, B3) ─────────────────────
  /**
   * Stream an entity's rows to the warehouse in CHUNKS, so that:
   *
   *   • a checkpoint can be persisted after every chunk (`checkpoint` set):
   *     a worker killed at its ceiling resumes from the last cursor written
   *     instead of pulling the entity from the start again;
   *   • the run's time budget (`ctx.timeBudget`) can stop the entity CLEANLY
   *     between rows — whatever was fetched is flushed, reported as a
   *     checkpoint, and the entity comes back as `stoppedForBudget` so the
   *     connector reports it incomplete and the orchestrator continues it in
   *     a follow-up run.
   *
   * Chunking is only possible with a merge key (a second write without one
   * would overwrite the first); without it the whole entity is one write,
   * which the budget may still end early. The rows are never buffered in
   * JavaScript: each chunk is an async iterable the writer drains straight
   * into its staging file. The first chunk carries the caller's options
   * verbatim (so `replace` still means replace); later chunks always merge.
   * A one-row lookahead keeps an exhausted source from costing an extra,
   * empty merge.
   */
  protected static async writeEntityInChunks<T extends Record<string, unknown>>(
    args: ChunkedWriteArgs<T>,
  ): Promise<ChunkedWriteResult> {
    const { entity, ctx, checkpoint } = args;
    const writer = ctx.warehouseWriter;
    const canChunk = !!args.writeOpts?.mergeKey;
    const chunkRows = canChunk ? (args.chunkRows ?? envChunkRows()) : Number.POSITIVE_INFINITY;
    const budget = ctx.timeBudget;
    const it = args.rows[Symbol.asyncIterator]();

    let pending: IteratorResult<T> | null = null;
    let rowsWritten = 0;
    let bytesWritten = 0;
    let rowsTotal: number | undefined;
    let maxCursorSeen: string | undefined;
    let preservedExisting: boolean | undefined;
    let flushes = 0;
    let stopped = false;

    const track = (row: T): void => {
      if (!checkpoint) return;
      const v = checkpoint.cursorOf(row);
      if (v && (!maxCursorSeen || v > maxCursorSeen)) maxCursorSeen = v;
    };

    try {
      for (;;) {
        if (!pending) pending = await it.next();
        if (pending.done && flushes > 0) break;

        let count = 0;
        const chunk = async function* (): AsyncIterable<T> {
          while (count < chunkRows) {
            if (!pending) {
              if (count > 0 && budget?.shouldStop()) { stopped = true; return; }
              pending = await it.next();
            }
            if (pending.done) return;
            const row = pending.value;
            pending = null;
            count += 1;
            track(row);
            yield row;
          }
        };

        const opts = flushes === 0 ? args.writeOpts : { ...args.writeOpts, replace: false };
        const res = await writer.writeTable(entity, chunk(), opts);
        flushes += 1;
        rowsWritten += count;
        bytesWritten = res.bytesWritten;
        rowsTotal = res.rowsTotal;
        if (res.preservedExisting) preservedExisting = true;

        if (count > 0 && checkpoint && maxCursorSeen && ctx.onEntityCheckpoint) {
          await ctx.onEntityCheckpoint({ entity, cursor: { type: checkpoint.type, value: maxCursorSeen }, rowsSoFar: rowsWritten });
        }
        if (stopped || pending?.done) break;
      }
    } finally {
      if (stopped) await it.return?.().catch(() => undefined);
    }
    return { rowsWritten, bytesWritten, rowsTotal, maxCursorSeen, preservedExisting, stoppedForBudget: stopped };
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

function envChunkRows(): number {
  const n = Number(process.env.SYNC_CHECKPOINT_ROWS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_CHUNK_ROWS;
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

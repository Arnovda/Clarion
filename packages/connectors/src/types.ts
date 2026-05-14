/**
 * The source-connector contract.
 *
 * Every connector (ExactOnline, NetSuite, future Airbyte adapter, ...) implements
 * `SourceConnector`. The interface is the only surface area the rest of the
 * platform sees — the wizard, the orchestrator, the worker, the egress NSGs are
 * all driven from data exposed here.
 *
 * Three lifecycle methods, each with a different runtime context:
 *   • testConnection / listEntities — run IN-PROCESS in the main backend.
 *     Fast, synchronous-ish, used during the wizard. No isolation needed.
 *   • sync — runs in the ISOLATED sync-worker container. The container has
 *     only this one tenant's credentials, only egress to the connector's
 *     allow-list, and only write access to its own warehouse path.
 *
 * Connectors should never:
 *   • read Clarion's database (workers have no DB credentials)
 *   • read environment variables directly (use config + ctx)
 *   • log credentials (use `ctx.log` — it redacts)
 *   • write outside `ctx.warehouseWriter` (the SAS token wouldn't authorise it)
 */

import type { JSONSchema7 } from 'json-schema';

// ─── The interface every connector implements ────────────────────────────
export interface SourceConnector {
  /** Stable identifier. Stored in `connections.connector_type`. Lower-snake-case. */
  readonly type: string;

  /** Shown in the wizard's "pick a source" grid. */
  readonly displayName: string;

  /** Optional inline SVG markup for the wizard tile. Falls back to a generic icon. */
  readonly iconSvg?: string;

  /**
   * JSON Schema (draft-07) describing the credential / config object the user
   * fills in. Drives the wizard form and validates every config write.
   */
  readonly configSchema: JSONSchema7;

  /**
   * FQDNs (or wildcards) the connector needs egress to during sync.
   * Used to provision NSG / Container Apps egress rules. The orchestrator
   * refuses to launch a sync if the platform can't honour the allow-list.
   *
   * Example: ['*.exactonline.nl', '*.exactonline.be']
   */
  readonly egressAllowList: readonly string[];

  /**
   * Optional. Declares OAuth 2.0 Authorization Code support. When present,
   * the wizard renders a "Connect with <displayName>" button instead of
   * asking the user to paste tokens. The platform handles the popup +
   * callback dance; the connector provides the URL builder + code exchanger.
   *
   * Connectors that don't support OAuth (or only support paste-token for
   * now) leave this undefined.
   */
  readonly oauth?: OAuthSpec;

  /**
   * Validate credentials. Returns `{ ok: true }` on success or
   * `{ ok: false, error }` with a user-facing reason on failure.
   *
   * Must be idempotent — the wizard's "Test connection" button may invoke
   * it many times.
   */
  testConnection(config: ConnectorConfig, ctx: ProbeContext): Promise<TestResult>;

  /**
   * Discover or return the entities (tables / streams) available for this
   * source. Powers the multi-select in the wizard.
   *
   * Implementations:
   *   • Dynamic (preferred when supported) — call the source's metadata
   *     endpoint, parse, return.
   *   • Curated — return a hardcoded array compiled into the connector.
   */
  listEntities(config: ConnectorConfig, ctx: ProbeContext): Promise<EntityDescriptor[]>;

  /**
   * Run a sync of the selected entities. Runs in the isolated worker.
   *
   * The connector:
   *   • fetches data from the SaaS API
   *   • writes one Parquet file per entity via `ctx.warehouseWriter`
   *   • emits progress via `ctx.progress` (drives the UI heartbeat)
   *   • checks `ctx.cancellationToken` between API calls
   *
   * On unrecoverable error: throw. The worker exits non-zero, the
   * orchestrator marks the run failed, the user sees the error message.
   */
  sync(config: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult>;

  /**
   * Optional. Returns FKs that are well-known for this source system and don't
   * need to be inferred — they're just facts about the API surface (e.g.
   * `SalesInvoiceLines.InvoiceID` always references `SalesInvoices.InvoiceID`
   * in ExactOnline).
   *
   * Why this matters: API-style sources (ExactOnline, NetSuite, Stripe, ...)
   * land their data in Parquet files which carry no FK constraints. Generic
   * heuristics that look for `_id` snake_case suffixes don't match
   * PascalCase API columns. Without this method, the schema profiler would
   * have to ask Claude to re-discover relationships that are part of the
   * vendor's documented data model. Cheaper and more accurate to declare them.
   *
   * Implementations should:
   *   • only return relationships whose endpoints both appear in
   *     `selectedEntities` (returning ones for unsynced entities is harmless,
   *     they just won't match a table)
   *   • use the same column casing as the actual Parquet headers
   *   • mark each entry with `confidence` ≤ 1.0 — exact-as-vendor-docs is 1.0
   *
   * The platform calls this BEFORE running heuristic FK detection. Returned
   * relationships are merged in as `source: 'declared'` and skipped by
   * subsequent layers (no duplicate name-pattern guesses).
   */
  getKnownRelationships?(selectedEntities: readonly string[]): readonly KnownRelationship[];
}

// ─── Known relationships ──────────────────────────────────────────────────
/**
 * A relationship that's part of the source system's documented data model.
 * Connectors expose these via `getKnownRelationships()`; the schema profiler
 * treats them as ground truth and skips heuristic re-detection.
 */
export interface KnownRelationship {
  /** Source-side table name. Must match `EntityDescriptor.name`. */
  fromTable: string;
  /** Source-side column name (case-sensitive — must match the Parquet header). */
  fromColumn: string;
  /** Referenced table. Must match `EntityDescriptor.name`. */
  toTable: string;
  /** Referenced column (typically the PK). */
  toColumn: string;
  /** Cardinality. Defaults to 'many_to_one' if omitted. */
  type?: 'many_to_one' | 'one_to_many' | 'many_to_many' | 'one_to_one';
  /** Plain-English description shown to users. */
  description?: string;
}

// ─── OAuth specification ──────────────────────────────────────────────────
/**
 * OAuth 2.0 Authorization Code support for a connector. Three pieces:
 *
 *   1. `preAuthFields` — which fields of `configSchema` the user fills in
 *      BEFORE the OAuth handshake (typically clientId, clientSecret, region).
 *      The wizard renders these as form inputs; the rest of `configSchema`
 *      (refresh_token, etc.) is hidden from the form.
 *
 *   2. `buildAuthUrl(...)` — pure function that constructs the URL we
 *      redirect the user to. Connector-specific because OAuth providers
 *      differ wildly in scope/state/PKCE conventions.
 *
 *   3. `exchangeCode(...)` — exchanges the callback's `code` for tokens
 *      and returns the FULL config (originals + the freshly-acquired
 *      refresh_token / access_token). Pure async function; no side effects.
 *
 * The platform owns: state-token generation, popup management, the temp
 * `oauth_pending` row, postMessage to the wizard. Connectors only need
 * the three above.
 */
export interface OAuthSpec {
  /**
   * Names of fields in `configSchema.properties` that the user must fill in
   * BEFORE the auth redirect. Everything in `configSchema` not listed here
   * is hidden from the wizard form (the connector + platform fill it in
   * via the OAuth dance).
   */
  readonly preAuthFields: readonly string[];

  /**
   * Build the URL to redirect the user to. The connector knows its own
   * scopes, response_type, and any vendor-specific quirks (e.g. EO's
   * `force_login=0`).
   *
   * @param config       The user's pre-auth fields.
   * @param state        Opaque token the platform wants echoed back; we
   *                     use it as a CSRF guard + lookup key for the
   *                     pending OAuth row.
   * @param redirectUri  Absolute URL the OAuth provider should send the
   *                     user back to after auth. The connector includes
   *                     this in the auth URL; on `exchangeCode` it must
   *                     pass the SAME value (OAuth providers verify
   *                     redirect_uri matches between auth + token calls).
   */
  buildAuthUrl(config: ConnectorConfig, state: string, redirectUri: string): string;

  /**
   * Exchange the `code` from the callback for tokens. Returns the
   * connector's full config (preAuthFields + acquired tokens), ready
   * to be encrypted + persisted by the platform.
   *
   * Throw on failure — platform turns it into a user-facing error.
   */
  exchangeCode(
    config: ConnectorConfig,
    code: string,
    redirectUri: string,
  ): Promise<ConnectorConfig>;
}

// ─── Configuration ────────────────────────────────────────────────────────
/**
 * Connector-specific config. Always validated against `configSchema` before
 * being passed to a connector method. Encrypted at rest via Clarion's
 * AES-256-GCM crypto helpers.
 */
export type ConnectorConfig = Record<string, unknown>;

// ─── Discovery ────────────────────────────────────────────────────────────
/**
 * Cursor specification for an incrementally-syncable entity. The connector
 * declares this per-entity so the platform knows:
 *
 *   1. Whether the entity supports incremental sync at all
 *      (entities without a stable "modified" field run full each time)
 *   2. Which field carries the cursor value (e.g. 'Modified' on EO entities)
 *   3. How to interpret the cursor value when reading it back from
 *      `entity_sync_cursors.cursor_value` next run.
 *
 * The connector still owns FILTER CONSTRUCTION — the platform just stores
 * and retrieves the opaque cursor value. This keeps each connector's
 * source-specific quirks (OData syntax, REST query params, SQL clauses)
 * out of the platform.
 */
export interface EntityCursorSpec {
  /** Field on the entity that monotonically increases as rows change. */
  readonly field: string;

  /**
   * Type of the cursor value. Matches the CHECK constraint on
   * `entity_sync_cursors.cursor_type`. The connector decides which to use.
   *
   *   - `timestamp` : ISO 8601 string (`2026-05-14T10:00:00`)
   *   - `integer`   : numeric ID, stored as text (`123456`)
   *   - `string`    : opaque, e.g. an LSN or an OData skip token
   */
  readonly type: 'timestamp' | 'integer' | 'string';
}

/**
 * Single cursor instance — what the platform persists per entity in
 * `entity_sync_cursors` and hands back to the connector on the next sync.
 */
export interface EntityCursor {
  readonly type: 'timestamp' | 'integer' | 'string';
  readonly value: string;
}

export interface EntityDescriptor {
  /** Stable name used in `connections.selected_entities` and as the warehouse table name. */
  name: string;

  /** Optional human-friendly label shown in the wizard. Falls back to `name`. */
  displayName?: string;

  /** Optional grouping for UI organisation. e.g. 'CRM', 'Financial', 'Logistics'. */
  category?: string;

  /** Optional one-liner shown next to the entity in the picker. */
  description?: string;

  /** Optional row-count hint to help users pick (avoid pulling 10M-row entities by accident). */
  estimatedRowCount?: number;

  /**
   * Convenience boolean for the wizard's "incremental supported" UI hint.
   * MUST equal `!!incrementalCursor` — the platform asserts this in tests
   * to keep declarations consistent.
   */
  supportsIncremental: boolean;

  /**
   * If present, the entity is incrementally syncable: subsequent syncs
   * pull only rows where `field > <previousCursor>`. If absent, every
   * sync is a full pull and no cursor is persisted for this entity.
   *
   * The connector is responsible for translating the cursor into the
   * source-specific filter (e.g. EO's OData `$filter=Modified gt …`)
   * and for tracking the new cursor value as rows stream past.
   */
  readonly incrementalCursor?: EntityCursorSpec;

  /**
   * Stable primary-key column on the entity. Required when the entity is
   * incrementally syncable so the warehouse writer can merge new rows
   * into existing data by key (delta wins on conflict).
   *
   * For EO entities this is almost always `ID`. Some have specific
   * column names (e.g. `SalesInvoices.InvoiceID`, `Subscriptions.EntryID`).
   *
   * Connectors that emit FULL tables on every sync (incrementalCursor
   * undefined) don't need this — the writer overwrites.
   */
  readonly businessKey?: string;
}

// ─── Probe context (testConnection, listEntities) ─────────────────────────
/**
 * Context passed to in-process methods (testConnection, listEntities).
 * No warehouse writer (those methods don't write); no cancellation
 * (those methods are short-running).
 */
export interface ProbeContext {
  /** Pre-redacted logger. Anything credential-shaped is scrubbed. */
  readonly log: Logger;
}

// ─── Sync options + context ───────────────────────────────────────────────
export interface SyncOptions {
  /** Entity names to sync, from `EntityDescriptor.name`. */
  entities: string[];

  /**
   * Per-entity cursor state from the previous successful sync. Keyed by
   * `EntityDescriptor.name`. Loaded by the orchestrator from
   * `entity_sync_cursors` before the sync starts. Missing keys mean
   * "first sync for this entity" — the connector should fall back to a
   * full pull.
   *
   * Entities whose descriptor has no `incrementalCursor` MUST be absent
   * from this map even if a row exists in the table (the platform skips
   * the lookup for them).
   *
   * Legacy name `incrementalState` is kept until callers are migrated.
   */
  cursors?: Record<string, EntityCursor>;

  /**
   * @deprecated Use `cursors`. Kept for back-compat with any caller that
   * was already passing this in. The connector framework picks
   * `cursors` first when both are set.
   */
  incrementalState?: Record<string, unknown>;
}

export interface SyncContext {
  readonly tenantId: string;
  readonly connectionId: string;

  /** Sandboxed Parquet writer. Connector calls writer.writeTable(name, rows). */
  readonly warehouseWriter: WarehouseWriter;

  /** Pre-redacted logger. */
  readonly log: Logger;

  /** Emit progress to the orchestrator's heartbeat channel. UI polls it. */
  readonly progress: (msg: ProgressMsg) => void;

  /** Connector code should check this between API calls and abort cleanly if cancelled. */
  readonly cancellationToken: CancellationToken;

  /**
   * Hook the connector calls when it rotates a credential (e.g. ExactOnline
   * rotates refresh_tokens on every refresh). The orchestrator re-encrypts
   * and persists. Optional — connectors that don't rotate creds can ignore it.
   */
  readonly onCredentialRotated?: (newConfig: ConnectorConfig) => Promise<void>;
}

// ─── Results ──────────────────────────────────────────────────────────────
export interface TestResult {
  ok: boolean;
  /** User-facing error reason on failure. Already redacted. */
  error?: string;
  /** Connector-specific extras to display on success (e.g. division name). */
  details?: Record<string, string>;
}

export interface SyncResult {
  /** Per-entity row counts. Persisted to `source_sync_runs.row_counts`. */
  rowCounts: Record<string, number>;

  /** Non-fatal warnings to surface in the UI. e.g. "Entity X returned no data". */
  warnings: string[];

  /**
   * Per-entity NEW cursor state, captured from the just-completed sync.
   * Keyed by `EntityDescriptor.name`. Only entities that actually
   * succeeded AND were incrementally synced should appear here.
   *
   * The orchestrator persists these to `entity_sync_cursors` ONLY for
   * entities that did not raise an error during the sync — per-entity
   * granularity is the whole point. An entity that failed leaves its
   * cursor row untouched so the next run resumes from the same point.
   *
   * Cursors MUST NOT GO BACKWARDS. The orchestrator validates this
   * defensively before updating the row.
   */
  cursors?: Record<string, EntityCursor>;

  /**
   * @deprecated Use `cursors`. Pre-incremental field name kept for
   * back-compat.
   */
  nextIncrementalState?: Record<string, unknown>;
}

// ─── Warehouse writer (the only side-effect connectors are allowed) ───────
export interface WriteTableOptions {
  /**
   * Business-key column on the rows. When provided, the writer MERGES the
   * incoming rows into any existing Parquet for `tableName`:
   *
   *   - If a row's key matches an existing row → the new row replaces it
   *   - If a row's key is new → it's appended
   *   - Existing rows whose key does NOT appear in the new batch → kept
   *
   * This is the upsert semantic the incremental-sync framework relies on:
   * connectors stream the delta, the writer merges with history. The same
   * pattern the SCD1 product-tables sidecar uses, applied at the source
   * ingestion layer.
   *
   * When absent, the writer OVERWRITES the entire table — the legacy
   * full-sync behaviour. Connectors that don't support incremental for
   * a given entity should omit this option so the writer falls back to
   * overwrite.
   */
  mergeKey?: string;
}

export interface WarehouseWriter {
  /**
   * Write Parquet for `tableName`.
   *
   * Default (no `opts.mergeKey`): overwrites the existing file. This is
   * the legacy full-sync path.
   *
   * Merge mode (`opts.mergeKey` set): reads existing rows, upserts the
   * incoming rows by key, writes the merged result back. Existing rows
   * whose key is absent from the new batch are KEPT (no delete detection).
   *
   * The writer is sandboxed — in production it holds a SAS token scoped to
   * `warehouse/conn_<id>/`. A connector that tries to write outside that
   * path gets a 403 from Azure Blob, regardless of the path it passes.
   *
   * `rows` is an async iterable so connectors can stream pages from the
   * source without buffering the entire dataset. The writer batches
   * internally for efficient Parquet output; in merge mode it collects
   * the delta in memory, reads existing once, then writes the merged
   * file. Connectors writing tens of millions of rows in a single
   * incremental sync should chunk by date range to keep memory bounded.
   */
  writeTable(
    tableName: string,
    rows: AsyncIterable<Record<string, unknown>>,
    opts?: WriteTableOptions,
  ): Promise<TableWriteResult>;
}

export interface TableWriteResult {
  rowsWritten: number;
  bytesWritten: number;
  warehousePath: string; // relative to warehouse root, e.g. 'conn_42/Accounts/data.parquet'
}

// ─── Logging ──────────────────────────────────────────────────────────────
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ─── Progress + heartbeat ─────────────────────────────────────────────────
export interface ProgressMsg {
  /** Human-readable status line shown in the UI ("Fetching Accounts (page 3)…"). */
  message: string;

  /** Optional structured per-entity counters. */
  perEntity?: Record<string, { rowsFetched?: number; pagesFetched?: number }>;

  /** Overall percentage, 0-100. Optional — connectors that can't estimate it skip. */
  percent?: number;
}

// ─── Cancellation ─────────────────────────────────────────────────────────
export interface CancellationToken {
  readonly isCancelled: boolean;
  /**
   * Throws `CancellationError` if cancelled. Connector code calls this in
   * tight loops (e.g. between pagination pages) to abort cleanly.
   */
  throwIfCancelled(): void;
}

export class CancellationError extends Error {
  constructor() {
    super('Sync cancelled');
    this.name = 'CancellationError';
  }
}

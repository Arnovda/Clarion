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
import type { StarSchemaTemplate } from './starSchema';
import type { EntityBusinessKey } from './businessKeys';

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
   * Optional. Probe each catalogued entity against the source to determine
   * which ones the connected user/division can actually access. Drives the
   * "probe-before-pick" wizard step: instead of letting users select an
   * entity that will silently fail during sync, the wizard hides forbidden
   * ones and labels the available ones with row hints.
   *
   * Implementations should:
   *   • Issue a CHEAP probe per entity (e.g. `$top=1`)
   *   • Respect rate limits — concurrency-bounded fetching is OK
   *   • Return a result for every catalogued entity (one of available /
   *     forbidden / not_found / error) so the wizard has a complete picture
   *   • Honour the cancellation token so a slow probe doesn't hold up a
   *     user that hit Back
   *
   * Connectors that don't implement this method fall back to the current
   * behaviour — the wizard renders every catalogued entity clickable and
   * the user discovers permission issues at sync time. Adoption is per-
   * connector and incremental.
   */
  probeEntities?(config: ConnectorConfig, ctx: ProbeContext): Promise<EntityAvailability[]>;

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

  /**
   * The identifying column per entity — declared, not inferred.
   *
   * Same rung and same shape as `getKnownRelationships`: a fact about the API
   * surface, returned SYNCHRONOUSLY with no network call, because it is a
   * compile-time constant and a live-metadata failure must never cost us it.
   *
   * Why the platform cannot work this out on its own: a business key is the
   * column that IDENTIFIES a row, and uniqueness alone does not find it. On an
   * append-only table `Created` is unique too — picking it yields completeness
   * and uniqueness scores that read 100% while measuring nothing, which is
   * worse than no score at all because it looks like a good one.
   *
   * Implementations should return `businessKeysFromCatalog(catalog, selected)`
   * — the declarations already on `EntityDescriptor.businessKey`, which the
   * warehouse writer uses to merge rows on re-sync. Entities with no declared
   * key are OMITTED rather than returned empty: "the source does not say" and
   * "the source says none" must stay distinguishable.
   */
  getBusinessKeys?(selectedEntities: readonly string[]): readonly EntityBusinessKey[];

  /**
   * Optional. Return the source system's OWN documentation for the selected
   * entities — table/column descriptions, display labels, analytics-role
   * hints, and (for self-describing sources) relationship facts derived from
   * the source's metadata API.
   *
   * This is the "documentation before inference" channel from
   * docs/SOURCE_ONBOARDING.md. The schema profiler treats returned docs as
   * TRUSTED: they land approved (not `ai_draft`), the AI description passes
   * skip covered columns entirely, and docs-derived relationships merge in at
   * the `declared` rung alongside `getKnownRelationships`.
   *
   * Two implementation styles, matching the playbook's metadata tiers:
   *   • Tier 1 (self-describing) — call the source's metadata endpoint with
   *     the customer's credentials (Odoo `fields_get`, OData `$metadata`,
   *     GraphQL introspection). Covers per-instance custom fields.
   *   • Tier 2 (vendor-documented) — return a map curated at build time from
   *     the vendor's published data-model reference. No network needed.
   *
   * Contract:
   *   • Column names must match the Parquet headers the sync writes
   *     (post-flattening / post-renaming).
   *   • Only return a `description` when the source actually documents the
   *     field — an empty/missing description means "let the AI fill the gap".
   *     Never fabricate docs; that's worse than an honest AI draft.
   *   • Failures must not fail profiling: throw and the platform logs +
   *     degrades to the AI pipeline for everything.
   */
  describeEntities?(
    config: ConnectorConfig,
    selectedEntities: readonly string[],
    ctx: ProbeContext,
  ): Promise<EntityDocs[]>;

  /**
   * Optional. Return the connector's deterministic star-schema template —
   * the hand-written, versioned fact/dimension design for this source system
   * (docs/SOURCE_ONBOARDING.md Phase F). When present and the template
   * covers the synced entities, the platform instantiates it INSTEAD of
   * asking the AI to design a star schema: deterministic, instant,
   * token-free, identical across customers.
   *
   * Implementations return the FULL template; the platform filters it to the
   * available entities via `instantiateStarSchemaTemplate` (graceful
   * degradation). Return null when the connector has no template (the AI
   * designer runs as before). Pure and synchronous — templates are
   * compile-time data, not discovery.
   */
  getStarSchemaTemplate?(): StarSchemaTemplate | null;
}

// ─── Entity documentation (describeEntities) ──────────────────────────────
/**
 * Vendor documentation for one column, as exposed by `describeEntities`.
 * `name` must match the Parquet header exactly (case-sensitive).
 */
export interface ColumnDoc {
  name: string;

  /** Vendor display label (e.g. Odoo's `string` attribute — "Customer"). */
  displayName?: string;

  /**
   * Vendor description text (e.g. Odoo's `help` attribute). Presence marks
   * the column as DOCUMENTED: the profiler stores it approved and skips the
   * AI description pass for this column. Omit when the source has none.
   */
  description?: string;

  /**
   * Analytics-role hint derived deterministically from the vendor's type
   * system (e.g. Odoo `monetary`/`float` → measure, `many2one`/`selection` →
   * dimension). Used for `is_measure`/`is_dimension` on documented columns,
   * which skip the AI classification pass. Omit when ambiguous.
   */
  role?: 'measure' | 'dimension';

  /**
   * Vendor-declared type string, verbatim (e.g. OData `Edm.Guid`, Odoo
   * `many2one`). Informational/curation metadata — warehouse column types
   * are pinned at WRITE time (explicit `WriteTableOptions.columns`), not
   * from this field.
   */
  dataType?: string;

  /**
   * Vendor-documented foreign-key target, both sides in `EntityDescriptor`
   * name space (e.g. EO's docs pages hyperlink every FK property to the
   * target entity's page). `describeEntities` turns these into declared-rung
   * relationships, filtered to the entities the user actually selected.
   */
  references?: { table: string; column: string };
}

/**
 * A documented reference whose target column needs the data to settle it.
 *
 * Exact Online's docs hyperlink an FK property to the target ENTITY's page and
 * stop there; the transcription then resolved the column from that entity's
 * key-marked property, which sent `JournalCode` (a string of journal codes) at
 * `Journals.ID` (a GUID). 35 of 245 references landed that way. Refusing them
 * is right — but refusing is all a connector can do, because deciding between
 * `Journals.Code` and `Journals.Description` needs values, not types.
 */
export interface UnresolvedReference {
  /** The column on THIS entity that the vendor marked as a foreign key. */
  fromColumn: string;
  /** The entity the vendor points it at. Their claim, not ours. */
  toTable: string;
  /**
   * The column the connector's own resolution produced and then rejected.
   * Carried so a log line can say what was wrong rather than only that
   * something was.
   */
  rejectedColumn: string;
  /**
   * Columns of `toTable` that could carry this key by declared type. Narrowed
   * further by the profiler, which drops any that are not near-unique before
   * spending a containment query on them.
   */
  candidates: string[];
  description?: string;
}

/** Vendor documentation for one entity, returned by `describeEntities`. */
export type { EntityBusinessKey } from './businessKeys';

export interface EntityDocs {
  /** Matches `EntityDescriptor.name`. */
  entityName: string;

  /** Human-friendly table label (falls back to the AI's suggestion). */
  displayName?: string;

  /** Table-level description. Presence = documented (see ColumnDoc). */
  description?: string;

  columns: ColumnDoc[];

  /**
   * Relationship facts discovered from the source's metadata (e.g. Odoo
   * many2one `relation` targets). Merged with `getKnownRelationships` at the
   * `declared` trust rung. Only include relationships whose endpoints are
   * both in the selected entities.
   */
  relationships?: KnownRelationship[];

  /**
   * References the vendor documents but whose target COLUMN the connector could
   * not settle from declared types alone — see `columnTypes.ts`.
   *
   * The division of labour is the point. **The connector knows the source's
   * shape and nothing about the tenant's data; the profiler has the data and
   * nothing about the source's shape.** So the connector says "the vendor
   * points this column at that entity, and by type these are the columns of it
   * that could carry the key", and the profiler measures which one actually
   * does. Neither could answer it alone, and neither has to guess.
   *
   * A reference resolved this way stays attributed to the SOURCE. The vendor
   * asserted the relationship; the endpoint was settled by measurement, not by
   * anybody's judgement — which is the difference between this and a curated
   * entry, where a person decided the relationship exists at all.
   */
  unresolvedReferences?: UnresolvedReference[];

  /**
   * Which playbook rung these docs came from:
   *   • 'declared' — harvested at runtime from the source's metadata API
   *   • 'curated'  — transcribed from vendor docs into the connector package
   * Stored as row-level provenance so the UI can say "from Odoo" vs
   * "AI suggestion".
   */
  provenance: 'declared' | 'curated';
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

// ─── Probe results (probeEntities) ────────────────────────────────────────

/**
 * Outcome of probing one entity from the connector's catalog against the
 * source system, using the connected user / division's credentials.
 *
 * The wizard maps these onto three UI states:
 *
 *   - `available`   : checkbox enabled. If `rowCountSample === 0`, the
 *                     entity is reachable but contains no data yet —
 *                     surface a muted hint so the user understands.
 *   - `forbidden`   : checkbox disabled. The OAuth app / user does not
 *                     have access — typically the module is not licensed
 *                     for this division. `reason` carries the user-
 *                     facing explanation.
 *   - `not_found`   : entity hidden from the picker entirely. The path
 *                     doesn't resolve at all — usually a regional API
 *                     difference or a stale catalog entry (a connector
 *                     bug, not a customer one).
 *   - `error`       : transient failure (timeout, 5xx). Wizard shows a
 *                     "couldn't verify" row with a retry control.
 */
export interface EntityAvailability {
  /** Matches `EntityDescriptor.name`. */
  name: string;

  state: 'available' | 'forbidden' | 'not_found' | 'error';

  /**
   * Sample row count from the probe (typically the size of a `$top=1`
   * response — so 0 or 1). Only meaningful when `state === 'available'`;
   * a 0 here means the endpoint is reachable but empty.
   */
  rowCountSample?: number;

  /**
   * Short user-facing explanation when the entity isn't fully available.
   * Examples:
   *   - 'Module not licensed for this division.'
   *   - 'Endpoint not available in this API region.'
   *   - 'Verification timed out — try again.'
   * Should never contain raw HTTP bodies, stack traces, or internal IDs.
   */
  reason?: string;

  /** HTTP status the source returned. Useful for debugging; not shown in UI. */
  httpStatus?: number;
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

  /**
   * Optional hook for OAuth-rotating connectors. When the probe path
   * causes a refresh-token rotation (EO, Salesforce, …) the connector
   * MUST call this with the full rotated config so the orchestrator
   * can re-encrypt and persist it. Skipping this hook on token rotation
   * causes the next sync to use a stale refresh token that the auth
   * provider has already invalidated — the classic "Old refresh token
   * used" 401.
   *
   * Async on purpose: the persist path is awaited so the next API call
   * doesn't race a half-written DB row.
   *
   * Optional because: (a) most probes use cached access tokens and
   * never rotate, and (b) non-OAuth connectors have no rotation.
   */
  readonly onCredentialRotated?: (newConfig: ConnectorConfig) => Promise<void>;
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

  /**
   * Schema for an entity the writer will end up materialising as an EMPTY
   * Parquet file. Used by connectors that know the column shape via an
   * out-of-band mechanism (OData $metadata, GraphQL introspection, …)
   * when the entity has zero rows in the source — without this hint the
   * empty-Parquet path produces a single `_placeholder` column, which
   * isn't useful for catalog browsing or downstream type inference.
   *
   * Each entry is one column: a name (PascalCase as it appears in the
   * source) and a DuckDB-compatible SQL type. Connectors translate from
   * source-specific types (e.g. EO's `Edm.String`, `Edm.Int32`,
   * `Edm.DateTime`) to DuckDB types before passing this option.
   *
   * Ignored when rows actually arrive — the inferred schema from the
   * rows always wins. Only consulted on the empty-write branch.
   */
  emptySchema?: ReadonlyArray<{ name: string; sqlType: string }>;

  /**
   * Explicit column schema for the POPULATED write path. When provided, the
   * writer hands DuckDB a fixed `columns={…}` map instead of inferring types
   * from a JSON sample (`auto_detect`). This eliminates the type-drift class
   * of bugs that plague sample-based inference:
   *
   *   • a column that's all-null in one sync and typed in another no longer
   *     flips type between runs (which would break the merge UNION),
   *   • dates land as real `TIMESTAMP`/`DATE` instead of strings,
   *   • large integers / monetary values keep their declared precision.
   *
   * Connectors that know their schema authoritatively (Odoo via `fields_get`,
   * any SQL-introspectable source, GraphQL introspection, …) should pass it.
   * Each entry is `{ name, sqlType }` with a DuckDB-compatible SQL type;
   * names + types are validated against an allow-list before interpolation.
   *
   * Columns present here but absent from a given row are filled NULL; JSON
   * keys not listed here are ignored. Applies to both the overwrite and the
   * delta side of a merge. When unset, the writer falls back to
   * `auto_detect` (legacy behaviour — unchanged for existing connectors).
   *
   * Doubles as the empty-table schema: if rows turn out to be zero and no
   * `emptySchema` was given, `columns` is used for the empty write too.
   */
  columns?: ReadonlyArray<{ name: string; sqlType: string }>;
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
   * The writer confines writes to `warehouse/tenant_<tid>/conn_<cid>/` by
   * prefixing every blob path and rejecting unsafe table names. NOTE: in the
   * current Azure deployment the SAS is CONTAINER-scoped (write+create), so
   * this confinement is enforced by the writer's code + the tenant-prefixed
   * layout, NOT by the SAS itself — a path-scoped (per-blob / HNS-directory)
   * SAS or per-tenant container is the tracked infra follow-up. Don't rely on
   * Azure returning a 403 for an out-of-prefix path today.
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

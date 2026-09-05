/**
 * Odoo source connector.
 *
 * Implements `SourceConnector` for Odoo's external API:
 *   • testConnection — resolve a transport (JSON-2 preferred, XML-RPC fallback)
 *                      and verify the API key.
 *   • listEntities  — return the curated allowlist (see `entities.ts`).
 *   • probeEntities — `search_count` each allowlisted model so the wizard only
 *                     offers ones that actually exist + are readable on this
 *                     instance (this is how version differences self-resolve —
 *                     e.g. `stock.valuation.layer`, gone in Odoo 19, drops out).
 *   • sync          — per entity: discover ingestible fields via `fields_get`,
 *                     page `search_read` (incremental on `write_date`), flatten
 *                     relational values, stream rows to the warehouse writer
 *                     with an explicit column schema (stable types) and
 *                     merge-by-`id`.
 *
 * Read-only: all data access goes through the transport's `assertReadOnly`
 * gate. The connector never issues create / write / unlink.
 *
 * Incremental correctness: the cursor filter is `write_date >= cursor` (not
 * `>`). `write_date` is second-precision and non-unique, so `>` can skip rows
 * that share the boundary second; `>=` re-pulls the boundary instant and the
 * merge-by-`id` writer makes that idempotent.
 */

import { BaseSourceConnector } from '../BaseSourceConnector';
import type {
  ColumnDoc,
  ConnectorConfig,
  EntityAvailability,
  EntityDescriptor,
  EntityDocs,
  KnownRelationship,
  ProbeContext,
  SourceConnector,
  SyncContext,
  SyncOptions,
  SyncResult,
  TestResult,
  EntityBusinessKey,
} from '../types';
import { CancellationError } from '../types';
import { businessKeysFromCatalog } from '../businessKeys';
import { asOdooConfig, odooConfigSchema } from './schema';
import {
  ALWAYS_KEEP_FIELDS,
  ENTITIES_BY_NAME,
  EXCLUDE_FIELD_PREFIXES,
  EXCLUDE_FIELD_TYPES,
  MODEL_TO_TABLE,
  ODOO_ENTITIES,
  ODOO_KNOWN_RELATIONSHIPS,
  PAGE_SIZE,
  asEntityDescriptors,
  odooFieldRole,
  odooTypeToDuckDb,
  type OdooEntity,
} from './entities';
import {
  OdooAuthError,
  resolveOdooTransport,
  type OdooFieldMeta,
  type OdooTransport,
} from './transport';
import type { StarSchemaTemplate } from '../starSchema';
import { ODOO_STAR_SCHEMA_TEMPLATE } from './starSchemaTemplate';
import { ODOO_COLUMN_DOCS } from './docs';

export class OdooConnector extends BaseSourceConnector implements SourceConnector {
  readonly type = 'odoo';
  readonly displayName = 'Odoo';
  readonly configSchema = odooConfigSchema;
  // Odoo Online / Odoo.sh hosts. Self-hosted instances run on customer domains
  // that can't be known statically — when per-connector egress enforcement
  // lands (see framework backlog), the host will be derived from config.url.
  readonly egressAllowList: readonly string[] = ['*.odoo.com', '*.odoo.sh'];

  // ─── testConnection ────────────────────────────────────────────────────
  async testConnection(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<TestResult> {
    this.validateConfig(rawConfig);
    const config = asOdooConfig(rawConfig);
    try {
      const { detail } = await resolveOdooTransport(config, ctx.log);
      return { ok: true, details: detail };
    } catch (e) {
      if (e instanceof OdooAuthError) return { ok: false, error: e.message };
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return { ok: false, error: `Could not reach Odoo: ${msg}` };
    }
  }

  // ─── listEntities ──────────────────────────────────────────────────────
  async listEntities(rawConfig: ConnectorConfig, _ctx: ProbeContext): Promise<EntityDescriptor[]> {
    this.validateConfig(rawConfig);
    return asEntityDescriptors();
  }

  // ─── probeEntities ─────────────────────────────────────────────────────
  /**
   * Probe each allowlisted model with `search_count`. One cheap call proves
   * existence (a missing model errors) AND yields a row-count hint. Runs
   * sequentially because the transport's HttpClient paces to Odoo Online's
   * ~1 req/sec budget — bounded concurrency would just trip 429s.
   */
  async probeEntities(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<EntityAvailability[]> {
    this.validateConfig(rawConfig);
    const config = asOdooConfig(rawConfig);
    const { transport } = await resolveOdooTransport(config, ctx.log);

    const results: EntityAvailability[] = [];
    for (const entity of ODOO_ENTITIES) {
      ctx.log.debug(`probing ${entity.model}`);
      results.push(await this.probeOne(transport, entity, ctx));
    }
    return results;
  }

  private async probeOne(
    transport: OdooTransport,
    entity: OdooEntity,
    ctx: ProbeContext,
  ): Promise<EntityAvailability> {
    try {
      const count = await transport.searchCount(entity.model, []);
      return { name: entity.name, state: 'available', rowCountSample: count };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      // A model absent on this Odoo version (e.g. stock.valuation.layer on
      // v19). The JSON-2 transport surfaces this as "endpoint not found";
      // XML-RPC as a "doesn't exist" fault.
      if (msg.includes('not found') || msg.includes("doesn't exist") || msg.includes('does not exist')) {
        return { name: entity.name, state: 'not_found', reason: 'Not available on this Odoo version.' };
      }
      if (msg.includes('access') || msg.includes('not allowed') || msg.includes('forbidden')) {
        return { name: entity.name, state: 'forbidden', reason: 'Your Odoo user cannot read this model.' };
      }
      ctx.log.warn(`probe failed for ${entity.model}`, { error: msg });
      return { name: entity.name, state: 'error', reason: 'Could not verify — try again.' };
    }
  }

  // ─── sync ──────────────────────────────────────────────────────────────
  async sync(rawConfig: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult> {
    this.validateConfig(rawConfig);
    const config = asOdooConfig(rawConfig);

    if (opts.entities.length === 0) {
      return { rowCounts: {}, warnings: ['No entities selected — nothing to sync.'] };
    }

    const resolved: OdooEntity[] = [];
    const warnings: string[] = [];
    for (const name of opts.entities) {
      const entity = ENTITIES_BY_NAME.get(name);
      if (!entity) { warnings.push(`Unknown entity '${name}' — skipped.`); continue; }
      resolved.push(entity);
    }
    if (resolved.length === 0) return { rowCounts: {}, warnings };

    const { transport } = await resolveOdooTransport(config, ctx.log);
    ctx.log.info(`Odoo sync starting`, { transport: transport.kind, entities: resolved.length });

    const rowCounts: Record<string, number> = {};
    const cursors: Record<string, { type: 'timestamp'; value: string }> = {};
    const failedEntities: Record<string, string> = {};
    const fullResync = opts.fullResync === true;

    for (const entity of resolved) {
      ctx.cancellationToken.throwIfCancelled();
      const priorCursor = fullResync ? undefined : opts.cursors?.[entity.name];
      ctx.progress({ message: `Syncing ${entity.displayName ?? entity.name}…` });
      ctx.log.info(`syncing ${entity.name}`, {
        model: entity.model,
        mode: fullResync ? 'full-resync' : priorCursor ? 'incremental' : 'initial-full',
        priorCursor: priorCursor?.value,
      });

      try {
        const { rowsWritten, maxCursorSeen, preservedExisting } =
          await this.syncOneEntity(transport, entity, ctx, priorCursor?.value, fullResync);
        rowCounts[entity.name] = rowsWritten;
        if (preservedExisting) {
          warnings.push(
            `Entity '${entity.name}' returned no rows; the previous table was kept. ` +
            `Run a full re-sync if the source really is empty now.`,
          );
        } else if (rowsWritten === 0) warnings.push(`Entity '${entity.name}' returned no rows.`);
        // Advance the cursor only when we saw a strictly-greater write_date.
        // (We FILTER with >= for boundary-safety, but only ADVANCE on >, so
        // the orchestrator's monotonicity guard is satisfied and we never
        // re-pull the same window forever.)
        if (maxCursorSeen && (!priorCursor || maxCursorSeen > priorCursor.value)) {
          cursors[entity.name] = { type: 'timestamp', value: maxCursorSeen };
        }
      } catch (err) {
        if (err instanceof CancellationError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`entity '${entity.name}' failed — continuing`, { error: msg });
        warnings.push(`Entity '${entity.name}' failed: ${msg}`);
        failedEntities[entity.name] = msg;
        rowCounts[entity.name] = 0;
      }
    }

    return { rowCounts, warnings, cursors, failedEntities };
  }

  /** Sync one entity: fields_get → paged search_read → flatten → write. */
  private async syncOneEntity(
    transport: OdooTransport,
    entity: OdooEntity,
    ctx: SyncContext,
    priorCursorValue: string | undefined,
    fullResync = false,
  ): Promise<{ rowsWritten: number; maxCursorSeen?: string; preservedExisting?: boolean }> {
    const meta = await transport.fieldsGet(entity.model);
    const fields = ingestibleFields(meta);
    const booleanFields = new Set(
      fields.filter((f) => meta[f]?.type === 'boolean'),
    );
    const columns = buildColumnSchema(fields, meta);

    // Request everything except `id` (Odoo always returns it) — keeps the
    // explicit-fields list clean. The columns schema still declares `id`.
    const requestFields = fields.filter((f) => f !== 'id');
    const domain = priorCursorValue ? [['write_date', '>=', priorCursorValue]] : [];

    let maxCursorSeen: string | undefined;
    let pagesFetched = 0;
    let rowsFetched = 0;

    async function* rows(): AsyncIterable<Record<string, unknown>> {
      let offset = 0;
      for (;;) {
        ctx.cancellationToken.throwIfCancelled();
        const batch = await transport.searchRead(entity.model, {
          domain,
          fields: requestFields,
          limit: PAGE_SIZE,
          offset,
          order: 'id',
        });
        if (batch.length === 0) break;
        for (const raw of batch) {
          const wd = raw['write_date'];
          if (typeof wd === 'string' && (!maxCursorSeen || wd > maxCursorSeen)) maxCursorSeen = wd;
          yield flattenRow(raw, booleanFields);
        }
        pagesFetched += 1;
        rowsFetched += batch.length;
        ctx.progress({
          message: `Syncing ${entity.name} (page ${pagesFetched}, ${rowsFetched} rows)`,
          perEntity: { [entity.name]: { pagesFetched, rowsFetched } },
        });
        if (batch.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
    }

    const result = await ctx.warehouseWriter.writeTable(entity.name, rows(), {
      mergeKey: entity.businessKey, // 'id'
      columns,
      ...(fullResync ? { replace: true } : {}),
    });
    ctx.log.info(`${entity.name} sync complete`, {
      pages: pagesFetched,
      rows: rowsFetched,
      bytes: result.bytesWritten,
      newCursor: maxCursorSeen,
    });
    return { rowsWritten: result.rowsWritten, maxCursorSeen, preservedExisting: result.preservedExisting };
  }

  // ─── getKnownRelationships ───────────────────────────────────────────────
  getKnownRelationships(selectedEntities: readonly string[]): readonly KnownRelationship[] {
    const set = new Set(selectedEntities);
    return ODOO_KNOWN_RELATIONSHIPS.filter((r) => set.has(r.fromTable) && set.has(r.toTable));
  }

  // ─── getBusinessKeys ───────────────────────────────────────────────────
  /**
   * Odoo's primary key is always the integer `id`, on every model — the ORM
   * guarantees it. Declared per entity rather than assumed platform-side, so
   * the profiler reads one contract for every source.
   */
  getBusinessKeys(selectedEntities: readonly string[]): readonly EntityBusinessKey[] {
    return businessKeysFromCatalog(ODOO_ENTITIES, selectedEntities);
  }

  // ─── getStarSchemaTemplate ─────────────────────────────────────────────
  /** Deterministic Kimball design for Odoo — see `starSchemaTemplate.ts`. */
  getStarSchemaTemplate(): StarSchemaTemplate {
    return ODOO_STAR_SCHEMA_TEMPLATE;
  }

  // ─── describeEntities ──────────────────────────────────────────────────
  /**
   * Harvest Odoo's OWN field documentation via `fields_get`: the `string`
   * attribute is the display label, `help` is the description text, and
   * `relation` on many2one fields names the target model — turning them into
   * declared relationships. Because this runs against the connected instance,
   * it covers customer custom fields (`x_...`) and installed-module fields
   * that static curation never could.
   *
   * Sequential per model (the transport paces to Odoo Online's ~1 req/sec),
   * so ~1s per selected entity during profiling. A model that fails
   * `fields_get` is skipped — the profiler's AI pipeline covers it instead.
   */
  async describeEntities(
    rawConfig: ConnectorConfig,
    selectedEntities: readonly string[],
    ctx: ProbeContext,
  ): Promise<EntityDocs[]> {
    this.validateConfig(rawConfig);
    const config = asOdooConfig(rawConfig);

    const selected = selectedEntities
      .map((n) => ENTITIES_BY_NAME.get(n))
      .filter((e): e is OdooEntity => !!e);
    if (selected.length === 0) return [];

    const { transport } = await resolveOdooTransport(config, ctx.log);
    const selectedTables = new Set(selected.map((e) => e.name));

    const out: EntityDocs[] = [];
    for (const entity of selected) {
      try {
        const meta = await transport.fieldsGet(entity.model);
        out.push(buildEntityDocs(entity, meta, selectedTables));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log.warn(`describeEntities: fields_get failed for ${entity.model} — skipping`, { error: msg });
      }
    }
    return out;
  }
}

// ─── Field helpers (exported for unit tests) ─────────────────────────────────
/**
 * Flatten Odoo's relational + empty-value encodings for one row:
 *   • many2one `[id, "Display Name"]` → the integer id (the join key)
 *   • `false` on a NON-boolean field → null (Odoo's empty-value sentinel)
 *   • `false` on a boolean field → kept (a real value)
 */
export function flattenRow(
  raw: Record<string, unknown>,
  booleanFields: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
      out[k] = v[0]; // many2one → id
    } else if (v === false && !booleanFields.has(k)) {
      out[k] = null; // empty-value sentinel
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Pick the safe, stable subset of fields to ingest for a model. */
export function ingestibleFields(meta: Record<string, OdooFieldMeta>): string[] {
  const keep: string[] = [];
  for (const [name, f] of Object.entries(meta)) {
    if (ALWAYS_KEEP_FIELDS.includes(name)) { keep.push(name); continue; }
    if (EXCLUDE_FIELD_TYPES.has(f?.type)) continue;
    if (EXCLUDE_FIELD_PREFIXES.some((p) => name.startsWith(p))) continue;
    keep.push(name);
  }
  // Guarantee id + write_date even if a rule above (or a sparse fields_get)
  // would have dropped them.
  for (const must of ALWAYS_KEEP_FIELDS) {
    if (!keep.includes(must) && (must in meta || must === 'id')) keep.push(must);
  }
  return keep;
}

/** Build the writer's explicit `columns` schema from Odoo field metadata. */
export function buildColumnSchema(
  fields: string[],
  meta: Record<string, OdooFieldMeta>,
): Array<{ name: string; sqlType: string }> {
  return fields.map((name) => ({
    name,
    sqlType: name === 'id' ? 'BIGINT' : odooTypeToDuckDb(meta[name]?.type ?? 'char'),
  }));
}

/** Odoo returns `false` (or omits) unset string attributes — coerce to undefined. */
function strAttr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Turn one model's `fields_get` metadata into `EntityDocs` — the vendor's own
 * documentation for the semantic layer. Pure; exported for unit tests.
 *
 *   • Same field selection as sync (`ingestibleFields`), so every documented
 *     column matches a Parquet header and nothing else.
 *   • `help` text → column description verbatim. When a many2one has no
 *     `help`, a description is synthesised deterministically from the label +
 *     `relation` target ("Customer — references res_partner") — faithful to
 *     the metadata, and FK columns are exactly where descriptions matter most.
 *   • many2one `relation` targets inside the selected set become declared
 *     relationships (fromColumn is the flattened id column, target is `id`).
 */
export function buildEntityDocs(
  entity: OdooEntity,
  meta: Record<string, OdooFieldMeta>,
  selectedTables: ReadonlySet<string>,
): EntityDocs {
  const fields = ingestibleFields(meta);
  const columns: ColumnDoc[] = [];
  const relationships: KnownRelationship[] = [];

  for (const name of fields) {
    const f = meta[name];
    const type = f?.type ?? '';
    const label = strAttr(f?.string);
    const help = strAttr(f?.help);
    const relationModel = type === 'many2one' ? strAttr(f?.relation) : undefined;
    const relationTable = relationModel ? MODEL_TO_TABLE.get(relationModel) : undefined;

    // Precedence: live instance help text (reflects tenant customisation
    // and language) > curated core-field docs (ODOO_COLUMN_DOCS — many
    // standard fields ship without help) > synthesised many2one fallback.
    let description = help;
    if (!description) description = ODOO_COLUMN_DOCS[entity.model]?.[name];
    if (!description && type === 'many2one' && label) {
      description = `${label} — references ${relationTable ?? relationModel ?? 'another record'}.`;
    }

    columns.push({
      name,
      displayName: label,
      description,
      role: odooFieldRole(name, type),
    });

    if (relationTable && selectedTables.has(relationTable)) {
      relationships.push({
        fromTable: entity.name,
        fromColumn: name,
        toTable: relationTable,
        toColumn: 'id',
        type: 'many_to_one',
        description: label ? `${label}.` : undefined,
      });
    }
  }

  return {
    entityName: entity.name,
    displayName: entity.displayName,
    description: entity.description,
    columns,
    relationships,
    provenance: 'declared',
  };
}

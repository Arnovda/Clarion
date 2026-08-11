import { BaseConnector, FkCandidate } from '../connectors/BaseConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import {
  detectSchemaConventions,
  generateTableContext,
  generateColumnDescriptions,
  suggestFkMatches,
} from '../ai/AIService';
import type { TableContextOutput, FkCandidateLike } from '../ai/prompts/schemaContextPrompt';
import { semanticDb } from '../db/knex';
import { runQualityProfileWithConnector } from '../quality/QualityProfiler';
import { TableQualityStat } from '../ai/prompts/schemaDraftPrompt';
import * as graph from '../db/semanticGraph';
import {
  createAdapterLogger,
  getConnector as getSourceConnector,
  type ColumnDoc,
  type EntityDocs,
} from '@databridge/connectors';
import { decryptCredentials, encryptCredentials } from '../utils/crypto';
import { tenantScopedWrite } from '../db/tenantScopedWrite';
import { setTenantContext } from '../db/tenantContext';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'SchemaProfiler' });

export interface ProfilerResult {
  connectionId: number;
  tablesInserted: number;
  columnsInserted: number;
  relationshipsInserted: number;
}

export interface ProfilerProgress {
  phase: 'schema' | 'quality' | 'ai_draft' | 'storing' | 'neo4j' | 'done' | 'error';
  message: string;
  table?: string;
  tableIndex?: number;
  tableCount?: number;
  batchIndex?: number;
  batchCount?: number;
}

// Foreign-key verification lives in ./fkVerification so the relationship canvas
// can import the SAME test without pulling in the connector layer. Re-exported
// here because this module was its original home and callers import it from
// both places.
export {
  verifyFkCandidate,
  describeFkVerdict,
  type FkVerdict,
} from './fkVerification';
import { verifyFkCandidate, describeFkVerdict } from './fkVerification';

export interface ProfilerOptions {
  /**
   * 'full' (default) — the whole pipeline including the AI passes.
   * 'structural' — FREE registration pass: introspection + connector-shipped
   * documentation (describeEntities / getKnownRelationships) only. No AI
   * calls, no quality profiling. Tables/columns land in the catalog with
   * vendor docs where available and bare structure otherwise
   * (ai_draft=false, approval_status='draft', semantic_source=NULL — they
   * are not AI drafts, so they stay out of the review queue). Used by the
   * sync orchestrator so a first sync surfaces tables in the catalog
   * immediately; the AI passes stay behind the explicit "Analyse" click.
   */
  mode?: 'full' | 'structural';

  /**
   * The `connections` row, pre-fetched by the caller under a correct RLS
   * tenant context. ALWAYS pass this from request/orchestrator code.
   *
   * Why it matters: the profiler's own fallback fetch runs on the raw
   * `semanticDb` pool. Under RLS (production runs as `databridge_app`) a
   * pooled connection without `app.current_tenant` set returns ZERO rows —
   * the row comes back undefined and the connector docs channel +
   * known-relationships harvest silently degrade to the pure-AI pipeline.
   * That exact failure shipped AI descriptions for fully-vendor-documented
   * ExactOnline columns in production (found 2026-07-20). The fallback
   * fetch is kept only for dev scripts where the pool bypasses RLS.
   */
  connection?: Record<string, unknown>;
}

/**
 * Three-pass schema profiler.
 *
 *   1. Heuristic FK detection (declared / known-from-connector / name-pattern
 *      / value-overlap) — runs first so subsequent AI calls have anchor points.
 *   2. Quality profiling — null %, distinct counts, top values per column.
 *   3. AI Pass A: detect schema conventions (Haiku, cheap).
 *   4. AI Pass B: generate table descriptions + relationships (one call,
 *      all tables, no per-column descriptions yet).
 *   5. Verify AI-suggested relationships via value-overlap JOINs against
 *      the live data — keep only those with ≥50% overlap.
 *   6. AI Pass C: per-batch column descriptions, with the table context +
 *      verified relationships injected. This is where "InvoiceTo" turns
 *      into "Which customer is being billed for this invoice" instead of
 *      a generic "Account reference".
 *   7. Persist to Postgres + Neo4j.
 *
 * Falls back gracefully on every AI step — a failed conventions/context/column
 * pass logs a warning, the next stage still runs with what it has, and the
 * profiler always returns success unless the introspection itself blows up.
 */
export async function runSchemaProfiler(
  connectionId: number,
  onProgress?: (p: ProfilerProgress) => void,
  connectorOverride?: BaseConnector,
  options?: ProfilerOptions,
): Promise<ProfilerResult> {
  const emit = onProgress ?? (() => {});
  const structural = options?.mode === 'structural';

  // ── 1. Introspect source schema ────────────────────────────────────────
  emit({ phase: 'schema', message: 'Step 1/7 — Reading database schema…' });
  let connector: BaseConnector;
  let shouldDisconnect = true;
  let connectorType: string | null = null;
  let selectedEntities: readonly string[] | null = null;

  // The connection row primes everything trusted: connector_type /
  // selected_entities gate the docs + known-relationships harvest, and
  // connector_config_encrypted feeds describeEntities. Callers pass it
  // pre-fetched (options.connection) because the fallback fetch below runs
  // on the raw pool and returns nothing under RLS without tenant context —
  // see ProfilerOptions.connection for the production incident this caused.
  const connRow =
    (options?.connection as Record<string, unknown> | undefined)
    ?? await semanticDb('connections').where({ id: connectionId }).first();
  if (!connRow) {
    // With a connectorOverride we can still profile structurally, but every
    // trusted-tier channel is dead — say so LOUDLY instead of silently
    // shipping AI text for vendor-documented columns.
    log.warn(
      { connectionId },
      'connection row unavailable (missing options.connection + RLS-filtered pool fetch?) — '
      + 'connector docs channel and known-relationships harvest are DISABLED for this run',
    );
  }
  if (connectorOverride) {
    connector = connectorOverride;
    shouldDisconnect = false;
  } else {
    if (!connRow) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    connector = await createConnector(connRow as unknown as Parameters<typeof createConnector>[0]);
  }
  connectorType = (connRow?.connector_type as string | undefined) ?? null;
  selectedEntities = (connRow?.selected_entities as string[] | null | undefined) ?? null;
  const tenantId: number | null = Number.isFinite(Number(connRow?.tenant_id))
    ? Number(connRow?.tenant_id)
    : null;

  await connector.connect();
  const schema = await connector.introspectSchema();
  const heuristicFks: FkCandidate[] = schema.fkCandidates ?? [];
  const classifications = schema.tableClassifications ?? [];

  // ── 1a. Connector-documented semantics (docs/SOURCE_ONBOARDING.md §1) ──
  // "Documentation before inference": self-describing sources return their
  // OWN table/column docs + relationship facts via describeEntities (e.g.
  // Odoo `fields_get` labels + help texts — which also cover customer custom
  // fields). Everything returned is TRUSTED: it lands approved (not
  // ai_draft), and the AI passes below only fill what's left uncovered.
  // Failure degrades to the AI pipeline — never fatal.
  let connectorDocs: EntityDocs[] = [];
  if (connectorType && selectedEntities?.length && connRow?.connector_config_encrypted) {
    try {
      const sourceConnector = getSourceConnector(connectorType);
      if (sourceConnector.describeEntities) {
        emit({ phase: 'schema', message: 'Step 1/7 — Reading field documentation from the source system…' });
        const connectorConfig = JSON.parse(decryptCredentials(connRow.connector_config_encrypted));
        connectorDocs = await sourceConnector.describeEntities(connectorConfig, selectedEntities, {
          log: createAdapterLogger(log),
          // Some sources rotate credentials even on metadata reads — persist
          // the rotation or the next sync would use a dead refresh token.
          // Tenant-scoped: a bare pool update is RLS-filtered to zero rows
          // in production, silently losing the rotated token.
          onCredentialRotated: async (newConfig) => {
            const encrypted = encryptCredentials(JSON.stringify(newConfig));
            if (tenantId != null) {
              await tenantScopedWrite(tenantId, (trx) =>
                trx('connections')
                  .where({ id: connectionId })
                  .update({ connector_config_encrypted: encrypted }),
              );
            } else {
              await semanticDb('connections')
                .where({ id: connectionId })
                .update({ connector_config_encrypted: encrypted });
            }
          },
        });
        const documentedCols = connectorDocs.reduce(
          (sum, d) => sum + d.columns.filter((c) => c.description).length, 0,
        );
        log.info(`describeEntities(${connectorType}): ${connectorDocs.length} entities, ${documentedCols} documented columns`);
        if (documentedCols > 0) {
          emit({ phase: 'schema', message: `Step 1/7 — Source documentation found for ${documentedCols} column(s) across ${connectorDocs.length} table(s)` });
        }
      }
    } catch (err) {
      log.warn({ err }, `describeEntities(${connectorType}) failed — falling back to AI descriptions`);
      connectorDocs = [];
    }
  }

  // Lookups for the trusted-docs rung. A column counts as DOCUMENTED only
  // when the connector supplied a description — those skip AI Pass C.
  const tableDocByName = new Map<string, EntityDocs>();
  const colDocByKey = new Map<string, ColumnDoc>();
  for (const d of connectorDocs) {
    tableDocByName.set(d.entityName, d);
    for (const c of d.columns) colDocByKey.set(`${d.entityName}.${c.name}`, c);
  }

  // Vendor-docs context for the AI passes: table definitions for Pass B,
  // documented siblings for Pass C (so custom fields are described in the
  // vendor's own vocabulary instead of blind). Truncation/caps applied at
  // prompt-render time.
  const vendorDocsCtx = connectorDocs.length > 0
    ? {
        tableDescriptions: Object.fromEntries(
          connectorDocs.filter((d) => d.description).map((d) => [d.entityName, d.description!]),
        ),
        columnsByTable: Object.fromEntries(
          connectorDocs.map((d) => [
            d.entityName,
            d.columns.filter((c) => c.description).map((c) => ({ name: c.name, description: c.description! })),
          ]),
        ),
      }
    : undefined;

  // ── 1b. Known-from-connector FKs (free signal, no AI tokens) ───────────
  // API-style sources (ExactOnline, NetSuite, …) ship a documented data
  // model — far more reliable than heuristic name-pattern matching on
  // PascalCase columns.
  const knownFks: FkCandidate[] = [];
  if (connectorType && selectedEntities) {
    try {
      const sourceConnector = getSourceConnector(connectorType);
      if (sourceConnector.getKnownRelationships) {
        const known = sourceConnector.getKnownRelationships(selectedEntities);
        for (const rel of known) {
          knownFks.push({
            fromTable: rel.fromTable,
            fromColumn: rel.fromColumn,
            toTable: rel.toTable,
            toColumn: rel.toColumn,
            source: 'declared',
            confidence: 1.0,
          });
        }
        log.info(`Loaded ${knownFks.length} known relationship(s) from ${connectorType}`);
      }
    } catch (err) {
      log.warn({ err }, `getKnownRelationships(${connectorType}) failed`);
    }
  }

  // Docs-derived relationship facts (e.g. Odoo many2one `relation` targets)
  // join the declared rung too — deduped against the static catalog.
  {
    const seen = new Set(knownFks.map((k) => `${k.fromTable}.${k.fromColumn}→${k.toTable}.${k.toColumn}`));
    let docRelCount = 0;
    for (const d of connectorDocs) {
      for (const rel of d.relationships ?? []) {
        const key = `${rel.fromTable}.${rel.fromColumn}→${rel.toTable}.${rel.toColumn}`;
        if (seen.has(key)) continue;
        seen.add(key);
        knownFks.push({
          fromTable:  rel.fromTable,
          fromColumn: rel.fromColumn,
          toTable:    rel.toTable,
          toColumn:   rel.toColumn,
          source:     'declared',
          confidence: 1.0,
        });
        docRelCount++;
      }
    }
    if (docRelCount > 0) log.info(`describeEntities(${connectorType}): +${docRelCount} declared relationship(s) from source metadata`);
  }

  // De-duplicate: heuristic FKs that match a known one are dropped.
  const knownKeys = new Set(knownFks.map((k) => `${k.fromTable}.${k.fromColumn}→${k.toTable}.${k.toColumn}`));
  const heuristicMinusKnown = heuristicFks.filter(
    (fk) => !knownKeys.has(`${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`),
  );

  const declaredCount = heuristicFks.filter((fk) => fk.source === 'declared').length;
  const patternCount = heuristicFks.filter((fk) => fk.source === 'name_pattern').length;
  const overlapCount = heuristicFks.filter((fk) => fk.source === 'value_overlap').length;
  const fkParts: string[] = [];
  if (knownFks.length) fkParts.push(`${knownFks.length} known`);
  if (declaredCount) fkParts.push(`${declaredCount} declared`);
  if (patternCount) fkParts.push(`${patternCount} by name`);
  if (overlapCount) fkParts.push(`${overlapCount} by data`);
  const fkSummary = fkParts.length ? ` — ${fkParts.join(', ')}` : '';
  emit({ phase: 'schema', message: `Step 1/7 — Found ${schema.tables.length} tables${fkSummary}` });

  // ── 1b. AI-assisted FK matching (legacy assist) ────────────────────────
  const unmatched = connector.getUnmatchedKeyColumns(schema.tables, classifications, [...knownFks, ...heuristicMinusKnown]);
  const allFkCandidates = [...knownFks, ...heuristicMinusKnown];
  if (!structural && unmatched.length > 0) {
    emit({ phase: 'schema', message: `Step 1/7 — Asking Claude to match ${unmatched.length} unmatched key column(s)…` });
    const dimTables = classifications
      .filter((c) => c.role === 'dimension' || c.role === 'unknown')
      .map((c) => {
        const t = schema.tables.find((t2) => t2.tableName === c.tableName)!;
        return {
          tableName: c.tableName,
          columns: t.columns.map((col) => ({ name: col.name, sampleValues: col.sampleValues })),
          role: c.role,
        };
      });
    try {
      const aiSuggestions = await suggestFkMatches(unmatched, dimTables);
      for (const s of aiSuggestions) {
        const key = `${s.from_table}.${s.from_column}→${s.to_table}.${s.to_column}`;
        if (allFkCandidates.some((c) => `${c.fromTable}.${c.fromColumn}→${c.toTable}.${c.toColumn}` === key)) continue;
        try {
          const v = await verifyFkCandidate(connector, s.from_table, s.from_column, s.to_table, s.to_column);
          const label = `${s.from_table}.${s.from_column} → ${s.to_table}.${s.to_column}`;
          if (v.ok) {
            log.info(`[FK AI] verified: ${label}: ${describeFkVerdict(v)}`);
            allFkCandidates.push({
              fromTable: s.from_table, fromColumn: s.from_column,
              toTable: s.to_table, toColumn: s.to_column,
              source: 'ai_suggested', confidence: v.containment >= 0.9 ? 0.9 : 0.75,
              overlapRatio: v.containment,
            });
          } else {
            log.info(`[FK AI] rejected: ${label}: ${describeFkVerdict(v)}`);
          }
        } catch { /* verification query failed — skip */ }
      }
      const aiAdded = allFkCandidates.length - knownFks.length - heuristicMinusKnown.length;
      if (aiAdded > 0) emit({ phase: 'schema', message: `Step 1/7 — Claude found ${aiAdded} additional relationship(s)` });
    } catch (err) {
      log.warn({ err }, 'AI FK matching failed (non-fatal)');
    }
  }

  // ── 2. Quality profiling ───────────────────────────────────────────────
  // Skipped in structural mode: no AI tokens are involved, but per-column
  // distinct/null scans over every table would make the post-sync
  // registration slow for no user-visible gain — the full Analyse run
  // re-does it anyway.
  const qualityStats: TableQualityStat[] = [];
  for (let ti = 0; !structural && ti < schema.tables.length; ti++) {
    const table = schema.tables[ti];
    emit({ phase: 'quality', message: `Step 2/7 — Profiling ${table.tableName} (${ti + 1}/${schema.tables.length}) — nulls, distincts, value distributions…`, table: table.tableName, tableIndex: ti, tableCount: schema.tables.length });
    try {
      // Always use the connector-based profiler — every connection type
      // (SQLite for local dev, the source connectors for live data, DuckDB
      // for product warehouses) implements the BaseConnector interface, so
      // there's a single code path.
      const result = await runQualityProfileWithConnector(
        connectionId,
        table.tableName,
        connector,
        table.columns.map(c => ({ name: c.name, type: c.type })),
      );
      qualityStats.push({
        table_name: table.tableName,
        row_count:  result.rowCount,
        columns: result.fields.map((f) => ({
          field_name:     f.field_name,
          null_pct:       f.null_pct,
          distinct_count: f.distinct_count,
          row_count:      result.rowCount,
          top_values:     (f.top_values ?? []).map((v) => ({ value: String(v.value), pct: v.pct })),
          min_value:      f.min_value,
          max_value:      f.max_value,
        })),
      });
    } catch (err) {
      log.warn({ err }, `quality pre-profile skipped for ${table.tableName}`);
    }
  }

  // ── 3. AI Pass A — detect schema conventions ───────────────────────────
  let conventions: Awaited<ReturnType<typeof detectSchemaConventions>> = null;
  if (!structural) {
    emit({ phase: 'ai_draft', message: 'Step 3/7 — Detecting naming conventions (PascalCase / snake_case / camelCase)…' });
    conventions = await detectSchemaConventions(connectorType, schema.tables);
    if (conventions) {
      log.info(`Conventions: ${conventions.naming_style} (confidence ${conventions.confidence})`);
      emit({ phase: 'ai_draft', message: `Step 3/7 — Detected ${conventions.naming_style} naming (confidence ${Math.round(conventions.confidence * 100)}%)` });
    }
  }

  // ── 4. AI Pass B — table descriptions + relationships ──────────────────
  const totalCols = schema.tables.reduce((sum, t) => sum + t.columns.length, 0);
  let tableContext: TableContextOutput;
  if (structural) {
    // Structural mode: no AI table context. Tables carry vendor docs (merged
    // below) or bare names; relationships come only from the declared /
    // heuristic candidates persisted in step 5b.
    tableContext = {
      tables: schema.tables.map((t) => ({
        table_name: t.tableName, display_name: t.tableName, description: '', grain: '',
      })),
      relationships: [],
    };
  } else {
  emit({ phase: 'ai_draft', message: `Step 4/7 — Asking Claude to map your data model (${schema.tables.length} tables, ${totalCols} columns) — this is one large call, ~30-60s…` });
  const fkLikes: FkCandidateLike[] = allFkCandidates.map((fk) => ({
    fromTable: fk.fromTable,
    fromColumn: fk.fromColumn,
    toTable: fk.toTable,
    toColumn: fk.toColumn,
    source: fk.source,
    confidence: fk.confidence,
    overlapRatio: fk.overlapRatio ?? null,
  }));

  try {
    tableContext = await generateTableContext(
      connectorType, conventions, schema.tables, qualityStats, fkLikes, vendorDocsCtx,
    );
    log.info(`Pass B: ${tableContext.tables.length} tables, ${tableContext.relationships.length} relationships`);
    emit({ phase: 'ai_draft', message: `Step 4/7 — Claude described ${tableContext.tables.length} tables and suggested ${tableContext.relationships.length} relationship(s)` });
  } catch (err) {
    log.warn({ err }, 'generateTableContext failed (non-fatal)');
    tableContext = {
      tables: schema.tables.map((t) => ({
        table_name: t.tableName, display_name: t.tableName, description: '', grain: '',
      })),
      relationships: [],
    };
  }
  }

  // ── 4a0. The model's JSON is parsed with a CAST, not a schema, so every
  //         field below is `string` by assertion only. One relationship
  //         missing `from_table` used to reach `.toLowerCase()` and abort the
  //         ENTIRE profiling run with "Cannot read properties of undefined" —
  //         no descriptions, no relationships, nothing persisted, for one bad
  //         element out of a couple of hundred. A malformed element is not a
  //         reason to lose the other 99%: drop it and name it.
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  {
    const badTables = tableContext.tables.filter((t) => !isStr(t?.table_name));
    if (badTables.length > 0) {
      log.warn({ count: badTables.length }, 'Dropped AI table entries with no table_name');
      tableContext.tables = tableContext.tables.filter((t) => isStr(t?.table_name));
    }
    // Both endpoints AND both columns are required — a relationship missing
    // any of the four cannot express a JOIN even if it survives the lookup.
    const wellFormed = tableContext.relationships.filter(
      (r) => isStr(r?.from_table) && isStr(r?.to_table) && isStr(r?.via_column) && isStr(r?.to_column),
    );
    if (wellFormed.length !== tableContext.relationships.length) {
      const dropped = tableContext.relationships.length - wellFormed.length;
      log.warn(
        { dropped, kept: wellFormed.length },
        'Dropped malformed AI relationship(s) — missing table or column name',
      );
      tableContext.relationships = wellFormed;
    }
  }

  // ── 4a. Build a case-insensitive lookup for the AI's `from_table` /
  //        `to_table` strings. Without this, EO `salesinvoicelines` would
  //        silently fail to match `SalesInvoiceLines` in the schema and the
  //        relationship would be dropped on insert.
  const tableNameByLower = new Map<string, string>();
  for (const t of schema.tables) tableNameByLower.set(t.tableName.toLowerCase(), t.tableName);

  // Normalise relationship table names back to the canonical (Parquet-header)
  // casing so column / table lookups downstream succeed.
  const droppedAiRels: string[] = [];
  for (const rel of tableContext.relationships) {
    const fromCanon = tableNameByLower.get(rel.from_table.toLowerCase());
    const toCanon = tableNameByLower.get(rel.to_table.toLowerCase());
    if (!fromCanon) { droppedAiRels.push(`${rel.from_table}.${rel.via_column}→${rel.to_table}`); continue; }
    if (!toCanon)   { droppedAiRels.push(`${rel.from_table}.${rel.via_column}→${rel.to_table}`); continue; }
    rel.from_table = fromCanon;
    rel.to_table = toCanon;
  }
  if (droppedAiRels.length > 0) {
    log.warn(`Dropped ${droppedAiRels.length} AI relationship(s) — table not in schema: ${droppedAiRels.slice(0, 5).join(', ')}${droppedAiRels.length > 5 ? '…' : ''}`);
  }
  // Drop the canonicalised-out rels (those whose endpoint tables don't exist).
  tableContext.relationships = tableContext.relationships.filter(
    (r) => tableNameByLower.has(r.from_table.toLowerCase()) && tableNameByLower.has(r.to_table.toLowerCase()),
  );

  // ── 5. Verify Pass B's relationships against the data ──────────────────
  // Drops anything the data doesn't actually back. Skips relationships that
  // came from a known/declared/already-verified source (those are trusted).
  // Structural mode has no AI suggestions to verify.
  //
  // This used to carry its OWN copy of the check — 500-value sample against a
  // whole-column total, `overlap >= 0.5`, no uniqueness test on the target.
  // When the other two candidate paths were fixed, this one was missed, and it
  // is the path that produced every `→ GLClassifications.Name` row in the
  // production audit: `Name` is not unique, so a target-uniqueness test kills
  // them, and there was none here. It now calls the same verifyFkCandidate()
  // as the others.
  if (!structural) {
  emit({ phase: 'ai_draft', message: `Step 5/7 — Verifying AI-suggested relationships against the data (${tableContext.relationships.length} to check)…` });
  const trustedKeys = new Set(allFkCandidates.map((fk) => `${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`));
  const verifiedAiRels: typeof tableContext.relationships = [];
  let aiVerified = 0, aiDropped = 0, aiUnverified = 0;
  const VERIFY_TIMEOUT = 8_000;
  // Bounds how long Analyse spends here. At ~170 candidates the old 60s could
  // run out before the last ones were checked, and every remaining candidate
  // was then kept UNVERIFIED and counted in neither number below — so the
  // summary read as if everything had been checked. Raised, configurable, and
  // exhaustion is now reported rather than absorbed.
  const VERIFY_BUDGET  = Number(process.env.FK_VERIFY_BUDGET_MS) || 180_000;
  const verifyStart = Date.now();
  for (const rel of tableContext.relationships) {
    const key = `${rel.from_table}.${rel.via_column}→${rel.to_table}.${rel.to_column}`;
    if (trustedKeys.has(key)) {
      verifiedAiRels.push(rel);
      continue;
    }
    if (Date.now() - verifyStart > VERIFY_BUDGET) {
      // Budget exhausted — keep remaining AI rels as-is (ai_draft = true, so
      // the user can confirm/flag them in the review queue). Counted, because
      // "kept without being checked" must not look like "verified".
      aiUnverified++;
      verifiedAiRels.push(rel);
      continue;
    }
    try {
      const v = await Promise.race([
        verifyFkCandidate(connector, rel.from_table, rel.via_column, rel.to_table, rel.to_column),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('verify timeout')), VERIFY_TIMEOUT)),
      ]);
      if (v.ok) {
        verifiedAiRels.push(rel);
        // Also add to allFkCandidates so it's persisted with overlap info.
        allFkCandidates.push({
          fromTable: rel.from_table, fromColumn: rel.via_column,
          toTable: rel.to_table, toColumn: rel.to_column,
          source: 'ai_suggested',
          confidence: v.containment >= 0.9 ? 0.9 : 0.75,
          overlapRatio: v.containment,
        });
        aiVerified++;
        log.info(`AI rel verified: ${key} (${describeFkVerdict(v)})`);
      } else {
        aiDropped++;
        log.info(`AI rel rejected: ${key} (${describeFkVerdict(v)})`);
      }
    } catch {
      // Verification failed (timeout / type mismatch) — keep the rel anyway as
      // ai_draft so the user can review it. Better than silently dropping a
      // potentially-good relationship on an infrastructure hiccup.
      verifiedAiRels.push(rel);
    }
  }
  tableContext.relationships = verifiedAiRels;
  if (aiUnverified > 0) {
    log.warn(
      { unverified: aiUnverified, budgetMs: VERIFY_BUDGET },
      'relationship verification budget exhausted — remaining candidates kept unchecked as drafts',
    );
  }
  if (aiVerified > 0 || aiDropped > 0 || aiUnverified > 0) {
    emit({
      phase: 'ai_draft',
      message: `Step 5/7 — Verified ${aiVerified} AI-suggested relationship(s)`
        + (aiDropped ? `, dropped ${aiDropped}` : '')
        + (aiUnverified ? `, ${aiUnverified} left unchecked (time budget)` : ''),
    });
  }
  }

  // ── 6. AI Pass C — column descriptions with table+rel context ──────────
  // Connector-documented columns are EXCLUDED from this pass: their vendor
  // docs are already final (trusted rung), so Claude only describes the
  // uncovered remainder — custom fields, undocumented columns. This is where
  // the documentation channel saves tokens and review-queue load.
  const isDocumented = (t: string, c: string) => !!colDocByKey.get(`${t}.${c}`)?.description;
  const uncoveredTables = schema.tables
    .map((t) => ({ ...t, columns: t.columns.filter((c) => !isDocumented(t.tableName, c.name)) }))
    .filter((t) => t.columns.length > 0);
  const uncoveredCols = uncoveredTables.reduce((sum, t) => sum + t.columns.length, 0);
  const coveredCols = totalCols - uncoveredCols;

  let columnDescriptions;
  if (structural) {
    // No AI column pass — vendor docs (merged below) are all we ship.
    columnDescriptions = { columns: [] };
  } else if (uncoveredCols === 0) {
    columnDescriptions = { columns: [] };
    emit({ phase: 'ai_draft', message: `Step 6/7 — All ${totalCols} columns are documented by the source system — no AI descriptions needed` });
  } else {
    emit({
      phase: 'ai_draft',
      message: coveredCols > 0
        ? `Step 6/7 — ${coveredCols} columns documented by the source; Claude is describing the remaining ${uncoveredCols}…`
        : `Step 6/7 — Claude is describing ${totalCols} columns across ${schema.tables.length} tables…`,
    });
    try {
      columnDescriptions = await generateColumnDescriptions(
        connectorType, tableContext, uncoveredTables, qualityStats,
        (tableNames, batchIndex, totalBatches) => {
          emit({ phase: 'ai_draft', message: `Step 6/7 — Describing ${tableNames.join(', ')} (batch ${batchIndex + 1}/${totalBatches})…`, batchIndex, batchCount: totalBatches });
        },
        vendorDocsCtx,
      );
      emit({ phase: 'ai_draft', message: `Step 6/7 — Claude described ${columnDescriptions.columns.length} columns` });
    } catch (err) {
      log.warn({ err }, 'generateColumnDescriptions failed (non-fatal)');
      columnDescriptions = { columns: [] };
    }
  }

  if (shouldDisconnect) connector.disconnect();

  // Lookup maps
  // Explicit element types: without them, the build's tsc widens the
  // tuple `[string, T]` to `(string | T)[]` and the Map values come out
  // as `unknown` (so `.display_name` etc. fail to type-check downstream).
  type TableCtxEntry = (typeof tableContext.tables)[number];
  type ColumnDefEntry = (typeof columnDescriptions.columns)[number];
  const tableContextByName = new Map<string, TableCtxEntry>(
    tableContext.tables.map((t) => [t.table_name, t] as const),
  );
  const columnDefByKey = new Map<string, ColumnDefEntry>(
    columnDescriptions.columns.map((c) => [`${c.table_name}.${c.column_name}`, c] as const),
  );

  // Merge the trusted docs rung with the AI drafts into final per-row persist
  // values — computed ONCE and consumed by both the Postgres insert and the
  // Neo4j sync, so the dual-write mirror can't diverge. Precedence per
  // docs/SOURCE_ONBOARDING.md §1: connector docs > AI; a row whose
  // description came from the connector lands approved (ai_draft=false) with
  // its provenance recorded in semantic_source.
  type TablePersist = { displayName: string; description: string | null; vendorDescription: string | null; aiDraft: boolean; approvalStatus: 'draft' | 'approved'; semanticSource: string | null; editedByUser: boolean };
  type ColPersist = { displayName: string; description: string | null; vendorDescription: string | null; isDimension: boolean; isMeasure: boolean; aiDraft: boolean; approvalStatus: 'draft' | 'approved'; semanticSource: string | null; editedByUser: boolean };
  const tablePersistByName = new Map<string, TablePersist>();
  const colPersistByKey = new Map<string, ColPersist>();
  for (const table of schema.tables) {
    const tCtx = tableContextByName.get(table.tableName);
    const tDoc = tableDocByName.get(table.tableName);
    const tableDocumented = !!tDoc?.description;
    tablePersistByName.set(table.tableName, {
      displayName:    tDoc?.displayName ?? tCtx?.display_name ?? table.tableName,
      description:    tDoc?.description ?? tCtx?.description ?? null,
      // Immutable curated base for the enrichment layer — vendor text only.
      vendorDescription: tDoc?.description ?? null,
      // Structural mode never produces AI content, so nothing is an AI
      // draft — undocumented rows are bare structure (semantic_source NULL,
      // approval 'draft') that the review queue must NOT list, because
      // there is no draft text to review yet.
      aiDraft:        structural ? false : !tableDocumented,
      approvalStatus: tableDocumented ? 'approved' : 'draft',
      semanticSource: tableDocumented ? (tDoc?.provenance ?? 'declared') : (structural ? null : 'ai'),
      editedByUser:   false,
    });
    for (const srcCol of table.columns) {
      const key = `${table.tableName}.${srcCol.name}`;
      const cDoc = colDocByKey.get(key);
      const colDef = columnDefByKey.get(key);
      const colDocumented = !!cDoc?.description;
      colPersistByKey.set(key, {
        // Vendor labels beat AI guesses even on undocumented columns; the
        // role hint only fills in when the AI pass didn't cover the column.
        displayName:    cDoc?.displayName ?? colDef?.display_name ?? srcCol.name,
        description:    cDoc?.description ?? colDef?.description ?? null,
        vendorDescription: cDoc?.description ?? null,
        isDimension:    colDef?.is_dimension ?? (cDoc?.role === 'dimension'),
        isMeasure:      colDef?.is_measure ?? (cDoc?.role === 'measure'),
        aiDraft:        structural ? false : !colDocumented,
        approvalStatus: colDocumented ? 'approved' : 'draft',
        semanticSource: colDocumented ? (tDoc?.provenance ?? 'declared') : (structural ? null : 'ai'),
        editedByUser:   false,
      });
    }
  }

  // ── 6b. Human-edit + approved-enrichment snapshots ─────────────────────
  // The persist step below is wipe-and-reinsert, which historically erased
  // curator work on every re-profile. Snapshot the rows a human authored
  // (edited_by_user), the enrichments a human approved, and the
  // relationships a human confirmed — then merge them into the persist maps
  // so BOTH Postgres and the Neo4j mirror receive the human values
  // (precedence: human > connector docs > AI). Rows whose table/column no
  // longer exists at the source are dropped with a log line — the catalog
  // must not claim schema that isn't there.
  type HumanRelSnap = {
    from_table: string; from_column: string | null;
    to_table: string; to_column: string | null;
    relationship_type: string; description: string | null;
  };
  let humanRelSnaps: HumanRelSnap[] = [];
  try {
    const snaps = await semanticDb.transaction(async (trx) => {
      if (tenantId != null) await setTenantContext(trx, tenantId);
      const tableRows = await trx('source_tables')
        .where({ connection_id: connectionId })
        .where('edited_by_user', true)
        .select('table_name', 'display_name', 'description');
      const colRows = await trx('source_columns as c')
        .join('source_tables as t', 'c.table_id', 't.id')
        .where({ 't.connection_id': connectionId })
        .where(function () {
          this.where('c.edited_by_user', true)
            .orWhere(function () {
              this.where('c.semantic_source', 'ai_enriched').andWhere('c.approval_status', 'approved');
            });
        })
        .select(
          't.table_name', 'c.column_name', 'c.display_name', 'c.description',
          'c.is_dimension', 'c.is_measure', 'c.edited_by_user', 'c.semantic_source',
        );
      const relRows = await trx('table_relationships as r')
        .join('source_tables as ft', 'r.from_table_id', 'ft.id')
        .join('source_tables as tt', 'r.to_table_id', 'tt.id')
        .leftJoin('source_columns as fc', 'r.from_column_id', 'fc.id')
        .leftJoin('source_columns as tc', 'r.to_column_id', 'tc.id')
        .where({ 'ft.connection_id': connectionId })
        .where('r.confirmed_by_user', true)
        .select(
          'ft.table_name as from_table', 'fc.column_name as from_column',
          'tt.table_name as to_table', 'tc.column_name as to_column',
          'r.relationship_type', 'r.description',
        );
      return { tableRows, colRows, relRows };
    });

    for (const s of snaps.tableRows) {
      const tp = tablePersistByName.get(s.table_name);
      if (!tp) { log.info(`human-edited table ${s.table_name} no longer exists at the source — snapshot dropped`); continue; }
      tablePersistByName.set(s.table_name, {
        ...tp,
        displayName: s.display_name ?? tp.displayName,
        description: s.description ?? tp.description,
        aiDraft: false,
        approvalStatus: 'approved',
        editedByUser: true,
      });
    }
    for (const s of snaps.colRows) {
      const key = `${s.table_name}.${s.column_name}`;
      const cp = colPersistByKey.get(key);
      if (!cp) { log.info(`human-edited/enriched column ${key} no longer exists at the source — snapshot dropped`); continue; }
      const isEnrichedOnly = !s.edited_by_user;
      colPersistByKey.set(key, {
        ...cp,
        displayName: s.display_name ?? cp.displayName,
        description: s.description ?? cp.description,
        isDimension: !!s.is_dimension,
        isMeasure: !!s.is_measure,
        aiDraft: false,
        approvalStatus: 'approved',
        semanticSource: isEnrichedOnly ? 'ai_enriched' : cp.semanticSource,
        editedByUser: !!s.edited_by_user,
      });
    }
    humanRelSnaps = snaps.relRows as HumanRelSnap[];
    if (snaps.tableRows.length || snaps.colRows.length || humanRelSnaps.length) {
      log.info(
        `preserving human curation across re-profile: ${snaps.tableRows.length} table(s), `
        + `${snaps.colRows.length} column(s), ${humanRelSnaps.length} relationship(s)`,
      );
    }
  } catch (err) {
    log.warn({ err }, 'human-edit snapshot read failed — re-profile proceeds WITHOUT edit preservation');
  }

  // ── 7. Persist to Postgres + Neo4j ─────────────────────────────────────
  let tablesInserted = 0;
  let columnsInserted = 0;
  let relationshipsInserted = 0;

  const tableIdMap  = new Map<string, number>();
  const columnIdMap = new Map<string, number>();
  let pgRelsForNeo4j: Array<Record<string, unknown>> = [];

  emit({ phase: 'storing', message: `Step 7/7 — Saving ${schema.tables.length} tables, ${totalCols} columns, ${tableContext.relationships.length} relationships to database…` });
  await semanticDb.transaction(async (trx) => {
    // Pin the RLS tenant context ON THIS transaction. Without it the
    // transaction's pooled connection may carry no tenant (writes silently
    // affect 0 rows / inserts get NULL tenant_id) or — worse — a STALE
    // tenant from an earlier request on the same pooled connection.
    if (tenantId != null) await setTenantContext(trx, tenantId);
    const existingTables = await trx('source_tables')
      .where({ connection_id: connectionId })
      .select('id', 'table_name');
    const existingTableIds = existingTables.map((t: { id: number }) => t.id);

    type CvRelSnapshot = {
      id: number; view_id: number; relationship_type: string; label: string | null;
      from_table: string; from_col: string | null;
      to_table:   string; to_col:   string | null;
    };
    type CvTableSnapshot = { view_id: number; table_name: string; pos_x: number; pos_y: number };

    let cvRelSnapshots:   CvRelSnapshot[]   = [];
    let cvTableSnapshots: CvTableSnapshot[] = [];

    if (existingTableIds.length) {
      const existingColumns = await trx('source_columns')
        .whereIn('table_id', existingTableIds)
        .select('id', 'column_name', 'table_id');

      const colIdToName = new Map(
        existingColumns.map((c: { id: number; column_name: string; table_id: number }) => {
          const tbl = existingTables.find((t: { id: number }) => t.id === c.table_id);
          return [c.id, { table: tbl?.table_name ?? '', col: c.column_name }];
        }),
      );
      const tableIdToName = new Map(existingTables.map((t: { id: number; table_name: string }) => [t.id, t.table_name]));

      const existingColumnIds = existingColumns.map((c: { id: number }) => c.id);
      if (existingColumnIds.length || existingTableIds.length) {
        const cvRels = await trx('cross_view_relationships')
          .where(function () {
            this
              .whereIn('from_table_id', existingTableIds)
              .orWhereIn('to_table_id',   existingTableIds)
              .orWhereIn('from_column_id', existingColumnIds)
              .orWhereIn('to_column_id',   existingColumnIds);
          })
          .select('id', 'view_id', 'from_table_id', 'from_column_id',
                  'to_table_id', 'to_column_id', 'relationship_type', 'label');

        cvRelSnapshots = cvRels.map((r: {
          id: number; view_id: number;
          from_table_id: number; from_column_id: number | null;
          to_table_id:   number; to_column_id:   number | null;
          relationship_type: string; label: string | null;
        }) => ({
          id:                r.id,
          view_id:           r.view_id,
          relationship_type: r.relationship_type,
          label:             r.label,
          from_table: tableIdToName.get(r.from_table_id) ?? '',
          from_col:   r.from_column_id ? (colIdToName.get(r.from_column_id)?.col ?? null) : null,
          to_table:   tableIdToName.get(r.to_table_id) ?? '',
          to_col:     r.to_column_id   ? (colIdToName.get(r.to_column_id)?.col   ?? null) : null,
        }));

        if (cvRelSnapshots.length) {
          await trx('cross_view_relationships')
            .whereIn('id', cvRelSnapshots.map((r) => r.id))
            .delete();
        }
      }

      const cvTables = await trx('cross_view_tables')
        .whereIn('table_id', existingTableIds)
        .select('view_id', 'table_id', 'pos_x', 'pos_y');

      cvTableSnapshots = cvTables.map((r: { view_id: number; table_id: number; pos_x: number; pos_y: number }) => ({
        view_id:    r.view_id,
        table_name: tableIdToName.get(r.table_id) ?? '',
        pos_x:      r.pos_x,
        pos_y:      r.pos_y,
      }));

      await trx('table_relationships')
        .where(function () {
          this.whereIn('from_table_id', existingTableIds).orWhereIn('to_table_id', existingTableIds);
        })
        .delete();
      await trx('source_columns').whereIn('table_id', existingTableIds).delete();
      await trx('source_tables').whereIn('id', existingTableIds).delete();
    }

    // Re-insert tables and columns. Rows whose description came from the
    // connector's documentation land approved (trusted rung); AI drafts keep
    // the review-queue flow.
    for (const table of schema.tables) {
      const tp = tablePersistByName.get(table.tableName)!;

      const [row] = await trx('source_tables')
        .insert({
          connection_id:   connectionId,
          table_name:      table.tableName,
          display_name:    tp.displayName,
          description:     tp.description,
          is_active:       true,
          ai_draft:        tp.aiDraft,
          semantic_source: tp.semanticSource,
          approval_status: tp.approvalStatus,
          vendor_description: tp.vendorDescription,
          edited_by_user:  tp.editedByUser,
        })
        .returning('id');

      const tableId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
      tableIdMap.set(table.tableName, tableId);
      tablesInserted++;

      for (const srcCol of table.columns) {
        const cp = colPersistByKey.get(`${table.tableName}.${srcCol.name}`)!;

        const [colRow] = await trx('source_columns')
          .insert({
            table_id:        tableId,
            column_name:     srcCol.name,
            data_type:       srcCol.type,
            display_name:    cp.displayName,
            description:     cp.description,
            example_values:  JSON.stringify(srcCol.sampleValues),
            is_dimension:    cp.isDimension,
            is_measure:      cp.isMeasure,
            ai_draft:        cp.aiDraft,
            semantic_source: cp.semanticSource,
            approval_status: cp.approvalStatus,
            vendor_description: cp.vendorDescription,
            edited_by_user:  cp.editedByUser,
          })
          .returning('id');

        const colId: number = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);
        columnIdMap.set(`${table.tableName}.${srcCol.name}`, colId);
        columnsInserted++;
      }
    }

    // Insert relationships from the AI table-context pass.
    const insertedRelKeys = new Set<string>();
    for (const rel of tableContext.relationships) {
      const fromTableId = tableIdMap.get(rel.from_table);
      const toTableId = tableIdMap.get(rel.to_table);
      if (!fromTableId || !toTableId) continue;

      const fromColId = columnIdMap.get(`${rel.from_table}.${rel.via_column}`) ?? null;
      const toColId = columnIdMap.get(`${rel.to_table}.${rel.to_column}`) ?? null;

      const relKey = `${rel.from_table}.${rel.via_column}→${rel.to_table}.${rel.to_column}`;

      // Same rule as the programmatic loop below: a relationship missing either
      // endpoint column cannot express a JOIN. It renders in the catalog as
      // `Table.? → Other.ID` and can never be used or repaired, so it is not a
      // relationship. The columns were resolved from this same run, so a miss
      // means the model named a column that does not exist.
      if (!fromColId || !toColId) {
        log.warn({ rel: relKey, source: 'ai_table_context' }, 'relationship dropped: endpoint column did not resolve');
        continue;
      }

      if (insertedRelKeys.has(relKey)) continue;
      insertedRelKeys.add(relKey);

      // Known/declared relationships go in NOT-draft so they show up
      // immediately as confirmed; AI-only suggestions go in as drafts for
      // user review.
      const isKnown = knownKeys.has(relKey);
      await trx('table_relationships').insert({
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: rel.type,
        description:       rel.reason ?? `${rel.from_table}.${rel.via_column} → ${rel.to_table}.${rel.to_column}`,
        ai_draft:          !isKnown,
      });
      relationshipsInserted++;
    }

    // 5b. Insert any high-confidence programmatic FK candidates not already covered.
    for (const fk of allFkCandidates) {
      if (fk.confidence < 0.7) continue;
      const relKey = `${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`;
      if (insertedRelKeys.has(relKey)) continue;

      const fromTableId = tableIdMap.get(fk.fromTable);
      const toTableId   = tableIdMap.get(fk.toTable);
      if (!fromTableId || !toTableId) continue;

      const fromColId = columnIdMap.get(`${fk.fromTable}.${fk.fromColumn}`) ?? null;
      const toColId   = columnIdMap.get(`${fk.toTable}.${fk.toColumn}`) ?? null;

      // A relationship missing either endpoint column cannot express a JOIN, so
      // it is not a relationship — it is a half-formed row that shows up in the
      // catalog as `Table.? → Other.ID` and can never be used or repaired. The
      // columns were resolved from this same profiling run, so a miss means the
      // candidate named a column that does not exist. Drop it, loudly.
      if (!fromColId || !toColId) {
        log.warn(
          { fk: relKey, source: fk.source },
          'relationship dropped: endpoint column did not resolve',
        );
        continue;
      }

      insertedRelKeys.add(relKey);
      const isKnown = knownKeys.has(relKey);
      await trx('table_relationships').insert({
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: 'many_to_one',
        description:       `${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn} [${fk.source}]`,
        ai_draft:          !isKnown,
      });
      relationshipsInserted++;
    }

    // 5c. Re-apply human-confirmed relationships. A relationship the
    // profiler re-derived gets its confirmation restored; one the profiler
    // did NOT re-derive (e.g. the heuristic changed its mind) is re-inserted
    // — a human said it's real, and humans outrank the pipeline. Endpoints
    // whose tables/columns disappeared are dropped with a log line.
    for (const snap of humanRelSnaps) {
      const fromTableId = tableIdMap.get(snap.from_table);
      const toTableId = tableIdMap.get(snap.to_table);
      if (!fromTableId || !toTableId) {
        log.info(`confirmed relationship ${snap.from_table}→${snap.to_table} references a table that no longer exists — dropped`);
        continue;
      }
      const fromColId = snap.from_column ? (columnIdMap.get(`${snap.from_table}.${snap.from_column}`) ?? null) : null;
      const toColId = snap.to_column ? (columnIdMap.get(`${snap.to_table}.${snap.to_column}`) ?? null) : null;
      if ((snap.from_column && !fromColId) || (snap.to_column && !toColId)) {
        log.info(`confirmed relationship ${snap.from_table}.${snap.from_column}→${snap.to_table}.${snap.to_column} references a column that no longer exists — dropped`);
        continue;
      }
      const existing = await trx('table_relationships')
        .where({ from_table_id: fromTableId, to_table_id: toTableId })
        .where((qb) => { fromColId ? qb.where('from_column_id', fromColId) : qb.whereNull('from_column_id'); })
        .where((qb) => { toColId ? qb.where('to_column_id', toColId) : qb.whereNull('to_column_id'); })
        .first();
      if (existing) {
        await trx('table_relationships').where({ id: existing.id }).update({
          ai_draft: false,
          confirmed_by_user: true,
          relationship_type: snap.relationship_type,
          ...(snap.description ? { description: snap.description } : {}),
        });
      } else {
        await trx('table_relationships').insert({
          from_table_id: fromTableId,
          from_column_id: fromColId,
          to_table_id: toTableId,
          to_column_id: toColId,
          relationship_type: snap.relationship_type,
          description: snap.description ?? `${snap.from_table}.${snap.from_column} → ${snap.to_table}.${snap.to_column} [confirmed by user]`,
          ai_draft: false,
          confirmed_by_user: true,
        });
        relationshipsInserted++;
      }
    }

    // Restore cross_view_tables / cross_view_relationships
    for (const snap of cvTableSnapshots) {
      const newTableId = tableIdMap.get(snap.table_name);
      if (!newTableId) continue;
      await trx('cross_view_tables')
        .insert({ view_id: snap.view_id, table_id: newTableId, pos_x: snap.pos_x, pos_y: snap.pos_y })
        .onConflict()
        .ignore();
    }

    for (const snap of cvRelSnapshots) {
      const fromTableId = tableIdMap.get(snap.from_table);
      const toTableId   = tableIdMap.get(snap.to_table);
      if (!fromTableId || !toTableId) continue;

      const fromColId = snap.from_col
        ? (columnIdMap.get(`${snap.from_table}.${snap.from_col}`) ?? null)
        : null;
      const toColId = snap.to_col
        ? (columnIdMap.get(`${snap.to_table}.${snap.to_col}`) ?? null)
        : null;

      if (snap.from_col && !fromColId) continue;
      if (snap.to_col   && !toColId)   continue;

      await trx('cross_view_relationships').insert({
        view_id:           snap.view_id,
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: snap.relationship_type,
        label:             snap.label,
      });
    }

    const _insertedTableIds = Array.from(tableIdMap.values());
    pgRelsForNeo4j = _insertedTableIds.length
      ? await trx('table_relationships')
          .leftJoin('source_columns as fc', 'table_relationships.from_column_id', 'fc.id')
          .leftJoin('source_columns as tc', 'table_relationships.to_column_id',   'tc.id')
          .whereIn('table_relationships.from_table_id', _insertedTableIds)
          .select(
            'table_relationships.id',
            'table_relationships.from_table_id', 'table_relationships.to_table_id',
            'table_relationships.from_column_id', 'table_relationships.to_column_id',
            'table_relationships.relationship_type',
            'table_relationships.description',
            'fc.column_name as from_col_name',
            'tc.column_name as to_col_name',
          )
      : [];
  });

  // ── Sync to Neo4j ──────────────────────────────────────────────────────
  emit({ phase: 'neo4j', message: `Step 7/7 — Syncing ${schema.tables.length} tables to the knowledge graph for AI context…` });
  try {
    // Mirror the SAME persist values Postgres received (dual-write contract).
    const graphTables: graph.UpsertTableInput[] = schema.tables.map((t) => {
      const ctx = tableContextByName.get(t.tableName);
      const tp = tablePersistByName.get(t.tableName)!;
      return {
        pgId:           tableIdMap.get(t.tableName) ?? 0,
        connectionId,
        tableName:      t.tableName,
        displayName:    tp.displayName,
        description:    tp.description,
        grain:          ctx?.grain ?? null,
        aiDraft:        tp.aiDraft,
        semanticSource: tp.semanticSource,
      };
    }).filter((t) => t.pgId > 0);

    const graphColumns: graph.UpsertColumnInput[] = [];
    for (const t of schema.tables) {
      const tablePgId = tableIdMap.get(t.tableName);
      if (!tablePgId) continue;
      for (const srcCol of t.columns) {
        const cp = colPersistByKey.get(`${t.tableName}.${srcCol.name}`)!;
        const colPgId = columnIdMap.get(`${t.tableName}.${srcCol.name}`);
        if (!colPgId) continue;
        graphColumns.push({
          pgId:           colPgId,
          tablePgId,
          tableName:      t.tableName,
          columnName:     srcCol.name,
          dataType:       srcCol.type,
          displayName:    cp.displayName,
          description:    cp.description,
          exampleValues:  srcCol.sampleValues,
          isDimension:    cp.isDimension,
          isMeasure:      cp.isMeasure,
          aiDraft:        cp.aiDraft,
          semanticSource: cp.semanticSource,
        });
      }
    }

    log.info(`Neo4j sync: ${graphTables.length} tables, ${graphColumns.length} columns, ${pgRelsForNeo4j.length} relationships`);
    const graphRels: graph.UpsertRelationshipInput[] = (pgRelsForNeo4j as {
      id: number; from_table_id: number; to_table_id: number;
      from_column_id: number | null; to_column_id: number | null;
      relationship_type: string; description: string | null;
      from_col_name: string | null; to_col_name: string | null;
    }[]).map((r) => ({
      pgId:          r.id,
      fromTablePgId: r.from_table_id,
      fromColPgId:   r.from_column_id ?? null,
      fromColName:   r.from_col_name  ?? null,
      toTablePgId:   r.to_table_id,
      toColPgId:     r.to_column_id   ?? null,
      toColName:     r.to_col_name    ?? null,
      relType:       r.relationship_type,
      description:   r.description ?? null,
    }));

    await graph.upsertConnectionGraph(graphTables, graphColumns, graphRels, tenantId);

    if (allFkCandidates.length > 0) {
      await graph.saveFkCandidates(
        connectionId,
        allFkCandidates.map((fk) => ({
          fromTable:    fk.fromTable,
          fromColumn:   fk.fromColumn,
          toTable:      fk.toTable,
          toColumn:     fk.toColumn,
          source:       fk.source,
          confidence:   fk.confidence,
          overlapRatio: fk.overlapRatio ?? null,
        })),
      );
    }
  } catch (neo4jErr) {
    log.warn({ err: neo4jErr }, 'Neo4j sync failed (non-fatal)');
  }

  return { connectionId, tablesInserted, columnsInserted, relationshipsInserted };
}

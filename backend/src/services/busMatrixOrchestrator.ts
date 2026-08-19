/**
 * Bus matrix orchestrator — runs the full design + build + transform
 * workflow as a single server-side operation.
 *
 * Usage:
 *   1. From a BullMQ worker: caller wraps progress callbacks to push events
 *      into job.log() / job.updateProgress(); passes an AbortController.signal
 *      so the user can cancel mid-run.
 *   2. From an inline (Redis-not-available) fallback: caller forwards events
 *      directly to an SSE response.
 *
 * Phases:
 *   A. Read schema + relationships → build prompt context.
 *   B. AI call: generateBusMatrixStreaming (cancellable).
 *   C. Validate AI output.
 *   D. Persist to DB (transactional) via buildBusMatrix.
 *   E. Run transformations per product in build_order (cancellable
 *      between products).
 */

import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import { generateBusMatrixStreaming } from '../ai/AIService';
import { buildBusMatrix, validateBusMatrix, recoverIncompleteBusMatrix, BuiltProduct } from './busMatrixBuilder';
import { tryBuildBusMatrixFromTemplate } from './starSchemaTemplates';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

export type OrchestratorEventType =
  | 'phase'      // human-readable phase change
  | 'thinking'   // AI thinking-token delta
  | 'diag'       // diagnostic from the AI streamer
  | 'log'        // arbitrary log line
  | 'designed'   // structured: the design landed — topic list with ids (Build page cards)
  | 'product_start' // structured: product transformation started (Build page card → building)
  | 'product'    // a product finished transforming (with status)
  | 'error_detail' // per-failed-table error (so user can see WHY)
  | 'source_run' // structured: source X has sync_run #N (so dock can drill in)
  | 'done'       // workflow finished successfully
  | 'error';     // workflow failed

/**
 * designed: one entry per data product the design created. Carries ONLY
 * display-facing fields — grouping name, description, counts — never
 * dim_/fact_ table names, because the Build page (the flow's front door)
 * is an outcome-language surface where warehouse vocabulary is forbidden.
 */
export interface DesignedTopic {
  id: number;
  name: string;
  description: string;
  kind: 'analytics' | 'reference';
  tableCount: number;
  buildOrder: number;
}

export interface OrchestratorEvent {
  type: OrchestratorEventType;
  text?: string;
  /**
   * phase only: the same milestone in business language ("Studying your 36
   * tables and how they connect…"). The Build page renders this over `text`;
   * the /products workshop keeps the technical `text`. Optional so every
   * existing consumer and phase emit stays valid.
   */
  friendly?: string;
  productName?: string;
  productId?: number;
  status?: 'ok' | 'error' | 'partial';
  details?: unknown;
  /** designed: the topics the build is about to create (with real ids). */
  topics?: DesignedTopic[];
  /** error_detail: which table inside `productName` failed. */
  tableName?: string;
  /** error_detail: the actual error message (e.g. "Column not found"). */
  error?: string;
  /** source_run: connection id whose sync just got queued. */
  sourceConnectionId?: number;
  /** source_run: source_sync_runs.id — dock fetches detail from this. */
  syncRunId?: number;
}

/**
 * Derive the `designed` event payload from the validated bus matrix and the
 * products Phase D just persisted. Pure on purpose (unit-tested without a
 * DB): products are matched to their grouping by name, a grouping whose
 * product failed to persist is dropped rather than shipped without an id,
 * and `kind` mirrors busMatrixBuilder's rule — no fact tables = reference.
 */
export function designedTopicsFromBusMatrix(
  busMatrix: BusMatrixOutput,
  products: BuiltProduct[],
): DesignedTopic[] {
  const byName = new Map(products.map((p) => [p.name, p]));
  return busMatrix.data_products
    .map((dp): DesignedTopic | null => {
      const built = byName.get(dp.name);
      if (!built) return null;
      return {
        id: built.id,
        name: dp.name,
        description: dp.description ?? '',
        kind: dp.fact_tables.length === 0 ? 'reference' : 'analytics',
        tableCount: dp.fact_tables.length + dp.owned_dimensions.length,
        buildOrder: built.build_order,
      };
    })
    .filter((t): t is DesignedTopic => t !== null)
    .sort((a, b) => a.buildOrder - b.buildOrder);
}

export interface RunBusMatrixWorkflowOptions {
  connectionId: number;
  tenantId: number | undefined;
  userEmail: string | undefined;
  emit: (event: OrchestratorEvent) => void;
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface RunBusMatrixWorkflowResult {
  busMatrix: BusMatrixOutput;
  products: BuiltProduct[];
  allOk: boolean;
}

class CancelledError extends Error {
  constructor() { super('Workflow cancelled by user'); this.name = 'CancelledError'; }
}

async function checkCancelled(opts: RunBusMatrixWorkflowOptions): Promise<void> {
  if (opts.abortSignal?.aborted) throw new CancelledError();
  if (opts.isCancelled && (await opts.isCancelled())) throw new CancelledError();
}

export async function runBusMatrixWorkflow(
  opts: RunBusMatrixWorkflowOptions,
): Promise<RunBusMatrixWorkflowResult> {
  const { connectionId, tenantId, emit } = opts;

  // ── Phase A: read schema + relationships ─────────────────────────────
  emit({ type: 'phase', text: 'Reading schema…', friendly: 'Reading what your source contains…' });

  if (tenantId) await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  const connection = await semanticDb('connections').where({ id: connectionId }).first();
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const sourceTables = await semanticDb('source_tables as st')
    .where({ 'st.connection_id': connectionId, 'st.is_active': true })
    .select('st.*');

  // ── Phase A.5: deterministic connector template ──────────────────────
  // "Documentation before inference" (docs/SOURCE_ONBOARDING.md Phase F):
  // connectors that ship a star-schema template skip the AI design phases
  // entirely — same design for every customer, instant and token-free. The
  // AI designer below remains the fallback (no template / template doesn't
  // cover the synced entities / STAR_SCHEMA_TEMPLATES_DISABLED=1).
  const templateHit = tryBuildBusMatrixFromTemplate(
    (connection.connector_type as string | null) ?? null,
    sourceTables.map((t: { table_name: string }) => t.table_name),
  );

  let busMatrix: BusMatrixOutput;
  let templateVersion: number | undefined;

  if (templateHit) {
    busMatrix = templateHit.busMatrix;
    templateVersion = templateHit.templateVersion;
    emit({
      type: 'phase',
      text: `Using the built-in ${connection.connector_type} star-schema template v${templateHit.templateVersion} — deterministic design, no AI needed (${busMatrix.conformed_dimensions.length} dimensions, ${busMatrix.fact_tables.length} fact tables)`,
      friendly: `Using the ready-made design for ${connection.name} — your topics are already worked out.`,
    });
  } else {
    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await semanticDb('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    // Ground the design in what actually synced: the latest measured row
    // count per table. dataset_profiles is written by quality profiling
    // during Analyse with a real COUNT(*) — accurate as of the last
    // analysis, which is what the annotation says. Best-effort on purpose:
    // a structural-only Analyse leaves no profiles, and an unknown count
    // simply gets no annotation. Without this the designer works from
    // schema + descriptions alone and happily builds a fact on entities
    // that hold no data (the 2026-08-19 fact_sales_pipeline case).
    const rowCountByTable = new Map<string, number>();
    try {
      const profileQuery = semanticDb('dataset_profiles')
        .where({ connection_id: connectionId })
        .whereNotNull('row_count')
        .orderBy('profiled_at', 'asc')
        .select('table_name', 'row_count');
      if (tenantId) profileQuery.andWhere('tenant_id', Number(tenantId));
      const profileRows = await profileQuery;
      // Ascending order → the latest profile per table wins the map slot.
      for (const r of profileRows as Array<{ table_name: string; row_count: number }>) {
        rowCountByTable.set(r.table_name, Number(r.row_count));
      }
    } catch (err) {
      emit({ type: 'log', text: `Row-count context skipped: ${err instanceof Error ? err.message : String(err)}` });
    }

    const tablesText = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) => {
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`;
        }).join('\n');
      const rc = rowCountByTable.get(t.table_name);
      const rcNote = rc === undefined
        ? ''
        : rc === 0
          ? ' [NO ROWS at last analysis — this table is empty]'
          : ` [~${rc} rows at last analysis]`;
      return `Table: ${t.table_name}${rcNote} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    let relationshipsText = '';
    let relCount = 0;
    try {
      const { getRelationshipsForContext } = await import('../db/semanticGraph');
      const rels = await getRelationshipsForContext(connectionId);
      if (rels.length > 0) {
        const lines = rels.map((r) => {
          const from = `${r.from_table as string}.${r.from_column as string}`;
          const to = `${r.to_table as string}.${r.to_column as string}`;
          const type = (r.relationship_type as string) || 'RELATES_TO';
          const desc = (r.description as string) ? ` — ${r.description as string}` : '';
          return `  ${from} → ${to} (${type})${desc}`;
        }).join('\n');
        relationshipsText = `\n\nCONFIRMED FOREIGN KEY RELATIONSHIPS (use these for fact↔dim joins — do NOT invent join columns):\n${lines}`;
        relCount = rels.length;
      }
    } catch (err) {
      emit({ type: 'log', text: `Failed to load Neo4j relationships: ${err instanceof Error ? err.message : String(err)}` });
    }

    const sourceContext = tablesText + relationshipsText;

    emit({
      type: 'phase',
      text: `Loaded ${sourceTables.length} tables, ${relCount} relationships — designing bus matrix…`,
      friendly: `Studying your ${sourceTables.length} tables and how they connect — working out the topics they can answer…`,
    });

    await checkCancelled(opts);

    // ── Phase B: AI design (cancellable) ───────────────────────────────
    busMatrix = await generateBusMatrixStreaming(
      connection.name as string,
      sourceContext,
      (type, delta) => {
        if (type === 'thinking') emit({ type: 'thinking', text: delta });
        else if (type === 'diag') emit({ type: 'diag', text: delta });
      },
      opts.abortSignal,
    );

    await checkCancelled(opts);

    // ── Phase C (AI path only): recover truncated output ───────────────
    // If the AI output was truncated and JSON-repair stripped
    // data_products / relationships / etc., synthesize sensible defaults so
    // the user doesn't lose the 5-10 min of dim/fact design they paid for.
    const recovery = recoverIncompleteBusMatrix(busMatrix);
    if (recovery.recovered) {
      emit({ type: 'log', text: `AI output was truncated — recovered with: ${recovery.notes.join('; ')}` });
    }
  }

  // ── Phase C: validate (template and AI output alike) ─────────────────
  const validationErrors = validateBusMatrix(busMatrix);
  if (validationErrors.length > 0) {
    throw new Error(`Bus matrix validation failed: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  emit({
    type: 'phase',
    text: `Saving ${busMatrix.conformed_dimensions.length} dimensions and ${busMatrix.fact_tables.length} fact tables…`,
    friendly: 'Design ready — setting up your topics…',
  });

  // ── Phase D: persist ─────────────────────────────────────────────────
  const { products } = await buildBusMatrix({
    connectionId,
    tenantId,
    userEmail: opts.userEmail,
    busMatrix,
    templateVersion,
  });

  emit({ type: 'log', text: `Created ${products.length} data product(s)` });

  // Structured topic list for the Build page's materializing cards. Emitted
  // AFTER persist on purpose: the cards deep-link by product id, so the ids
  // must be real. Rides the job log like every other event, which is what
  // makes reattach work — a browser landing mid-build replays this and
  // rebuilds the cards.
  emit({ type: 'designed', topics: designedTopicsFromBusMatrix(busMatrix, products) });

  // ── Phase D.5: generate per-product line-icon SVGs (parallel, best-effort) ──
  emit({ type: 'phase', text: 'Designing product icons…', friendly: 'Drawing an icon for each topic…' });
  try {
    const { generateProductIcon } = await import('../ai/AIService');
    await Promise.all(products.map(async (p) => {
      try {
        const row = await tenantQuery(tenantId, (trx) =>
          trx('data_products').where({ id: p.id }).first()
        );
        const svg = await generateProductIcon(p.name, row?.description as string | undefined);
        if (svg) {
          await tenantQuery(tenantId, (trx) =>
            trx('data_products').where({ id: p.id }).update({ icon_svg: svg })
          );
          emit({ type: 'log', text: `  Icon ready for "${p.name}"` });
        }
      } catch (iconErr) {
        emit({ type: 'log', text: `  Icon failed for "${p.name}": ${iconErr instanceof Error ? iconErr.message : 'unknown'}` });
      }
    }));
  } catch (err) {
    emit({ type: 'log', text: `Icon generation skipped: ${err instanceof Error ? err.message : 'unknown'}` });
  }

  await checkCancelled(opts);

  // ── Phase E: run transformations per product in build_order ──────────
  emit({ type: 'phase', text: 'Running transformations…', friendly: 'Building the data behind your topics…' });

  const sortedProducts = [...products].sort((a, b) => a.build_order - b.build_order);
  const { runProductTransformation } = await import('./transformationRunner');

  let allOk = true;

  for (const p of sortedProducts) {
    await checkCancelled(opts);
    emit({ type: 'log', text: `  Running "${p.name}"…` });
    // Structured twin of the log line above — flips the Build page's card
    // for this topic to "building" without string-matching log text.
    emit({ type: 'product_start', productName: p.name, productId: p.id });

    try {
      // Read every row through tenantQuery — the orchestrator runs in a
      // BullMQ worker (no per-request middleware), and knex's connection
      // pool can route subsequent queries to a different connection than
      // the one that received the initial `SET app.current_tenant`. When
      // that happens, RLS hides every row and `.first()` returns
      // undefined → the transformation runner crashes reading
      // `product.connection_id`. tenantQuery wraps each query in a short
      // transaction with `SET LOCAL app.current_tenant` so RLS sees the
      // right tenant regardless of pool dynamics.
      const product = await tenantQuery(tenantId, (trx) =>
        trx('data_products').where({ id: p.id }).first()
      );
      const schemas = await tenantQuery(tenantId, (trx) =>
        trx('star_schemas').where({ data_product_id: p.id })
      );
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      const tables = schemaIds.length
        ? await tenantQuery(tenantId, (trx) =>
            trx('product_tables')
              .whereIn('star_schema_id', schemaIds)
              .whereNotNull('transformation_sql')
              .orderBy('dag_order', 'asc')
          )
        : [];

      if (!product) {
        // Defensive: even with tenantQuery, surface the missing-row case
        // as a clear error instead of a JS TypeError. Should not happen
        // after the RLS fix; here as a load-bearing assertion.
        throw new Error(`Product ${p.id} ("${p.name}") was inserted in Phase D but cannot be read in Phase E — RLS or transaction visibility issue.`);
      }

      const results = await runProductTransformation(product, tables, tenantId);

      if (Array.isArray(results)) {
        const failed = results.filter((r: { status: string }) => r.status === 'error');
        if (failed.length > 0) {
          emit({ type: 'product', productName: p.name, productId: p.id, status: 'partial', text: `${results.length - failed.length} ok, ${failed.length} failed` });
          // Surface each failure so the user can SEE what broke. Without
          // this the UI just says "0 ok, 2 failed" with no path to a fix.
          for (const f of failed as Array<{ table_name: string; error?: string }>) {
            emit({
              type: 'error_detail',
              productName: p.name,
              productId: p.id,
              tableName: f.table_name,
              error: f.error ?? 'Unknown error',
            });
          }
          allOk = false;
        } else {
          emit({ type: 'product', productName: p.name, productId: p.id, status: 'ok', text: `all ${results.length} tables ok` });
        }
      } else {
        emit({ type: 'product', productName: p.name, productId: p.id, status: 'ok', text: 'done' });
      }

      // Sync to Neo4j (non-blocking)
      try {
        const { syncProductToNeo4j } = await import('./productGraphSync');
        syncProductToNeo4j(p.id).catch(() => { /* non-fatal */ });
      } catch { /* ignore */ }
    } catch (runErr) {
      const msg = runErr instanceof Error ? runErr.message : 'Run failed';
      emit({ type: 'product', productName: p.name, productId: p.id, status: 'error', text: msg });
      allOk = false;
    }
  }

  emit({ type: 'done', text: allOk ? 'All done!' : 'Build completed with some errors.' });

  return { busMatrix, products, allOk };
}

export { CancelledError };

// ---------------------------------------------------------------------------
// Pipeline workflow — runs a resolved scope (sources + products in topo order).
//
// Phases:
//   1. Sync each source in scope (parallel, since sources don't depend on
//      each other). Failures are reported but don't halt the pipeline —
//      products that depended on a failed source will fail downstream;
//      products independent of it still run.
//   2. Transform products in topological order. Failures are reported per
//      table (via error_detail events) but don't halt the pipeline —
//      independent products still run.
//
// Reuses `runProductTransformation` and `triggerSync` so all the existing
// FK detection / value-overlap / per-table error semantics flow through
// unchanged.
// ---------------------------------------------------------------------------

export interface RunPipelineWorkflowOptions {
  scope: { sourceIds: number[]; productIds: number[]; shouldSyncSources: boolean };
  pipelineRunId?: number;
  tenantId: number;
  userEmail?: string;
  emit: (event: OrchestratorEvent) => void;
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface RunPipelineWorkflowResult {
  allOk: boolean;
  sourceResults: Array<{ sourceId: number; status: 'succeeded' | 'failed' | 'skipped'; error?: string }>;
  productResults: Array<{ productId: number; productName: string; allOk: boolean; failedTables: number; totalTables: number }>;
}

async function checkPipelineCancelled(opts: RunPipelineWorkflowOptions): Promise<void> {
  if (opts.abortSignal?.aborted) throw new CancelledError();
  if (opts.isCancelled && (await opts.isCancelled())) throw new CancelledError();
}

async function waitForSyncRun(
  syncRunId: number,
  tenantId: number,
  opts: RunPipelineWorkflowOptions,
): Promise<{ status: string; error_message: string | null }> {
  const POLL_MS = 3_000;
  const TIMEOUT_MS = 30 * 60 * 1000;
  const start = Date.now();
  while (true) {
    await checkPipelineCancelled(opts);
    const row = await semanticDb('source_sync_runs')
      .where({ id: syncRunId, tenant_id: tenantId })
      .first();
    if (!row) throw new Error(`Sync run ${syncRunId} not found`);
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      return { status: row.status, error_message: row.error_message };
    }
    if (Date.now() - start > TIMEOUT_MS) throw new Error('Source sync timed out after 30 min');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function runPipelineWorkflow(
  opts: RunPipelineWorkflowOptions,
): Promise<RunPipelineWorkflowResult> {
  const { scope, tenantId, emit, pipelineRunId } = opts;

  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  if (pipelineRunId) {
    await semanticDb('pipeline_runs')
      .where({ id: pipelineRunId, tenant_id: tenantId })
      .update({ status: 'running', started_at: new Date().toISOString() });
  }

  const sourceResults: RunPipelineWorkflowResult['sourceResults'] = [];
  const productResults: RunPipelineWorkflowResult['productResults'] = [];

  // ── Phase 1 — source syncs (parallel) ────────────────────────────────
  if (scope.shouldSyncSources && scope.sourceIds.length > 0) {
    emit({ type: 'phase', text: `Syncing ${scope.sourceIds.length} source${scope.sourceIds.length === 1 ? '' : 's'}…` });

    const { triggerSync } = await import('../orchestrator/SyncOrchestrator');
    const syncs = await Promise.all(
      scope.sourceIds.map(async (sourceId) => {
        try {
          const conn = await semanticDb('connections').where({ id: sourceId }).first();
          if (!conn?.connector_type) {
            emit({ type: 'log', text: `  ${conn?.name ?? sourceId}: skipped (not a source-connector)` });
            return { sourceId, status: 'skipped' as const };
          }
          emit({ type: 'log', text: `  ${conn.name}: queueing sync…` });
          const triggered = await triggerSync({
            connectionId: sourceId,
            tenantId: Number(tenantId),
            // Omit triggeredByUserId: source_sync_runs.triggered_by_user_id
            // is a FK to users.id — passing 0 violates it. Audit attribution
            // for pipeline-driven syncs lives on pipeline_runs.triggered_by.
            triggeredByUserId: undefined,
          });
          const syncRunId = (triggered as { syncRunId?: number }).syncRunId;
          if (!syncRunId) {
            emit({ type: 'log', text: `  ${conn.name}: no syncRunId returned — skipping` });
            return { sourceId, status: 'skipped' as const };
          }
          // Structured event so the dock can pin the sync_run_id to this
          // source node and let the user expand for live row_counts.
          emit({ type: 'source_run', sourceConnectionId: sourceId, syncRunId });
          // We MUST poll. In LocalProcessJobLauncher mode triggerSync
          // resolves only when the worker exits (so a single read would
          // also work) — but in AzureContainerAppsJobLauncher mode
          // triggerSync returns as soon as the Container Apps Job is
          // queued, with the row still in 'running'. Without polling we'd
          // mismark the source as failed every time.
          const final = await waitForSyncRun(syncRunId, Number(tenantId), opts);
          if (final.status === 'succeeded') {
            emit({ type: 'log', text: `  ${conn.name}: sync OK` });
            return { sourceId, status: 'succeeded' as const };
          }
          if (final.status === 'cancelled') throw new CancelledError();
          emit({ type: 'error_detail', tableName: conn.name, error: final.error_message ?? 'Sync failed' });
          return { sourceId, status: 'failed' as const, error: final.error_message ?? 'Sync failed' };
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          const msg = err instanceof Error ? err.message : 'Sync failed';
          emit({ type: 'error_detail', tableName: `source:${sourceId}`, error: msg });
          return { sourceId, status: 'failed' as const, error: msg };
        }
      }),
    );
    sourceResults.push(...syncs);
  }

  await checkPipelineCancelled(opts);

  // ── Phase 2 — product transformations (topological order) ────────────
  if (scope.productIds.length > 0) {
    const { topoSortProducts } = await import('./pipelineService');
    const ordered = await topoSortProducts(scope.productIds);
    emit({ type: 'phase', text: `Running ${ordered.length} product${ordered.length === 1 ? '' : 's'}…` });

    // Disambiguate duplicate product names in the log. Real-world hit: a
    // tenant with two source connections (EO + wholesale_erp) ends up with
    // two products called "Sales" / "Reference". Without the source suffix
    // the log says `Running "Sales"…` twice with no way to tell apart
    // which product just failed. Build a name → connection map up front so
    // we only suffix when we actually have a collision.
    const orderedRows = await semanticDb('data_products')
      .whereIn('id', ordered)
      .select<{ id: number; name: string; connection_id: number | null }[]>('id', 'name', 'connection_id');
    const nameCount = new Map<string, number>();
    for (const r of orderedRows) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
    const connIds = Array.from(new Set(orderedRows.map((r) => r.connection_id).filter((x): x is number => !!x)));
    const connNameById = new Map<number, string>();
    if (connIds.length > 0) {
      const conns = await semanticDb('connections').whereIn('id', connIds).select('id', 'name');
      for (const c of conns as { id: number; name: string }[]) connNameById.set(c.id, c.name);
    }
    const displayNameById = new Map<number, string>();
    for (const r of orderedRows) {
      const ambiguous = (nameCount.get(r.name) ?? 0) > 1;
      const connName = r.connection_id != null ? connNameById.get(r.connection_id) : null;
      displayNameById.set(r.id, ambiguous && connName ? `${r.name} (${connName})` : r.name);
    }

    const { runProductTransformation } = await import('./transformationRunner');
    for (const pid of ordered) {
      await checkPipelineCancelled(opts);
      // Same RLS guard as Phase E in runBusMatrixWorkflow — tenantQuery
      // wrappers required for worker-context reads.
      const product = await tenantQuery(tenantId, (trx) =>
        trx('data_products').where({ id: pid }).first()
      );
      if (!product) {
        productResults.push({ productId: pid, productName: `#${pid}`, allOk: false, failedTables: 0, totalTables: 0 });
        continue;
      }
      const dispName = displayNameById.get(pid) ?? product.name;
      emit({ type: 'log', text: `  Running "${dispName}"…` });

      const schemas = await tenantQuery(tenantId, (trx) =>
        trx('star_schemas').where({ data_product_id: pid })
      );
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      const tables = schemaIds.length
        ? await tenantQuery(tenantId, (trx) =>
            trx('product_tables')
              .whereIn('star_schema_id', schemaIds)
              .whereNotNull('transformation_sql')
              .orderBy('dag_order', 'asc')
          )
        : [];

      try {
        const results = await runProductTransformation(product, tables, tenantId);
        const failed = results.filter((r) => r.status === 'error');
        const allOk = failed.length === 0;
        if (failed.length > 0) {
          emit({
            type: 'product',
            productName: dispName,
            productId: pid,
            status: 'partial',
            text: `${results.length - failed.length} ok, ${failed.length} failed`,
          });
          for (const f of failed) {
            emit({
              type: 'error_detail',
              productName: dispName,
              productId: pid,
              tableName: f.table_name,
              error: f.error ?? 'Unknown error',
            });
          }
        } else {
          emit({
            type: 'product',
            productName: dispName,
            productId: pid,
            status: 'ok',
            text: `all ${results.length} tables ok`,
          });
        }
        productResults.push({
          productId: pid, productName: dispName,
          allOk, failedTables: failed.length, totalTables: results.length,
        });

        // Sync to Neo4j (non-blocking)
        try {
          const { syncProductToNeo4j } = await import('./productGraphSync');
          syncProductToNeo4j(pid).catch(() => { /* non-fatal */ });
        } catch { /* ignore */ }
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const msg = err instanceof Error ? err.message : 'Run failed';
        emit({ type: 'product', productName: dispName, productId: pid, status: 'error', text: msg });
        productResults.push({
          productId: pid, productName: dispName,
          allOk: false, failedTables: 0, totalTables: 0,
        });
      }
    }
  }

  const allOk = sourceResults.every((s) => s.status !== 'failed') && productResults.every((p) => p.allOk);
  emit({ type: 'done', text: allOk ? 'All done!' : 'Pipeline completed with some errors.' });

  if (pipelineRunId) {
    await semanticDb('pipeline_runs')
      .where({ id: pipelineRunId, tenant_id: tenantId })
      .update({
        status: allOk ? 'succeeded' : (productResults.length === 0 && sourceResults.every((s) => s.status === 'failed') ? 'failed' : 'partial'),
        completed_at: new Date().toISOString(),
        node_results: JSON.stringify({ sources: sourceResults, products: productResults }),
      });
  }

  return { allOk, sourceResults, productResults };
}

// ---------------------------------------------------------------------------
// Product refresh workflow — re-run a single product's transformations,
// optionally syncing the source connection upstream first.
//
// Reuses the same OrchestratorEvent stream so the existing SSE / cancel /
// active-job endpoints work for both modes without changes.
// ---------------------------------------------------------------------------

export interface RunProductRefreshWorkflowOptions {
  productId: number;
  tenantId: number | undefined;
  userEmail: string | undefined;
  emit: (event: OrchestratorEvent) => void;
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean | Promise<boolean>;
  /** When true, trigger source connection sync first and wait for completion. */
  syncSource?: boolean;
}

export interface RunProductRefreshWorkflowResult {
  productId: number;
  productName: string;
  allOk: boolean;
  results: Array<{ table_name: string; status: 'success' | 'error'; row_count?: number; error?: string }>;
}

async function checkRefreshCancelled(opts: RunProductRefreshWorkflowOptions): Promise<void> {
  if (opts.abortSignal?.aborted) throw new CancelledError();
  if (opts.isCancelled && (await opts.isCancelled())) throw new CancelledError();
}

/**
 * Wait for a source-sync run to reach a terminal state. Polls
 * `source_sync_runs` every 3s. Honours cancellation. The orchestrator
 * caller already emits a heartbeat phase before calling this — we just
 * emit log lines on status changes.
 */
async function waitForSourceSync(
  syncRunId: number,
  tenantId: number,
  opts: RunProductRefreshWorkflowOptions,
): Promise<{ status: string; warnings: unknown; error_message: string | null }> {
  const POLL_MS = 3_000;
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap
  const start = Date.now();
  let lastStatus = '';
  while (true) {
    await checkRefreshCancelled(opts);
    const row = await semanticDb('source_sync_runs')
      .where({ id: syncRunId, tenant_id: tenantId })
      .first();
    if (!row) throw new Error(`Sync run ${syncRunId} not found`);
    if (row.status !== lastStatus) {
      lastStatus = row.status;
      opts.emit({ type: 'log', text: `  Source sync: ${row.status}` });
    }
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      return { status: row.status, warnings: row.warnings, error_message: row.error_message };
    }
    if (Date.now() - start > TIMEOUT_MS) {
      throw new Error('Source sync timed out after 30 minutes');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function runProductRefreshWorkflow(
  opts: RunProductRefreshWorkflowOptions,
): Promise<RunProductRefreshWorkflowResult> {
  const { productId, tenantId, emit, syncSource } = opts;

  // SET app.current_tenant on a single pooled connection is unreliable —
  // knex may route subsequent queries to a different connection where
  // RLS will hide every row. Use tenantQuery for each read instead.
  const product = await tenantQuery(tenantId, (trx) =>
    trx('data_products').where({ id: productId }).first()
  );
  if (!product) throw new Error(`Product ${productId} not found`);

  emit({ type: 'log', text: `Refreshing "${product.name}"…` });

  // ── Phase A: optional source sync ────────────────────────────────────
  if (syncSource) {
    if (!product.connection_id) {
      emit({ type: 'log', text: 'Skipping source sync: product is not pinned to a connection.' });
    } else {
      emit({ type: 'phase', text: 'Syncing source data…' });
      try {
        const { triggerSync } = await import('../orchestrator/SyncOrchestrator');
        const triggered = await triggerSync({
          connectionId: Number(product.connection_id),
          tenantId: Number(tenantId),
          // Omit triggeredByUserId — passing 0 would violate the FK on
          // source_sync_runs.triggered_by_user_id → users.id.
          triggeredByUserId: undefined,
        });
        const syncRunId = (triggered as { syncRunId?: number }).syncRunId;
        if (!syncRunId) throw new Error('Source sync did not return a syncRunId');
        emit({ type: 'log', text: `  Source sync queued (run #${syncRunId})…` });
        // Must poll: in Azure mode triggerSync returns when the
        // Container Apps Job is queued, not when it completes. Polling
        // until terminal status is the only correct path.
        const final = await waitForSourceSync(syncRunId, Number(tenantId), opts);
        if (final.status === 'failed') {
          throw new Error(`Source sync failed: ${final.error_message ?? 'unknown'}`);
        }
        if (final.status === 'cancelled') {
          throw new CancelledError();
        }
        emit({ type: 'log', text: '  Source sync complete' });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const msg = err instanceof Error ? err.message : 'Source sync failed';
        emit({ type: 'error', text: msg });
        return {
          productId,
          productName: product.name,
          allOk: false,
          results: [],
        };
      }
    }
  }

  await checkRefreshCancelled(opts);

  // ── Phase B: run product transformations ─────────────────────────────
  emit({ type: 'phase', text: 'Running transformations…' });
  emit({ type: 'log', text: `  Running "${product.name}"…` });

  const schemas = await tenantQuery(tenantId, (trx) =>
    trx('star_schemas').where({ data_product_id: productId })
  );
  const schemaIds = schemas.map((s: { id: number }) => s.id);
  const tables = schemaIds.length
    ? await tenantQuery(tenantId, (trx) =>
        trx('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .whereNotNull('transformation_sql')
          .orderBy('dag_order', 'asc')
      )
    : [];

  const { runProductTransformation } = await import('./transformationRunner');
  const results = await runProductTransformation(product, tables, tenantId);

  const failed = results.filter((r) => r.status === 'error');
  const allOk = failed.length === 0;
  if (failed.length > 0) {
    emit({
      type: 'product',
      productName: product.name,
      productId,
      status: 'partial',
      text: `${results.length - failed.length} ok, ${failed.length} failed`,
    });
    for (const f of failed) {
      emit({
        type: 'error_detail',
        productName: product.name,
        productId,
        tableName: f.table_name,
        error: f.error ?? 'Unknown error',
      });
    }
  } else {
    emit({
      type: 'product',
      productName: product.name,
      productId,
      status: 'ok',
      text: `all ${results.length} tables ok`,
    });
  }

  // Sync to Neo4j (non-blocking)
  try {
    const { syncProductToNeo4j } = await import('./productGraphSync');
    syncProductToNeo4j(productId).catch(() => { /* non-fatal */ });
  } catch { /* ignore */ }

  emit({ type: 'done', text: allOk ? 'All done!' : 'Refresh completed with some errors.' });

  return { productId, productName: product.name, allOk, results };
}

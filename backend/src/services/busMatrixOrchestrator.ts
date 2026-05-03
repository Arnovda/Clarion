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
import { generateBusMatrixStreaming } from '../ai/AIService';
import { buildBusMatrix, validateBusMatrix, BuiltProduct } from './busMatrixBuilder';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

export type OrchestratorEventType =
  | 'phase'      // human-readable phase change
  | 'thinking'   // AI thinking-token delta
  | 'diag'       // diagnostic from the AI streamer
  | 'log'        // arbitrary log line
  | 'product'    // a product finished transforming (with status)
  | 'error_detail' // per-failed-table error (so user can see WHY)
  | 'done'       // workflow finished successfully
  | 'error';     // workflow failed

export interface OrchestratorEvent {
  type: OrchestratorEventType;
  text?: string;
  productName?: string;
  productId?: number;
  status?: 'ok' | 'error' | 'partial';
  details?: unknown;
  /** error_detail: which table inside `productName` failed. */
  tableName?: string;
  /** error_detail: the actual error message (e.g. "Column not found"). */
  error?: string;
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
  emit({ type: 'phase', text: 'Reading schema…' });

  if (tenantId) await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  const connection = await semanticDb('connections').where({ id: connectionId }).first();
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const sourceTables = await semanticDb('source_tables as st')
    .where({ 'st.connection_id': connectionId, 'st.is_active': true })
    .select('st.*');

  const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
  const sourceColumns = sourceTableIds.length
    ? await semanticDb('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
    : [];

  const tablesText = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
    const cols = sourceColumns
      .filter((c: { table_id: number }) => c.table_id === t.id)
      .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) => {
        return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`;
      }).join('\n');
    return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
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

  emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables, ${relCount} relationships — designing bus matrix…` });

  await checkCancelled(opts);

  // ── Phase B: AI design (cancellable) ─────────────────────────────────
  const busMatrix = await generateBusMatrixStreaming(
    connection.name as string,
    sourceContext,
    (type, delta) => {
      if (type === 'thinking') emit({ type: 'thinking', text: delta });
      else if (type === 'diag') emit({ type: 'diag', text: delta });
    },
    opts.abortSignal,
  );

  await checkCancelled(opts);

  // ── Phase C: validate ────────────────────────────────────────────────
  const validationErrors = validateBusMatrix(busMatrix);
  if (validationErrors.length > 0) {
    throw new Error(`Bus matrix validation failed: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  emit({
    type: 'phase',
    text: `Saving ${busMatrix.conformed_dimensions.length} dimensions and ${busMatrix.fact_tables.length} fact tables…`,
  });

  // ── Phase D: persist ─────────────────────────────────────────────────
  const { products } = await buildBusMatrix({
    connectionId,
    tenantId,
    userEmail: opts.userEmail,
    busMatrix,
  });

  emit({ type: 'log', text: `Created ${products.length} data product(s)` });

  // ── Phase D.5: generate per-product line-icon SVGs (parallel, best-effort) ──
  emit({ type: 'phase', text: 'Designing product icons…' });
  try {
    const { generateProductIcon } = await import('../ai/AIService');
    await Promise.all(products.map(async (p) => {
      try {
        const row = await semanticDb('data_products').where({ id: p.id }).first();
        const svg = await generateProductIcon(p.name, row?.description as string | undefined);
        if (svg) {
          await semanticDb('data_products').where({ id: p.id }).update({ icon_svg: svg });
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
  emit({ type: 'phase', text: 'Running transformations…' });

  const sortedProducts = [...products].sort((a, b) => a.build_order - b.build_order);
  const { runProductTransformation } = await import('./transformationRunner');

  let allOk = true;

  for (const p of sortedProducts) {
    await checkCancelled(opts);
    emit({ type: 'log', text: `  Running "${p.name}"…` });

    try {
      const product = await semanticDb('data_products').where({ id: p.id }).first();
      const schemas = await semanticDb('star_schemas').where({ data_product_id: p.id });
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      const tables = schemaIds.length
        ? await semanticDb('product_tables')
            .whereIn('star_schema_id', schemaIds)
            .whereNotNull('transformation_sql')
            .orderBy('dag_order', 'asc')
        : [];

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

  if (tenantId) await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  const product = await semanticDb('data_products').where({ id: productId }).first();
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
          triggeredByUserId: 0, // refresh job — no specific user id needed
        });
        const syncRunId = (triggered as { syncRunId?: number }).syncRunId;
        if (!syncRunId) throw new Error('Source sync did not return a syncRunId');
        emit({ type: 'log', text: `  Source sync queued (run #${syncRunId})…` });
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

  const schemas = await semanticDb('star_schemas').where({ data_product_id: productId });
  const schemaIds = schemas.map((s: { id: number }) => s.id);
  const tables = schemaIds.length
    ? await semanticDb('product_tables')
        .whereIn('star_schema_id', schemaIds)
        .whereNotNull('transformation_sql')
        .orderBy('dag_order', 'asc')
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

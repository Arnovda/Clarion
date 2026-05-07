/**
 * Refine Service — orchestrates the per-product chat:
 *
 *   1. Gather product context (tables, columns, KPIs, recent customizations)
 *   2. Call the AI to classify intent + generate a structured proposal
 *   3. Persist the proposal as a `pending` row in product_customizations
 *   4. On approve: dispatch to the right apply handler (add_column /
 *      modify_column / add_kpi) and update the row to `applied`
 *   5. On reject: update the row to `rejected`
 *
 * The chat is the single conversation per product. Team-visible —
 * every user sees the same log. Customizations are append-only; no
 * edit-after-the-fact (would lose audit trail).
 */

import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import { logger } from '../utils/logger';
import {
  type RefineChatProductContext,
  type ProposalPayload,
  type AddColumnPayload,
  type ModifyColumnPayload,
  type AddKpiPayload,
} from '../ai/prompts/refineChatPrompt';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RefinementRow {
  id: number;
  data_product_id: number;
  product_table_id: number | null;
  user_message: string;
  user_id: number | null;
  user_name: string | null;
  intent: string;
  intent_confidence: string;
  intent_reasoning: string | null;
  proposal: ProposalPayload;
  summary: string | null;
  status: 'pending' | 'approved' | 'applied' | 'rejected' | 'failed';
  decided_at: string | null;
  decided_by_user_id: number | null;
  decided_by_user_name: string | null;
  apply_error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Context gathering — pulls everything the AI needs in one tenant-scoped pass
// ---------------------------------------------------------------------------

export async function buildRefineContext(
  tenantId: number,
  productId: number,
  focusedTableId: number | null,
): Promise<RefineChatProductContext | null> {
  return tenantQuery(tenantId, async (trx) => {
    const product = await trx('data_products').where({ id: productId }).first();
    if (!product) return null;

    // ── Product layer ────────────────────────────────────────────────────
    const tables = await trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .where('ss.data_product_id', productId)
      .select('pt.id', 'pt.table_name', 'pt.table_role', 'pt.transformation_sql')
      .orderBy(['pt.dag_order', 'pt.table_name']);

    const tableIds = tables.map((t) => Number(t.id));
    const columns = tableIds.length > 0
      ? await trx('product_columns')
          .whereIn('product_table_id', tableIds)
          // Hide technical columns (`_row_hash`; future SCD2 metadata) from
          // refine prompts so Claude doesn't try to modify or describe them.
          .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
          .orderBy(['product_table_id', 'sort_order'])
          .select('id', 'product_table_id', 'column_name', 'data_type',
                  'column_role', 'description', 'transformation_expression')
      : [];

    const colsByTable = new Map<number, typeof columns>();
    for (const c of columns) {
      const list = colsByTable.get(Number(c.product_table_id)) ?? [];
      list.push(c);
      colsByTable.set(Number(c.product_table_id), list);
    }

    // ── Lineage (which source col fed each product col) ──────────────────
    const productColIds = columns.map((c) => Number(c.id));
    const lineage = productColIds.length > 0
      ? await trx('column_lineage')
          .whereIn('product_column_id', productColIds)
          .select('product_column_id', 'source_table_name', 'source_column_name')
      : [];
    const lineageByCol = new Map<number, Array<{ sourceTable: string; sourceColumn: string }>>();
    for (const l of lineage) {
      const list = lineageByCol.get(Number(l.product_column_id)) ?? [];
      list.push({
        sourceTable:  String(l.source_table_name),
        sourceColumn: String(l.source_column_name),
      });
      lineageByCol.set(Number(l.product_column_id), list);
    }

    // ── Source layer ─────────────────────────────────────────────────────
    // Includes the product's own connection plus every dependency product's
    // connection (so cross-product asks like "join in the customer name
    // from the Reference product's source" have the right schema).
    const ownConnId = Number(product.connection_id);
    const depConnIds = await trx('data_product_dependencies as dpd')
      .join('data_products as dp', 'dpd.source_product_id', 'dp.id')
      .where('dpd.dependent_product_id', productId)
      .pluck('dp.connection_id');
    const allConnIds = Array.from(new Set([ownConnId, ...depConnIds.map((id) => Number(id))]))
      .filter((id) => Number.isFinite(id));

    const sourceConnections = await loadSourceSchemas(trx, allConnIds);

    // ── KPIs + recent customizations ─────────────────────────────────────
    const kpiNames = await trx('product_kpis')
      .where({ data_product_id: productId })
      .pluck<string[]>('name');

    const recent = await trx('product_customizations')
      .where({ data_product_id: productId })
      .orderBy('created_at', 'desc')
      .limit(10)
      .select('intent', 'summary', 'status');

    return {
      productName: String(product.name),
      productDescription: product.description ? String(product.description) : null,
      tables: tables.map((t) => ({
        tableId: Number(t.id),
        tableName: String(t.table_name),
        tableRole: String(t.table_role),
        transformationSql: t.transformation_sql ? String(t.transformation_sql) : null,
        columns: (colsByTable.get(Number(t.id)) ?? []).map((c) => ({
          columnId: Number(c.id),
          columnName: String(c.column_name),
          dataType: String(c.data_type),
          columnRole: c.column_role ? String(c.column_role) : null,
          description: c.description ? String(c.description) : null,
          transformationExpression: c.transformation_expression ? String(c.transformation_expression) : null,
          sourceLineage: lineageByCol.get(Number(c.id)) ?? [],
        })),
      })),
      sourceConnections,
      existingKpiNames: kpiNames,
      focusedTableId,
      recentCustomizations: recent.map((r) => ({
        intent: String(r.intent),
        summary: r.summary ? String(r.summary) : '',
        status: String(r.status),
      })),
    };
  });
}

/**
 * Load source schemas for a set of connections, joined to whatever quality
 * profile we have (top values, null %, distinct count). Used to give the
 * Refine AI awareness of raw columns it might be asked to pull in.
 *
 * Connection-table-column join with a left join on dataset_profiles so
 * profiling results are best-effort — unprofiled tables still appear.
 */
async function loadSourceSchemas(
  trx: import('knex').Knex,
  connectionIds: number[],
): Promise<RefineChatProductContext['sourceConnections']> {
  if (connectionIds.length === 0) return [];

  const conns = await trx('connections')
    .whereIn('id', connectionIds)
    .select('id', 'name', 'connector_type');

  const sourceTables = await trx('source_tables')
    .whereIn('connection_id', connectionIds)
    .where({ is_active: true })
    .select('id', 'connection_id', 'table_name', 'description');

  const stIds = sourceTables.map((t) => Number(t.id));
  const sourceColumns = stIds.length > 0
    ? await trx('source_columns')
        .whereIn('table_id', stIds)
        .orderBy(['table_id', 'id'])
        .select('table_id', 'column_name', 'data_type', 'description')
    : [];

  // Per-column quality stats (best-effort — most recent profile per
  // (connection_id, table_name)).
  const profiles = stIds.length > 0
    ? await trx('dataset_profiles as dp')
        .leftJoin('field_profiles as fp', 'fp.profile_id', 'dp.id')
        .whereIn('dp.connection_id', connectionIds)
        .select(
          'dp.connection_id', 'dp.table_name',
          'fp.field_name', 'fp.null_pct', 'fp.distinct_count', 'fp.top_values',
        )
    : [];
  const profileByKey = new Map<string, {
    nullPct: number | null;
    distinctCount: number | null;
    topValues: string[] | null;
  }>();
  for (const p of profiles) {
    if (!p.field_name) continue;
    const key = `${p.connection_id}|${p.table_name}|${p.field_name}`;
    const existing = profileByKey.get(key);
    if (existing) continue; // first wins (latest profile via natural query order)
    let topValues: string[] | null = null;
    if (p.top_values) {
      try {
        const parsed = typeof p.top_values === 'string' ? JSON.parse(p.top_values) : p.top_values;
        if (Array.isArray(parsed)) {
          topValues = parsed.slice(0, 3).map((v: unknown) =>
            typeof v === 'object' && v !== null && 'value' in (v as object)
              ? String((v as { value: unknown }).value)
              : String(v),
          );
        }
      } catch { /* leave null */ }
    }
    profileByKey.set(key, {
      nullPct: p.null_pct != null ? Number(p.null_pct) : null,
      distinctCount: p.distinct_count != null ? Number(p.distinct_count) : null,
      topValues,
    });
  }

  // Group columns by source-table id.
  const colsByStId = new Map<number, typeof sourceColumns>();
  for (const c of sourceColumns) {
    const list = colsByStId.get(Number(c.table_id)) ?? [];
    list.push(c);
    colsByStId.set(Number(c.table_id), list);
  }

  // Compose final shape.
  return conns.map((c) => {
    const tablesForConn = sourceTables.filter((t) => Number(t.connection_id) === Number(c.id));
    return {
      connectionName: String(c.name),
      connectorType:  c.connector_type ? String(c.connector_type) : null,
      tables: tablesForConn.map((t) => ({
        sourceTableName: String(t.table_name),
        description:     t.description ? String(t.description) : null,
        columns: (colsByStId.get(Number(t.id)) ?? []).map((col) => {
          const stats = profileByKey.get(`${c.id}|${t.table_name}|${col.column_name}`) ?? null;
          return {
            columnName:    String(col.column_name),
            dataType:      String(col.data_type ?? 'UNKNOWN'),
            description:   col.description ? String(col.description) : null,
            topValues:     stats?.topValues ?? null,
            nullPct:       stats?.nullPct ?? null,
            distinctCount: stats?.distinctCount ?? null,
          };
        }),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listRefinements(
  tenantId: number,
  productId: number,
): Promise<RefinementRow[]> {
  return tenantQuery(tenantId, (trx) =>
    trx('product_customizations')
      .where({ data_product_id: productId })
      .orderBy('created_at', 'asc')
      .select<RefinementRow[]>('*'),
  );
}

// ---------------------------------------------------------------------------
// Create — runs the AI, persists the proposal as pending
// ---------------------------------------------------------------------------

export async function createRefinement(
  tenantId: number,
  productId: number,
  userId: number | null,
  userName: string | null,
  userMessage: string,
  focusedTableId: number | null,
): Promise<RefinementRow> {
  const context = await buildRefineContext(tenantId, productId, focusedTableId);
  if (!context) throw new Error('Product not found');

  // Run the AI. Lazy-import to avoid a circular dep at module load.
  const { proposeRefinement } = await import('../ai/AIService');
  const result = await proposeRefinement(context, userMessage);

  const id = await tenantQuery(tenantId, async (trx) => {
    const [row] = await trx('product_customizations')
      .insert({
        data_product_id:    productId,
        product_table_id:   focusedTableId,
        user_message:       userMessage,
        user_id:            userId,
        user_name:          userName,
        intent:             result.intent,
        intent_confidence:  result.confidence,
        intent_reasoning:   result.reasoning,
        proposal:           JSON.stringify(result.proposal),
        summary:            result.summary,
        // Non-applyable intents (clarification / unsupported) are
        // terminal — no approve flow makes sense. Mark applied.
        status: result.intent === 'add_column'
             || result.intent === 'modify_column'
             || result.intent === 'add_kpi'
          ? 'pending'
          : 'applied',
        decided_at: result.intent === 'ask_clarification' || result.intent === 'unsupported'
          ? new Date().toISOString()
          : null,
      })
      .returning('id');
    return typeof row === 'object' ? Number((row as { id: number }).id) : Number(row);
  });

  const [created] = await tenantQuery(tenantId, (trx) =>
    trx('product_customizations').where({ id }).select<RefinementRow[]>('*'),
  );
  return created;
}

// ---------------------------------------------------------------------------
// Approve — dispatch to the right apply handler
// ---------------------------------------------------------------------------

export async function approveRefinement(
  tenantId: number,
  refinementId: number,
  userId: number,
  userName: string,
): Promise<RefinementRow> {
  const row = await tenantQuery(tenantId, (trx) =>
    trx('product_customizations').where({ id: refinementId }).first(),
  );
  if (!row) throw new Error('Refinement not found');
  if (row.status !== 'pending') {
    throw new Error(`Cannot approve refinement in status "${row.status}"`);
  }

  const proposal = parseProposal(row.proposal);
  if (!proposal) throw new Error('Proposal payload is malformed');

  try {
    if (proposal.intent === 'add_column') {
      await applyAddColumn(tenantId, proposal);
    } else if (proposal.intent === 'modify_column') {
      await applyModifyColumn(tenantId, proposal);
    } else if (proposal.intent === 'add_kpi') {
      await applyAddKpi(tenantId, Number(row.data_product_id), proposal);
    } else {
      throw new Error(`Cannot apply proposal of intent "${proposal.intent}"`);
    }

    await tenantQuery(tenantId, (trx) =>
      trx('product_customizations').where({ id: refinementId }).update({
        status: 'applied',
        decided_at: new Date().toISOString(),
        decided_by_user_id: userId,
        decided_by_user_name: userName,
        apply_error: null,
        updated_at: new Date().toISOString(),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, refinementId, intent: proposal.intent }, 'refine apply failed');
    await tenantQuery(tenantId, (trx) =>
      trx('product_customizations').where({ id: refinementId }).update({
        status: 'failed',
        decided_at: new Date().toISOString(),
        decided_by_user_id: userId,
        decided_by_user_name: userName,
        apply_error: msg,
        updated_at: new Date().toISOString(),
      }),
    );
    throw err;
  }

  const [updated] = await tenantQuery(tenantId, (trx) =>
    trx('product_customizations').where({ id: refinementId }).select<RefinementRow[]>('*'),
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

export async function rejectRefinement(
  tenantId: number,
  refinementId: number,
  userId: number,
  userName: string,
): Promise<RefinementRow> {
  await tenantQuery(tenantId, (trx) =>
    trx('product_customizations').where({ id: refinementId }).update({
      status: 'rejected',
      decided_at: new Date().toISOString(),
      decided_by_user_id: userId,
      decided_by_user_name: userName,
      updated_at: new Date().toISOString(),
    }),
  );
  const [updated] = await tenantQuery(tenantId, (trx) =>
    trx('product_customizations').where({ id: refinementId }).select<RefinementRow[]>('*'),
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Apply handlers — each runs in a single tenantQuery transaction so a
// partial write doesn't leave the product in an inconsistent state.
// ---------------------------------------------------------------------------

async function applyAddColumn(tenantId: number, p: AddColumnPayload): Promise<void> {
  await tenantQuery(tenantId, async (trx) => {
    // 1. Verify the table exists and grab the next sort_order.
    const table = await trx('product_tables').where({ id: p.product_table_id }).first();
    if (!table) throw new Error(`Table id ${p.product_table_id} not found`);

    const maxSort = await trx('product_columns')
      .where({ product_table_id: p.product_table_id })
      .max<{ max: number | null }[]>('sort_order as max');
    const nextSort = (maxSort[0]?.max ?? -1) + 1;

    // 2. Insert the new column row.
    await trx('product_columns').insert({
      product_table_id:           p.product_table_id,
      column_name:                p.column_name,
      data_type:                  p.data_type,
      column_role:                p.column_role,
      description:                p.description,
      transformation_expression:  p.transformation_expression,
      sort_order:                 nextSort,
      ai_draft:                   false,
    });

    // 3. Replace the table's transformation_sql with the AI's full version.
    //    The next refresh re-materialises with the new column included.
    await trx('product_tables').where({ id: p.product_table_id }).update({
      transformation_sql: p.new_transformation_sql,
      // Mark not-yet-materialised so the catalog UI can hint a refresh.
      // We don't change transformation_status — the previous successful
      // build is still readable from the old delta_path until the next
      // refresh writes a new parquet.
      updated_at: new Date().toISOString(),
    });
  });
}

async function applyModifyColumn(tenantId: number, p: ModifyColumnPayload): Promise<void> {
  await tenantQuery(tenantId, async (trx) => {
    const col = await trx('product_columns').where({ id: p.product_column_id }).first();
    if (!col) throw new Error(`Column id ${p.product_column_id} not found`);

    const colUpdates: Record<string, unknown> = { ai_draft: false };
    if (p.data_type !== null) colUpdates.data_type = p.data_type;
    if (p.column_role !== null) colUpdates.column_role = p.column_role;
    if (p.description !== null) colUpdates.description = p.description;
    if (p.transformation_expression !== null) colUpdates.transformation_expression = p.transformation_expression;

    if (Object.keys(colUpdates).length > 1) {
      await trx('product_columns').where({ id: p.product_column_id }).update(colUpdates);
    }

    await trx('product_tables').where({ id: p.product_table_id }).update({
      transformation_sql: p.new_transformation_sql,
      updated_at: new Date().toISOString(),
    });
  });
}

async function applyAddKpi(
  tenantId: number,
  productId: number,
  p: AddKpiPayload,
): Promise<void> {
  await tenantQuery(tenantId, (trx) =>
    trx('product_kpis').insert({
      data_product_id:    productId,
      name:               p.name,
      description:        p.description,
      formula_plain_text: p.formula_plain_text,
      formula_sql:        p.formula_sql,
      ai_draft:           false,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProposal(raw: unknown): ProposalPayload | null {
  if (raw == null) return null;
  // jsonb columns come back as objects already; handle string fallback.
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as ProposalPayload; } catch { return null; }
  }
  if (typeof raw === 'object') return raw as ProposalPayload;
  return null;
}

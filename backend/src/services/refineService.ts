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
      .select('pt.id', 'pt.table_name', 'pt.table_role', 'pt.transformation_sql', 'pt.source_product_table_id')
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

    // ── Shared-dimension resolution ──────────────────────────────────────
    // A table with source_product_table_id is a STUB for a dimension owned
    // by another product — it has no authoritative SQL/columns of its own.
    // To let the AI reason (and write) against the canonical definition, we
    // present the OWNER's id, columns and SQL in place of the stub, and
    // record the blast radius so the UI can warn "affects N products".
    // Products with no shared dims hit none of this (ownerByStub is empty).
    const ownerByStub = new Map<number, number>();
    for (const t of tables) {
      const owner = (t as { source_product_table_id?: number | null }).source_product_table_id;
      if (owner) ownerByStub.set(Number(t.id), Number(owner));
    }
    const ownerIds = Array.from(new Set(ownerByStub.values()));

    const ownerMetaById = new Map<number, { tableName: string; tableRole: string; transformationSql: string | null; ownerProductName: string }>();
    const ownerColsByTable = new Map<number, typeof columns>();
    const affectedByOwner = new Map<number, Array<{ id: number; name: string }>>();

    if (ownerIds.length > 0) {
      const ownerTables = await trx('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .whereIn('pt.id', ownerIds)
        .select('pt.id', 'pt.table_name', 'pt.table_role', 'pt.transformation_sql', 'dp.id as owner_product_id', 'dp.name as owner_product_name');
      for (const o of ownerTables) {
        ownerMetaById.set(Number(o.id), {
          tableName: String(o.table_name),
          tableRole: String(o.table_role),
          transformationSql: o.transformation_sql ? String(o.transformation_sql) : null,
          ownerProductName: String(o.owner_product_name),
        });
      }

      const ownerCols = await trx('product_columns')
        .whereIn('product_table_id', ownerIds)
        .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
        .orderBy(['product_table_id', 'sort_order'])
        .select('id', 'product_table_id', 'column_name', 'data_type', 'column_role', 'description', 'transformation_expression');
      for (const c of ownerCols) {
        const list = ownerColsByTable.get(Number(c.product_table_id)) ?? [];
        list.push(c);
        ownerColsByTable.set(Number(c.product_table_id), list);
      }
      // Owner column lineage — merge into the same map keyed by column id.
      const ownerColIds = ownerCols.map((c) => Number(c.id));
      const ownerLineage = ownerColIds.length
        ? await trx('column_lineage').whereIn('product_column_id', ownerColIds)
            .select('product_column_id', 'source_table_name', 'source_column_name')
        : [];
      for (const l of ownerLineage) {
        const list = lineageByCol.get(Number(l.product_column_id)) ?? [];
        list.push({ sourceTable: String(l.source_table_name), sourceColumn: String(l.source_column_name) });
        lineageByCol.set(Number(l.product_column_id), list);
      }

      // Dependents: every product that pulls in one of these owner tables.
      const deps = await trx('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .whereIn('pt.source_product_table_id', ownerIds)
        .select('pt.source_product_table_id as owner_id', 'dp.id as product_id', 'dp.name as product_name');
      for (const ownerId of ownerIds) {
        const seen = new Map<number, string>();
        // Lead the impact list with the owning product (the source of truth)…
        const ownerTableRow = ownerTables.find((o) => Number(o.id) === ownerId);
        if (ownerTableRow) seen.set(Number(ownerTableRow.owner_product_id), String(ownerTableRow.owner_product_name));
        // …then every product that consumes it.
        for (const d of deps) {
          if (Number(d.owner_id) !== ownerId) continue;
          seen.set(Number(d.product_id), String(d.product_name));
        }
        affectedByOwner.set(ownerId, Array.from(seen, ([id, name]) => ({ id, name })));
      }
    }

    const effectiveFocusedTableId = focusedTableId != null
      ? (ownerByStub.get(focusedTableId) ?? focusedTableId)
      : null;

    return {
      productName: String(product.name),
      productDescription: product.description ? String(product.description) : null,
      tables: tables.map((t) => {
        const ownerId = ownerByStub.get(Number(t.id));
        const effId = ownerId ?? Number(t.id);
        const ownerMeta = ownerId != null ? ownerMetaById.get(ownerId) : null;
        const cols = ownerId != null ? (ownerColsByTable.get(ownerId) ?? []) : (colsByTable.get(Number(t.id)) ?? []);
        return {
          tableId: effId,
          tableName: ownerMeta ? ownerMeta.tableName : String(t.table_name),
          tableRole: ownerMeta ? ownerMeta.tableRole : String(t.table_role),
          transformationSql: ownerMeta ? ownerMeta.transformationSql : (t.transformation_sql ? String(t.transformation_sql) : null),
          columns: cols.map((c) => ({
            columnId: Number(c.id),
            columnName: String(c.column_name),
            dataType: String(c.data_type),
            columnRole: c.column_role ? String(c.column_role) : null,
            description: c.description ? String(c.description) : null,
            transformationExpression: c.transformation_expression ? String(c.transformation_expression) : null,
            sourceLineage: lineageByCol.get(Number(c.id)) ?? [],
          })),
          ...(ownerId != null && ownerMeta
            ? { sharedFrom: { ownerProductName: ownerMeta.ownerProductName, affectedProducts: affectedByOwner.get(ownerId) ?? [] } }
            : {}),
        };
      }),
      sourceConnections,
      existingKpiNames: kpiNames,
      focusedTableId: effectiveFocusedTableId,
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
// Preview — resolve a pending proposal into runnable SQL so the UI can show
// sample rows of the change BEFORE the user approves. Only column-shaped
// intents (add/modify column) carry a `new_transformation_sql` that produces
// a table; KPIs are query-time formulas and aren't previewable as rows.
// The actual DuckDB execution happens in the route (where the warehouse
// session helpers live) — this just resolves the plan under tenant scope.
// ---------------------------------------------------------------------------

export interface RefinementPreviewPlan {
  previewable: boolean;
  /** Why preview isn't available (KPI / clarification / unsupported). */
  reason?: string;
  connectionId?: number;
  /** Full transformation SQL that will produce the table after approval. */
  sql?: string;
  /** The column the proposal adds or changes — the UI highlights it. */
  targetColumn?: string;
}

export async function getRefinementPreviewPlan(
  tenantId: number,
  refinementId: number,
): Promise<RefinementPreviewPlan> {
  const row = await tenantQuery(tenantId, (trx) =>
    trx('product_customizations').where({ id: refinementId }).first(),
  );
  if (!row) throw new Error('Refinement not found');

  const proposal = parseProposal(row.proposal);
  if (!proposal) throw new Error('Proposal payload is malformed');

  if (proposal.intent !== 'add_column' && proposal.intent !== 'modify_column') {
    return {
      previewable: false,
      reason: proposal.intent === 'add_kpi'
        ? 'KPIs are calculated when a question or dashboard runs — open a dashboard to see this metric.'
        : 'There is nothing to preview for this message.',
    };
  }

  const product = await tenantQuery(tenantId, (trx) =>
    trx('data_products').where({ id: Number(row.data_product_id) }).first(),
  );
  if (!product) return { previewable: false, reason: 'Product not found' };

  return {
    previewable: true,
    connectionId: Number(product.connection_id),
    sql: proposal.new_transformation_sql,
    targetColumn: proposal.column_name,
  };
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

  // If the proposal targets a shared dimension, stamp the blast radius
  // onto the proposal so the UI can warn + offer refresh propagation. The
  // context already resolved stubs to owner ids, so product_table_id here
  // is the canonical (owner) table and apply writes to the right place.
  // (proposeRefinement guarantees a defined proposal object, but guard
  // anyway — a malformed proposal must never crash the send.)
  if (result.proposal && (result.proposal.intent === 'add_column' || result.proposal.intent === 'modify_column')) {
    const targetId = result.proposal.product_table_id;
    const ctxTable = context.tables.find((t) => t.tableId === targetId);
    if (ctxTable?.sharedFrom) {
      result.proposal.shared = {
        ownerProductName: ctxTable.sharedFrom.ownerProductName,
        affectedProducts: ctxTable.sharedFrom.affectedProducts,
      };
    }
  }

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

    // 4. Mirror the change into the notebook's deploy cell so the two
    //    editors stay in lockstep — otherwise the notebook shows stale
    //    cells and the next Deploy overwrites this change.
    await syncDeployCell(trx, p.product_table_id, p.new_transformation_sql);
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

    // Keep the notebook's deploy cell in sync (see applyAddColumn).
    await syncDeployCell(trx, p.product_table_id, p.new_transformation_sql);
  });
}

/**
 * Write `newSql` onto the cell a later Deploy would read for this table —
 * the `is_deploy_cell`, else the last SQL/NL cell — so a refine change is
 * visible in the notebook and re-applied (not clobbered) on the next
 * Deploy. Creates a deploy cell when the table has none (refine-first
 * tables), which also turns the notebook's "No cells yet" into the
 * applied SQL. Runs inside the caller's transaction.
 */
async function syncDeployCell(
  trx: import('knex').Knex,
  productTableId: number,
  newSql: string,
): Promise<void> {
  let cell = await trx('product_table_cells')
    .where({ product_table_id: productTableId, is_deploy_cell: true })
    .first();
  if (!cell) {
    cell = await trx('product_table_cells')
      .where({ product_table_id: productTableId })
      .whereIn('cell_type', ['sql', 'nl'])
      .orderBy('position', 'desc')
      .first();
  }
  if (cell) {
    // NL cells deploy from generated_sql; SQL cells from source.
    const patch = cell.cell_type === 'nl'
      ? { generated_sql: newSql, updated_at: new Date().toISOString() }
      : { source: newSql, updated_at: new Date().toISOString() };
    await trx('product_table_cells').where({ id: cell.id }).update(patch);
  } else {
    await trx('product_table_cells').insert({
      product_table_id: productTableId,
      cell_type: 'sql',
      source: newSql,
      position: 0,
      is_deploy_cell: true,
    });
  }
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

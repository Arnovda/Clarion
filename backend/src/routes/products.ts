import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
// tenantQuery removed — AI repair loops eliminated; deterministic auto-fix lives in transformationRunner
import { parsePagination, paginatedResponse } from '../utils/paginate';
import { syncProductToNeo4j, deleteProductFromNeo4j } from '../services/productGraphSync';
import { refineProduct } from '../ai/AIService';
import type {
  ProductSummary,
  RefineChange,
} from '../ai/prompts/refineProductPrompt';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/products — List all data products
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { limit: 50 });
    const [{ count: total }] = await semanticDb('data_products').count('* as count');
    const products = await semanticDb('data_products')
      .select('data_products.*')
      .select(
        semanticDb.raw('(SELECT COUNT(*) FROM star_schemas WHERE star_schemas.data_product_id = data_products.id) as star_schema_count'),
      )
      .orderBy('data_products.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Compute the canonical "primary source" for every product so the UI
    // can group / filter / badge consistently. Rules (see CLAUDE.md notes):
    //   1. Most-tables-contributed connection wins.
    //   2. Tie → fall back to data_products.connection_id.
    //   3. Empty data_product_sources → use data_products.connection_id.
    //   4. Connection deleted → primary becomes null + sourceDeleted=true.
    // multiSource=true when the product touches >1 connection.
    const productIds = products.map((p: { id: number }) => p.id);
    const sourceRows = productIds.length
      ? await semanticDb('data_product_sources as dps')
          .join('source_tables as st', 'st.id', 'dps.source_table_id')
          .whereIn('dps.data_product_id', productIds)
          .select('dps.data_product_id as product_id', 'st.connection_id as connection_id')
      : [];

    const connectionIds = new Set<number>();
    for (const p of products as { connection_id: number | null }[]) if (p.connection_id) connectionIds.add(p.connection_id);
    for (const r of sourceRows as { connection_id: number }[]) if (r.connection_id) connectionIds.add(r.connection_id);
    const connRows = connectionIds.size
      ? await semanticDb('connections')
          .whereIn('id', Array.from(connectionIds))
          .select('id', 'name', 'type', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; type: string; connectorType: string | null }>(
      connRows.map((c: { id: number; name: string; type: string; connector_type: string | null }) =>
        [c.id, { id: c.id, name: c.name, type: c.type, connectorType: c.connector_type }] as const,
      ),
    );

    // product_id → connection_id → table_count
    const tallies = new Map<number, Map<number, number>>();
    for (const r of sourceRows as { product_id: number; connection_id: number }[]) {
      if (!r.connection_id) continue;
      let inner = tallies.get(r.product_id);
      if (!inner) { inner = new Map(); tallies.set(r.product_id, inner); }
      inner.set(r.connection_id, (inner.get(r.connection_id) ?? 0) + 1);
    }

    const enriched = (products as Array<{ id: number; connection_id: number | null }>).map((p) => {
      const inner = tallies.get(p.id);
      const contributors = inner
        ? Array.from(inner.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])
        : [];
      // Primary connection: most-tables wins, fallback to data_products.connection_id.
      const primaryId = contributors[0]?.[0] ?? p.connection_id ?? null;
      const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
      const otherIds = contributors.slice(1).map(([id]) => id);
      const otherSources = otherIds
        .map((id) => connMap.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c);
      const multiSource = contributors.length > 1;
      // The product's stored connection_id pointed at a row we couldn't load
      // (cascade delete left the FK NULL or the connection row vanished
      // outside the tenant filter). Surface that explicitly so the UI can
      // render a "Source deleted" pill rather than a silent "Unknown".
      const sourceDeleted = primaryId != null && !primaryConn;
      return {
        ...p,
        source: {
          id: primaryConn?.id ?? null,
          name: primaryConn?.name ?? null,
          connectorType: primaryConn?.connectorType ?? null,
          multiSource,
          sourceDeleted,
          otherSources,
        },
      };
    });

    res.json(paginatedResponse(enriched, Number(total), page, limit));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products — Create a data product
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, connectionId, sourceTables } = req.body as {
      name: string;
      description?: string;
      connectionId: number;
      sourceTables: { sourceTableId: number; tableName: string }[];
    };

    if (!name?.trim()) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }

    const [row] = await semanticDb('data_products')
      .insert({
        name,
        description: description ?? null,
        connection_id: connectionId,
        status: 'draft',
        created_by: req.user!.sub,
      })
      .returning('id');

    const productId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);

    // Insert source table selections
    if (sourceTables?.length) {
      await semanticDb('data_product_sources').insert(
        sourceTables.map((s) => ({
          data_product_id: productId,
          source_table_id: s.sourceTableId,
          table_name: s.tableName,
        })),
      );
    }

    res.json({ ok: true, data: { id: productId } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/dependency-graph — All dependency edges for this tenant
// Must be before /:id routes to avoid being captured by the param handler
// ---------------------------------------------------------------------------

router.get('/dependency-graph', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deps = await semanticDb('data_product_dependencies')
      .select('dependent_product_id', 'source_product_id');
    res.json({ ok: true, data: deps });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/by-source-table/:sourceTableId — Products referencing a source table
// Must be before /:id routes to avoid being captured by the param handler
// ---------------------------------------------------------------------------

router.get('/by-source-table/:sourceTableId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceTableId = Number(req.params.sourceTableId);
    if (!Number.isFinite(sourceTableId)) {
      res.status(400).json({ ok: false, error: 'sourceTableId required' });
      return;
    }
    const rows = await semanticDb('data_product_sources as dps')
      .join('data_products as dp', 'dp.id', 'dps.data_product_id')
      .where('dps.source_table_id', sourceTableId)
      .select('dp.id', 'dp.name', 'dp.status');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id — Full data product with star schemas, tables, columns, lineage, relationships
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Star schemas
    const schemas = await semanticDb('star_schemas')
      .where({ data_product_id: product.id })
      .orderBy('id');

    // Tables
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const rawTables = schemaIds.length
      ? await semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];

    // Enrich reference rows (rows that point at an owner via source_product_table_id)
    // with the owner's freshness fields and product name. Without this, a consumer
    // product's UI shows stale "last_run_at" / row_count for shared dims that are
    // only physically rebuilt under their owning product.
    const ownerIds = rawTables
      .map((t: { source_product_table_id?: number | null }) => t.source_product_table_id)
      .filter((id): id is number => typeof id === 'number');
    const owners = ownerIds.length
      ? await semanticDb('product_tables as pt')
          .leftJoin('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
          .leftJoin('data_products as dp', 'ss.data_product_id', 'dp.id')
          .whereIn('pt.id', ownerIds)
          .select(
            'pt.id', 'pt.transformation_status', 'pt.last_run_at',
            'pt.last_run_error', 'pt.row_count', 'pt.delta_path',
            'dp.id as owner_product_id', 'dp.name as owner_product_name',
          )
      : [];
    const ownerById = new Map(owners.map((o: { id: number }) => [o.id, o]));

    const tables: any[] = rawTables.map((t: any) => {
      const ownerId = t.source_product_table_id as number | null | undefined;
      if (!ownerId) return t;
      const owner = ownerById.get(ownerId) as any;
      if (!owner) return t;
      return {
        ...t,
        transformation_status: owner.transformation_status ?? t.transformation_status,
        last_run_at: owner.last_run_at ?? t.last_run_at,
        last_run_error: owner.last_run_error ?? t.last_run_error,
        row_count: owner.row_count ?? t.row_count,
        delta_path: owner.delta_path ?? t.delta_path,
        owner_product_id: owner.owner_product_id ?? null,
        owner_product_name: owner.owner_product_name ?? null,
        is_reference: true,
      };
    });

    // Columns
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await semanticDb('product_columns')
          .whereIn('product_table_id', tableIds)
          .orderBy(['sort_order', 'id'])
      : [];

    // Lineage
    const columnIds = columns.map((c: { id: number }) => c.id);
    const lineage = columnIds.length
      ? await semanticDb('column_lineage').whereIn('product_column_id', columnIds)
      : [];

    // Relationships
    const relationships = schemaIds.length
      ? await semanticDb('product_relationships as pr')
          .join('product_tables as ft', 'pr.from_table_id', 'ft.id')
          .join('product_tables as tt', 'pr.to_table_id', 'tt.id')
          .whereIn('pr.star_schema_id', schemaIds)
          .select(
            'pr.id', 'pr.star_schema_id',
            'ft.table_name as from_table_name', 'pr.from_column_name',
            'tt.table_name as to_table_name', 'pr.to_column_name',
            'pr.relationship_type',
          )
      : [];

    // Transformation quality checks
    const checks = tableIds.length
      ? await semanticDb('transformation_checks').whereIn('product_table_id', tableIds)
      : [];

    const checksByTable = new Map<number, typeof checks>();
    for (const c of checks) {
      const arr = checksByTable.get(c.product_table_id) ?? [];
      arr.push(c);
      checksByTable.set(c.product_table_id, arr);
    }

    // Assemble nested response
    const lineageByCol = new Map<number, typeof lineage>();
    for (const l of lineage) {
      const arr = lineageByCol.get(l.product_column_id) ?? [];
      arr.push(l);
      lineageByCol.set(l.product_column_id, arr);
    }

    const colsByTable = new Map<number, (typeof columns[0] & { lineage: typeof lineage })[]>();
    for (const c of columns) {
      const arr = colsByTable.get(c.product_table_id) ?? [];
      arr.push({ ...c, lineage: lineageByCol.get(c.id) ?? [] });
      colsByTable.set(c.product_table_id, arr);
    }

    const tablesBySchema = new Map<number, (typeof tables[0] & { columns: unknown[]; quality_checks: unknown[] })[]>();
    for (const t of tables) {
      const arr = tablesBySchema.get(t.star_schema_id) ?? [];
      arr.push({ ...t, columns: colsByTable.get(t.id) ?? [], quality_checks: checksByTable.get(t.id) ?? [] });
      tablesBySchema.set(t.star_schema_id, arr);
    }

    const relsBySchema = new Map<number, typeof relationships>();
    for (const r of relationships) {
      const arr = relsBySchema.get(r.star_schema_id) ?? [];
      arr.push(r);
      relsBySchema.set(r.star_schema_id, arr);
    }

    // Compute the same `source` block the list endpoint returns so the
    // detail panel can show <SourceBadge> consistently with /products and
    // the catalog tree.
    const dpsRows = await semanticDb('data_product_sources as dps')
      .join('source_tables as st', 'st.id', 'dps.source_table_id')
      .where('dps.data_product_id', product.id)
      .select('st.connection_id as connection_id');
    const tally = new Map<number, number>();
    for (const r of dpsRows as { connection_id: number }[]) {
      if (!r.connection_id) continue;
      tally.set(r.connection_id, (tally.get(r.connection_id) ?? 0) + 1);
    }
    const contributors = Array.from(tally.entries()).sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    const primaryId = contributors[0]?.[0] ?? product.connection_id ?? null;
    const involvedIds = new Set<number>(contributors.map(([id]) => id));
    if (product.connection_id) involvedIds.add(product.connection_id);
    const connRows = involvedIds.size
      ? await semanticDb('connections')
          .whereIn('id', Array.from(involvedIds))
          .select('id', 'name', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; connector_type: string | null }>(
      connRows.map((c: { id: number; name: string; connector_type: string | null }) => [c.id, c] as const),
    );
    const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
    const otherSources = contributors.slice(1)
      .map(([id]) => connMap.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ id: c.id, name: c.name, connectorType: c.connector_type }));
    const source = {
      id: primaryConn?.id ?? null,
      name: primaryConn?.name ?? null,
      connectorType: primaryConn?.connector_type ?? null,
      multiSource: contributors.length > 1,
      sourceDeleted: primaryId != null && !primaryConn,
      otherSources,
    };

    const result = {
      ...product,
      source,
      star_schemas: schemas.map((s: { id: number }) => ({
        ...s,
        tables: tablesBySchema.get(s.id) ?? [],
        relationships: relsBySchema.get(s.id) ?? [],
      })),
    };

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/:id — Update data product
// ---------------------------------------------------------------------------

router.put('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, status } = req.body as { name?: string; description?: string; status?: string };
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;

    await semanticDb('data_products').where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/products/:id — Delete data product (cascade)
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = Number(req.params.id);

    // Collect table info before cascading delete removes it
    const product = await semanticDb('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await semanticDb('star_schemas').where({ data_product_id: productId }).select('id');
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const tables = schemaIds.length
      ? await semanticDb('product_tables').whereIn('star_schema_id', schemaIds).select('table_name', 'delta_path')
      : [];
    const connId = product.connection_id;

    // Clean up quality data for product tables (keyed by connection_id + table_name, no FK cascade)
    for (const t of tables) {
      const tn = t.table_name as string;
      // Delete quality rules (cascades to rule_executions + quality_failures)
      await semanticDb('quality_rules').where({ connection_id: connId, table_name: tn }).delete();
      // Delete quality score history
      await semanticDb('quality_score_history').where({ connection_id: connId, table_name: tn }).delete();
      // Delete field profiles via dataset_profiles
      const profiles = await semanticDb('dataset_profiles')
        .where({ connection_id: connId, table_name: tn }).select('id');
      if (profiles.length) {
        await semanticDb('field_profiles').whereIn('profile_id', profiles.map((p: { id: number }) => p.id)).delete();
        await semanticDb('dataset_profiles').where({ connection_id: connId, table_name: tn }).delete();
      }
    }

    // Clean up warehouse Parquet files
    const productSlug = (product.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const conn = await semanticDb('connections').where({ id: connId }).first();
    const warehousePath = conn?.warehouse_path ?? `./warehouse/conn_${connId}`;
    if (!warehousePath.startsWith('az://')) {
      const productDir = require('path').resolve('./warehouse/product', productSlug);
      const fs = require('fs');
      if (fs.existsSync(productDir)) {
        fs.rmSync(productDir, { recursive: true, force: true });
        console.log(`[products] Deleted warehouse dir: ${productDir}`);
      }
    }

    // Delete product row (cascades to star_schemas → product_tables → product_columns)
    await semanticDb('data_products').where({ id: productId }).delete();

    // Remove product graph from Neo4j
    deleteProductFromNeo4j(productId).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/sources — Source tables assigned to this data product
// ---------------------------------------------------------------------------

router.get('/:id/sources', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = await semanticDb('data_product_sources')
      .where({ data_product_id: req.params.id })
      .orderBy('table_name');
    res.json({ ok: true, data: sources });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/design-stream — SSE streaming AI star schema design
// Streams thinking tokens, phase updates, and table previews as they appear.
// ---------------------------------------------------------------------------

router.post('/:id/design-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      emit({ type: 'error', message: 'Data product not found' });
      res.end(); return;
    }

    const sources = await semanticDb('data_product_sources').where({ data_product_id: product.id });
    if (sources.length === 0) {
      emit({ type: 'error', message: 'No source tables selected for this data product' });
      res.end(); return;
    }

    // Mark as designing
    await semanticDb('data_products').where({ id: product.id }).update({
      status: 'designing', updated_at: new Date().toISOString(),
    });

    emit({ type: 'phase', text: `Reading ${sources.length} source tables...` });

    // Build source context
    const sourceTableNames = sources.map((s: { table_name: string }) => s.table_name);
    const sourceTables = await semanticDb('source_tables')
      .where({ connection_id: product.connection_id, is_active: true })
      .whereIn('table_name', sourceTableNames);

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await semanticDb('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    const sourceContext = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean; example_values: unknown }) => {
          const examples = c.example_values
            ? ` — samples: ${JSON.stringify(typeof c.example_values === 'string' ? JSON.parse(c.example_values) : c.example_values)}`
            : '';
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}${examples}`;
        }).join('\n');
      return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // ── Load shared dimensions from dependency products ───────────────────
    // These are conformed dims already designed in other products.
    // We inject their schemas so the AI knows NOT to redesign them and can
    // write correct JOIN SQL referencing the right surrogate key columns.
    let sharedDimsContext = '';
    try {
      const deps = await semanticDb('data_product_dependencies as dpd')
        .join('data_products as dp', 'dpd.source_product_id', 'dp.id')
        .where('dpd.dependent_product_id', product.id)
        .select('dpd.source_product_id', 'dp.name as source_product_name');

      if (deps.length > 0) {
        const sharedDimBlocks: string[] = [];
        for (const dep of deps) {
          // Owners (is_shared_dimension=false) live in the upstream product
          // and have transformation_sql. Stubs in downstream products are
          // is_shared_dimension=true with null SQL — we want the owners here.
          const sharedTables = await semanticDb('product_tables as pt')
            .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
            .where({ 'ss.data_product_id': dep.source_product_id, 'pt.is_shared_dimension': false })
            .where('pt.table_role', 'dimension')
            .whereNotNull('pt.transformation_sql')
            .select('pt.id', 'pt.table_name', 'pt.display_name', 'pt.description');

          for (const tbl of sharedTables) {
            const cols = await semanticDb('product_columns')
              .where({ product_table_id: tbl.id })
              .orderBy('sort_order')
              .select('column_name', 'data_type', 'column_role', 'description');

            const colLines = cols.map((c: { column_name: string; data_type: string; column_role: string; description: string }) =>
              `    ${c.column_name} (${c.data_type}) [${c.column_role}]: ${c.description ?? ''}`
            ).join('\n');

            sharedDimBlocks.push(
              `Shared dimension from "${dep.source_product_name}" (already built — reference only, do NOT redesign):\n` +
              `Table: ${tbl.table_name} — ${tbl.description ?? tbl.display_name}\n  Columns:\n${colLines}`
            );
          }
        }
        if (sharedDimBlocks.length > 0) {
          sharedDimsContext = sharedDimBlocks.join('\n\n');
        }
      }
    } catch (depErr) {
      console.warn('[products/design-stream] Could not load dependency dims:', depErr);
    }

    const fullSourceContext = sharedDimsContext
      ? `${sourceContext}\n\n━━━ CONFORMED DIMENSIONS (owned by other products — JOIN to these, do NOT rebuild) ━━━\n\n${sharedDimsContext}`
      : sourceContext;

    emit({ type: 'phase', text: 'Designing star schema with AI...' });

    // ── Phase 1: Streaming star schema design ─────────────────────────────
    const { generateStarSchemaDesignStreaming } = await import('../ai/AIService');

    const design = await generateStarSchemaDesignStreaming(
      product.name,
      product.description ?? '',
      fullSourceContext,
      (type, delta) => {
        if (type === 'thinking') {
          emit({ type: 'thinking', text: delta });
        }
        // We could parse partial JSON for live table previews, but it's fragile.
        // Instead, we send text deltas so frontend can detect table names in the JSON stream.
        if (type === 'text') {
          emit({ type: 'json_delta', text: delta });
        }
      },
    );

    emit({ type: 'phase', text: 'Saving star schema design...' });

    // ── Save design to DB (same logic as non-streaming endpoint) ──────────
    await semanticDb('star_schemas').where({ data_product_id: product.id }).delete();

    const allSavedTables: { name: string; role: string; columnCount: number }[] = [];

    const schema = design.star_schema;
    {
      const [schemaRow] = await semanticDb('star_schemas')
        .insert({
          data_product_id: product.id,
          name: schema.name,
          description: schema.description,
          grain: schema.grain,
          fact_table_type: schema.fact_table_type,
        }).returning('id');
      const schemaId: number = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      for (const table of schema.tables) {
        const [tableRow] = await semanticDb('product_tables')
          .insert({
            star_schema_id: schemaId,
            table_name: table.table_name,
            display_name: table.display_name,
            description: table.description,
            table_role: table.table_role,
            dag_order: table.dag_order,
            transformation_sql: table.transformation_sql ?? null,
            transformation_status: table.transformation_sql ? 'draft' : 'pending',
            ai_draft: true,
          }).returning('id');
        const tableId: number = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(table.table_name, tableId);

        for (const col of table.columns) {
          const [colRow] = await semanticDb('product_columns')
            .insert({
              product_table_id: tableId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            }).returning('id');
          const colId: number = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          // Filter out lineage entries with null source columns (e.g. generated dim_date keys)
          const validLineage = (col.lineage ?? []).filter(
            (l) => l.source_table_name && l.source_column_name,
          );
          if (validLineage.length) {
            await semanticDb('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }

        allSavedTables.push({
          name: table.table_name,
          role: table.table_role,
          columnCount: table.columns.length,
        });

        // Emit table preview as each table is saved
        emit({ type: 'table_saved', table: {
          name: table.table_name,
          role: table.table_role,
          description: table.description,
          columns: table.columns.map((c) => ({
            name: c.column_name,
            role: c.column_role,
            type: c.data_type,
          })),
        }});
      }

      // Save relationships
      for (const rel of schema.relationships) {
        const fromTableId = tableNameToId.get(rel.from_table_name);
        const toTableId = tableNameToId.get(rel.to_table_name);
        if (fromTableId && toTableId) {
          await semanticDb('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromTableId,
            from_column_name: rel.from_column_name,
            to_table_id: toTableId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // ── Auto-inject dim_date using hardcoded template ──────────────────
      const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');
      const dateRange = design.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };

      const [dimDateRow] = await semanticDb('product_tables')
        .insert({
          star_schema_id: schemaId,
          table_name: 'dim_date',
          display_name: 'Date',
          description: 'Auto-generated calendar dimension',
          table_role: 'dimension',
          dag_order: 0,
          transformation_sql: DIM_DATE_SQL(dateRange.start, dateRange.end),
          transformation_status: 'draft',
          ai_draft: false,
        }).returning('id');
      const dimDateId: number = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await semanticDb('product_columns')
          .insert({
            product_table_id: dimDateId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            transformation_expression: col.transformation_expression,
            scd_type: col.scd_type,
            sort_order: col.sort_order,
            ai_draft: false,
          });
      }

      allSavedTables.push({
        name: 'dim_date',
        role: 'dimension',
        columnCount: DIM_DATE_COLUMNS.length,
      });

      emit({ type: 'table_saved', table: {
        name: 'dim_date',
        role: 'dimension',
        description: 'Auto-generated calendar dimension',
        columns: DIM_DATE_COLUMNS.map((c) => ({
          name: c.column_name,
          role: c.column_role,
          type: c.data_type,
        })),
      }});
    }

    // Save proposed KPIs
    if (design.proposed_kpis?.length) {
      await semanticDb('product_kpis').insert(
        design.proposed_kpis.map((k) => ({
          data_product_id: product.id,
          name: k.name,
          description: k.description,
          formula_plain_text: k.formula_plain_text,
          formula_sql: k.formula_sql,
          ai_draft: true,
        })),
      );
    }

    await semanticDb('data_products').where({ id: product.id }).update({
      status: 'approved', updated_at: new Date().toISOString(),
    });

    emit({ type: 'design_complete', tables: allSavedTables });

    emit({ type: 'sql_complete', tablesUpdated: allSavedTables.length });

    // Sync product graph to Neo4j for data dictionary
    await syncProductToNeo4j(product.id);

    emit({ type: 'done' });
    res.end();
  } catch (err: unknown) {
    console.error('[products/design-stream] Error:', err);
    await semanticDb('data_products').where({ id: req.params.id }).update({
      status: 'error', updated_at: new Date().toISOString(),
    }).catch(() => {});
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Design failed. Please try again.' });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/design — Trigger AI star schema design (non-streaming)
// ---------------------------------------------------------------------------

router.post('/:id/design', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Get source tables
    const sources = await semanticDb('data_product_sources')
      .where({ data_product_id: product.id });

    if (sources.length === 0) {
      res.status(400).json({ ok: false, error: 'No source tables selected for this data product' });
      return;
    }

    // Mark as designing
    await semanticDb('data_products').where({ id: product.id }).update({
      status: 'designing',
      updated_at: new Date().toISOString(),
    });

    // Build source context for AI
    const sourceTableNames = sources.map((s: { table_name: string }) => s.table_name);
    const sourceTables = await semanticDb('source_tables')
      .where({ connection_id: product.connection_id, is_active: true })
      .whereIn('table_name', sourceTableNames);

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await semanticDb('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    // Build context string
    const sourceContext = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean; example_values: unknown }) => {
          const examples = c.example_values
            ? ` — samples: ${JSON.stringify(typeof c.example_values === 'string' ? JSON.parse(c.example_values) : c.example_values)}`
            : '';
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}${examples}`;
        })
        .join('\n');
      return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // Call AI to design star schema
    const { generateStarSchemaDesign } = await import('../ai/AIService');
    const design = await generateStarSchemaDesign(
      product.name,
      product.description ?? '',
      sourceContext,
    );

    // Delete existing schemas for this product (re-design)
    await semanticDb('star_schemas').where({ data_product_id: product.id }).delete();

    // Save the design
    const schema = design.star_schema;
    {
      const [schemaRow] = await semanticDb('star_schemas')
        .insert({
          data_product_id: product.id,
          name: schema.name,
          description: schema.description,
          grain: schema.grain,
          fact_table_type: schema.fact_table_type,
        })
        .returning('id');
      const schemaId: number = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      // Track table_name → id for relationship resolution
      const tableNameToId = new Map<string, number>();

      for (const table of schema.tables) {
        const [tableRow] = await semanticDb('product_tables')
          .insert({
            star_schema_id: schemaId,
            table_name: table.table_name,
            display_name: table.display_name,
            description: table.description,
            table_role: table.table_role,
            dag_order: table.dag_order,
            transformation_sql: table.transformation_sql ?? null,
            transformation_status: table.transformation_sql ? 'draft' : 'pending',
            ai_draft: true,
          })
          .returning('id');
        const tableId: number = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(table.table_name, tableId);

        for (const col of table.columns) {
          const [colRow] = await semanticDb('product_columns')
            .insert({
              product_table_id: tableId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            })
            .returning('id');
          const colId: number = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          // Save lineage
          // Filter out lineage entries with null source columns (e.g. generated dim_date keys)
          const validLineage = (col.lineage ?? []).filter(
            (l) => l.source_table_name && l.source_column_name,
          );
          if (validLineage.length) {
            await semanticDb('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }
      }

      // Save relationships
      for (const rel of schema.relationships) {
        const fromTableId = tableNameToId.get(rel.from_table_name);
        const toTableId = tableNameToId.get(rel.to_table_name);
        if (fromTableId && toTableId) {
          await semanticDb('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromTableId,
            from_column_name: rel.from_column_name,
            to_table_id: toTableId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // ── Auto-inject dim_date using hardcoded template ──────────────────
      const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');
      const dateRange = design.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };

      const [dimDateRow] = await semanticDb('product_tables')
        .insert({
          star_schema_id: schemaId,
          table_name: 'dim_date',
          display_name: 'Date',
          description: 'Auto-generated calendar dimension',
          table_role: 'dimension',
          dag_order: 0,
          transformation_sql: DIM_DATE_SQL(dateRange.start, dateRange.end),
          transformation_status: 'draft',
          ai_draft: false,
        }).returning('id');
      const dimDateId: number = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await semanticDb('product_columns')
          .insert({
            product_table_id: dimDateId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            transformation_expression: col.transformation_expression,
            scd_type: col.scd_type,
            sort_order: col.sort_order,
            ai_draft: false,
          });
      }
    }

    // Save proposed KPIs
    if (design.proposed_kpis?.length) {
      await semanticDb('product_kpis').insert(
        design.proposed_kpis.map((k) => ({
          data_product_id: product.id,
          name: k.name,
          description: k.description,
          formula_plain_text: k.formula_plain_text,
          formula_sql: k.formula_sql,
          ai_draft: true,
        })),
      );
    }

    // Update product status
    await semanticDb('data_products').where({ id: product.id }).update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    });

    // Sync product graph to Neo4j for data dictionary
    await syncProductToNeo4j(product.id);

    res.json({ ok: true, data: { status: 'approved', sqlGenerated: true } });
  } catch (err) {
    // Revert status on error
    await semanticDb('data_products').where({ id: req.params.id }).update({
      status: 'error',
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/run — Run all transformations for a data product
// ---------------------------------------------------------------------------

router.post('/:id/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await semanticDb('star_schemas').where({ data_product_id: product.id });
    const schemaIds = schemas.map((s: { id: number }) => s.id);

    const fetchTables = () => schemaIds.length
      ? semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .whereNotNull('transformation_sql')
          .orderBy('dag_order', 'asc')
      : Promise.resolve([]);

    const { runProductTransformation } = await import('../services/transformationRunner');

    const tables = await fetchTables();
    const results = await runProductTransformation(product, tables, req.user?.tenantId);

    // Sync updated row counts / status to Neo4j
    syncProductToNeo4j(product.id).catch(() => {});

    res.json({ ok: true, data: results });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/tables/:tableId/run — Run a single table transformation
// ---------------------------------------------------------------------------

router.post('/tables/:tableId/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const table = await semanticDb('product_tables').where({ id: req.params.tableId }).first();
    if (!table) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    if (!table.transformation_sql) {
      res.status(400).json({ ok: false, error: 'No transformation SQL defined' });
      return;
    }

    const schema = await semanticDb('star_schemas').where({ id: table.star_schema_id }).first();
    const product = await semanticDb('data_products').where({ id: schema.data_product_id }).first();

    const { runProductTransformation } = await import('../services/transformationRunner');

    const result = (await runProductTransformation(product, [table], req.user?.tenantId))[0] ?? null;

    // Sync updated row counts / status to Neo4j
    syncProductToNeo4j(product.id).catch(() => {});

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/products/tables/:tableId — Update product table metadata
// (currently: description, display_name)
// ---------------------------------------------------------------------------

router.patch('/tables/:tableId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allowed = ['description', 'display_name'];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    await semanticDb('product_tables').where({ id: req.params.tableId }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/tables/:tableId/sql — Update transformation SQL
// ---------------------------------------------------------------------------

router.put('/tables/:tableId/sql', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sql } = req.body as { sql: string };
    await semanticDb('product_tables')
      .where({ id: req.params.tableId })
      .update({
        transformation_sql: sql,
        transformation_status: 'draft',
        updated_at: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/tables/:tableId/approve — Approve transformation
// ---------------------------------------------------------------------------

router.put('/tables/:tableId/approve', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await semanticDb('product_tables')
      .where({ id: req.params.tableId })
      .update({
        transformation_status: 'approved',
        updated_at: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/tables/:tableId/checks — Get quality check results
// ---------------------------------------------------------------------------

router.get('/tables/:tableId/checks', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const checks = await semanticDb('transformation_checks')
      .where({ product_table_id: req.params.tableId })
      .orderBy('check_type');
    res.json({ ok: true, data: checks });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/columns/:columnId — Update a product column
// ---------------------------------------------------------------------------

router.put('/columns/:columnId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allowed = [
      'column_name', 'data_type', 'display_name', 'description',
      'column_role', 'fk_target_table', 'fk_target_column',
      'transformation_expression', 'additivity', 'scd_type', 'sort_order',
    ];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    await semanticDb('product_columns').where({ id: req.params.columnId }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/refine — Propose metadata changes from NL instruction
// ---------------------------------------------------------------------------

router.post('/:id/refine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = Number(req.params.id);
    const { instruction } = req.body as { instruction: string };
    if (!instruction?.trim()) {
      res.status(400).json({ ok: false, error: 'instruction is required' });
      return;
    }

    const product = await semanticDb('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await semanticDb('star_schemas').where({ data_product_id: productId });
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const tables = schemaIds.length
      ? await semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await semanticDb('product_columns')
          .whereIn('product_table_id', tableIds)
          .orderBy(['sort_order', 'id'])
      : [];
    const kpis = await semanticDb('product_kpis')
      .where({ data_product_id: productId })
      .orderBy('name');

    const colsByTable = new Map<number, typeof columns>();
    for (const c of columns) {
      const arr = colsByTable.get(c.product_table_id) ?? [];
      arr.push(c);
      colsByTable.set(c.product_table_id, arr);
    }

    const summary: ProductSummary = {
      id:          product.id,
      name:        product.name,
      description: product.description ?? null,
      tables: tables.map((t: any) => ({
        id:          t.id,
        table_name:  t.table_name,
        description: t.description ?? null,
        columns: (colsByTable.get(t.id) ?? []).map((c: any) => ({
          id:           c.id,
          column_name:  c.column_name,
          display_name: c.display_name ?? null,
          description:  c.description ?? null,
          data_type:    c.data_type ?? null,
        })),
      })),
      kpis: kpis.map((k: any) => ({
        id:                  k.id,
        name:                k.name,
        description:         k.description ?? null,
        formula_plain_text:  k.formula_plain_text ?? null,
        formula_sql:         k.formula_sql ?? null,
      })),
    };

    const proposal = await refineProduct(summary, instruction.trim());
    res.json({ ok: true, data: proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/refine/apply — Apply a proposal's changes
// Body: { changes: RefineChange[] }
// Returns: { applied: number, skipped: Array<{ change, reason }>, notes: string[] }
// ---------------------------------------------------------------------------

router.post('/:id/refine/apply', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = Number(req.params.id);
    const { changes } = req.body as { changes: RefineChange[] };
    if (!Array.isArray(changes)) {
      res.status(400).json({ ok: false, error: 'changes[] is required' });
      return;
    }

    const product = await semanticDb('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const now = new Date().toISOString();
    let applied = 0;
    const skipped: Array<{ change: RefineChange; reason: string }> = [];
    const notes: string[] = [];

    for (const change of changes) {
      try {
        switch (change.op) {
          case 'update_table_description': {
            const n = await semanticDb('product_tables')
              .where({ id: change.table_id })
              .update({ description: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'Table not found' });
            break;
          }
          case 'update_column_description': {
            const n = await semanticDb('product_columns')
              .where({ id: change.column_id })
              .update({ description: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'Column not found' });
            break;
          }
          case 'update_column_display_name': {
            const n = await semanticDb('product_columns')
              .where({ id: change.column_id })
              .update({ display_name: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'Column not found' });
            break;
          }
          case 'update_kpi_description': {
            const n = await semanticDb('product_kpis')
              .where({ id: change.kpi_id, data_product_id: productId })
              .update({ description: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'KPI not found' });
            break;
          }
          case 'update_kpi_formula': {
            const n = await semanticDb('product_kpis')
              .where({ id: change.kpi_id, data_product_id: productId })
              .update({ formula_sql: change.new_value, ai_draft: false, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'KPI not found' });
            break;
          }
          case 'update_kpi_plain_text': {
            const n = await semanticDb('product_kpis')
              .where({ id: change.kpi_id, data_product_id: productId })
              .update({ formula_plain_text: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'KPI not found' });
            break;
          }
          case 'add_kpi': {
            await semanticDb('product_kpis').insert({
              data_product_id:    productId,
              name:               change.name,
              description:        change.description,
              formula_plain_text: change.formula_plain_text,
              formula_sql:        change.formula_sql,
              ai_draft:           false,
            });
            applied++;
            break;
          }
          case 'note': {
            notes.push(change.message);
            break;
          }
          default: {
            skipped.push({ change, reason: 'Unknown op' });
          }
        }
      } catch (e) {
        skipped.push({ change, reason: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    res.json({ ok: true, data: { applied, skipped, notes } as { applied: number; skipped: typeof skipped; notes: string[] } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/kpis — List KPIs
// ---------------------------------------------------------------------------

router.get('/:id/kpis', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kpis = await semanticDb('product_kpis')
      .where({ data_product_id: req.params.id })
      .orderBy('name');
    res.json({ ok: true, data: kpis });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/kpis — Create a KPI
// ---------------------------------------------------------------------------

router.post('/:id/kpis', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, formulaPlainText, formulaSql } = req.body as {
      name: string; description?: string; formulaPlainText?: string; formulaSql?: string;
    };

    const [row] = await semanticDb('product_kpis')
      .insert({
        data_product_id: Number(req.params.id),
        name,
        description: description ?? null,
        formula_plain_text: formulaPlainText ?? null,
        formula_sql: formulaSql ?? null,
        ai_draft: false,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/kpis/:kpiId — Update a KPI
// ---------------------------------------------------------------------------

router.put('/kpis/:kpiId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allowed = ['name', 'description', 'formula_plain_text', 'formula_sql', 'owner_name', 'ai_draft'];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    await semanticDb('product_kpis').where({ id: req.params.kpiId }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/products/kpis/:kpiId — Delete a KPI
// ---------------------------------------------------------------------------

router.delete('/kpis/:kpiId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await semanticDb('product_kpis').where({ id: req.params.kpiId }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/products/tables/:tableId/load-mode — Toggle incremental vs full
// Body: { load_mode: 'full' | 'incremental' }
// ---------------------------------------------------------------------------
router.patch('/tables/:tableId/load-mode', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { load_mode } = req.body as { load_mode: 'full' | 'incremental' };
    if (!['full', 'incremental'].includes(load_mode)) {
      res.status(400).json({ ok: false, error: 'load_mode must be "full" or "incremental"' });
      return;
    }
    await semanticDb('product_tables')
      .where({ id: req.params.tableId })
      .update({ load_mode });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/run-full — Force a full refresh (ignores load_mode)
// Query: ?include=upstream  also rebuilds upstream dependency products in
// topological order, so shared dims are fresh before consumer facts run.
// ---------------------------------------------------------------------------
router.post('/:id/run-full', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const includeUpstream = String(req.query.include ?? '').toLowerCase() === 'upstream';

    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const { runProductTransformation } = await import('../services/transformationRunner');
    const { resolveUpstreamProductsTopo } = await import('../services/productOwnership');

    // Build the run order: upstream-first if requested, then current product.
    const upstreamIds = includeUpstream
      ? await resolveUpstreamProductsTopo(Number(product.id), tenantId)
      : [];
    const runOrder = [...upstreamIds, Number(product.id)];

    const allResults: Array<{
      product_id: number;
      product_name: string;
      table_name: string;
      status: 'success' | 'error';
      row_count?: number;
      error?: string;
    }> = [];

    for (const pid of runOrder) {
      const p = await semanticDb('data_products').where({ id: pid }).first();
      if (!p) continue;

      const schemas = await semanticDb('star_schemas').where({ data_product_id: pid });
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      const tables = schemaIds.length
        ? await semanticDb('product_tables')
            .whereIn('star_schema_id', schemaIds)
            .whereNotNull('transformation_sql')
            .orderBy('dag_order', 'asc')
        : [];

      // Override load_mode to 'full' for this run only
      const fullTables = tables.map((t: Record<string, unknown>) => ({ ...t, load_mode: 'full' }));

      const results = await runProductTransformation(p, fullTables as any, tenantId);
      for (const r of results) {
        allResults.push({
          product_id: pid,
          product_name: p.name as string,
          ...r,
        });
      }
    }

    res.json({
      ok: true,
      data: allResults,
      meta: {
        run_order: runOrder,
        included_upstream: includeUpstream && upstreamIds.length > 0,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-single — propose exactly one data product
// from a free-text user description. No streaming — returns JSON directly.
// ---------------------------------------------------------------------------

router.post('/propose-single', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { connectionId, description } = req.body as { connectionId: number; description: string };
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const sourceTables = await semanticDb('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await semanticDb('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure');
      const fkRels = await semanticDb('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');
      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));
      const bkCol = t.business_key_column as string | null;
      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: c.column_name === 'id' || c.column_name === bkCol,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    const existingProducts = await semanticDb('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await semanticDb('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateStarSchemaDesign } = await import('../ai/AIService');

    const sourceTablesContext = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const desc = description.trim().slice(0, 500);
    const proposal = await generateStarSchemaDesign(
      desc || connection.name as string,
      desc,
      sourceTablesContext,
    );

    return res.json({ ok: true, data: proposal });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to propose data product';
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Bus Matrix — job-based flow (survives browser close, supports cancel)
//
// Endpoints:
//   POST /api/products/bus-matrix/start       → enqueue job, return { jobId }
//   GET  /api/products/bus-matrix/active      → currently running/queued job for tenant
//   GET  /api/products/bus-matrix/:jobId/stream → SSE: tail job logs + progress
//   POST /api/products/bus-matrix/:jobId/cancel → cancel a running job
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/products/:id/refresh-start — enqueue a refresh job for one product
//
// Body: { syncSource?: boolean }
//   - false (default) → just re-runs this product's transformations
//   - true            → triggers source connection sync first, waits for it
//                       to complete, THEN runs transformations. Single click
//                       for the upstream → downstream pipeline.
//
// Returns { jobId } — frontend then attaches via /bus-matrix/:jobId/stream
// (the SSE / cancel / active-job endpoints are mode-agnostic).
// ---------------------------------------------------------------------------
router.post('/:id/refresh-start', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) {
      res.status(400).json({ ok: false, error: 'Invalid product id' });
      return;
    }
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    const product = await semanticDb('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const syncSource = !!(req.body as { syncSource?: boolean })?.syncSource;

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({
        ok: false,
        error: 'Job queue not available — Redis is not configured. Refresh requires Redis to survive browser close.',
      });
      return;
    }

    // Refuse to enqueue a second active refresh for the same product.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find(
      (j) => j.data.tenantId === tenantId && j.data.mode === 'refresh' && j.data.productId === productId,
    );
    if (existing) {
      res.status(409).json({
        ok: false,
        error: 'A refresh is already running for this product.',
        jobId: existing.id,
      });
      return;
    }

    const job = await queue.add('product-refresh', {
      // connectionId is also required by the JobData type; carry it for tenant
      // filtering on the active-jobs endpoint.
      connectionId: Number(product.connection_id ?? 0),
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
      mode: 'refresh' as const,
      productId,
      syncSource,
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix', mode: 'refresh', syncSource } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to start refresh' });
  }
});

router.post('/bus-matrix/start', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({
        ok: false,
        error: 'Job queue not available — Redis is not configured. Bus matrix builds require Redis to survive browser close.',
      });
      return;
    }

    // Refuse to enqueue a second active job for the same connection.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find((j) => j.data.connectionId === connectionId && j.data.tenantId === tenantId);
    if (existing) {
      res.status(409).json({
        ok: false,
        error: 'A bus matrix build is already running for this connection.',
        jobId: existing.id,
      });
      return;
    }

    const job = await queue.add('bus-matrix', {
      connectionId,
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to start bus matrix job' });
  }
});

router.get('/bus-matrix/active', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.json({ ok: true, data: null });
      return;
    }

    const jobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const match = jobs.find((j) =>
      j.data.tenantId === tenantId &&
      (connectionId === undefined || j.data.connectionId === connectionId),
    );

    if (!match) { res.json({ ok: true, data: null }); return; }

    const state = await match.getState();
    res.json({
      ok: true,
      data: {
        jobId: match.id,
        state,
        connectionId: match.data.connectionId,
        progress: match.progress,
        createdAt: match.timestamp,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to query active jobs' });
  }
});

router.post('/bus-matrix/:jobId/cancel', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const { jobId } = req.params;

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({ ok: false, error: 'Job queue not available' });
      return;
    }

    const job = await queue.getJob(jobId);
    if (!job) { res.status(404).json({ ok: false, error: 'Job not found' }); return; }
    if (job.data.tenantId !== tenantId) { res.status(403).json({ ok: false, error: 'Forbidden' }); return; }

    const state = await job.getState();
    const { cancelJob } = await import('../jobs/cancellation');
    const aborted = cancelJob(jobId);

    // If still waiting in the queue, remove it directly.
    if (state === 'waiting' || state === 'delayed') {
      try { await job.remove(); } catch { /* ignore */ }
    }

    res.json({
      ok: true,
      data: {
        jobId,
        priorState: state,
        aborted,
        message: aborted
          ? 'Cancellation signal sent — the worker will stop at the next safe checkpoint.'
          : (state === 'waiting' || state === 'delayed')
            ? 'Job removed from the queue before it started.'
            : 'Cancellation flag set; worker is not currently active in this process.',
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to cancel job' });
  }
});

router.get('/bus-matrix/:jobId/stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const tenantId = req.user?.tenantId;
  const { jobId } = req.params;

  const emit = (data: Record<string, unknown>) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
  };

  const { getBusMatrixQueue } = await import('../jobs/queues');
  const queue = getBusMatrixQueue();
  if (!queue) {
    emit({ type: 'error', message: 'Job queue not available' });
    res.end();
    return;
  }

  const job = await queue.getJob(jobId);
  if (!job) { emit({ type: 'error', message: 'Job not found' }); res.end(); return; }
  if (job.data.tenantId !== tenantId) { emit({ type: 'error', message: 'Forbidden' }); res.end(); return; }

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  // Track which logs we've already sent so polling can resume on reconnect.
  let logCursor = 0;

  const pollLogs = async () => {
    try {
      const { logs } = await queue.getJobLogs(jobId, logCursor, logCursor + 500);
      if (logs.length > 0) {
        for (const line of logs) {
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { /* ignore */ }
          if (parsed) emit(parsed);
          else emit({ type: 'log', text: line });
        }
        logCursor += logs.length;
      }
    } catch { /* job may have been removed */ }
  };

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
  }, 20_000);

  // Poll loop — every 500ms, drain new logs + check state.
  const POLL_MS = 500;
  while (!clientClosed) {
    await pollLogs();

    let state: string;
    try { state = await job.getState(); } catch { state = 'unknown'; }

    if (state === 'completed') {
      await pollLogs();
      const updated = await queue.getJob(jobId);
      emit({ type: 'completed', result: updated?.returnvalue ?? null });
      break;
    }
    if (state === 'failed') {
      await pollLogs();
      const updated = await queue.getJob(jobId);
      emit({ type: 'failed', error: updated?.failedReason ?? 'Job failed' });
      break;
    }
    if (state === 'unknown') {
      emit({ type: 'failed', error: 'Job vanished from queue' });
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  clearInterval(keepalive);
  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/products/bus-matrix-stream — SSE streaming enterprise bus matrix
// One AI call designs ALL dims + ALL facts + groupings. Replaces propose + design.
// (LEGACY — kept for backward compat. New flow uses /bus-matrix/start.)
// ---------------------------------------------------------------------------

router.post('/bus-matrix-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const reqId = `bms-${Date.now().toString(36)}`;
  const startTs = Date.now();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable any proxy buffering
  res.flushHeaders();

  console.log(`[${reqId}] bus-matrix-stream START (connectionId=${(req.body as { connectionId?: number })?.connectionId})`);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    console.warn(`[${reqId}] CLIENT DISCONNECTED after ${Date.now() - startTs}ms`);
  });

  const emit = (data: Record<string, unknown>) => {
    try {
      const written = res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (!written) {
        console.warn(`[${reqId}] res.write returned false (backpressure) type=${data.type as string}`);
      }
    } catch (err) {
      console.error(`[${reqId}] res.write failed type=${data.type as string}:`, err instanceof Error ? err.message : err);
    }
  };

  let keepaliveInterval: NodeJS.Timeout | null = null;

  try {
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { emit({ type: 'error', message: 'connectionId required' }); res.end(); return; }

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) { emit({ type: 'error', message: 'Connection not found' }); res.end(); return; }

    emit({ type: 'phase', text: `Reading schema for ${connection.name}…` });

    // Build source context WITHOUT example values to keep the prompt compact
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

    // Pull confirmed FK relationships from Neo4j so the AI knows the actual joins
    // instead of inferring them from column names (root cause of phantom join cols
    // like dc.source_system that crash the build).
    let relationshipsText = '';
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
      }
    } catch (err) {
      console.warn(`[${reqId}] Failed to load Neo4j relationships:`, err instanceof Error ? err.message : err);
    }

    const sourceContext = tablesText + relationshipsText;

    emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables, ${relationshipsText ? relationshipsText.split('\n').length - 2 : 0} relationships — designing bus matrix…` });

    // Send SSE keepalive comments every 20 seconds to prevent Azure / proxy timeout
    // during the (potentially long) AI generation phase.
    keepaliveInterval = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* connection already closed */ }
    }, 20_000);

    const { generateBusMatrixStreaming } = await import('../ai/AIService');

    let busMatrix: Awaited<ReturnType<typeof generateBusMatrixStreaming>>;
    const aiStart = Date.now();
    try {
      busMatrix = await generateBusMatrixStreaming(
        connection.name as string,
        sourceContext,
        (type, delta) => {
          if (clientDisconnected) return; // don't fight with a dead socket
          if (type === 'thinking') emit({ type: 'thinking', text: delta });
          else if (type === 'diag') emit({ type: 'diag', text: delta });
        },
      );
      console.log(`[${reqId}] AI call completed in ${Date.now() - aiStart}ms`);
    } catch (aiErr) {
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      const msg = aiErr instanceof Error ? aiErr.message : 'AI call failed';
      console.error(`[${reqId}] AI call FAILED after ${Date.now() - aiStart}ms:`, msg, aiErr instanceof Error ? aiErr.stack : '');
      emit({ type: 'error', message: `AI design failed: ${msg}` });
      res.end();
      return;
    }

    if (keepaliveInterval) clearInterval(keepaliveInterval);
    console.log(`[${reqId}] Emitting 'done' (total ${Date.now() - startTs}ms, dims=${busMatrix.conformed_dimensions?.length ?? 0}, facts=${busMatrix.fact_tables?.length ?? 0})`);
    emit({ type: 'done', busMatrix });
  } catch (err) {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    console.error(`[${reqId}] Outer error after ${Date.now() - startTs}ms:`, err instanceof Error ? err.message : err, err instanceof Error ? err.stack : '');
    try {
      emit({ type: 'error', message: err instanceof Error ? err.message : 'Bus matrix design failed' });
    } catch { /* response already closed */ }
  }
  console.log(`[${reqId}] res.end() (total ${Date.now() - startTs}ms, clientDisconnected=${clientDisconnected})`);
  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/products/build-bus-matrix — Persist a bus matrix design to DB
// Creates data products, star schemas, tables (with SQL), columns, relationships.
// ---------------------------------------------------------------------------

router.post('/build-bus-matrix', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const reqId = `bm-save-${Date.now().toString(36)}`;
  try {
    const { connectionId, busMatrix } = req.body as {
      connectionId: number;
      busMatrix: import('../ai/prompts/busMatrixPrompt').BusMatrixOutput;
    };
    if (!connectionId || !busMatrix) {
      res.status(400).json({ ok: false, error: 'connectionId and busMatrix required' });
      return;
    }

    // Pre-flight: validate the bus matrix shape so we fail fast with a readable
    // message instead of a cryptic DB constraint error. Any of these being wrong
    // means the AI output was truncated/malformed and the auto-repair produced
    // incomplete data.
    const validationErrors: string[] = [];
    if (!Array.isArray(busMatrix.conformed_dimensions)) validationErrors.push('conformed_dimensions missing or not an array');
    if (!Array.isArray(busMatrix.fact_tables)) validationErrors.push('fact_tables missing or not an array');
    if (!Array.isArray(busMatrix.data_products)) validationErrors.push('data_products missing or not an array');
    (busMatrix.data_products ?? []).forEach((dp, i) => {
      if (!dp.name) validationErrors.push(`data_products[${i}].name missing`);
      if (!Array.isArray(dp.owned_dimensions)) validationErrors.push(`data_products[${i}] "${dp.name}": owned_dimensions missing`);
      if (!Array.isArray(dp.fact_tables)) validationErrors.push(`data_products[${i}] "${dp.name}": fact_tables missing`);
      if (typeof dp.build_order !== 'number') validationErrors.push(`data_products[${i}] "${dp.name}": build_order missing`);
    });
    (busMatrix.conformed_dimensions ?? []).forEach((d, i) => {
      if (!d.table_name) validationErrors.push(`conformed_dimensions[${i}].table_name missing`);
      if (!Array.isArray(d.columns)) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": columns missing`);
      if (!Array.isArray(d.source_tables)) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": source_tables missing`);
      if (!d.transformation_sql) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql missing`);
    });
    (busMatrix.fact_tables ?? []).forEach((f, i) => {
      if (!f.table_name) validationErrors.push(`fact_tables[${i}].table_name missing`);
      if (!Array.isArray(f.columns)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": columns missing`);
      if (!Array.isArray(f.source_tables)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": source_tables missing`);
      if (!Array.isArray(f.dimensions_used)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": dimensions_used missing`);
      if (!f.transformation_sql) validationErrors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql missing`);
    });

    console.log(`[${reqId}] build-bus-matrix START: ${busMatrix.conformed_dimensions?.length ?? 0} dims, ${busMatrix.fact_tables?.length ?? 0} facts, ${busMatrix.data_products?.length ?? 0} products, ${validationErrors.length} validation errors`);

    if (validationErrors.length > 0) {
      console.error(`[${reqId}] bus matrix failed validation:`, validationErrors.slice(0, 20));
      res.status(400).json({
        ok: false,
        error: 'Bus matrix is incomplete — the AI output was likely truncated. Retry the design.',
        details: validationErrors.slice(0, 10),
      });
      return;
    }

    const tenantId = req.user?.tenantId;
    const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');

    // Wrap in a transaction — all-or-nothing to avoid partial state on failure
    const results = await semanticDb.transaction(async (trx) => {

    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);

    // Build lookup maps for dims and facts
    const dimByName = new Map(busMatrix.conformed_dimensions.map((d) => [d.table_name, d]));
    const factByName = new Map(busMatrix.fact_tables.map((f) => [f.table_name, f]));

    // Sort products by build_order
    const sortedProducts = [...busMatrix.data_products].sort((a, b) => a.build_order - b.build_order);

    const productIdByName = new Map<string, number>();
    const _results: Array<{ name: string; id: number; status: string }> = [];

    // Collect all source table names used across dims + facts for data_product_sources
    const allSourceTablesByProduct = new Map<string, Set<string>>();
    for (const dp of sortedProducts) {
      const srcSet = new Set<string>();
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (dim) dim.source_tables.forEach((s) => srcSet.add(s));
      }
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (fact) fact.source_tables.forEach((s) => srcSet.add(s));
      }
      allSourceTablesByProduct.set(dp.name, srcSet);
    }

    // Track which product owns which dim (for dependency resolution)
    const dimOwnerProduct = new Map<string, string>();
    for (const dp of sortedProducts) {
      for (const dimName of dp.owned_dimensions) {
        dimOwnerProduct.set(dimName, dp.name);
      }
    }

    for (const dp of sortedProducts) {
      // Create data_product row
      const [productRow] = await trx('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        created_by: req.user?.email || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productRow === 'object' ? (productRow as { id: number }).id : (productRow as number);
      productIdByName.set(dp.name, pid);

      // Record dependencies: for each fact's dimensions_used, if the dim is owned by another product, add dependency
      const depProductNames = new Set<string>();
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue; // dim_date is auto-injected, no dependency needed
          const owner = dimOwnerProduct.get(dimName);
          if (owner && owner !== dp.name) depProductNames.add(owner);
        }
      }
      for (const depName of depProductNames) {
        const sourceId = productIdByName.get(depName);
        if (sourceId) {
          await trx('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      // Create star schema for this product
      const allTablesInProduct = [...dp.owned_dimensions, ...dp.fact_tables];
      const primaryFact = dp.fact_tables[0] ? factByName.get(dp.fact_tables[0]) : null;

      const [schemaRow] = await trx('star_schemas').insert({
        data_product_id: pid,
        name: dp.name,
        description: dp.description,
        grain: primaryFact?.grain ?? 'Conformed dimensions',
        fact_table_type: primaryFact?.fact_table_type ?? 'transaction',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const schemaId = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      // Insert owned dimensions
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (!dim) {
          console.warn(`[build-bus-matrix] Product "${dp.name}": owned dimension "${dimName}" not found in conformed_dimensions — skipping`);
          continue;
        }

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: dim.table_name,
          display_name: dim.display_name,
          description: dim.description,
          table_role: 'dimension',
          // OWNER row — this product materialises the dim. Stubs in
          // downstream products are inserted with is_shared_dimension=true
          // in the fact-tables loop below.
          is_shared_dimension: false,
          dag_order: 0,
          transformation_sql: dim.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(dim.table_name, tableId);

        // Insert columns
        for (const col of dim.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }
      }

      // Insert fact tables
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) {
          console.warn(`[build-bus-matrix] Product "${dp.name}": fact table "${factName}" not found in fact_tables — skipping`);
          continue;
        }

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: fact.table_name,
          display_name: fact.display_name,
          description: fact.description,
          table_role: 'fact',
          is_shared_dimension: false,
          dag_order: 1,
          transformation_sql: fact.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(fact.table_name, tableId);

        for (const col of fact.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }

        // Also add referenced shared dims (from other products) as stub entries
        // so the star schema has complete info for querying
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          if (dp.owned_dimensions.includes(dimName)) continue; // Already added above
          const dim = dimByName.get(dimName);
          if (!dim || tableNameToId.has(dimName)) continue;

          const [stubRow] = await trx('product_tables').insert({
            star_schema_id: schemaId,
            table_name: dim.table_name,
            display_name: dim.display_name,
            description: dim.description,
            table_role: 'dimension',
            is_shared_dimension: true,
            dag_order: 0,
            transformation_sql: null, // Not built here — owned by another product
            transformation_status: 'draft',
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).returning('id');
          const stubId = typeof stubRow === 'object' ? (stubRow as { id: number }).id : (stubRow as number);
          tableNameToId.set(dim.table_name, stubId);

          // Insert dim columns as metadata (for query context)
          for (const col of dim.columns) {
            await trx('product_columns').insert({
              product_table_id: stubId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            });
          }
        }
      }

      // Auto-inject dim_date
      const dateRange = busMatrix.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };
      const isFirstBuilder = dp.build_order === 1;
      const [dimDateRow] = await trx('product_tables').insert({
        star_schema_id: schemaId,
        table_name: 'dim_date',
        display_name: 'Date',
        description: 'Auto-generated calendar dimension',
        table_role: 'dimension',
        // Only the first product in build order materializes dim_date.
        // All later products treat it as a conformed (shared) dimension and
        // load it from the owning product's parquet at run time.
        is_shared_dimension: !isFirstBuilder,
        dag_order: 0,
        transformation_sql: isFirstBuilder ? DIM_DATE_SQL(dateRange.start, dateRange.end) : null,
        transformation_status: 'draft',
        ai_draft: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const dimDateId = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await trx('product_columns').insert({
          product_table_id: dimDateId,
          column_name: col.column_name,
          data_type: col.data_type,
          display_name: col.display_name,
          description: col.description,
          column_role: col.column_role,
          transformation_expression: col.transformation_expression,
          scd_type: col.scd_type,
          sort_order: col.sort_order,
          ai_draft: false,
        });
      }

      // Save relationships for tables in this product
      for (const rel of busMatrix.relationships) {
        const fromId = tableNameToId.get(rel.from_table_name);
        const toId = tableNameToId.get(rel.to_table_name);
        if (fromId && toId) {
          await trx('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromId,
            from_column_name: rel.from_column_name,
            to_table_id: toId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // Populate data_product_sources
      const srcSet = allSourceTablesByProduct.get(dp.name);
      if (srcSet && srcSet.size > 0) {
        const sourceTblRows = await trx('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...srcSet])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await trx('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            })),
          );
        }
      }

      // Save KPIs for this product
      const productKpis = (busMatrix.proposed_kpis ?? []).filter((k) => k.product_name === dp.name);
      if (productKpis.length > 0) {
        await trx('product_kpis').insert(
          productKpis.map((k) => ({
            data_product_id: pid,
            name: k.name,
            description: k.description,
            formula_plain_text: k.formula_plain_text,
            formula_sql: k.formula_sql,
            ai_draft: true,
          })),
        );
      }

      // Mark as approved (ready to run)
      await trx('data_products').where({ id: pid }).update({
        status: 'approved',
        updated_at: new Date().toISOString(),
      });

      // Count tables actually inserted for this product
      const tableCount = await trx('product_tables').where({ star_schema_id: schemaId }).count('id as count').first();
      const count = Number(tableCount?.count ?? 0);
      console.log(`[build-bus-matrix] Product "${dp.name}" (id=${pid}): ${count} tables created (owned_dims: ${dp.owned_dimensions.length}, facts: ${dp.fact_tables.length})`);

      _results.push({ name: dp.name, id: pid, status: 'created' });
    }

    // Summary
    console.log(`[build-bus-matrix] Summary: AI designed ${busMatrix.conformed_dimensions?.length ?? 0} dims + ${busMatrix.fact_tables?.length ?? 0} facts → ${_results.length} products`);

    return _results;

    }); // end transaction

    console.log(`[${reqId}] build-bus-matrix SUCCESS: ${results.length} products created`);
    res.json({ ok: true, data: { products: results } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.code ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (err as any)?.detail ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const constraint = (err as any)?.constraint ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = (err as any)?.table ?? null;
    console.error(`[${reqId}] build-bus-matrix FAILED: ${msg}`, { code, detail, constraint, table, stack });
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: `Failed to save bus matrix: ${msg}`,
        details: { code, constraint, table, detail },
      });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-stream — SSE streaming version of /propose
// Streams Claude's thinking tokens live so the browser shows progress immediately.
// (LEGACY — kept for backward compat; new flow uses bus-matrix-stream)
// ---------------------------------------------------------------------------

router.post('/propose-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { emit({ type: 'error', message: 'connectionId required' }); res.end(); return; }

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) { emit({ type: 'error', message: 'Connection not found' }); res.end(); return; }

    emit({ type: 'phase', text: `Reading schema for ${connection.name}…` });

    // Same data-gathering as /propose
    const sourceTables = await semanticDb('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables — asking Claude to plan the warehouse…` });

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await semanticDb('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure', 'example_values');
      const fkRels = await semanticDb('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');
      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));
      const bkCol = t.business_key_column as string | null;
      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: c.column_name === 'id' || c.column_name === bkCol,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    const existingProducts = await semanticDb('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await semanticDb('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateBusMatrixStreaming } = await import('../ai/AIService');

    const sourceTablesContextStream = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const proposal = await generateBusMatrixStreaming(
      connection.name as string,
      sourceTablesContextStream,
      (type, delta) => {
        if (type === 'thinking') emit({ type: 'thinking', text: delta });
      },
    );

    emit({ type: 'done', proposal });
  } catch (err) {
    console.error('[products/propose-stream] Error:', err);
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
  }
  res.end();
});

// POST /api/products/propose — AI auto-proposes all data products for a connection
// ---------------------------------------------------------------------------

router.post('/propose', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { res.status(400).json({ ok: false, error: 'connectionId required' }); return; }

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }

    // Gather semantic context from Postgres + Neo4j
    const sourceTables = await semanticDb('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await semanticDb('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure', 'example_values');

      // Derive FK info from table_relationships (from_column_id → to source_tables)
      const fkRels = await semanticDb('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');

      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));

      // Heuristic: column named 'id' or matching business_key_column is PK
      const bkCol = t.business_key_column as string | null;

      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          const isPk = c.column_name === 'id' || c.column_name === bkCol;
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: isPk,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    // Existing products (so Claude doesn't recreate them)
    const existingProducts = await semanticDb('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await semanticDb('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateBusMatrixStreaming: generateBusMatrix } = await import('../ai/AIService');
    const sourceTablesContextProp = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const proposal = await generateBusMatrix(connection.name as string, sourceTablesContextProp, () => {});

    res.json({ ok: true, data: proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/build-proposed — persist + queue a full proposal
// ---------------------------------------------------------------------------

router.post('/build-proposed', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, proposal } = req.body as {
      connectionId: number;
      proposal: import('../ai/prompts/dataProductProposalPrompt').DataProductProposal;
    };
    if (!connectionId || !proposal) { res.status(400).json({ ok: false, error: 'connectionId and proposal required' }); return; }

    const tenantId = req.user?.tenantId;

    // Sort products by build_order so owners are created before dependents
    const sorted = [...proposal.data_products].sort((a, b) => a.build_order - b.build_order);

    // Map product name → DB id (populated as we insert)
    const productIdByName = new Map<string, number>();

    const results: Array<{ name: string; id: number; status: string }> = [];

    for (const dp of sorted) {
      // Create data_product row
      const [productId] = await semanticDb('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        created_by: req.user?.email || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productId === 'object' ? (productId as { id: number }).id : productId;
      productIdByName.set(dp.name, pid);

      // Record dependencies
      for (const dep of dp.depends_on) {
        const sourceId = productIdByName.get(dep.source_product_name);
        if (sourceId) {
          await semanticDb('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      // Create star schemas + tables
      for (const ss of dp.star_schemas) {
        const [schemaId] = await semanticDb('star_schemas').insert({
          data_product_id: pid,
          name: ss.name,
          description: ss.description,
          grain: ss.grain,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const ssid = typeof schemaId === 'object' ? (schemaId as { id: number }).id : schemaId;

        for (const tbl of ss.tables) {
          await semanticDb('product_tables').insert({
            star_schema_id: ssid,
            table_name: tbl.table_name,
            display_name: tbl.display_name,
            description: tbl.description,
            table_role: tbl.table_role,
            is_shared_dimension: tbl.is_shared_dimension,
            transformation_sql: null,          // generated later via AI Design
            transformation_status: 'draft',
            dag_order: tbl.dag_order,
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Populate data_product_sources so AI Design Star Schema can find source table context
      const allSourceTableNames = new Set<string>();
      for (const ss of dp.star_schemas) {
        for (const tbl of ss.tables) {
          for (const src of tbl.source_tables) {
            allSourceTableNames.add(src);
          }
        }
      }
      if (allSourceTableNames.size > 0) {
        const sourceTblRows = await semanticDb('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...allSourceTableNames])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await semanticDb('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            }))
          );
        }
      }

      results.push({ name: dp.name, id: pid, status: 'created' });
    }

    // Queue transformations in build_order (one job per product)
    try {
      const { getTransformationQueue } = await import('../jobs/queues');
      const tQueue = getTransformationQueue();
      if (tQueue) {
        for (const r of results) {
          await tQueue.add('transform', { productId: r.id, tenantId, triggeredBy: 'system' });
        }
      }
    } catch {
      // Redis not available — caller can trigger manually
    }

    res.json({ ok: true, data: { products: results } });
  } catch (err) { next(err); }
});

export default router;

/**
 * Products router (3/9): AI star-schema design (streaming + non-streaming)
 * and the run-all-transformations + run-single-table triggers... note the
 * single-table run lives in tables.ts; this module ends at POST /:id/run.
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { syncProductToNeo4j } from '../../services/productGraphSync';
import { reqDb } from '../../db/reqDb';
import { tenantScopedWrite } from '../../db/tenantScopedWrite';
import { startSSE } from '../../services/sse';
import { log } from './shared';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/products/:id/design-stream — SSE streaming AI star schema design
// Streams thinking tokens, phase updates, and table previews as they appear.
// ---------------------------------------------------------------------------

router.post('/:id/design-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  // SSE setup
  const sse = startSSE(res);

  const emit = (data: Record<string, unknown>) => sse.emit(data);

  const db = reqDb(req);
  try {
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      emit({ type: 'error', message: 'Data product not found' });
      sse.end(); return;
    }

    const sources = await db('data_product_sources').where({ data_product_id: product.id });
    if (sources.length === 0) {
      emit({ type: 'error', message: 'No source tables selected for this data product' });
      sse.end(); return;
    }

    // Mark as designing
    await db('data_products').where({ id: product.id }).update({
      status: 'designing', updated_at: new Date().toISOString(),
    });

    emit({ type: 'phase', text: `Reading ${sources.length} source tables...` });

    // Build source context
    const sourceTableNames = sources.map((s: { table_name: string }) => s.table_name);
    const sourceTables = await db('source_tables')
      .where({ connection_id: product.connection_id, is_active: true })
      .whereIn('table_name', sourceTableNames);

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await db('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
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
      const deps = await db('data_product_dependencies as dpd')
        .join('data_products as dp', 'dpd.source_product_id', 'dp.id')
        .where('dpd.dependent_product_id', product.id)
        .select('dpd.source_product_id', 'dp.name as source_product_name');

      if (deps.length > 0) {
        const sharedDimBlocks: string[] = [];
        for (const dep of deps) {
          // Owners (is_shared_dimension=false) live in the upstream product
          // and have transformation_sql. Stubs in downstream products are
          // is_shared_dimension=true with null SQL — we want the owners here.
          const sharedTables = await db('product_tables as pt')
            .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
            .where({ 'ss.data_product_id': dep.source_product_id, 'pt.is_shared_dimension': false })
            .where('pt.table_role', 'dimension')
            .whereNotNull('pt.transformation_sql')
            .select('pt.id', 'pt.table_name', 'pt.display_name', 'pt.description');

          for (const tbl of sharedTables) {
            const cols = await db('product_columns')
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
      log.warn({ err: depErr }, '[products/design-stream] Could not load dependency dims');
    }

    const fullSourceContext = sharedDimsContext
      ? `${sourceContext}\n\n━━━ CONFORMED DIMENSIONS (owned by other products — JOIN to these, do NOT rebuild) ━━━\n\n${sharedDimsContext}`
      : sourceContext;

    emit({ type: 'phase', text: 'Designing star schema with AI...' });

    // ── Phase 1: Streaming star schema design ─────────────────────────────
    const { generateStarSchemaDesignStreaming } = await import('../../ai/AIService');

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
    await db('star_schemas').where({ data_product_id: product.id }).delete();

    const allSavedTables: { name: string; role: string; columnCount: number }[] = [];

    const schema = design.star_schema;
    {
      const [schemaRow] = await db('star_schemas')
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
        const [tableRow] = await db('product_tables')
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
          const [colRow] = await db('product_columns')
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
            await db('column_lineage').insert(
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
          await db('product_relationships').insert({
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
      const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../../ai/prompts/starSchemaPrompt');
      const dateRange = design.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };

      const [dimDateRow] = await db('product_tables')
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
        await db('product_columns')
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
      await db('product_kpis').insert(
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

    await db('data_products').where({ id: product.id }).update({
      status: 'approved', updated_at: new Date().toISOString(),
    });

    emit({ type: 'design_complete', tables: allSavedTables });

    emit({ type: 'sql_complete', tablesUpdated: allSavedTables.length });

    // Sync product graph to Neo4j for data dictionary
    await syncProductToNeo4j(product.id);

    emit({ type: 'done' });
    sse.end();
  } catch (err: unknown) {
    log.error({ err }, '[products/design-stream] Error');
    // Mark the product as errored in a FRESH transaction. The request
    // trx (`db`) may already be poisoned by whatever blew up upstream
    // (Postgres rejects every statement in a failed trx with 25P02);
    // writing to it would silently no-op. tenantScopedWrite opens its
    // own short trx with the user's tenant context set, so this
    // diagnostic update lands even when the request trx is in
    // failed state.
    const productId = Number(req.params.id);
    if (req.user?.tenantId && Number.isFinite(productId)) {
      try {
        await tenantScopedWrite(req.user.tenantId, (trx) =>
          trx('data_products').where({ id: productId }).update({
            status: 'error', updated_at: new Date().toISOString(),
          }),
        );
      } catch (markErr) {
        log.error({ err: markErr }, '[products/design-stream] failed to mark errored');
      }
    }
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Design failed. Please try again.' });
    sse.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/design — Trigger AI star schema design (non-streaming)
// ---------------------------------------------------------------------------

router.post('/:id/design', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const db = reqDb(req);
  try {
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Get source tables
    const sources = await db('data_product_sources')
      .where({ data_product_id: product.id });

    if (sources.length === 0) {
      res.status(400).json({ ok: false, error: 'No source tables selected for this data product' });
      return;
    }

    // Mark as designing
    await db('data_products').where({ id: product.id }).update({
      status: 'designing',
      updated_at: new Date().toISOString(),
    });

    // Build source context for AI
    const sourceTableNames = sources.map((s: { table_name: string }) => s.table_name);
    const sourceTables = await db('source_tables')
      .where({ connection_id: product.connection_id, is_active: true })
      .whereIn('table_name', sourceTableNames);

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await db('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
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
    const { generateStarSchemaDesign } = await import('../../ai/AIService');
    const design = await generateStarSchemaDesign(
      product.name,
      product.description ?? '',
      sourceContext,
    );

    // Delete existing schemas for this product (re-design)
    await db('star_schemas').where({ data_product_id: product.id }).delete();

    // Save the design
    const schema = design.star_schema;
    {
      const [schemaRow] = await db('star_schemas')
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
        const [tableRow] = await db('product_tables')
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
          const [colRow] = await db('product_columns')
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
            await db('column_lineage').insert(
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
          await db('product_relationships').insert({
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
      const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../../ai/prompts/starSchemaPrompt');
      const dateRange = design.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };

      const [dimDateRow] = await db('product_tables')
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
        await db('product_columns')
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
      await db('product_kpis').insert(
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
    await db('data_products').where({ id: product.id }).update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    });

    // Sync product graph to Neo4j for data dictionary
    await syncProductToNeo4j(product.id);

    res.json({ ok: true, data: { status: 'approved', sqlGenerated: true } });
  } catch (err) {
    // Revert status on error. Same trx-poison rationale as the
    // /design-stream handler above — use a fresh tenantScopedWrite
    // so the "mark as error" update isn't lost when req.dbTrx has
    // already been poisoned upstream.
    const productId = Number(req.params.id);
    if (req.user?.tenantId && Number.isFinite(productId)) {
      try {
        await tenantScopedWrite(req.user.tenantId, (trx) =>
          trx('data_products').where({ id: productId }).update({
            status: 'error',
            updated_at: new Date().toISOString(),
          }),
        );
      } catch (markErr) {
        log.error({ err: markErr }, 'failed to mark errored');
      }
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/run — Run all transformations for a data product
// ---------------------------------------------------------------------------

router.post('/:id/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await db('star_schemas').where({ data_product_id: product.id });
    const schemaIds = schemas.map((s: { id: number }) => s.id);

    const fetchTables = () => schemaIds.length
      ? db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .where((qb) => {
                // Stubs (shared dims from another product) carry no SQL — the
                // runner's skip-path publishes them from the upstream owner, which
                // is also what flips their status to 'success'. Excluding them
                // left every stub at 'draft' forever (found 2026-08-24 via the
                // topics canvas drawing zero relations).
                qb.whereNotNull('transformation_sql').orWhere('is_shared_dimension', true);
              })
          .orderBy('dag_order', 'asc')
      : Promise.resolve([]);

    const { runProductTransformation } = await import('../../services/transformationRunner');

    const tables = await fetchTables();
    const results = await runProductTransformation(product, tables, req.user?.tenantId);

    // Sync updated row counts / status to Neo4j
    syncProductToNeo4j(product.id).catch(() => {}); // non-db — Neo4j graph sync, not a request-trx Knex query

    res.json({ ok: true, data: results });
  } catch (err) { next(err); }
});


export default router;

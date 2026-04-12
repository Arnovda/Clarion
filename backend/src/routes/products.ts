import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { parsePagination, paginatedResponse } from '../utils/paginate';

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

    res.json(paginatedResponse(products, Number(total), page, limit));
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
    const tables = schemaIds.length
      ? await semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];

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

    const result = {
      ...product,
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
    const deleted = await semanticDb('data_products').where({ id: req.params.id }).delete();
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }
    res.json({ ok: true });
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
          const sharedTables = await semanticDb('product_tables as pt')
            .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
            .where({ 'ss.data_product_id': dep.source_product_id, 'pt.is_shared_dimension': true })
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
    const { generateStarSchemaDesignStreaming, generateTransformationSqlStreaming } = await import('../ai/AIService');

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

    for (const schema of design.star_schemas) {
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
            transformation_status: 'draft',
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

    // ── Phase 2: Auto-generate transformation SQL ─────────────────────────
    emit({ type: 'phase', text: 'Generating transformation SQL...' });

    try {
      const savedSchemas = await semanticDb('star_schemas').where({ data_product_id: product.id });
      const savedSchemaIds = savedSchemas.map((s: { id: number }) => s.id);
      const savedTables = savedSchemaIds.length
        ? await semanticDb('product_tables').whereIn('star_schema_id', savedSchemaIds).orderBy(['dag_order', 'table_name'])
        : [];
      const savedTableIds = savedTables.map((t: { id: number }) => t.id);
      const savedColumns = savedTableIds.length
        ? await semanticDb('product_columns').whereIn('product_table_id', savedTableIds).orderBy(['sort_order', 'id'])
        : [];

      const schemaJsonForSql = savedSchemas.map((s: { id: number; name: string; grain: string }) => ({
        ...s,
        tables: savedTables
          .filter((t: { star_schema_id: number }) => t.star_schema_id === s.id)
          .map((t: { id: number; table_name: string; table_role: string; description: string }) => ({
            ...t,
            columns: savedColumns.filter((c: { product_table_id: number }) => c.product_table_id === t.id),
          })),
      }));

      const rawTableNames = sources.map((s: { table_name: string }) => s.table_name).join(', ');
      const sqlSourceContext = sharedDimsContext
        ? `${rawTableNames}\n\n━━━ CONFORMED DIMENSIONS (pre-built views — JOIN directly by table name) ━━━\n\n${sharedDimsContext}`
        : rawTableNames;
      const sqlResult = await generateTransformationSqlStreaming(
        JSON.stringify(schemaJsonForSql),
        sqlSourceContext,
        (type, delta) => {
          if (type === 'thinking') {
            emit({ type: 'sql_thinking', text: delta });
          }
        },
      );

      for (const item of sqlResult.tables) {
        await semanticDb('product_tables')
          .whereIn('star_schema_id', savedSchemaIds)
          .where({ table_name: item.table_name })
          .update({
            transformation_sql: item.sql,
            transformation_status: 'draft',
            updated_at: new Date().toISOString(),
          });
      }

      emit({ type: 'sql_complete', tablesUpdated: sqlResult.tables.length });
    } catch (sqlErr) {
      console.warn('[products/design-stream] SQL generation failed:', sqlErr);
      emit({ type: 'sql_error', message: 'SQL generation failed — you can retry from the Transformations tab.' });
    }

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
    for (const schema of design.star_schemas) {
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
            transformation_status: 'draft',
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

    // Auto-chain: generate transformation SQL immediately after design
    try {
      const savedSchemas = await semanticDb('star_schemas').where({ data_product_id: product.id });
      const savedSchemaIds = savedSchemas.map((s: { id: number }) => s.id);
      const savedTables = savedSchemaIds.length
        ? await semanticDb('product_tables').whereIn('star_schema_id', savedSchemaIds).orderBy(['dag_order', 'table_name'])
        : [];
      const savedTableIds = savedTables.map((t: { id: number }) => t.id);
      const savedColumns = savedTableIds.length
        ? await semanticDb('product_columns').whereIn('product_table_id', savedTableIds).orderBy(['sort_order', 'id'])
        : [];

      const schemaJsonForSql = savedSchemas.map((s: { id: number; name: string; grain: string }) => ({
        ...s,
        tables: savedTables
          .filter((t: { star_schema_id: number }) => t.star_schema_id === s.id)
          .map((t: { id: number; table_name: string; table_role: string; description: string }) => ({
            ...t,
            columns: savedColumns.filter((c: { product_table_id: number }) => c.product_table_id === t.id),
          })),
      }));

      const sqlSourceContext = sources.map((s: { table_name: string }) => s.table_name).join(', ');
      const { generateTransformationSql } = await import('../ai/AIService');
      const sqlResult = await generateTransformationSql(JSON.stringify(schemaJsonForSql), sqlSourceContext);

      for (const item of sqlResult.tables) {
        await semanticDb('product_tables')
          .whereIn('star_schema_id', savedSchemaIds)
          .where({ table_name: item.table_name })
          .update({
            transformation_sql: item.sql,
            transformation_status: 'draft',
            updated_at: new Date().toISOString(),
          });
      }
    } catch (sqlErr) {
      console.warn('[products/design] Auto SQL generation failed (non-blocking):', sqlErr);
    }

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
// POST /api/products/:id/generate-sql — Generate transformation SQL for all tables
// ---------------------------------------------------------------------------

router.post('/:id/generate-sql', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Get all star schemas + tables for this product
    const schemas = await semanticDb('star_schemas').where({ data_product_id: product.id });
    const schemaIds = schemas.map((s: { id: number }) => s.id);

    const tables = schemaIds.length
      ? await semanticDb('product_tables').whereIn('star_schema_id', schemaIds).orderBy(['dag_order', 'table_name'])
      : [];

    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await semanticDb('product_columns').whereIn('product_table_id', tableIds).orderBy(['sort_order', 'id'])
      : [];

    // Build the schema JSON for the AI
    const schemaJson = schemas.map((s: { id: number; name: string; grain: string }) => ({
      ...s,
      tables: tables
        .filter((t: { star_schema_id: number }) => t.star_schema_id === s.id)
        .map((t: { id: number; table_name: string; table_role: string; description: string }) => ({
          ...t,
          columns: columns.filter((c: { product_table_id: number }) => c.product_table_id === t.id),
        })),
    }));

    // Get source table context
    const sources = await semanticDb('data_product_sources').where({ data_product_id: product.id });
    const sourceContext = sources.map((s: { table_name: string }) => s.table_name).join(', ');

    const { generateTransformationSql } = await import('../ai/AIService');
    const result = await generateTransformationSql(JSON.stringify(schemaJson), sourceContext);

    // Update each table's SQL
    for (const item of result.tables) {
      await semanticDb('product_tables')
        .whereIn('star_schema_id', schemaIds)
        .where({ table_name: item.table_name })
        .update({
          transformation_sql: item.sql,
          transformation_status: 'draft',
          updated_at: new Date().toISOString(),
        });
    }

    res.json({ ok: true, data: { tablesUpdated: result.tables.length } });
  } catch (err) { next(err); }
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
    const { repairTransformationSql } = await import('../ai/AIService');

    let tables = await fetchTables();
    let results = await runProductTransformation(product, tables, req.user?.tenantId);

    // ── Build source-column context once (for repair loop) ─────────────
    // These are the REAL column names from the source database — used to
    // correct hallucinated names like "stad" when the source has "city".
    const sourceColRows = await semanticDb('source_columns as sc')
      .join('source_tables as st', 'sc.table_id', 'st.id')
      .where({ 'st.connection_id': product.connection_id, 'st.is_active': true })
      .select('st.table_name', 'sc.column_name', 'sc.data_type');

    const sourceColumnsByTable = new Map<string, string>();
    for (const row of sourceColRows as { table_name: string; column_name: string; data_type: string }[]) {
      const key = row.table_name;
      const existing = sourceColumnsByTable.get(key) ?? '';
      sourceColumnsByTable.set(key, existing + `  ${row.column_name} (${row.data_type})\n`);
    }
    const sourceColumnsContext = [...sourceColumnsByTable.entries()]
      .map(([tName, cols]) => `Table "${tName}":\n${cols}`)
      .join('\n');

    // ── Auto-repair loop (up to 2 attempts) ──────────────────────────────
    const MAX_REPAIR = 2;
    for (let attempt = 0; attempt < MAX_REPAIR; attempt++) {
      const failed = results.filter((r) => r.status === 'error' && r.error);
      if (failed.length === 0) break;

      console.log(`[products/run] Auto-repairing ${failed.length} failed table(s), attempt ${attempt + 1}`);

      // Re-fetch tables so SQL reflects any previous repair saves
      tables = await fetchTables();

      const repairedTables: typeof tables = [];

      await Promise.allSettled(failed.map(async (failedResult) => {
        const tbl = tables.find((t: { table_name: string }) => t.table_name === failedResult.table_name);
        if (!tbl?.transformation_sql || !failedResult.error) return;

        // Build expected-columns context from product_columns
        const cols = await semanticDb('product_columns')
          .where({ product_table_id: tbl.id })
          .orderBy('sort_order')
          .select('column_name', 'data_type', 'column_role', 'description');

        const expectedColumns = cols.length
          ? cols.map((c: Record<string, string>) =>
              `  ${c.column_name} (${c.data_type ?? 'VARCHAR'}) [${c.column_role ?? 'attribute'}]${c.description ? ': ' + c.description : ''}`
            ).join('\n')
          : '  (no column metadata available)';

        try {
          const correctedSql = await repairTransformationSql(
            tbl.table_name,
            tbl.table_role,
            tbl.transformation_sql,
            failedResult.error,
            expectedColumns,
            sourceColumnsContext,
          );

          await semanticDb('product_tables')
            .where({ id: tbl.id })
            .update({ transformation_sql: correctedSql, updated_at: new Date().toISOString() });

          repairedTables.push({ ...tbl, transformation_sql: correctedSql });
          console.log(`[products/run] Repaired SQL saved for ${tbl.table_name}`);
        } catch (repairErr) {
          console.warn(`[products/run] Repair AI call failed for ${tbl.table_name}:`, repairErr);
        }
      }));

      if (repairedTables.length === 0) break;

      // Re-run only the repaired tables (in dag_order so dims come before facts)
      const rerunResults = await runProductTransformation(
        product,
        repairedTables.sort((a: { dag_order: number }, b: { dag_order: number }) => a.dag_order - b.dag_order),
        req.user?.tenantId,
      );

      // Merge re-run results back (replace the failed entries)
      results = results.map((r) => rerunResults.find((rr) => rr.table_name === r.table_name) ?? r);
    }
    // ─────────────────────────────────────────────────────────────────────

    res.json({ ok: true, data: results });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/tables/:tableId/run — Run a single table transformation
// ---------------------------------------------------------------------------

router.post('/tables/:tableId/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    let table = await semanticDb('product_tables').where({ id: req.params.tableId }).first();
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
    const { repairTransformationSql } = await import('../ai/AIService');

    let result = (await runProductTransformation(product, [table], req.user?.tenantId))[0] ?? null;

    // ── Build source-column context for repair ─────────────────────────
    const srcColRows = await semanticDb('source_columns as sc')
      .join('source_tables as st', 'sc.table_id', 'st.id')
      .where({ 'st.connection_id': product.connection_id, 'st.is_active': true })
      .select('st.table_name', 'sc.column_name', 'sc.data_type');

    const srcColsByTable = new Map<string, string>();
    for (const row of srcColRows as { table_name: string; column_name: string; data_type: string }[]) {
      const existing = srcColsByTable.get(row.table_name) ?? '';
      srcColsByTable.set(row.table_name, existing + `  ${row.column_name} (${row.data_type})\n`);
    }
    const srcColsContext = [...srcColsByTable.entries()]
      .map(([tName, cols]) => `Table "${tName}":\n${cols}`)
      .join('\n');

    // ── Auto-repair (up to 2 attempts) ───────────────────────────────────
    const MAX_REPAIR = 2;
    for (let attempt = 0; attempt < MAX_REPAIR; attempt++) {
      if (!result || result.status !== 'error' || !result.error || !table.transformation_sql) break;

      console.log(`[tables/run] Auto-repairing ${table.table_name}, attempt ${attempt + 1}: ${result.error}`);

      const cols = await semanticDb('product_columns')
        .where({ product_table_id: table.id })
        .orderBy('sort_order')
        .select('column_name', 'data_type', 'column_role', 'description');

      const expectedColumns = cols.length
        ? cols.map((c: Record<string, string>) =>
            `  ${c.column_name} (${c.data_type ?? 'VARCHAR'}) [${c.column_role ?? 'attribute'}]${c.description ? ': ' + c.description : ''}`
          ).join('\n')
        : '  (no column metadata available)';

      try {
        const correctedSql = await repairTransformationSql(
          table.table_name,
          table.table_role,
          table.transformation_sql,
          result.error,
          expectedColumns,
          srcColsContext,
        );

        await semanticDb('product_tables')
          .where({ id: table.id })
          .update({ transformation_sql: correctedSql, updated_at: new Date().toISOString() });

        table = { ...table, transformation_sql: correctedSql };
        result = (await runProductTransformation(product, [table], req.user?.tenantId))[0] ?? result;
        console.log(`[tables/run] Post-repair status for ${table.table_name}: ${result.status}`);
      } catch (repairErr) {
        console.warn(`[tables/run] Repair AI call failed for ${table.table_name}:`, repairErr);
        break;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    res.json({ ok: true, data: result });
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
// ---------------------------------------------------------------------------
router.post('/:id/run-full', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await semanticDb('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await semanticDb('star_schemas').where({ data_product_id: product.id });
    const schemaIds = schemas.map((s: { id: number }) => s.id);

    const tables = schemaIds.length
      ? await semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .whereNotNull('transformation_sql')
          .orderBy('dag_order', 'asc')
      : [];

    // Override load_mode to 'full' for this run only
    const fullTables = tables.map((t: Record<string, unknown>) => ({ ...t, load_mode: 'full' }));

    const { runProductTransformation } = await import('../services/transformationRunner');
    const { repairTransformationSql } = await import('../ai/AIService');

    let results = await runProductTransformation(product, fullTables as any, req.user?.tenantId);

    // ── Auto-repair loop (same as /run) ──────────────────────────────────
    const srcRows = await semanticDb('source_columns as sc')
      .join('source_tables as st', 'sc.table_id', 'st.id')
      .where({ 'st.connection_id': product.connection_id, 'st.is_active': true })
      .select('st.table_name', 'sc.column_name', 'sc.data_type');
    const srcMap = new Map<string, string>();
    for (const r of srcRows as { table_name: string; column_name: string; data_type: string }[]) {
      srcMap.set(r.table_name, (srcMap.get(r.table_name) ?? '') + `  ${r.column_name} (${r.data_type})\n`);
    }
    const srcCtx = [...srcMap.entries()].map(([t, c]) => `Table "${t}":\n${c}`).join('\n');

    const MAX_REPAIR = 2;
    for (let attempt = 0; attempt < MAX_REPAIR; attempt++) {
      const failed = results.filter((r) => r.status === 'error' && r.error);
      if (failed.length === 0) break;

      console.log(`[products/run-full] Auto-repairing ${failed.length} failed table(s), attempt ${attempt + 1}`);

      const repairedTables: typeof fullTables = [];

      await Promise.allSettled(failed.map(async (failedResult) => {
        const tbl = fullTables.find((t: Record<string, unknown>) => t.table_name === failedResult.table_name);
        if (!tbl?.transformation_sql || !failedResult.error) return;

        const cols = await semanticDb('product_columns')
          .where({ product_table_id: tbl.id })
          .orderBy('sort_order')
          .select('column_name', 'data_type', 'column_role', 'description');

        const expectedColumns = cols.length
          ? cols.map((c: Record<string, string>) =>
              `  ${c.column_name} (${c.data_type ?? 'VARCHAR'}) [${c.column_role ?? 'attribute'}]${c.description ? ': ' + c.description : ''}`
            ).join('\n')
          : '  (no column metadata available)';

        try {
          const correctedSql = await repairTransformationSql(
            tbl.table_name as string, tbl.table_role as string,
            tbl.transformation_sql as string, failedResult.error,
            expectedColumns, srcCtx,
          );
          await semanticDb('product_tables')
            .where({ id: tbl.id })
            .update({ transformation_sql: correctedSql, updated_at: new Date().toISOString() });
          repairedTables.push({ ...tbl, transformation_sql: correctedSql });
          console.log(`[products/run-full] Repaired SQL saved for ${tbl.table_name}`);
        } catch (repairErr) {
          console.warn(`[products/run-full] Repair AI call failed for ${tbl.table_name}:`, repairErr);
        }
      }));

      if (repairedTables.length === 0) break;
      const rerunResults = await runProductTransformation(
        product,
        repairedTables.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          (a.dag_order as number) - (b.dag_order as number)) as any,
        req.user?.tenantId,
      );
      results = results.map((r) => rerunResults.find((rr) => rr.table_name === r.table_name) ?? r);
    }

    res.json({ ok: true, data: results });
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
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': true })
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { proposeSingleDataProduct } = await import('../ai/AIService');

    const proposal = await proposeSingleDataProduct(
      tableContexts,
      existingWithDims,
      connection.name as string,
      description.trim().slice(0, 500),
    );

    return res.json({ ok: true, data: proposal });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to propose data product';
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-stream — SSE streaming version of /propose
// Streams Claude's thinking tokens live so the browser shows progress immediately.
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
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': true })
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { proposeDataProductsStreaming } = await import('../ai/AIService');

    const proposal = await proposeDataProductsStreaming(
      tableContexts,
      existingWithDims,
      connection.name as string,
      (type, delta) => {
        if (type === 'thinking') emit({ type: 'thinking', text: delta });
        // text events are the JSON being built — don't forward (it's raw partial JSON)
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
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': true })
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { proposeDataProducts } = await import('../ai/AIService');
    const proposal = await proposeDataProducts(tableContexts, existingWithDims, connection.name as string);

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
      const { enqueueTransformation } = await import('../jobs/queues');
      for (const r of results) {
        await enqueueTransformation({ productId: r.id, tenantId });
      }
    } catch {
      // Redis not available — caller can trigger manually
    }

    res.json({ ok: true, data: { products: results } });
  } catch (err) { next(err); }
});

export default router;

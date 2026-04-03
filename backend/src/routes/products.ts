import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/products — List all data products
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await semanticDb('data_products')
      .select('data_products.*')
      .select(
        semanticDb.raw('(SELECT COUNT(*) FROM star_schemas WHERE star_schemas.data_product_id = data_products.id) as star_schema_count'),
      )
      .orderBy('data_products.created_at', 'desc');

    res.json({ ok: true, data: products });
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

    emit({ type: 'phase', text: 'Designing star schema with AI...' });

    // ── Phase 1: Streaming star schema design ─────────────────────────────
    const { generateStarSchemaDesignStreaming, generateTransformationSqlStreaming } = await import('../ai/AIService');

    const design = await generateStarSchemaDesignStreaming(
      product.name,
      product.description ?? '',
      sourceContext,
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

      const sqlSourceContext = sources.map((s: { table_name: string }) => s.table_name).join(', ');
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

    const tables = schemaIds.length
      ? await semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .whereNotNull('transformation_sql')
          .orderBy('dag_order', 'asc')
      : [];

    const { runProductTransformation } = await import('../services/transformationRunner');
    const results = await runProductTransformation(product, tables);

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
    const results = await runProductTransformation(product, [table]);

    res.json({ ok: true, data: results[0] ?? null });
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

export default router;

/**
 * Notebooks API — SQL + Python cells for data exploration
 *
 * GET    /api/notebooks                       — list user's notebooks
 * POST   /api/notebooks                       — create new notebook
 * GET    /api/notebooks/:id                   — get notebook with cells
 * PATCH  /api/notebooks/:id                   — update title/description/connection
 * DELETE /api/notebooks/:id                   — delete notebook + cells
 * PATCH  /api/notebooks/:id/star              — toggle starred
 * POST   /api/notebooks/:id/cells             — add a cell
 * PATCH  /api/notebooks/cells/:cellId         — update cell source/type/position
 * DELETE /api/notebooks/cells/:cellId         — delete a cell
 * POST   /api/notebooks/cells/:cellId/execute — execute SQL cell server-side
 * POST   /api/notebooks/:id/reorder           — bulk reorder cells
 * POST   /api/notebooks/:id/duplicate         — clone a notebook
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { parsePagination, paginatedResponse } from '../utils/paginate';
import { callClaudeMultiTurn } from '../ai/AIService';
import { Database } from 'duckdb-async';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin', 'analyst'));

// ─── Helper: build a namespaced DuckDB instance for a connection ──────────────
// Creates schemas for source tables (schema = connection name) and product tables
// (schema = product name), so queries like `SELECT * FROM wholesale_erp.artikelgroepen` work.
async function buildNamespacedDuckDB(connectionId: number): Promise<Database> {
  const connection = await semanticDb('connections').where({ id: connectionId }).first();
  if (!connection) throw new Error('Connection not found');

  const db = await Database.create(':memory:');
  try { await db.exec('LOAD delta;'); } catch { await db.exec('INSTALL delta; LOAD delta;'); }

  const isAzure = (connection.warehouse_path ?? '').startsWith('az://');
  if (isAzure) {
    try { await db.exec('LOAD azure;'); } catch { await db.exec('INSTALL azure; LOAD azure;'); }
    await db.exec("SET azure_transport_option_type = 'curl';");
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
    if (connStr) {
      await db.exec(`CREATE SECRET azure_secret (TYPE AZURE, CONNECTION_STRING '${connStr.replace(/'/g, "''")}');`);
    }
  }

  const createView = async (schema: string, viewName: string, tablePath: string) => {
    const safePath = tablePath.replace(/\\/g, '/').replace(/'/g, "''");
    const safeSchema = schema.replace(/"/g, '""');
    const safeView = viewName.replace(/"/g, '""');
    await db.exec(`CREATE SCHEMA IF NOT EXISTS "${safeSchema}";`);
    if (isAzure) {
      await db.exec(`CREATE OR REPLACE VIEW "${safeSchema}"."${safeView}" AS SELECT * FROM delta_scan('${safePath}');`);
      return;
    }
    const fsPath = tablePath.replace(/\//g, path.sep);
    if (fs.existsSync(path.join(fsPath, '_delta_log'))) {
      await db.exec(`CREATE OR REPLACE VIEW "${safeSchema}"."${safeView}" AS SELECT * FROM delta_scan('${safePath}');`);
    } else {
      await db.exec(`CREATE OR REPLACE VIEW "${safeSchema}"."${safeView}" AS SELECT * FROM read_parquet('${safePath}/*.parquet');`);
    }
  };

  // Source tables — schema = connection name
  const warehousePath = connection.warehouse_path;
  if (warehousePath) {
    const ingestedTables = await semanticDb('ingested_tables')
      .where({ connection_id: connectionId, status: 'done' })
      .select('table_name');
    for (const t of ingestedTables) {
      try {
        const tPath = isAzure ? `${warehousePath}/${t.table_name}` : path.join(warehousePath, t.table_name);
        await createView(connection.name, t.table_name, tPath);
      } catch (err) {
        console.warn(`[notebooks] Failed to create view for source ${connection.name}.${t.table_name}:`, err);
      }
    }
  }

  // Product tables — schema = product name
  const products = await semanticDb('data_products')
    .where({ connection_id: connectionId })
    .whereIn('status', ['approved', 'success'])
    .select('id', 'name');
  for (const product of products) {
    const schemas = await semanticDb('star_schemas').where({ data_product_id: product.id }).select('id');
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    if (schemaIds.length === 0) continue;
    const productTables = await semanticDb('product_tables')
      .whereIn('star_schema_id', schemaIds)
      .where('transformation_status', 'success')
      .whereNotNull('delta_path')
      .select('table_name', 'delta_path');
    for (const t of productTables) {
      try {
        const tPath = isAzure ? t.delta_path : path.resolve(t.delta_path);
        await createView(product.name, t.table_name, tPath);
      } catch (err) {
        console.warn(`[notebooks] Failed to create view for product ${product.name}.${t.table_name}:`, err);
      }
    }
  }

  return db;
}

// ─── DIRECT SQL QUERY — for Python cells to call via fetch ────────────────────
// POST /api/notebooks/query { connectionId, sql }
router.post('/query', async (req: Request, res: Response, next: NextFunction) => {
  let db: Database | null = null;
  try {
    const { connectionId, sql: sqlText } = req.body as { connectionId: number; sql: string };
    if (!connectionId || !sqlText?.trim()) {
      res.status(400).json({ ok: false, error: 'connectionId and sql are required' });
      return;
    }

    db = await buildNamespacedDuckDB(connectionId);
    const rawRows = await db.all(sqlText.trim()) as Record<string, unknown>[];
    const rows = rawRows.slice(0, 500).map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({ ok: true, data: { rows, columns, rowCount: rawRows.length } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Query failed';
    res.json({ ok: false, error: msg });
  } finally {
    if (db) db.close().catch(() => {});
  }
});

// ─── AI CODE GENERATION — generate SQL/Python from natural language ────────
// POST /api/notebooks/generate { connectionId, prompt, cellType, existingCode? }
router.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, prompt, cellType, scope, existingCode } = req.body as {
      connectionId: number;
      prompt: string;
      cellType: 'sql' | 'python';
      scope?: 'sources' | 'products';
      existingCode?: string;
    };

    if (!connectionId || !prompt?.trim()) {
      res.status(400).json({ ok: false, error: 'connectionId and prompt are required' });
      return;
    }

    // Build schema context string, filtered by scope
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }

    const scopeLabel = scope === 'sources' ? 'data sources (raw tables)' : scope === 'products' ? 'data products (curated star schemas)' : 'data sources and data products';
    let schemaContext = `Available ${scopeLabel} (use 2-level namespace: schema_name.table_name):\n\n`;

    // Source tables — only if scope is 'sources' or unset
    const includeSources = !scope || scope === 'sources';
    const sourceTables = includeSources ? await semanticDb('source_tables')
      .where({ connection_id: connectionId, is_active: true })
      .select('id', 'table_name', 'display_name', 'description')
      .orderBy('table_name') : [];

    if (sourceTables.length > 0) {
      schemaContext += `## Source: "${connection.name}" (use as: ${connection.name}.table_name)\n`;
      const stIds = sourceTables.map((t: { id: number }) => t.id);
      const sourceCols = await semanticDb('source_columns')
        .whereIn('table_id', stIds)
        .select('table_id', 'column_name', 'data_type', 'display_name', 'description', 'is_dimension', 'is_measure')
        .orderBy(['table_id', 'id']);
      const colMap = new Map<number, typeof sourceCols>();
      for (const c of sourceCols) {
        if (!colMap.has(c.table_id)) colMap.set(c.table_id, []);
        colMap.get(c.table_id)!.push(c);
      }
      for (const t of sourceTables) {
        const desc = t.description ? ` -- ${t.description}` : '';
        schemaContext += `\n  ${connection.name}.${t.table_name}${desc}\n`;
        for (const c of colMap.get(t.id) ?? []) {
          const role = c.is_measure ? ' [measure]' : c.is_dimension ? ' [dimension]' : '';
          const cdesc = c.description ? ` -- ${c.description}` : '';
          schemaContext += `    ${c.column_name} ${c.data_type}${role}${cdesc}\n`;
        }
      }
    }

    // Product tables — only if scope is 'products' or unset
    const includeProducts = !scope || scope === 'products';
    const products = includeProducts ? await semanticDb('data_products')
      .where({ connection_id: connectionId })
      .whereIn('status', ['approved', 'success'])
      .select('id', 'name', 'description')
      .orderBy('name') : [];

    for (const product of products) {
      const schemas = await semanticDb('star_schemas').where({ data_product_id: product.id }).select('id');
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      if (schemaIds.length === 0) continue;

      const tables = await semanticDb('product_tables')
        .whereIn('star_schema_id', schemaIds)
        .where('transformation_status', 'success')
        .select('id', 'table_name', 'display_name', 'description', 'table_role')
        .orderBy(['table_role', 'table_name']);

      if (tables.length === 0) continue;

      const pdesc = product.description ? ` -- ${product.description}` : '';
      schemaContext += `\n## Data Product: "${product.name}"${pdesc} (use as: ${product.name}.table_name)\n`;

      const tIds = tables.map((t: { id: number }) => t.id);
      const prodCols = await semanticDb('product_columns')
        .whereIn('product_table_id', tIds)
        .select('product_table_id', 'column_name', 'data_type', 'display_name', 'description', 'column_role', 'fk_target_table')
        .orderBy(['product_table_id', 'sort_order', 'id']);
      const pColMap = new Map<number, typeof prodCols>();
      for (const c of prodCols) {
        if (!pColMap.has(c.product_table_id)) pColMap.set(c.product_table_id, []);
        pColMap.get(c.product_table_id)!.push(c);
      }

      for (const t of tables) {
        const role = t.table_role ? ` [${t.table_role}]` : '';
        const tdesc = t.description ? ` -- ${t.description}` : '';
        schemaContext += `\n  ${product.name}.${t.table_name}${role}${tdesc}\n`;
        for (const c of pColMap.get(t.id) ?? []) {
          const crole = c.column_role ? ` [${c.column_role}]` : '';
          const fk = c.fk_target_table ? ` -> ${c.fk_target_table}` : '';
          const cdesc = c.description ? ` -- ${c.description}` : '';
          schemaContext += `    ${c.column_name} ${c.data_type}${crole}${fk}${cdesc}\n`;
        }
      }
    }

    // Relationships (for source scope)
    if (includeSources) {
      const rels = await semanticDb('table_relationships as tr')
        .join('source_tables as ft', 'tr.from_table_id', 'ft.id')
        .join('source_columns as fc', 'tr.from_column_id', 'fc.id')
        .join('source_tables as tt', 'tr.to_table_id', 'tt.id')
        .join('source_columns as tc', 'tr.to_column_id', 'tc.id')
        .where('ft.connection_id', connectionId)
        .select(
          'ft.table_name as from_table', 'fc.column_name as from_col',
          'tt.table_name as to_table', 'tc.column_name as to_col',
          'tr.relationship_type', 'tr.description as rel_desc',
        );
      if (rels.length > 0) {
        schemaContext += `\n## Relationships (use these for JOINs)\n`;
        for (const r of rels) {
          const desc = r.rel_desc ? ` -- ${r.rel_desc}` : '';
          schemaContext += `  ${connection.name}.${r.from_table}.${r.from_col} -> ${connection.name}.${r.to_table}.${r.to_col} (${r.relationship_type})${desc}\n`;
        }
      }
    }

    // KPI definitions
    const kpis = await semanticDb('kpi_definitions')
      .where({ connection_id: connectionId })
      .select('name', 'description', 'formula_plain_text', 'formula_sql');
    if (kpis.length > 0) {
      schemaContext += `\n## KPI Definitions (use these formulas when the user references these metrics)\n`;
      for (const k of kpis) {
        const desc = k.description ? ` -- ${k.description}` : '';
        const formula = k.formula_sql ? ` | SQL: ${k.formula_sql}` : '';
        const plain = k.formula_plain_text ? ` | ${k.formula_plain_text}` : '';
        schemaContext += `  ${k.name}${desc}${plain}${formula}\n`;
      }
    }

    const lang = cellType === 'python' ? 'Python' : 'SQL';
    const systemPrompt = `You are a data analyst assistant in a notebook environment.
You generate ${lang} code based on the user's request and the available schema.

${schemaContext}

Rules:
- Generate ONLY ${lang} code, no explanations or markdown fences.
- For SQL: use DuckDB SQL dialect. Always use 2-level namespaces (schema_name.table_name).
- For Python: a \`sql(query)\` function is available that runs a DuckDB query and returns a pandas DataFrame. pandas, numpy, and matplotlib are available.
- If the user references a table or column, use the exact names from the schema above.
- Write clean, concise code.${existingCode ? `\n\nThe user already has this code in the cell:\n${existingCode}` : ''}`;

    const code = await callClaudeMultiTurn(systemPrompt, [
      { role: 'user', content: prompt.trim() },
    ]);

    // Strip markdown fences if Claude wraps the code
    const cleaned = code
      .replace(/^```(?:sql|python|py)?\s*\n?/im, '')
      .replace(/\n?\s*```\s*$/m, '')
      .trim();

    res.json({ ok: true, data: { code: cleaned } });
  } catch (err) { next(err); }
});

// ─── SCHEMA EXPLORER — full tree for sidebar ───────────────────────────────
// Returns two-level namespaces: source tables + data product tables
// Each with columns and data types
router.get('/schema/:connectionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.params.connectionId);

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    // 1. Source tables + columns
    const sourceTables = await semanticDb('source_tables')
      .where({ connection_id: connectionId, is_active: true })
      .select('id', 'table_name', 'display_name', 'description')
      .orderBy('table_name');

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await semanticDb('source_columns')
          .whereIn('table_id', sourceTableIds)
          .select('id', 'table_id', 'column_name', 'data_type', 'display_name', 'description', 'is_dimension', 'is_measure')
          .orderBy(['table_id', 'id'])
      : [];

    // Group columns by table
    const sourceColMap = new Map<number, typeof sourceColumns>();
    for (const col of sourceColumns) {
      if (!sourceColMap.has(col.table_id)) sourceColMap.set(col.table_id, []);
      sourceColMap.get(col.table_id)!.push(col);
    }

    const sourceNamespace = {
      type: 'source' as const,
      name: connection.name,
      id: `source:${connectionId}`,
      tables: sourceTables.map((t: { id: number; table_name: string; display_name: string; description: string | null }) => ({
        id: t.id,
        name: t.table_name,
        displayName: t.display_name || t.table_name,
        description: t.description,
        columns: (sourceColMap.get(t.id) ?? []).map((c: { id: number; column_name: string; data_type: string; display_name: string; description: string | null; is_dimension: boolean; is_measure: boolean }) => ({
          id: c.id,
          name: c.column_name,
          dataType: c.data_type,
          displayName: c.display_name || c.column_name,
          description: c.description,
          isDimension: c.is_dimension,
          isMeasure: c.is_measure,
        })),
      })),
    };

    // 2. Data product tables + columns
    const products = await semanticDb('data_products')
      .where({ connection_id: connectionId })
      .whereIn('status', ['approved', 'success'])
      .select('id', 'name', 'description')
      .orderBy('name');

    const productNamespaces = [];

    for (const product of products) {
      const schemas = await semanticDb('star_schemas')
        .where({ data_product_id: product.id })
        .select('id');
      const schemaIds = schemas.map((s: { id: number }) => s.id);

      if (schemaIds.length === 0) continue;

      const tables = await semanticDb('product_tables')
        .whereIn('star_schema_id', schemaIds)
        .where('transformation_status', 'success')
        .select('id', 'table_name', 'display_name', 'description', 'table_role')
        .orderBy(['table_role', 'table_name']);

      const tableIds = tables.map((t: { id: number }) => t.id);
      const columns = tableIds.length
        ? await semanticDb('product_columns')
            .whereIn('product_table_id', tableIds)
            .select('id', 'product_table_id', 'column_name', 'data_type', 'display_name', 'description', 'column_role', 'fk_target_table')
            .orderBy(['product_table_id', 'sort_order', 'id'])
        : [];

      const colMap = new Map<number, typeof columns>();
      for (const col of columns) {
        if (!colMap.has(col.product_table_id)) colMap.set(col.product_table_id, []);
        colMap.get(col.product_table_id)!.push(col);
      }

      productNamespaces.push({
        type: 'product' as const,
        name: product.name,
        id: `product:${product.id}`,
        description: product.description,
        tables: tables.map((t: { id: number; table_name: string; display_name: string; description: string | null; table_role: string }) => ({
          id: t.id,
          name: t.table_name,
          displayName: t.display_name || t.table_name,
          description: t.description,
          role: t.table_role,
          columns: (colMap.get(t.id) ?? []).map((c: { id: number; column_name: string; data_type: string; display_name: string; description: string | null; column_role: string; fk_target_table: string | null }) => ({
            id: c.id,
            name: c.column_name,
            dataType: c.data_type,
            displayName: c.display_name || c.column_name,
            description: c.description,
            role: c.column_role,
            fkTarget: c.fk_target_table,
          })),
        })),
      });
    }

    res.json({
      ok: true,
      data: {
        connectionName: connection.name,
        namespaces: [sourceNamespace, ...productNamespaces],
      },
    });
  } catch (err) { next(err); }
});

// ─── LIST notebooks ─────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const starred = req.query.starred === 'true';
    const { page, limit, offset } = parsePagination(req.query, { limit: 30 });

    let baseQuery = semanticDb('notebooks').where({ user_id: userId });
    if (starred) baseQuery = baseQuery.where({ starred: true });

    const [{ count: total }] = await baseQuery.clone().count('* as count');

    const rows = await baseQuery
      .select('id', 'title', 'description', 'connection_id', 'starred', 'created_at', 'updated_at')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Add cell count for each notebook
    const ids = rows.map((r: { id: number }) => r.id);
    const cellCounts = ids.length > 0
      ? await semanticDb('notebook_cells')
          .whereIn('notebook_id', ids)
          .groupBy('notebook_id')
          .select('notebook_id')
          .count('* as count')
      : [];
    const countMap = new Map(cellCounts.map((c: { notebook_id: number; count: string }) => [c.notebook_id, Number(c.count)]));

    const enriched = rows.map((r: { id: number }) => ({
      ...r,
      cell_count: countMap.get(r.id) ?? 0,
    }));

    res.json(paginatedResponse(enriched, Number(total), page, limit));
  } catch (err) { next(err); }
});

// ─── CREATE notebook ────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, description, connectionId } = req.body as {
      title?: string;
      description?: string;
      connectionId?: number;
    };

    const [notebook] = await semanticDb('notebooks')
      .insert({
        tenant_id: req.user!.tenantId,
        user_id: req.user!.sub,
        title: title?.trim() || 'Untitled Notebook',
        description: description?.trim() || null,
        connection_id: connectionId ?? null,
      })
      .returning('*');

    // Auto-create one empty SQL cell
    await semanticDb('notebook_cells').insert({
      tenant_id: req.user!.tenantId,
      notebook_id: notebook.id,
      cell_type: 'sql',
      source: '',
      position: 0,
    });

    res.json({ ok: true, data: notebook });
  } catch (err) { next(err); }
});

// ─── GET notebook with cells ────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notebook = await semanticDb('notebooks')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();

    if (!notebook) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }

    const cells = await semanticDb('notebook_cells')
      .where({ notebook_id: notebook.id })
      .orderBy('position', 'asc')
      .select('*');

    res.json({ ok: true, data: { ...notebook, cells } });
  } catch (err) { next(err); }
});

// ─── UPDATE notebook ────────────────────────────────────────────────────────
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, description, connectionId } = req.body as {
      title?: string;
      description?: string;
      connectionId?: number | null;
    };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description.trim() || null;
    if (connectionId !== undefined) updates.connection_id = connectionId;

    const count = await semanticDb('notebooks')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .update(updates);

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE notebook ────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await semanticDb('notebooks')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .delete();

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── TOGGLE star ────────────────────────────────────────────────────────────
router.patch('/:id/star', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notebook = await semanticDb('notebooks')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();

    if (!notebook) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }

    const newVal = !notebook.starred;
    await semanticDb('notebooks')
      .where({ id: notebook.id })
      .update({ starred: newVal, updated_at: new Date().toISOString() });

    res.json({ ok: true, data: { starred: newVal } });
  } catch (err) { next(err); }
});

// ─── ADD cell ───────────────────────────────────────────────────────────────
router.post('/:id/cells', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notebookId = Number(req.params.id);

    // Verify ownership
    const notebook = await semanticDb('notebooks')
      .where({ id: notebookId, user_id: req.user!.sub })
      .first();
    if (!notebook) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }

    const { cellType, source, position } = req.body as {
      cellType?: string;
      source?: string;
      position?: number;
    };

    // If position specified, shift existing cells down
    let actualPosition: number;
    if (position !== undefined) {
      actualPosition = position;
    } else {
      const maxRow = await semanticDb('notebook_cells').where({ notebook_id: notebookId }).max('position as max').first();
      actualPosition = (maxRow?.max ?? -1) + 1;
    }

    if (position !== undefined) {
      await semanticDb('notebook_cells')
        .where({ notebook_id: notebookId })
        .where('position', '>=', position)
        .increment('position', 1);
    }

    const [cell] = await semanticDb('notebook_cells')
      .insert({
        tenant_id: req.user!.tenantId,
        notebook_id: notebookId,
        cell_type: cellType ?? 'sql',
        source: source ?? '',
        position: actualPosition,
      })
      .returning('*');

    await semanticDb('notebooks')
      .where({ id: notebookId })
      .update({ updated_at: new Date().toISOString() });

    res.json({ ok: true, data: cell });
  } catch (err) { next(err); }
});

// ─── UPDATE cell ────────────────────────────────────────────────────────────
router.patch('/cells/:cellId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cellId = Number(req.params.cellId);

    // Verify ownership via notebook join
    const cell = await semanticDb('notebook_cells as nc')
      .join('notebooks as n', 'n.id', 'nc.notebook_id')
      .where({ 'nc.id': cellId, 'n.user_id': req.user!.sub })
      .select('nc.id', 'nc.notebook_id')
      .first();

    if (!cell) {
      res.status(404).json({ ok: false, error: 'Cell not found' });
      return;
    }

    const { source, cellType, position } = req.body as {
      source?: string;
      cellType?: string;
      position?: number;
    };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (source !== undefined) updates.source = source;
    if (cellType !== undefined) updates.cell_type = cellType;
    if (position !== undefined) updates.position = position;

    await semanticDb('notebook_cells').where({ id: cellId }).update(updates);

    await semanticDb('notebooks')
      .where({ id: cell.notebook_id })
      .update({ updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE cell ────────────────────────────────────────────────────────────
router.delete('/cells/:cellId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cellId = Number(req.params.cellId);

    // Verify ownership via notebook join
    const cell = await semanticDb('notebook_cells as nc')
      .join('notebooks as n', 'n.id', 'nc.notebook_id')
      .where({ 'nc.id': cellId, 'n.user_id': req.user!.sub })
      .select('nc.id', 'nc.notebook_id')
      .first();

    if (!cell) {
      res.status(404).json({ ok: false, error: 'Cell not found' });
      return;
    }

    await semanticDb('notebook_cells').where({ id: cellId }).delete();

    await semanticDb('notebooks')
      .where({ id: cell.notebook_id })
      .update({ updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── EXECUTE SQL cell ───────────────────────────────────────────────────────
router.post('/cells/:cellId/execute', async (req: Request, res: Response, next: NextFunction) => {
  let db: Database | null = null;
  try {
    const cellId = Number(req.params.cellId);

    const cell = await semanticDb('notebook_cells as nc')
      .join('notebooks as n', 'n.id', 'nc.notebook_id')
      .where({ 'nc.id': cellId, 'n.user_id': req.user!.sub })
      .select('nc.*', 'n.connection_id')
      .first();

    if (!cell) { res.status(404).json({ ok: false, error: 'Cell not found' }); return; }
    if (cell.cell_type !== 'sql') { res.status(400).json({ ok: false, error: 'Only SQL cells can be executed server-side' }); return; }

    const sqlText = (req.body.source ?? cell.source)?.trim();
    if (!sqlText) { res.status(400).json({ ok: false, error: 'No SQL to execute' }); return; }
    if (!cell.connection_id) { res.status(400).json({ ok: false, error: 'No connection selected for this notebook' }); return; }

    db = await buildNamespacedDuckDB(cell.connection_id);

    try {
      const start = Date.now();
      const rawRows = await db.all(sqlText) as Record<string, unknown>[];
      const rows = rawRows.slice(0, 500).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) { out[k] = typeof v === 'bigint' ? Number(v) : v; }
        return out;
      });
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      const durationMs = Date.now() - start;

      await semanticDb('notebook_cells').where({ id: cellId }).update({
        source: sqlText,
        last_output: JSON.stringify({ rows: rows.slice(0, 200), columns, rowCount: rawRows.length, durationMs }),
        last_status: 'success',
        last_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      res.json({ ok: true, data: { rows, columns, rowCount: rawRows.length, durationMs } });
    } catch (execErr) {
      const errorMessage = execErr instanceof Error ? execErr.message : 'Query execution failed';
      await semanticDb('notebook_cells').where({ id: cellId }).update({
        source: sqlText,
        last_output: JSON.stringify({ error: errorMessage }),
        last_status: 'error',
        last_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      res.json({ ok: false, error: errorMessage });
    }
  } catch (err) { next(err); }
  finally { if (db) db.close().catch(() => {}); }
});

// ─── REORDER cells ──────────────────────────────────────────────────────────
router.post('/:id/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notebookId = Number(req.params.id);

    const notebook = await semanticDb('notebooks')
      .where({ id: notebookId, user_id: req.user!.sub })
      .first();
    if (!notebook) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }

    const { order } = req.body as { order: Array<{ cellId: number; position: number }> };
    if (!Array.isArray(order)) {
      res.status(400).json({ ok: false, error: 'order must be an array' });
      return;
    }

    await semanticDb.transaction(async (trx) => {
      for (const item of order) {
        await trx('notebook_cells')
          .where({ id: item.cellId, notebook_id: notebookId })
          .update({ position: item.position });
      }
    });

    await semanticDb('notebooks')
      .where({ id: notebookId })
      .update({ updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DUPLICATE notebook ─────────────────────────────────────────────────────
router.post('/:id/duplicate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const original = await semanticDb('notebooks')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();

    if (!original) {
      res.status(404).json({ ok: false, error: 'Notebook not found' });
      return;
    }

    const [copy] = await semanticDb('notebooks')
      .insert({
        tenant_id: req.user!.tenantId,
        user_id: req.user!.sub,
        title: `${original.title} (copy)`,
        description: original.description,
        connection_id: original.connection_id,
      })
      .returning('*');

    // Copy cells
    const cells = await semanticDb('notebook_cells')
      .where({ notebook_id: original.id })
      .orderBy('position', 'asc');

    for (const cell of cells) {
      await semanticDb('notebook_cells').insert({
        tenant_id: req.user!.tenantId,
        notebook_id: copy.id,
        cell_type: cell.cell_type,
        source: cell.source,
        position: cell.position,
      });
    }

    res.json({ ok: true, data: copy });
  } catch (err) { next(err); }
});

export default router;

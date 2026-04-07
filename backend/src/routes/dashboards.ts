import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { createConnector, createProductConnector } from '../connectors/ConnectorFactory';
import { generateDashboardSpec, generateDashboardRefinement, refineDashboardSpec, validateAndFixDashboardSpec, SqlDialect } from '../ai/AIService';
import { DashboardSpec, RefinementOutput, WidgetExecutionResult } from '../ai/prompts/dashboardPrompt';
import { buildSemanticContextForQuery } from '../db/semanticGraph';
import { buildProductSemanticContext, getProductWarehousePath } from '../services/productContext';
import { parsePagination, paginatedResponse } from '../utils/paginate';

const router = Router();

// ---------------------------------------------------------------------------
// Helper — build semantic + relationship context strings for a connection
// ---------------------------------------------------------------------------

async function buildSemanticContext(
  connectionId: number,
): Promise<{ semanticContext: string; relationshipContext: string }> {
  const { tables, columns, relationships } = await buildSemanticContextForQuery(connectionId);

  const semanticContext = (tables as { id: number; table_name: string; description: string }[])
    .map((t) => {
      const cols = (columns as { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }[])
        .filter((c) => c.table_id === t.id)
        .map((c) =>
          `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
        )
        .join('\n');
      return `Table: ${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
    })
    .join('\n\n');

  const relationshipContext = relationships.length
    ? (relationships as { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }[])
        .map((r) => {
          const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
          const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
          return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
        })
        .join('\n')
    : 'No relationships defined yet — avoid JOINs unless you are certain of the key columns.';

  return { semanticContext, relationshipContext };
}

// ---------------------------------------------------------------------------
// Helper — apply default filter values to SQL placeholders
// ---------------------------------------------------------------------------

function applyDefaultFilters(sql: string): string {
  return sql
    .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
    .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
    .replace(/\{\{[^}]+\}\}/g, 'all');
}

// ---------------------------------------------------------------------------
// Helper — execute all widgets with default filters, return results for validation
// ---------------------------------------------------------------------------

async function executeSpecForValidation(
  spec: DashboardSpec,
  connectionId: number,
  tenantId?: number,
): Promise<WidgetExecutionResult[]> {
  // Wrap all RLS-dependent queries in a single transaction
  const { connection, productPath } = await semanticDb.transaction(async (trx) => {
    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
    const conn = await trx('connections').where({ id: connectionId }).first();
    const pp = await getProductWarehousePath(connectionId, trx);
    return { connection: conn, productPath: pp };
  });
  if (!connection) return [];

  const connector = productPath
    ? await createProductConnector(productPath, connection.id)
    : await createConnector(connection);
  await connector.connect();

  const results: WidgetExecutionResult[] = [];

  try {
    for (const widget of spec.widgets) {
      const resolvedSql = applyDefaultFilters(widget.sql);
      try {
        const result = await connector.executeQuery(resolvedSql);
        const rows = result.rows as Record<string, unknown>[];
        results.push({
          id: widget.id,
          title: widget.title,
          type: widget.type,
          rowCount: rows.length,
          sampleRows: rows.slice(0, 3),
        });
      } catch (err: unknown) {
        results.push({
          id: widget.id,
          title: widget.title,
          type: widget.type,
          rowCount: 0,
          error: err instanceof Error ? err.message : String(err),
          sampleRows: [],
        });
      }
    }
  } finally {
    connector.disconnect();
  }

  return results;
}

// ---------------------------------------------------------------------------
// POST /api/dashboards/generate
// ---------------------------------------------------------------------------

router.post('/generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, request, answers, productIds } = req.body as {
      connectionId: number;
      request: string;
      answers?: string[];
      productIds?: number[];
    };

    if (!request?.trim()) {
      res.status(400).json({ ok: false, error: 'request is required' });
      return;
    }

    // Append any refinement answers to the request so the AI uses them
    const nonEmptyAnswers = (answers ?? []).filter((a) => a?.trim());
    const fullRequest = nonEmptyAnswers.length
      ? `${request}\n\nAdditional requirements from the user:\n${nonEmptyAnswers.map((a) => `- ${a}`).join('\n')}`
      : request;

    // Check for product layer first — star schema context is much better for dashboards
    const productCtx = await buildProductSemanticContext(connectionId, productIds);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId);

    // Determine SQL dialect from the connection's query engine
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    const dialect: SqlDialect = productCtx ? 'duckdb' : (connection?.query_engine === 'duckdb' ? 'duckdb' : 'sqlite');

    let spec = await generateDashboardSpec(fullRequest, semanticCtx.semanticContext, semanticCtx.relationshipContext, dialect);

    // Validation pass — execute all widget SQLs with default filters and fix any broken/empty widgets
    try {
      const executionResults = await executeSpecForValidation(spec, connectionId, req.user!.tenantId);
      const hasIssues = executionResults.some(
        (r) => r.error || r.rowCount === 0 || (r.type === 'pie_chart' && r.rowCount > 3),
      );
      if (hasIssues) {
        spec = await validateAndFixDashboardSpec(spec, executionResults, semanticCtx.semanticContext, semanticCtx.relationshipContext);
      }
    } catch {
      // Validation is best-effort — never block the response if it fails
    }

    res.json({ ok: true, data: { spec } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine — get clarifying questions before generation
// ---------------------------------------------------------------------------

router.post('/refine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, request, productIds } = req.body as { connectionId: number; request: string; productIds?: number[] };

    if (!request?.trim()) {
      res.status(400).json({ ok: false, error: 'request is required' });
      return;
    }

    const productCtx = await buildProductSemanticContext(connectionId, productIds);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId);
    const result: RefinementOutput = await generateDashboardRefinement(request, semanticCtx.semanticContext, semanticCtx.relationshipContext);

    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine-spec — update an existing spec based on user feedback
// ---------------------------------------------------------------------------

router.post('/refine-spec', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, refinement, currentSpec, productIds } = req.body as {
      connectionId: number;
      refinement: string;
      currentSpec: DashboardSpec;
      productIds?: number[];
    };

    if (!refinement?.trim()) {
      res.status(400).json({ ok: false, error: 'refinement is required' });
      return;
    }
    if (!currentSpec) {
      res.status(400).json({ ok: false, error: 'currentSpec is required' });
      return;
    }

    const productCtx = await buildProductSemanticContext(connectionId, productIds);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId);
    const spec = await refineDashboardSpec(refinement, currentSpec, semanticCtx.semanticContext, semanticCtx.relationshipContext);

    res.json({ ok: true, data: { spec } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/execute
// ---------------------------------------------------------------------------

router.post('/execute', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, sql, filterValues = {} } = req.body as {
      connectionId: number;
      sql: string;
      filterValues: Record<string, string>;
    };

    // Substitute {{key}} placeholders with filter values
    let resolvedSql = sql;
    for (const [key, value] of Object.entries(filterValues)) {
      let resolved: string;
      if (!value) {
        if (key.endsWith('_from')) {
          resolved = '1900-01-01';
        } else if (key.endsWith('_to')) {
          resolved = '2099-12-31';
        } else {
          resolved = 'all';
        }
      } else {
        resolved = value;
      }
      resolvedSql = resolvedSql.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), resolved);
    }

    // Also apply defaults for any remaining unsubstituted placeholders
    resolvedSql = resolvedSql
      .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
      .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
      .replace(/\{\{[^}]+\}\}/g, 'all');

    // Wrap all RLS-dependent queries in a single transaction to guarantee tenant context
    const tenantId = req.user!.tenantId;
    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = productPath
      ? await createProductConnector(productPath, connection.id)
      : await createConnector(connection);
    await connector.connect();

    try {
      const result = await connector.executeQuery(resolvedSql);
      res.json({ ok: true, data: { rows: result.rows } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ ok: false, error: message });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/filter-options
// ---------------------------------------------------------------------------

router.post('/filter-options', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, table, column } = req.body as {
      connectionId: number;
      table: string;
      column: string;
    };

    if (!table || !column) {
      res.status(400).json({ ok: false, error: 'table and column are required' });
      return;
    }

    // Wrap all RLS-dependent queries in a single transaction
    const filterTenantId = req.user!.tenantId;
    const { connection: filterConn, productPath: filterProductPath } = await semanticDb.transaction(async (trx) => {
      if (filterTenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(filterTenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!filterConn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = filterProductPath
      ? await createProductConnector(filterProductPath, filterConn.id)
      : await createConnector(filterConn);
    await connector.connect();

    try {
      const result = await connector.executeQuery(
        `SELECT DISTINCT "${column}" FROM "${table}" WHERE "${column}" IS NOT NULL ORDER BY "${column}" LIMIT 100`,
      );
      const options = result.rows.map((r) => String((r as Record<string, unknown>)[column]));
      res.json({ ok: true, data: { options } });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards — list own + shared dashboards in the same tenant
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const folder = req.query.folder as string | undefined;
    const { page, limit, offset } = parsePagination(req.query, { limit: 50 });

    // Own dashboards + shared dashboards from same tenant (RLS handles tenant isolation)
    let baseQuery = semanticDb('dashboards')
      .where(function () {
        this.where({ user_id: userId }).orWhere({ is_shared: true });
      });

    if (folder) {
      baseQuery = baseQuery.where({ folder });
    }

    const [{ count: total }] = await baseQuery.clone().count('* as count');

    const rows = await baseQuery
      .select(
        'id', 'title', 'description', 'is_favorite', 'is_shared',
        'shared_permission', 'folder', 'auto_refresh_seconds',
        'user_id', 'created_at', 'updated_at',
      )
      .orderBy('is_favorite', 'desc')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Tag each row with is_owner so the frontend knows permission level
    const tagged = rows.map((r: Record<string, unknown>) => ({
      ...r,
      is_owner: r.user_id === userId,
      permission: r.user_id === userId ? 'owner' : (r.shared_permission ?? 'viewer'),
    }));

    res.json(paginatedResponse(tagged, Number(total), page, limit));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/folders — list distinct folders
// ---------------------------------------------------------------------------

router.get('/folders', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await semanticDb('dashboards')
      .whereNotNull('folder')
      .distinct('folder')
      .orderBy('folder');

    res.json({ ok: true, data: rows.map((r: { folder: string }) => r.folder) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards
// ---------------------------------------------------------------------------

router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, title, description, spec, folder } = req.body as {
      connectionId: number;
      title: string;
      description: string;
      spec: DashboardSpec;
      folder?: string;
    };

    const [row] = await semanticDb('dashboards')
      .insert({
        user_id:       req.user!.sub,
        connection_id: connectionId,
        title,
        description,
        spec:          JSON.stringify(spec),
        folder:        folder || null,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/templates/list — list available templates
// ---------------------------------------------------------------------------

router.get('/templates/list', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await semanticDb('dashboard_templates')
      .select('id', 'name', 'description', 'category', 'created_at')
      .orderBy('category')
      .orderBy('name');

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/templates/:id — get a template spec
// ---------------------------------------------------------------------------

router.get('/templates/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await semanticDb('dashboard_templates')
      .where({ id: req.params.id })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Template not found' });
      return;
    }

    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/templates — create a template (admin only)
// ---------------------------------------------------------------------------

router.post('/templates', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ ok: false, error: 'Admin only' });
      return;
    }

    const { name, description, category, spec } = req.body as {
      name: string;
      description?: string;
      category?: string;
      spec: DashboardSpec;
    };

    const [row] = await semanticDb('dashboard_templates')
      .insert({
        name,
        description: description || null,
        category: category || 'General',
        spec: JSON.stringify(spec),
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/from-template — create dashboard from a template
// ---------------------------------------------------------------------------

router.post('/from-template', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { templateId, connectionId, folder } = req.body as {
      templateId: number;
      connectionId: number;
      folder?: string;
    };

    const template = await semanticDb('dashboard_templates')
      .where({ id: templateId })
      .first();

    if (!template) {
      res.status(404).json({ ok: false, error: 'Template not found' });
      return;
    }

    const spec = typeof template.spec === 'string' ? JSON.parse(template.spec) : template.spec;

    const [row] = await semanticDb('dashboards')
      .insert({
        user_id: req.user!.sub,
        connection_id: connectionId,
        title: template.name,
        description: template.description,
        spec: JSON.stringify(spec),
        folder: folder || null,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/:id — accessible if owned or shared within tenant
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    // RLS ensures tenant isolation; allow access if owned or shared
    const row = await semanticDb('dashboards')
      .where({ id: req.params.id })
      .where(function () {
        this.where({ user_id: userId }).orWhere({ is_shared: true });
      })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const isOwner = row.user_id === userId;
    res.json({
      ok: true,
      data: {
        ...row,
        is_owner: isOwner,
        permission: isOwner ? 'owner' : (row.shared_permission ?? 'viewer'),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/dashboards/:id
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await semanticDb('dashboards')
      .where({ id: req.params.id, user_id: req.user!.sub })
      .delete();

    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/dashboards/:id/favorite
// ---------------------------------------------------------------------------

router.patch('/:id/favorite', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await semanticDb('dashboards')
      .where({ id: req.params.id, user_id: req.user!.sub })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const newValue = !row.is_favorite;
    await semanticDb('dashboards')
      .where({ id: req.params.id })
      .update({ is_favorite: newValue });

    res.json({ ok: true, data: { is_favorite: newValue } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/dashboards/:id — update dashboard properties (title, folder, sharing, auto-refresh)
// ---------------------------------------------------------------------------

router.patch('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const row = await semanticDb('dashboards')
      .where({ id: req.params.id, user_id: userId })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found or not owned by you' });
      return;
    }

    const { title, description, folder, is_shared, shared_permission, auto_refresh_seconds, spec } = req.body as {
      title?: string;
      description?: string;
      folder?: string | null;
      is_shared?: boolean;
      shared_permission?: string;
      auto_refresh_seconds?: number | null;
      spec?: DashboardSpec;
    };

    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (folder !== undefined) updates.folder = folder || null;
    if (is_shared !== undefined) updates.is_shared = is_shared;
    if (shared_permission !== undefined) updates.shared_permission = shared_permission;
    if (auto_refresh_seconds !== undefined) updates.auto_refresh_seconds = auto_refresh_seconds;
    if (spec !== undefined) updates.spec = JSON.stringify(spec);

    if (Object.keys(updates).length === 0) {
      res.json({ ok: true, data: row });
      return;
    }

    updates.updated_at = new Date().toISOString();
    await semanticDb('dashboards').where({ id: req.params.id }).update(updates);
    const updated = await semanticDb('dashboards').where({ id: req.params.id }).first();
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/:id/duplicate — clone a dashboard
// ---------------------------------------------------------------------------

router.post('/:id/duplicate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    // Allow duplicating owned or shared dashboards
    const source = await semanticDb('dashboards')
      .where({ id: req.params.id })
      .where(function () {
        this.where({ user_id: userId }).orWhere({ is_shared: true });
      })
      .first();

    if (!source) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const [row] = await semanticDb('dashboards')
      .insert({
        user_id: userId,
        connection_id: source.connection_id,
        title: `${source.title} (copy)`,
        description: source.description,
        spec: typeof source.spec === 'string' ? source.spec : JSON.stringify(source.spec),
        folder: source.folder,
        is_shared: false,
        is_favorite: false,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

export default router;

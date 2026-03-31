import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { generateDashboardSpec, generateDashboardRefinement, refineDashboardSpec, validateAndFixDashboardSpec } from '../ai/AIService';
import { DashboardSpec, RefinementOutput, WidgetExecutionResult } from '../ai/prompts/dashboardPrompt';
import { buildSemanticContextForQuery } from '../db/semanticGraph';

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
): Promise<WidgetExecutionResult[]> {
  const connection = await semanticDb('connections').where({ id: connectionId }).first();
  if (!connection) return [];

  const config = typeof connection.config === 'string'
    ? JSON.parse(connection.config)
    : connection.config;

  const connector = new SqliteConnector(config.filepath);
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
    const { connectionId, request, answers } = req.body as {
      connectionId: number;
      request: string;
      answers?: string[];
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

    const { semanticContext, relationshipContext } = await buildSemanticContext(connectionId);
    let spec = await generateDashboardSpec(fullRequest, semanticContext, relationshipContext);

    // Validation pass — execute all widget SQLs with default filters and fix any broken/empty widgets
    try {
      const executionResults = await executeSpecForValidation(spec, connectionId);
      const hasIssues = executionResults.some(
        (r) => r.error || r.rowCount === 0 || (r.type === 'pie_chart' && r.rowCount > 3),
      );
      if (hasIssues) {
        spec = await validateAndFixDashboardSpec(spec, executionResults, semanticContext, relationshipContext);
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
    const { connectionId, request } = req.body as { connectionId: number; request: string };

    if (!request?.trim()) {
      res.status(400).json({ ok: false, error: 'request is required' });
      return;
    }

    const { semanticContext, relationshipContext } = await buildSemanticContext(connectionId);
    const result: RefinementOutput = await generateDashboardRefinement(request, semanticContext, relationshipContext);

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
    const { connectionId, refinement, currentSpec } = req.body as {
      connectionId: number;
      refinement: string;
      currentSpec: DashboardSpec;
    };

    if (!refinement?.trim()) {
      res.status(400).json({ ok: false, error: 'refinement is required' });
      return;
    }
    if (!currentSpec) {
      res.status(400).json({ ok: false, error: 'currentSpec is required' });
      return;
    }

    const { semanticContext, relationshipContext } = await buildSemanticContext(connectionId);
    const spec = await refineDashboardSpec(refinement, currentSpec, semanticContext, relationshipContext);

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

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const config = typeof connection.config === 'string'
      ? JSON.parse(connection.config)
      : connection.config;

    const connector = new SqliteConnector(config.filepath);
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

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const config = typeof connection.config === 'string'
      ? JSON.parse(connection.config)
      : connection.config;

    const connector = new SqliteConnector(config.filepath);
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
// GET /api/dashboards
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const rows = await semanticDb('dashboards')
      .where({ user_id: userId })
      .select('id', 'title', 'description', 'is_favorite', 'created_at', 'updated_at')
      .orderBy('is_favorite', 'desc')
      .orderBy('updated_at', 'desc');

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards
// ---------------------------------------------------------------------------

router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, title, description, spec } = req.body as {
      connectionId: number;
      title: string;
      description: string;
      spec: DashboardSpec;
    };

    const [row] = await semanticDb('dashboards')
      .insert({
        user_id:       req.user!.sub,
        connection_id: connectionId,
        title,
        description,
        spec:          JSON.stringify(spec),
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/:id
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await semanticDb('dashboards')
      .where({ id: req.params.id, user_id: req.user!.sub })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    res.json({ ok: true, data: row });
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

export default router;

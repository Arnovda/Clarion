import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import { generateReportNarrative } from '../ai/AIService';
import { KpiResult } from '../ai/prompts/answerFormatterPrompt';
import { getKpisByIds } from '../db/semanticGraph';
import { parsePagination, paginatedResponse } from '../utils/paginate';

const router = Router();

// POST /api/reports/generate
router.post('/generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, title, period, kpiIds } = req.body as {
      connectionId: number;
      title: string;
      period: string;
      kpiIds: number[];
    };

    if (!kpiIds?.length) {
      res.status(400).json({ ok: false, error: 'At least one KPI is required' });
      return;
    }

    // 1. Fetch confirmed KPI definitions from Neo4j
    const kpis = await getKpisByIds(kpiIds, connectionId);

    if (!kpis.length) {
      res.status(400).json({ ok: false, error: 'No confirmed KPIs found for the provided IDs' });
      return;
    }

    // 2. Get source connection
    const connection = await db('connections').where({ id: connectionId }).first();
    const cfg = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
    const sqliteConnector = await createConnector(connection);
    await sqliteConnector.connect();

    // 3. Execute all KPI queries in parallel
    const kpiResults: KpiResult[] = await Promise.all(
      kpis.map(async (kpi) => {
        try {
          const result = await sqliteConnector.executeQuery(kpi.formula_sql as string);
          const value = result.rows[0] ? Object.values(result.rows[0])[0] : null;
          return {
            kpi_name: kpi.name as string,
            value:    (value as number | string) ?? 0,
            unit:     '',
          };
        } catch {
          return { kpi_name: kpi.name as string, value: 'Error', unit: '' };
        }
      }),
    );

    sqliteConnector.disconnect();

    // 4. Generate executive summary (Call Type 3)
    const narrative = await generateReportNarrative(title, period, kpiResults);

    res.json({
      ok: true,
      data: { title, period, kpiResults, narrative },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/query-log — admin + analyst per CLAUDE.md role matrix.
// Frontend gating alone is not security; gate on the server.
router.get('/query-log', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { page, limit, offset } = parsePagination(req.query, { limit: 50 });
    const [{ count: total }] = await db('query_log').count('* as count');
    const rows = await db('query_log')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
    res.json(paginatedResponse(rows, Number(total), page, limit));
  } catch (err) { next(err); }
});

// GET /api/reports/gaps — definition gaps for admin review
router.get('/gaps', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { page, limit, offset } = parsePagination(req.query, { limit: 50 });
    const baseQuery = db('definition_gaps')
      .join('query_log', 'definition_gaps.query_log_id', 'query_log.id');
    const [{ count: total }] = await baseQuery.clone().count('* as count');
    const rows = await baseQuery
      .select('definition_gaps.*', 'query_log.question_text')
      .orderByRaw('definition_gaps.resolved ASC, definition_gaps.hit_count DESC, definition_gaps.last_hit_at DESC')
      .limit(limit)
      .offset(offset);
    res.json(paginatedResponse(rows, Number(total), page, limit));
  } catch (err) { next(err); }
});

// PATCH /api/reports/gaps/:id/resolve — admin only.
router.patch('/gaps/:id/resolve', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    await db('definition_gaps').where({ id: req.params.id }).update({ resolved: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;

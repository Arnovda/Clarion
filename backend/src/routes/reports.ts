import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { generateReportNarrative } from '../ai/AIService';
import { KpiResult } from '../ai/prompts/answerFormatterPrompt';

const router = Router();

// POST /api/reports/generate
router.post('/generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    // 1. Fetch confirmed KPI definitions
    const kpis = await semanticDb('kpi_definitions')
      .whereIn('id', kpiIds)
      .where({ connection_id: connectionId, ai_draft: false });

    if (!kpis.length) {
      res.status(400).json({ ok: false, error: 'No confirmed KPIs found for the provided IDs' });
      return;
    }

    // 2. Get source connection
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    const cfg = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
    const sqliteConnector = new SqliteConnector(cfg.filepath);
    await sqliteConnector.connect();

    // 3. Execute all KPI queries in parallel
    const kpiResults: KpiResult[] = await Promise.all(
      kpis.map(async (kpi) => {
        try {
          const result = await sqliteConnector.executeQuery(kpi.formula_sql);
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

// GET /api/reports/query-log?connectionId=1 — admin only (via role check in frontend)
router.get('/query-log', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await semanticDb('query_log')
      .orderBy('created_at', 'desc')
      .limit(100);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/reports/gaps — definition gaps for admin review
router.get('/gaps', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await semanticDb('definition_gaps')
      .join('query_log', 'definition_gaps.query_log_id', 'query_log.id')
      .select('definition_gaps.*', 'query_log.question_text')
      .orderBy('definition_gaps.created_at', 'desc');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/reports/gaps/:id/resolve
router.patch('/gaps/:id/resolve', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await semanticDb('definition_gaps').where({ id: req.params.id }).update({ resolved: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;

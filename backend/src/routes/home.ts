/**
 * /api/home — aggregated dashboard for the landing page.
 *
 * One request returns everything the Home page needs:
 *   • Health gamification score (overall 0–100 + sub-scores)
 *   • Freshness (sources / products synced recently)
 *   • Definition completeness (tables / columns / relationships approved)
 *   • Pipeline activity (last week's runs + active runs)
 *   • Pinned/recent dashboards
 *   • Recent conversations
 *   • Active alerts ("worth your attention")
 *
 * Designed to be cheap (single tenant scan, lots of COUNTs and a few small
 * SELECTs). The Home page polls this on focus / every 60s.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';

const router = Router();

const FRESH_WINDOW_HOURS = 24; // "synced today" / "ran today"

router.get('/summary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

    const since = new Date(Date.now() - FRESH_WINDOW_HOURS * 3600_000);
    const weekAgo = new Date(Date.now() - 7 * 86400_000);

    // ── Sources ─────────────────────────────────────────────────────────
    const sourceRows = await semanticDb('connections')
      .where('tenant_id', tenantId)
      .select<{
        id: number; name: string; type: string; connector_type: string | null;
        last_synced_at: Date | string | null; last_sync_status: string | null;
      }[]>('id', 'name', 'type', 'connector_type', 'last_synced_at', 'last_sync_status');
    const sourcesTotal = sourceRows.length;
    const sourcesFresh = sourceRows.filter((s) => s.last_synced_at && new Date(s.last_synced_at) > since).length;
    const staleSources = sourceRows
      .filter((s) => !s.last_synced_at || new Date(s.last_synced_at) <= since)
      .map((s) => ({ id: s.id, name: s.name, lastSyncedAt: s.last_synced_at ? String(s.last_synced_at) : null }));
    // Full source list — used by the freshness detail slide-over (the
    // user wants to SEE every source with its timestamp before deciding
    // which one to refresh).
    const allSources = sourceRows.map((s) => ({
      id: s.id, name: s.name,
      connectorType: s.connector_type,
      lastSyncedAt: s.last_synced_at ? String(s.last_synced_at) : null,
      lastSyncStatus: s.last_sync_status,
      isStale: !s.last_synced_at || new Date(s.last_synced_at) <= since,
    }));

    // ── Products ───────────────────────────────────────────────────────
    // Freshness signal = MAX(product_tables.last_run_at) per product.
    // The earlier implementation read data_products.updated_at, but that
    // column only changes on metadata edits (CRUD on the product
    // definition) — refreshing the data does NOT touch it. The actual
    // refresh path writes product_tables.last_run_at via the catalog's
    // publishProductTable. So reading data_products.updated_at meant the
    // "products refreshed today" count was permanently 0/N regardless of
    // how many refreshes ran. Correct signal lives one level down.
    //
    // We LEFT JOIN through star_schemas → product_tables and aggregate
    // MAX(last_run_at) per product. Successful product_tables only
    // (transformation_status = 'success') so a stuck/failed run doesn't
    // inflate the freshness number. Tenant scoping: explicit filter on
    // data_products.tenant_id for parity with the rest of the file
    // (other queries in home.ts also filter explicitly even though RLS
    // would catch a missing filter).
    const productRows = await semanticDb('data_products as dp')
      .where('dp.tenant_id', tenantId)
      .leftJoin('star_schemas as ss', 'dp.id', 'ss.data_product_id')
      .leftJoin('product_tables as pt', function () {
        this.on('ss.id', 'pt.star_schema_id')
            .andOn('pt.transformation_status', semanticDb.raw('?', ['success']));
      })
      .groupBy('dp.id', 'dp.name', 'dp.status')
      .select<{ id: number; name: string; status: string; last_refreshed_at: Date | string | null }[]>(
        'dp.id',
        'dp.name',
        'dp.status',
        semanticDb.raw('MAX(pt.last_run_at) as last_refreshed_at'),
      );
    const productsTotal = productRows.length;
    const productsFresh = productRows.filter((p) => p.last_refreshed_at && new Date(p.last_refreshed_at) > since).length;
    const allProducts = productRows.map((p) => ({
      id: p.id, name: p.name, status: p.status,
      lastRefreshedAt: p.last_refreshed_at ? String(p.last_refreshed_at) : null,
      isStale: !p.last_refreshed_at || new Date(p.last_refreshed_at) <= since,
    }));
    const staleProducts = allProducts.filter((p) => p.isStale);

    // ── Definition completeness ────────────────────────────────────────
    const [{ tot: tablesTotal }] = await semanticDb('source_tables').where({ is_active: true })
      .count<[{ tot: string | number }]>('* as tot');
    const [{ ok: tablesDefined }] = await semanticDb('source_tables')
      .where({ is_active: true, ai_draft: false })
      .count<[{ ok: string | number }]>('* as ok');
    const [{ tot: columnsTotal }] = await semanticDb('source_columns')
      .count<[{ tot: string | number }]>('* as tot');
    const [{ ok: columnsDefined }] = await semanticDb('source_columns')
      .where({ ai_draft: false })
      .whereNotNull('description')
      .count<[{ ok: string | number }]>('* as ok');
    const [{ tot: relsTotal }] = await semanticDb('table_relationships')
      .count<[{ tot: string | number }]>('* as tot');
    const [{ ok: relsApproved }] = await semanticDb('table_relationships')
      .where({ ai_draft: false })
      .count<[{ ok: string | number }]>('* as ok');

    // ── Pending review queue (AI drafts to confirm/flag) ───────────────
    const [{ tot: pendingTables }] = await semanticDb('source_tables')
      .where({ is_active: true, ai_draft: true })
      .count<[{ tot: string | number }]>('* as tot');
    const [{ tot: pendingColumns }] = await semanticDb('source_columns')
      .where({ ai_draft: true })
      .count<[{ tot: string | number }]>('* as tot');
    const [{ tot: pendingRels }] = await semanticDb('table_relationships')
      .where({ ai_draft: true })
      .count<[{ tot: string | number }]>('* as tot');

    // ── Pipeline activity ──────────────────────────────────────────────
    let pipelineRunsThisWeek = 0;
    let pipelineSuccess = 0;
    let pipelineFailures = 0;
    let activeRuns = 0;
    try {
      const runs = await semanticDb('pipeline_runs')
        .where('tenant_id', tenantId)
        .where('queued_at', '>=', weekAgo)
        .select<{ status: string }[]>('status');
      pipelineRunsThisWeek = runs.length;
      for (const r of runs) {
        if (r.status === 'succeeded') pipelineSuccess++;
        else if (r.status === 'failed' || r.status === 'partial') pipelineFailures++;
        else if (r.status === 'running' || r.status === 'queued') activeRuns++;
      }
    } catch { /* pipeline_runs migration may not have been run yet */ }

    // ── Last few dashboards (recency / starred first) ─────────────────
    let dashboards: Array<{ id: number; title: string; starred: boolean; updatedAt: string | null }> = [];
    try {
      const rows = await semanticDb('dashboards')
        .where('tenant_id', tenantId)
        .orderBy([{ column: 'starred', order: 'desc' }, { column: 'updated_at', order: 'desc' }])
        .limit(6)
        .select<{ id: number; title: string; starred: boolean; updated_at: Date | string | null }[]>(
          'id', 'title', 'starred', 'updated_at',
        );
      dashboards = rows.map((r) => ({
        id: r.id, title: r.title, starred: !!r.starred,
        updatedAt: r.updated_at ? String(r.updated_at) : null,
      }));
    } catch { /* dashboards table may not exist for this user */ }

    // ── Recent conversations (last 5) ──────────────────────────────────
    let recentQuestions: Array<{ id: number; title: string | null; lastMessageAt: string | null }> = [];
    try {
      const rows = await semanticDb('conversations')
        .where('tenant_id', tenantId)
        .where('user_id', req.user!.sub)
        .orderBy('updated_at', 'desc')
        .limit(5)
        .select<{ id: number; title: string | null; updated_at: Date | string | null }[]>(
          'id', 'title', 'updated_at',
        );
      recentQuestions = rows.map((r) => ({
        id: r.id, title: r.title, lastMessageAt: r.updated_at ? String(r.updated_at) : null,
      }));
    } catch { /* ignore */ }

    // ── Active alerts (quality, undismissed) ───────────────────────────
    let alerts: Array<{ id: number; severity: string; message: string; kind: string; createdAt: string | null }> = [];
    try {
      const rows = await semanticDb('quality_alerts')
        .where('tenant_id', tenantId)
        .where('dismissed', false)
        .orderBy('created_at', 'desc')
        .limit(10)
        .select<{ id: number; severity: string; message: string; alert_type: string; created_at: Date | string | null }[]>(
          'id', 'severity', 'message', 'alert_type', 'created_at',
        );
      alerts = rows.map((r) => ({
        id: r.id, severity: r.severity, message: r.message, kind: r.alert_type,
        createdAt: r.created_at ? String(r.created_at) : null,
      }));
    } catch { /* ignore */ }

    // ── Compute the gamified Health score ──────────────────────────────
    // Weighted average across freshness, definitions, relationships,
    // pipeline success rate. Each sub-score is 0-100; we cap "no data"
    // cases at neutral 50 so an empty tenant doesn't show a panic state.
    const safeRatio = (ok: number | string | undefined, total: number | string | undefined): number | null => {
      const n = Number(ok ?? 0);
      const t = Number(total ?? 0);
      if (t === 0) return null;
      return Math.round((n / t) * 100);
    };
    const scoreFreshness = sourcesTotal === 0
      ? null
      : Math.round(((sourcesFresh + productsFresh) / Math.max(1, sourcesTotal + productsTotal)) * 100);
    const scoreTables = safeRatio(tablesDefined, tablesTotal);
    const scoreColumns = safeRatio(columnsDefined, columnsTotal);
    const scoreRels = safeRatio(relsApproved, relsTotal);
    const definitionScore = [scoreTables, scoreColumns, scoreRels].filter((x): x is number => x != null);
    const scoreDefinitions = definitionScore.length === 0
      ? null
      : Math.round(definitionScore.reduce((s, x) => s + x, 0) / definitionScore.length);
    const scorePipelines = pipelineRunsThisWeek === 0
      ? null
      : Math.round((pipelineSuccess / pipelineRunsThisWeek) * 100);

    const subScores = [
      { name: 'freshness',   score: scoreFreshness,   weight: 0.30 },
      { name: 'definitions', score: scoreDefinitions, weight: 0.40 },
      { name: 'pipelines',   score: scorePipelines,   weight: 0.30 },
    ];
    const presentScores = subScores.filter((s): s is { name: string; score: number; weight: number } => s.score != null);
    const overall = presentScores.length === 0
      ? null
      : Math.round(
          presentScores.reduce((s, x) => s + x.score * x.weight, 0)
          / presentScores.reduce((s, x) => s + x.weight, 0),
        );

    res.json({
      ok: true,
      data: {
        health: {
          overall,
          freshness:   scoreFreshness,
          definitions: scoreDefinitions,
          pipelines:   scorePipelines,
        },
        freshness: {
          sources:  { fresh: sourcesFresh,  total: sourcesTotal },
          products: { fresh: productsFresh, total: productsTotal },
          stale: staleSources,        // sources only — kept for back-compat
          staleProducts,              // new — needed for attention list
          allSources,                 // full list for the freshness detail slide-over
          allProducts,
        },
        definitions: {
          tables:        { defined: Number(tablesDefined),  total: Number(tablesTotal) },
          columns:       { defined: Number(columnsDefined), total: Number(columnsTotal) },
          relationships: { approved: Number(relsApproved),  total: Number(relsTotal) },
          pendingReview: {
            tables: Number(pendingTables),
            columns: Number(pendingColumns),
            relationships: Number(pendingRels),
            total: Number(pendingTables) + Number(pendingColumns) + Number(pendingRels),
          },
        },
        pipelines: {
          runsThisWeek: pipelineRunsThisWeek,
          successCount: pipelineSuccess,
          failureCount: pipelineFailures,
          activeNow: activeRuns,
          successRate: scorePipelines,
        },
        dashboards,
        recentQuestions,
        alerts,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

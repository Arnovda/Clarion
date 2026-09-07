/**
 * /api/home — the read model behind the standing brief.
 *
 * One request returns the parts of Home that are not the brief itself:
 *   • Freshness (which sources / subjects are current) — the ops line
 *   • Pinned + recent dashboards
 *   • Recent questions
 *   • Active quality alerts, with Claude's plain-English context
 *
 * WHAT THIS DELIBERATELY NO LONGER COMPUTES, and why. Until 2026-09-07 this
 * endpoint also produced a 0–100 health score, definition-completeness counts
 * over `source_tables` / `source_columns` / `table_relationships`, an average
 * quality score built from two window functions over `dataset_profiles` and
 * `rule_executions`, and a week of `pipeline_runs`. That was ~10 queries per
 * request serving a health ring and a sub-score strip that the Home rebuild
 * removed — the page now reads seven fields.
 *
 * Leaving the computation in place would have meant paying for a UI that no
 * longer exists on every page load AND on every window focus (the page
 * refreshes on focus). The scores are recoverable from git if an operator
 * surface ever wants them; the curator signals they drove now live where the
 * work happens — Sources and Build, which `IconRail` already badges.
 *
 * Designed to be cheap: a handful of indexed reads. The Home page polls this
 * on focus.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'home' });

const router = Router();

const FRESH_WINDOW_HOURS = 24; // "synced today" / "refreshed today"

router.get('/summary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const since = new Date(Date.now() - FRESH_WINDOW_HOURS * 3600_000);

    // ── Sources ─────────────────────────────────────────────────────────
    const sourceRows = await db('connections')
      .where('tenant_id', tenantId)
      .select<{
        id: number; name: string; type: string; connector_type: string | null;
        last_synced_at: Date | string | null; last_sync_status: string | null;
      }[]>('id', 'name', 'type', 'connector_type', 'last_synced_at', 'last_sync_status');

    const allSources = sourceRows.map((s) => ({
      id: s.id,
      name: s.name,
      connectorType: s.connector_type,
      lastSyncedAt: s.last_synced_at ? String(s.last_synced_at) : null,
      lastSyncStatus: s.last_sync_status,
      isStale: !s.last_synced_at || new Date(s.last_synced_at) <= since,
    }));
    const sourcesFresh = allSources.filter((s) => !s.isStale).length;
    const stale = allSources
      .filter((s) => s.isStale)
      .map((s) => ({ id: s.id, name: s.name, lastSyncedAt: s.lastSyncedAt }));

    // ── Subjects ────────────────────────────────────────────────────────
    // Freshness signal = MAX(product_tables.last_run_at) per product.
    // `data_products.updated_at` only changes on metadata edits, so reading
    // it made "refreshed today" permanently 0/N however many refreshes ran.
    // The refresh path writes product_tables.last_run_at via the catalog's
    // publishProductTable, so the correct signal lives one level down.
    const productRows = await db('data_products as dp')
      .where('dp.tenant_id', tenantId)
      .leftJoin('star_schemas as ss', 'dp.id', 'ss.data_product_id')
      .leftJoin('product_tables as pt', function () {
        this.on('ss.id', 'pt.star_schema_id')
            .andOn('pt.transformation_status', db.raw('?', ['success']));
      })
      .groupBy('dp.id', 'dp.name', 'dp.status')
      .select<{ id: number; name: string; status: string; last_refreshed_at: Date | string | null }[]>(
        'dp.id',
        'dp.name',
        'dp.status',
        db.raw('MAX(pt.last_run_at) as last_refreshed_at'),
      );

    const allProducts = productRows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      lastRefreshedAt: p.last_refreshed_at ? String(p.last_refreshed_at) : null,
      isStale: !p.last_refreshed_at || new Date(p.last_refreshed_at) <= since,
    }));
    const productsFresh = allProducts.filter((p) => !p.isStale).length;
    const staleProducts = allProducts.filter((p) => p.isStale);

    // ── Dashboards (favourites first, then recency) ─────────────────────
    // The column is `is_favorite` (migration 20260329000008); `starred` is a
    // conversations/notebooks column and a 2026-09-06 audit found this block
    // selecting it — the query threw on every request and a swallowed catch
    // hid it, so Home read "No dashboards yet" for every tenant. The wire
    // field stays `starred`. Visibility mirrors GET /dashboards: the
    // caller's own plus the team's shared ones.
    let dashboards: Array<{ id: number; title: string; starred: boolean; updatedAt: string | null }> = [];
    try {
      const rows = await db('dashboards')
        .where('tenant_id', tenantId)
        .where(function () {
          this.where({ user_id: req.user!.sub }).orWhere({ is_shared: true });
        })
        .orderBy([{ column: 'is_favorite', order: 'desc' }, { column: 'updated_at', order: 'desc' }])
        .limit(6)
        .select<{ id: number; title: string; is_favorite: boolean | null; updated_at: Date | string | null }[]>(
          'id', 'title', 'is_favorite', 'updated_at',
        );
      dashboards = rows.map((r) => ({
        id: r.id, title: r.title, starred: !!r.is_favorite,
        updatedAt: r.updated_at ? String(r.updated_at) : null,
      }));
    } catch (err) {
      // Never silent again: a wrong column name must show up in the logs.
      log.warn({ err, tenantId }, 'home summary: dashboards query failed');
    }

    // ── Recent questions (this user's own) ──────────────────────────────
    let recentQuestions: Array<{ id: number; title: string | null; lastMessageAt: string | null }> = [];
    try {
      const rows = await db('conversations')
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

    // ── Active quality alerts ───────────────────────────────────────────
    // `ai_context` is Claude's plain-English explanation of the alert — the
    // difference between "Gross margin on SKU dropped 14%" and "...likely a
    // unit-of-measure mismatch on the supplier import". Home renders these
    // as movement cards beside the brief's own bullets: an alert is a thing
    // that moved, and dropping it would lose the one signal that arrives
    // without anyone having put the metric on their watchlist.
    let alerts: Array<{ id: number; severity: string; message: string; aiContext: string | null; kind: string; createdAt: string | null }> = [];
    try {
      const rows = await db('quality_alerts')
        .where('tenant_id', tenantId)
        .where('dismissed', false)
        .orderBy('created_at', 'desc')
        .limit(10)
        .select<{ id: number; severity: string; message: string; ai_context: string | null; alert_type: string; created_at: Date | string | null }[]>(
          'id', 'severity', 'message', 'ai_context', 'alert_type', 'created_at',
        );
      alerts = rows.map((r) => ({
        id: r.id, severity: r.severity, message: r.message,
        aiContext: r.ai_context ?? null,
        kind: r.alert_type,
        createdAt: r.created_at ? String(r.created_at) : null,
      }));
    } catch { /* ignore */ }

    res.json({
      ok: true,
      data: {
        freshness: {
          sources:  { fresh: sourcesFresh,  total: allSources.length },
          products: { fresh: productsFresh, total: allProducts.length },
          stale,
          staleProducts,
          allSources,
          allProducts,
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

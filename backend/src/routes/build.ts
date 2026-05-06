/**
 * /api/build — backend for the Build (workshop) dashboard.
 *
 * The Build page is the operator surface — admins/analysts come here to
 * design, refresh, and operate data products. The dashboard endpoint
 * serves four things in one round-trip:
 *
 *   - products[]      Per-product summary with status (OK / stale / error /
 *                     designing) so the workshop list can render with rich
 *                     operator signals.
 *   - statusCounts    Aggregate counts for the four status tiles at the
 *                     top of the dashboard.
 *   - recentActivity  Last ~20 pipeline runs and notable notifications,
 *                     framed as "what's happened recently?"
 *   - suggestions     Proactive AI-co-pilot prompts: schema drift events,
 *                     failed transformations with auto-fix availability,
 *                     unbuilt source tables. Empty array for v1 if there
 *                     are no signals.
 *
 * Single endpoint (instead of /suggestions + /status-summary + /products)
 * because the cache invalidation is the same — any product refresh /
 * sync / rebuild affects all four payloads. One Redis key, one fetch.
 *
 * RLS-scoped via tenantQuery — every read goes through the tenant's
 * RLS context so cross-tenant leaks are structurally impossible.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { tenantQuery } from '../services/tenantQuery';

const router = Router();

const STALE_HOURS = 24;

interface DashboardProduct {
  id: number;
  name: string;
  description: string | null;
  status: string;                                 // raw data_products.status
  derivedStatus: 'ok' | 'stale' | 'error' | 'designing';
  lastRefreshedAt: string | null;
  tableCount: number;
  kpiCount: number;
  failedTableCount: number;
  source: {
    id: number | null;
    name: string | null;
    connectorType: string | null;
  };
}

interface DashboardSuggestion {
  id: string;                       // stable client key (e.g. 'drift:23', 'failed:201')
  kind: 'drift' | 'failed' | 'unbuilt' | 'kpi';
  severity: 'info' | 'warning' | 'error';
  productId: number | null;
  productName: string | null;
  text: string;
  /** Optional follow-up action the UI can offer as a button. */
  action?: { label: string; href?: string; method?: string; endpoint?: string };
}

interface DashboardActivity {
  id: string;                       // 'run:N' / 'notif:N'
  at: string;                       // ISO
  kind: 'refresh' | 'design' | 'suggestion' | 'alert';
  productId: number | null;
  productName: string | null;
  status: string;                   // 'succeeded' / 'failed' / 'running' / etc.
  message: string;
}

interface DashboardResponse {
  products: DashboardProduct[];
  statusCounts: {
    total: number;
    ok: number;
    stale: number;
    error: number;
    designing: number;
  };
  suggestions: DashboardSuggestion[];
  recentActivity: DashboardActivity[];
}

router.get('/dashboard', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const since = new Date(Date.now() - STALE_HOURS * 3600 * 1000);

    const data = await tenantQuery(tenantId, async (trx) => {
      // ── Products with derived status ─────────────────────────────────
      // Reuses the same enrichment shape as GET /api/products: kpi count,
      // table count, last_refreshed_at (MAX of product_tables.last_run_at
      // for successfully transformed tables).
      const products = await trx('data_products as dp')
        .leftJoin('star_schemas as ss', 'dp.id', 'ss.data_product_id')
        .leftJoin('product_tables as pt', 'pt.star_schema_id', 'ss.id')
        .groupBy('dp.id')
        .select<Array<{
          id: number;
          name: string;
          description: string | null;
          status: string;
          connection_id: number | null;
          last_refreshed_at: Date | string | null;
          table_count: string | number;
          failed_table_count: string | number;
          success_table_count: string | number;
        }>>(
          'dp.id', 'dp.name', 'dp.description', 'dp.status', 'dp.connection_id',
          trx.raw(`MAX(pt.last_run_at) FILTER (WHERE pt.transformation_status = 'success') as last_refreshed_at`),
          trx.raw(`COUNT(pt.id) as table_count`),
          trx.raw(`COUNT(pt.id) FILTER (WHERE pt.transformation_status = 'error') as failed_table_count`),
          trx.raw(`COUNT(pt.id) FILTER (WHERE pt.transformation_status = 'success') as success_table_count`),
        );

      const productIds = products.map((p) => Number(p.id));
      const kpisByProduct = new Map<number, number>();
      if (productIds.length > 0) {
        const kpiRows = await trx('product_kpis')
          .whereIn('data_product_id', productIds)
          .select('data_product_id')
          .count<{ data_product_id: number; cnt: string }[]>('* as cnt')
          .groupBy('data_product_id');
        for (const r of kpiRows) {
          kpisByProduct.set(Number(r.data_product_id), Number(r.cnt));
        }
      }

      // Connection lookup — single fetch, mapped by id for the source block.
      const connectionIds = Array.from(new Set(
        products.map((p) => p.connection_id).filter((id): id is number => id != null),
      ));
      const conns = connectionIds.length > 0
        ? await trx('connections')
            .whereIn('id', connectionIds)
            .select('id', 'name', 'type', 'connector_type')
        : [];
      const connMap = new Map<number, { name: string; connectorType: string | null }>(
        conns.map((c) => [Number(c.id), { name: String(c.name), connectorType: c.connector_type }]),
      );

      // Derive a single status for each product so the UI can show one
      // pill instead of dim-witted overlapping states.
      //   error     → any product_table has transformation_status='error'
      //   designing → status='draft' AND no successful tables yet
      //   stale     → no last_refresh OR last_refresh > STALE_HOURS old
      //   ok        → otherwise
      const dashProducts: DashboardProduct[] = products.map((p) => {
        const failedTableCount = Number(p.failed_table_count ?? 0);
        const successTableCount = Number(p.success_table_count ?? 0);
        const lastRefreshedAt = p.last_refreshed_at instanceof Date
          ? p.last_refreshed_at.toISOString()
          : (p.last_refreshed_at ?? null);
        const isStale = !lastRefreshedAt || new Date(lastRefreshedAt) <= since;

        let derivedStatus: DashboardProduct['derivedStatus'];
        if (failedTableCount > 0) derivedStatus = 'error';
        else if (p.status === 'draft' && successTableCount === 0) derivedStatus = 'designing';
        else if (isStale) derivedStatus = 'stale';
        else derivedStatus = 'ok';

        const conn = p.connection_id != null ? connMap.get(p.connection_id) : null;

        return {
          id: Number(p.id),
          name: String(p.name),
          description: p.description ?? null,
          status: String(p.status),
          derivedStatus,
          lastRefreshedAt,
          tableCount: Number(p.table_count ?? 0),
          kpiCount: kpisByProduct.get(Number(p.id)) ?? 0,
          failedTableCount,
          source: {
            id: p.connection_id ?? null,
            name: conn?.name ?? null,
            connectorType: conn?.connectorType ?? null,
          },
        };
      });

      // ── Status counts ────────────────────────────────────────────────
      const statusCounts = {
        total: dashProducts.length,
        ok: dashProducts.filter((p) => p.derivedStatus === 'ok').length,
        stale: dashProducts.filter((p) => p.derivedStatus === 'stale').length,
        error: dashProducts.filter((p) => p.derivedStatus === 'error').length,
        designing: dashProducts.filter((p) => p.derivedStatus === 'designing').length,
      };

      // ── Recent activity ──────────────────────────────────────────────
      // Pipeline runs are the operator's "what just happened" feed —
      // refreshes, builds, scheduled re-runs. Last 20.
      let recentActivity: DashboardActivity[] = [];
      try {
        const runs = await trx('pipeline_runs')
          .orderBy('queued_at', 'desc')
          .limit(20)
          .select('id', 'pipeline_kind', 'pipeline_id', 'status', 'queued_at', 'finished_at', 'triggered_by');
        recentActivity = runs.map((r) => {
          const started = r.finished_at ?? r.queued_at;
          return {
            id: `run:${r.id}`,
            at: started instanceof Date ? started.toISOString() : String(started),
            kind: r.pipeline_kind === 'design' ? 'design' as const : 'refresh' as const,
            productId: null,             // Not always tied to a single product — pipelines can scope multiple
            productName: null,
            status: String(r.status),
            message: `${r.pipeline_kind === 'design' ? 'Design' : 'Refresh'} (${r.pipeline_id}) — ${r.status}`,
          };
        });
      } catch {
        // pipeline_runs table may not exist on legacy installs — non-fatal.
      }

      // ── Suggestions ──────────────────────────────────────────────────
      // v1 keeps it simple: surface failed transformations as actionable
      // suggestions. Drift detection + AI-suggested KPIs are stubs to be
      // expanded in Phase 8.
      const suggestions: DashboardSuggestion[] = [];

      // Failed transformations → "Investigate {Product}" suggestion
      for (const p of dashProducts) {
        if (p.derivedStatus === 'error' && p.failedTableCount > 0) {
          suggestions.push({
            id: `failed:${p.id}`,
            kind: 'failed',
            severity: 'error',
            productId: p.id,
            productName: p.name,
            text: `${p.name} has ${p.failedTableCount} failed table${p.failedTableCount === 1 ? '' : 's'} — review and refresh.`,
            action: { label: 'Open product', href: `/products/${p.id}` },
          });
        }
      }
      // Stale products → "Refresh {Product}" suggestion
      for (const p of dashProducts) {
        if (p.derivedStatus === 'stale') {
          suggestions.push({
            id: `stale:${p.id}`,
            kind: 'drift',
            severity: 'warning',
            productId: p.id,
            productName: p.name,
            text: `${p.name} hasn't been refreshed in over a day — schedule a sync?`,
            action: { label: 'Refresh now', endpoint: `/api/products/${p.id}/refresh-start`, method: 'POST' },
          });
        }
      }

      return { products: dashProducts, statusCounts, suggestions, recentActivity } as DashboardResponse;
    });

    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

export default router;

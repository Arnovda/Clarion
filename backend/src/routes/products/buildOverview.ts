/**
 * Products router: GET /build-overview — the Build page's single read model.
 *
 * The Build page (Studio → Build) is the tenant-level answer to "what can my
 * data become, what already exists, and what feeds what?" — the coverage
 * checklist of warehouse doc §2.1b given a home. It is tenant-wide on
 * purpose: preparing data is not a per-source act (conformed dimensions span
 * sources), so this endpoint returns EVERY connection with, per connection:
 *
 *   - sync + analyse state (whether the primary action can run, and what to
 *     point at when it can't);
 *   - the PLAN: the topics the connector's deterministic star-schema
 *     template would build from the tables actually synced — computed by
 *     instantiating the real template, so the promise shown before the
 *     build is exactly what the build produces, never a hand-maintained
 *     copy of it;
 *   - the built products, with the `hidden` visibility flag (show/hide IS
 *     the topic selection — everything the template can build gets built).
 *
 * Vocabulary: the plan ships DISPLAY names only (topic names, dimension
 *  display names, KPI names). Warehouse table names (dim_/fact_) stay out of
 * the payload so the page cannot accidentally leak them — same discipline
 * as GET /:id/topic.
 *
 * admin+analyst: the role table grants "Design star schema products" to
 * both, and this page is the front door to that flow.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { reqDb } from '../../db/reqDb';
import { tryBuildBusMatrixFromTemplate } from '../../services/starSchemaTemplates';

const router = Router();

interface PlannedTopic {
  name: string;
  description: string;
  /** 'analytics' = a topic row in the rail; 'reference' = the shared-data set. */
  kind: 'analytics' | 'reference';
  /** KPI names the template ships for this topic — the "what you can ask" hint. */
  sampleQuestions: string[];
  /** Display names of the shared lookups this topic slices by. */
  sharedData: string[];
}

router.get('/build-overview', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    // Every query filters tenant_id EXPLICITLY (same rule as the graph
    // endpoint and GET /:id/topic): reqDb can fall back to the pool whose
    // session-level tenant var races, and this endpoint aggregates the two
    // most enumerable things a tenant owns.
    const connections = (await db('connections')
      .where('tenant_id', tenantId)
      .select('id', 'name', 'type', 'connector_type', 'profiling_status', 'last_synced_at', 'last_ingested_at', 'last_sync_status')
      .orderBy('created_at', 'asc')) as Array<{
        id: number; name: string; type: string; connector_type: string | null;
        profiling_status: string | null;
        last_synced_at: Date | string | null; last_ingested_at: Date | string | null;
        last_sync_status: string | null;
      }>;

    const connIds = connections.map((c) => c.id);
    const tableRows = connIds.length
      ? ((await db('source_tables')
          .where('tenant_id', tenantId)
          .whereIn('connection_id', connIds)
          .select('connection_id', 'table_name')) as Array<{ connection_id: number; table_name: string }>)
      : [];
    const tablesByConn = new Map<number, string[]>();
    for (const r of tableRows) {
      const list = tablesByConn.get(r.connection_id);
      if (list) list.push(r.table_name);
      else tablesByConn.set(r.connection_id, [r.table_name]);
    }

    const products = (await db('data_products')
      .where('data_products.tenant_id', tenantId)
      .select('data_products.id', 'data_products.name', 'data_products.description', 'data_products.kind',
        'data_products.status', 'data_products.hidden', 'data_products.connection_id', 'data_products.template_version')
      .select(
        db.raw(`(
          SELECT COUNT(*)
          FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as table_count`),
        db.raw(`(
          SELECT MAX(pt.last_run_at)
          FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as last_refreshed_at`),
        // Total rows across the topic's built tables. NULL when nothing has
        // materialised; 0 means "built, but every table is empty" — a
        // legitimate state since the zero-row Delta fix (an AI-designed
        // fact over entities that synced no data), which the Build page
        // renders as "waiting for data" instead of "refreshed just now".
        db.raw(`(
          SELECT SUM(pt.row_count)
          FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as rows_total`),
      )
      .orderBy('data_products.created_at', 'asc')) as Array<{
        id: number; name: string; description: string | null; kind: string | null;
        status: string | null; hidden: boolean | null; connection_id: number | null;
        template_version: number | null;
        table_count: string | number; last_refreshed_at: Date | string | null;
        rows_total: string | number | null;
      }>;

    const knownConnIds = new Set(connIds);
    const shapeProduct = (p: (typeof products)[number]) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: (p.kind ?? 'analytics') as 'analytics' | 'reference',
      status: p.status,
      hidden: p.hidden === true,
      templateVersion: p.template_version,
      tableCount: Number(p.table_count ?? 0),
      lastRefreshedAt: p.last_refreshed_at ? String(p.last_refreshed_at) : null,
      rowsTotal: p.rows_total === null || p.rows_total === undefined ? null : Number(p.rows_total),
    });

    const sources = connections.map((c) => {
      const tableNames = tablesByConn.get(c.id) ?? [];
      // The plan is the REAL template instantiated against the REAL synced
      // tables — pure in-memory work, no AI, no queries. Null means "no
      // template covers this source" and the build would take the AI path.
      const templated = tableNames.length
        ? tryBuildBusMatrixFromTemplate(c.connector_type, tableNames)
        : null;

      let plan: { templateVersion: number; topics: PlannedTopic[] } | null = null;
      if (templated) {
        const bm = templated.busMatrix;
        const dimDisplayByTable = new Map(bm.conformed_dimensions.map((d) => [d.table_name, d.display_name] as const));
        const kpisByProduct = new Map<string, string[]>();
        for (const k of bm.proposed_kpis) {
          const list = kpisByProduct.get(k.product_name);
          if (list) list.push(k.name);
          else kpisByProduct.set(k.product_name, [k.name]);
        }
        plan = {
          templateVersion: templated.templateVersion,
          topics: bm.data_products.map((p) => ({
            name: p.name,
            description: p.description,
            kind: p.fact_tables.length > 0 ? 'analytics' as const : 'reference' as const,
            sampleQuestions: (kpisByProduct.get(p.name) ?? []).slice(0, 3),
            sharedData: p.owned_dimensions
              .map((t) => dimDisplayByTable.get(t))
              .filter((n): n is string => !!n),
          })),
        };
      }

      return {
        id: c.id,
        name: c.name,
        type: c.type,
        connectorType: c.connector_type,
        profilingStatus: c.profiling_status,
        lastSyncedAt: (c.last_synced_at ?? c.last_ingested_at) ? String(c.last_synced_at ?? c.last_ingested_at) : null,
        lastSyncStatus: c.last_sync_status,
        tableCount: tableNames.length,
        hasTemplate: plan !== null,
        plan,
        products: products.filter((p) => p.connection_id === c.id).map(shapeProduct),
      };
    });

    // Products whose connection is gone still exist and still render in the
    // rail — surface them rather than making them unreachable from Build.
    const unassignedProducts = products
      .filter((p) => !p.connection_id || !knownConnIds.has(p.connection_id))
      .map(shapeProduct);

    res.json({ ok: true, data: { sources, unassignedProducts } });
  } catch (err) { next(err); }
});

export default router;

/**
 * Products router (2/9): product CRUD — create, dependency-graph,
 * by-source-table, get/update/delete by id, sources. The literal routes
 * /dependency-graph and /by-source-table/:sourceTableId MUST stay
 * registered before the /:id routes below (see their inline comments).
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { createProductSchema, updateProductSchema } from '../../middleware/schemas';
import { deleteProductFromNeo4j } from '../../services/productGraphSync';
import { deleteWarehousePaths, productBasePath, productBasePathV2, warehouseLayoutVersion, productSlug as toProductSlug } from '../../services/warehouse';
import { listProductTables } from '../../services/tableCatalog';
import { recordAudit } from '../../services/auditService';
import { reqDb } from '../../db/reqDb';
import { log } from './shared';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/products — Create a data product
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requireRole('admin'), validate(createProductSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, description, connectionId, sourceTables } = req.body as {
      name: string;
      description?: string;
      connectionId: number;
      sourceTables: { sourceTableId: number; tableName: string }[];
    };

    const [row] = await db('data_products')
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
      await db('data_product_sources').insert(
        sourceTables.map((s) => ({
          data_product_id: productId,
          source_table_id: s.sourceTableId,
          table_name: s.tableName,
        })),
      );
    }

    await recordAudit(req, {
      action:     'product.create',
      entityType: 'product',
      entityId:   productId,
      context:    { name, connection_id: connectionId, source_table_count: sourceTables?.length ?? 0 },
    });

    res.json({ ok: true, data: { id: productId } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/dependency-graph — All dependency edges for this tenant
// Must be before /:id routes to avoid being captured by the param handler
// ---------------------------------------------------------------------------

router.get('/dependency-graph', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const deps = await db('data_product_dependencies')
      .select('dependent_product_id', 'source_product_id');
    res.json({ ok: true, data: deps });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/by-source-table/:sourceTableId — Products referencing a source table
// Must be before /:id routes to avoid being captured by the param handler
// ---------------------------------------------------------------------------

router.get('/by-source-table/:sourceTableId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const sourceTableId = Number(req.params.sourceTableId);
    if (!Number.isFinite(sourceTableId)) {
      res.status(400).json({ ok: false, error: 'sourceTableId required' });
      return;
    }
    const rows = await db('data_product_sources as dps')
      .join('data_products as dp', 'dp.id', 'dps.data_product_id')
      .where('dps.source_table_id', sourceTableId)
      .select('dp.id', 'dp.name', 'dp.status');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id — Full data product with star schemas, tables, columns, lineage, relationships
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Star schemas
    const schemas = await db('star_schemas')
      .where({ data_product_id: product.id })
      .orderBy('id');

    // Tables
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const rawTables = schemaIds.length
      ? await db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];

    // Enrich reference rows (rows that point at an owner via source_product_table_id)
    // with the owner's freshness fields and product name. Without this, a consumer
    // product's UI shows stale "last_run_at" / row_count for shared dims that are
    // only physically rebuilt under their owning product.
    const ownerIds = rawTables
      .map((t: { source_product_table_id?: number | null }) => t.source_product_table_id)
      .filter((id): id is number => typeof id === 'number');
    const owners = ownerIds.length
      ? await db('product_tables as pt')
          .leftJoin('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
          .leftJoin('data_products as dp', 'ss.data_product_id', 'dp.id')
          .whereIn('pt.id', ownerIds)
          .select(
            'pt.id', 'pt.transformation_status', 'pt.last_run_at',
            'pt.last_run_error', 'pt.row_count', 'pt.delta_path',
            'dp.id as owner_product_id', 'dp.name as owner_product_name',
          )
      : [];
    const ownerById = new Map(owners.map((o: { id: number }) => [o.id, o]));

    const tables: any[] = rawTables.map((t: any) => {
      const ownerId = t.source_product_table_id as number | null | undefined;
      if (!ownerId) return t;
      const owner = ownerById.get(ownerId) as any;
      if (!owner) return t;
      return {
        ...t,
        transformation_status: owner.transformation_status ?? t.transformation_status,
        last_run_at: owner.last_run_at ?? t.last_run_at,
        last_run_error: owner.last_run_error ?? t.last_run_error,
        row_count: owner.row_count ?? t.row_count,
        delta_path: owner.delta_path ?? t.delta_path,
        owner_product_id: owner.owner_product_id ?? null,
        owner_product_name: owner.owner_product_name ?? null,
        is_reference: true,
      };
    });

    // Columns. Hide technical columns (`_row_hash` today; future SCD2
    // metadata) from the product detail panel — these are physical-storage
    // concerns the curator never authors or describes.
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await db('product_columns')
          .whereIn('product_table_id', tableIds)
          .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
          .orderBy(['sort_order', 'id'])
      : [];

    // Lineage
    const columnIds = columns.map((c: { id: number }) => c.id);
    const lineage = columnIds.length
      ? await db('column_lineage').whereIn('product_column_id', columnIds)
      : [];

    // Relationships
    const relationships = schemaIds.length
      ? await db('product_relationships as pr')
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
      ? await db('transformation_checks').whereIn('product_table_id', tableIds)
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

    // Compute the same `source` block the list endpoint returns so the
    // detail panel can show <SourceBadge> consistently with /products and
    // the catalog tree.
    const dpsRows = await db('data_product_sources as dps')
      .join('source_tables as st', 'st.id', 'dps.source_table_id')
      .where('dps.data_product_id', product.id)
      .select('st.connection_id as connection_id');
    const tally = new Map<number, number>();
    for (const r of dpsRows as { connection_id: number }[]) {
      if (!r.connection_id) continue;
      tally.set(r.connection_id, (tally.get(r.connection_id) ?? 0) + 1);
    }
    const contributors = Array.from(tally.entries()).sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    const primaryId = contributors[0]?.[0] ?? product.connection_id ?? null;
    const involvedIds = new Set<number>(contributors.map(([id]) => id));
    if (product.connection_id) involvedIds.add(product.connection_id);
    const connRows = involvedIds.size
      ? await db('connections')
          .whereIn('id', Array.from(involvedIds))
          .select('id', 'name', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; connector_type: string | null }>(
      connRows.map((c: { id: number; name: string; connector_type: string | null }) => [c.id, c] as const),
    );
    const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
    const otherSources = contributors.slice(1)
      .map(([id]) => connMap.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ id: c.id, name: c.name, connectorType: c.connector_type }));
    const source = {
      id: primaryConn?.id ?? null,
      name: primaryConn?.name ?? null,
      connectorType: primaryConn?.connector_type ?? null,
      multiSource: contributors.length > 1,
      sourceDeleted: primaryId != null && !primaryConn,
      otherSources,
    };

    const result = {
      ...product,
      source,
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

router.put('/:id', requireAuth, requireRole('admin'), validate(updateProductSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, description, status } = req.body as { name?: string; description?: string; status?: string };
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;

    await db('data_products').where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/products/:id — Delete data product (cascade)
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);

    // Collect table info before cascading delete removes it
    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await db('star_schemas').where({ data_product_id: productId }).select('id');
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const tables = schemaIds.length
      ? await db('product_tables').whereIn('star_schema_id', schemaIds).select('table_name', 'delta_path')
      : [];
    const connId = product.connection_id;

    // Clean up quality data for product tables (keyed by connection_id + table_name, no FK cascade)
    for (const t of tables) {
      const tn = t.table_name as string;
      // Delete quality rules (cascades to rule_executions + quality_failures)
      await db('quality_rules').where({ connection_id: connId, table_name: tn }).delete();
      // Delete quality score history
      await db('quality_score_history').where({ connection_id: connId, table_name: tn }).delete();
      // Delete field profiles via dataset_profiles
      const profiles = await db('dataset_profiles')
        .where({ connection_id: connId, table_name: tn }).select('id');
      if (profiles.length) {
        await db('field_profiles').whereIn('profile_id', profiles.map((p: { id: number }) => p.id)).delete();
        await db('dataset_profiles').where({ connection_id: connId, table_name: tn }).delete();
      }
    }

    // Clean up the warehouse data files. We collect every possible
    // location the product's data might live BEFORE we wipe the
    // metadata rows (the catalog reads from those rows).
    //
    // Three sources, in priority order:
    //   1. The catalog's resolved URIs — what `delta_path` actually
    //      says for each materialised product_tables row. Authoritative
    //      because it captures the historical writer's exact location,
    //      including the v1 vs v2 layout chosen at write time.
    //   2. The expected v2 product directory — `tenant_<tid>/product_<pid>`
    //      under the warehouse root. Catches v2 deployments where the
    //      catalog rows might miss empty/never-written directories.
    //   3. The expected v1 product directory — `./warehouse/product/<slug>`
    //      (local) or `az://.../products/<slug>` (azure). Catches
    //      legacy deployments where the catalog rows are gone but the
    //      files were never migrated.
    //
    // Best-effort: per-blob failures are logged into the audit
    // context, never block the DB-row deletion. Orphan blobs are
    // recoverable (and we can re-run cleanup), orphan rows are not.
    const slug = toProductSlug(product.name as string);
    const tenantId = req.user!.tenantId;
    const conn = await db('connections').where({ id: connId }).first();
    const sourceWarehousePath: string = conn?.warehouse_path ?? `./warehouse/conn_${connId}`;

    const urisToDelete = new Set<string>();

    // (1) Resolved URIs from the catalog — one per ready product_tables row.
    try {
      const resolved = await listProductTables(tenantId, productId);
      for (const t of resolved) {
        if (t.uri) urisToDelete.add(t.uri);
      }
    } catch (err) {
      log.warn({ err }, '[products.delete] catalog lookup failed; falling back to layout-based paths');
    }

    // (2) Expected v2 product directory. Stable across renames.
    urisToDelete.add(productBasePathV2(tenantId, productId));

    // (3) Expected v1 product directory. Slug-based; only matters for
    //     legacy deployments. productBasePath handles azure vs local.
    if (warehouseLayoutVersion() === 'v1' || sourceWarehousePath) {
      urisToDelete.add(productBasePath(sourceWarehousePath, slug));
    }

    const warehouseDeleteResult = await deleteWarehousePaths(Array.from(urisToDelete));
    if (warehouseDeleteResult.errors.length > 0) {
      log.warn(
        { errors: warehouseDeleteResult.errors.slice(0, 5) },
        `[products.delete] product=${productId} warehouse cleanup had ${warehouseDeleteResult.errors.length} errors`,
      );
    }
    log.info(
      `product=${productId} deleted ${warehouseDeleteResult.deleted} warehouse file(s) ` +
      `(${warehouseDeleteResult.kind}) from ${urisToDelete.size} candidate path(s)`,
    );

    // Delete product row (cascades to star_schemas → product_tables → product_columns)
    await db('data_products').where({ id: productId }).delete();

    // Remove product graph from Neo4j — fire-and-forget, non-db.
    // Neo4j is a separate store with its own driver/connection pool;
    // a failure here cannot poison the Postgres request transaction.
    deleteProductFromNeo4j(productId).catch(() => {}); // fire-and-forget

    await recordAudit(req, {
      action:     'product.delete',
      entityType: 'product',
      entityId:   productId,
      context: {
        product_name:           product.name,
        kind:                   product.kind,
        tables_deleted:         tables.length,
        warehouse_files_deleted: warehouseDeleteResult.deleted,
        warehouse_storage_kind:  warehouseDeleteResult.kind,
        warehouse_errors:        warehouseDeleteResult.errors.length || undefined,
      },
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/sources — Source tables assigned to this data product
// ---------------------------------------------------------------------------

router.get('/:id/sources', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const sources = await db('data_product_sources')
      .where({ data_product_id: req.params.id })
      .orderBy('table_name');
    res.json({ ok: true, data: sources });
  } catch (err) { next(err); }
});


export default router;

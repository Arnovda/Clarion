import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { createSourceConnector } from '../connectors/ConnectorFactory';
import { DuckDBConnector } from '../connectors/DuckDBConnector';
import { decryptCredentials, isEncrypted } from '../utils/crypto';
import { triggerMaintenanceNow } from '../jobs/warehouseMaintenance';
import { invalidateTenantCache } from '../services/queryCache';
import { invalidateWidgetCache } from '../services/widgetCache';
import { isAzurePath } from '../services/warehouse';
import { startSSE } from '../services/sse';
import { trackMetric, trackEvent } from '../utils/monitoring';
import axios from 'axios';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'ingestion' });

const router = Router();

const ETL_URL = process.env.ETL_URL ?? 'http://localhost:8000';

/**
 * Maps a host file path to the Docker container's mount point.
 * The ETL container mounts ./data → /sources (read-only).
 * So we need to convert paths like "C:\Users\...\databridge\data\sample.db"
 * to "/sources/sample.db".
 */
/**
 * Maps the Docker container's warehouse path to the host-side bind mount.
 * Docker: /warehouse/conn_1  →  Host: <project>/warehouse/conn_1
 */
function remapWarehouseToHost(dockerPath: string): string {
  if (process.env.NODE_ENV === 'production') {
    // In Azure both ETL and backend mount the same Azure Files share at /warehouse
    return dockerPath;
  }
  // Local dev: docker-compose maps ./warehouse → /warehouse
  const relativePart = dockerPath.replace(/^\/warehouse\/?/, '');
  return path.resolve(__dirname, '../../../warehouse', relativePart);
}

function remapPathForDocker(config: Record<string, unknown>): Record<string, unknown> {
  const filepath = config.filepath as string | undefined;
  if (!filepath) return config;

  // Extract just the filename from whatever path format
  const filename = filepath.replace(/\\/g, '/').split('/').pop();
  return { ...config, filepath: `/sources/${filename}` };
}

/**
 * Parse and decrypt the config stored in the connections table.
 * Handles both encrypted strings and JSONB objects with an `encrypted` wrapper.
 */
function decryptConfig(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw === 'object') {
    // Wrapped encrypted config: { encrypted: "enc:..." }
    if (raw.encrypted && typeof raw.encrypted === 'string' && isEncrypted(raw.encrypted)) {
      return JSON.parse(decryptCredentials(raw.encrypted));
    }
    return raw;
  }
  // String config — check if encrypted
  if (isEncrypted(raw)) {
    return JSON.parse(decryptCredentials(raw));
  }
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// GET /api/ingestion/discover?connectionId=1
// List all tables available in the source (with row counts / column counts)
// ---------------------------------------------------------------------------
router.get('/discover', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const connectionId = Number(req.query.connectionId);
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const conn = await db('connections').where({ id: connectionId }).first();
    if (!conn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const config = decryptConfig(conn.config);
    log.info(`discover: type=${conn.type}, configKeys=${Object.keys(config).join(',')}`);

    // Call the ETL service to discover tables — remap paths for Docker
    const etlPayload = {
      source_type: conn.type,
      config: remapPathForDocker(config),
    };
    const etlRes = await axios.post(`${ETL_URL}/discover`, etlPayload, { timeout: 30000 });

    if (!etlRes.data.ok) {
      // deliberate-500: static friendly message, no raw error to leak (ETL responded but reported failure — no `err` to rethrow)
      res.status(500).json({ ok: false, error: 'ETL discover failed' });
      return;
    }

    // Also fetch any existing ingested_tables rows so we can show their status
    const existing = await db('ingested_tables').where({ connection_id: connectionId });
    const statusMap = new Map(existing.map((r: { table_name: string; status: string; ingested_at: string | null }) =>
      [r.table_name, { status: r.status, ingested_at: r.ingested_at }]
    ));

    const tables = etlRes.data.tables.map((t: { table_name: string; row_count: number; column_count: number }) => ({
      ...t,
      ingestion_status: statusMap.get(t.table_name)?.status ?? null,
      ingested_at: statusMap.get(t.table_name)?.ingested_at ?? null,
    }));

    res.json({ ok: true, data: tables });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.code === 'ECONNREFUSED') {
        res.status(503).json({ ok: false, error: 'ETL service is not running. Start it with: docker compose up -d etl' });
        return;
      }
      // Forward ETL error details (e.g. 422 validation error)
      const detail = err.response?.data?.detail ?? err.response?.data?.error ?? err.message;
      log.error(`discover: ETL error ${err.response?.status}: ${JSON.stringify(detail)}`);
      res.status(err.response?.status ?? 500).json({ ok: false, error: `ETL error: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingestion/ingest
// Body: { connectionId, tables: ["orders", "customers", ...] }
// Triggers the ETL service, updates ingested_tables rows, then auto-profiles.
// ---------------------------------------------------------------------------
router.post('/ingest', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const { connectionId, tables } = req.body as { connectionId: number; tables: string[] };
    if (!connectionId || !tables?.length) {
      res.status(400).json({ ok: false, error: 'connectionId and tables[] required' });
      return;
    }

    const conn = await db('connections').where({ id: connectionId }).first();
    if (!conn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const config = decryptConfig(conn.config);

    // Mark connection as ingesting
    await db('connections').where({ id: connectionId }).update({
      ingestion_status: 'running',
      ingestion_progress: 0,
      ingestion_error: null,
    });

    // Upsert ingested_tables rows as 'pending'
    for (const tableName of tables) {
      await db('ingested_tables')
        .insert({
          connection_id: connectionId,
          table_name: tableName,
          status: 'pending',
        })
        .onConflict(['connection_id', 'table_name'])
        .merge({ status: 'pending', error: null });
    }

    // Remove any ingested_tables that are NOT in the selected set
    await db('ingested_tables')
      .where({ connection_id: connectionId })
      .whereNotIn('table_name', tables)
      .delete();

    // Build table_specs with watermark info for incremental loads
    const existingRows = await db('ingested_tables')
      .where({ connection_id: connectionId })
      .whereIn('table_name', tables)
      .select('table_name', 'load_mode', 'watermark_column', 'watermark_value');

    const tableSpecs = existingRows.map((row: {
      table_name: string; load_mode: string;
      watermark_column: string | null; watermark_value: string | null;
    }) => ({
      table_name: row.table_name,
      load_mode: row.load_mode ?? 'full',
      watermark_column: row.watermark_column,
      watermark_value: row.watermark_value,
    }));

    // SSE streaming response
    const wantsStream = req.headers.accept?.includes('text/event-stream');
    const streamStart = Date.now();
    const syncStart = streamStart;
    if (wantsStream) {
      const sse = startSSE(res);

      const emit = (data: object) => sse.emit(data);

      try {
        emit({ phase: 'ingesting', message: `Ingesting ${tables.length} table(s)…` });

        // Call ETL service (with watermark specs for incremental)
        const tenantId = (req as unknown as { user?: { tenantId?: number } }).user?.tenantId;
        const etlRes = await axios.post(`${ETL_URL}/ingest`, {
          source_type: conn.type,
          config: remapPathForDocker(config),
          connection_id: connectionId,
          tenant_id: tenantId ?? null,
          tables,
          table_specs: tableSpecs,
        }, { timeout: 600000 }); // 10 min timeout for large tables

        const results = etlRes.data.results ?? [];
        // Blob paths (az://...) don't need remapping; local paths do
        const rawPath = etlRes.data.warehouse_path as string;
        const warehousePath = isAzurePath(rawPath) ? rawPath : remapWarehouseToHost(rawPath);

        // Update ingested_tables with results (including watermark)
        let doneCount = 0;
        for (const r of results as Array<{
          table_name: string; status: string;
          row_count?: number; file_size_bytes?: number;
          delta_path?: string; error?: string;
          new_watermark?: string;
        }>) {
          const updateData: Record<string, unknown> = {
            status: r.status,
            row_count: r.row_count ?? null,
            file_size_bytes: r.file_size_bytes ?? null,
            delta_path: r.delta_path ?? null,
            error: r.error ?? null,
            ingested_at: r.status === 'done' ? new Date().toISOString() : null,
          };
          // Update watermark value if ETL returned a new one
          if (r.new_watermark) {
            updateData.watermark_value = r.new_watermark;
          }
          await db('ingested_tables')
            .where({ connection_id: connectionId, table_name: r.table_name })
            .update(updateData);

          doneCount++;
          const pct = Math.round((doneCount / tables.length) * 100);
          emit({
            phase: 'ingesting',
            message: `${r.table_name}: ${r.status}${r.row_count ? ` (${r.row_count} rows)` : ''}`,
            table: r.table_name,
            tableIndex: doneCount - 1,
            tableCount: tables.length,
            progress: pct,
          });
        }

        // Update connection
        const allDone = results.every((r: { status: string }) => r.status === 'done');
        const nowTs = new Date().toISOString();
        await db('connections').where({ id: connectionId }).update({
          ingestion_status: allDone ? 'done' : 'error',
          ingestion_progress: 100,
          ingestion_error: allDone ? null : 'Some tables failed to ingest',
          last_ingested_at: nowTs,
          last_synced_at: allDone ? nowTs : undefined,
          warehouse_path: warehousePath,
          query_engine: allDone ? 'duckdb' : 'source',
        });

        // Invalidate any pooled DuckDB instances for this warehouse so the next
        // query rebuilds views over the new table set.
        await DuckDBConnector.invalidateWarehouse(warehousePath);

        // Fresh ingestion may add new tables → cached SQL context + widget results are stale.
        const streamTenantId = (req as unknown as { user?: { tenantId?: number } }).user?.tenantId;
        if (streamTenantId) {
          await invalidateTenantCache(streamTenantId);
          invalidateWidgetCache(streamTenantId);
        }

        const succeeded = results.filter((r: { status: string }) => r.status === 'done').length;
        trackMetric('ingestion_ms', Date.now() - streamStart, {
          connectionId: String(connectionId),
          tables: String(tables.length),
          mode: 'stream',
        });
        trackEvent('ingestion_complete', {
          connectionId: String(connectionId),
          mode: 'stream',
          outcome: succeeded === tables.length ? 'success' : 'partial',
        }, { succeeded, total: tables.length });

        emit({
          phase: 'done',
          message: `Ingestion complete — ${succeeded}/${tables.length} tables ingested`,
          warehouse_path: warehousePath,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Ingestion failed';
        await db('connections').where({ id: connectionId }).update({
          ingestion_status: 'error',
          ingestion_error: errMsg,
        });
        emit({ phase: 'error', message: errMsg });
      }
      sse.end();
    } else {
      // Synchronous fallback
      try {
        const syncTenantId = (req as unknown as { user?: { tenantId?: number } }).user?.tenantId;
        const etlRes = await axios.post(`${ETL_URL}/ingest`, {
          source_type: conn.type,
          config: remapPathForDocker(config),
          connection_id: connectionId,
          tenant_id: syncTenantId ?? null,
          tables,
          table_specs: tableSpecs,
        }, { timeout: 600000 });

        const results = etlRes.data.results ?? [];
        const rawSyncPath = etlRes.data.warehouse_path as string;
        const warehousePath = isAzurePath(rawSyncPath) ? rawSyncPath : remapWarehouseToHost(rawSyncPath);

        for (const r of results as Array<{
          table_name: string; status: string;
          row_count?: number; file_size_bytes?: number;
          delta_path?: string; error?: string;
          new_watermark?: string;
        }>) {
          const updateData: Record<string, unknown> = {
            status: r.status,
            row_count: r.row_count ?? null,
            file_size_bytes: r.file_size_bytes ?? null,
            delta_path: r.delta_path ?? null,
            error: r.error ?? null,
            ingested_at: r.status === 'done' ? new Date().toISOString() : null,
          };
          if (r.new_watermark) {
            updateData.watermark_value = r.new_watermark;
          }
          await db('ingested_tables')
            .where({ connection_id: connectionId, table_name: r.table_name })
            .update(updateData);
        }

        const allDone = results.every((r: { status: string }) => r.status === 'done');
        const syncNowTs = new Date().toISOString();
        await db('connections').where({ id: connectionId }).update({
          ingestion_status: allDone ? 'done' : 'error',
          ingestion_progress: 100,
          last_ingested_at: syncNowTs,
          last_synced_at: allDone ? syncNowTs : undefined,
          warehouse_path: warehousePath,
          query_engine: allDone ? 'duckdb' : 'source',
        });

        await DuckDBConnector.invalidateWarehouse(warehousePath);

        const syncTenantId2 = (req as unknown as { user?: { tenantId?: number } }).user?.tenantId;
        if (syncTenantId2) {
          await invalidateTenantCache(syncTenantId2);
          invalidateWidgetCache(syncTenantId2);
        }

        const syncSucceeded = results.filter((r: { status: string }) => r.status === 'done').length;
        trackMetric('ingestion_ms', Date.now() - syncStart, {
          connectionId: String(connectionId),
          tables: String(tables.length),
          mode: 'sync',
        });
        trackEvent('ingestion_complete', {
          connectionId: String(connectionId),
          mode: 'sync',
          outcome: syncSucceeded === tables.length ? 'success' : 'partial',
        }, { succeeded: syncSucceeded, total: tables.length });

        res.json({ ok: true, data: { results, warehouse_path: warehousePath } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Ingestion failed';
        await db('connections').where({ id: connectionId }).update({
          ingestion_status: 'error',
          ingestion_error: errMsg,
        });
        // Rethrow to the central errorHandler (admins see the real message,
        // others a generic one) instead of echoing the raw error inline.
        throw err;
      }
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ingestion/status?connectionId=1
// Returns ingestion status for a connection and its tables
// ---------------------------------------------------------------------------
router.get('/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const connectionId = Number(req.query.connectionId);
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const conn = await db('connections')
      .where({ id: connectionId })
      .select('id', 'ingestion_status', 'ingestion_progress', 'ingestion_error',
              'last_ingested_at', 'warehouse_path', 'query_engine')
      .first();

    if (!conn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const tables = await db('ingested_tables')
      .where({ connection_id: connectionId })
      .orderBy('table_name');

    res.json({
      ok: true,
      data: {
        connection: conn,
        tables,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/ingestion/table-config
// Body: { connectionId, tableName, load_mode, watermark_column }
// Configure incremental vs full load per table
// ---------------------------------------------------------------------------
router.patch('/table-config', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, tableName, load_mode, watermark_column } = req.body as {
      connectionId: number;
      tableName: string;
      load_mode?: 'full' | 'incremental';
      watermark_column?: string | null;
    };

    if (!connectionId || !tableName) {
      res.status(400).json({ ok: false, error: 'connectionId and tableName required' });
      return;
    }

    const update: Record<string, unknown> = {};
    if (load_mode !== undefined) update.load_mode = load_mode;
    if (watermark_column !== undefined) update.watermark_column = watermark_column;

    // If switching to full, clear the watermark value so next run does a full load
    if (load_mode === 'full') {
      update.watermark_value = null;
    }

    const count = await db('ingested_tables')
      .where({ connection_id: connectionId, table_name: tableName })
      .update(update);

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    const row = await db('ingested_tables')
      .where({ connection_id: connectionId, table_name: tableName })
      .first();

    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingestion/reset-watermark
// Body: { connectionId, tableName }
// Clears the watermark so the next incremental run re-ingests everything
// ---------------------------------------------------------------------------
router.post('/reset-watermark', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, tableName } = req.body as { connectionId: number; tableName: string };

    if (!connectionId || !tableName) {
      res.status(400).json({ ok: false, error: 'connectionId and tableName required' });
      return;
    }

    await db('ingested_tables')
      .where({ connection_id: connectionId, table_name: tableName })
      .update({ watermark_value: null });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Manual trigger for Delta OPTIMIZE + VACUUM. The cron-scheduled worker runs
 * weekly; this endpoint is for one-off runs after a large ingest or to
 * reclaim space on demand.
 */
router.post('/optimize', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId } = req.body as { connectionId?: number };
    const email = (req as unknown as { user?: { email?: string } }).user?.email ?? 'admin';

    const outcome = await triggerMaintenanceNow({
      connectionId,
      triggeredBy: email,
    });

    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

export default router;

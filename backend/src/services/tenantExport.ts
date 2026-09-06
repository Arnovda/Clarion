/**
 * Tenant data export (P0-7) — the DPA promises "in-product user erasure,
 * data export and full workspace deletion"; erasure and deletion existed
 * (accountDeletion.ts), export did not. This makes the sentence true.
 *
 * One ZIP, streamed, never held in memory:
 *   README.txt              what is in here and what is not
 *   manifest.json           tables, row counts, redacted columns, versions
 *   tables/<table>.json     every row of every tenant-scoped table
 *   warehouse.json          the tenant's warehouse files and, in per-tenant
 *                           container mode, a 24 h read-only download link
 *
 * Tables are discovered the way purgeTenant discovers them — every table
 * with a tenant_id column — so the export cannot drift from the schema. Two
 * kinds of column never leave: secrets (password hashes, encrypted source
 * credentials, token hashes, MFA secrets) and the tables that are nothing
 * but secrets. They are named in the manifest, not silently dropped.
 *
 * Every query filters tenant_id EXPLICITLY beside the RLS context (house
 * rule: an export is exactly the read where a stray row is unforgivable).
 * Rows are read in pages ordered by primary key so a large table streams
 * without a server-side cursor pinning a transaction across the download.
 */
import type { Knex } from 'knex';
import fs from 'fs';
import path from 'path';
import { ZipStreamWriter, type ZipSink } from '../utils/zipStream';
import { warehouseRoot, warehouseContainer, isAzureMode } from './warehouse';
import { perTenantContainersActive } from './warehouse/container';
import { currentLegalVersions, legalInForce } from './legal';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'tenant-export' });

const PAGE = 2000;
const MAX_WAREHOUSE_FILES = 5000;

/** Tables that hold nothing but credentials — omitted whole. */
export const EXPORT_OMITTED_TABLES = new Set<string>([
  'refresh_tokens',
  'api_tokens',
  'mfa_backup_codes',
  'webauthn_credentials',
  'oauth_pending',
  'password_reset_tokens',
]);

/** Column names that never leave, whatever table they sit in. */
export const REDACTED_COLUMN_RE = /(password|secret|token|_hash$|encrypted|credential|api_key|private_key)/i;

export interface ExportManifestTable {
  table: string;
  rows: number;
  redactedColumns: string[];
}

export interface ExportManifest {
  generatedAt: string;
  tenantId: number;
  tenantName: string | null;
  requestedBy: string | null;
  legal: { inForce: boolean; versions: ReturnType<typeof currentLegalVersions> };
  tables: ExportManifestTable[];
  omittedTables: string[];
  warehouse: WarehouseInventory;
}

export interface WarehouseInventory {
  mode: 'local' | 'azure-shared' | 'azure-per-tenant';
  root: string;
  files: Array<{ path: string; bytes: number | null }>;
  truncated: boolean;
  /** Per-tenant container mode only: a read+list SAS on the tenant's own container. */
  download: { url: string; expiresAt: string } | null;
  note: string;
}

async function tenantTables(db: Knex | Knex.Transaction): Promise<Map<string, string[]>> {
  const rows = await db.raw(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  const byTable = new Map<string, string[]>();
  for (const r of rows.rows as Array<{ table_name: string; column_name: string }>) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name)!.push(r.column_name);
  }
  for (const [t, cols] of byTable) {
    if (!cols.includes('tenant_id') || t.startsWith('knex_')) byTable.delete(t);
  }
  return byTable;
}

function listLocalFiles(root: string): { files: Array<{ path: string; bytes: number | null }>; truncated: boolean } {
  const files: Array<{ path: string; bytes: number | null }> = [];
  let truncated = false;
  const walk = (dir: string) => {
    if (truncated || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_WAREHOUSE_FILES) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ path: path.relative(root, full), bytes: fs.statSync(full).size });
    }
  };
  walk(root);
  return { files, truncated };
}

export async function warehouseInventory(tenantId: number): Promise<WarehouseInventory> {
  if (!isAzureMode()) {
    const root = path.join(warehouseRoot(tenantId), `tenant_${tenantId}`);
    const { files, truncated } = listLocalFiles(root);
    return {
      mode: 'local', root, files, truncated, download: null,
      note: 'Local warehouse: the files listed here live on the server filesystem; ask the operator for a copy.',
    };
  }
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    return { mode: perTenantContainersActive() ? 'azure-per-tenant' : 'azure-shared', root: warehouseRoot(tenantId), files: [], truncated: false, download: null, note: 'Warehouse listing unavailable: storage is not configured on this backend.' };
  }
  const { BlobServiceClient, ContainerSASPermissions } = await import('@azure/storage-blob');
  const svc = BlobServiceClient.fromConnectionString(connStr);
  const container = warehouseContainer(tenantId);
  const client = svc.getContainerClient(container);
  const perTenant = perTenantContainersActive();
  // In shared-container mode the tenant's data is a prefix; a SAS would be
  // container-wide and therefore expose other tenants — list only.
  const prefix = perTenant ? '' : `tenant_${tenantId}/`;
  const files: Array<{ path: string; bytes: number | null }> = [];
  let truncated = false;
  for await (const blob of client.listBlobsFlat({ prefix })) {
    if (files.length >= MAX_WAREHOUSE_FILES) { truncated = true; break; }
    files.push({ path: blob.name, bytes: blob.properties.contentLength ?? null });
  }
  let download: WarehouseInventory['download'] = null;
  if (perTenant) {
    const expiresOn = new Date(Date.now() + 24 * 3600 * 1000);
    const url = await client.generateSasUrl({
      permissions: ContainerSASPermissions.parse('rl'),
      expiresOn,
    });
    download = { url, expiresAt: expiresOn.toISOString() };
  }
  return {
    mode: perTenant ? 'azure-per-tenant' : 'azure-shared',
    root: `az://${container}/${prefix}`,
    files, truncated, download,
    note: perTenant
      ? 'The download link lists and reads every file in your workspace\'s own storage container for 24 hours (Parquet / Delta tables as written by the platform).'
      : 'Shared-container mode: files are listed; a download link cannot be scoped to one workspace here — ask the operator for a copy.',
  };
}

/**
 * Stream the export into `sink`. Returns the manifest that was written.
 * `db` must carry the tenant context (the request handle); tenant_id is
 * still filtered explicitly on every query.
 */
export async function streamTenantExport(
  db: Knex | Knex.Transaction,
  sink: ZipSink,
  input: { tenantId: number; requestedBy: string | null },
): Promise<ExportManifest> {
  const { tenantId } = input;
  const zip = new ZipStreamWriter(sink);
  const generatedAt = new Date();
  const tenant = await db('tenants').where({ id: tenantId }).select('name').first();

  const tables = await tenantTables(db);
  const manifestTables: ExportManifestTable[] = [];
  const omitted: string[] = [];

  await zip.addFile('README.txt', [
    `Clarion workspace export — ${tenant?.name ?? `tenant ${tenantId}`}`,
    `Generated ${generatedAt.toISOString()}${input.requestedBy ? ` at the request of ${input.requestedBy}` : ''}.`,
    '',
    'tables/<name>.json  — every row of every table that belongs to this workspace, as a JSON array.',
    'manifest.json       — the list of tables with row counts and the columns that were withheld.',
    'warehouse.json      — the files of your data warehouse (source tables, topics) and how to fetch them.',
    '',
    'Withheld on purpose: password hashes, encrypted source-system credentials, session and API',
    'token hashes, MFA secrets. They are named per table in manifest.json so nothing is silently missing.',
    '',
  ].join('\n'), generatedAt);

  for (const [table, columns] of [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (EXPORT_OMITTED_TABLES.has(table)) { omitted.push(table); continue; }
    const keep = columns.filter((c) => !REDACTED_COLUMN_RE.test(c));
    const redacted = columns.filter((c) => REDACTED_COLUMN_RE.test(c));
    const orderBy = columns.includes('id') ? 'id' : null;
    let rows = 0;
    await zip.beginEntry(`tables/${table}.json`, generatedAt);
    await zip.write('[');
    for (let offset = 0; ; offset += PAGE) {
      let q = db(table).where({ tenant_id: tenantId }).select(keep).limit(PAGE).offset(offset);
      q = orderBy ? q.orderBy(orderBy, 'asc') : q.orderByRaw('ctid');
      const page = await q;
      for (const row of page) {
        await zip.write((rows > 0 ? ',\n' : '\n') + JSON.stringify(row));
        rows++;
      }
      if (page.length < PAGE) break;
    }
    await zip.write(rows > 0 ? '\n]\n' : ']\n');
    await zip.endEntry();
    manifestTables.push({ table, rows, redactedColumns: redacted });
  }

  let warehouse: WarehouseInventory;
  try {
    warehouse = await warehouseInventory(tenantId);
  } catch (err) {
    log.warn({ err, tenantId }, 'warehouse inventory failed during export');
    warehouse = { mode: isAzureMode() ? 'azure-shared' : 'local', root: '', files: [], truncated: false, download: null, note: `Warehouse listing failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await zip.addFile('warehouse.json', JSON.stringify(warehouse, null, 2) + '\n', generatedAt);

  const manifest: ExportManifest = {
    generatedAt: generatedAt.toISOString(),
    tenantId,
    tenantName: tenant?.name ?? null,
    requestedBy: input.requestedBy,
    legal: { inForce: legalInForce(), versions: currentLegalVersions() },
    tables: manifestTables,
    omittedTables: omitted,
    warehouse,
  };
  await zip.addFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n', generatedAt);
  await zip.finish();
  log.info({ tenantId, tables: manifestTables.length, rows: manifestTables.reduce((a, t) => a + t.rows, 0) }, 'tenant export streamed');
  return manifest;
}

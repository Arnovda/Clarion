/**
 * Frontend types + API wrapper for the catalog browser.
 *
 * The catalog is a Unity-Catalog-style three-level namespace:
 *   - catalog ('sources' | 'products')
 *   - schema   (a connection name or a data product name, slugged with id suffix)
 *   - table    (raw integer pgId, kept stable across renames)
 *   - column   (raw integer pgId)
 *
 * Mirrors backend/src/routes/catalog.ts. If you change a response shape there,
 * update this file too.
 */

import api from './api';

export type CatalogId = 'sources' | 'products';

export interface CatalogEntry {
  id: CatalogId;
  label: string;
  schemaCount: number;
}

export interface SchemaEntry {
  catalog: CatalogId;
  id: string;             // slug: "<name>_<id>"
  label: string;
  description?: string | null;
  tableCount: number;
  ownerName?: string | null;
  status?: string | null;     // products only
  lastRefreshed?: string | null;
  meta?: {
    connectionId?: number;
    dataProductId?: number;
    type?: string;
    /** Primary source for a product schema (products catalog only). */
    sourceConnectionId?: number | null;
    sourceConnectionName?: string | null;
    sourceConnectorType?: string | null;
    multiSource?: boolean;
    sourceDeleted?: boolean;
  };
}

export interface TableEntry {
  catalog: CatalogId;
  schema: string;
  id: string;             // raw pgId as string
  label: string;
  tableName: string | null;
  role?: 'fact' | 'dimension' | 'bridge' | 'junk' | 'source' | string | null;
  dagOrder?: number;
  rowCount?: number | null;
  columnCount: number;
  transformationStatus?: string | null;
  lastRunAt?: string | null;
  lastProfiledAt?: string | null;
  ownerName?: string | null;
  description?: string | null;
  aiDraft?: boolean;
  approvalStatus?: string | null;
}

export interface ColumnEntry {
  catalog: CatalogId;
  schema: string;
  table: string;
  id: string;
  name: string | null;
  label: string;
  type: string | null;
  role?: string | null;
  description?: string | null;
  nullPct?: number | null;
  distinctPct?: number | null;
  sampleValues?: unknown;
  fkTargetTable?: string | null;
  fkTargetColumn?: string | null;
  additivity?: string | null;
  transformationExpression?: string | null;
  approvalStatus?: string | null;
  aiDraft?: boolean;
}

interface ApiOk<T> { ok: true;  data: T }
interface ApiErr   { ok: false; error: string }

async function unwrap<T>(promise: Promise<{ data: ApiOk<T> | ApiErr }>): Promise<T> {
  const res = await promise;
  if (!res.data.ok) throw new Error(res.data.error || 'Catalog request failed');
  return res.data.data;
}

/** Parse the trailing `_<id>` from a schema slug back into its numeric id. */
export function parseIdFromSlug(slug: string): number | null {
  const m = slug.match(/_(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

/**
 * One flat hit returned by the catalog search endpoint — enough to
 * navigate to the table or column directly via `onSelectTable`.
 * Column hits carry `columnName` so the UI can show context.
 */
export interface CatalogSearchHit {
  kind: 'table' | 'column';
  catalog: CatalogId;
  schemaSlug: string;
  schemaLabel: string;
  tableId: string;
  tableLabel: string;
  tableName: string;
  role: string | null;
  columnName?: string;
  columnLabel?: string;
}

export const catalogApi = {
  catalogs: () =>
    unwrap<CatalogEntry[]>(api.get('/catalog')),

  schemas: (catalog: CatalogId) =>
    unwrap<SchemaEntry[]>(api.get(`/catalog/${catalog}`)),

  tables: (catalog: CatalogId, schemaSlug: string) =>
    unwrap<TableEntry[]>(api.get(`/catalog/${catalog}/${encodeURIComponent(schemaSlug)}`)),

  columns: (catalog: CatalogId, schemaSlug: string, tableId: string) =>
    unwrap<ColumnEntry[]>(
      api.get(`/catalog/${catalog}/${encodeURIComponent(schemaSlug)}/${encodeURIComponent(tableId)}`),
    ),

  search: (q: string) =>
    unwrap<CatalogSearchHit[]>(api.get(`/catalog/search?q=${encodeURIComponent(q)}`)),
};

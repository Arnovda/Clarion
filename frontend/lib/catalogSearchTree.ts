/**
 * The catalog's search results, as the tree they came from.
 *
 * The Databricks explorer filters its tree in place — "meetreeksen" leaves
 * catalog › schema › the matching tables, with the matched text in bold —
 * instead of replacing the tree with a flat list. This is the pure half of
 * that: flat hits from GET /catalog/search regrouped into catalog › schema
 * › table › matching columns, in the order the backend ranked them, so the
 * tree component only has to render.
 */
import type { CatalogId, CatalogSearchHit } from './catalog';

export interface SearchTreeColumn { name: string; label: string }

export interface SearchTreeTable {
  tableId: string;
  tableLabel: string;
  tableName: string;
  role: string | null;
  /** The table's own name matched (not only a column of it). */
  tableMatched: boolean;
  columns: SearchTreeColumn[];
}

export interface SearchTreeSchema {
  catalog: CatalogId;
  schemaSlug: string;
  schemaLabel: string;
  tables: SearchTreeTable[];
}

export interface SearchTreeCatalog {
  catalog: CatalogId;
  schemas: SearchTreeSchema[];
}

export function groupSearchHits(hits: CatalogSearchHit[]): SearchTreeCatalog[] {
  const catalogs: SearchTreeCatalog[] = [];
  const catalogByKey = new Map<string, SearchTreeCatalog>();
  const schemaByKey = new Map<string, SearchTreeSchema>();
  const tableByKey = new Map<string, SearchTreeTable>();

  for (const h of hits) {
    let cat = catalogByKey.get(h.catalog);
    if (!cat) {
      cat = { catalog: h.catalog, schemas: [] };
      catalogByKey.set(h.catalog, cat);
      catalogs.push(cat);
    }
    const schemaKey = `${h.catalog}/${h.schemaSlug}`;
    let schema = schemaByKey.get(schemaKey);
    if (!schema) {
      schema = { catalog: h.catalog, schemaSlug: h.schemaSlug, schemaLabel: h.schemaLabel, tables: [] };
      schemaByKey.set(schemaKey, schema);
      cat.schemas.push(schema);
    }
    const tableKey = `${schemaKey}/${h.tableId}`;
    let table = tableByKey.get(tableKey);
    if (!table) {
      table = { tableId: h.tableId, tableLabel: h.tableLabel, tableName: h.tableName, role: h.role, tableMatched: false, columns: [] };
      tableByKey.set(tableKey, table);
      schema.tables.push(table);
    }
    if (h.kind === 'table') {
      table.tableMatched = true;
    } else if (h.columnName && !table.columns.some((c) => c.name === h.columnName)) {
      table.columns.push({ name: h.columnName, label: h.columnLabel ?? h.columnName });
    }
  }

  // Subjects before Sources, whatever order the hits arrived in.
  return catalogs.sort((a, b) => (a.catalog === 'products' ? 0 : 1) - (b.catalog === 'products' ? 0 : 1));
}

/** Where `query` occurs in `text` (case-insensitive), for the bold match. */
export function matchRange(text: string, query: string): [number, number] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const idx = text.toLowerCase().indexOf(q);
  return idx === -1 ? null : [idx, idx + q.length];
}

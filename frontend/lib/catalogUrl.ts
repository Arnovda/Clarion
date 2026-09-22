/**
 * The catalog's deep links, read in one place.
 *
 * The catalog was rebuilt IN PLACE (2026-09-22): the URL did not change, so
 * every link that already points into it keeps working — the dashboard
 * filter popover's `?table=dim_item`, Shared data's `?refTableId=`, the topic
 * page's `?productId=`, the rail's old `?facet=` entries. This module turns
 * the query string into ONE intent the page acts on, and is pure so those
 * links are pinned by a test rather than by memory.
 */

export type CatalogIntent =
  | { kind: 'definitions' }
  | { kind: 'subject'; productId: number }
  /** A product table by EITHER id space — the panel resolves both. */
  | { kind: 'table'; tableId: number }
  /** A table known only by NAME (e.g. `dim_item`) — resolved by search. */
  | { kind: 'table-by-name'; name: string }
  | { kind: 'source'; connectionId: number }
  | { kind: 'source-table'; tableId: number; connectionId: number }
  | { kind: 'none' };

function positive(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

export function parseCatalogUrl(params: URLSearchParams): CatalogIntent {
  // The glossary facet is the Definitions pane now.
  if (params.get('facet') === 'glossary') return { kind: 'definitions' };

  const tableId = positive(params.get('tableId'));
  const refTableId = positive(params.get('refTableId'));
  const productId = positive(params.get('productId'));
  const connectionId = positive(params.get('connectionId'));
  const sourceTableId = positive(params.get('sourceTableId'));
  const name = params.get('table')?.trim() || null;

  if (sourceTableId && connectionId) return { kind: 'source-table', tableId: sourceTableId, connectionId };
  if (tableId) return { kind: 'table', tableId };
  if (refTableId) return { kind: 'table', tableId: refTableId };
  if (productId) return { kind: 'subject', productId };
  if (connectionId) return { kind: 'source', connectionId };
  if (name) return { kind: 'table-by-name', name };
  return { kind: 'none' };
}

/** The URL for a selection, so the address bar and a pasted link agree. */
export function catalogHref(intent: CatalogIntent): string {
  switch (intent.kind) {
    case 'subject':      return `/catalog?productId=${intent.productId}`;
    case 'table':        return `/catalog?tableId=${intent.tableId}`;
    case 'table-by-name': return `/catalog?table=${encodeURIComponent(intent.name)}`;
    case 'source':       return `/catalog?connectionId=${intent.connectionId}`;
    case 'source-table': return `/catalog?connectionId=${intent.connectionId}&sourceTableId=${intent.tableId}`;
    case 'definitions':  return '/definitions';
    default:             return '/catalog';
  }
}

/**
 * What a catalog panel may ask the page to do.
 *
 * The page owns the selection (tree highlight + URL + view). A panel that
 * wants to move — a breadcrumb back to the subject, a "used in" chip to
 * another subject, the source name on a table — hands it one of these and
 * the page does what a tree click would. No panel writes the URL itself.
 */
export type CatalogNavTarget =
  | { kind: 'catalog' }
  | { kind: 'subject'; productId: number }
  | { kind: 'source'; connectionId: number }
  /** A product table by EITHER id space (the loader resolves both). `tab`
   *  lands on that tab — a table just added opens on its SQL, to be declared. */
  | { kind: 'table'; tableId: number; tab?: 'sql' }
  | { kind: 'source-table'; tableId: number; connectionId: number };

/** The connection row as GET /connections returns it, the parts panels read. */
export interface CatalogConnection {
  id: number;
  name: string;
  type?: string | null;
  connector_type?: string | null;
  domains?: string[] | string | null;
  last_synced_at?: string | null;
  last_sync_status?: string | null;
  profiling_status?: string | null;
}

/** The floating assistant, opened from a header action. */
export type AssistantOpenMode = 'ask' | 'change';

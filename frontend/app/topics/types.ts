/**
 * Types for the topic-first data experience (`/topics/[productId]`).
 *
 * `Topic` mirrors `GET /api/products/:id/topic` — the single read model the
 * topic page mounts on. Deliberately small: the topic page must never learn
 * the words "fact", "dimension" or "star schema", so nothing here carries
 * them. Everything technical is the catalog's subject page, one door away.
 */

export type FreshnessState = 'ok' | 'warn' | 'err';

export interface TopicQuestion {
  kpiId: number;
  /** The clickable question. Falls back to the KPI name server-side. */
  text: string;
  /** True when `text` is the raw KPI name because no phrasing was stored. */
  derived: boolean;
  description: string | null;
}

export interface Topic {
  id: number;
  name: string;
  description: string | null;
  kind: 'analytics' | 'reference';
  status: string;
  source: { id: number; name: string; connectorType: string | null } | null;
  questions: TopicQuestion[];
  /** Business-facing lens labels for the break-down line. Date sorts last. */
  dimensions: string[];
  counts: { tables: number; sharedLookups: number; metrics: number };
  freshness: {
    state: FreshnessState;
    lastBuiltAt: string | null;
    sourceSyncedAt: string | null;
    failedTables: number;
    /** Tables that ran without a column the source stopped providing. */
    degradedTables: Array<{ table: string; reason: string }>;
  };
  /** Counts only — a viewer may read these; failure detail is the catalog's. */
  quality: { checksPassing: number; checksTotal: number };
  /** Tables whose deploy-cell SQL differs from what the warehouse was built from. */
  pendingChanges: number;
}

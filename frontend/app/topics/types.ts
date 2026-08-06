/**
 * Types for the topic-first data experience (`/topics/[productId]`).
 *
 * `Topic` mirrors `GET /api/products/:id/topic` — the single read model the
 * topic page mounts on. Deliberately small: the topic page must never learn
 * the words "fact", "dimension" or "star schema", so nothing here carries
 * them. Manage mode loads the full `FullDataProduct` separately, because
 * that is the surface where warehouse vocabulary is allowed.
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
  };
  /** Counts only — a viewer may read these; failure detail stays in Manage mode. */
  quality: { checksPassing: number; checksTotal: number };
  /** Tables whose deploy-cell SQL differs from what the warehouse was built from. */
  pendingChanges: number;
}

/** Manage mode's tab strip. Values are the plain-language labels' keys. */
export type ManageTab = 'tables' | 'fits' | 'comes-from' | 'metrics' | 'quality' | 'activity';

/** Sub-tabs on a selected table inside Manage mode's Tables tab. */
export type TableSubTab = 'built' | 'columns' | 'relationships' | 'quality';

export type DeployState = 'idle' | 'running' | 'done' | 'error';
